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
