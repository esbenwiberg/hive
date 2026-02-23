import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import logger from "../logger.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { getById, updateStatus, updateEnrichment } from "../db/queries/tasks.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { routeTask } from "./router.js";
import { evaluateGate } from "./gate.js";
import { callClaude } from "./sdk.js";
import { runEnrichers } from "../enrichers/base.js";
import { ALL_ENRICHERS } from "../enrichers/index.js";
import { architectEnricher } from "../enrichers/architect.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { resolveGitCredentials } from "../execution/worktree.js";
import { getGitProvider } from "../execution/git-provider.js";
import { addEvent } from "../db/queries/task-events.js";
import type { EnricherConfig } from "../enrichers/base.js";
import type { ArchitectBlueprint } from "../enrichers/architect.js";

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
    const routed = await getById(taskId);
    await addEvent(taskId, "route_complete", "router", `Routed: type=${routed?.type ?? "unknown"}, size=${routed?.size ?? "unknown"}`);
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
    // Build enricher config from per-repo settings (default: disabled)
    const enricherConfigs: Record<string, EnricherConfig> = {};
    for (const e of ALL_ENRICHERS) {
      enricherConfigs[e.name] = { enabled: false };
    }

    const taskForRepo = await getById(taskId);
    if (taskForRepo) {
      const repo = await getRepoById(taskForRepo.repoId);
      if (repo) {
        const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;
        const repoEnrichers = (repoSettings.enrichers ?? {}) as Record<string, { enabled?: boolean }>;
        for (const [name, entry] of Object.entries(repoEnrichers)) {
          if (enricherConfigs[name] && entry.enabled) {
            enricherConfigs[name].enabled = true;
          }
        }
      }
    }

    const enrichers = ALL_ENRICHERS.filter((e) => enricherConfigs[e.name]?.enabled);

    // Reload task to get latest state after routing
    const enrichingTask = await getById(taskId);
    if (!enrichingTask) {
      throw new Error(`Pipeline: task ${taskId} disappeared during enrichment`);
    }

    // Clone the repo for enrichment if not already available
    const repoDir = `/tmp/hive-repos/${enrichingTask.repoId}`;
    let clonedForEnrichment = false;
    if (!existsSync(repoDir)) {
      const repo = await getRepoById(enrichingTask.repoId);
      if (repo) {
        try {
          await mkdir("/tmp/hive-repos", { recursive: true });
          const creds = await resolveGitCredentials(enrichingTask.createdBy, repo.provider);
          const gitProvider = getGitProvider(repo.provider);
          await gitProvider.clone(
            repo.fullName,
            repoDir,
            repo.defaultBranch ?? "main",
            creds,
            { depth: 1 },
          );
          clonedForEnrichment = true;
          logger.info({ taskId, repoId: enrichingTask.repoId }, "Pipeline: cloned repo for enrichment");
        } catch (cloneErr) {
          logger.warn({ taskId, repoId: enrichingTask.repoId, err: cloneErr }, "Pipeline: failed to clone repo, skipping enrichment");
        }
      } else {
        logger.warn({ taskId, repoId: enrichingTask.repoId }, "Pipeline: repo not found in DB, skipping enrichment");
      }
    }

    if (existsSync(repoDir)) {
      await addEvent(taskId, "enrichment_started", "pipeline", `Starting enrichment (${enrichers.length} enrichers)`);
      await runEnrichers(enrichingTask, repoDir, enrichers, enricherConfigs);
      await addEvent(taskId, "enrichment_complete", "pipeline", "Enrichment complete");
      logger.info({ taskId }, "Pipeline: enrichment complete");
    }
  } catch (err) {
    logger.error({ taskId, err }, "Pipeline: enrichment failed");
    await failTask(taskId, err);
    return;
  }

  // ── Step 4b: Clarification check ────────────────────────────────────────
  try {
    const postEnrichTask = await getById(taskId);
    if (!postEnrichTask) {
      throw new Error(`Pipeline: task ${taskId} disappeared after enrichment`);
    }

    const enrichment = (postEnrichTask.enrichment ?? {}) as Record<string, unknown>;
    const architect = enrichment.architect as ArchitectBlueprint | undefined;

    // Propagate architect's skipPreview recommendation to task column
    if (architect?.skipPreview === true) {
      await db.update(tasks).set({ skipPreview: true, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    }

    if (architect?.awaitingInput) {
      const config = getAutonomousConfig();
      const clarificationMode = config.clarification.mode;
      const taskSize = postEnrichTask.size ?? "medium";

      // Determine how many clarification rounds are allowed for this task size.
      // Large tasks may have up to 2 rounds; small/medium/trivial tasks only 1.
      const maxRounds = taskSize === "large" ? 2 : 1;
      const currentRound = (architect.clarificationRound ?? 0) + 1;

      logger.info(
        { taskId, clarificationMode, taskSize, clarificationRound: currentRound, maxRounds },
        "Pipeline: architect requesting clarification",
      );

      if (clarificationMode === "human") {
        if (currentRound > maxRounds) {
          // Exceeded the allowed clarification rounds — force blueprint by clearing awaitingInput
          logger.warn(
            { taskId, currentRound, maxRounds },
            "Pipeline: max clarification rounds reached, forcing blueprint generation",
          );
          const updatedArchitect = { ...architect, awaitingInput: false };
          const updatedEnrichment = { ...enrichment, architect: updatedArchitect };
          await updateEnrichment(taskId, updatedEnrichment);
        } else {
          // Transition to "ready" so the dashboard shows questions for human review
          await updateStatus(taskId, "ready");
          logger.info(
            { taskId, clarificationRound: currentRound },
            "Pipeline: paused for human clarification (status → ready)",
          );
          return;
        }
      } else if (clarificationMode === "ai") {
        // AI answers the questions, then re-runs architect
        await handleAiClarification(postEnrichTask, enrichment, architect, currentRound, maxRounds);
      } else {
        // "auto" mode: skip clarification for trivial/small, AI-answer for medium/large
        if (taskSize === "trivial" || taskSize === "small") {
          // Clear questions and proceed without answers
          const updatedArchitect = { ...architect, awaitingInput: false };
          const updatedEnrichment = { ...enrichment, architect: updatedArchitect };
          await updateEnrichment(taskId, updatedEnrichment);
          logger.info({ taskId }, "Pipeline: auto-mode skipping clarification for small/trivial task");
        } else {
          // Medium/large: AI answers
          await handleAiClarification(postEnrichTask, enrichment, architect, currentRound, maxRounds);
        }
      }
    }
  } catch (err) {
    logger.error({ taskId, err }, "Pipeline: clarification check failed");
    await failTask(taskId, err);
    return;
  }

  // ── Step 5: Gate evaluation ───────────────────────────────────────────────
  try {
    await evaluateGate(taskId);
    const gatedTask = await getById(taskId);
    await addEvent(taskId, "gate_complete", "gate", `Gate verdict: ${gatedTask?.gateVerdict ?? "unknown"}`);
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
 * Uses Claude to answer the architect's clarification questions, then re-runs
 * the architect enricher with the answers so it can produce a full blueprint.
 *
 * @param currentRound - The 1-based clarification round number being processed.
 * @param maxRounds    - Maximum rounds allowed for this task size (1 for small/medium, 2 for large).
 */
async function handleAiClarification(
  task: { id: string; title: string; body: string; size: string | null; repoId: number; enrichment: unknown },
  enrichment: Record<string, unknown>,
  architect: ArchitectBlueprint,
  currentRound: number = 1,
  maxRounds: number = 1,
): Promise<void> {
  const questions = architect.clarificationQuestions ?? [];
  if (questions.length === 0) {
    logger.warn({ taskId: task.id }, "Pipeline: awaitingInput but no questions found");
    return;
  }

  // Build a prompt asking Claude to answer the clarification questions
  const prompt = [
    "You are helping plan an engineering task. The architect enricher has asked the following clarification questions.",
    "Please answer each question concisely based on the task context provided.",
    "",
    "Task title: " + task.title,
    "Task body: " + task.body,
    "Task size: " + (task.size ?? "medium"),
    "",
    "Existing enrichment data:",
    JSON.stringify(enrichment, null, 2),
    "",
    "Questions to answer:",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "Respond with a JSON array of strings, one answer per question. Example: [\"answer1\", \"answer2\"]",
  ].join("\n");

  const model = getModelFor("clarification");

  const response = await callClaude({ prompt, model });

  // Parse answers from response
  let answers: string[];
  try {
    const cleaned = response.text
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    answers = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    // If parsing fails, use the raw text as a single answer
    answers = [response.text.trim()];
    logger.warn({ taskId: task.id }, "Pipeline: could not parse AI clarification answers as JSON, using raw text");
  }

  logger.info(
    { taskId: task.id, questionCount: questions.length, answerCount: answers.length },
    "Pipeline: AI answered clarification questions",
  );

  // Store answers in enrichment. Include the current round so the architect prompt
  // can adjust its instructions accordingly (e.g. force blueprint on final round).
  const updatedArchitect = {
    ...architect,
    clarificationAnswers: answers,
    clarificationRound: currentRound,
    awaitingInput: false,
  };
  const updatedEnrichment = { ...enrichment, architect: updatedArchitect };
  await updateEnrichment(task.id, updatedEnrichment);

  // Re-run the architect enricher with the updated enrichment
  const reloadedTask = await getById(task.id);
  if (!reloadedTask) {
    throw new Error(`Pipeline: task ${task.id} disappeared during AI clarification`);
  }

  const repoDir = `/tmp/hive-repos/${reloadedTask.repoId}`;
  const architectConfig: EnricherConfig = { enabled: true };

  const result = await architectEnricher.run(
    reloadedTask,
    repoDir,
    updatedEnrichment,
    architectConfig,
  );

  // Merge the re-run result back into enrichment
  const reRunArchitect = result.data?.architect as ArchitectBlueprint | undefined;

  if (reRunArchitect?.awaitingInput && currentRound < maxRounds) {
    // The architect still wants more clarification, and we have rounds remaining.
    // Preserve the round counter so the next pass treats this as a follow-up round.
    logger.info(
      { taskId: task.id, completedRound: currentRound, maxRounds },
      "Pipeline: architect requesting follow-up clarification after round answers",
    );
    const roundTrackedArchitect = {
      ...reRunArchitect,
      clarificationRound: currentRound,
    };
    const finalEnrichment = { ...updatedEnrichment, ...result.data, architect: roundTrackedArchitect };
    await updateEnrichment(task.id, finalEnrichment);
  } else {
    if (reRunArchitect?.awaitingInput && currentRound >= maxRounds) {
      // Exhausted rounds — force blueprint generation
      logger.warn(
        { taskId: task.id, currentRound, maxRounds },
        "Pipeline: max clarification rounds reached after re-run, forcing blueprint generation",
      );
      const forcedArchitect = { ...reRunArchitect, awaitingInput: false };
      const finalEnrichment = { ...updatedEnrichment, ...result.data, architect: forcedArchitect };
      await updateEnrichment(task.id, finalEnrichment);
    } else {
      const finalEnrichment = { ...updatedEnrichment, ...result.data };
      await updateEnrichment(task.id, finalEnrichment);
    }
  }

  logger.info({ taskId: task.id, completedRound: currentRound }, "Pipeline: architect re-run after AI clarification complete");
}

/**
 * Transitions a task to 'failed' status with a failure reason.
 * Silently catches errors from the transition itself to avoid masking
 * the original error.
 */
async function failTask(taskId: string, err: unknown): Promise<void> {
  const reason =
    err instanceof Error ? err.message : String(err);

  try {
    await addEvent(taskId, "error", "pipeline", `Pipeline failed: ${reason}`);
  } catch {
    // Best effort — don't let event logging block status transition
  }

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
