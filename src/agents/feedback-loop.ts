import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getById } from "../db/queries/tasks.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { reinforceLearning, contradictLearning, createLearning, buildDismissedContext } from "../db/queries/learnings.js";
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

/**
 * Extracts the first JSON object or array from a raw string.
 * Handles markdown code fences, leading/trailing text, and mixed content.
 * Returns the raw string unchanged if no clear JSON boundaries are found.
 */
export function extractJson(raw: string): string {
  // Strip markdown code fences first (```json ... ``` or ``` ... ```)
  const fenceStripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // Find the outermost JSON object or array by locating the first { or [
  // and then scanning for the matching closing bracket.
  const firstBrace = fenceStripped.indexOf("{");
  const firstBracket = fenceStripped.indexOf("[");

  let openChar: string;
  let closeChar: string;
  let startIdx: number;

  if (firstBrace === -1 && firstBracket === -1) {
    // No JSON structure found — return as-is and let JSON.parse fail naturally
    return fenceStripped;
  } else if (firstBrace === -1) {
    openChar = "[";
    closeChar = "]";
    startIdx = firstBracket;
  } else if (firstBracket === -1) {
    openChar = "{";
    closeChar = "}";
    startIdx = firstBrace;
  } else {
    // Use whichever comes first
    if (firstBrace < firstBracket) {
      openChar = "{";
      closeChar = "}";
      startIdx = firstBrace;
    } else {
      openChar = "[";
      closeChar = "]";
      startIdx = firstBracket;
    }
  }

  // Walk forward counting nesting depth to find the matching closing bracket
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let endIdx = -1;

  for (let i = startIdx; i < fenceStripped.length; i++) {
    const ch = fenceStripped[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    // Unbalanced structure — return fence-stripped text and let JSON.parse handle it
    return fenceStripped;
  }

  return fenceStripped.slice(startIdx, endIdx + 1);
}

const EMPTY_FEEDBACK_RESULT: FeedbackResult = {
  reinforceIds: [],
  contradictIds: [],
  newLearnings: [],
};

function parseFeedbackResult(text: string): FeedbackResult {
  try {
    const jsonStr = extractJson(text);
    const parsed = JSON.parse(jsonStr);

    return {
      reinforceIds: Array.isArray(parsed.reinforceIds) ? parsed.reinforceIds : [],
      contradictIds: Array.isArray(parsed.contradictIds) ? parsed.contradictIds : [],
      newLearnings: Array.isArray(parsed.newLearnings) ? parsed.newLearnings : [],
    };
  } catch (err) {
    logger.warn(
      { err, rawPreview: text.slice(0, 200) },
      "feedback-loop: failed to parse JSON response — skipping learning updates",
    );
    return EMPTY_FEEDBACK_RESULT;
  }
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
  const model = getModelFor("feedback-loop");

  await register(taskId, "feedback-loop", model, "analyzing");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const dismissedContext = await buildDismissedContext();

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
      dismissedContext,
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
