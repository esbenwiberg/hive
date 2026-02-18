import { eq, desc } from "drizzle-orm";
import { db } from "../connection.js";
import { previewLogs } from "../schema.js";

/**
 * Appends a log entry for a preview environment.
 */
export async function addPreviewLog(
  taskId: string,
  source: string,
  message: string,
) {
  const [row] = await db
    .insert(previewLogs)
    .values({ taskId, source, message })
    .returning();

  return row;
}

/**
 * Returns preview logs for a task, ordered by createdAt descending.
 * Optionally limited to the most recent `limit` entries.
 */
export async function getPreviewLogs(taskId: string, limit?: number) {
  const query = db
    .select()
    .from(previewLogs)
    .where(eq(previewLogs.taskId, taskId))
    .orderBy(desc(previewLogs.createdAt));

  if (limit !== undefined) {
    return query.limit(limit);
  }

  return query;
}
