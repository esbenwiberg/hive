import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks, activeAgents } from "../db/schema.js";

/** Size-based stale thresholds (ms). Tasks with an active heartbeat are never stale. */
const STALE_THRESHOLDS: Record<string, number> = {
  trivial: 15 * 60_000,  // 15 minutes
  small: 15 * 60_000,    // 15 minutes
  medium: 30 * 60_000,   // 30 minutes
  large: 45 * 60_000,    // 45 minutes
};

const DEFAULT_THRESHOLD_MS = 30 * 60_000;

/** @deprecated Use findStaleTasks() which now uses size-based thresholds internally. */
export const STALE_THRESHOLD_MS = DEFAULT_THRESHOLD_MS;

/**
 * Returns task rows stuck in a transitional status that have no recent
 * heartbeat activity. A task is considered stale if:
 *   - It's in a transitional status (queued/enriching/executing/reviewing), AND
 *   - No active_agent row exists for it (no heartbeat at all), AND threshold exceeded
 *   - OR the agent's last heartbeat is older than the size-based threshold
 *
 * Tasks with a recent heartbeat (within their size threshold) are NEVER
 * considered stale, regardless of total elapsed time.
 */
export async function findStaleTasks(_thresholdMs?: number) {
  // Use the most generous threshold for the initial DB query, then filter in JS
  const maxThreshold = Math.max(...Object.values(STALE_THRESHOLDS));
  const widestCutoff = new Date(Date.now() - maxThreshold);

  const candidates = await db
    .select({
      task: tasks,
      lastHeartbeat: activeAgents.lastHeartbeatAt,
    })
    .from(tasks)
    .leftJoin(activeAgents, sql`${tasks.id} = ${activeAgents.taskId}`)
    .where(
      sql`${tasks.status} IN ('queued','enriching','executing','reviewing','rework')
        AND (
          ${activeAgents.taskId} IS NULL
          OR ${activeAgents.lastHeartbeatAt} < ${widestCutoff}
        )`,
    );

  const now = Date.now();
  return candidates
    .filter((row) => {
      const size = row.task.size ?? "medium";
      const threshold = STALE_THRESHOLDS[size] ?? DEFAULT_THRESHOLD_MS;

      // If there's a heartbeat, only stale if heartbeat is older than threshold
      if (row.lastHeartbeat) {
        return now - new Date(row.lastHeartbeat).getTime() > threshold;
      }

      // No heartbeat at all — check task update/creation time against threshold
      const taskTime = row.task.updatedAt ?? row.task.createdAt;
      if (!taskTime) return true; // no timestamp at all — consider stale
      return now - new Date(taskTime).getTime() > threshold;
    })
    .map((r) => r.task);
}
