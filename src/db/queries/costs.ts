import { eq, sql, and, gte, lte, inArray } from "drizzle-orm";
import { db } from "../connection.js";
import { costs, users, tasks, repos } from "../schema.js";

// ── Shared types ────────────────────────────────────────────────────────────

export interface DateRange {
  from?: Date;
  to?: Date;
}

export interface DailyBreakdownRow {
  date: string;
  totalUsd: number;
  count: number;
}

export interface BreakdownRow {
  dimension: string;
  totalUsd: number;
  count: number;
}

export interface MonthlySummaryRow {
  month: string;
  totalUsd: number;
  count: number;
}

/** Optional scope filter — when set, queries are restricted to this user/repos. */
export interface CostScope {
  userId?: number;
  repoIds?: number[];
}

/**
 * Records a cost entry for an API call.
 */
export async function recordCost(
  taskId: string,
  userId: number,
  agent: string,
  model: string,
  costUsd: number,
  turns?: number,
  durationMs?: number,
) {
  const [row] = await db
    .insert(costs)
    .values({
      taskId,
      userId,
      agent,
      model,
      costUsd: costUsd.toFixed(4),
      turns: turns ?? null,
      durationMs: durationMs ?? null,
    })
    .returning();

  return row;
}

/**
 * Returns the total cost (USD) for a specific task.
 * Sums all cost records associated with the given taskId.
 */
export async function getTotalCostForTask(taskId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs)
    .where(eq(costs.taskId, taskId));

  return parseFloat(row.total);
}

/**
 * Returns the total cost (USD) for a user today (since midnight UTC).
 * Numeric columns come back as strings from pg — parsed with parseFloat.
 */
export async function getTodayTotal(userId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs)
    .where(
      sql`${costs.userId} = ${userId} AND ${costs.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    );

  return parseFloat(row.total);
}

/**
 * Returns the total cost (USD) across all users today (since midnight UTC).
 */
export async function getTodayTotalGlobal(scope?: CostScope): Promise<number> {
  const conds = [
    sql`${costs.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    ...scopeConditions(scope),
  ];

  let query = db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const [row] = await query.where(and(...conds));
  return parseFloat(row.total);
}

/**
 * Returns the lifetime total cost (USD) for a user.
 */
export async function getUserTotal(userId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs)
    .where(eq(costs.userId, userId));

  return parseFloat(row.total);
}

/**
 * Checks remaining budget for a user against their daily limit.
 * Returns the remaining amount in USD.
 * Reads the user's dailyBudget from the users table if no explicit budget is passed.
 */
export async function checkBudget(
  userId: number,
  dailyBudget?: number,
): Promise<number> {
  let budget = dailyBudget;

  if (budget === undefined) {
    const [user] = await db
      .select({ dailyBudget: users.dailyBudget })
      .from(users)
      .where(eq(users.id, userId));

    budget = user ? parseFloat(user.dailyBudget ?? "100.00") : 100;
  }

  const todaySpent = await getTodayTotal(userId);
  return budget - todaySpent;
}

// ── Helper: build date-range conditions ─────────────────────────────────────

function dateConditions(range?: DateRange) {
  const conds = [];
  if (range?.from) {
    conds.push(gte(costs.createdAt, range.from));
  }
  if (range?.to) {
    conds.push(lte(costs.createdAt, range.to));
  }
  return conds;
}

// ── Helper: build scope conditions (user + repo filtering) ──────────────────

function scopeConditions(scope?: CostScope) {
  const conds = [];
  if (scope?.userId != null) {
    conds.push(eq(costs.userId, scope.userId));
  }
  if (scope?.repoIds && scope.repoIds.length > 0) {
    conds.push(inArray(tasks.repoId, scope.repoIds));
  }
  return conds;
}

/** Whether the query needs a tasks join (when filtering by repo). */
function needsTasksJoin(scope?: CostScope): boolean {
  return (scope?.repoIds?.length ?? 0) > 0;
}

// ── Aggregation queries ─────────────────────────────────────────────────────

/**
 * Returns the all-time total cost (USD) across all users.
 */
export async function getAllTimeTotal(scope?: CostScope): Promise<number> {
  const conds = scopeConditions(scope);

  let query = db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const [row] = conds.length > 0
    ? await query.where(and(...conds))
    : await query;
  return parseFloat(row.total);
}

/**
 * Returns the total cost (USD) for the current calendar month (UTC).
 */
export async function getMonthTotal(scope?: CostScope): Promise<number> {
  const conds = [
    sql`${costs.createdAt} >= date_trunc('month', now() AT TIME ZONE 'UTC')`,
    ...scopeConditions(scope),
  ];

  let query = db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const [row] = await query.where(and(...conds));
  return parseFloat(row.total);
}

/**
 * Daily cost breakdown for the last N days (default 30).
 * Returns one row per day with total USD and entry count.
 */
export async function getDailyBreakdown(
  days: number = 30,
  range?: DateRange,
  scope?: CostScope,
): Promise<DailyBreakdownRow[]> {
  const conds = [...dateConditions(range), ...scopeConditions(scope)];

  // If no explicit range, default to last N days
  if (!range?.from) {
    conds.push(
      sql`${costs.createdAt} >= now() - make_interval(days => ${days})`,
    );
  }

  const where = conds.length > 0 ? and(...conds) : undefined;

  let query = db
    .select({
      date: sql<string>`to_char(${costs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const rows = await query
    .where(where)
    .groupBy(
      sql`to_char(${costs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    )
    .orderBy(
      sql`to_char(${costs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    );

  return rows.map((r) => ({
    date: r.date,
    totalUsd: parseFloat(r.totalUsd),
    count: r.count,
  }));
}

/**
 * Cost breakdown grouped by user (joins users table for display name).
 */
export async function getBreakdownByUser(
  range?: DateRange,
  scope?: CostScope,
): Promise<BreakdownRow[]> {
  const conds = [...dateConditions(range), ...scopeConditions(scope)];
  const where = conds.length > 0 ? and(...conds) : undefined;

  let query = db
    .select({
      dimension: sql<string>`coalesce(${users.displayName}, 'unknown')`,
      totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(costs)
    .leftJoin(users, eq(costs.userId, users.id));

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const rows = await query
    .where(where)
    .groupBy(users.displayName)
    .orderBy(sql`sum(${costs.costUsd}) desc`);

  return rows.map((r) => ({
    dimension: r.dimension,
    totalUsd: parseFloat(r.totalUsd),
    count: r.count,
  }));
}

/**
 * Cost breakdown grouped by repo.
 * Joins costs → tasks → repos to resolve the repo full name.
 */
export async function getBreakdownByRepo(
  range?: DateRange,
  scope?: CostScope,
): Promise<BreakdownRow[]> {
  const conds = [...dateConditions(range), ...scopeConditions(scope)];
  const where = conds.length > 0 ? and(...conds) : undefined;

  // This query always joins tasks → repos for the dimension label
  const rows = await db
    .select({
      dimension: sql<string>`coalesce(${repos.fullName}, 'unknown')`,
      totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(costs)
    .leftJoin(tasks, eq(costs.taskId, tasks.id))
    .leftJoin(repos, eq(tasks.repoId, repos.id))
    .where(where)
    .groupBy(repos.fullName)
    .orderBy(sql`sum(${costs.costUsd}) desc`);

  return rows.map((r) => ({
    dimension: r.dimension,
    totalUsd: parseFloat(r.totalUsd),
    count: r.count,
  }));
}

/**
 * Cost breakdown grouped by agent name.
 */
export async function getBreakdownByAgent(
  range?: DateRange,
  scope?: CostScope,
): Promise<BreakdownRow[]> {
  const conds = [...dateConditions(range), ...scopeConditions(scope)];
  const where = conds.length > 0 ? and(...conds) : undefined;

  let query = db
    .select({
      dimension: costs.agent,
      totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const rows = await query
    .where(where)
    .groupBy(costs.agent)
    .orderBy(sql`sum(${costs.costUsd}) desc`);

  return rows.map((r) => ({
    dimension: r.dimension,
    totalUsd: parseFloat(r.totalUsd),
    count: r.count,
  }));
}

/**
 * Cost breakdown grouped by model.
 */
export async function getBreakdownByModel(
  range?: DateRange,
  scope?: CostScope,
): Promise<BreakdownRow[]> {
  const conds = [...dateConditions(range), ...scopeConditions(scope)];
  const where = conds.length > 0 ? and(...conds) : undefined;

  let query = db
    .select({
      dimension: costs.model,
      totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const rows = await query
    .where(where)
    .groupBy(costs.model)
    .orderBy(sql`sum(${costs.costUsd}) desc`);

  return rows.map((r) => ({
    dimension: r.dimension,
    totalUsd: parseFloat(r.totalUsd),
    count: r.count,
  }));
}

/**
 * Monthly cost summary for the last N months (default 12).
 * Returns one row per month with total USD and entry count.
 */
export async function getMonthlySummary(
  months: number = 12,
  range?: DateRange,
  scope?: CostScope,
): Promise<MonthlySummaryRow[]> {
  const conds = [...dateConditions(range), ...scopeConditions(scope)];

  // If no explicit range, default to last N months
  if (!range?.from) {
    conds.push(
      sql`${costs.createdAt} >= now() - make_interval(months => ${months})`,
    );
  }

  const where = conds.length > 0 ? and(...conds) : undefined;

  let query = db
    .select({
      month: sql<string>`to_char(${costs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM')`,
      totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(costs);

  if (needsTasksJoin(scope)) {
    query = query.leftJoin(tasks, eq(costs.taskId, tasks.id)) as unknown as typeof query;
  }

  const rows = await query
    .where(where)
    .groupBy(
      sql`to_char(${costs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM')`,
    )
    .orderBy(
      sql`to_char(${costs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM')`,
    );

  return rows.map((r) => ({
    month: r.month,
    totalUsd: parseFloat(r.totalUsd),
    count: r.count,
  }));
}