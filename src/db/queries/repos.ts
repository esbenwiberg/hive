import { eq, sql } from "drizzle-orm";
import { db } from "../connection.js";
import { repos } from "../schema.js";

export type { RepoRow } from "../schema.js";

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
/**
 * Deletes a repo and all dependent rows (tasks + their children, user_repo_access).
 * Returns the number of repo rows deleted (0 or 1).
 */
export async function deleteById(id: number): Promise<number> {
  const result = await db.execute(sql`
    WITH doomed_tasks AS (
      SELECT id FROM tasks WHERE repo_id = ${id}
    ),
    d1 AS (DELETE FROM costs WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d2 AS (DELETE FROM gate_decisions WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d3 AS (DELETE FROM code_reviews WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d4 AS (DELETE FROM active_agents WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d5 AS (DELETE FROM task_events WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d6 AS (DELETE FROM enrichment_runs WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d7 AS (DELETE FROM preview_logs WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d8 AS (DELETE FROM learning_events WHERE task_id IN (SELECT id FROM doomed_tasks)),
    d9 AS (DELETE FROM tasks WHERE repo_id = ${id}),
    d10 AS (DELETE FROM user_repo_access WHERE repo_id = ${id})
    DELETE FROM repos WHERE id = ${id}
  `);

  return Number(result.rowCount ?? 0);
}

export async function updateSettings(
  repoId: number,
  settings: Record<string, unknown>,
) {
  const [repo] = await db
    .update(repos)
    .set({ settings: sql`COALESCE(${repos.settings}, '{}'::jsonb) || ${JSON.stringify(settings)}::jsonb`, updatedAt: new Date() })
    .where(eq(repos.id, repoId))
    .returning();

  return repo;
}
