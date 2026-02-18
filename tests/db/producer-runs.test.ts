import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// Mock src/db/connection.js so that query functions use our test db/pool
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Import AFTER the mock is registered
const { recordRun, listRecent } = await import(
  "../../src/db/queries/producer-runs.js"
);

useTestDb();

describe("producer-runs queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── recordRun ─────────────────────────────────────────────────────────────

  describe("recordRun", () => {
    it("inserts a row with correct fields and returns it", async () => {
      const row = await recordRun({
        producer: "issue-scanner",
        repo: "acme/widget",
        tasksCreated: 3,
        duplicatesSkipped: 1,
        errors: ["something went wrong"],
        costUsd: 0.0512,
        durationMs: 1500,
      });

      expect(row).toBeDefined();
      expect(row.id).toBeGreaterThan(0);
      expect(row.producer).toBe("issue-scanner");
      expect(row.repo).toBe("acme/widget");
      expect(row.tasksCreated).toBe(3);
      expect(row.duplicatesSkipped).toBe(1);
      expect(row.errors).toEqual(["something went wrong"]);
      expect(parseFloat(row.costUsd!)).toBeCloseTo(0.0512, 4);
      expect(row.durationMs).toBe(1500);
      expect(row.createdAt).toBeTruthy();
    });

    it("allows repo to be omitted (null)", async () => {
      const row = await recordRun({
        producer: "backlog-scanner",
        tasksCreated: 0,
        duplicatesSkipped: 0,
        errors: [],
        costUsd: 0,
        durationMs: 100,
      });

      expect(row.repo).toBeNull();
    });
  });

  // ── listRecent ────────────────────────────────────────────────────────────

  describe("listRecent", () => {
    it("returns empty array when no runs exist", async () => {
      const runs = await listRecent("nonexistent");
      expect(runs).toEqual([]);
    });

    it("returns rows in descending createdAt order", async () => {
      // Insert three runs sequentially so createdAt differs
      await recordRun({
        producer: "issue-scanner",
        repo: "acme/first",
        tasksCreated: 1,
        duplicatesSkipped: 0,
        errors: [],
        costUsd: 0.01,
        durationMs: 100,
      });

      await recordRun({
        producer: "issue-scanner",
        repo: "acme/second",
        tasksCreated: 2,
        duplicatesSkipped: 0,
        errors: [],
        costUsd: 0.02,
        durationMs: 200,
      });

      await recordRun({
        producer: "issue-scanner",
        repo: "acme/third",
        tasksCreated: 3,
        duplicatesSkipped: 0,
        errors: [],
        costUsd: 0.03,
        durationMs: 300,
      });

      const runs = await listRecent("issue-scanner");
      expect(runs).toHaveLength(3);
      // Descending order: most recent first
      expect(runs[0].repo).toBe("acme/third");
      expect(runs[1].repo).toBe("acme/second");
      expect(runs[2].repo).toBe("acme/first");
    });

    it("respects the limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await recordRun({
          producer: "bulk-producer",
          tasksCreated: i,
          duplicatesSkipped: 0,
          errors: [],
          costUsd: 0,
          durationMs: 50,
        });
      }

      const runs = await listRecent("bulk-producer", 2);
      expect(runs).toHaveLength(2);
    });

    it("only returns runs for the specified producer", async () => {
      await recordRun({
        producer: "alpha",
        tasksCreated: 1,
        duplicatesSkipped: 0,
        errors: [],
        costUsd: 0,
        durationMs: 50,
      });

      await recordRun({
        producer: "beta",
        tasksCreated: 2,
        duplicatesSkipped: 0,
        errors: [],
        costUsd: 0,
        durationMs: 50,
      });

      const runs = await listRecent("alpha");
      expect(runs).toHaveLength(1);
      expect(runs[0].producer).toBe("alpha");
    });
  });
});
