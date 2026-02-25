import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { extractJson } from "./sdk.js";
import { getModelFor } from "../domain/autonomous-config.js";
import type { AdvisorReport } from "../domain/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdvisorContext {
  /** Short title of the task. */
  title: string;
  /** Full task body / description. */
  body: string;
  /** Structured enrichment data from the enricher agents (serialised to JSON). */
  enrichment?: Record<string, unknown>;
  /** Repository identifier used for Prism index lookups. */
  repoId?: string;
  /** Skip the LLM call and return a deterministic stub (useful in tests). */
  dryRun?: boolean;
}

// ── Fallback ─────────────────────────────────────────────────────────────────

const FALLBACK_REPORT: AdvisorReport = {
  recommendation: "reject",
  score: 0,
  confidence: 0,
  reasoning: "Failed to parse advisor output",
  flags: [],
  escalate: true,
};

// ── Prism integration (optional) ─────────────────────────────────────────────

/**
 * Attempts to load @prism/core and run a semantic search for the task.
 * Returns a formatted string of results, or null if Prism is unavailable.
 * Never throws — all errors are caught and logged.
 */
async function tryPrismSearch(
  query: string,
  repoId?: string,
): Promise<string | null> {
  if (!repoId) return null;

  try {
    // Dynamic import so the rest of the module loads fine when Prism is absent.
    // @ts-expect-error – @prism/core is an optional peer, not always installed
    const prism = await import("@prism/core");
    const results: Array<{ content: string; filePath: string; score: number }> =
      await prism.search({ query, repoId, limit: 5 });

    if (!results || results.length === 0) return null;

    const formatted = results
      .map(
        (r, i) =>
          `### Result ${i + 1} (score: ${r.score.toFixed(3)}) — ${r.filePath}\n${r.content}`,
      )
      .join("\n\n");

    logger.debug(
      { repoId, resultCount: results.length },
      "Prism search returned results for advisor",
    );
    return formatted;
  } catch (err) {
    // Prism not installed or index not available — silently continue.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "Prism unavailable for advisor (continuing without it)",
    );
    return null;
  }
}

// ── Prompt loader ─────────────────────────────────────────────────────────────

function loadPrompt(): string {
  // Works from both src/ and dist/ after build.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(__dirname, "../../prompts/advisor.md");
  return readFileSync(promptPath, "utf-8");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Runs the advisor agent against an enriched task context.
 *
 * The agent evaluates fit, design quality, and feasibility, then returns an
 * {@link AdvisorReport} with a recommendation, score, confidence, and flags.
 *
 * Low confidence (< 50) always forces `escalate: true`.
 * On any failure the function returns {@link FALLBACK_REPORT} (escalate=true).
 */
export async function runAdvisor(context: AdvisorContext): Promise<AdvisorReport> {
  logger.info({ title: context.title }, "Advisor agent starting");

  // Build the user-facing prompt from the system prompt template + task data.
  let systemPrompt: string;
  try {
    systemPrompt = loadPrompt();
  } catch (err) {
    logger.error({ err }, "Advisor failed to load prompt file");
    return { ...FALLBACK_REPORT, reasoning: "Failed to load advisor prompt file" };
  }

  // Assemble the task context block.
  const enrichmentSection = context.enrichment
    ? `\n\n## Enrichment Data\n\`\`\`json\n${JSON.stringify(context.enrichment, null, 2)}\n\`\`\``
    : "";

  // Optionally fetch Prism semantic search results.
  const prismQuery = `${context.title}\n\n${context.body}`.slice(0, 500);
  const prismResults = await tryPrismSearch(prismQuery, context.repoId);
  const prismSection = prismResults
    ? `\n\n## Prism Semantic Search Results\nThese are the most relevant code/docs snippets found in the repository:\n\n${prismResults}`
    : "";

  const userPrompt = `## Task Title\n${context.title}\n\n## Task Body\n${context.body}${enrichmentSection}${prismSection}`;

  // dryRun shortcut — bypass the LLM and return a deterministic stub.
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

  let rawText: string;
  try {
    const model = getModelFor("advisor");
    const response = await callClaude({
      systemPrompt,
      prompt: userPrompt,
      model,
      maxTokens: 1024,
    });
    rawText = response.text;
    logger.debug({ title: context.title, rawLength: rawText.length }, "Advisor LLM call complete");
  } catch (err) {
    logger.error({ err, title: context.title }, "Advisor LLM call failed");
    return { ...FALLBACK_REPORT, reasoning: "Advisor LLM call failed" };
  }

  // Parse the JSON response, with a safe fallback on any error.
  let parsed: AdvisorReport;
  try {
    const raw = extractJson(rawText) as AdvisorReport;

    // Validate required fields; throw so we land in the catch fallback.
    if (
      !["approve", "redesign", "reject"].includes(raw.recommendation) ||
      typeof raw.score !== "number" ||
      typeof raw.confidence !== "number" ||
      typeof raw.reasoning !== "string"
    ) {
      throw new Error("Missing or invalid fields in advisor JSON response");
    }

    parsed = {
      recommendation: raw.recommendation,
      score: Math.max(0, Math.min(100, raw.score)),
      confidence: Math.max(0, Math.min(100, raw.confidence)),
      reasoning: raw.reasoning,
      flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
      // Enforce escalation rules regardless of what the LLM said.
      escalate:
        raw.confidence < 50 ||
        raw.recommendation === "reject" ||
        raw.score < 30 ||
        Boolean(raw.escalate),
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), title: context.title },
      "Advisor failed to parse LLM JSON response — returning fallback",
    );
    return { ...FALLBACK_REPORT };
  }

  logger.info(
    {
      title: context.title,
      recommendation: parsed.recommendation,
      score: parsed.score,
      confidence: parsed.confidence,
      escalate: parsed.escalate,
    },
    "Advisor agent complete",
  );

  return parsed;
}
