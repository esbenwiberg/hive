import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, cleanupTables } from "../setup.js";

// Mock src/db/connection.js so that findOrCreateByEntraOid uses our test db/pool
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Import AFTER the mock is registered
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);

describe("findOrCreateByEntraOid", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  it("creates a new user on first call", async () => {
    const user = await findOrCreateByEntraOid(
      "oid-aaa",
      "alice@example.com",
      "Alice",
    );

    expect(user).toBeDefined();
    expect(user.entraOid).toBe("oid-aaa");
    expect(user.email).toBe("alice@example.com");
    expect(user.displayName).toBe("Alice");
    expect(user.role).toBe("user");
    expect(user.id).toBeTypeOf("number");
    expect(user.createdAt).toBeTruthy();
    expect(user.updatedAt).toBeTruthy();
  });

  it("returns the same user on second call with same oid", async () => {
    const first = await findOrCreateByEntraOid(
      "oid-bbb",
      "bob@example.com",
      "Bob",
    );
    const second = await findOrCreateByEntraOid(
      "oid-bbb",
      "bob@example.com",
      "Bob",
    );

    expect(second.id).toBe(first.id);
    expect(second.entraOid).toBe("oid-bbb");
  });

  it("updates email and displayName if they changed (upsert)", async () => {
    const original = await findOrCreateByEntraOid(
      "oid-ccc",
      "old@example.com",
      "Old Name",
    );

    const updated = await findOrCreateByEntraOid(
      "oid-ccc",
      "new@example.com",
      "New Name",
    );

    expect(updated.id).toBe(original.id);
    expect(updated.email).toBe("new@example.com");
    expect(updated.displayName).toBe("New Name");
  });

  it("defaults role to 'user'", async () => {
    const user = await findOrCreateByEntraOid(
      "oid-ddd",
      "dave@example.com",
      "Dave",
    );

    expect(user.role).toBe("user");
  });
});
