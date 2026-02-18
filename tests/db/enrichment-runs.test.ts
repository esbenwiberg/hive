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
const { recordRun, listByTask, mergeResults } = await import(
  "../../src/db/queries/enrichment-runs.js"
);

useTestDb();

// Helper to seed prerequisite data
async function seedTask() {
  const user = await findOrCreateByEntraOid(
    "oid-enrich-run-test",
    "enrich-run@example.com",
    "Enrich Run User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Test task for enrichment runs",
    body: "body",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

describe("enrichment-runs queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── recordRun ───────────────────────────────────────────────────────────────

  describe("recordRun", () => {
    it("inserts a completed enrichment run and returns it", async () => {
      const { task } = await seedTask();

      const row = await recordRun(
        task.id,
        "codebase",
        "completed",
        { files: 42 },
        0.0,
        250,
      );

      expect(row).toBeDefined();
      expect(row.taskId).toBe(task.id);
      expect(row.enricher).toBe("codebase");
      expect(row.status).toBe("completed");
      expect(row.result).toEqual({ files: 42 });
      expect(row.durationMs).toBe(250);
      expect(row.error).toBeNull();
      expect(row.createdAt).toBeTruthy();
    });

    it("inserts a failed enrichment run with error message", async () => {
      const { task } = await seedTask();

      const row = await recordRun(
        task.id,
        "docs",
        "failed",
        undefined,
        undefined,
        undefined,
        "Permission denied",
      );

      expect(row.status).toBe("failed");
      expect(row.result).toBeNull();
      expect(row.costUsd).toBeNull();
      expect(row.durationMs).toBeNull();
      expect(row.error).toBe("Permission denied");
    });

    it("records costUsd as a numeric value", async () => {
      const { task } = await seedTask();

      const row = await recordRun(
        task.id,
        "ai-enricher",
        "completed",
        { summary: "hello" },
        0.0567,
        100,
      );

      expect(parseFloat(row.costUsd!)).toBeCloseTo(0.0567, 4);
    });
  });

  // ── listByTask ──────────────────────────────────────────────────────────────

  describe("listByTask", () => {
    it("returns empty array when no runs exist", async () => {
      const { task } = await seedTask();

      const runs = await listByTask(task.id);
      expect(runs).toEqual([]);
    });

    it("returns all runs for a task ordered by createdAt", async () => {
      const { task } = await seedTask();

      await recordRun(task.id, "codebase", "completed", { a: 1 }, undefined, 100);
      await recordRun(task.id, "docs", "completed", { b: 2 }, undefined, 200);
      await recordRun(task.id, "ai", "failed", undefined, undefined, undefined, "boom");

      const runs = await listByTask(task.id);
      expect(runs).toHaveLength(3);
      expect(runs[0].enricher).toBe("codebase");
      expect(runs[1].enricher).toBe("docs");
      expect(runs[2].enricher).toBe("ai");
    });

    it("does not include runs from other tasks", async () => {
      const { task } = await seedTask();

      // Create a second task
      const { findOrCreateByEntraOid: find } = await import(
        "../../src/db/queries/users.js"
      );
      const user = await find("oid-other-task", "other@example.com", "Other");
      const { findOrCreate } = await import("../../src/db/queries/repos.js");
      const repo = await findOrCreate("github", "acme/other");
      const { create } = await import("../../src/db/queries/tasks.js");
      const otherTask = await create({
        title: "Other task",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await recordRun(task.id, "codebase", "completed", { a: 1 }, undefined, 100);
      await recordRun(otherTask.id, "codebase", "completed", { b: 2 }, undefined, 100);

      const runs = await listByTask(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].taskId).toBe(task.id);
    });
  });

  // ── mergeResults ────────────────────────────────────────────────────────────

  describe("mergeResults", () => {
    it("returns empty object when no completed runs exist", async () => {
      const { task } = await seedTask();

      const merged = await mergeResults(task.id);
      expect(merged).toEqual({});
    });

    it("merges results from completed runs only", async () => {
      const { task } = await seedTask();

      await recordRun(task.id, "codebase", "completed", { files: 42 }, undefined, 100);
      await recordRun(task.id, "docs", "failed", undefined, undefined, undefined, "error");
      await recordRun(task.id, "ai", "completed", { summary: "good" }, undefined, 200);

      const merged = await mergeResults(task.id);
      expect(merged).toEqual({ files: 42, summary: "good" });
    });

    it("later results override earlier for conflicting keys", async () => {
      const { task } = await seedTask();

      await recordRun(task.id, "codebase", "completed", { shared: "first", a: 1 }, undefined, 100);
      await recordRun(task.id, "docs", "completed", { shared: "second", b: 2 }, undefined, 100);

      const merged = await mergeResults(task.id);
      expect(merged).toEqual({ shared: "second", a: 1, b: 2 });
    });
  });
});
