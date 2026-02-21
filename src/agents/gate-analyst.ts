import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { createLearning, buildDismissedContext } from "../db/queries/learnings.js";
import { recordEvent } from "../db/queries/learning-events.js";
import { db } from "../db/connection.js";
import { gateDecisions } from "../db/schema.js";
import { desc, sql } from "drizzle-orm";

const GATE_ANALYST_SYSTEM_PROMPT = `You are a gate decision pattern analyst. You look at recent gate decisions (approve/reject verdicts and their reasoning) to identify recurring patterns.

Your goal: find anti-patterns — common reasons tasks are being rejected — and propose learnings that can help future tasks avoid these pitfalls.

Given recent gate decisions, identify patterns where similar rejection reasons appear 3+ times.
For each pattern found, propose a learning.

Scope rules:
- Use "universal" for patterns that apply across all repos.
- Use "repo:<owner/name>" (matching the repo in the input) for patterns specific to one repo.

Respond with JSON:
\`\`\`json
{
  "patterns": [
    {
      "description": "Brief description of the pattern",
      "occurrences": <number>,
      "learning": {
        "scope": "universal or repo:<owner/name>",
        "category": "anti-pattern",
        "content": "Actionable advice to avoid this pattern",
        "tags": ["gate", "rejection"],
        "confidence": 0.50
      }
    }
  ]
}
\`\`\`

If no clear patterns are found, return an empty patterns array.
Only propose learnings for patterns with 3+ occurrences.
Never propose learnings that are semantically equivalent to any dismissed learning listed in the input.`;

interface GateAnalystResult {
  patterns: {
    description: string;
    occurrences: number;
    learning: {
      scope: string;
      category: string;
      content: string;
      tags: string[];
      confidence: number;
    };
  }[];
}

function parseGateAnalystResult(text: string): GateAnalystResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned);

  return {
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
  };
}

/**
 * Analyzes recent gate decisions for patterns of repeated rejections.
 * If patterns found, proposes anti-pattern learnings.
 */
export async function analyzeGatePatterns(
  taskId: string,
  verdict: string,
  reasoning: string,
  repoFullName?: string,
): Promise<void> {
  const model = getModelFor("gate-analyst");

  try {
    // Load recent gate decisions (last 50)
    const recentDecisions = await db
      .select()
      .from(gateDecisions)
      .orderBy(desc(gateDecisions.createdAt))
      .limit(50);

    // Only analyze if we have enough data
    if (recentDecisions.length < 5) {
      logger.debug("Gate-analyst: not enough decisions to analyze");
      return;
    }

    // Count rejections
    const rejections = recentDecisions.filter((d) => d.verdict === "reject" || d.verdict === "rejected");
    if (rejections.length < 3) {
      logger.debug("Gate-analyst: not enough rejections to analyze patterns");
      return;
    }

    const decisionsSummary = recentDecisions
      .map(
        (d) =>
          `[${d.verdict}] task=${d.taskId} reasoning=${d.reasoning ?? "(none)"}`,
      )
      .join("\n");

    const dismissedContext = await buildDismissedContext();

    const userPrompt = [
      `## Current Decision`,
      `Task: ${taskId}`,
      ...(repoFullName ? [`Repo: ${repoFullName}`] : []),
      `Verdict: ${verdict}`,
      `Reasoning: ${reasoning}`,
      ``,
      `## Recent Gate Decisions (${recentDecisions.length} total, ${rejections.length} rejections)`,
      ``,
      decisionsSummary,
      dismissedContext,
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: GATE_ANALYST_SYSTEM_PROMPT,
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const result = parseGateAnalystResult(response.text);

    // Create learnings for identified patterns
    for (const pattern of result.patterns) {
      const learning = await createLearning({
        scope: pattern.learning.scope,
        category: pattern.learning.category,
        content: pattern.learning.content,
        confidence: pattern.learning.confidence,
        tags: pattern.learning.tags,
        sourceTaskIds: [taskId],
      });
      await recordEvent({
        learningId: learning.id,
        eventType: "created",
        taskId,
        evidence: `Gate-analyst: ${pattern.description} (${pattern.occurrences} occurrences)`,
      });
    }

    logger.info(
      {
        taskId,
        patternsFound: result.patterns.length,
        learningsCreated: result.patterns.length,
        costUsd,
      },
      "Gate-analyst complete",
    );
  } catch (err) {
    logger.error({ taskId, err }, "Gate-analyst: analysis failed");
  }
}
