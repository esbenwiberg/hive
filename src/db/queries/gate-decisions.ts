import { eq, desc } from "drizzle-orm";
import { db } from "../connection.js";
import { gateDecisions } from "../schema.js";

/**
 * Records a gate decision for a task.
 */
export async function recordDecision(
  taskId: string,
  verdict: string,
  source: string,
  decidedBy?: number,
  reasoning?: string,
  taskContext?: Record<string, unknown>,
) {
  const [row] = await db
    .insert(gateDecisions)
    .values({
      taskId,
      verdict,
      source,
      decidedBy: decidedBy ?? null,
      reasoning: reasoning ?? null,
      taskContext: taskContext ?? null,
    })
    .returning();

  return row;
}

/**
 * Returns all gate decisions for a task, ordered by createdAt descending.
 */
export async function listByTask(taskId: string) {
  return db
    .select()
    .from(gateDecisions)
    .where(eq(gateDecisions.taskId, taskId))
    .orderBy(desc(gateDecisions.createdAt));
}
