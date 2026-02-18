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
      text: "Race condition in auth middleware\nMemory leak in WebSocket handler\nSQL injection in search endpoint",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

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
      text: "Bug 1\nBug 2\nBug 3\nBug 4\nBug 5\nBug 6\nBug 7",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(5);
  });

  it("skips duplicate titles", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "Race condition in auth\nMemory leak in WS",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 50 },
    });

    const ctx = {
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    };

    // First run
    await producer.run(ctx);

    // Second run with same titles
    const result = await producer.run(ctx);
    expect(result.tasksCreated).toBe(0);
    expect(result.duplicatesSkipped).toBe(2);
  });

  it("handles empty Claude response gracefully", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockResolvedValue({
      text: "",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 0 },
    });

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("catches SDK errors and adds to errors array", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new BugHunterProducer();

    mockCallClaude.mockRejectedValue(new Error("API rate limit"));

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit");
  });
});
