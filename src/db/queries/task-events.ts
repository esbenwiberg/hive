import { eq, desc } from "drizzle-orm";
import { db } from "../connection.js";
import { taskEvents } from "../schema.js";
import type { AdvisorReport } from "../../domain/types.js";

/**
 * Appends an event to the task activity log.
 */
export async function addEvent(
  taskId: string,
  event: string,
  agent: string,
  message: string,
  metadata?: Record<string, unknown>,
) {
  const [row] = await db
    .insert(taskEvents)
    .values({ taskId, event, agent, message, metadata: metadata ?? null })
    .returning();

  return row;
}

/**
 * Returns events for a task, ordered by createdAt descending.
 * Optionally limited to the most recent `limit` entries.
 */
export async function getEvents(taskId: string, limit?: number) {
  const query = db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt));

  if (limit !== undefined) {
    return query.limit(limit);
  }

  return query;
}

/**
 * Records an advisor-agent event in the task activity log.
 * The full AdvisorReport is stored in the event metadata so it is
 * visible in the dashboard timeline alongside other task events.
 */
export async function addAdvisorEvent(
  taskId: string,
  report: AdvisorReport,
): Promise<void> {
  const recommendationLabel =
    report.recommendation === "approve"
      ? "✅ Approve"
      : report.recommendation === "redesign"
        ? "⚠️ Redesign"
        : "❌ Reject";

  const message =
    `Advisor recommendation: ${recommendationLabel} ` +
    `(score ${report.score}/100, confidence ${report.confidence}/100)` +
    (report.escalate ? " — escalated to human review" : "");

  await addEvent(taskId, "advisor_report", "advisor", message, {
    recommendation: report.recommendation,
    score: report.score,
    confidence: report.confidence,
    reasoning: report.reasoning,
    flags: report.flags,
    escalate: report.escalate,
  });
}

/**
 * Returns the single most recent event for a task.
 */
export async function getLatestEvent(taskId: string) {
  const [row] = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt))
    .limit(1);

  return row ?? null;
}
