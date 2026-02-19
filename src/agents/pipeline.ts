import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import logger from "../logger.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { getById, updateStatus } from "../db/queries/tasks.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { routeTask } from "./router.js";
import { evaluateGate } from "./gate.js";
import { runEnrichers } from "../enrichers/base.js";
import { getEnabledEnrichers } from "../enrichers/index.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { EnricherConfig } from "../enrichers/base.js";

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Orchestrates the full Route -> Enrich -> Gate pipeline for a task.
 *
 * Steps:
 * 1. Load task, verify it's pending
 * 2. Route (pending -> queued): classify type/size/workflow
 * 3. Transition queued -> enriching
 * 4. Run enabled enrichers
 * 5. Run gate evaluation (enriching -> ready/approved/rejected/rework)
 *
 * On unrecoverable failure, transitions the task to 'failed'.
 */
export async function runPipeline(taskId: string): Promise<void> {
  logger.info({ taskId }, "Pipeline: starting");

  // ── Step 1: Load and validate ───────────────────────────────────────────
  const task = await getById(taskId);

  if (!task) {
    throw new Error(`Pipeline: task ${taskId} not found`);
  }

  if (task.status !== "pending") {
    throw new Error(
      `Pipeline: task ${taskId} is not pending (status: ${task.status})`,
    );
  }

  // ── Step 2: Route ─────────────────────────────────────────────────────────
  try {
    await routeTask(taskId);
    logger.info({ taskId }, "Pipeline: routing complete");
  } catch (err) {
    logger.error({ taskId, err }, "Pipeline: routing failed");
    await failTask(taskId, err);
    return;
  }

  // ── Step 3: Transition to enriching ───────────────────────────────────────
  try {
    await updateStatus(taskId, "enriching");
    logger.info({ taskId }, "Pipeline: transitioned to enriching");
  } catch (err) {
    logger.error({ taskId, err }, "Pipeline: failed to transition to enriching");
    await failTask(taskId, err);
    return;
  }

  // ── Step 4: Run enrichers ─────────────────────────────────────────────────
  try {
    const config = getAutonomousConfig();
    const enrichers = getEnabledEnrichers(config);

    // Build enricher config map: global defaults, then per-repo overrides
    const enricherConfigs: Record<string, EnricherConfig> = {};
    for (const entry of config.enrichers) {
      enricherConfigs[entry.name] = { enabled: entry.enabled };
    }

    // Reload task to read its repoId for per-repo overrides
    const taskForRepo = await getById(taskId);
    if (taskForRepo) {
      const repo = await getRepoById(taskForRepo.repoId);
      if (repo) {
        const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;
        const enricherOverrides = (repoSettings.enrichers ?? {}) as Record<string, { enabled?: boolean }>;
        for (const [name, override] of Object.entries(enricherOverrides)) {
          if (enricherConfigs[name] && override.enabled !== undefined) {
            enricherConfigs[name].enabled = override.enabled;
          }
        }
      }
    }

    // Reload task to get latest state after routing
    const enrichingTask = await getById(taskId);
    if (!enrichingTask) {
      throw new Error(`Pipeline: task ${taskId} disappeared during enrichment`);
    }

    // Determine repo directory — skip enrichment if no real repo is cloned
    const repoDir = `/tmp/hive-repos/${enrichingTask.repoId}`;
    if (!existsSync(repoDir)) {
      logger.warn({ taskId, repoId: enrichingTask.repoId }, "Pipeline: repo directory not available, skipping enrichment");
    } else {
      await runEnrichers(enrichingTask, repoDir, enrichers, enricherConfigs);
      logger.info({ taskId }, "Pipeline: enrichment complete");
    }
  } catch (err) {
    logger.error({ taskId, err }, "Pipeline: enrichment failed");
    await failTask(taskId, err);
    return;
  }

  // ── Step 5: Gate evaluation ───────────────────────────────────────────────
  try {
    await evaluateGate(taskId);
    logger.info({ taskId }, "Pipeline: gate evaluation complete");
  } catch (err) {
    logger.error({ taskId, err }, "Pipeline: gate evaluation failed");
    await failTask(taskId, err);
    return;
  }

  // ── Step 6: Execute (if approved) ─────────────────────────────────────────
  const postGateTask = await getById(taskId);
  if (postGateTask && postGateTask.status === "approved") {
    try {
      const { executeTask, executeEpic } = await import("../execution/worker.js");

      let result;
      if (postGateTask.workflow === "epic") {
        result = await executeEpic(taskId);
      } else {
        result = await executeTask(taskId);
      }

      if (!result.success) {
        // executeTask already handled its own status transitions internally;
        // don't call failTask to avoid double-transition.
        logger.warn({ taskId, error: result.error }, "Pipeline: execution returned failure");
        return;
      }

      logger.info({ taskId }, "Pipeline: execution complete");
    } catch (err) {
      // Only call failTask if executeTask threw (didn't handle the failure itself)
      logger.error({ taskId, err }, "Pipeline: execution failed unexpectedly");
      await failTask(taskId, err);
      return;
    }
  }

  logger.info({ taskId }, "Pipeline: completed successfully");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Transitions a task to 'failed' status with a failure reason.
 * Silently catches errors from the transition itself to avoid masking
 * the original error.
 */
async function failTask(taskId: string, err: unknown): Promise<void> {
  const reason =
    err instanceof Error ? err.message : String(err);

  try {
    await updateStatus(taskId, "failed");
  } catch (transitionErr) {
    // The task may already be in a state that can't transition to failed.
    // Log but don't throw — the original error is more important.
    logger.error(
      { taskId, transitionErr },
      "Pipeline: could not transition task to failed",
    );
  }

  // Update failure reason directly (updateStatus doesn't set it)
  try {
    await db
      .update(tasks)
      .set({ failureReason: reason, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
  } catch (updateErr) {
    logger.error(
      { taskId, updateErr },
      "Pipeline: could not set failure reason",
    );
  }
}
