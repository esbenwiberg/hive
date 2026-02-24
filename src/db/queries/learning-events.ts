import { eq, desc, sql } from "drizzle-orm";
import { db } from "../connection.js";
import { learningEvents } from "../schema.js";
import type { LearningEventRow } from "../schema.js";

/**
 * Records a learning event.
 */
export async function recordEvent(data: {
  learningId: number;
  eventType: string;
  taskId?: string;
  evidence?: string;
}): Promise<LearningEventRow> {
  const [row] = await db
    .insert(learningEvents)
    .values({
      learningId: data.learningId,
      eventType: data.eventType,
      taskId: data.taskId ?? null,
      evidence: data.evidence ?? null,
    })
    .returning();

  return row;
}

/**
 * Returns recent events for a specific learning, ordered newest first.
 */
export async function getEventsForLearning(
  learningId: number,
  limit?: number,
): Promise<LearningEventRow[]> {
  const query = db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.learningId, learningId))
    .orderBy(desc(learningEvents.createdAt));

  if (limit !== undefined) {
    return query.limit(limit);
  }
  return query;
}

/**
 * Returns all events tied to a specific task.
 */
export async function getEventsForTask(
  taskId: string,
): Promise<LearningEventRow[]> {
  return db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.taskId, taskId))
    .orderBy(desc(learningEvents.createdAt));
}

/**
 * Returns the latest events across all learnings, ordered newest first.
 */
export async function getRecentEvents(
  limit?: number,
): Promise<LearningEventRow[]> {
  const effectiveLimit = limit ?? 50;
  return db
    .select()
    .from(learningEvents)
    .orderBy(desc(learningEvents.createdAt))
    .limit(effectiveLimit);
}

/**
 * Returns event counts grouped by event_type within a given number of days.
 */
export async function getEventCountsByType(
  days: number,
): Promise<{ eventType: string; count: number }[]> {
  return db
    .select({
      eventType: learningEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(learningEvents)
    .where(sql`${learningEvents.createdAt} >= now() - make_interval(days => ${days})`)
    .groupBy(learningEvents.eventType)
    .orderBy(sql`count(*) desc`);
}

/**
 * Returns daily event counts for the last N days (for trend display).
 */
export async function getDailyEventVolume(
  days: number,
): Promise<{ date: string; count: number }[]> {
  return db
    .select({
      date: sql<string>`to_char(${learningEvents.createdAt}::date, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(learningEvents)
    .where(sql`${learningEvents.createdAt} >= now() - make_interval(days => ${days})`)
    .groupBy(sql`${learningEvents.createdAt}::date`)
    .orderBy(sql`${learningEvents.createdAt}::date`);
}
