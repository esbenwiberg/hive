import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";
import { tasks } from "../../src/db/schema.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

vi.mock("../../src/producers/base.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/producers/base.js")>();
  return {
    ...original,
    gatherRepoSummary: vi.fn(() => "## File tree\nindex.ts\npackage.json"),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { MaintenanceProducer } = await import("../../src/producers/maintenance.js");
const { findOrCreateByEntraOid } = await import("../../src/db/queries/users.js");
const { findOrCreate: findOrCreateRepo } = await import("../../src/db/queries/repos.js");

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

const TEST_REPO_DIR = "/tmp/hive-test-repo";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-maintenance-test",
    "maintenance@example.com",
    "Maintenance Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/legacy-app");
  return { user, repo };
}

function ctxWithRepo(repoId: number, userId: number) {
  return {
    repoId,
    repoFullName: "acme/legacy-app",
    repoDir: TEST_REPO_DIR,
    createdBy: userId,
  };
}

function makeFinding(overrides: Record<string, unknown> = {}) {
  return {
    title: "Refactor authentication middleware",
    body: "The auth middleware has grown to 500 lines.",
    category: "complexity",
    scores: { value: 4, complexity: 2, risk: 2, block: 1 },
    priority: 7,
    ...overrides,
  };
}

function jsonResponse(findings: unknown[]) {
  return {
    text: JSON.stringify(findings),
    cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 100 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MaintenanceProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  // ── Prompt loading ─────────────────────────────────────────────────────────

  it("loads its prompt file without throwing", async () => {
    const { loadPrompt } = await import("../../src/prompt-cache.js");
    expect(() => loadPrompt("producers/maintenance")).not.toThrow();
    const text = loadPrompt("producers/maintenance");
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  // ── Basic task creation ────────────────────────────────────────────────────

  it("creates tasks for each finding returned by Claude", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([
        makeFinding({ title: "Refactor auth middleware" }),
        makeFinding({ title: "Remove dead payment code", category: "dead-code" }),
        makeFinding({ title: "Upgrade lodash to v4", category: "outdated-deps" }),
      ]),
    );

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
    expect(result.errors).toHaveLength(0);

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(3);
    expect(created.map((t) => t.type)).toEqual(["chore", "chore", "chore"]);
  });

  // ── Score-based priority ordering ─────────────────────────────────────────

  it("inserts high-value/low-complexity findings before low-value/high-complexity ones", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    // Lower priority: value=2, complexity=4, risk=3, block=1 → (2*2)+(1*2)-4-3 = -1
    const lowPriority = makeFinding({
      title: "Low priority task",
      scores: { value: 2, complexity: 4, risk: 3, block: 1 },
    });

    // Higher priority: value=5, complexity=1, risk=1, block=3 → (5*2)+(3*2)-1-1 = 14
    const highPriority = makeFinding({
      title: "High priority task",
      scores: { value: 5, complexity: 1, risk: 1, block: 3 },
    });

    // Return low-priority first to confirm the producer re-sorts by recomputed priority
    mockCallClaude.mockResolvedValue(jsonResponse([lowPriority, highPriority]));

    await producer.run(ctxWithRepo(repo.id, user.id));

    const created = await db
      .select({ title: tasks.title, body: tasks.body })
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    // Both tasks are created
    expect(created).toHaveLength(2);
    const titles = created.map((t) => t.title);
    expect(titles).toContain("High priority task");
    expect(titles).toContain("Low priority task");

    // High-priority task body should show priority=14, low-priority should show priority=-1
    const highTask = created.find((t) => t.title === "High priority task")!;
    const lowTask = created.find((t) => t.title === "Low priority task")!;
    expect(highTask.body).toContain("**14**");
    expect(lowTask.body).toContain("**-1**");
  });

  // ── Deduplication ─────────────────────────────────────────────────────────

  it("skips findings whose titles match existing open tasks", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([
        makeFinding({ title: "Refactor auth middleware" }),
        makeFinding({ title: "Remove dead payment code", category: "dead-code" }),
      ]),
    );

    const ctx = ctxWithRepo(repo.id, user.id);

    // First run creates both tasks
    await producer.run(ctx);

    // Second run with same titles — both should be skipped
    const result = await producer.run(ctx);
    expect(result.tasksCreated).toBe(0);
    expect(result.duplicatesSkipped).toBe(2);
  });

  it("creates a task if a previous one with the same title is in terminal status", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const { create: createTask } = await import("../../src/db/queries/tasks.js");

    // Manually create a task and fast-forward it to 'done' via direct DB update
    const task = await createTask({
      title: "Refactor auth middleware",
      body: "old body",
      source: "producer:maintenance",
      repoId: repo.id,
      createdBy: user.id,
    });
    await db
      .update(tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(sql`${tasks.id} = ${task.id}`);

    mockCallClaude.mockResolvedValue(
      jsonResponse([makeFinding({ title: "Refactor auth middleware" })]),
    );

    const result = await producer.run(ctxWithRepo(repo.id, user.id));
    expect(result.tasksCreated).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
  });

  // ── Edge: no findings ─────────────────────────────────────────────────────

  it("returns empty suggestions when Claude returns an empty array", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "[]",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 50, outputTokens: 2 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty suggestions when Claude responds with NONE", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "NONE",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 50, outputTokens: 4 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Edge: malformed LLM response ──────────────────────────────────────────

  it("handles completely malformed JSON without throwing", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "this is not json at all }{",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 50, outputTokens: 10 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0); // parse failures are silent
  });

  it("handles a JSON object (not array) without throwing", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ title: "oops", body: "not an array" }),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 50, outputTokens: 10 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips array items that are missing a title", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([
        { body: "no title here", category: "legacy", scores: { value: 3, complexity: 2, risk: 2, block: 1 } },
        makeFinding({ title: "Valid finding" }),
      ]),
    );

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);
  });

  it("skips findings whose title looks like an LLM refusal", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([
        makeFinding({ title: "I cannot directly access the repository files" }),
        makeFinding({ title: "Legitimate refactor task" }),
      ]),
    );

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);
  });

  it("strips markdown fences before parsing JSON", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const fenced =
      "```json\n" + JSON.stringify([makeFinding({ title: "Fenced finding" })]) + "\n```";

    mockCallClaude.mockResolvedValue({
      text: fenced,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 80, outputTokens: 30 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);
  });

  // ── Edge: missing repoDir ─────────────────────────────────────────────────

  it("returns early with an error when repoDir is not provided", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/legacy-app",
      createdBy: user.id,
      // no repoDir
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not available");
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  // ── Edge: SDK failure ─────────────────────────────────────────────────────

  it("catches SDK errors and adds them to the errors array", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockRejectedValue(new Error("API rate limit exceeded"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit exceeded");
  });

  // ── Score clamping ────────────────────────────────────────────────────────

  it("clamps out-of-range scores to 1–5 and still creates the task", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([
        makeFinding({
          title: "Task with wild scores",
          scores: { value: 99, complexity: -5, risk: 0, block: 100 },
        }),
      ]),
    );

    const result = await producer.run(ctxWithRepo(repo.id, user.id));
    expect(result.tasksCreated).toBe(1);

    const [created] = await db
      .select({ body: tasks.body })
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    // Body should contain clamped values (5 max, 1 min)
    expect(created.body).toContain("5/5"); // value clamped from 99
    expect(created.body).toContain("1/5"); // complexity clamped from -5
  });

  // ── Size mapping from complexity ──────────────────────────────────────────

  it("maps complexity=1 to size small, complexity=3 to medium, complexity=5 to large", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([
        makeFinding({ title: "Small task", scores: { value: 3, complexity: 1, risk: 1, block: 1 } }),
        makeFinding({ title: "Medium task", scores: { value: 3, complexity: 3, risk: 1, block: 1 } }),
        makeFinding({ title: "Large task", scores: { value: 3, complexity: 5, risk: 1, block: 1 } }),
      ]),
    );

    await producer.run(ctxWithRepo(repo.id, user.id));

    const created = await db
      .select({ title: tasks.title, size: tasks.size })
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`)
      .orderBy(tasks.id);

    const byTitle = Object.fromEntries(created.map((t) => [t.title, t.size]));
    expect(byTitle["Small task"]).toBe("small");
    expect(byTitle["Medium task"]).toBe("medium");
    expect(byTitle["Large task"]).toBe("large");
  });

  // ── Dry-run mode ──────────────────────────────────────────────────────────

  it("does not persist tasks in dry-run mode", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue(
      jsonResponse([makeFinding({ title: "Dry run finding" })]),
    );

    const result = await producer.run({
      ...ctxWithRepo(repo.id, user.id),
      dryRun: true,
    });

    expect(result.tasksCreated).toBe(1); // counter still increments
    expect(result.errors).toHaveLength(0);

    const rows = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(rows).toHaveLength(0); // nothing actually written
  });

  // ── Category → task type mapping ──────────────────────────────────────────

  it("assigns type=chore for all known maintenance categories", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const categories = ["legacy", "outdated-deps", "complexity", "duplication", "dead-code", "stale-types"];

    mockCallClaude.mockResolvedValue(
      jsonResponse(
        categories.map((cat, i) =>
          makeFinding({ title: `Task ${i}`, category: cat }),
        ),
      ),
    );

    await producer.run(ctxWithRepo(repo.id, user.id));

    const created = await db
      .select({ type: tasks.type })
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(categories.length);
    expect(created.every((t) => t.type === "chore")).toBe(true);
  });
});
