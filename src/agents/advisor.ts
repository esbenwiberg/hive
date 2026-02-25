import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { loadPrompt } from "../prompt-cache.js";
import type { AdvisorVerdictResponse, AdvisorVerdict } from "./types.js";

/**
 * Advisor Agent (Pipeline Stage 4c: ADVISING)
 *
 * Analyzes enriched task data against product context, architecture patterns,
 * and design guidelines. Returns structured verdict with multi-dimensional
 * scoring, confidence score, escalation flag, and recommendations.
 *
 * ============================================================================
 * MANDATORY ESCALATION RULE: confidenceScore < 0.5 ALWAYS escalates to human.
 * This rule is enforced in validation AFTER LLM parsing. No exceptions.
 * ============================================================================
 *
 * Input:
 *   enrichment: TaskEnrichment (enriched task metadata from enrichers)
 *   context: ProductContext (loaded from docs/internal/product-context.md)
 *
 * Output: AdvisorVerdictResponse {
 *   verdict: 'approve' | 'caution' | 'rework',
 *   confidenceScore: [0.0–1.0],
 *   escalate: boolean (true if score < 0.5 OR human judgment needed),
 *   dimensions: Record<string, number> (e.g., productFit, architecturalAlignment),
 *   reasoning: string (explain verdict; max 5000 chars),
 *   recommendations: string[] (actionable suggestions; each < 1000 chars)
 * }
 *
 * Verdict Meanings:
 *   'approve': Task aligns with product goals, fits existing patterns, low risk.
 *   'caution': Task aligns but has risks or prerequisites; recommend review.
 *   'rework': Task conflicts with patterns; recommend redesign.
 *
 * Escalation Examples:
 *   - confidenceScore = 0.3 → escalate = true (mandatory override)
 *   - verdict = 'rework' and task removes core safety feature → escalate = true
 *   - conflicting architectural signals → escalate = true, recommend design review
 *
 * Fallback Verdict (on LLM error or validation failure):
 *   escalate: true (safe default)
 *   confidenceScore: 0.0
 *   verdict: 'rework'
 *   reasoning: "Advisor unavailable or validation failed; escalating to human review."
 *
 * Integration with Gate:
 *   Gate reads enrichment.advisor.escalate. If true, gate MUST escalate to
 *   human review regardless of verdict value or other signals.
 *
 * Security Notes:
 *   - Advisor prompt and product context are loaded from disk; file permissions
 *     must be read-only for this service (document in infrastructure docs).
 *   - LLM response is strictly validated (all required fields, bounded values).
 *   - Validation defaults are fail-closed (invalid → escalate: true).
 *   - Never log raw prompt, product context, or LLM responses (information leak risk).
 */

// ── Input shape (mirrors what the pipeline produces) ───────────────────────

export interface AdvisorInput {
  taskId: string;
  title: string;
  description: string;
  /** Raw output from the router enricher */
  routerClassification?: Record<string, unknown>;
  /** Raw output from the codebase enricher */
  codebaseContext?: Record<string, unknown>;
  /** Raw output from the architect enricher */
  architectBlueprint?: Record<string, unknown>;
  /** Raw output from the scorer enricher */
  scorerOutput?: Record<string, unknown>;
  /** Any additional enrichment blobs */
  extraEnrichment?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads a file from disk, returning its content or a fallback string when missing.
 */
function safeRead(filePath: string, fallback = ""): string {
  try {
    if (!existsSync(filePath)) return fallback;
    return readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

/**
 * Loads the repo-knowledge context: architecture overview + all module docs.
 */
function buildRepoKnowledge(): string {
  const sections: string[] = [];

  const architecturePath = resolve("docs/internal/architecture.md");
  const architecture = safeRead(architecturePath, "");
  if (architecture) {
    sections.push(`## Architecture Overview\n\n${architecture}`);
  }

  const modulesDir = resolve("docs/internal/modules");
  const moduleFiles = [
    "agents.md",
    "auth.md",
    "daemon.md",
    "dashboard.md",
    "database.md",
    "domain.md",
    "execution.md",
    "producers.md",
  ];

  const moduleSections: string[] = [];
  for (const file of moduleFiles) {
    const modulePath = resolve(modulesDir, file);
    const content = safeRead(modulePath, "");
    if (content) {
      const name = file.replace(".md", "");
      moduleSections.push(`### Module: ${name}\n\n${content}`);
    }
  }

  if (moduleSections.length > 0) {
    sections.push(`## Module Documentation\n\n${moduleSections.join("\n\n---\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Serialises a value to pretty JSON, returning "(not available)" on failure.
 */
function toJson(value: unknown): string {
  if (value === undefined || value === null) return "(not available)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Default fallback verdict used when advisor fails validation or LLM call.
 */
const FALLBACK_VERDICT: AdvisorVerdictResponse = {
  escalate: true,
  confidenceScore: 0.0,
  verdict: 'rework',
  dimensions: {},
  reasoning: 'Advisor unavailable or validation failed; escalating to human review.',
  recommendations: []
};

/**
 * Validates and normalizes LLM response to AdvisorVerdictResponse.
 * All validation is fail-closed: invalid → FALLBACK_VERDICT with escalate=true.
 */
function validateAdvisorResponse(parsed: unknown): AdvisorVerdictResponse {
  if (!parsed || typeof parsed !== 'object') {
    return FALLBACK_VERDICT;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate verdict
  const verdict = obj.verdict as string | undefined;
  if (!verdict || !['approve', 'caution', 'rework'].includes(verdict)) {
    return FALLBACK_VERDICT;
  }

  // Validate confidenceScore: must be number in [0, 1]
  const confidenceScore = Number(obj.confidenceScore);
  if (!Number.isFinite(confidenceScore) || confidenceScore < 0 || confidenceScore > 1) {
    return FALLBACK_VERDICT;
  }

  // Validate dimensions: all values must be numbers in [0, 1]
  const dimensions: Record<string, number> = {};
  const dimObj = obj.dimensions as Record<string, unknown> | undefined;
  if (dimObj && typeof dimObj === 'object') {
    for (const [key, val] of Object.entries(dimObj)) {
      const num = Number(val);
      if (Number.isFinite(num) && num >= 0 && num <= 1) {
        dimensions[key] = num;
      } else {
        return FALLBACK_VERDICT;
      }
    }
  }

  // Validate reasoning: string, max 5000 chars
  let reasoning = '';
  if (typeof obj.reasoning === 'string') {
    reasoning = obj.reasoning.slice(0, 5000);
  }

  // Validate recommendations: array of strings, each max 1000 chars
  let recommendations: string[] = [];
  if (Array.isArray(obj.recommendations)) {
    recommendations = obj.recommendations
      .filter((r): r is string => typeof r === 'string')
      .map(r => r.slice(0, 1000));
  }

  const result: AdvisorVerdictResponse = {
    verdict: verdict as AdvisorVerdict,
    confidenceScore,
    escalate: Boolean(obj.escalate),
    dimensions,
    reasoning,
    recommendations
  };

  // MANDATORY: if confidenceScore < 0.5, force escalate = true
  if (result.confidenceScore < 0.5) {
    result.escalate = true;
  }

  return result;
}

/**
 * Parses JSON response from LLM, handling markdown code fences.
 */
function parseAdvisorResponse(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  return JSON.parse(cleaned);
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function runAdvisor(input: AdvisorInput): Promise<AdvisorVerdictResponse> {
  const { taskId } = input;
  const model = getModelFor("advisor");

  logger.info({ taskId, model }, "Advisor: starting evaluation");

  // ── Load static knowledge ────────────────────────────────────────────────

  const systemPrompt = loadPrompt("enrichers/advisor");

  const productContextPath = resolve("docs/internal/product-context.md");
  const productContext = safeRead(
    productContextPath,
    "(product-context.md not found — proceeding without it)",
  );

  const repoKnowledge = buildRepoKnowledge();

  // ── Build user prompt ────────────────────────────────────────────────────

  const userPrompt = [
    "# Task Under Review",
    "",
    `**Task ID:** ${taskId}`,
    `**Title:** ${input.title}`,
    `**Description:**`,
    input.description,
    "",
    "---",
    "",
    "# Product Context",
    "",
    productContext,
    "",
    "---",
    "",
    "# Repo Knowledge",
    "",
    repoKnowledge,
    "",
    "---",
    "",
    "# Enrichment Data",
    "",
    "## Router Classification",
    "```json",
    toJson(input.routerClassification),
    "```",
    "",
    "## Codebase Context",
    "```json",
    toJson(input.codebaseContext),
    "```",
    "",
    "## Architect Blueprint",
    "```json",
    toJson(input.architectBlueprint),
    "```",
    "",
    "## Scorer Output",
    "```json",
    toJson(input.scorerOutput),
    "```",
    ...(input.extraEnrichment
      ? [
          "",
          "## Additional Enrichment",
          "```json",
          toJson(input.extraEnrichment),
          "```",
        ]
      : []),
    "",
    "---",
    "",
    "Evaluate this task and respond with the structured JSON verdict as specified in your instructions.",
  ].join("\n");

  // ── LLM call ─────────────────────────────────────────────────────────────

  let rawText: string;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  try {
    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt,
    });

    rawText = response.text;
    inputTokens = response.cost.inputTokens;
    outputTokens = response.cost.outputTokens;
    cacheCreationTokens = response.cost.cacheCreationInputTokens ?? 0;
    cacheReadTokens = response.cost.cacheReadInputTokens ?? 0;
  } catch (err) {
    logger.error(
      { taskId, err: String(err).slice(0, 500) },
      "Advisor: LLM call failed — returning fallback escalation verdict"
    );
    return FALLBACK_VERDICT;
  }

  // ── Cost tracking ────────────────────────────────────────────────────────

  const costUsd = estimateCostUsd(
    inputTokens,
    outputTokens,
    undefined,
    undefined,
    cacheCreationTokens,
    cacheReadTokens,
  );

  logger.info(
    {
      taskId,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUsd,
    },
    "Advisor: LLM call complete",
  );

  // ── Parse and validate response ──────────────────────────────────────────

  let parsed: unknown;
  try {
    parsed = parseAdvisorResponse(rawText);
  } catch (err) {
    logger.error(
      { taskId, err: String(err).slice(0, 200) },
      "Advisor: failed to parse LLM response — returning fallback verdict"
    );
    return FALLBACK_VERDICT;
  }

  const verdict = validateAdvisorResponse(parsed);

  logger.info(
    {
      taskId,
      verdict: verdict.verdict,
      confidenceScore: verdict.confidenceScore,
      escalate: verdict.escalate,
    },
    "Advisor: evaluation complete",
  );

  return verdict;
}
