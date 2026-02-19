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
const { FeatureScoutProducer } = await import(
  "../../src/producers/feature-scout.js"
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
    "oid-feature-test",
    "feature@example.com",
    "Feature Scout Test User",
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

describe("FeatureScoutProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates tasks with type 'feature' for each suggestion", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockResolvedValue({
      text: "Add dark mode support\nImplement real-time notifications\nAdd CSV export for reports",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 40 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify tasks have type 'feature'
    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:feature-scout'`);

    expect(created).toHaveLength(3);
    for (const task of created) {
      expect(task.type).toBe("feature");
    }
  });

  it("limits to 3 features even if Claude returns more", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockResolvedValue({
      text: "Feature 1\nFeature 2\nFeature 3\nFeature 4\nFeature 5",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 40 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
  });

  it("skips duplicates", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockResolvedValue({
      text: "Add dark mode\nReal-time notifications",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 30 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    await producer.run(ctx);

    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
  });

  it("returns early when repoDir is not provided", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

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
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockRejectedValue(new Error("Timeout"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Timeout");
  });
});
