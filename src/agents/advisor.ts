import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { extractJson } from "./sdk.js";
import { getModelFor, getAutonomousConfig } from "../domain/autonomous-config.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { insertAdvisorReport } from "../db/queries/tasks.js";
import { addAdvisorEvent } from "../db/queries/task-events.js";
import { estimateCostUsd } from "./cost-utils.js";
import type { AdvisorReport } from "../domain/types.js";

// ── Default Prompt ──────────────────────────────────────────────────────────

const DEFAULT_ADVISOR_PROMPT = `You are an expert advisor for a software engineering task orchestration system.
Evaluate the provided task for fit, design quality, feasibility, and architectural alignment.
Return a structured JSON response with your assessment.`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdvisorContext {
  /** Task ID for persistence. */
  taskId?: string;
  /** User ID for cost tracking. */
  userId?: number;
  /** Repository identifier. */
  repo?: string;
  /** Short title of the task. */
  title: string;
  /** Full task body / description. */
  taskBody: string;
  /** Structured enrichment data from the enricher agents. */
  enrichment?: Record<string, unknown>;
  /** Prism semantic search results (if available). */
  prismResults?: string;
  /** Whether to use Prism for this run. */
  usePrism?: boolean;
  /** Skip the LLM call and return a deterministic stub (useful in tests). */
  dryRun?: boolean;
}

// ── Fallback ─────────────────────────────────────────────────────────────────

function fallbackReport(reason: string): AdvisorReport {
  return {
    recommendation: "reject",
    score: 0,
    confidence: 0,
    reasoning: reason,
    flags: [],
    escalate: true,
  };
}

// ── Format helpers ───────────────────────────────────────────────────────────

function formatEnrichment(enrichment?: Record<string, unknown>): string {
  if (!enrichment) return "No enrichment data available";
  return `\`\`\`json\n${JSON.stringify(enrichment, null, 2)}\n\`\`\``;
}

function formatPrismResults(results: string): string {
  if (!results) return "";
  // Results are already formatted from tryPrismSearch
  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Runs the advisor agent against an enriched task context.
 *
 * The agent evaluates fit, design quality, and feasibility, then returns an
 * {@link AdvisorReport} with a recommendation, score, confidence, and flags.
 *
 * Low confidence (< confidenceThreshold) always forces `escalate: true`.
 * On any failure the function returns a fallback report (escalate=true).
 */
export async function runAdvisor(context: AdvisorContext): Promise<AdvisorReport> {
  const config = getAutonomousConfig();
  const taskId = context.taskId || "unknown";

  // Early exit if advisor is disabled
  if (!config.advisor.enabled) {
    logger.info("Advisor: disabled in config, skipping");
    return {
      recommendation: "approve",
      score: 50,
      confidence: 0,
      reasoning: "Advisor agent is disabled",
      flags: [],
      escalate: false,
    };
  }

  const model = getModelFor("advisor");

  try {
    // Register this agent as active
    await register(taskId, "advisor", model, "advising").catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn("Advisor: failed to register active agent — " + errorMsg);
    });

    // Load the advisor prompt
    const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../prompts/advisor.md");
    let prompt: string;

    try {
      prompt = readFileSync(promptPath, "utf-8");
    } catch (err) {
      const readErrorMsg = err instanceof Error ? err.message : String(err);
      logger.warn("Advisor: failed to load prompt from file — " + readErrorMsg);
      prompt = DEFAULT_ADVISOR_PROMPT;
    }

    // Prepare context for the LLM
    const enrichmentSummary = formatEnrichment(context.enrichment);
    let prismContext = "";

    if (context.usePrism && context.prismResults) {
      // Sanitize Prism results with untrusted markers
      prismContext = `[UNTRUSTED_CONTEXT_START]\n${context.prismResults}\n[UNTRUSTED_CONTEXT_END]`;
    }

    // Build the user message
    const originalLength = context.taskBody.length;
    const taskBodyPreview = context.taskBody.slice(0, 500);
    if (originalLength > 500) {
      logger.warn("Advisor: task body truncated — original: " + originalLength + ", shown: 500");
    }

    const userMessage = `
## Task Metadata
- **Title:** ${context.title}
- **Type:** ${context.enrichment?.type || "unknown"}
- **Size:** ${context.enrichment?.size || "unknown"}
- **Complexity Score:** ${context.enrichment?.complexityScore || "N/A"}

## Enrichment Data
${enrichmentSummary}

${prismContext ? `## Semantic Code Context (Prism)\n${prismContext}` : ""}

## Task Body (Preview)
${taskBodyPreview}
`;

    // dryRun shortcut
    if (context.dryRun) {
      logger.debug({ title: context.title }, "Advisor dry-run mode — skipping LLM call");
      return {
        recommendation: "approve",
        score: 75,
        confidence: 80,
        reasoning: "[dry-run] Advisor skipped LLM call",
        flags: [],
        escalate: false,
      };
    }

    const startTime = Date.now();

    // Call Claude with proper parameters
    const response = await callClaude({
      model,
      systemPrompt: prompt,
      prompt: userMessage,
      maxTokens: 4000,
    });

    if (!response || !response.text) {
      logger.error("Advisor: no response from LLM");
      return fallbackReport("No response from advisor LLM");
    }

    let report: AdvisorReport;
    try {
      // Sanitize response: strip markdown code fences
      let cleanedResponse = response.text.trim();
      if (cleanedResponse.startsWith("```json")) {
        cleanedResponse = cleanedResponse.slice(7);
      }
      if (cleanedResponse.startsWith("```")) {
        cleanedResponse = cleanedResponse.slice(3);
      }
      if (cleanedResponse.endsWith("```")) {
        cleanedResponse = cleanedResponse.slice(0, -3);
      }
      cleanedResponse = cleanedResponse.trim();

      // Extract and parse JSON
      const parsed = extractJson(cleanedResponse) as unknown;

      // Validate required fields
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !["approve", "redesign", "reject"].includes((parsed as Record<string, unknown>).recommendation as string) ||
        typeof (parsed as Record<string, unknown>).score !== "number" ||
        typeof (parsed as Record<string, unknown>).confidence !== "number" ||
        typeof (parsed as Record<string, unknown>).reasoning !== "string"
      ) {
        throw new Error("Missing or invalid fields in advisor JSON response");
      }

      const parsedData = parsed as Record<string, unknown>;
      report = {
        recommendation: parsedData.recommendation as "approve" | "redesign" | "reject",
        score: Math.max(0, Math.min(100, parsedData.score as number)),
        confidence: Math.max(0, Math.min(100, parsedData.confidence as number)),
        reasoning: String(parsedData.reasoning),
        flags: Array.isArray(parsedData.flags) ? (parsedData.flags as unknown[]).map(String) : [],
        escalate: Boolean(parsedData.escalate),
      };
    } catch (parseError) {
      const parseErrorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      logger.error("Advisor: failed to parse JSON response — " + parseErrorMsg);
      return fallbackReport("Failed to parse advisor response");
    }

    // Apply confidence threshold
    if (report.confidence < config.advisor.confidenceThreshold) {
      logger.info("Advisor: confidence below threshold, escalating — confidence: " + report.confidence + ", threshold: " + config.advisor.confidenceThreshold);
      report.escalate = true;
    }

    // Record cost if we have the necessary info
    const durationMs = Date.now() - startTime;
    const costUsd = estimateCostUsd(
      model,
      response.cost.inputTokens,
      response.cost.outputTokens,
      durationMs
    );

    // Persist the report
    if (taskId && context.userId) {
      try {
        await insertAdvisorReport(taskId, report);
        await addAdvisorEvent(taskId, report);
      } catch (persistError) {
        const persistErrorMsg = persistError instanceof Error ? persistError.message : String(persistError);
        logger.warn("Advisor: failed to persist report — " + persistErrorMsg);
      }
    }

    logger.info("Advisor agent complete — recommendation: " + report.recommendation + ", score: " + report.score + ", confidence: " + report.confidence + ", cost: $" + costUsd.toFixed(4));

    return report;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Advisor: unexpected error — " + errorMsg);
    return fallbackReport("Advisor encountered an error");
  } finally {
    // Unregister this agent
    await unregister(taskId).catch((err) => {
      const unregisterErrorMsg = err instanceof Error ? err.message : String(err);
      logger.warn("Advisor: failed to unregister active agent — " + unregisterErrorMsg);
    });
  }
}
