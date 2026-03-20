import logger from "../logger.js";
import { callClaudeWithTools } from "./sdk.js";
import { loadPrompt } from "../prompt-cache.js";
import { getById } from "../db/queries/tasks.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { REVIEW_TOOLS, createWorktreeToolExecutor } from "../execution/worker-tools.js";
import type { ReviewGateResult } from "../domain/types.js";
import type { ArchitectBlueprint } from "../enrichers/architect.js";

/**
 * Refines a task for rework based on review feedback.
 * Uses read-only tool access to inspect the actual code and produce
 * specific, actionable retry instructions.
 * Updates the task's retryInstructions, reworkCount, and reworkHistory.
 * Returns the refined instructions.
 */
export async function refineTask(
  taskId: string,
  reviewResult: ReviewGateResult,
): Promise<string> {
  const startTime = Date.now();
  const model = getModelFor("refiner");

  await register(taskId, "refiner", model, "refining");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const findingsSummary = reviewResult.findings
      .map(f => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`)
      .join("\n");

    const securitySummary = reviewResult.securityFindings
      .map(f => `- [${f.severity}] ${f.type}: ${f.description}${f.file ? ` (${f.file})` : ""}`)
      .join("\n");

    // Extract scope context from architect blueprint + review result
    const enrichment = task.enrichment as Record<string, unknown> | null;
    const architect = enrichment?.architect as ArchitectBlueprint | undefined;
    let expectedFiles: string[] = [];
    if (architect && !architect.skipped) {
      if (architect.milestones?.length) {
        const set = new Set<string>();
        for (const ms of architect.milestones) {
          for (const f of ms.filesToModify) set.add(f);
        }
        expectedFiles = [...set];
      } else if (architect.keyFiles?.length) {
        expectedFiles = architect.keyFiles;
      }
    }
    const changedFiles = reviewResult.changedFiles ?? [];
    const outOfScope = changedFiles.filter(f => !expectedFiles.includes(f));

    const scopeSections: string[] = [];
    if (changedFiles.length > 0) {
      scopeSections.push(`## Changed Files`, changedFiles.map(f => `- ${f}`).join("\n"), ``);
    }
    if (expectedFiles.length > 0) {
      scopeSections.push(`## Expected File Scope`, expectedFiles.map(f => `- ${f}`).join("\n"), ``);
    }
    if (outOfScope.length > 0) {
      scopeSections.push(`## Out-of-scope Files`, outOfScope.map(f => `- ${f}`).join("\n"), ``);
    }

    const userPrompt = [
      `## Task: ${task.title}`,
      ``,
      task.body,
      ``,
      `## Review Findings`,
      findingsSummary || "(none)",
      ``,
      `## Security Findings`,
      securitySummary || "(none)",
      ``,
      ...scopeSections,
      task.retryInstructions ? `## Previous Retry Instructions\n${task.retryInstructions}` : "",
      ``,
      `## Rework Cycle: ${(task.reworkCount ?? 0) + 1}`,
      ``,
      `You have read-only access to the codebase via read_file and list_directory.`,
      `Use them to inspect the actual code referenced in findings so you can produce`,
      `specific, line-level retry instructions (e.g. "change line 42 from X to Y").`,
      ``,
      `Produce refined instructions that address the review feedback above.`,
    ].filter(Boolean).join("\n");

    // Use agentic loop with read-only tools so the refiner can inspect actual code
    const worktreePath = task.worktreePath;
    const hasWorktree = !!worktreePath;

    let refinedInstructions: string;
    let costUsd: number;
    let turnCount: number;

    if (hasWorktree) {
      const response = await callClaudeWithTools({
        prompt: userPrompt,
        model,
        systemPrompt: loadPrompt("refiner"),
        tools: REVIEW_TOOLS,
        executeTool: createWorktreeToolExecutor(worktreePath!, undefined, undefined, { readOnly: true }),
        maxTurns: 5,
      });
      costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
      turnCount = response.turns;
      refinedInstructions = response.text.trim();
    } else {
      // No worktree available — fall back to non-agentic call
      const { callClaude } = await import("./sdk.js");
      const response = await callClaude({
        prompt: userPrompt,
        model,
        systemPrompt: loadPrompt("refiner"),
      });
      costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
      turnCount = 1;
      refinedInstructions = response.text.trim();
    }

    const durationMs = Date.now() - startTime;

    // Update task: retryInstructions, reworkCount, reworkHistory
    const currentHistory = (task.reworkHistory as Array<Record<string, unknown>>) ?? [];
    const newHistory = [
      ...currentHistory,
      {
        cycle: (task.reworkCount ?? 0) + 1,
        findings: reviewResult.findings,
        securityFindings: reviewResult.securityFindings,
        refinedInstructions,
        timestamp: new Date().toISOString(),
        ...(reviewResult.reviewHeadSha ? { reviewHeadSha: reviewResult.reviewHeadSha } : {}),
      },
    ];

    await db
      .update(tasks)
      .set({
        retryInstructions: refinedInstructions,
        reworkCount: (task.reworkCount ?? 0) + 1,
        reworkHistory: newHistory,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    await recordCost(taskId, task.createdBy, "refiner", model, costUsd, turnCount, durationMs);

    logger.info({ taskId, reworkCount: (task.reworkCount ?? 0) + 1, costUsd, turns: turnCount }, "Task refined");

    return refinedInstructions;
  } finally {
    await unregister(taskId);
  }
}
