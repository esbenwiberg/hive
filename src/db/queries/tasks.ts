import { eq, ilike, and, sql, count, desc, inArray } from "drizzle-orm";
import { db } from "../connection.js";
import { tasks } from "../schema.js";
import { generateTaskId } from "../../domain/types.js";
import { canTransition } from "../../domain/state-machine.js";
import type { TaskFilters } from "../../domain/types.js";

function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Creates a new task with a generated HIVE-YYYYMMDD-xxxx id.
 * Status is always set to 'pending'.
 */
export async function create(data: {
  title: string;
  body: string;
  source: string;
  type?: string;
  size?: string;
  workflow?: string;
  repoId: number;
  createdBy: number;
}) {
  const id = generateTaskId();

  const [task] = await db
    .insert(tasks)
    .values({
      id,
      title: data.title,
      body: data.body,
      source: data.source,
      type: data.type,
      size: data.size,
      workflow: data.workflow,
      repoId: data.repoId,
      createdBy: data.createdBy,
      status: "pending",
    })
    .returning();

  return task;
}

/**
 * Returns a single task by its id, or undefined if not found.
 */
export async function getById(id: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  return task;
}

/**
 * Lists tasks with optional filters and pagination.
 * Supports filtering by status, repoId, createdBy, and text search on title.
 */
export async function list(
  filters: TaskFilters = {},
  limit?: number,
  offset?: number,
) {
  const conditions = [];

  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(tasks.status, filters.statuses));
  } else if (filters.status) {
    conditions.push(eq(tasks.status, filters.status));
  }
  if (filters.repoId !== undefined) {
    conditions.push(eq(tasks.repoId, filters.repoId));
  }
  if (filters.createdBy !== undefined) {
    conditions.push(eq(tasks.createdBy, filters.createdBy));
  }
  if (filters.search) {
    conditions.push(ilike(tasks.title, `%${escapeLike(filters.search)}%`));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(where)
      .limit(limit ?? 50)
      .offset(offset ?? 0)
      .orderBy(desc(tasks.updatedAt)),
    db
      .select({ total: count() })
      .from(tasks)
      .where(where),
  ]);

  return { tasks: items, total };
}

/**
 * Updates a task's status after validating the transition via the state machine.
 * Throws an Error if the transition is not allowed.
 * If the new status is 'approved' or 'ready', sets approvedBy.
 */
export async function updateStatus(
  id: string,
  newStatus: string,
  userId?: number,
) {
  const existing = await getById(id);
  if (!existing) {
    throw new Error(`Task ${id} not found`);
  }

  if (!canTransition(existing.status, newStatus)) {
    throw new Error(
      `Invalid transition from '${existing.status}' to '${newStatus}'`,
    );
  }

  const updates: Record<string, unknown> = {
    status: newStatus,
    updatedAt: new Date(),
  };

  if (
    (newStatus === "approved" || newStatus === "ready") &&
    userId !== undefined
  ) {
    updates.approvedBy = userId;
  }

  // Reset rework state when retrying a failed task
  if (newStatus === "pending" && existing.status === "failed") {
    updates.reworkCount = 0;
    updates.reworkHistory = [];
    updates.failureReason = null;
    updates.retryInstructions = null;
  }

  const [updated] = await db
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, id))
    .returning();

  return updated;
}

/**
 * Updates classification fields on a task.
 * Called by the router agent after classifying a task.
 */
export async function updateClassification(
  id: string,
  data: {
    type: string;
    size: string;
    model: string;
    workflow: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
  },
) {
  const [updated] = await db
    .update(tasks)
    .set({
      type: data.type,
      size: data.size,
      model: data.model,
      workflow: data.workflow,
      maxTurns: data.maxTurns ?? null,
      maxBudgetUsd: data.maxBudgetUsd?.toFixed(2) ?? null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  return updated;
}

/**
 * Updates the enrichment JSONB column on a task.
 * Called by the enrichment pipeline after gathering context.
 */
export async function updateEnrichment(
  id: string,
  enrichment: Record<string, unknown>,
) {
  const [updated] = await db
    .update(tasks)
    .set({
      enrichment,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  return updated;
}

/**
 * Deletes tasks whose title matches a LIKE pattern, cascading through
 * all dependent tables (costs, gate_decisions, code_reviews, active_agents,
 * enrichment_runs, learnings, preview_logs).
 * Returns the number of deleted task rows.
 */
export async function deleteByTitlePattern(pattern: string): Promise<number> {
  const result = await db.execute(sql`
    WITH doomed AS (
      SELECT id FROM tasks WHERE title ILIKE ${pattern}
    ),
    d1 AS (DELETE FROM costs WHERE task_id IN (SELECT id FROM doomed)),
    d2 AS (DELETE FROM gate_decisions WHERE task_id IN (SELECT id FROM doomed)),
    d3 AS (DELETE FROM code_reviews WHERE task_id IN (SELECT id FROM doomed)),
    d4 AS (DELETE FROM active_agents WHERE task_id IN (SELECT id FROM doomed)),
    d5 AS (DELETE FROM enrichment_runs WHERE task_id IN (SELECT id FROM doomed)),
    d6 AS (DELETE FROM preview_logs WHERE task_id IN (SELECT id FROM doomed)),
    d7 AS (DELETE FROM learning_events WHERE task_id IN (SELECT id FROM doomed))
    DELETE FROM tasks WHERE id IN (SELECT id FROM doomed)
  `);

  return Number(result.rowCount ?? 0);
}

/**
 * Returns task counts grouped by status.
 * Uses Drizzle's sql template for the GROUP BY query.
 */
export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .groupBy(tasks.status);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}
