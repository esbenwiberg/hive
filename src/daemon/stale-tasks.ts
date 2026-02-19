import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks, activeAgents } from "../db/schema.js";

/** Default threshold: 30 minutes. */
export const STALE_THRESHOLD_MS = 1_800_000;

/**
 * Returns task rows stuck in a transitional status that have no recent
 * heartbeat activity. A task is considered stale if:
 *   - It's in a transitional status (queued/enriching/executing/reviewing), AND
 *   - Either no active_agent row exists for it, OR the agent's last heartbeat
 *     is older than the threshold.
 *
 * This avoids false positives for long-running tasks that are still making
 * progress (emitting heartbeats).
 */
export async function findStaleTasks(thresholdMs: number) {
  const cutoff = new Date(Date.now() - thresholdMs);

  return db
    .select({ task: tasks })
    .from(tasks)
    .leftJoin(activeAgents, sql`${tasks.id} = ${activeAgents.taskId}`)
    .where(
      // Note: 'suspended' is intentionally excluded — those are handled by the resume logic on boot
      sql`${tasks.status} IN ('queued','enriching','executing','reviewing')
        AND (
          ${activeAgents.taskId} IS NULL
          OR ${activeAgents.lastHeartbeatAt} < ${cutoff}
        )`,
    )
    .then((rows) => rows.map((r) => r.task));
}
