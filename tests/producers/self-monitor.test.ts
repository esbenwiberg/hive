import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";
import { tasks } from "../../src/db/schema.js";

// Mock db/connection.js so queries use our test database
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Mock the log buffer so we can inject entries
const mockGetRecent = vi.fn().mockReturnValue([]);
vi.mock("../../src/log-buffer.js", () => {
  const { Writable } = require("node:stream");
  return {
    logBuffer: {
      getRecent: mockGetRecent,
      getStream: () => new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } }),
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { SelfMonitorProducer } = await import(
  "../../src/producers/self-monitor.js"
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
    "oid-selfmon-test",
    "selfmon@example.com",
    "Self Monitor Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

function makeErrorEntry(msg: string, time?: number, extras?: Partial<{ err: string; taskId: string }>) {
  return {
    level: 50,
    levelLabel: "error",
    time: time ?? Date.now(),
    msg,
    component: "app",
    ...extras,
    raw: JSON.stringify({ level: 50, msg }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SelfMonitorProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates a task for recurring error patterns in log buffer", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    const now = Date.now();
    // Two occurrences of the same error message within the last hour
    mockGetRecent.mockReturnValue([
      makeErrorEntry("Connection timeout to database", now - 30_000),
      makeErrorEntry("Connection timeout to database", now - 10_000),
    ]);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify the created task
    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:self-monitor'`);

    expect(created).toHaveLength(1);
    expect(created[0].source).toBe("producer:self-monitor");
    expect(created[0].title).toContain("Recurring error:");
    expect(created[0].type).toBe("bug");
  });

  it("does not create tasks when no recent errors", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    // No errors in the buffer
    mockGetRecent.mockReturnValue([]);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
  });

  it("ignores single occurrences (needs 2+ to trigger)", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    mockGetRecent.mockReturnValue([
      makeErrorEntry("Unique error", Date.now() - 5_000),
    ]);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
  });

  it("skips duplicate stuck-task alerts", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    const now = Date.now();
    const entries = [
      makeErrorEntry("Recurring db error", now - 30_000),
      makeErrorEntry("Recurring db error", now - 10_000),
    ];
    mockGetRecent.mockReturnValue(entries);

    const ctx = {
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    };

    // First run creates the alert
    const first = await producer.run(ctx);
    expect(first.tasksCreated).toBe(1);

    // Second run skips as duplicate
    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
  });
});
