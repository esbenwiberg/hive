import { isNotNull, eq, desc } from "drizzle-orm";
import { db } from "../connection.js";
import { tasks, repos } from "../schema.js";

export interface PreviewInstanceRow {
  taskId: string;
  title: string;
  repoFullName: string | null;
  previewPort: number | null;
  previewStatus: string;
  previewStartedAt: Date | null;
}

/**
 * Returns all tasks with a non-null previewStatus, ordered by previewStartedAt DESC.
 */
export async function getPreviewInstances(): Promise<PreviewInstanceRow[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      repoFullName: repos.fullName,
      previewPort: tasks.previewPort,
      previewStatus: tasks.previewStatus,
      previewStartedAt: tasks.previewStartedAt,
    })
    .from(tasks)
    .leftJoin(repos, eq(tasks.repoId, repos.id))
    .where(isNotNull(tasks.previewStatus))
    .orderBy(desc(tasks.previewStartedAt));

  return rows as PreviewInstanceRow[];
}
