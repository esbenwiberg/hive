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
const { MaintenanceProducer } = await import(
  "../../src/producers/maintenance.js"
);
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);

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
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

function ctxWithRepo(repoId: number, userId: number) {
  return {
    repoId,
    repoFullName: "acme/widget",
    repoDir: TEST_REPO_DIR,
    createdBy: userId,
  };
}

/** Builds a valid scored candidate block for use in mocked LLM responses. */
function candidateBlock(title: string, description: string, scores: {
  value: number;
  complexity: number;
  risk: number;
  block: number;
}): string {
  const { value, complexity, risk, block } = scores;
  const priority = value * 2 + block * 2 - complexity - risk;
  return [
    `## ${title}`,
    description,
    `**Scores:** value=${value}, complexity=${complexity}, risk=${risk}, block=${block}, priority=${priority}`,
  ].join("\n");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MaintenanceProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates tasks with type 'chore' for each scored candidate", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: [
        candidateBlock(
          "Upgrade deprecated lodash usage",
          "Replace _.merge calls with native Object.assign throughout the codebase.",
          { value: 6, complexity: 3, risk: 2, block: 4 },
        ),
        candidateBlock(
          "Remove dead code in utils.ts",
          "Several exported helpers in utils.ts are no longer imported anywhere.",
          { value: 5, complexity: 2, risk: 1, block: 3 },
        ),
      ].join("\n"),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 80 },
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

  it("appends maintenance scores to the task body", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: candidateBlock(
        "Consolidate duplicate DB helpers",
        "Three files contain nearly identical query wrappers; extract into a shared module.",
        { value: 7, complexity: 3, risk: 2, block: 5 },
      ),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 50 },
    });

    await producer.run(ctxWithRepo(repo.id, user.id));

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(1);
    expect(created[0].body).toContain("**Maintenance scores:**");
    expect(created[0].body).toContain("value=7");
    expect(created[0].body).toContain("priority=");
  });

  it("limits to 5 candidates even if Claude returns more", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const blocks = Array.from({ length: 7 }, (_, i) =>
      candidateBlock(
        `Maintenance task ${i + 1}`,
        `Description for task ${i + 1}.`,
        { value: 7, complexity: 2, risk: 1, block: 4 },
      ),
    );

    mockCallClaude.mockResolvedValue({
      text: blocks.join("\n"),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 300, outputTokens: 120 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(5);
  });

  it("discards candidates with priority <= 5", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    // value=2, complexity=3, risk=1, block=2 → priority = 4+4-3-1 = 4 (discarded)
    const lowPriority = candidateBlock(
      "Minor whitespace cleanup",
      "Some files have inconsistent trailing whitespace.",
      { value: 2, complexity: 3, risk: 1, block: 2 },
    );
    // value=5, complexity=2, risk=1, block=4 → priority = 10+8-2-1 = 15 (kept)
    const highPriority = candidateBlock(
      "Extract shared config loader",
      "Config loading logic is duplicated across four entry points.",
      { value: 5, complexity: 2, risk: 1, block: 4 },
    );

    mockCallClaude.mockResolvedValue({
      text: [lowPriority, highPriority].join("\n"),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 60 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(1);
    expect(created[0].title).toBe("Extract shared config loader");
  });

  it("returns early with no tasks when Claude responds with NONE", async () => {
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

  it("skips duplicates on a second run", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: [
        candidateBlock(
          "Upgrade deprecated lodash usage",
          "Replace _.merge calls with native Object.assign.",
          { value: 6, complexity: 3, risk: 2, block: 4 },
        ),
        candidateBlock(
          "Remove dead code in utils.ts",
          "Several exported helpers are no longer used.",
          { value: 5, complexity: 2, risk: 1, block: 3 },
        ),
      ].join("\n"),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 80 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    const first = await producer.run(ctx);
    expect(first.tasksCreated).toBe(2);

    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
  });

  it("returns early when repoDir is not provided", async () => {
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

    mockCallClaude.mockRejectedValue(new Error("Service unavailable"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Service unavailable");
  });
});
