import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, cleanupTables, useTestDb } from "../setup.js";

// Mock db/connection.js so queries use our test database
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { isDuplicate, isRefusalTitle } = await import("../../src/producers/base.js");
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
    "oid-base-test",
    "base@example.com",
    "Base Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("isDuplicate", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  it("returns true when a task with the same source and title exists in non-terminal status", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Fix login bug",
      body: "body",
      source: "producer:test",
      repoId: repo.id,
      createdBy: user.id,
    });

    const result = await isDuplicate("producer:test", "Fix login bug");
    expect(result).toBe(true);
  });

  it("returns false for a different title", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Fix login bug",
      body: "body",
      source: "producer:test",
      repoId: repo.id,
      createdBy: user.id,
    });

    const result = await isDuplicate("producer:test", "Fix signup bug");
    expect(result).toBe(false);
  });

  it("returns false when existing task is in terminal status (failed)", async () => {
    const { user, repo } = await seedUserAndRepo();

    const task = await createTask({
      title: "Fix login bug",
      body: "body",
      source: "producer:test",
      repoId: repo.id,
      createdBy: user.id,
    });

    // Move through states to reach failed: pending -> queued -> enriching -> ready -> approved -> executing -> failed
    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");
    await updateStatus(task.id, "ready");
    await updateStatus(task.id, "approved");
    await updateStatus(task.id, "executing");
    await updateStatus(task.id, "failed");

    const result = await isDuplicate("producer:test", "Fix login bug");
    expect(result).toBe(false);
  });

  it("returns false when no tasks exist", async () => {
    const result = await isDuplicate("producer:test", "Nonexistent task");
    expect(result).toBe(false);
  });
});

describe("isRefusalTitle", () => {
  it("detects common LLM refusal patterns", () => {
    expect(isRefusalTitle("I don't have the ability to directly analyze external repositories")).toBe(true);
    expect(isRefusalTitle("I cannot directly access GitHub repositories")).toBe(true);
    expect(isRefusalTitle("I can't analyze the repository without access")).toBe(true);
    expect(isRefusalTitle("I would need you to share the code first")).toBe(true);
    expect(isRefusalTitle("Please share the relevant code files so I can help")).toBe(true);
  });

  it("rejects titles longer than 200 chars", () => {
    expect(isRefusalTitle("A".repeat(201))).toBe(true);
  });

  it("allows legitimate task titles", () => {
    expect(isRefusalTitle("Race condition in auth middleware")).toBe(false);
    expect(isRefusalTitle("XSS vulnerability in comment rendering")).toBe(false);
    expect(isRefusalTitle("Add dark mode support")).toBe(false);
    expect(isRefusalTitle("Missing CSRF token validation")).toBe(false);
  });
});
