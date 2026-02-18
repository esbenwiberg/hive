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
const {
  getByUserAndProvider,
  getByUser,
  create,
  deleteByUserAndProvider,
} = await import("../../src/db/queries/user-credentials.js");

useTestDb();

// Helper to set up a user for credential tests
async function seedUser() {
  const user = await findOrCreateByEntraOid(
    "oid-cred-test",
    "cred@example.com",
    "Credential User",
  );
  return user;
}

describe("user-credentials queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── create ──────────────────────────────────────────────────────────────

  describe("create", () => {
    it("inserts a credential row and returns it", async () => {
      const user = await seedUser();

      const row = await create(user.id, "github", "vault-secret-123");

      expect(row).toBeDefined();
      expect(row.userId).toBe(user.id);
      expect(row.provider).toBe("github");
      expect(row.vaultSecretId).toBe("vault-secret-123");
      expect(row.label).toBe("default");
      expect(row.createdAt).toBeTruthy();
    });

    it("inserts a credential with a label", async () => {
      const user = await seedUser();

      const row = await create(user.id, "github", "vault-secret-456", "work-account");

      expect(row.label).toBe("work-account");
    });

    it("upserts on conflict (same userId+provider+label)", async () => {
      const user = await seedUser();

      // Use an explicit label — NULL labels don't trigger PG unique conflicts
      const row1 = await create(user.id, "github", "vault-secret-old", "default");
      const row2 = await create(user.id, "github", "vault-secret-new", "default");

      // Same row should be updated
      expect(row2.id).toBe(row1.id);
      expect(row2.vaultSecretId).toBe("vault-secret-new");
    });

    it("allows different providers for the same user", async () => {
      const user = await seedUser();

      const gh = await create(user.id, "github", "vault-gh");
      const gl = await create(user.id, "gitlab", "vault-gl");

      expect(gh.provider).toBe("github");
      expect(gl.provider).toBe("gitlab");
      expect(gh.id).not.toBe(gl.id);
    });

    it("allows different labels for the same user+provider", async () => {
      const user = await seedUser();

      const work = await create(user.id, "github", "vault-work", "work");
      const personal = await create(user.id, "github", "vault-personal", "personal");

      expect(work.label).toBe("work");
      expect(personal.label).toBe("personal");
      expect(work.id).not.toBe(personal.id);
    });
  });

  // ── getByUserAndProvider ────────────────────────────────────────────────

  describe("getByUserAndProvider", () => {
    it("returns undefined when no credential exists", async () => {
      const user = await seedUser();

      const row = await getByUserAndProvider(user.id, "github");
      expect(row).toBeUndefined();
    });

    it("returns a credential for user+provider", async () => {
      const user = await seedUser();

      await create(user.id, "github", "vault-secret-123");

      const row = await getByUserAndProvider(user.id, "github");
      expect(row).toBeDefined();
      expect(row!.provider).toBe("github");
      expect(row!.vaultSecretId).toBe("vault-secret-123");
    });

    it("does not return credentials for a different provider", async () => {
      const user = await seedUser();

      await create(user.id, "github", "vault-secret-gh");

      const row = await getByUserAndProvider(user.id, "gitlab");
      expect(row).toBeUndefined();
    });
  });

  // ── getByUser ───────────────────────────────────────────────────────────

  describe("getByUser", () => {
    it("returns empty array when no credentials exist", async () => {
      const user = await seedUser();

      const rows = await getByUser(user.id);
      expect(rows).toHaveLength(0);
    });

    it("returns all credentials for a user", async () => {
      const user = await seedUser();

      await create(user.id, "github", "vault-gh");
      await create(user.id, "gitlab", "vault-gl");

      const rows = await getByUser(user.id);
      expect(rows).toHaveLength(2);
    });

    it("does not return credentials for other users", async () => {
      const user = await seedUser();
      const otherUser = await findOrCreateByEntraOid(
        "oid-other-cred",
        "other-cred@example.com",
        "Other Cred User",
      );

      await create(user.id, "github", "vault-user");
      await create(otherUser.id, "github", "vault-other");

      const rows = await getByUser(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(user.id);
    });
  });

  // ── deleteByUserAndProvider ─────────────────────────────────────────────

  describe("deleteByUserAndProvider", () => {
    it("deletes credentials for a user+provider pair", async () => {
      const user = await seedUser();

      await create(user.id, "github", "vault-secret-123");

      await deleteByUserAndProvider(user.id, "github");

      const row = await getByUserAndProvider(user.id, "github");
      expect(row).toBeUndefined();
    });

    it("does not delete credentials for a different provider", async () => {
      const user = await seedUser();

      await create(user.id, "github", "vault-gh");
      await create(user.id, "gitlab", "vault-gl");

      await deleteByUserAndProvider(user.id, "github");

      const ghRow = await getByUserAndProvider(user.id, "github");
      expect(ghRow).toBeUndefined();

      const glRow = await getByUserAndProvider(user.id, "gitlab");
      expect(glRow).toBeDefined();
    });

    it("is a no-op when no credentials exist", async () => {
      const user = await seedUser();

      // Should not throw
      await deleteByUserAndProvider(user.id, "github");

      const rows = await getByUser(user.id);
      expect(rows).toHaveLength(0);
    });
  });
});
