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
const { SecurityScannerProducer } = await import(
  "../../src/producers/security-scanner.js"
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
    "oid-secscan-test",
    "secscan@example.com",
    "Security Scanner Test User",
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

describe("SecurityScannerProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates tasks with type 'security' for each finding", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SecurityScannerProducer();

    mockCallClaude.mockResolvedValue({
      text: "XSS vulnerability in comment rendering\nInsecure direct object reference in /api/users/:id\nMissing CSRF token validation",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 60 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify tasks have type 'security'
    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:security-scanner'`);

    expect(created).toHaveLength(3);
    for (const task of created) {
      expect(task.type).toBe("security");
    }
  });

  it("limits to 5 findings", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SecurityScannerProducer();

    mockCallClaude.mockResolvedValue({
      text: "Finding 1\nFinding 2\nFinding 3\nFinding 4\nFinding 5\nFinding 6",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 60 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(5);
  });

  it("skips duplicates", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SecurityScannerProducer();

    mockCallClaude.mockResolvedValue({
      text: "XSS in comments\nCSRF missing",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 40 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    await producer.run(ctx);

    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
  });

  it("returns early when repoDir is not provided", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SecurityScannerProducer();

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
    const producer = new SecurityScannerProducer();

    mockCallClaude.mockRejectedValue(new Error("Service unavailable"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Service unavailable");
  });
});
