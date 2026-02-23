import { eq, ilike, and, or, sql, count, desc, inArray, notInArray } from "drizzle-orm";
import { db } from "../connection.js";
import { tasks } from "../schema.js";
import { generateTaskId } from "../../domain/types.js";
import { canTransition } from "../../domain/state-machine.js";
import { getTotalCostForTask } from "./costs.js";
import type { TaskFilters } from "../../domain/types.js";

function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Builds a properly parameterised SQL text[] array from a JS string array.
 * Uses sql.join so each element becomes its own bind parameter inside ARRAY[…]::text[].
 */
function sqlTextArray(ids: string[]) {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;
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
  visibility?: string;
  skipPreview?: boolean;
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
      visibility: data.visibility ?? "public",
      skipPreview: data.skipPreview ?? false,
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
 * Returns a single task by its id with total cost included, or undefined if not found.
 */
export async function getByIdWithCost(id: string) {
  const task = await getById(id);
  if (!task) return undefined;
  
  const totalCost = await getTotalCostForTask(id);
  return { ...task, totalCost };
}

/**
 * Lists tasks with optional filters and pagination.
 * Supports filtering by status, repoId, createdBy, and text search on title.
 */
export async function list(
  filters: TaskFilters = {},
  limit?: number,
  offset?: number,
  userContext?: { userId: number; role: string; accessibleRepoIds?: number[] },
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

  // Repo access filter: restrict to accessible repos for non-admins
  if (userContext?.accessibleRepoIds !== undefined) {
    if (userContext.accessibleRepoIds.length === 0) {
      return { tasks: [], total: 0 };
    }
    conditions.push(inArray(tasks.repoId, userContext.accessibleRepoIds));
  }

  // Visibility filter: show public, or private if user is creator or admin
  if (userContext && userContext.role !== "admin") {
    conditions.push(
      or(
        eq(tasks.visibility, "public"),
        eq(tasks.createdBy, userContext.userId),
      )!,
    );
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
 * Lists tasks with total cost included for each task.
 * Similar to list() but augments each task with its totalCost.
 */
export async function listWithCosts(
  filters: TaskFilters = {},
  limit?: number,
  offset?: number,
  userContext?: { userId: number; role: string; accessibleRepoIds?: number[] },
) {
  const { tasks: tasksData, total } = await list(filters, limit, offset, userContext);
  
  // Get total cost for each task in parallel
  const tasksWithCosts = await Promise.all(
    tasksData.map(async (task) => {
      const totalCost = await getTotalCostForTask(task.id);
      return { ...task, totalCost };
    })
  );

  return { tasks: tasksWithCosts, total };
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

  // Reset rework state when retrying a failed task (full restart)
  if (newStatus === "pending" && existing.status === "failed") {
    updates.reworkCount = 0;
    updates.maxReworkCycles = 2;
    updates.reworkHistory = [];
    updates.failureReason = null;
    updates.retryInstructions = null;
    updates.completedMilestones = 0;
    updates.worktreePath = null;
    updates.worktreeBaseSha = null;
  }

  // Clear failure state when continuing a failed task (preserve milestone progress)
  if (newStatus === "approved" && existing.status === "failed") {
    updates.failureReason = null;
    updates.retryInstructions = null;
  }

  // Bump max rework cycles when granting more cycles from failed
  if (newStatus === "rework" && existing.status === "failed") {
    updates.maxReworkCycles = (existing.maxReworkCycles ?? 2) + 2;
    updates.failureReason = null;
  }

  // Clear suspendedFrom when resuming from suspended
  if (existing.status === "suspended") {
    updates.suspendedFrom = null;
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
 * all dependent tables (task_events, costs, gate_decisions, code_reviews,
 * active_agents, enrichment_runs, learnings, preview_logs).
 * Returns the number of deleted task rows.
 */
export async function deleteByTitlePattern(pattern: string): Promise<number> {
  const result = await db.execute(sql`
    WITH doomed AS (
      SELECT id FROM tasks WHERE title ILIKE ${pattern}
    ),
    d1 AS (DELETE FROM task_events WHERE task_id IN (SELECT id FROM doomed)),
    d2 AS (DELETE FROM costs WHERE task_id IN (SELECT id FROM doomed)),
    d3 AS (DELETE FROM gate_decisions WHERE task_id IN (SELECT id FROM doomed)),
    d4 AS (DELETE FROM code_reviews WHERE task_id IN (SELECT id FROM doomed)),
    d5 AS (DELETE FROM active_agents WHERE task_id IN (SELECT id FROM doomed)),
    d6 AS (DELETE FROM enrichment_runs WHERE task_id IN (SELECT id FROM doomed)),
    d7 AS (DELETE FROM preview_logs WHERE task_id IN (SELECT id FROM doomed)),
    d8 AS (DELETE FROM learning_events WHERE task_id IN (SELECT id FROM doomed))
    DELETE FROM tasks WHERE id IN (SELECT id FROM doomed)
  `);

  return Number(result.rowCount ?? 0);
}

/**
 * Deletes tasks by an array of IDs, cascading through all dependent tables.
 * Returns the number of deleted task rows.
 */
export async function deleteByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const idArray = sqlTextArray(ids);

  const result = await db.execute(sql`
    WITH doomed AS (
      SELECT id FROM tasks WHERE id = ANY(${idArray})
    ),
    d1 AS (DELETE FROM task_events WHERE task_id IN (SELECT id FROM doomed)),
    d2 AS (DELETE FROM costs WHERE task_id IN (SELECT id FROM doomed)),
    d3 AS (DELETE FROM gate_decisions WHERE task_id IN (SELECT id FROM doomed)),
    d4 AS (DELETE FROM code_reviews WHERE task_id IN (SELECT id FROM doomed)),
    d5 AS (DELETE FROM active_agents WHERE task_id IN (SELECT id FROM doomed)),
    d6 AS (DELETE FROM enrichment_runs WHERE task_id IN (SELECT id FROM doomed)),
    d7 AS (DELETE FROM preview_logs WHERE task_id IN (SELECT id FROM doomed)),
    d8 AS (DELETE FROM learning_events WHERE task_id IN (SELECT id FROM doomed))
    DELETE FROM tasks WHERE id IN (SELECT id FROM doomed)
  `);

  return Number(result.rowCount ?? 0);
}

/**
 * Resets a task to initial pending state, clearing all enrichment, gate,
 * execution, and review state. Cascades through all dependent tables
 * (task_events, enrichment_runs, gate_decisions, code_reviews, active_agents,
 * costs, preview_logs, learning_events).
 */
export async function resetTask(id: string) {
  const existing = await getById(id);
  if (!existing) {
    throw new Error(`Task ${id} not found`);
  }

  // Delete related rows (mirrors cascades in deleteByIds)
  await db.execute(sql`
    WITH target AS (SELECT ${id}::text AS tid)
    , d1 AS (DELETE FROM task_events WHERE task_id = (SELECT tid FROM target))
    , d2 AS (DELETE FROM enrichment_runs WHERE task_id = (SELECT tid FROM target))
    , d3 AS (DELETE FROM gate_decisions WHERE task_id = (SELECT tid FROM target))
    , d4 AS (DELETE FROM code_reviews WHERE task_id = (SELECT tid FROM target))
    , d5 AS (DELETE FROM active_agents WHERE task_id = (SELECT tid FROM target))
    , d6 AS (DELETE FROM costs WHERE task_id = (SELECT tid FROM target))
    , d7 AS (DELETE FROM preview_logs WHERE task_id = (SELECT tid FROM target))
    , d8 AS (DELETE FROM learning_events WHERE task_id = (SELECT tid FROM target))
    SELECT 1
  `);

  const [updated] = await db
    .update(tasks)
    .set({
      status: "pending",
      enrichment: null,
      gateVerdict: null,
      gateReasoning: null,
      executionAttempts: 0,
      prUrl: null,
      failureReason: null,
      reworkCount: 0,
      reworkHistory: [],
      retryInstructions: null,
      blueprint: null,
      previewPort: null,
      previewStatus: null,
      previewUrl: null,
      previewStartedAt: null,
      suspendedFrom: null,
      worktreePath: null,
      worktreeBaseSha: null,
      completedMilestones: 0,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  return updated;
}

/**
 * Returns task counts grouped by status.
 * Uses Drizzle's sql template for the GROUP BY query.
 */
export async function countByStatus(accessibleRepoIds?: number[]): Promise<Record<string, number>> {
  if (accessibleRepoIds !== undefined && accessibleRepoIds.length === 0) {
    return {};
  }

  const where = accessibleRepoIds
    ? inArray(tasks.repoId, accessibleRepoIds)
    : undefined;

  const rows = await db
    .select({
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(where)
    .groupBy(tasks.status);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}

/**
 * Suspends a task by recording its current status in `suspendedFrom`
 * and transitioning it to `suspended`.
 */
export async function suspendTask(id: string) {
  const existing = await getById(id);
  if (!existing) {
    throw new Error(`Task ${id} not found`);
  }

  if (!canTransition(existing.status, "suspended")) {
    throw new Error(
      `Cannot suspend task ${id}: invalid transition from '${existing.status}'`,
    );
  }

  const [updated] = await db
    .update(tasks)
    .set({
      status: "suspended",
      suspendedFrom: existing.status,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  return updated;
}

/**
 * Returns all tasks currently in `suspended` status.
 */
export async function findSuspended() {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.status, "suspended"));
}

/** Terminal statuses excluded from duplicate-detection candidates. */
const TERMINAL_STATUSES = ["completed", "cancelled", "failed", "merged", "rejected"] as const;

/**
 * Returns recent non-terminal tasks for duplicate detection.
 * Excludes tasks in terminal statuses (completed, cancelled, failed, merged, rejected).
 * Optionally filters by producer/source type and limits the result set.
 *
 * @param options.producerType - If provided, only returns tasks whose `source` matches this value
 * @param options.limit        - Maximum number of candidate tasks to return (default 100)
 */
export async function getOpenTasksForDedup(options: {
  producerType?: string;
  limit?: number;
} = {}) {
  const { producerType, limit = 100 } = options;

  const conditions = [
    notInArray(tasks.status, [...TERMINAL_STATUSES]),
    ...(producerType !== undefined ? [eq(tasks.source, producerType)] : []),
  ];

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      body: tasks.body,
      status: tasks.status,
      producerType: tasks.source,
    })
    .from(tasks)
    .where(where)
    .orderBy(desc(tasks.createdAt))
    .limit(limit);
}
