import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// Mock src/db/connection.js so that query functions use our test db/pool
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Import AFTER the mock is registered
const { createLearning } = await import("../../src/db/queries/learnings.js");
const { recordEvent, getEventsForLearning, getEventsForTask, getRecentEvents } =
  await import("../../src/db/queries/learning-events.js");
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const { create: createTask } = await import("../../src/db/queries/tasks.js");

useTestDb();

// Helper to create a task (needed because learning_events.task_id references tasks)
async function seedTask() {
  const user = await findOrCreateByEntraOid(
    "oid-le-test",
    "le@example.com",
    "LE User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Test task for learning events",
    body: "body",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return task;
}

describe("learning-events queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── recordEvent ─────────────────────────────────────────────────────────────

  describe("recordEvent", () => {
    it("creates an event", async () => {
      const learning = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Test learning",
      });

      const event = await recordEvent({
        learningId: learning.id,
        eventType: "reinforced",
        evidence: "Task passed review on first attempt",
      });

      expect(event).toBeDefined();
      expect(event.learningId).toBe(learning.id);
      expect(event.eventType).toBe("reinforced");
      expect(event.evidence).toBe("Task passed review on first attempt");
      expect(event.taskId).toBeNull();
      expect(event.createdAt).toBeTruthy();
    });
  });

  // ── getEventsForLearning ──────────────────────────────────────────────────

  describe("getEventsForLearning", () => {
    it("returns events for a specific learning", async () => {
      const learning1 = await createLearning({
        scope: "universal",
        category: "a",
        content: "L1",
      });
      const learning2 = await createLearning({
        scope: "universal",
        category: "b",
        content: "L2",
      });

      await recordEvent({ learningId: learning1.id, eventType: "reinforced" });
      await recordEvent({ learningId: learning1.id, eventType: "contradicted" });
      await recordEvent({ learningId: learning2.id, eventType: "reinforced" });

      const events = await getEventsForLearning(learning1.id);
      expect(events).toHaveLength(2);
      events.forEach((e) => expect(e.learningId).toBe(learning1.id));
    });
  });

  // ── getEventsForTask ──────────────────────────────────────────────────────

  describe("getEventsForTask", () => {
    it("returns events tied to a task", async () => {
      const task = await seedTask();
      const learning = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Test learning",
      });

      await recordEvent({
        learningId: learning.id,
        eventType: "reinforced",
        taskId: task.id,
      });
      await recordEvent({
        learningId: learning.id,
        eventType: "created",
      });

      const events = await getEventsForTask(task.id);
      expect(events).toHaveLength(1);
      expect(events[0].taskId).toBe(task.id);
      expect(events[0].eventType).toBe("reinforced");
    });
  });

  // ── getRecentEvents ───────────────────────────────────────────────────────

  describe("getRecentEvents", () => {
    it("returns recent events", async () => {
      const learning = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Test learning",
      });

      await recordEvent({ learningId: learning.id, eventType: "created" });
      await recordEvent({ learningId: learning.id, eventType: "reinforced" });
      await recordEvent({ learningId: learning.id, eventType: "contradicted" });

      const events = await getRecentEvents(2);
      expect(events).toHaveLength(2);
      // Most recent first
      expect(events[0].eventType).toBe("contradicted");
      expect(events[1].eventType).toBe("reinforced");
    });
  });
});
