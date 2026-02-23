import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { loadPrompt } from "../prompt-cache.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdvisorDimension {
  /** Numeric score 0–1 for this dimension */
  score: number;
  /** One-sentence rationale */
  rationale: string;
}

export interface AdvisorVerdict {
  /** High-level verdict: "approve" | "caution" | "reject" */
  verdict: "approve" | "caution" | "reject";
  /** Aggregate weighted score 0–1 */
  overallScore: number;
  /** How confident the advisor is in its assessment 0–1; < 0.5 forces escalation */
  confidenceScore: number;
  /** Per-dimension breakdown */
  dimensions: {
    productFit: AdvisorDimension;
    architecturalAlignment: AdvisorDimension;
    userImpact: AdvisorDimension;
    implementationRisk: AdvisorDimension;
    scopeClarity: AdvisorDimension;
  };
  /** Detailed reasoning paragraph(s) */
  reasoning: string;
  /** Ordered list of actionable recommendations */
  recommendations: string[];
  /** True if the task should be escalated to a human regardless of gate mode */
  escalate: boolean;
}

// ── Enrichment context shape (mirrors what the pipeline produces) ─────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Default fallback verdict ──────────────────────────────────────────────────

function buildDefaultVerdict(reason: string): AdvisorVerdict {
  return {
    verdict: "caution",
    overallScore: 0,
    confidenceScore: 0,
    dimensions: {
      productFit: { score: 0, rationale: "Parse failure — unable to assess." },
      architecturalAlignment: { score: 0, rationale: "Parse failure — unable to assess." },
      userImpact: { score: 0, rationale: "Parse failure — unable to assess." },
      implementationRisk: { score: 0, rationale: "Parse failure — unable to assess." },
      scopeClarity: { score: 0, rationale: "Parse failure — unable to assess." },
    },
    reasoning: `Advisor could not produce a structured verdict. Reason: ${reason}. Escalating to human for manual review.`,
    recommendations: ["Human review required — advisor response was unparseable."],
    escalate: true,
  };
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseAdvisorResponse(text: string): AdvisorVerdict {
  // Strip markdown fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`JSON.parse failed: ${String(err)}`);
  }

  // Validate required fields
  const requiredFields = [
    "verdict",
    "overallScore",
    "confidenceScore",
    "dimensions",
    "reasoning",
    "recommendations",
    "escalate",
  ] as const;

  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  const verdict = parsed.verdict as string;
  if (!["approve", "caution", "reject"].includes(verdict)) {
    throw new Error(`Invalid verdict value: ${verdict}`);
  }

  const dims = parsed.dimensions as Record<string, unknown>;
  const dimNames = ["productFit", "architecturalAlignment", "userImpact", "implementationRisk", "scopeClarity"];
  for (const dim of dimNames) {
    if (!dims || typeof dims[dim] !== "object" || dims[dim] === null) {
      throw new Error(`Missing or invalid dimension: ${dim}`);
    }
  }

  const overallScore = Number(parsed.overallScore);
  const confidenceScore = Number(parsed.confidenceScore);

  const buildDim = (raw: unknown): AdvisorDimension => {
    const d = raw as Record<string, unknown>;
    return {
      score: Number(d.score ?? 0),
      rationale: String(d.rationale ?? ""),
    };
  };

  const result: AdvisorVerdict = {
    verdict: verdict as "approve" | "caution" | "reject",
    overallScore: Number.isFinite(overallScore) ? overallScore : 0,
    confidenceScore: Number.isFinite(confidenceScore) ? confidenceScore : 0,
    dimensions: {
      productFit: buildDim(dims.productFit),
      architecturalAlignment: buildDim(dims.architecturalAlignment),
      userImpact: buildDim(dims.userImpact),
      implementationRisk: buildDim(dims.implementationRisk),
      scopeClarity: buildDim(dims.scopeClarity),
    },
    reasoning: String(parsed.reasoning ?? ""),
    recommendations: Array.isArray(parsed.recommendations)
      ? (parsed.recommendations as unknown[]).map(String)
      : [],
    escalate: Boolean(parsed.escalate),
  };

  // Low confidence forces escalation regardless of what the LLM said
  if (result.confidenceScore < 0.5) {
    result.escalate = true;
  }

  return result;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Runs the Advisor agent against an enriched task.
 *
 * Loads:
 *  - prompts/enrichers/advisor.md         (system prompt)
 *  - docs/internal/product-context.md     (product knowledge)
 *  - docs/internal/architecture.md        (architecture overview)
 *  - docs/internal/modules/*.md           (module documentation)
 *
 * Injects enrichment data (router, codebase, architect, scorer) as structured
 * context in the user prompt, calls the LLM, and returns a typed AdvisorVerdict.
 *
 * On any parse failure, returns a low-confidence escalation verdict rather than
 * throwing, so the pipeline can continue safely.
 */
export async function runAdvisor(input: AdvisorInput): Promise<AdvisorVerdict> {
  const { taskId } = input;
  const model = getModelFor("advisor");

  logger.info({ taskId, model }, "Advisor: starting evaluation");

  // ── Load static knowledge ─────────────────────────────────────────────────

  const systemPrompt = loadPrompt("enrichers/advisor");

  const productContextPath = resolve("docs/internal/product-context.md");
  const productContext = safeRead(
    productContextPath,
    "(product-context.md not found — proceeding without it)",
  );

  const repoKnowledge = buildRepoKnowledge();

  // ── Build user prompt ─────────────────────────────────────────────────────

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
    logger.error({ taskId, err }, "Advisor: LLM call failed — returning default escalation verdict");
    return buildDefaultVerdict(`LLM call failed: ${String(err)}`);
  }

  // ── Cost tracking ─────────────────────────────────────────────────────────

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

  // ── Parse response ────────────────────────────────────────────────────────

  let verdict: AdvisorVerdict;
  try {
    verdict = parseAdvisorResponse(rawText);
  } catch (err) {
    logger.error({ taskId, err, rawText }, "Advisor: failed to parse LLM response — returning default escalation verdict");
    return buildDefaultVerdict(`Response parse error: ${String(err)}`);
  }

  logger.info(
    {
      taskId,
      verdict: verdict.verdict,
      overallScore: verdict.overallScore,
      confidenceScore: verdict.confidenceScore,
      escalate: verdict.escalate,
    },
    "Advisor: evaluation complete",
  );

  return verdict;
}
