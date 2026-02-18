import { sql, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Monitors for tasks stuck in transitional statuses for too long.
 * Creates self-healing tasks for any task stuck in enriching, executing,
 * or reviewing status for more than 30 minutes.
 */
export class SelfMonitorProducer implements Producer {
  name = "self-monitor";

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    try {
      const stuckStatuses = ["enriching", "executing", "reviewing"];
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);

      const stuckTasks = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(
          sql`${tasks.status} IN (${sql.join(
            stuckStatuses.map((s) => sql`${s}`),
            sql`, `,
          )}) AND ${tasks.updatedAt} < ${cutoff.toISOString()}`,
        );

      const source = `producer:${this.name}`;

      for (const stuck of stuckTasks) {
        try {
          const title = `Self-monitor: task ${stuck.id} stuck in ${stuck.status}`;

          if (await isDuplicate(source, title)) {
            result.duplicatesSkipped++;
            continue;
          }

          if (!ctx.dryRun) {
            await create({
              title,
              body: `Task ${stuck.id} has been stuck in '${stuck.status}' status for over 30 minutes. Requires investigation.`,
              source,
              type: "bug",
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create self-monitor task for ${stuck.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Self-monitor query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const selfMonitor = new SelfMonitorProducer();
export default selfMonitor;
