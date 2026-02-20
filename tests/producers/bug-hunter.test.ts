import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";
import { tasks } from "../../src/db/schema.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SDK so we never call the real Anthropic API
vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

// Mock db/connection.js so queries use our test database
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
const { BugHunterProducer } = await import(
  "../../src/producers/bug-hunter.js"
);
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// Real fixture directory for gatherRepoSummary
const TEST_REPO_DIR = "/tmp/hive-test-repo";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-bughunter-test",
    "bughunter@example.com",
    "Bug Hunter Test User",
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BugHunterProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates tasks for each bug title from Claude response", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "## Race condition in auth middleware\nDetails about race condition\n## Memory leak in WebSocket handler\nDetails about memory leak\n## SQL injection in search endpoint\nDetails about SQL injection",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify task rows in DB
    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:bug-hunter'`);

    expect(created).toHaveLength(3);
    expect(created.map((t) => t.type)).toEqual(["bug", "bug", "bug"]);
  });

  it("limits to 5 titles even if Claude returns more", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "## Bug 1\nd\n## Bug 2\nd\n## Bug 3\nd\n## Bug 4\nd\n## Bug 5\nd\n## Bug 6\nd\n## Bug 7\nd",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(5);
  });

  it("skips duplicate titles", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "## Race condition in auth\nDetails\n## Memory leak in WS\nDetails",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    // First run
    await producer.run(ctx);

    // Second run with same titles
    const result = await producer.run(ctx);
    expect(result.tasksCreated).toBe(0);
    expect(result.duplicatesSkipped).toBe(2);
  });

  it("returns early when repoDir is not provided", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
      // no repoDir
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not available");
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("filters out refusal-style titles", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "## Race condition in auth middleware\nDetails\n## I don't have the ability to directly analyze external repositories\nRefusal text\n## Memory leak in WS handler\nDetails",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(2);
  });

  it("handles NONE response gracefully", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "NONE",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 5 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("catches SDK errors and adds to errors array", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockRejectedValue(new Error("API rate limit"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit");
  });
});
