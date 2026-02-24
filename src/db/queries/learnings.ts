import { eq, sql, and, desc, isNull, isNotNull } from "drizzle-orm";
import { db } from "../connection.js";
import { learnings } from "../schema.js";
import type { LearningRow } from "../schema.js";
import { recordEvent } from "./learning-events.js";

/**
 * Merges Claude-generated tags with contextual tags (task type, repo name).
 * Deduplicates and lowercases for consistent overlap matching.
 */
export function normalizeLearningTags(
  claudeTags: string[],
  context: { taskType?: string | null; repoFullName?: string | null },
): string[] {
  const merged = new Set(claudeTags.map((t) => t.toLowerCase()));
  if (context.taskType) merged.add(context.taskType.toLowerCase());
  if (context.repoFullName) merged.add(context.repoFullName.toLowerCase());
  return [...merged];
}

/**
 * Builds the tag array used when retrieving learnings.
 * Includes task type, severity, and repo name so the PostgreSQL `&&`
 * array-overlap operator can match against normalized creation tags.
 * Falls back to `["general"]` when no dimensions are available.
 */
export function buildRetrievalTags(context: {
  taskType?: string | null;
  severity?: string | null;
  repoFullName?: string | null;
}): string[] {
  const tags: string[] = [];
  if (context.taskType) tags.push(context.taskType.toLowerCase());
  if (context.severity) tags.push(context.severity.toLowerCase());
  if (context.repoFullName) tags.push(context.repoFullName.toLowerCase());
  return tags.length > 0 ? tags : ["general"];
}

/**
 * Inserts a new learning record.
 */
export async function createLearning(data: {
  scope: string;
  category: string;
  content: string;
  confidence?: number;
  tags?: string[];
  sourceTaskIds?: string[];
}): Promise<LearningRow> {
  const [row] = await db
    .insert(learnings)
    .values({
      scope: data.scope,
      category: data.category,
      content: data.content,
      confidence:
        data.confidence !== undefined
          ? data.confidence.toFixed(2)
          : undefined,
      tags: data.tags ?? null,
      sourceTaskIds: data.sourceTaskIds ?? null,
    })
    .returning();

  return row;
}

/**
 * Retrieves a single learning by ID.
 */
export async function getLearningById(
  id: number,
): Promise<LearningRow | undefined> {
  const [row] = await db
    .select()
    .from(learnings)
    .where(eq(learnings.id, id));

  return row;
}

/**
 * Retrieves relevant learnings by scope hierarchy and tag overlap.
 * Filters by the provided scopes, overlaps tags using postgres array operators,
 * sorts by confidence DESC then reinforcements DESC, and limits results.
 * Updates last_used_at on returned rows.
 */
export async function retrieveRelevantLearnings(opts: {
  scopes: string[];
  tags: string[];
  limit?: number;
}): Promise<LearningRow[]> {
  const limit = opts.limit ?? 15;

  // Build conditions: scope in list, tags overlap (if tags provided), not superseded
  const conditions = [
    sql`${learnings.scope} = ANY(ARRAY[${sql.join(opts.scopes.map((s) => sql`${s}`), sql`, `)}]::text[])`,
    isNull(learnings.supersededBy),
  ];

  // Only add tag overlap condition when tags are provided
  if (opts.tags.length > 0) {
    conditions.push(
      sql`${learnings.tags} && ARRAY[${sql.join(opts.tags.map((t) => sql`${t}`), sql`, `)}]::text[]`,
    );
  }

  const rows = await db
    .select()
    .from(learnings)
    .where(and(...conditions))
    .orderBy(desc(learnings.confidence), desc(learnings.reinforcements))
    .limit(limit);

  // Update last_used_at on the returned rows
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db
      .update(learnings)
      .set({ lastUsedAt: new Date() })
      .where(sql`${learnings.id} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`);
  }

  return rows;
}

/**
 * Reinforces a learning: increments reinforcements, bumps confidence
 * (capped at 1.0), and updates updatedAt.
 */
export async function reinforceLearning(
  id: number,
  taskId: string,
): Promise<void> {
  await db
    .update(learnings)
    .set({
      reinforcements: sql`${learnings.reinforcements} + 1`,
      confidence: sql`least(1.0, ${learnings.confidence} + 0.05)::numeric(3,2)`,
      updatedAt: new Date(),
    })
    .where(eq(learnings.id, id));
}

/**
 * Records a contradiction against a learning: increments contradictions,
 * decreases confidence (floored at 0.0), and updates updatedAt.
 */
export async function contradictLearning(
  id: number,
  taskId: string,
  amount?: number,
): Promise<void> {
  const decrement = amount ?? 0.05;
  await db
    .update(learnings)
    .set({
      contradictions: sql`${learnings.contradictions} + 1`,
      confidence: sql`greatest(0.0, ${learnings.confidence} - ${decrement})::numeric(3,2)`,
      updatedAt: new Date(),
    })
    .where(eq(learnings.id, id));
}

/**
 * Marks a learning as superseded by a newer learning.
 */
export async function supersedeLearning(
  oldId: number,
  newId: number,
): Promise<void> {
  await db
    .update(learnings)
    .set({ supersededBy: newId, updatedAt: new Date() })
    .where(eq(learnings.id, oldId));
}

/**
 * Applies monthly decay: multiplies confidence by 0.95 for all learnings
 * where last_used_at < now() - 30 days and not superseded.
 * Returns count of affected rows.
 */
export async function applyMonthlyDecay(): Promise<number> {
  const result = await db
    .update(learnings)
    .set({
      confidence: sql`(${learnings.confidence} * 0.95)::numeric(3,2)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        sql`${learnings.lastUsedAt} < now() - interval '30 days'`,
        isNull(learnings.supersededBy),
      ),
    )
    .returning({ id: learnings.id });

  return result.length;
}

/**
 * Archives stale learnings by setting supersededBy = -1 (self-archived sentinel)
 * for learnings with low confidence, few reinforcements, and unused for 30+ days.
 * Returns count of affected rows.
 */
export async function archiveStale(): Promise<number> {
  const result = await db
    .update(learnings)
    .set({ supersededBy: -1, updatedAt: new Date() })
    .where(
      and(
        sql`${learnings.confidence} < 0.2`,
        sql`${learnings.reinforcements} < 3`,
        isNull(learnings.supersededBy),
        sql`(${learnings.lastUsedAt} is null or ${learnings.lastUsedAt} < now() - interval '30 days')`,
      ),
    )
    .returning({ id: learnings.id });

  return result.length;
}

/**
 * Dismisses a learning: sets dismissedAt/dismissedBy, marks supersededBy = -1
 * so it's excluded from retrieveRelevantLearnings, and records a dismissed event.
 */
export async function dismissLearning(
  id: number,
  userId: string,
): Promise<void> {
  await db
    .update(learnings)
    .set({
      dismissedAt: new Date(),
      dismissedBy: userId,
      supersededBy: -1,
      updatedAt: new Date(),
    })
    .where(eq(learnings.id, id));

  await recordEvent({
    learningId: id,
    eventType: "dismissed",
    evidence: `Dismissed by admin ${userId}`,
  });
}

/**
 * Returns learnings that have been dismissed by an admin.
 */
export async function getDismissedLearnings(
  limit?: number,
): Promise<LearningRow[]> {
  return db
    .select()
    .from(learnings)
    .where(isNotNull(learnings.dismissedAt))
    .orderBy(desc(learnings.dismissedAt))
    .limit(limit ?? 50);
}

/**
 * Builds a text block of dismissed learnings for injection into agent prompts.
 * Returns empty string if no dismissed learnings exist.
 */
export async function buildDismissedContext(): Promise<string> {
  const dismissed = await getDismissedLearnings(50);
  if (dismissed.length === 0) return "";

  const entries = dismissed
    .map(
      (l) =>
        `[id:${l.id}] scope=${l.scope} category=${l.category}\n  ${l.content}`,
    )
    .join("\n");

  return [
    ``,
    `## Dismissed Learnings (admin-rejected — DO NOT recreate)`,
    entries,
    ``,
    `Never propose new learnings that are semantically equivalent to any dismissed learning listed above.`,
  ].join("\n");
}

/**
 * Paginated list of learnings for the dashboard.
 */
export async function listLearnings(opts?: {
  scope?: string;
  category?: string;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}): Promise<{ learnings: LearningRow[]; total: number }> {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  const conditions = [];
  if (opts?.scope) {
    conditions.push(eq(learnings.scope, opts.scope));
  }
  if (opts?.category) {
    conditions.push(eq(learnings.category, opts.category));
  }
  if (opts?.minConfidence !== undefined) {
    conditions.push(
      sql`${learnings.confidence} >= ${opts.minConfidence}`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(learnings)
      .where(where)
      .orderBy(desc(learnings.updatedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(learnings)
      .where(where),
  ]);

  return { learnings: rows, total: countRow.total };
}

/**
 * Returns aggregate stats for the dashboard.
 */
export async function getLearningStats(): Promise<{
  total: number;
  active: number;
  archived: number;
  dismissed: number;
  avgConfidence: number;
  topCategories: { category: string; count: number }[];
  topScopes: { scope: string; count: number }[];
}> {
  const [statsRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${learnings.supersededBy} is null)::int`,
      archived: sql<number>`count(*) filter (where ${learnings.supersededBy} is not null and ${learnings.dismissedAt} is null)::int`,
      dismissed: sql<number>`count(*) filter (where ${learnings.dismissedAt} is not null)::int`,
      avgConfidence: sql<string>`coalesce(avg(${learnings.confidence}) filter (where ${learnings.supersededBy} is null), 0)`,
    })
    .from(learnings);

  const [topCategories, topScopes] = await Promise.all([
    db
      .select({
        category: learnings.category,
        count: sql<number>`count(*)::int`,
      })
      .from(learnings)
      .where(isNull(learnings.supersededBy))
      .groupBy(learnings.category)
      .orderBy(sql`count(*) desc`)
      .limit(10),
    db
      .select({
        scope: learnings.scope,
        count: sql<number>`count(*)::int`,
      })
      .from(learnings)
      .where(isNull(learnings.supersededBy))
      .groupBy(learnings.scope)
      .orderBy(sql`count(*) desc`)
      .limit(20),
  ]);

  return {
    total: statsRow.total,
    active: statsRow.active,
    archived: statsRow.archived,
    dismissed: statsRow.dismissed,
    avgConfidence: parseFloat(statsRow.avgConfidence),
    topCategories,
    topScopes,
  };
}
