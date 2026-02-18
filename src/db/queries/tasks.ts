import { eq, ilike, and, sql, count } from "drizzle-orm";
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

  if (filters.status) {
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
      .orderBy(tasks.createdAt),
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

  const [updated] = await db
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, id))
    .returning();

  return updated;
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
