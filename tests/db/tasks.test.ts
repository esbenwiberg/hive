import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, cleanupTables, useTestDb } from "../setup.js";

// Mock src/db/connection.js so that query functions use our test db/pool
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Import AFTER the mock is registered
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const { create, getById, getByIdWithCost, list, listWithCosts, updateStatus, countByStatus, deleteByIds, getOpenTasksForDedup } = await import(
  "../../src/db/queries/tasks.js"
);
const { recordCost } = await import(
  "../../src/db/queries/costs.js"
);
const { addEvent } = await import(
  "../../src/db/queries/task-events.js"
);

useTestDb();

// Helper to set up a user + repo for task creation
async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-test",
    "test@example.com",
    "Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

describe("tasks queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── create ──────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a task with generated id and pending status", async () => {
      const { user, repo } = await seedUserAndRepo();

      const task = await create({
        title: "Fix login bug",
        body: "The login form crashes on submit",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      expect(task).toBeDefined();
      expect(task.id).toMatch(/^HIVE-\d{8}-[0-9a-f]{8}$/);
      expect(task.title).toBe("Fix login bug");
      expect(task.body).toBe("The login form crashes on submit");
      expect(task.source).toBe("manual");
      expect(task.status).toBe("pending");
      expect(task.repoId).toBe(repo.id);
      expect(task.createdBy).toBe(user.id);
      expect(task.createdAt).toBeTruthy();
    });

    it("accepts optional type, size, and workflow", async () => {
      const { user, repo } = await seedUserAndRepo();

      const task = await create({
        title: "Add dark mode",
        body: "Support dark theme",
        source: "github-issue",
        type: "feature",
        size: "medium",
        workflow: "flow",
        repoId: repo.id,
        createdBy: user.id,
      });

      expect(task.type).toBe("feature");
      expect(task.size).toBe("medium");
      expect(task.workflow).toBe("flow");
    });
  });

  // ── getById ─────────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns the task when it exists", async () => {
      const { user, repo } = await seedUserAndRepo();
      const created = await create({
        title: "Test task",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      const found = await getById(created.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.title).toBe("Test task");
    });

    it("returns undefined for a nonexistent id", async () => {
      const found = await getById("HIVE-00000000-0000");
      expect(found).toBeUndefined();
    });
  });

  // ── getByIdWithCost ─────────────────────────────────────────────────────

  describe("getByIdWithCost", () => {
    it("returns task with totalCost property", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({
        title: "Test task with costs",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await recordCost(task.id, user.id, "router", "model-a", 1.5);
      await recordCost(task.id, user.id, "gate", "model-a", 2.25);

      const found = await getByIdWithCost(task.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(task.id);
      expect(found!.totalCost).toBeCloseTo(3.75, 2);
    });

    it("returns task with totalCost = 0 when no costs exist", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({
        title: "Test task no costs",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      const found = await getByIdWithCost(task.id);

      expect(found).toBeDefined();
      expect(found!.totalCost).toBe(0);
    });

    it("returns undefined for nonexistent task", async () => {
      const found = await getByIdWithCost("HIVE-00000000-0000");
      expect(found).toBeUndefined();
    });
  });

  // ── list ────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all tasks with default pagination", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({ title: "Task 1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Task 2", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      const result = await list();

      expect(result.tasks).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("filters by status", async () => {
      const { user, repo } = await seedUserAndRepo();

      const t1 = await create({ title: "Task 1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Task 2", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      // Move t1 to queued
      await updateStatus(t1.id, "queued");

      const result = await list({ status: "queued" });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(t1.id);
      expect(result.total).toBe(1);
    });

    it("filters by repoId", async () => {
      const { user } = await seedUserAndRepo();
      const { findOrCreate: findOrCreateRepo2 } = await import(
        "../../src/db/queries/repos.js"
      );
      const repo2 = await findOrCreateRepo2("github", "acme/other");

      const repo1 = await findOrCreateRepo("github", "acme/widget");
      await create({ title: "Task in repo1", body: "b", source: "manual", repoId: repo1.id, createdBy: user.id });
      await create({ title: "Task in repo2", body: "b", source: "manual", repoId: repo2.id, createdBy: user.id });

      const result = await list({ repoId: repo1.id });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe("Task in repo1");
    });

    it("filters by createdBy", async () => {
      const { user, repo } = await seedUserAndRepo();
      const user2 = await findOrCreateByEntraOid(
        "oid-other",
        "other@example.com",
        "Other User",
      );

      await create({ title: "Task by user1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Task by user2", body: "b", source: "manual", repoId: repo.id, createdBy: user2.id });

      const result = await list({ createdBy: user.id });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe("Task by user1");
    });

    it("filters by text search on title (case-insensitive)", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({ title: "Fix login bug", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Add dark mode", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Fix signup flow", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      const result = await list({ search: "fix" });
      expect(result.tasks).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("supports pagination with limit and offset", async () => {
      const { user, repo } = await seedUserAndRepo();

      for (let i = 1; i <= 5; i++) {
        await create({ title: `Task ${i}`, body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      }

      const page1 = await list({}, 2, 0);
      expect(page1.tasks).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await list({}, 2, 2);
      expect(page2.tasks).toHaveLength(2);
      expect(page2.total).toBe(5);

      const page3 = await list({}, 2, 4);
      expect(page3.tasks).toHaveLength(1);
      expect(page3.total).toBe(5);
    });

    it("combines multiple filters", async () => {
      const { user, repo } = await seedUserAndRepo();

      const t1 = await create({ title: "Fix login bug", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Add dark mode", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await updateStatus(t1.id, "queued");

      const result = await list({ status: "queued", search: "login" });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(t1.id);
    });
  });

  // ── listWithCosts ──────────────────────────────────────────────────────

  describe("listWithCosts", () => {
    it("returns tasks with totalCost property", async () => {
      const { user, repo } = await seedUserAndRepo();

      const task1 = await create({ title: "Task 1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      const task2 = await create({ title: "Task 2", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await recordCost(task1.id, user.id, "router", "model-a", 1.0);
      await recordCost(task1.id, user.id, "gate", "model-a", 2.0);
      await recordCost(task2.id, user.id, "worker", "model-b", 3.0);

      const result = await listWithCosts();

      expect(result.tasks).toHaveLength(2);
      expect(result.total).toBe(2);
      
      // Find tasks by title since order might vary
      const t1 = result.tasks.find(t => t.title === "Task 1");
      const t2 = result.tasks.find(t => t.title === "Task 2");
      
      expect(t1!.totalCost).toBeCloseTo(3.0, 2);
      expect(t2!.totalCost).toBeCloseTo(3.0, 2);
    });

    it("returns tasks with totalCost = 0 when no costs exist", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({ title: "Task no costs", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      const result = await listWithCosts();

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].totalCost).toBe(0);
    });

    it("respects filters like regular list function", async () => {
      const { user, repo } = await seedUserAndRepo();

      const t1 = await create({ title: "Task 1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      const t2 = await create({ title: "Task 2", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await recordCost(t1.id, user.id, "router", "model-a", 5.0);
      await recordCost(t2.id, user.id, "router", "model-a", 10.0);
      await updateStatus(t1.id, "queued");

      const result = await listWithCosts({ status: "queued" });

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(t1.id);
      expect(result.tasks[0].totalCost).toBeCloseTo(5.0, 2);
    });
  });

  // ── updateStatus ────────────────────────────────────────────────────────

  describe("updateStatus", () => {
    it("transitions pending -> queued", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Test", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      const updated = await updateStatus(task.id, "queued");

      expect(updated.status).toBe("queued");
      expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(task.updatedAt!).getTime(),
      );
    });

    it("throws on invalid transition (pending -> executing)", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Test", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await expect(updateStatus(task.id, "executing")).rejects.toThrow(
        "Invalid transition from 'pending' to 'executing'",
      );
    });

    it("throws when task not found", async () => {
      await expect(updateStatus("HIVE-00000000-0000", "queued")).rejects.toThrow(
        "Task HIVE-00000000-0000 not found",
      );
    });

    it("sets approvedBy when transitioning to approved", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Test", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      // pending -> queued -> enriching -> ready -> approved
      await updateStatus(task.id, "queued");
      await updateStatus(task.id, "enriching");
      await updateStatus(task.id, "ready", user.id);
      const approved = await updateStatus(task.id, "approved", user.id);

      expect(approved.status).toBe("approved");
      expect(approved.approvedBy).toBe(user.id);
    });

    it("sets approvedBy when transitioning to ready", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Test", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await updateStatus(task.id, "queued");
      await updateStatus(task.id, "enriching");
      const ready = await updateStatus(task.id, "ready", user.id);

      expect(ready.status).toBe("ready");
      expect(ready.approvedBy).toBe(user.id);
    });

    it("allows full lifecycle: pending -> ... -> merged", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Full lifecycle", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await updateStatus(task.id, "queued");
      await updateStatus(task.id, "enriching");
      await updateStatus(task.id, "ready");
      await updateStatus(task.id, "approved", user.id);
      await updateStatus(task.id, "executing");
      await updateStatus(task.id, "reviewing");
      await updateStatus(task.id, "done");
      const merged = await updateStatus(task.id, "merged");

      expect(merged.status).toBe("merged");
    });
  });

  // ── deleteByIds ─────────────────────────────────────────────────────────

  describe("deleteByIds", () => {
    it("deletes a single task by id", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "To delete", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      const deleted = await deleteByIds([task.id]);

      expect(deleted).toBe(1);
      const found = await getById(task.id);
      expect(found).toBeUndefined();
    });

    it("deletes multiple tasks by ids", async () => {
      const { user, repo } = await seedUserAndRepo();
      const t1 = await create({ title: "Delete me 1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      const t2 = await create({ title: "Delete me 2", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      const t3 = await create({ title: "Keep me", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      const deleted = await deleteByIds([t1.id, t2.id]);

      expect(deleted).toBe(2);
      expect(await getById(t1.id)).toBeUndefined();
      expect(await getById(t2.id)).toBeUndefined();
      expect(await getById(t3.id)).toBeDefined();
    });

    it("returns 0 when given an empty array", async () => {
      const deleted = await deleteByIds([]);
      expect(deleted).toBe(0);
    });

    it("returns 0 when ids do not match any tasks", async () => {
      const deleted = await deleteByIds(["HIVE-00000000-0000", "HIVE-00000000-0001"]);
      expect(deleted).toBe(0);
    });

    it("cascades deletion to related cost rows", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Task with costs", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await recordCost(task.id, user.id, "router", "model-a", 1.5);
      await recordCost(task.id, user.id, "gate", "model-a", 2.25);

      const deleted = await deleteByIds([task.id]);

      expect(deleted).toBe(1);
      expect(await getById(task.id)).toBeUndefined();
    });

    it("cascades deletion to related task_events rows without FK violation", async () => {
      const { user, repo } = await seedUserAndRepo();
      const task = await create({ title: "Task with events", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      // Insert task_events referencing the task (the source of the FK violation)
      await addEvent(task.id, "status_change", "daemon", "Task moved to queued");
      await addEvent(task.id, "status_change", "daemon", "Task moved to enriching");
      await addEvent(task.id, "enrichment_done", "enricher", "Enrichment complete");

      // This must not throw a foreign key constraint violation
      const deleted = await deleteByIds([task.id]);

      expect(deleted).toBe(1);
      expect(await getById(task.id)).toBeUndefined();
    });

    it("cascades deletion of task_events for multiple tasks", async () => {
      const { user, repo } = await seedUserAndRepo();
      const t1 = await create({ title: "Task A", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      const t2 = await create({ title: "Task B", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      const t3 = await create({ title: "Task C (keep)", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      await addEvent(t1.id, "status_change", "daemon", "Event for task A");
      await addEvent(t2.id, "status_change", "daemon", "Event for task B");
      await addEvent(t3.id, "status_change", "daemon", "Event for task C");

      const deleted = await deleteByIds([t1.id, t2.id]);

      expect(deleted).toBe(2);
      expect(await getById(t1.id)).toBeUndefined();
      expect(await getById(t2.id)).toBeUndefined();
      expect(await getById(t3.id)).toBeDefined();
    });
  });

  // ── countByStatus ───────────────────────────────────────────────────────

  describe("countByStatus", () => {
    it("returns empty object when no tasks exist", async () => {
      const counts = await countByStatus();
      expect(counts).toEqual({ archived: 0 });
    });

    it("returns correct counts grouped by status", async () => {
      const { user, repo } = await seedUserAndRepo();

      const t1 = await create({ title: "Task 1", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Task 2", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Task 3", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });

      // Move t1 to queued
      await updateStatus(t1.id, "queued");

      const counts = await countByStatus();
      expect(counts.pending).toBe(2);
      expect(counts.queued).toBe(1);
    });
  });

  // ── getOpenTasksForDedup ─────────────────────────────────────────────────

  describe("getOpenTasksForDedup", () => {
    it("returns non-terminal tasks with required fields", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({ title: "Open bug", body: "Something is broken", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await create({ title: "Open feature", body: "Add a new widget", source: "feature-scout", repoId: repo.id, createdBy: user.id });

      const results = await getOpenTasksForDedup();

      expect(results).toHaveLength(2);
      // Each result must expose the required fields
      for (const r of results) {
        expect(r).toHaveProperty("id");
        expect(r).toHaveProperty("title");
        expect(r).toHaveProperty("body");
        expect(r).toHaveProperty("status");
        expect(r).toHaveProperty("producerType");
      }
    });

    it("excludes tasks in terminal statuses (completed, cancelled, failed, merged, rejected)", async () => {
      const { user, repo } = await seedUserAndRepo();

      // Create tasks and walk them to terminal statuses
      const completed = await create({ title: "Done task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(completed.id, "queued");
      await updateStatus(completed.id, "enriching");
      await updateStatus(completed.id, "ready");
      await updateStatus(completed.id, "approved", user.id);
      await updateStatus(completed.id, "executing");
      await updateStatus(completed.id, "reviewing");
      await updateStatus(completed.id, "done");
      await updateStatus(completed.id, "merged");

      const cancelled = await create({ title: "Cancelled task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(cancelled.id, "cancelled");

      // This one remains open (pending)
      const open = await create({ title: "Still open", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });

      const results = await getOpenTasksForDedup();

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(open.id);
      expect(results[0].status).toBe("pending");
    });

    it("filters by producerType when provided", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({ title: "Bug task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await create({ title: "Feature task", body: "b", source: "feature-scout", repoId: repo.id, createdBy: user.id });
      await create({ title: "Security task", body: "b", source: "security-scanner", repoId: repo.id, createdBy: user.id });

      const bugOnly = await getOpenTasksForDedup({ producerType: "bug-hunter" });

      expect(bugOnly).toHaveLength(1);
      expect(bugOnly[0].producerType).toBe("bug-hunter");
      expect(bugOnly[0].title).toBe("Bug task");
    });

    it("returns empty array when producerType has no open tasks", async () => {
      const { user, repo } = await seedUserAndRepo();

      // Only create a feature-scout task
      await create({ title: "Feature task", body: "b", source: "feature-scout", repoId: repo.id, createdBy: user.id });

      const results = await getOpenTasksForDedup({ producerType: "bug-hunter" });

      expect(results).toHaveLength(0);
    });

    it("respects the limit option", async () => {
      const { user, repo } = await seedUserAndRepo();

      for (let i = 1; i <= 5; i++) {
        await create({ title: `Task ${i}`, body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      }

      const results = await getOpenTasksForDedup({ limit: 3 });

      expect(results).toHaveLength(3);
    });

    it("returns all open tasks when no filters are provided", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({ title: "Alpha", body: "b", source: "manual", repoId: repo.id, createdBy: user.id });
      await create({ title: "Beta", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });

      const results = await getOpenTasksForDedup();

      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array when no tasks exist", async () => {
      const results = await getOpenTasksForDedup();
      expect(results).toHaveLength(0);
    });

    it("includes tasks in every non-terminal status", async () => {
      const { user, repo } = await seedUserAndRepo();

      // pending (default on create)
      await create({ title: "Pending task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });

      // queued
      const queued = await create({ title: "Queued task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(queued.id, "queued");

      // enriching
      const enriching = await create({ title: "Enriching task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(enriching.id, "queued");
      await updateStatus(enriching.id, "enriching");

      // ready
      const ready = await create({ title: "Ready task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(ready.id, "queued");
      await updateStatus(ready.id, "enriching");
      await updateStatus(ready.id, "ready");

      const results = await getOpenTasksForDedup({ producerType: "bug-hunter" });
      expect(results).toHaveLength(4);

      const statuses = results.map((r) => r.status);
      expect(statuses).toContain("pending");
      expect(statuses).toContain("queued");
      expect(statuses).toContain("enriching");
      expect(statuses).toContain("ready");
    });

    it("does not include tasks in done, rejected, or completed terminal statuses", async () => {
      const { user, repo } = await seedUserAndRepo();

      // done
      const done = await create({ title: "Done task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(done.id, "queued");
      await updateStatus(done.id, "enriching");
      await updateStatus(done.id, "ready");
      await updateStatus(done.id, "approved", user.id);
      await updateStatus(done.id, "executing");
      await updateStatus(done.id, "reviewing");
      await updateStatus(done.id, "done");

      // failed
      const failed = await create({ title: "Failed task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(failed.id, "queued");
      await updateStatus(failed.id, "enriching");
      await updateStatus(failed.id, "ready");
      await updateStatus(failed.id, "approved");
      await updateStatus(failed.id, "executing");
      await updateStatus(failed.id, "failed");

      // cancelled
      const cancelled = await create({ title: "Cancelled task", body: "b", source: "bug-hunter", repoId: repo.id, createdBy: user.id });
      await updateStatus(cancelled.id, "cancelled");

      const results = await getOpenTasksForDedup({ producerType: "bug-hunter" });
      expect(results).toHaveLength(0);
    });

    it("returned rows include id, title, body, status, and producerType fields", async () => {
      const { user, repo } = await seedUserAndRepo();

      await create({
        title: "Test field shape",
        body: "Body content here",
        source: "security-scanner",
        repoId: repo.id,
        createdBy: user.id,
      });

      const [row] = await getOpenTasksForDedup({ producerType: "security-scanner" });

      expect(row.id).toMatch(/^HIVE-/);
      expect(row.title).toBe("Test field shape");
      expect(row.body).toBe("Body content here");
      expect(row.status).toBe("pending");
      expect(row.producerType).toBe("security-scanner");

      // Ensure no extra sensitive fields leak through
      expect((row as any).createdBy).toBeUndefined();
      expect((row as any).repoId).toBeUndefined();
    });
  });
});
