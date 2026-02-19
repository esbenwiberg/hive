import { eq } from "drizzle-orm";
import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { getById as getTask, updateStatus } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";
import { recordCost, checkBudget } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { retrieveRelevantLearnings } from "../db/queries/learnings.js";
import { createWorktree, cleanupWorktree, resolveGitCredentials } from "./worktree.js";
import { getGitProvider } from "./git-provider.js";
import { reviewChanges } from "./review-gate.js";
import { refineTask } from "../agents/refiner.js";
import { parseHiveYaml } from "../hive-yaml.js";
import { previewManager } from "./preview/manager.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { loadPrompt } from "../prompt-cache.js";
import type { WorkerResult, WorktreeInfo } from "../domain/types.js";

const MAX_REWORK_CYCLES = 2;

function getFlowPrompt(): string {
  return loadPrompt("flow");
}

/**
 * Executes a single flow task: creates worktree, runs Claude agent, reviews, pushes PR.
 * Handles rework cycles up to MAX_REWORK_CYCLES.
 */
export async function executeTask(taskId: string): Promise<WorkerResult> {
  const startTime = Date.now();
  const config = getAutonomousConfig();

  // Load task and repo
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const repo = await getRepo(task.repoId);
  if (!repo) throw new Error(`Repo ${task.repoId} not found for task ${taskId}`);

  // Check budget
  const remaining = await checkBudget(task.createdBy);
  if (remaining <= 0) {
    throw new Error(`Budget exhausted for user ${task.createdBy}`);
  }

  // Fallback to gate model when no task-specific model is configured
  const model = task.model ?? config.models.gate;
  const branchName = `hive/${taskId}`;
  let worktree: WorktreeInfo | undefined;

  // Register first so if it fails, task status hasn't changed yet
  await register(taskId, "worker", model, "executing");

  // Transition to executing
  await updateStatus(taskId, "executing");

  try {
    // Create worktree
    worktree = await createWorktree(
      repo.fullName,
      repo.provider,
      branchName,
      repo.defaultBranch ?? "main",
      task.createdBy,
    );

    // Retrieve relevant learnings for this task (non-blocking — failures degrade gracefully)
    let learningIds: number[] = [];
    let relevantLearnings: Awaited<ReturnType<typeof retrieveRelevantLearnings>> = [];
    try {
      const enrichmentTags: string[] = [];
      if (task.type) enrichmentTags.push(task.type);
      if (task.severity) enrichmentTags.push(task.severity);

      relevantLearnings = await retrieveRelevantLearnings({
        scopes: ["universal", `repo:${repo.fullName}`],
        tags: enrichmentTags.length > 0 ? enrichmentTags : ["general"],
        limit: 15,
      });

      learningIds = relevantLearnings.map((l) => l.id);
    } catch (learningsErr) {
      logger.warn({ taskId, err: learningsErr }, "Failed to retrieve learnings — proceeding without");
    }

    let learningsStr = "";
    if (relevantLearnings.length > 0) {
      const items = relevantLearnings
        .map((l) => `- [confidence: ${l.confidence}] (${l.scope}) ${l.content}`)
        .join("\n");
      learningsStr = `\n## Relevant Learnings\n\nThese learnings come from past tasks. Apply them where relevant:\n\n${items}`;
    }

    // Build prompt for Claude
    const enrichmentStr = task.enrichment
      ? `\n## Enrichment Context\n${JSON.stringify(task.enrichment, null, 2)}`
      : "";

    const retryStr = task.retryInstructions
      ? `\n## Retry Instructions (address this feedback)\n${task.retryInstructions}`
      : "";

    const userPrompt = [
      `## Task: ${task.title}`,
      ``,
      task.body,
      enrichmentStr,
      learningsStr,
      retryStr,
      ``,
      `## Working Directory`,
      worktree.path,
      ``,
      `## Branch`,
      branchName,
    ].join("\n");

    // Call Claude (the "implementation" step)
    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: getFlowPrompt(),
    });

    const implCostUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const implDurationMs = Date.now() - startTime;
    await recordCost(taskId, task.createdBy, "worker", model, implCostUsd, 1, implDurationMs);

    // Increment execution attempts
    await db
      .update(tasks)
      .set({
        executionAttempts: (task.executionAttempts ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // Transition to reviewing
    await updateStatus(taskId, "reviewing");

    // Run review gate (pass learning IDs for feedback loop)
    const reviewResult = await reviewChanges(taskId, worktree, learningIds);

    if (reviewResult.verdict === "pass") {
      // Push and create PR
      const creds = await resolveGitCredentials(task.createdBy, repo.provider);
      const gitProvider = getGitProvider(repo.provider);

      await gitProvider.commitAll(worktree.path, `${task.title}\n\nTask: ${taskId}`);
      await gitProvider.push(worktree.path, branchName, creds);

      const prUrl = await gitProvider.createPR(
        repo.fullName,
        branchName,
        repo.defaultBranch ?? "main",
        task.title,
        `## Task Description\n\n${task.body}\n\n---\n_Automated by Hive - Task ${taskId}_`,
        creds,
      );

      // Update task with PR URL and transition to done
      await db
        .update(tasks)
        .set({ prUrl, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      await updateStatus(taskId, "done");

      logger.info({ taskId, prUrl }, "Task execution complete — PR created");

      // Attempt to start preview environment if configured
      let previewUrl: string | undefined;
      try {
        const previewConfig = parseHiveYaml(worktree.path);
        const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;
        const repoPreview = (repoSettings.preview ?? {}) as { enabled?: boolean; cleanup_timeout_minutes?: number };
        const previewEnabled = repoPreview.enabled ?? config.preview.enabled;

        if (previewConfig && previewEnabled) {
          const previewInfo = await previewManager.startPreview(taskId, worktree.path, previewConfig);
          previewUrl = `http://${previewInfo.host}:${previewInfo.port}`;
          logger.info({ taskId, previewUrl }, "Preview environment started");

          // Post preview URL as PR comment
          try {
            const timeoutMinutes = repoPreview.cleanup_timeout_minutes ?? config.preview.cleanup_timeout_minutes;
            const comment = [
              `## Preview Environment`,
              ``,
              `A preview environment is available for this PR:`,
              ``,
              `**URL:** ${previewUrl}`,
              ``,
              `_Preview will auto-cleanup when this PR is closed/merged or after ${timeoutMinutes} minutes of inactivity._`,
              ``,
              `---`,
              `_Automated by Hive - Task ${taskId}_`,
            ].join("\n");

            await gitProvider.commentOnPR(repo.fullName, prUrl, comment, creds);
            logger.info({ taskId, prUrl }, "Preview URL posted as PR comment");
          } catch (commentErr) {
            logger.warn({ taskId, err: commentErr }, "Failed to post preview comment on PR — continuing");
          }
        }
      } catch (previewErr) {
        logger.warn({ taskId, err: previewErr }, "Failed to start preview — continuing without");
      }

      return { success: true, prUrl, previewUrl, branch: branchName, reviewResult };
    }

    if (reviewResult.verdict === "rework" && (task.reworkCount ?? 0) < MAX_REWORK_CYCLES) {
      // Transition to rework, refine, and the daemon will re-execute
      await updateStatus(taskId, "rework");
      await refineTask(taskId, reviewResult);

      logger.info({ taskId, reworkCount: (task.reworkCount ?? 0) + 1 }, "Task sent for rework");

      return { success: false, branch: branchName, reviewResult, error: "Sent for rework" };
    }

    // Fail: either verdict is "fail" or max rework exceeded
    const reason = reviewResult.verdict === "fail"
      ? "Review gate failed: critical issues found"
      : `Max rework cycles (${MAX_REWORK_CYCLES}) exceeded`;

    await db
      .update(tasks)
      .set({ failureReason: reason, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await updateStatus(taskId, "failed");

    logger.warn({ taskId, reason }, "Task execution failed");

    return { success: false, branch: branchName, reviewResult, error: reason };

  } catch (err) {
    // On unexpected error, try to transition to failed
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, err }, "Worker: unexpected error");

    try {
      await db
        .update(tasks)
        .set({ failureReason: reason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
    } catch (transitionErr) {
      logger.error({ taskId, transitionErr }, "Worker: could not transition to failed");
    }

    return { success: false, error: reason };
  } finally {
    if (worktree) {
      // Worktree cleanup deferred — preview manager owns cleanup when preview stops.
      const activePreview = previewManager.getPreviewInfo(taskId);
      if (!activePreview) {
        await cleanupWorktree(worktree);
      } else {
        logger.info({ taskId }, "Worktree cleanup deferred — preview is active");
      }
    }
    await unregister(taskId);
  }
}

/**
 * Executes an epic task: decomposes into milestones and creates child tasks.
 */
export async function executeEpic(taskId: string): Promise<WorkerResult> {
  // Import here to avoid circular dependency
  const { decomposeEpic } = await import("../agents/decomposer.js");

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.workflow !== "epic") throw new Error(`Task ${taskId} is not an epic`);

  await updateStatus(taskId, "executing");
  await register(taskId, "worker", "system", "decomposing");

  try {
    const milestones = await decomposeEpic(taskId);

    // Create child tasks for each milestone
    const { create: createTask } = await import("../db/queries/tasks.js");

    for (const milestone of milestones) {
      const child = await createTask({
        title: milestone.title,
        body: milestone.body,
        source: `epic:${taskId}`,
        repoId: task.repoId,
        createdBy: task.createdBy,
      });

      // Set epic metadata
      await db
        .update(tasks)
        .set({
          epicId: taskId,
          milestoneIndex: milestone.index,
          milestoneTotal: milestone.total,
          workflow: "flow",
        })
        .where(eq(tasks.id, child.id));
    }

    // Store the decomposition plan
    await db
      .update(tasks)
      .set({
        blueprint: JSON.stringify(milestones),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // State machine requires executing -> reviewing -> done; no actual review for epics
    await updateStatus(taskId, "reviewing");
    await updateStatus(taskId, "done");

    logger.info({ taskId, milestoneCount: milestones.length }, "Epic decomposed into milestones");

    return { success: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await db
        .update(tasks)
        .set({ failureReason: reason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
    } catch {
      // swallow
    }
    return { success: false, error: reason };
  } finally {
    await unregister(taskId);
  }
}
