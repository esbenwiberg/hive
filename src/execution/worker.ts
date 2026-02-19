import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { getById as getTask, updateStatus } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";
import { recordCost, checkBudget } from "../db/queries/costs.js";
import { register, unregister, heartbeat } from "../db/queries/active-agents.js";
import { addEvent } from "../db/queries/task-events.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { retrieveRelevantLearnings } from "../db/queries/learnings.js";
import { createWorktree, cleanupWorktree, resolveGitCredentials } from "./worktree.js";
import { getGitProvider } from "./git-provider.js";
import { reviewChanges } from "./review-gate.js";
import { reviewFix } from "./milestone-review.js";
import { refineTask } from "../agents/refiner.js";
import { parseHiveYaml } from "../hive-yaml.js";
import { previewManager } from "./preview/manager.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { loadPrompt } from "../prompt-cache.js";
import type { ArchitectBlueprint } from "../enrichers/architect.js";
import type { WorkerResult, WorktreeInfo } from "../domain/types.js";

const MAX_REWORK_CYCLES = 2;

const execFileAsync = promisify(execFile);

function getFlowPrompt(): string {
  return loadPrompt("flow");
}

// ── Milestone helpers ─────────────────────────────────────────────────────────

/**
 * Commits all changes in the worktree for the given milestone.
 * Silently succeeds when there is nothing to commit (empty working tree).
 */
async function commitMilestone(
  worktreePath: string,
  title: string,
  taskId: string,
): Promise<void> {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    await execFileAsync(
      "git",
      ["commit", "-m", `feat: ${title}\n\nTask: ${taskId}`],
      { cwd: worktreePath },
    );
  } catch (err: unknown) {
    // Exit code 1 from `git commit` means "nothing to commit" — that's fine.
    const code = (err as { code?: number }).code;
    if (code !== 1) {
      throw err;
    }
    logger.debug({ worktreePath, title }, "commitMilestone: nothing to commit");
  }
}

/**
 * Executes an architect blueprint milestone-by-milestone:
 *
 * For each milestone:
 *  1. Build a milestone-scoped prompt
 *  2. Call Claude for implementation
 *  3. Run reviewFix (lint/build/test + AI review-fix loop)
 *  4. Commit the milestone
 *  5. Accumulate a summary for subsequent milestones
 */
async function executeMilestones(
  task: { id: string; title: string; body: string },
  worktreePath: string,
  blueprint: ArchitectBlueprint,
  model: string,
  learningsStr: string,
): Promise<{ totalCostUsd: number }> {
  const milestones = blueprint.milestones!;
  let totalCostUsd = 0;
  const priorSummaries: string[] = [];

  for (let i = 0; i < milestones.length; i++) {
    const ms = milestones[i];
    await addEvent(task.id, "milestone_started", "worker", `Milestone ${i + 1}/${milestones.length}: ${ms.title}`);
    await heartbeat(task.id);
    logger.info(
      { taskId: task.id, milestone: i + 1, total: milestones.length, title: ms.title },
      "Starting milestone",
    );

    // ── 1. Build milestone-scoped prompt ──────────────────────────────────
    const sections: string[] = [
      `## Task: ${task.title}`,
      "",
      task.body,
      "",
      `## Overall Approach`,
      blueprint.approach,
      "",
      `## Current Milestone (${i + 1}/${milestones.length}): ${ms.title}`,
      "",
      ms.description,
      "",
      `### Files to Modify`,
      ms.filesToModify.map((f) => `- ${f}`).join("\n"),
      "",
      `### Acceptance Criteria`,
      ms.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
    ];

    if (priorSummaries.length > 0) {
      sections.push(
        "",
        `## Prior Milestones (already committed)`,
        priorSummaries.map((s, idx) => `${idx + 1}. ${s}`).join("\n"),
      );
    }

    if (learningsStr) {
      sections.push(learningsStr);
    }

    sections.push("", `## Working Directory`, worktreePath);

    const milestonePrompt = sections.join("\n");

    const systemPrompt = [
      getFlowPrompt(),
      "",
      "## Milestone Mode",
      "You are implementing a single milestone of a larger task.",
      "Focus exclusively on this milestone's scope.",
      "Only modify listed files unless absolutely necessary.",
      "Previous milestones have already been committed — build on their changes.",
      "Ensure your changes satisfy the milestone's acceptance criteria.",
    ].join("\n");

    // ── 2. Call Claude for implementation ─────────────────────────────────
    await addEvent(task.id, "claude_call_started", "worker", `Calling Claude (${model})`);
    await heartbeat(task.id);

    const response = await callClaude({
      prompt: milestonePrompt,
      model,
      systemPrompt,
    });

    const implCost = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    totalCostUsd += implCost;

    await addEvent(task.id, "claude_call_complete", "worker", `Claude complete (${response.cost.inputTokens}+${response.cost.outputTokens} tokens, $${implCost.toFixed(2)})`, {
      inputTokens: response.cost.inputTokens,
      outputTokens: response.cost.outputTokens,
      costUsd: implCost,
    });
    await heartbeat(task.id);

    // ── 3. Review-fix loop ────────────────────────────────────────────────
    const review = await reviewFix(worktreePath, ms.title, model);
    totalCostUsd += review.costUsd;

    // ── 4. Commit the milestone ───────────────────────────────────────────
    await commitMilestone(worktreePath, ms.title, task.id);

    // ── 5. Accumulate summary ─────────────────────────────────────────────
    priorSummaries.push(`${ms.title} — completed (review ${review.passed ? "passed" : "had issues"})`);

    await addEvent(task.id, "milestone_complete", "worker", `Milestone ${i + 1}/${milestones.length} complete`);
    await heartbeat(task.id);

    logger.info(
      {
        taskId: task.id,
        milestone: i + 1,
        title: ms.title,
        reviewPassed: review.passed,
        milestoneCostUsd: implCost + review.costUsd,
      },
      "Milestone completed",
    );
  }

  return { totalCostUsd };
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
    await addEvent(taskId, "worktree_created", "worker", "Git worktree created");

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

    // Check for architect milestones
    const architectData = (task.enrichment as Record<string, unknown> | null)?.architect as ArchitectBlueprint | undefined;
    const hasMilestones = architectData?.milestones && architectData.milestones.length > 0;

    let implCostUsd: number;
    if (hasMilestones) {
      const { totalCostUsd } = await executeMilestones(task, worktree.path, architectData!, model, learningsStr);
      implCostUsd = totalCostUsd;
    } else {
      // Single-call path (original behavior for tasks without milestones)
      await addEvent(taskId, "claude_call_started", "worker", `Calling Claude (${model})`);
      await heartbeat(taskId);

      const response = await callClaude({
        prompt: userPrompt,
        model,
        systemPrompt: getFlowPrompt(),
      });
      implCostUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);

      await addEvent(taskId, "claude_call_complete", "worker", `Claude complete (${response.cost.inputTokens}+${response.cost.outputTokens} tokens, $${implCostUsd.toFixed(2)})`, {
        inputTokens: response.cost.inputTokens,
        outputTokens: response.cost.outputTokens,
        costUsd: implCostUsd,
      });
      await heartbeat(taskId);
    }
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
    await addEvent(taskId, "review_started", "worker", "Starting code review");
    await heartbeat(taskId);
    const reviewResult = await reviewChanges(taskId, worktree, learningIds);
    await addEvent(taskId, "review_complete", "worker", `Review: ${reviewResult.verdict}`);
    await heartbeat(taskId);

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

      await addEvent(taskId, "pr_created", "worker", "PR created", { prUrl });
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

    if ((task.reworkCount ?? 0) < MAX_REWORK_CYCLES) {
      // Always rework if under max cycles — no terminal "fail" verdict
      await updateStatus(taskId, "rework");
      await refineTask(taskId, reviewResult);

      logger.info({ taskId, reworkCount: (task.reworkCount ?? 0) + 1 }, "Task sent for rework");

      return { success: false, branch: branchName, reviewResult, error: "Sent for rework" };
    }

    // Only fail when max rework cycles exhausted
    const reason = `Max rework cycles (${MAX_REWORK_CYCLES}) exceeded`;

    await addEvent(taskId, "error", "worker", `Failed: ${reason}`);
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
      await addEvent(taskId, "error", "worker", `Execution failed: ${reason}`);
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
