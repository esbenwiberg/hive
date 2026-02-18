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
const { recordReview, listByTask, getLatestByTask } = await import(
  "../../src/db/queries/code-reviews.js"
);

useTestDb();

// Helper to set up user + repo + task for code review tests
async function seedData() {
  const user = await findOrCreateByEntraOid(
    "oid-review-test",
    "review@example.com",
    "Review User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Test task for code reviews",
    body: "body",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

describe("code-reviews queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── recordReview ──────────────────────────────────────────────────────────

  describe("recordReview", () => {
    it("inserts a review row and returns it", async () => {
      const { task } = await seedData();

      const row = await recordReview(
        task.id,
        "pass",
        0,
        [{ severity: "info", file: "src/main.ts", message: "Looks good", category: "correctness" }],
        [],
        { testsRun: true, testsPassed: true, lintClean: true, buildSucceeded: true, notes: [] },
        0.0052,
      );

      expect(row).toBeDefined();
      expect(row.taskId).toBe(task.id);
      expect(row.verdict).toBe("pass");
      expect(row.reworkCycle).toBe(0);
      expect(row.findings).toEqual([
        { severity: "info", file: "src/main.ts", message: "Looks good", category: "correctness" },
      ]);
      expect(row.securityFindings).toEqual([]);
      expect(row.verification).toEqual({
        testsRun: true,
        testsPassed: true,
        lintClean: true,
        buildSucceeded: true,
        notes: [],
      });
      expect(parseFloat(row.costUsd!)).toBeCloseTo(0.0052, 4);
      expect(row.createdAt).toBeTruthy();
    });

    it("allows null optional fields", async () => {
      const { task } = await seedData();

      const row = await recordReview(task.id, "rework", 1);

      expect(row.findings).toBeNull();
      expect(row.securityFindings).toBeNull();
      expect(row.verification).toBeNull();
      expect(row.costUsd).toBeNull();
    });

    it("records a fail verdict", async () => {
      const { task } = await seedData();

      const row = await recordReview(
        task.id,
        "fail",
        2,
        undefined,
        [{ severity: "critical", type: "injection", description: "SQL injection", file: "src/db.ts" }],
      );

      expect(row.verdict).toBe("fail");
      expect(row.reworkCycle).toBe(2);
      expect(row.securityFindings).toEqual([
        { severity: "critical", type: "injection", description: "SQL injection", file: "src/db.ts" },
      ]);
    });
  });

  // ── listByTask ──────────────────────────────────────────────────────────

  describe("listByTask", () => {
    it("returns empty array when no reviews exist", async () => {
      const { task } = await seedData();

      const rows = await listByTask(task.id);
      expect(rows).toHaveLength(0);
    });

    it("returns all reviews for a task", async () => {
      const { task } = await seedData();

      await recordReview(task.id, "rework", 0);
      await recordReview(task.id, "pass", 1);

      const rows = await listByTask(task.id);
      expect(rows).toHaveLength(2);
    });

    it("returns reviews ordered by createdAt descending", async () => {
      const { task } = await seedData();

      await recordReview(task.id, "rework", 0);
      await recordReview(task.id, "pass", 1);

      const rows = await listByTask(task.id);
      // Most recent first
      expect(rows[0].verdict).toBe("pass");
      expect(rows[1].verdict).toBe("rework");
    });

    it("does not return reviews for other tasks", async () => {
      const { user, repo, task } = await seedData();

      const task2 = await createTask({
        title: "Another task",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await recordReview(task.id, "pass", 0);
      await recordReview(task2.id, "fail", 0);

      const rows = await listByTask(task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].verdict).toBe("pass");
    });
  });

  // ── getLatestByTask ─────────────────────────────────────────────────────

  describe("getLatestByTask", () => {
    it("returns undefined when no reviews exist", async () => {
      const { task } = await seedData();

      const row = await getLatestByTask(task.id);
      expect(row).toBeUndefined();
    });

    it("returns the most recent review only", async () => {
      const { task } = await seedData();

      await recordReview(task.id, "rework", 0);
      await recordReview(task.id, "rework", 1);
      await recordReview(task.id, "pass", 2);

      const row = await getLatestByTask(task.id);
      expect(row).toBeDefined();
      expect(row!.verdict).toBe("pass");
      expect(row!.reworkCycle).toBe(2);
    });
  });
});
