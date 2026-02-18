import { eq, desc } from "drizzle-orm";
import { db } from "../connection.js";
import { codeReviews } from "../schema.js";

/**
 * Records a code review result for a task.
 */
export async function recordReview(
  taskId: string,
  verdict: string,
  reworkCycle: number,
  findings?: unknown,
  securityFindings?: unknown,
  verification?: unknown,
  costUsd?: number,
) {
  const [row] = await db
    .insert(codeReviews)
    .values({
      taskId,
      verdict,
      reworkCycle,
      findings: findings ?? null,
      securityFindings: securityFindings ?? null,
      verification: verification ?? null,
      costUsd: costUsd?.toFixed(4) ?? null,
    })
    .returning();

  return row;
}

/**
 * Returns all code reviews for a task, most recent first.
 */
export async function listByTask(taskId: string) {
  return db
    .select()
    .from(codeReviews)
    .where(eq(codeReviews.taskId, taskId))
    .orderBy(desc(codeReviews.createdAt));
}

/**
 * Returns the most recent code review for a task, or undefined.
 */
export async function getLatestByTask(taskId: string) {
  const [row] = await db
    .select()
    .from(codeReviews)
    .where(eq(codeReviews.taskId, taskId))
    .orderBy(desc(codeReviews.createdAt))
    .limit(1);

  return row;
}
