import { eq, and } from "drizzle-orm";
import { db } from "../connection.js";
import { userCredentials } from "../schema.js";

/**
 * Returns the first credential for a user+provider pair.
 */
export async function getByUserAndProvider(userId: number, provider: string) {
  const [row] = await db
    .select()
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        eq(userCredentials.provider, provider),
      ),
    )
    .limit(1);

  return row;
}

/**
 * Returns all credentials for a user.
 */
export async function getByUser(userId: number) {
  return db
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
}

/**
 * Creates a new credential (upsert on userId+provider+label).
 */
export async function create(
  userId: number,
  provider: string,
  vaultSecretId: string,
  label?: string,
) {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId,
      provider,
      vaultSecretId,
      label: label ?? null,
    })
    .onConflictDoUpdate({
      target: [userCredentials.userId, userCredentials.provider, userCredentials.label],
      set: { vaultSecretId },
    })
    .returning();

  return row;
}

/**
 * Deletes all credentials for a user+provider pair.
 */
export async function deleteByUserAndProvider(userId: number, provider: string) {
  await db
    .delete(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        eq(userCredentials.provider, provider),
      ),
    );
}
