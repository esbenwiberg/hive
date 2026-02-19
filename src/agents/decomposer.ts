import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getById } from "../db/queries/tasks.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { loadPrompt } from "../prompt-cache.js";
import type { MilestoneSpec } from "../domain/types.js";

function getMilestonePrompt(): string {
  return loadPrompt("milestone");
}

/**
 * Decomposes an epic task into ordered milestones.
 * Returns an array of MilestoneSpec objects.
 */
export async function decomposeEpic(taskId: string): Promise<MilestoneSpec[]> {
  const startTime = Date.now();
  const config = getAutonomousConfig();
  const model = config.models.gate;

  await register(taskId, "decomposer", model, "decomposing");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const enrichmentStr = task.enrichment
      ? `\n## Enrichment Context\n${JSON.stringify(task.enrichment, null, 2)}`
      : "";

    const userPrompt = [
      `## Epic: ${task.title}`,
      ``,
      task.body,
      enrichmentStr,
      ``,
      `Break this epic into ordered milestones.`,
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: getMilestonePrompt(),
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    // Parse response
    const cleaned = response.text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error("Decomposer response is not an array");
    }

    const total = parsed.length;
    const milestones: MilestoneSpec[] = parsed.map((m: Record<string, unknown>, i: number) => ({
      title: String(m.title ?? `Milestone ${i + 1}`),
      body: String(m.body ?? ""),
      index: i,
      total,
    }));

    await recordCost(taskId, task.createdBy, "decomposer", model, costUsd, 1, durationMs);

    logger.info({ taskId, milestoneCount: milestones.length, costUsd }, "Epic decomposed");

    return milestones;
  } finally {
    await unregister(taskId);
  }
}
