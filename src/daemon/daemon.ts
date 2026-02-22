import { mkdir, rm } from "node:fs/promises";
import logger from "../logger.js";
import { resolveGitCredentials } from "../execution/worktree.js";
import { getGitProvider } from "../execution/git-provider.js";
import { Scheduler } from "./scheduler.js";
import { findStaleTasks, STALE_THRESHOLD_MS } from "./stale-tasks.js";
import { cleanupStale } from "../db/queries/active-agents.js";
import { list, updateStatus, suspendTask, findSuspended } from "../db/queries/tasks.js";
import { addEvent } from "../db/queries/task-events.js";
import { checkBudget } from "../db/queries/costs.js";
import { runPipeline } from "../agents/pipeline.js";
import { executeTask } from "../execution/worker.js";
import { logScanner } from "../producers/log-scanner.js";
import { bugHunter } from "../producers/bug-hunter.js";
import { securityScanner } from "../producers/security-scanner.js";
import { featureScout } from "../producers/feature-scout.js";
import { selfMonitor } from "../producers/self-monitor.js";
import { docAuditor } from "../producers/doc-auditor.js";
import { maintenanceProducer } from "../producers/maintenance.js";
import { recordRun } from "../db/queries/producer-runs.js";
import { notifyTasksCreated } from "../notifications.js";
import { listAll } from "../db/queries/repos.js";
import { runRetrospective } from "../agents/retrospective.js";
import { applyMonthlyDecay, archiveStale } from "../db/queries/learnings.js";
import { curateLearnings } from "../agents/keeper.js";
import { getConfig, setConfig } from "../domain/config.js";
import { cleanupExpiredPreviews } from "./preview-cleanup.js";
import { cleanupClosedPRPreviews } from "./pr-close-cleanup.js";
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
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const RETROSPECTIVE_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
const DECAY_MIN_GAP_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const PREVIEW_CLEANUP_INTERVAL_MS = 60 * 1_000; // 60 seconds
const PR_CLOSE_CLEANUP_INTERVAL_MS = 60 * 1_000; // 60 seconds
const SUSPEND_DRAIN_MS = 10_000; // 10s for _dispatch finally blocks to clean up

const ALL_PRODUCERS: Producer[] = [
  logScanner,
  bugHunter,
  securityScanner,
  featureScout,
  selfMonitor,
  docAuditor,
  maintenanceProducer,
];

export class Daemon {
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxPerUser: number;
  private readonly producerIntervalMs: number;

  private readonly activeTaskIds = new Set<string>();
  private readonly userCounts = new Map<number, number>();
  /** Tasks already notified about budget exhaustion (reset on budget recovery). */
  private readonly budgetNotified = new Set<string>();
  private readonly scheduler: Scheduler;
  private readonly producerSchedulers: Scheduler[] = [];
  private readonly retrospectiveScheduler: Scheduler;
  private readonly decayScheduler: Scheduler;
  private readonly previewCleanupScheduler: Scheduler;
  private readonly prCloseCleanupScheduler: Scheduler;
  private stopping = false;

  constructor(opts?: DaemonOptions) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrent = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPerUser = opts?.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.producerIntervalMs =
      opts?.producerIntervalMs ??
      parseInt(process.env.HIVE_PRODUCER_INTERVAL_MS ?? String(DEFAULT_PRODUCER_INTERVAL_MS), 10);

    this.scheduler = new Scheduler(this.pollIntervalMs, () => this._tick());
    this.retrospectiveScheduler = new Scheduler(MAINTENANCE_INTERVAL_MS, () => this._retrospectiveTick());
    this.decayScheduler = new Scheduler(MAINTENANCE_INTERVAL_MS, () => this._decayTick());
    this.previewCleanupScheduler = new Scheduler(PREVIEW_CLEANUP_INTERVAL_MS, () => cleanupExpiredPreviews());
    this.prCloseCleanupScheduler = new Scheduler(PR_CLOSE_CLEANUP_INTERVAL_MS, () => cleanupClosedPRPreviews(), { label: "pr-close-cleanup" });
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

    // Resume suspended tasks from a prior graceful shutdown
    const suspendedTasks = await findSuspended();
    for (const task of suspendedTasks) {
      try {
        // queued/enriching → re-enrich from pending; executing/reviewing → re-execute from approved
        const resumeTo =
          task.suspendedFrom === "executing" || task.suspendedFrom === "reviewing"
            ? "approved"
            : "pending";
        await updateStatus(task.id, resumeTo);
        await addEvent(
          task.id,
          "resumed",
          "daemon",
          `Task resumed from suspended (was ${task.suspendedFrom}) → ${resumeTo}`,
        );
        logger.info(
          { taskId: task.id, suspendedFrom: task.suspendedFrom, resumeTo },
          "Daemon: suspended task resumed",
        );
      } catch (err) {
        logger.warn(
          { taskId: task.id, err },
          "Daemon: could not resume suspended task, transitioning to failed",
        );
        try {
          await updateStatus(task.id, "failed");
        } catch {
          // Already logged, nothing more we can do
        }
      }
    }

    this.scheduler.start();

    // Start a scheduler for each producer, staggered evenly across the interval
    const staggerMs = ALL_PRODUCERS.length > 1
      ? Math.floor(this.producerIntervalMs / ALL_PRODUCERS.length)
      : 0;
    for (let i = 0; i < ALL_PRODUCERS.length; i++) {
      const producer = ALL_PRODUCERS[i];
      const s = new Scheduler(this.producerIntervalMs, () =>
        this._runProducer(producer),
        { label: `producer:${producer.name}`, initialDelayMs: i * staggerMs },
      );
      this.producerSchedulers.push(s);
      s.start();
    }

    // Start retrospective scheduler (24h interval, checks 7-day gap)
    this.retrospectiveScheduler.start();

    // Start decay scheduler (24h interval)
    this.decayScheduler.start();

    // Start preview cleanup scheduler (60s interval)
    this.previewCleanupScheduler.start();

    // Start PR-close cleanup scheduler (60s interval)
    this.prCloseCleanupScheduler.start();

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

    // Stop producer schedulers first and wait for in-flight ticks
    await Promise.all(this.producerSchedulers.map((s) => s.stop()));

    await this.retrospectiveScheduler.stop();
    await this.decayScheduler.stop();
    await this.previewCleanupScheduler.stop();
    await this.prCloseCleanupScheduler.stop();
    await this.scheduler.stop();

    // Suspend all in-flight tasks so they survive a deploy
    if (this.activeTaskIds.size > 0) {
      logger.info(
        { active: this.activeTaskIds.size },
        "Daemon: suspending in-flight tasks",
      );

      for (const taskId of this.activeTaskIds) {
        try {
          await suspendTask(taskId);
          await addEvent(taskId, "suspended", "daemon", "Task suspended on shutdown");
          logger.info({ taskId }, "Daemon: task suspended");
        } catch (err) {
          logger.warn({ taskId, err }, "Daemon: could not suspend task");
        }
      }

      // Brief drain for _dispatch finally blocks to clean up in-memory tracking
      await new Promise((resolve) => setTimeout(resolve, SUSPEND_DRAIN_MS));
    }

    logger.info("Daemon stopped");
  }

  private async _tick(): Promise<void> {
    if (this.stopping) return;
    if (this.activeTaskIds.size >= this.maxConcurrent) return;

    // Fetch candidate tasks: pending, approved (human-approved), and rework
    const [pendingResult, approvedResult, reworkResult] = await Promise.all([
      list({ status: "pending" }, 10),
      list({ status: "approved" }, 10),
      list({ status: "rework" }, 10),
    ]);

    // Combine and sort by createdAt ascending (oldest first)
    const candidates = [...pendingResult.tasks, ...approvedResult.tasks, ...reworkResult.tasks].sort(
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
        // Notify once per task so the user can see why it's stalled
        if (!this.budgetNotified.has(task.id)) {
          this.budgetNotified.add(task.id);
          void addEvent(
            task.id,
            "budget_exhausted",
            "daemon",
            "Daily budget exhausted — task paused until tomorrow. Or bribe an admin with beers to bump your limit!",
          ).catch(() => {});
        }
        continue;
      }
      // Clear notification flag if budget recovered
      this.budgetNotified.delete(task.id);

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
    if (!Number.isFinite(createdBy) || createdBy < 1) {
      logger.error({ raw: process.env.HIVE_DAEMON_USER_ID }, "Daemon: invalid HIVE_DAEMON_USER_ID, skipping producer tick");
      return;
    }

    // Global producers run once against the self-repo, not per user repo
    if (producer.global) {
      const selfRepoName = process.env.HIVE_SELF_REPO;
      if (!selfRepoName) {
        logger.debug({ producer: producer.name }, "Daemon: HIVE_SELF_REPO not set, skipping global producer");
        return;
      }
      const selfRepo = allRepos.find((r) => r.fullName === selfRepoName);
      if (!selfRepo) {
        logger.warn({ producer: producer.name, selfRepoName }, "Daemon: self-repo not found in DB, skipping global producer");
        return;
      }
      await this._runProducerForRepo(producer, selfRepo, createdBy);
      return;
    }

    for (const repo of allRepos) {
      const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;

      // doc-auditor is gated on settings.docs.enabled, not the producers map
      if (producer.name === "doc-auditor") {
        const docs = repoSettings.docs as { enabled?: boolean } | undefined;
        if (!docs?.enabled) {
          logger.debug(
            { producer: producer.name, repo: repo.fullName },
            "Daemon: docs not enabled for repo, skipping doc-auditor",
          );
          continue;
        }
        await this._runProducerForRepo(producer, repo, createdBy);
        continue;
      }

      // Per-repo producer toggle: skip unless explicitly enabled
      const producersMap = (repoSettings.producers ?? {}) as Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
      const producerEntry = producersMap[producer.name];
      if (!producerEntry || producerEntry.enabled !== true) {
        logger.debug(
          { producer: producer.name, repo: repo.fullName },
          "Daemon: producer not enabled for repo, skipping",
        );
        continue;
      }

      await this._runProducerForRepo(producer, repo, createdBy, producerEntry.config);
    }
  }

  private async _runProducerForRepo(
    producer: Producer,
    repo: { id: number; fullName: string; defaultBranch: string | null; provider: string },
    createdBy: number,
    config?: Record<string, unknown>,
  ): Promise<void> {
    const start = Date.now();
    let cloneDir: string | undefined;

    try {
      // Shallow-clone the repo if the producer needs filesystem access
      let repoDir: string | undefined;
      if (producer.needsRepo) {
        cloneDir = `/tmp/hive-producer-clones/${repo.id}-${producer.name}-${Date.now()}`;
        await mkdir("/tmp/hive-producer-clones", { recursive: true });
        const creds = await resolveGitCredentials(createdBy, repo.provider);
        const gitProvider = getGitProvider(repo.provider);
        await gitProvider.clone(
          repo.fullName,
          cloneDir,
          repo.defaultBranch ?? "main",
          creds,
          { depth: 1 },
        );
        repoDir = cloneDir;
      }

      const ctx: ProducerContext = {
        repoId: repo.id,
        repoFullName: repo.fullName,
        repoDir,
        createdBy,
        config: config ?? {},
      };

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

      if (result.errors.length > 0) {
        logger.warn(
          {
            producer: producer.name,
            repo: repo.fullName,
            errors: result.errors,
            durationMs,
          },
          "Daemon: producer run completed with errors",
        );
      } else {
        logger.info(
          {
            producer: producer.name,
            repo: repo.fullName,
            tasksCreated: result.tasksCreated,
            duplicatesSkipped: result.duplicatesSkipped,
            durationMs,
          },
          "Daemon: producer run completed",
        );
      }

      if (result.tasksCreated > 0) {
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
    } finally {
      if (cloneDir) {
        await rm(cloneDir, { recursive: true, force: true }).catch((cleanupErr) => {
          logger.warn({ err: cleanupErr, path: cloneDir }, "Daemon: failed to clean up producer clone");
        });
      }
    }
  }

  private async _retrospectiveTick(): Promise<void> {
    try {
      const lastRunRaw = await getConfig("lastRetrospectiveRun");
      if (lastRunRaw) {
        const lastRun = new Date(lastRunRaw as string).getTime();
        const elapsed = Date.now() - lastRun;
        if (elapsed < RETROSPECTIVE_MIN_GAP_MS) {
          logger.debug(
            { elapsedDays: (elapsed / (24 * 60 * 60 * 1000)).toFixed(1) },
            "Daemon: retrospective not due yet, skipping",
          );
          return;
        }
      }

      logger.info("Daemon: starting weekly retrospective");
      const report = await runRetrospective();
      logger.info(
        {
          totalTasks: report.metrics.totalTasks,
          firstPassRate: report.metrics.firstPassRate,
          proposals: report.proposals.length,
          blindSpots: report.blindSpots.length,
        },
        "Daemon: retrospective completed",
      );
    } catch (err) {
      logger.error({ err }, "Daemon: retrospective tick failed");
    }
  }

  private async _decayTick(): Promise<void> {
    try {
      // Gate decay so it only runs once per 30 days
      const lastDecayRaw = await getConfig("lastDecayRun");
      if (lastDecayRaw) {
        const lastDecay = new Date(lastDecayRaw as string).getTime();
        const elapsed = Date.now() - lastDecay;
        if (elapsed < DECAY_MIN_GAP_MS) {
          logger.debug(
            { elapsedDays: (elapsed / (24 * 60 * 60 * 1000)).toFixed(1) },
            "Daemon: monthly decay not due yet, skipping",
          );
          // Still run archival and curation even if decay is not due
          const archived = await archiveStale();
          if (archived > 0) {
            logger.info({ archived }, "Daemon: stale archival complete (decay skipped)");
          }
          await curateLearnings();
          logger.info("Daemon: learning curation complete");
          return;
        }
      }

      const decayed = await applyMonthlyDecay();
      await setConfig("lastDecayRun", new Date().toISOString());
      const archived = await archiveStale();

      logger.info(
        { decayed, archived },
        "Daemon: confidence decay and stale archival complete",
      );

      await curateLearnings();

      logger.info("Daemon: learning curation complete");
    } catch (err) {
      logger.error({ err }, "Daemon: decay tick failed");
    }
  }

  private async _dispatch(
    task: { id: string; status: string; createdBy: number },
  ): Promise<void> {
    try {
      if (task.status === "pending") {
        await runPipeline(task.id);
        logger.info({ taskId: task.id }, "Daemon: pipeline completed");
      } else if (task.status === "approved" || task.status === "rework") {
        const result = await executeTask(task.id);
        logger.info(
          { taskId: task.id, success: result.success },
          "Daemon: execution completed",
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
      // Safety net: if the task is still in a dispatchable state, transition
      // to failed so it doesn't get retried indefinitely.
      try {
        const reason = err instanceof Error ? err.message : String(err);
        await addEvent(task.id, "error", "daemon", `Dispatch failed: ${reason}`);
        await updateStatus(task.id, "failed");
      } catch {
        // Task may already have transitioned — ignore
      }
    } finally {
      this.activeTaskIds.delete(task.id);
      const current = this.userCounts.get(task.createdBy) ?? 0;
      this.userCounts.set(task.createdBy, Math.max(0, current - 1));
    }
  }
}
