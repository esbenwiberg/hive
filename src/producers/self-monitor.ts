import { logBuffer } from "../log-buffer.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import logger from "../logger.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Reads Hive's own pino logs (from the in-memory log buffer) to detect
 * recurring errors and create investigation tasks.
 *
 * Global producer — hardcoded to the Hive self-repo.
 */
export class SelfMonitorProducer implements Producer {
  name = "self-monitor";
  global = true;

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    const source = `producer:${this.name}`;
    const cutoff = Date.now() - 60 * 60 * 1000; // last hour

    // Read recent logs from pino ring buffer
    const entries = logBuffer.getRecent();
    const recentErrors = entries.filter(
      (e) => e.level >= 50 && e.time >= cutoff,
    );

    if (recentErrors.length === 0) return result;

    // Group by message prefix (first 100 chars) to find recurring patterns
    const groups = new Map<
      string,
      { count: number; firstTime: number; lastTime: number; sampleErr?: string; sampleTaskId?: string }
    >();

    for (const entry of recentErrors) {
      const key = entry.msg.slice(0, 100);
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        existing.lastTime = Math.max(existing.lastTime, entry.time);
        if (!existing.sampleErr && entry.err) existing.sampleErr = entry.err;
        if (!existing.sampleTaskId && entry.taskId) existing.sampleTaskId = entry.taskId;
      } else {
        groups.set(key, {
          count: 1,
          firstTime: entry.time,
          lastTime: entry.time,
          sampleErr: entry.err,
          sampleTaskId: entry.taskId,
        });
      }
    }

    // Create tasks for patterns with 2+ occurrences
    for (const [msg, info] of groups) {
      if (info.count < 2) continue;

      const title = `Recurring error: ${msg.slice(0, 120)}`;

      try {
        if (await isDuplicate(source, title)) {
          result.duplicatesSkipped++;
          continue;
        }

        const firstSeen = new Date(info.firstTime).toISOString();
        const lastSeen = new Date(info.lastTime).toISOString();

        const body = [
          `Recurring error detected ${info.count} times in the last hour.`,
          `First seen: ${firstSeen}. Last seen: ${lastSeen}.`,
          info.sampleTaskId ? `Affected task: ${info.sampleTaskId}.` : null,
          ``,
          `## Error message`,
          `\`${msg}\``,
          info.sampleErr
            ? `\n## Stack / detail\n\`\`\`\n${info.sampleErr.slice(0, 1000)}\n\`\`\``
            : null,
          ``,
          `## Investigation`,
          `Search the codebase for the error message to find the throw site. ` +
            `Check the daemon (src/daemon/daemon.ts), pipeline (src/agents/pipeline.ts), ` +
            `and worker (src/execution/worker.ts) for the originating component. ` +
            `Review recent deployments for regressions.`,
        ]
          .filter(Boolean)
          .join("\n");

        if (!ctx.dryRun) {
          await create({
            title,
            body,
            source,
            type: "bug",
            repoId: ctx.repoId,
            createdBy: ctx.createdBy,
          });
        }
        result.tasksCreated++;
      } catch (err) {
        result.errors.push(
          `Failed to create task for "${msg.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}

export const selfMonitor = new SelfMonitorProducer();
export default selfMonitor;
