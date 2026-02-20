import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";
import { tasks } from "../../src/db/schema.js";

// Mock db/connection.js so queries use our test database
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Mock azure-monitor so we don't make real HTTP requests
const mockRunKqlQuery = vi.fn().mockResolvedValue([]);
vi.mock("../../src/integrations/azure-monitor.js", () => ({
  runKqlQuery: mockRunKqlQuery,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { LogScannerProducer } = await import(
  "../../src/producers/log-scanner.js"
);
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-logscan-test",
    "logscan@example.com",
    "Log Scanner Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("LogScannerProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates a task for recurring failures with the same prefix", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new LogScannerProducer();

    // Mock KQL returning a recurring error pattern
    mockRunKqlQuery.mockResolvedValueOnce([
      {
        msg: "Connection timeout to database server at 10.0.0.1",
        hitCount: 5,
        firstSeen: "2026-02-20T05:00:00Z",
        lastSeen: "2026-02-20T05:50:00Z",
        sampleErr: "ECONNREFUSED",
        sampleTaskId: null,
      },
    ]);
    // Second KQL call (system issues) returns empty
    mockRunKqlQuery.mockResolvedValueOnce([]);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
      config: { workspaceId: "test-workspace-id" },
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify the task row exists
    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:log-scanner'`);

    expect(created).toHaveLength(1);
    expect(created[0].source).toBe("producer:log-scanner");
    expect(created[0].title).toContain("Recurring error:");
  });

  it("does not create tasks for single failures", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new LogScannerProducer();

    // KQL returns empty (no patterns with 2+ hits)
    mockRunKqlQuery.mockResolvedValue([]);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
      config: { workspaceId: "test-workspace-id" },
    });

    expect(result.tasksCreated).toBe(0);
  });

  it("skips duplicates when run twice", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new LogScannerProducer();

    const kqlRow = {
      msg: "Null pointer exception in UserService.getUser()",
      hitCount: 3,
      firstSeen: "2026-02-20T05:00:00Z",
      lastSeen: "2026-02-20T05:50:00Z",
      sampleErr: null,
      sampleTaskId: null,
    };

    const ctx = {
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
      config: { workspaceId: "test-workspace-id" },
    };

    // First run: KQL returns pattern, system issues empty
    mockRunKqlQuery.mockResolvedValueOnce([kqlRow]);
    mockRunKqlQuery.mockResolvedValueOnce([]);
    const first = await producer.run(ctx);
    expect(first.tasksCreated).toBe(1);

    // Second run: same pattern returned
    mockRunKqlQuery.mockResolvedValueOnce([kqlRow]);
    mockRunKqlQuery.mockResolvedValueOnce([]);
    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
  });
});
