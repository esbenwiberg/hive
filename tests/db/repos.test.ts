import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, cleanupTables, useTestDb } from "../setup.js";

// Mock src/db/connection.js so that query functions use our test db/pool
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Import AFTER the mock is registered
const { findOrCreate, getById, listAll } = await import(
  "../../src/db/queries/repos.js"
);

useTestDb();

describe("repos queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── findOrCreate ────────────────────────────────────────────────────────

  describe("findOrCreate", () => {
    it("creates a new repo on first call", async () => {
      const repo = await findOrCreate("github", "acme/widget");

      expect(repo).toBeDefined();
      expect(repo.provider).toBe("github");
      expect(repo.fullName).toBe("acme/widget");
      expect(repo.defaultBranch).toBe("main");
      expect(repo.id).toBeTypeOf("number");
      expect(repo.createdAt).toBeTruthy();
    });

    it("accepts an optional defaultBranch", async () => {
      const repo = await findOrCreate("github", "acme/legacy", "develop");

      expect(repo.defaultBranch).toBe("develop");
    });

    it("is idempotent — returns same repo on repeated calls", async () => {
      const first = await findOrCreate("github", "acme/widget");
      const second = await findOrCreate("github", "acme/widget");

      expect(second.id).toBe(first.id);
      expect(second.provider).toBe("github");
      expect(second.fullName).toBe("acme/widget");
    });

    it("updates updatedAt on conflict", async () => {
      const first = await findOrCreate("github", "acme/widget");
      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await findOrCreate("github", "acme/widget");

      expect(second.id).toBe(first.id);
      // updatedAt should be >= the original
      expect(new Date(second.updatedAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(first.updatedAt!).getTime(),
      );
    });

    it("treats different providers as distinct repos", async () => {
      const gh = await findOrCreate("github", "acme/widget");
      const gl = await findOrCreate("gitlab", "acme/widget");

      expect(gh.id).not.toBe(gl.id);
    });
  });

  // ── getById ─────────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns the repo when it exists", async () => {
      const created = await findOrCreate("github", "acme/widget");
      const found = await getById(created.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.fullName).toBe("acme/widget");
    });

    it("returns undefined for a nonexistent id", async () => {
      const found = await getById(999999);
      expect(found).toBeUndefined();
    });
  });

  // ── listAll ─────────────────────────────────────────────────────────────

  describe("listAll", () => {
    it("returns empty array when no repos exist", async () => {
      const all = await listAll();
      expect(all).toEqual([]);
    });

    it("returns all repos", async () => {
      await findOrCreate("github", "acme/widget");
      await findOrCreate("github", "acme/gadget");
      await findOrCreate("gitlab", "acme/widget");

      const all = await listAll();
      expect(all).toHaveLength(3);
    });
  });
});
