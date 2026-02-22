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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-maintenance-test",
    "maintenance@example.com",
    "Maintenance Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

function ctxWithRepo(repoId: number, userId: number) {
  return {
    repoId,
    repoFullName: "acme/widget",
    repoDir: "/tmp/hive-test-repo",
    createdBy: userId,
  };
}

/** Build a minimal valid LLM JSON response for one finding */
function findingJson(overrides: Record<string, unknown> = {}): string {
  const finding = {
    title: "Refactor legacy auth module to use modern JWT library",
    body: "The auth module uses a deprecated HMAC approach. Replacing it with `jsonwebtoken` reduces risk.",
    category: "legacy",
    scores: { value: 4, complexity: 2, risk: 2, block: 1 },
    priority: 7,
    ...overrides,
  };
  return JSON.stringify([finding]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MaintenanceProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("exports MaintenanceProducer class and name is 'maintenance'", () => {
    const producer = new MaintenanceProducer();
    expect(producer.name).toBe("maintenance");
  });

  it("creates tasks with type 'chore' for each finding", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: JSON.stringify([
        {
          title: "Refactor legacy auth module",
          body: "Replace deprecated HMAC implementation.",
          category: "legacy",
          scores: { value: 4, complexity: 2, risk: 2, block: 1 },
          priority: 7,
        },
        {
          title: "Merge duplicated validation helpers in utils/",
          body: "Three copies of email validation exist across the repo.",
          category: "duplication",
          scores: { value: 3, complexity: 1, risk: 1, block: 1 },
          priority: 9,
        },
      ]),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 300, outputTokens: 80 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(2);
    expect(result.errors).toHaveLength(0);

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(2);
    for (const task of created) {
      expect(task.type).toBe("chore");
    }
  });

  it("includes the four-axis score breakdown in the task body", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: findingJson(),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 60 },
    });

    await producer.run(ctxWithRepo(repo.id, user.id));

    const [task] = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(task.body).toContain("Value");
    expect(task.body).toContain("Complexity");
    expect(task.body).toContain("Risk");
    expect(task.body).toContain("Block");
    expect(task.body).toContain("Priority");
    expect(task.body).toContain("5");
  });

  it("assigns size based on complexity score", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: JSON.stringify([
        {
          title: "Low-complexity quick-win task",
          body: "Small fix.",
          category: "dead-code",
          scores: { value: 3, complexity: 1, risk: 1, block: 1 },
          priority: 8,
        },
        {
          title: "Medium-complexity refactor task",
          body: "Medium effort.",
          category: "complexity",
          scores: { value: 3, complexity: 3, risk: 2, block: 1 },
          priority: 5,
        },
        {
          title: "High-complexity architectural overhaul",
          body: "Large effort needed.",
          category: "legacy",
          scores: { value: 5, complexity: 5, risk: 4, block: 3 },
          priority: 9,
        },
      ]),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 300, outputTokens: 100 },
    });

    await producer.run(ctxWithRepo(repo.id, user.id));

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    const byTitle = Object.fromEntries(created.map((t) => [t.title, t]));

    expect(byTitle["Low-complexity quick-win task"].size).toBe("small");
    expect(byTitle["Medium-complexity refactor task"].size).toBe("medium");
    expect(byTitle["High-complexity architectural overhaul"].size).toBe("large");
  });

  it("deduplicates — skips findings already open as tasks", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: findingJson({ title: "Migrate from deprecated request library" }),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 60 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    // First run — should create
    const first = await producer.run(ctx);
    expect(first.tasksCreated).toBe(1);

    // Second run with same findings — should deduplicate
    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
  });

  it("returns early and adds an error when repoDir is missing", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not available");
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("catches SDK errors without throwing", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockRejectedValue(new Error("Claude is overloaded"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Claude is overloaded");
  });

  it("handles NONE response gracefully", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "NONE",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 5 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles malformed JSON without throwing", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "this is not json at all",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 10 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("strips markdown fences from JSON response", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "```json\n" + findingJson() + "\n```",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 70 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("does not insert tasks in dry-run mode", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: findingJson({ title: "Dry-run refactor title" }),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 60 },
    });

    const result = await producer.run({
      ...ctxWithRepo(repo.id, user.id),
      dryRun: true,
    });

    expect(result.tasksCreated).toBe(1);

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(0);
  });
});
