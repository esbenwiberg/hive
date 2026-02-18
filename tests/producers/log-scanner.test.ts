import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";
import { tasks } from "../../src/db/schema.js";

// Mock db/connection.js so queries use our test database
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

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
const { create: createTask, updateStatus } = await import(
  "../../src/db/queries/tasks.js"
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
  });

  it("creates a task for recurring failures with the same prefix", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new LogScannerProducer();

    // Create two failed tasks with the same failureReason prefix
    const failureReason = "Connection timeout to database server at 10.0.0.1";

    const t1 = await createTask({
      title: "Task A",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    // Move to failed: pending -> queued -> enriching -> ready -> approved -> executing -> failed
    await updateStatus(t1.id, "queued");
    await updateStatus(t1.id, "enriching");
    await updateStatus(t1.id, "ready");
    await updateStatus(t1.id, "approved");
    await updateStatus(t1.id, "executing");
    await updateStatus(t1.id, "failed");
    // Set failureReason via raw SQL
    await db
      .update(tasks)
      .set({ failureReason })
      .where(sql`${tasks.id} = ${t1.id}`);

    const t2 = await createTask({
      title: "Task B",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(t2.id, "queued");
    await updateStatus(t2.id, "enriching");
    await updateStatus(t2.id, "ready");
    await updateStatus(t2.id, "approved");
    await updateStatus(t2.id, "executing");
    await updateStatus(t2.id, "failed");
    await db
      .update(tasks)
      .set({ failureReason })
      .where(sql`${tasks.id} = ${t2.id}`);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
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
    expect(created[0].title).toContain("Investigate recurring failure:");
  });

  it("does not create tasks for single failures", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new LogScannerProducer();

    // Only one failed task
    const t1 = await createTask({
      title: "Task A",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(t1.id, "queued");
    await updateStatus(t1.id, "enriching");
    await updateStatus(t1.id, "ready");
    await updateStatus(t1.id, "approved");
    await updateStatus(t1.id, "executing");
    await updateStatus(t1.id, "failed");
    await db
      .update(tasks)
      .set({ failureReason: "Unique error" })
      .where(sql`${tasks.id} = ${t1.id}`);

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
  });

  it("skips duplicates when run twice", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new LogScannerProducer();

    const failureReason = "Null pointer exception in UserService.getUser()";

    // Create two failed tasks
    for (const title of ["Task X", "Task Y"]) {
      const t = await createTask({
        title,
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });
      await updateStatus(t.id, "queued");
      await updateStatus(t.id, "enriching");
      await updateStatus(t.id, "ready");
      await updateStatus(t.id, "approved");
      await updateStatus(t.id, "executing");
      await updateStatus(t.id, "failed");
      await db
        .update(tasks)
        .set({ failureReason })
        .where(sql`${tasks.id} = ${t.id}`);
    }

    const ctx = {
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    };

    // First run creates the task
    const first = await producer.run(ctx);
    expect(first.tasksCreated).toBe(1);

    // Second run skips as duplicate
    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
  });
});
