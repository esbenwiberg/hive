import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { loadPrompt } from "../prompt-cache.js";
import { getById } from "../db/queries/tasks.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { ReviewGateResult } from "../domain/types.js";

/**
 * Refines a task for rework based on review feedback.
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
      task.retryInstructions ? `## Previous Retry Instructions\n${task.retryInstructions}` : "",
      ``,
      `## Rework Cycle: ${(task.reworkCount ?? 0) + 1}`,
      ``,
      `Produce refined instructions that address the review feedback above.`,
    ].filter(Boolean).join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: loadPrompt("refiner"),
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    const refinedInstructions = response.text.trim();

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

    await recordCost(taskId, task.createdBy, "refiner", model, costUsd, 1, durationMs);

    logger.info({ taskId, reworkCount: (task.reworkCount ?? 0) + 1, costUsd }, "Task refined");

    return refinedInstructions;
  } finally {
    await unregister(taskId);
  }
}
