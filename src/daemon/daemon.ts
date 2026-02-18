import logger from "../logger.js";
import { Scheduler } from "./scheduler.js";
import { findStaleTasks, STALE_THRESHOLD_MS } from "./stale-tasks.js";
import { cleanupStale } from "../db/queries/active-agents.js";
import { list, updateStatus } from "../db/queries/tasks.js";
import { checkBudget } from "../db/queries/costs.js";
import { runPipeline } from "../agents/pipeline.js";
import { executeTask } from "../execution/worker.js";

interface DaemonOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
  maxPerUser?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_PER_USER = 2;
const DRAIN_POLL_MS = 500;
const MAX_DRAIN_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

export class Daemon {
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxPerUser: number;

  private readonly activeTaskIds = new Set<string>();
  private readonly userCounts = new Map<number, number>();
  private readonly scheduler: Scheduler;
  private stopping = false;

  constructor(opts?: DaemonOptions) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrent = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPerUser = opts?.maxPerUser ?? DEFAULT_MAX_PER_USER;

    this.scheduler = new Scheduler(this.pollIntervalMs, () => this._tick());
  }

  async start(): Promise<void> {
    // Clean up stale active-agent rows from a prior crash
    const cleaned = await cleanupStale(STALE_THRESHOLD_MS);
    if (cleaned > 0) {
      logger.info({ cleaned }, "Daemon: cleaned up stale active-agent rows");
    }

    // Recover stale tasks stuck in transitional states
    const staleTasks = await findStaleTasks(STALE_THRESHOLD_MS);
    for (const task of staleTasks) {
      try {
        await updateStatus(task.id, "failed");
        logger.info(
          { taskId: task.id, previousStatus: task.status },
          `Daemon: stale task transitioned to failed (was stuck in ${task.status})`,
        );
      } catch (err) {
        logger.warn(
          { taskId: task.id, status: task.status, err },
          "Daemon: could not transition stale task to failed, skipping",
        );
      }
    }

    this.scheduler.start();

    logger.info(
      {
        maxConcurrent: this.maxConcurrent,
        pollIntervalMs: this.pollIntervalMs,
        maxPerUser: this.maxPerUser,
      },
      "Daemon started",
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.scheduler.stop();

    // Wait for in-flight tasks to drain
    if (this.activeTaskIds.size > 0) {
      logger.info(
        { active: this.activeTaskIds.size },
        "Daemon: waiting for in-flight tasks to drain",
      );

      await new Promise<void>((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (this.activeTaskIds.size === 0) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started >= MAX_DRAIN_TIMEOUT_MS) {
            clearInterval(timer);
            logger.warn(
              { remaining: this.activeTaskIds.size },
              "Daemon: drain timeout exceeded, stopping with tasks still in flight",
            );
            resolve();
          }
        }, DRAIN_POLL_MS);
      });
    }

    logger.info("Daemon stopped");
  }

  private async _tick(): Promise<void> {
    if (this.stopping) return;
    if (this.activeTaskIds.size >= this.maxConcurrent) return;

    // Fetch candidate tasks: pending and rework
    const [pendingResult, reworkResult] = await Promise.all([
      list({ status: "pending" }, 10),
      list({ status: "rework" }, 10),
    ]);

    // Combine and sort by createdAt ascending (oldest first)
    const candidates = [...pendingResult.tasks, ...reworkResult.tasks].sort(
      (a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return aTime - bTime;
      },
    );

    for (const task of candidates) {
      if (this.stopping) return;
      if (this.activeTaskIds.size >= this.maxConcurrent) return;

      // Skip tasks already in flight
      if (this.activeTaskIds.has(task.id)) continue;

      // Per-user concurrency guard
      const userCount = this.userCounts.get(task.createdBy) ?? 0;
      if (userCount >= this.maxPerUser) {
        logger.debug(
          { taskId: task.id, userId: task.createdBy, userCount },
          "Daemon: per-user concurrency limit reached, skipping task",
        );
        continue;
      }

      // Budget guard
      let remaining: number;
      try {
        remaining = await checkBudget(task.createdBy);
      } catch (err) {
        logger.warn(
          { taskId: task.id, userId: task.createdBy, err },
          "Daemon: budget check failed, skipping task",
        );
        continue;
      }

      if (remaining <= 0) {
        logger.warn(
          { taskId: task.id, userId: task.createdBy, remaining },
          "Daemon: user budget exhausted, skipping task",
        );
        continue;
      }

      // All guards passed — dispatch
      this.activeTaskIds.add(task.id);
      this.userCounts.set(task.createdBy, userCount + 1);

      void this._dispatch(task).catch((err) => {
        logger.error(
          { taskId: task.id, err },
          "Daemon: unhandled error in dispatch",
        );
      });
    }
  }

  private async _dispatch(
    task: { id: string; status: string; createdBy: number },
  ): Promise<void> {
    try {
      if (task.status === "pending") {
        await runPipeline(task.id);
        logger.info({ taskId: task.id }, "Daemon: pipeline completed");
      } else if (task.status === "rework") {
        const result = await executeTask(task.id);
        logger.info(
          { taskId: task.id, success: result.success },
          "Daemon: rework execution completed",
        );
      }
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        "Daemon: dispatch error",
      );
    } finally {
      this.activeTaskIds.delete(task.id);
      const current = this.userCounts.get(task.createdBy) ?? 0;
      this.userCounts.set(task.createdBy, Math.max(0, current - 1));
    }
  }
}
