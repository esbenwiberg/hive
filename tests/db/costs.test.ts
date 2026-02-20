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
const { recordCost, getTodayTotal, getUserTotal, checkBudget, getTotalCostForTask } = await import(
  "../../src/db/queries/costs.js"
);

useTestDb();

// Helper to set up user + repo + task for cost tests
async function seedData() {
  const user = await findOrCreateByEntraOid(
    "oid-cost-test",
    "cost@example.com",
    "Cost User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Test task for costs",
    body: "body",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

describe("cost queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── recordCost ─────────────────────────────────────────────────────────────

  describe("recordCost", () => {
    it("inserts a cost row and returns it", async () => {
      const { user, task } = await seedData();

      const row = await recordCost(
        task.id,
        user.id,
        "router",
        "claude-sonnet-4-20250514",
        0.0123,
        1,
        450,
      );

      expect(row).toBeDefined();
      expect(row.taskId).toBe(task.id);
      expect(row.userId).toBe(user.id);
      expect(row.agent).toBe("router");
      expect(row.model).toBe("claude-sonnet-4-20250514");
      expect(parseFloat(row.costUsd)).toBeCloseTo(0.0123, 4);
      expect(row.turns).toBe(1);
      expect(row.durationMs).toBe(450);
      expect(row.createdAt).toBeTruthy();
    });

    it("allows null turns and durationMs", async () => {
      const { user, task } = await seedData();

      const row = await recordCost(
        task.id,
        user.id,
        "gate",
        "claude-sonnet-4-20250514",
        0.005,
      );

      expect(row.turns).toBeNull();
      expect(row.durationMs).toBeNull();
    });
  });

  // ── getTotalCostForTask ────────────────────────────────────────────────────

  describe("getTotalCostForTask", () => {
    it("returns 0 when no costs exist for a task", async () => {
      const { task } = await seedData();

      const total = await getTotalCostForTask(task.id);
      expect(total).toBe(0);
    });

    it("sums all costs for a specific task", async () => {
      const { user, task } = await seedData();

      await recordCost(task.id, user.id, "router", "model-a", 1.5);
      await recordCost(task.id, user.id, "gate", "model-a", 2.25);
      await recordCost(task.id, user.id, "worker", "model-b", 3.0);

      const total = await getTotalCostForTask(task.id);
      expect(total).toBeCloseTo(6.75, 2);
    });

    it("only includes costs for the specific task", async () => {
      const { user, repo } = await seedData();
      
      const task1 = await createTask({
        title: "Task 1",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });
      
      const task2 = await createTask({
        title: "Task 2",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await recordCost(task1.id, user.id, "router", "model-a", 5.0);
      await recordCost(task2.id, user.id, "router", "model-a", 10.0);

      const total1 = await getTotalCostForTask(task1.id);
      const total2 = await getTotalCostForTask(task2.id);
      
      expect(total1).toBeCloseTo(5.0, 2);
      expect(total2).toBeCloseTo(10.0, 2);
    });

    it("handles non-existent task gracefully", async () => {
      const total = await getTotalCostForTask("non-existent-task");
      expect(total).toBe(0);
    });

    it("accumulates costs with different decimal precision", async () => {
      const { user, task } = await seedData();

      await recordCost(task.id, user.id, "router", "model-a", 0.0001);
      await recordCost(task.id, user.id, "gate", "model-a", 0.9999);
      await recordCost(task.id, user.id, "worker", "model-b", 1.0);

      const total = await getTotalCostForTask(task.id);
      expect(total).toBeCloseTo(2.0, 4);
    });
  });

  // ── getTodayTotal ──────────────────────────────────────────────────────────

  describe("getTodayTotal", () => {
    it("returns 0 when no costs exist", async () => {
      const { user } = await seedData();

      const total = await getTodayTotal(user.id);
      expect(total).toBe(0);
    });

    it("sums costs created today", async () => {
      const { user, task } = await seedData();

      await recordCost(task.id, user.id, "router", "model-a", 1.5);
      await recordCost(task.id, user.id, "gate", "model-a", 2.25);

      const total = await getTodayTotal(user.id);
      expect(total).toBeCloseTo(3.75, 2);
    });

    it("does not include costs from other users", async () => {
      const { user, task } = await seedData();
      const otherUser = await findOrCreateByEntraOid(
        "oid-other",
        "other@example.com",
        "Other",
      );

      await recordCost(task.id, user.id, "router", "model-a", 5.0);
      await recordCost(task.id, otherUser.id, "router", "model-a", 10.0);

      const total = await getTodayTotal(user.id);
      expect(total).toBeCloseTo(5.0, 2);
    });
  });

  // ── getUserTotal ───────────────────────────────────────────────────────────

  describe("getUserTotal", () => {
    it("returns 0 when no costs exist", async () => {
      const { user } = await seedData();

      const total = await getUserTotal(user.id);
      expect(total).toBe(0);
    });

    it("sums all costs for a user (lifetime)", async () => {
      const { user, task } = await seedData();

      await recordCost(task.id, user.id, "router", "model-a", 1.0);
      await recordCost(task.id, user.id, "gate", "model-a", 2.0);
      await recordCost(task.id, user.id, "executor", "model-b", 3.0);

      const total = await getUserTotal(user.id);
      expect(total).toBeCloseTo(6.0, 2);
    });
  });

  // ── checkBudget ────────────────────────────────────────────────────────────

  describe("checkBudget", () => {
    it("returns full budget when no costs exist", async () => {
      const { user } = await seedData();

      const remaining = await checkBudget(user.id, 50.0);
      expect(remaining).toBeCloseTo(50.0, 2);
    });

    it("subtracts today's spend from the daily budget", async () => {
      const { user, task } = await seedData();

      await recordCost(task.id, user.id, "router", "model-a", 10.0);
      await recordCost(task.id, user.id, "gate", "model-a", 5.0);

      const remaining = await checkBudget(user.id, 50.0);
      expect(remaining).toBeCloseTo(35.0, 2);
    });

    it("returns negative when over budget", async () => {
      const { user, task } = await seedData();

      await recordCost(task.id, user.id, "router", "model-a", 60.0);

      const remaining = await checkBudget(user.id, 50.0);
      expect(remaining).toBeCloseTo(-10.0, 2);
    });

    it("reads dailyBudget from user record when not provided", async () => {
      const { user, task } = await seedData();
      // Default dailyBudget in schema is 100.00

      await recordCost(task.id, user.id, "router", "model-a", 30.0);

      const remaining = await checkBudget(user.id);
      expect(remaining).toBeCloseTo(70.0, 2);
    });
  });
});