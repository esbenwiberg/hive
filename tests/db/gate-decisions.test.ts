import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

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
const { create: createTask } = await import("../../src/db/queries/tasks.js");
const { recordDecision, listByTask } = await import(
  "../../src/db/queries/gate-decisions.js"
);

useTestDb();

// Helper to set up user + repo + task for gate decision tests
async function seedData() {
  const user = await findOrCreateByEntraOid(
    "oid-gate-test",
    "gate@example.com",
    "Gate User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Test task for gate decisions",
    body: "body",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

describe("gate-decisions queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── recordDecision ──────────────────────────────────────────────────────────

  describe("recordDecision", () => {
    it("inserts a decision row and returns it", async () => {
      const { user, task } = await seedData();

      const row = await recordDecision(
        task.id,
        "approve",
        "ai",
        undefined,
        "Looks good",
        { size: "small", type: "bug" },
      );

      expect(row).toBeDefined();
      expect(row.taskId).toBe(task.id);
      expect(row.verdict).toBe("approve");
      expect(row.source).toBe("ai");
      expect(row.decidedBy).toBeNull();
      expect(row.reasoning).toBe("Looks good");
      expect(row.taskContext).toEqual({ size: "small", type: "bug" });
      expect(row.createdAt).toBeTruthy();
    });

    it("records a human decision with decidedBy", async () => {
      const { user, task } = await seedData();

      const row = await recordDecision(
        task.id,
        "approved",
        "human",
        user.id,
      );

      expect(row.decidedBy).toBe(user.id);
      expect(row.source).toBe("human");
      expect(row.reasoning).toBeNull();
      expect(row.taskContext).toBeNull();
    });

    it("records a reject decision", async () => {
      const { task } = await seedData();

      const row = await recordDecision(
        task.id,
        "reject",
        "ai",
        undefined,
        "Too risky",
      );

      expect(row.verdict).toBe("reject");
      expect(row.reasoning).toBe("Too risky");
    });

    it("records a rework decision", async () => {
      const { task } = await seedData();

      const row = await recordDecision(
        task.id,
        "rework",
        "ai",
        undefined,
        "Needs more detail",
      );

      expect(row.verdict).toBe("rework");
      expect(row.reasoning).toBe("Needs more detail");
    });
  });

  // ── listByTask ────────────────────────────────────────────────────────────

  describe("listByTask", () => {
    it("returns empty array when no decisions exist", async () => {
      const { task } = await seedData();

      const rows = await listByTask(task.id);
      expect(rows).toHaveLength(0);
    });

    it("returns all decisions for a task", async () => {
      const { task } = await seedData();

      await recordDecision(task.id, "rework", "ai", undefined, "First pass");
      await recordDecision(task.id, "approve", "ai", undefined, "Second pass");

      const rows = await listByTask(task.id);
      expect(rows).toHaveLength(2);
    });

    it("returns decisions ordered by createdAt descending", async () => {
      const { task } = await seedData();

      await recordDecision(task.id, "rework", "ai", undefined, "First");
      await recordDecision(task.id, "approve", "ai", undefined, "Second");

      const rows = await listByTask(task.id);
      // Most recent first
      expect(rows[0].reasoning).toBe("Second");
      expect(rows[1].reasoning).toBe("First");
    });

    it("does not return decisions for other tasks", async () => {
      const { user, repo, task } = await seedData();

      const task2 = await createTask({
        title: "Another task",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await recordDecision(task.id, "approve", "ai", undefined, "For task 1");
      await recordDecision(task2.id, "reject", "ai", undefined, "For task 2");

      const rows = await listByTask(task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].reasoning).toBe("For task 1");
    });
  });
});
