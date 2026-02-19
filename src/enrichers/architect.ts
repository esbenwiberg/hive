import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ArchitectMilestone {
  title: string;
  description: string;
  filesToModify: string[];
  acceptanceCriteria: string[];
}

export interface ArchitectBlueprint {
  /** High-level implementation strategy. */
  approach: string;
  /** Key files for small tasks (no milestones). */
  keyFiles?: string[];
  /** Checklist for small tasks (no milestones). */
  checklist?: string[];
  /** Milestones for medium/large tasks. */
  milestones?: ArchitectMilestone[];
  /** Set when the architect needs user input before producing a blueprint. */
  clarificationQuestions?: string[];
  /** True when clarification was requested and we are awaiting answers. */
  awaitingInput?: boolean;
  /** True when the enricher was skipped (trivial task). */
  skipped?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TRIVIAL_SIZE = "trivial";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips markdown code fences from a Claude response, then attempts to parse
 * the result as JSON. Returns the parsed object or `null` on failure.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
}

/**
 * Parses the raw Claude output into an ArchitectBlueprint.
 *
 * Attempts JSON parsing first. On failure, falls back to storing the raw text
 * as the `approach` field so downstream consumers still have something to work
 * with.
 */
export function parseBlueprint(raw: string, hasAnswers = false): ArchitectBlueprint {
  const cleaned = stripCodeFences(raw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    logger.warn("Architect response was not valid JSON; using raw text as fallback approach");
    return { approach: cleaned };
  }

  if (!parsed || typeof parsed !== "object") {
    return { approach: cleaned };
  }

  // ── Clarification mode (skip if answers were already provided) ──────────
  if (!hasAnswers && Array.isArray(parsed.clarificationQuestions)) {
    return {
      approach: typeof parsed.approach === "string" ? parsed.approach : "",
      clarificationQuestions: (parsed.clarificationQuestions as unknown[]).map(String),
      awaitingInput: true,
    };
  }

  // ── Blueprint mode ──────────────────────────────────────────────────────
  const blueprint: ArchitectBlueprint = {
    approach: typeof parsed.approach === "string" ? parsed.approach : "",
  };

  // keyFiles — coerce to string[]
  if (Array.isArray(parsed.keyFiles)) {
    blueprint.keyFiles = (parsed.keyFiles as unknown[]).map(String);
  }

  // checklist — coerce to string[]
  if (Array.isArray(parsed.checklist)) {
    blueprint.checklist = (parsed.checklist as unknown[]).map(String);
  }

  // milestones — validate and coerce each milestone
  if (Array.isArray(parsed.milestones)) {
    blueprint.milestones = (parsed.milestones as unknown[])
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
      .map((m) => ({
        title: typeof m.title === "string" ? m.title : "Untitled milestone",
        description: typeof m.description === "string" ? m.description : "",
        filesToModify: Array.isArray(m.filesToModify)
          ? (m.filesToModify as unknown[]).map(String)
          : [],
        acceptanceCriteria: Array.isArray(m.acceptanceCriteria)
          ? (m.acceptanceCriteria as unknown[]).map(String)
          : [],
      }));
  }

  return blueprint;
}

/**
 * Builds the user prompt sent to Claude alongside the architect system prompt.
 */
function buildUserPrompt(
  task: TaskRow,
  priorResults: Record<string, unknown>,
  clarificationAnswers?: string[],
  clarificationQuestions?: string[],
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

  // Include clarification Q&A if present
  if (clarificationAnswers && clarificationAnswers.length > 0) {
    const qaPairs = clarificationAnswers.map((a, i) => {
      const q = clarificationQuestions?.[i] ?? `Question ${i + 1}`;
      return `Q${i + 1}: ${q}\nA${i + 1}: ${a}`;
    });
    sections.push(
      "",
      "<clarification_answers>",
      "The user has already answered your clarification questions. Do NOT ask again. Produce a blueprint.",
      "",
      ...qaPairs,
      "</clarification_answers>",
    );
  }

  return sections.join("\n");
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const architectEnricher: Enricher = {
  name: "architect",

  async run(
    task: TaskRow,
    _repoDir: string,
    priorResults: Record<string, unknown>,
    config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    // ── Skip trivial tasks ────────────────────────────────────────────────
    if (task.size === TRIVIAL_SIZE) {
      logger.info({ taskId: task.id }, "Architect skipping trivial task");
      return {
        data: { architect: { skipped: true, approach: "" } satisfies ArchitectBlueprint },
        durationMs: Date.now() - startTime,
      };
    }

    // ── Resolve model ─────────────────────────────────────────────────────
    const autonomousConfig = getAutonomousConfig();
    const model = config.model ?? autonomousConfig.models.gate;

    // ── Build prompt ──────────────────────────────────────────────────────
    const systemPrompt = loadPrompt("enrichers/architect");

    // Check if there are existing clarification answers in the enrichment data
    const existingArchitect = priorResults.architect as
      | Record<string, unknown>
      | undefined;
    const clarificationAnswers = existingArchitect?.clarificationAnswers as
      | string[]
      | undefined;
    const clarificationQuestions = existingArchitect?.clarificationQuestions as
      | string[]
      | undefined;

    const userPrompt = buildUserPrompt(task, priorResults, clarificationAnswers, clarificationQuestions);

    // ── Call Claude ───────────────────────────────────────────────────────
    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt,
    });

    // ── Parse response (skip clarification if answers already provided) ──
    const hasAnswers = !!clarificationAnswers && clarificationAnswers.length > 0;
    const blueprint = parseBlueprint(response.text, hasAnswers);

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
        hasMilestones: !!blueprint.milestones,
        milestoneCount: blueprint.milestones?.length ?? 0,
        awaitingInput: blueprint.awaitingInput ?? false,
        durationMs,
      },
      "Architect enricher completed",
    );

    return {
      data: { architect: blueprint },
      costUsd,
      durationMs,
    };
  },
};
