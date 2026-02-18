import { eq, and } from "drizzle-orm";
import { db } from "../connection.js";
import { enrichmentRuns } from "../schema.js";

/**
 * Records a single enricher run for a task.
 */
export async function recordRun(
  taskId: string,
  enricher: string,
  status: string,
  result?: Record<string, unknown>,
  costUsd?: number,
  durationMs?: number,
  error?: string,
) {
  const [row] = await db
    .insert(enrichmentRuns)
    .values({
      taskId,
      enricher,
      status,
      result: result ?? null,
      costUsd: costUsd?.toFixed(4) ?? null,
      durationMs: durationMs ?? null,
      error: error ?? null,
    })
    .returning();

  return row;
}

/**
 * Returns all enrichment runs for a task, ordered by createdAt ascending.
 */
export async function listByTask(taskId: string) {
  return db
    .select()
    .from(enrichmentRuns)
    .where(eq(enrichmentRuns.taskId, taskId))
    .orderBy(enrichmentRuns.createdAt);
}

/**
 * Fetches all completed runs for a task and deep-merges their result JSONB
 * into a single object. Later enrichers override earlier ones for conflicting keys.
 */
export async function mergeResults(
  taskId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ result: enrichmentRuns.result })
    .from(enrichmentRuns)
    .where(
      and(
        eq(enrichmentRuns.taskId, taskId),
        eq(enrichmentRuns.status, "completed"),
      ),
    )
    .orderBy(enrichmentRuns.createdAt);

  const merged: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.result && typeof row.result === "object" && !Array.isArray(row.result)) {
      Object.assign(merged, row.result);
    }
  }

  return merged;
}
