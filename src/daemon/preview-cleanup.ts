import { sql } from "drizzle-orm";
import logger from "../logger.js";

/** Directory-name prefix used for preview artefact directories on disk. */
export const PREVIEW_DIR_PREFIX = "hive-preview-";
import { previewManager } from "../execution/preview/manager.js";
import { cleanupWorktree } from "../execution/worktree.js";
import { addPreviewLog } from "../db/queries/preview-logs.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { getById as getTask } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";

/**
 * Cleans up expired preview environments.
 *
 * 1. Snapshots worktree paths from in-memory previews before cleanup.
 * 2. Calls previewManager.cleanupExpired() to stop in-memory tracked previews
 *    that have exceeded the timeout.
 * 3. For each stopped preview, also cleans up the associated worktree.
 * 4. As a secondary check, queries the DB for tasks with preview_status = 'running'
 *    and preview_started_at past the timeout, in case the in-memory state is out of
 *    sync (e.g., after a restart). Updates those to 'stopped' directly.
 */
export async function cleanupExpiredPreviews(): Promise<void> {
  const config = getAutonomousConfig().preview;
  const timeoutMs = config.cleanup_timeout_minutes * 60 * 1000;

  // 1. Snapshot worktree paths before cleanup removes them from the map
  const worktreePaths = new Map<string, string>();
  for (const [taskId, info] of previewManager.getRunningPreviews()) {
    worktreePaths.set(taskId, info.worktreePath);
  }

  // 2. Clean up in-memory tracked previews (stops processes, updates DB)
  //    Pass a per-repo timeout resolver so repos with custom cleanup_timeout_minutes
  //    are respected.
  const getTimeoutMs = async (taskId: string): Promise<number | undefined> => {
    const task = await getTask(taskId);
    const repo = task ? await getRepo(task.repoId) : null;
    const repoTimeout = (repo?.settings as Record<string, unknown> | null)
      ?.preview as { cleanup_timeout_minutes?: number } | undefined;
    return repoTimeout?.cleanup_timeout_minutes != null
      ? repoTimeout.cleanup_timeout_minutes * 60_000
      : undefined;
  };

  let expiredIds: string[];
  try {
    expiredIds = await previewManager.cleanupExpired(getTimeoutMs);
  } catch (err) {
    logger.error({ err }, "Preview cleanup: error during in-memory cleanup");
    expiredIds = [];
  }

  // 3. Clean up worktrees for each expired preview
  for (const taskId of expiredIds) {
    const worktreePath = worktreePaths.get(taskId);
    if (worktreePath) {
      try {
        // cleanupWorktree only uses .path — other fields are not needed for rm -rf
        await cleanupWorktree({
          path: worktreePath,
          branch: "",
          repoFullName: "",
          provider: "",
          createdAt: new Date(),
          baseSha: "",
        });
        await addPreviewLog(taskId, "cleanup", `Worktree cleaned up at ${worktreePath}`);
      } catch (err) {
        logger.error({ taskId, worktreePath, err }, "Preview cleanup: failed to clean up worktree");
      }
    }
    await addPreviewLog(taskId, "cleanup", "Expired preview stopped");
    logger.info({ taskId }, "Preview cleanup: expired preview stopped");
  }

  // 4. Secondary DB check for out-of-sync previews
  const cutoff = new Date(Date.now() - timeoutMs);

  let dbStaleRows: { id: string }[];
  try {
    dbStaleRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        sql`${tasks.previewStatus} = 'running' AND ${tasks.previewStartedAt} < ${cutoff}`,
      );
  } catch (err) {
    logger.error({ err }, "Preview cleanup: error querying DB for stale previews");
    return;
  }

  // Filter to tasks not in the in-memory map (already handled above)
  const inMemoryIds = new Set(
    Array.from(previewManager.getRunningPreviews().keys()),
  );

  for (const row of dbStaleRows) {
    if (inMemoryIds.has(row.id)) {
      // Still in memory — will be handled by next cleanupExpired cycle
      continue;
    }

    // Task is in DB as 'running' but not tracked in memory — mark as stopped
    try {
      await db
        .update(tasks)
        .set({ previewStatus: "stopped", updatedAt: new Date() })
        .where(sql`${tasks.id} = ${row.id}`);

      await addPreviewLog(row.id, "cleanup", "Stale DB preview status corrected to stopped (not in memory)");
      logger.info({ taskId: row.id }, "Preview cleanup: corrected stale DB preview status");
    } catch (err) {
      logger.error(
        { taskId: row.id, err },
        "Preview cleanup: failed to update stale DB preview status",
      );
    }
  }

  if (expiredIds.length > 0 || dbStaleRows.length > 0) {
    logger.info(
      {
        expiredInMemory: expiredIds.length,
        staleInDb: dbStaleRows.length,
      },
      "Preview cleanup: cycle completed",
    );
  }
}
