import { eq } from "drizzle-orm";
import { db } from "../connection.js";
import { repos } from "../schema.js";

/**
 * Finds an existing repo by provider + full_name, or creates a new one.
 * Uses an upsert (INSERT ... ON CONFLICT DO UPDATE) so that
 * updated_at stays current on repeated imports.
 */
export async function findOrCreate(
  provider: string,
  fullName: string,
  defaultBranch?: string,
) {
  const [repo] = await db
    .insert(repos)
    .values({
      provider,
      fullName,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    })
    .onConflictDoUpdate({
      target: [repos.provider, repos.fullName],
      set: {
        updatedAt: new Date(),
      },
    })
    .returning();

  return repo;
}

/**
 * Returns a single repo by its id, or undefined if not found.
 */
export async function getById(id: number) {
  const [repo] = await db.select().from(repos).where(eq(repos.id, id));
  return repo;
}

/**
 * Returns all repos.
 */
export async function listAll() {
  return db.select().from(repos);
}

/**
 * Updates the `settings` JSONB column for a repo.
 * Returns the updated repo row, or undefined if the repo was not found.
 */
export async function updateSettings(
  repoId: number,
  settings: Record<string, unknown>,
) {
  const [repo] = await db
    .update(repos)
    .set({ settings, updatedAt: new Date() })
    .where(eq(repos.id, repoId))
    .returning();

  return repo;
}
