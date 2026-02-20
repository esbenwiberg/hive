import { eq, and } from "drizzle-orm";
import { db } from "../connection.js";
import { userRepoAccess, repos } from "../schema.js";

/**
 * Returns repo IDs the user has been granted access to.
 */
export async function listRepoIdsByUser(userId: number): Promise<number[]> {
  const rows = await db
    .select({ repoId: userRepoAccess.repoId })
    .from(userRepoAccess)
    .where(eq(userRepoAccess.userId, userId));

  return rows.map((r) => r.repoId);
}

/**
 * Returns access rows for a user, joined with repo info.
 */
export async function listByUser(userId: number) {
  return db
    .select({
      id: userRepoAccess.id,
      repoId: userRepoAccess.repoId,
      repoFullName: repos.fullName,
      grantedBy: userRepoAccess.grantedBy,
      createdAt: userRepoAccess.createdAt,
    })
    .from(userRepoAccess)
    .innerJoin(repos, eq(userRepoAccess.repoId, repos.id))
    .where(eq(userRepoAccess.userId, userId));
}

/**
 * Grants a user access to a repo. No-op if already granted.
 */
export async function grant(userId: number, repoId: number, grantedBy: number) {
  await db
    .insert(userRepoAccess)
    .values({ userId, repoId, grantedBy })
    .onConflictDoNothing();
}

/**
 * Revokes a user's access to a repo.
 */
export async function revoke(userId: number, repoId: number) {
  await db
    .delete(userRepoAccess)
    .where(and(eq(userRepoAccess.userId, userId), eq(userRepoAccess.repoId, repoId)));
}

/**
 * Checks whether a user has access to a specific repo.
 */
export async function hasAccess(userId: number, repoId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: userRepoAccess.id })
    .from(userRepoAccess)
    .where(and(eq(userRepoAccess.userId, userId), eq(userRepoAccess.repoId, repoId)))
    .limit(1);

  return !!row;
}

/**
 * Returns all access grants (for admin permissions page).
 */
export async function listAll() {
  return db
    .select({
      userId: userRepoAccess.userId,
      repoId: userRepoAccess.repoId,
    })
    .from(userRepoAccess);
}
