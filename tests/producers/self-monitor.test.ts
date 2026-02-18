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

const { SelfMonitorProducer } = await import(
  "../../src/producers/self-monitor.js"
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
    "oid-selfmon-test",
    "selfmon@example.com",
    "Self Monitor Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SelfMonitorProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  it("creates a task for a task stuck in executing status", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    // Create a task and move it to 'executing' status
    const task = await createTask({
      title: "Stuck task",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");
    await updateStatus(task.id, "ready");
    await updateStatus(task.id, "approved");
    await updateStatus(task.id, "executing");

    // Set updatedAt to 60 minutes ago via raw SQL
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(
      sql`UPDATE tasks SET updated_at = ${sixtyMinutesAgo.toISOString()} WHERE id = ${task.id}`,
    );

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
    expect(created[0].title).toBe(
      `Self-monitor: task ${task.id} stuck in executing`,
    );
    expect(created[0].type).toBe("bug");
  });

  it("does not flag tasks that were recently updated", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    // Create a task in 'executing' but with recent updatedAt
    const task = await createTask({
      title: "Active task",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");
    await updateStatus(task.id, "ready");
    await updateStatus(task.id, "approved");
    await updateStatus(task.id, "executing");

    // updatedAt is now (just set by updateStatus), so it should NOT be considered stuck

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
  });

  it("detects tasks stuck in enriching status", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    const task = await createTask({
      title: "Enriching task",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");

    // Set updatedAt to 60 minutes ago
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(
      sql`UPDATE tasks SET updated_at = ${sixtyMinutesAgo.toISOString()} WHERE id = ${task.id}`,
    );

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("skips duplicate stuck-task alerts", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new SelfMonitorProducer();

    const task = await createTask({
      title: "Stuck task",
      body: "body",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");
    await updateStatus(task.id, "ready");
    await updateStatus(task.id, "approved");
    await updateStatus(task.id, "executing");

    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(
      sql`UPDATE tasks SET updated_at = ${sixtyMinutesAgo.toISOString()} WHERE id = ${task.id}`,
    );

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
