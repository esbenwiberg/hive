import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";

/** Default threshold: 30 minutes. */
export const STALE_THRESHOLD_MS = 1_800_000;

/**
 * Returns task rows stuck in a transitional status whose `updated_at`
 * is older than `thresholdMs` milliseconds ago.
 */
export async function findStaleTasks(thresholdMs: number) {
  const cutoff = new Date(Date.now() - thresholdMs);

  return db
    .select()
    .from(tasks)
    .where(
      sql`${tasks.status} IN ('queued','enriching','executing','reviewing') AND ${tasks.updatedAt} < ${cutoff}`,
    );
}
