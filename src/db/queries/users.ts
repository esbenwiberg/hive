import { eq } from "drizzle-orm";
import { db } from "../connection.js";
import { users } from "../schema.js";

/**
 * Finds an existing user by their Entra OID, or creates a new one.
 * Uses an upsert (INSERT ... ON CONFLICT DO UPDATE) so that email
 * and display name stay current when the user logs in again.
 */
export async function findOrCreateByEntraOid(
  oid: string,
  email: string,
  displayName: string,
) {
  const [user] = await db
    .insert(users)
    .values({
      entraOid: oid,
      email,
      displayName,
    })
    .onConflictDoUpdate({
      target: users.entraOid,
      set: {
        email,
        displayName,
        updatedAt: new Date(),
      },
    })
    .returning();

  return user;
}

/**
 * Returns all users (id + displayName) for display purposes.
 */
export async function listAll() {
  return db
    .select({ id: users.id, displayName: users.displayName })
    .from(users);
}

/**
 * Returns all users with role info (for admin permissions page).
 */
export async function listAllWithRole() {
  return db
    .select({ id: users.id, displayName: users.displayName, role: users.role, dailyBudget: users.dailyBudget })
    .from(users);
}

/**
 * Updates a user's daily budget.
 */
export async function updateDailyBudget(userId: number, budget: string) {
  await db
    .update(users)
    .set({ dailyBudget: budget, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
