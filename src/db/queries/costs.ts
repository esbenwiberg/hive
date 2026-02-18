import { eq, sql } from "drizzle-orm";
import { db } from "../connection.js";
import { costs, users } from "../schema.js";

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
export async function getTodayTotalGlobal(): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
    })
    .from(costs)
    .where(
      sql`${costs.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    );

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
