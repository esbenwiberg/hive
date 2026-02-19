import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getById } from "../db/queries/tasks.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { reinforceLearning, contradictLearning, createLearning } from "../db/queries/learnings.js";
import { recordEvent } from "../db/queries/learning-events.js";
import { loadPrompt } from "../prompt-cache.js";

// ── Prompt loader ────────────────────────────────────────────────────────────

function getFeedbackPrompt(): string {
  return loadPrompt("feedback-loop");
}

// ── Response parsing ──────────────────────────────────────────────────────────

interface FeedbackResult {
  reinforceIds: number[];
  contradictIds: number[];
  newLearnings: {
    scope: string;
    category: string;
    content: string;
    tags: string[];
    confidence: number;
  }[];
}

function parseFeedbackResult(text: string): FeedbackResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned);

  return {
    reinforceIds: Array.isArray(parsed.reinforceIds) ? parsed.reinforceIds : [],
    contradictIds: Array.isArray(parsed.contradictIds) ? parsed.contradictIds : [],
    newLearnings: Array.isArray(parsed.newLearnings) ? parsed.newLearnings : [],
  };
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyzes the outcome of a task and updates the learning system accordingly.
 * Reinforces effective learnings, contradicts ineffective ones, and creates new learnings.
 */
export async function analyzeFeedback(
  taskId: string,
  verdict: "pass" | "rework" | "fail",
  promptLearningIds: number[],
  reviewFindings?: string,
): Promise<void> {
  const startTime = Date.now();
  const config = getAutonomousConfig();
  const model = config.models.gate;

  await register(taskId, "feedback-loop", model, "analyzing");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const userPrompt = [
      `## Task: ${task.title}`,
      ``,
      task.body,
      ``,
      `## Verdict: ${verdict}`,
      ``,
      `## Injected Learning IDs`,
      promptLearningIds.length > 0 ? promptLearningIds.join(", ") : "(none)",
      ``,
      `## Review Findings`,
      reviewFindings || "(none)",
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: getFeedbackPrompt(),
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    const result = parseFeedbackResult(response.text);

    // Reinforce learnings that helped
    for (const id of result.reinforceIds) {
      await reinforceLearning(id, taskId);
      await recordEvent({ learningId: id, eventType: "reinforced", taskId, evidence: `Verdict: ${verdict}` });
    }

    // Contradict learnings that didn't help
    const contradictAmount = verdict === "fail" ? 0.10 : 0.05;
    for (const id of result.contradictIds) {
      await contradictLearning(id, taskId, contradictAmount);
      await recordEvent({ learningId: id, eventType: "contradicted", taskId, evidence: `Verdict: ${verdict}` });
    }

    // Create new learnings
    for (const nl of result.newLearnings) {
      const learning = await createLearning({
        scope: nl.scope,
        category: nl.category,
        content: nl.content,
        confidence: nl.confidence,
        tags: nl.tags,
        sourceTaskIds: [taskId],
      });
      await recordEvent({ learningId: learning.id, eventType: "created", taskId, evidence: `Verdict: ${verdict}` });
    }

    await recordCost(taskId, task.createdBy, "feedback-loop", model, costUsd, 1, durationMs);

    logger.info(
      {
        taskId,
        verdict,
        reinforced: result.reinforceIds.length,
        contradicted: result.contradictIds.length,
        newLearnings: result.newLearnings.length,
        costUsd,
      },
      "Feedback loop complete",
    );
  } finally {
    await unregister(taskId);
  }
}

// ── Fire-and-forget wrapper ───────────────────────────────────────────────────

/**
 * Lightweight wrapper that calls analyzeFeedback but catches and logs errors.
 * Never throws — safe to call as fire-and-forget.
 */
export function fireAndForgetFeedback(
  taskId: string,
  verdict: "pass" | "rework" | "fail",
  learningIds: number[],
  reviewFindings?: string,
): void {
  analyzeFeedback(taskId, verdict, learningIds, reviewFindings).catch((err) => {
    logger.error({ taskId, verdict, err }, "Feedback loop failed (non-blocking)");
  });
}
