import logger from "../logger.js";
import { Scheduler } from "./scheduler.js";
import { findStaleTasks, STALE_THRESHOLD_MS } from "./stale-tasks.js";
import { cleanupStale } from "../db/queries/active-agents.js";
import { list, updateStatus } from "../db/queries/tasks.js";
import { checkBudget } from "../db/queries/costs.js";
import { runPipeline } from "../agents/pipeline.js";
import { executeTask } from "../execution/worker.js";
import { logScanner } from "../producers/log-scanner.js";
import { bugHunter } from "../producers/bug-hunter.js";
import { securityScanner } from "../producers/security-scanner.js";
import { featureScout } from "../producers/feature-scout.js";
import { selfMonitor } from "../producers/self-monitor.js";
import { recordRun } from "../db/queries/producer-runs.js";
import { notifyTasksCreated } from "../notifications.js";
import { listAll } from "../db/queries/repos.js";
import type { Producer, ProducerContext } from "../producers/base.js";

interface DaemonOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
  maxPerUser?: number;
  producerIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_PER_USER = 2;
const DEFAULT_PRODUCER_INTERVAL_MS = 15 * 60 * 1_000; // 15 minutes
const DRAIN_POLL_MS = 500;
const MAX_DRAIN_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

const ALL_PRODUCERS: Producer[] = [
  logScanner,
  bugHunter,
  securityScanner,
  featureScout,
  selfMonitor,
];

export class Daemon {
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxPerUser: number;
  private readonly producerIntervalMs: number;

  private readonly activeTaskIds = new Set<string>();
  private readonly userCounts = new Map<number, number>();
  private readonly scheduler: Scheduler;
  private readonly producerSchedulers: Scheduler[] = [];
  private stopping = false;

  constructor(opts?: DaemonOptions) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrent = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPerUser = opts?.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.producerIntervalMs =
      opts?.producerIntervalMs ??
      parseInt(process.env.HIVE_PRODUCER_INTERVAL_MS ?? String(DEFAULT_PRODUCER_INTERVAL_MS), 10);

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
          "Daemon: stale task transitioned to failed",
        );
      } catch (err) {
        logger.warn(
          { taskId: task.id, status: task.status, err },
          "Daemon: could not transition stale task to failed, skipping",
        );
      }
    }

    this.scheduler.start();

    // Start a scheduler for each producer
    for (const producer of ALL_PRODUCERS) {
      const s = new Scheduler(this.producerIntervalMs, () =>
        this._runProducer(producer),
      );
      this.producerSchedulers.push(s);
      s.start();
    }

    logger.info(
      {
        maxConcurrent: this.maxConcurrent,
        pollIntervalMs: this.pollIntervalMs,
        maxPerUser: this.maxPerUser,
        producerIntervalMs: this.producerIntervalMs,
        producers: ALL_PRODUCERS.map((p) => p.name),
      },
      "Daemon started",
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;

    // Stop producer schedulers first
    for (const s of this.producerSchedulers) {
      s.stop();
    }

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

    // Cache budget lookups within a single tick to avoid redundant DB queries
    const budgetCache = new Map<number, number>();

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

      // Budget guard (cached per user within this tick)
      let remaining = budgetCache.get(task.createdBy);
      if (remaining === undefined) {
        try {
          remaining = await checkBudget(task.createdBy);
          budgetCache.set(task.createdBy, remaining);
        } catch (err) {
          logger.warn(
            { taskId: task.id, userId: task.createdBy, err },
            "Daemon: budget check failed, skipping task",
          );
          continue;
        }
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

  private async _runProducer(producer: Producer): Promise<void> {
    let allRepos: Awaited<ReturnType<typeof listAll>>;
    try {
      allRepos = await listAll();
    } catch (err) {
      logger.error({ err, producer: producer.name }, "Daemon: failed to list repos for producer");
      return;
    }

    const createdBy = parseInt(process.env.HIVE_DAEMON_USER_ID ?? "1", 10);

    for (const repo of allRepos) {
      const ctx: ProducerContext = {
        repoId: repo.id,
        repoFullName: repo.fullName,
        createdBy,
      };

      const start = Date.now();
      try {
        const result = await producer.run(ctx);
        const durationMs = Date.now() - start;

        await recordRun({
          producer: producer.name,
          repo: repo.fullName,
          tasksCreated: result.tasksCreated,
          duplicatesSkipped: result.duplicatesSkipped,
          errors: result.errors,
          costUsd: result.costUsd,
          durationMs,
        });

        logger.info(
          {
            producer: producer.name,
            repo: repo.fullName,
            tasksCreated: result.tasksCreated,
            duplicatesSkipped: result.duplicatesSkipped,
            errors: result.errors.length,
            durationMs,
          },
          "Daemon: producer run completed",
        );

        if (result.tasksCreated > 0) {
          // We don't have individual task titles/IDs from ProducerResult,
          // so pass summary info
          await notifyTasksCreated(
            producer.name,
            repo.fullName,
            [`${result.tasksCreated} task(s) created`],
            [],
          ).catch((notifyErr) => {
            logger.warn(
              { err: notifyErr, producer: producer.name },
              "Daemon: notification failed",
            );
          });
        }
      } catch (err) {
        const durationMs = Date.now() - start;
        logger.error(
          { err, producer: producer.name, repo: repo.fullName },
          "Daemon: producer run failed",
        );

        try {
          await recordRun({
            producer: producer.name,
            repo: repo.fullName,
            tasksCreated: 0,
            duplicatesSkipped: 0,
            errors: [err instanceof Error ? err.message : String(err)],
            costUsd: 0,
            durationMs,
          });
        } catch (recordErr) {
          logger.error(
            { err: recordErr, producer: producer.name },
            "Daemon: failed to record producer run error",
          );
        }
      }
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
      } else {
        logger.warn(
          { taskId: task.id, status: task.status },
          "Daemon: unexpected task status in dispatch, skipping",
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
