import { eq, sql } from "drizzle-orm";
import { db } from "../connection.js";
import { activeAgents } from "../schema.js";

/**
 * Registers an active agent for a task (upsert since taskId is PK).
 * If the task already has an active agent, the row is replaced.
 */
export async function register(
  taskId: string,
  agent: string,
  model: string,
  phase?: string,
) {
  const [row] = await db
    .insert(activeAgents)
    .values({
      taskId,
      agent,
      model,
      phase: phase ?? null,
    })
    .onConflictDoUpdate({
      target: activeAgents.taskId,
      set: {
        agent,
        model,
        phase: phase ?? null,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    })
    .returning();

  return row;
}

/**
 * Updates the heartbeat timestamp for an active agent.
 * Call this periodically during long-running operations to signal liveness.
 */
export async function heartbeat(taskId: string): Promise<void> {
  await db
    .update(activeAgents)
    .set({ lastHeartbeatAt: new Date() })
    .where(eq(activeAgents.taskId, taskId));
}

/**
 * Unregisters an active agent by removing the row for the given taskId.
 */
export async function unregister(taskId: string): Promise<void> {
  await db.delete(activeAgents).where(eq(activeAgents.taskId, taskId));
}

/**
 * Returns the active agent for a specific task, or null if none.
 */
export async function getByTaskId(taskId: string) {
  const [row] = await db.select().from(activeAgents).where(eq(activeAgents.taskId, taskId));
  return row ?? null;
}

/**
 * Returns all currently active agents.
 */
export async function listActive() {
  return db.select().from(activeAgents);
}

/**
 * Deletes active agent rows older than maxAgeMs milliseconds.
 * Useful for cleaning up stale entries from crashed agents.
 */
export async function cleanupStale(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);

  const deleted = await db
    .delete(activeAgents)
    .where(sql`${activeAgents.startedAt} < ${cutoff}`)
    .returning();

  return deleted.length;
}
