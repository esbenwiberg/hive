import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Scans for recurring error patterns among recently failed tasks.
 * Groups by failureReason prefix (first 100 chars) and creates
 * investigation tasks for patterns that appear 2+ times in the last 24 hours.
 */
export class LogScannerProducer implements Producer {
  name = "log-scanner";

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    try {
      // Query tasks that failed in the last 24 hours with a failureReason
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          prefix: sql<string>`left(${tasks.failureReason}, 100)`,
          count: sql<number>`count(*)::int`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.status, "failed"),
            sql`${tasks.failureReason} IS NOT NULL`,
            sql`${tasks.createdAt} >= ${cutoff.toISOString()}`,
          ),
        )
        .groupBy(sql`left(${tasks.failureReason}, 100)`)
        .having(sql`count(*) >= 2`);

      for (const row of rows) {
        try {
          const title = `Investigate recurring failure: ${row.prefix}`;
          const source = `producer:${this.name}`;

          if (await isDuplicate(source, title)) {
            result.duplicatesSkipped++;
            continue;
          }

          if (!ctx.dryRun) {
            await create({
              title,
              body: `Recurring failure detected (${row.count} occurrences in last 24h). Failure prefix: ${row.prefix}`,
              source,
              type: "bug",
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create task for prefix "${row.prefix}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Log scanner query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const logScanner = new LogScannerProducer();
export default logScanner;
