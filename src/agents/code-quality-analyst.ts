import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { createLearning, buildDismissedContext } from "../db/queries/learnings.js";
import { recordEvent } from "../db/queries/learning-events.js";
import { db } from "../db/connection.js";
import { codeReviews } from "../db/schema.js";
import { desc } from "drizzle-orm";
import type { ReviewFinding } from "../domain/types.js";

const CODE_QUALITY_SYSTEM_PROMPT = `You are a code review pattern analyst. You look at recent code review findings to identify recurring quality issues.

Your goal: find recurring categories of findings (e.g., same finding category appears 3+ times) and propose learnings to help future tasks avoid these issues.

Given recent code review findings and the current task's findings, identify patterns.

Respond with JSON:
\`\`\`json
{
  "patterns": [
    {
      "category": "The recurring finding category",
      "occurrences": <number>,
      "learning": {
        "scope": "universal",
        "category": "code-quality",
        "content": "Actionable advice to avoid this recurring issue",
        "tags": ["review", "quality"],
        "confidence": 0.50
      }
    }
  ]
}
\`\`\`

If no clear patterns are found, return an empty patterns array.
Only propose learnings for patterns with 3+ occurrences.
Never propose learnings that are semantically equivalent to any dismissed learning listed in the input.`;

interface CodeQualityResult {
  patterns: {
    category: string;
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

function parseCodeQualityResult(text: string): CodeQualityResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned);

  return {
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
  };
}

/**
 * Analyzes recent code review findings for recurring categories.
 * If patterns found (e.g., same finding category > 3 times), proposes new learnings.
 */
export async function analyzeReviewPatterns(
  taskId: string,
  findings: ReviewFinding[],
): Promise<void> {
  const config = getAutonomousConfig();
  const model = config.models.gate;

  try {
    // Load recent code reviews (last 30)
    const recentReviews = await db
      .select()
      .from(codeReviews)
      .orderBy(desc(codeReviews.createdAt))
      .limit(30);

    // Only analyze if we have enough data
    if (recentReviews.length < 3) {
      logger.debug("Code-quality-analyst: not enough reviews to analyze");
      return;
    }

    // Extract all findings from recent reviews
    const allFindings: { taskId: string; findings: ReviewFinding[] }[] = recentReviews
      .filter((r) => r.findings != null)
      .map((r) => ({
        taskId: r.taskId,
        findings: r.findings as ReviewFinding[],
      }));

    // Quick check: count categories across all findings
    const categoryCounts = new Map<string, number>();
    for (const review of allFindings) {
      for (const f of review.findings) {
        if (f.category) {
          categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + 1);
        }
      }
    }

    // Only call Claude if any category appears 3+ times
    const hasPatterns = Array.from(categoryCounts.values()).some((c) => c >= 3);
    if (!hasPatterns) {
      logger.debug("Code-quality-analyst: no recurring categories found");
      return;
    }

    // Build summary for Claude
    const currentFindingsStr = findings
      .map((f) => `  [${f.severity}] ${f.category}: ${f.message} (${f.file})`)
      .join("\n");

    const recentFindingsStr = allFindings
      .map(
        (r) =>
          `Task ${r.taskId}:\n` +
          r.findings
            .map((f) => `  [${f.severity}] ${f.category}: ${f.message}`)
            .join("\n"),
      )
      .join("\n\n");

    const categoryCountsStr = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `  ${cat}: ${count} occurrences`)
      .join("\n");

    const dismissedContext = await buildDismissedContext();

    const userPrompt = [
      `## Current Task Findings`,
      `Task: ${taskId}`,
      currentFindingsStr || "(none)",
      ``,
      `## Category Frequency`,
      categoryCountsStr,
      ``,
      `## Recent Review Findings (${recentReviews.length} reviews)`,
      ``,
      recentFindingsStr,
      dismissedContext,
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: CODE_QUALITY_SYSTEM_PROMPT,
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const result = parseCodeQualityResult(response.text);

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
        evidence: `Code-quality-analyst: ${pattern.category} (${pattern.occurrences} occurrences)`,
      });
    }

    logger.info(
      {
        taskId,
        patternsFound: result.patterns.length,
        learningsCreated: result.patterns.length,
        costUsd,
      },
      "Code-quality-analyst complete",
    );
  } catch (err) {
    logger.error({ taskId, err }, "Code-quality-analyst: analysis failed");
  }
}
