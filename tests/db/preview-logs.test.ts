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
const { addPreviewLog, getPreviewLogs } = await import(
  "../../src/db/queries/preview-logs.js"
);

useTestDb();

// Helper to set up user + repo + task for preview log tests
async function seedData() {
  const user = await findOrCreateByEntraOid(
    "oid-preview-test",
    "preview@example.com",
    "Preview User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Test task for preview logs",
    body: "body",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

describe("preview-logs queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── addPreviewLog ────────────────────────────────────────────────────────

  describe("addPreviewLog", () => {
    it("inserts a log row and returns it", async () => {
      const { task } = await seedData();

      const row = await addPreviewLog(task.id, "docker", "Container started");

      expect(row).toBeDefined();
      expect(row.taskId).toBe(task.id);
      expect(row.source).toBe("docker");
      expect(row.message).toBe("Container started");
      expect(row.createdAt).toBeTruthy();
    });

    it("inserts multiple logs for the same task", async () => {
      const { task } = await seedData();

      await addPreviewLog(task.id, "docker", "Pulling image");
      await addPreviewLog(task.id, "docker", "Container started");
      await addPreviewLog(task.id, "health", "Health check passed");

      const rows = await getPreviewLogs(task.id);
      expect(rows).toHaveLength(3);
    });
  });

  // ── getPreviewLogs ─────────────────────────────────────────────────────

  describe("getPreviewLogs", () => {
    it("returns empty array when no logs exist", async () => {
      const { task } = await seedData();

      const rows = await getPreviewLogs(task.id);
      expect(rows).toHaveLength(0);
    });

    it("returns logs ordered by createdAt descending", async () => {
      const { task } = await seedData();

      await addPreviewLog(task.id, "docker", "First");
      await addPreviewLog(task.id, "docker", "Second");
      await addPreviewLog(task.id, "docker", "Third");

      const rows = await getPreviewLogs(task.id);
      expect(rows).toHaveLength(3);
      // Most recent first
      expect(rows[0].message).toBe("Third");
      expect(rows[2].message).toBe("First");
    });

    it("respects the limit parameter", async () => {
      const { task } = await seedData();

      await addPreviewLog(task.id, "docker", "First");
      await addPreviewLog(task.id, "docker", "Second");
      await addPreviewLog(task.id, "docker", "Third");

      const rows = await getPreviewLogs(task.id, 2);
      expect(rows).toHaveLength(2);
      // Should get the 2 most recent
      expect(rows[0].message).toBe("Third");
      expect(rows[1].message).toBe("Second");
    });

    it("does not return logs for other tasks", async () => {
      const { user, repo, task } = await seedData();

      const task2 = await createTask({
        title: "Another task",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await addPreviewLog(task.id, "docker", "Log for task 1");
      await addPreviewLog(task2.id, "docker", "Log for task 2");

      const rows = await getPreviewLogs(task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toBe("Log for task 1");
    });
  });
});
