import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";
import type { ArchitectBlueprint } from "./architect.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TaskScores {
  value:       { score: number; reasoning: string };
  complexity:  { score: number; reasoning: string };
  risk:        { score: number; reasoning: string };
  feasibility: { score: number; reasoning: string };
}

export interface CostEstimate {
  totalUsd: number;
  breakdown: { enrichment: number; execution: number; review: number };
  reasoning: string;
}

export interface ScorerResult {
  scores: TaskScores;
  costEstimate: CostEstimate;
  recommendation: "approve" | "reject" | "rework";
  summary: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_RECOMMENDATIONS = new Set(["approve", "reject", "rework"]);

const MID_RANGE_DEFAULTS: ScorerResult = {
  scores: {
    value:       { score: 5, reasoning: "parse_error" },
    complexity:  { score: 5, reasoning: "parse_error" },
    risk:        { score: 5, reasoning: "parse_error" },
    feasibility: { score: 5, reasoning: "parse_error" },
  },
  costEstimate: {
    totalUsd: 0,
    breakdown: { enrichment: 0, execution: 0, review: 0 },
    reasoning: "parse_error",
  },
  recommendation: "rework",
  summary: "Unable to parse scorer response; defaulting to mid-range scores",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips markdown code fences from a Claude response.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
}

/**
 * Clamps a number to the range [1, 10] and rounds to the nearest integer.
 */
function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * Ensures a value is a non-negative finite number. Falls back to 0.
 */
function ensurePositiveNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 10000) / 10000; // round to 4 decimal places
}

/**
 * Parses a single score dimension from the raw parsed object.
 */
function parseScoreDimension(
  raw: unknown,
): { score: number; reasoning: string } {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      score: clampScore(obj.score),
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
    };
  }
  return { score: 5, reasoning: "" };
}

/**
 * Parses the raw Claude output into a ScorerResult.
 *
 * Attempts JSON parsing, then validates and clamps all fields. On failure,
 * returns mid-range defaults with a "parse_error" note.
 */
export function parseScorerResult(raw: string): ScorerResult {
  const cleaned = stripCodeFences(raw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    logger.warn("Scorer response was not valid JSON; returning mid-range defaults");
    return { ...MID_RANGE_DEFAULTS };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ...MID_RANGE_DEFAULTS };
  }

  // ── Scores ──────────────────────────────────────────────────────────────
  const rawScores = parsed.scores as Record<string, unknown> | undefined;
  const scores: TaskScores = {
    value:       parseScoreDimension(rawScores?.value),
    complexity:  parseScoreDimension(rawScores?.complexity),
    risk:        parseScoreDimension(rawScores?.risk),
    feasibility: parseScoreDimension(rawScores?.feasibility),
  };

  // ── Cost estimate ───────────────────────────────────────────────────────
  const rawCost = parsed.costEstimate as Record<string, unknown> | undefined;
  const rawBreakdown = rawCost?.breakdown as Record<string, unknown> | undefined;

  const breakdown = {
    enrichment: ensurePositiveNumber(rawBreakdown?.enrichment),
    execution:  ensurePositiveNumber(rawBreakdown?.execution),
    review:     ensurePositiveNumber(rawBreakdown?.review),
  };

  const totalFromBreakdown = breakdown.enrichment + breakdown.execution + breakdown.review;
  const rawTotal = ensurePositiveNumber(rawCost?.totalUsd);

  const resolvedTotal = rawTotal > 0 ? rawTotal : totalFromBreakdown;
  if (resolvedTotal > 20) {
    logger.warn(
      { resolvedTotal, rawTotal, totalFromBreakdown, breakdown },
      "Scorer returned suspiciously high cost estimate — prompt guidance may not have been followed",
    );
  }

  const costEstimate: CostEstimate = {
    totalUsd: resolvedTotal,
    breakdown,
    reasoning: typeof rawCost?.reasoning === "string" ? rawCost.reasoning : "",
  };

  // ── Recommendation ──────────────────────────────────────────────────────
  const rawRec = String(parsed.recommendation ?? "").toLowerCase();
  const recommendation = VALID_RECOMMENDATIONS.has(rawRec)
    ? (rawRec as ScorerResult["recommendation"])
    : "rework";

  // ── Summary ─────────────────────────────────────────────────────────────
  const summary = typeof parsed.summary === "string"
    ? parsed.summary
    : "No summary provided";

  return { scores, costEstimate, recommendation, summary };
}

/**
 * Produces heuristic scores for tasks where the architect was skipped or missing.
 * Trivial tasks get low complexity/risk and high feasibility; others get mid-range.
 */
function heuristicScores(task: TaskRow): ScorerResult {
  const isTrivial = task.size === "trivial";
  const isSmall = task.size === "small";

  if (isTrivial) {
    return {
      scores: {
        value:       { score: 3, reasoning: "Trivial task — limited impact" },
        complexity:  { score: 1, reasoning: "Trivial task — minimal complexity" },
        risk:        { score: 1, reasoning: "Trivial task — very low risk" },
        feasibility: { score: 10, reasoning: "Trivial task — highly feasible for autonomous execution" },
      },
      costEstimate: {
        totalUsd: 0.25,
        breakdown: { enrichment: 0.01, execution: 0.06, review: 0.18 },
        reasoning: "Trivial task: minimal execution + up to 3 review gate passes + PR follow-up",
      },
      recommendation: "approve",
      summary: "Trivial task; auto-approved with heuristic scores",
    };
  }

  if (isSmall) {
    return {
      scores: {
        value:       { score: 4, reasoning: "Small task — moderate impact" },
        complexity:  { score: 3, reasoning: "Small task — low complexity" },
        risk:        { score: 2, reasoning: "Small task — low risk" },
        feasibility: { score: 8, reasoning: "Small task — very feasible for autonomous execution" },
      },
      costEstimate: {
        totalUsd: 0.80,
        breakdown: { enrichment: 0.02, execution: 0.15, review: 0.63 },
        reasoning: "Small task: 1 milestone at max review iterations + max gate rework cycles + PR follow-up",
      },
      recommendation: "approve",
      summary: "Small task; auto-approved with heuristic scores (no architect blueprint)",
    };
  }

  // Medium or large without a blueprint — cannot score accurately
  return {
    scores: {
      value:       { score: 5, reasoning: "No blueprint available — cannot assess accurately" },
      complexity:  { score: 5, reasoning: "No blueprint available — assuming moderate complexity" },
      risk:        { score: 6, reasoning: "No blueprint available — elevated risk due to missing plan" },
      feasibility: { score: 4, reasoning: "No blueprint available — reduced feasibility without execution plan" },
    },
    costEstimate: {
      totalUsd: 0,
      breakdown: { enrichment: 0, execution: 0, review: 0 },
      reasoning: "Cannot estimate cost without architect blueprint",
    },
    recommendation: "rework",
    summary: "No architect blueprint available; recommend rework to produce a plan before scoring",
  };
}

/**
 * Builds the user prompt sent to Claude alongside the scorer system prompt.
 */
function buildUserPrompt(
  task: TaskRow,
  priorResults: Record<string, unknown>,
): string {
  const sections: string[] = [
    `Task ID: ${task.id}`,
    `Size: ${task.size ?? "medium"}`,
    "",
    "<user_provided_title>",
    task.title,
    "</user_provided_title>",
    "",
    "<user_provided_body>",
    task.body,
    "</user_provided_body>",
  ];

  // Include enrichment context from prior enrichers
  const enrichmentKeys = Object.keys(priorResults).filter((k) => k !== "_enrichmentMeta");
  if (enrichmentKeys.length > 0) {
    const enrichmentSubset: Record<string, unknown> = {};
    for (const key of enrichmentKeys) {
      enrichmentSubset[key] = priorResults[key];
    }
    sections.push(
      "",
      "<enrichment_data>",
      JSON.stringify(enrichmentSubset, null, 2),
      "</enrichment_data>",
    );
  }

  return sections.join("\n");
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const scorerEnricher: Enricher = {
  name: "scorer",

  async run(
    task: TaskRow,
    _repoDir: string,
    priorResults: Record<string, unknown>,
    config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    // ── Check for architect blueprint ───────────────────────────────────────
    const architectResult = priorResults.architect as ArchitectBlueprint | undefined;
    const architectSkipped = !architectResult || architectResult.skipped === true;
    const architectAwaiting = architectResult?.awaitingInput === true;

    // If architect was skipped, missing, or awaiting input: use heuristic scores
    if (architectSkipped || architectAwaiting) {
      logger.info(
        { taskId: task.id, reason: architectAwaiting ? "awaiting_input" : "no_blueprint" },
        "Scorer using heuristic scores (no architect blueprint available)",
      );

      const result = heuristicScores(task);
      return {
        data: { scorer: result },
        durationMs: Date.now() - startTime,
      };
    }

    // ── Resolve model ─────────────────────────────────────────────────────
    const autonomousConfig = getAutonomousConfig();
    const model = config.model ?? getModelFor("scorer");

    // ── Build prompt ──────────────────────────────────────────────────────
    const systemPrompt = loadPrompt("enrichers/scorer");
    const userPrompt = buildUserPrompt(task, priorResults);

    // ── Call Claude ───────────────────────────────────────────────────────
    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt,
    });

    // ── Parse response ───────────────────────────────────────────────────
    const scorerResult = parseScorerResult(response.text);

    // ── Cost tracking ────────────────────────────────────────────────────
    const costUsd = estimateCostUsd(
      response.cost.inputTokens,
      response.cost.outputTokens,
      autonomousConfig.models.inputCostPerM,
      autonomousConfig.models.outputCostPerM,
    );

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        taskId: task.id,
        model: response.cost.model,
        inputTokens: response.cost.inputTokens,
        outputTokens: response.cost.outputTokens,
        costUsd,
        recommendation: scorerResult.recommendation,
        valueScore: scorerResult.scores.value.score,
        complexityScore: scorerResult.scores.complexity.score,
        riskScore: scorerResult.scores.risk.score,
        feasibilityScore: scorerResult.scores.feasibility.score,
        estimatedTotalUsd: scorerResult.costEstimate.totalUsd,
        durationMs,
      },
      "Scorer enricher completed",
    );

    return {
      data: { scorer: scorerResult },
      costUsd,
      durationMs,
    };
  },
};
