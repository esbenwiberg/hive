import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import { retrieveRelevantLearnings } from "../db/queries/learnings.js";
import { getById as getRepoById } from "../db/queries/repos.js";
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
  /** Answers provided (by human or AI) to a previous round of clarification questions. */
  clarificationAnswers?: string[];
  /** 1-based counter tracking how many clarification rounds have been completed. */
  clarificationRound?: number;
  /** True when clarification was requested and we are awaiting answers. */
  awaitingInput?: boolean;
  /** True when the enricher was skipped (trivial task). */
  skipped?: boolean;
  /** True when the task has no user-facing output and preview can be skipped. */
  skipPreview?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips markdown code fences from a Claude response, then attempts to parse
 * the result as JSON. Returns the parsed object or `null` on failure.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
}

/**
 * Options for controlling clarification behaviour in `parseBlueprint`.
 */
export interface ParseBlueprintOptions {
  /**
   * Whether clarification answers have already been provided for a prior round.
   * When `true`, a follow-up clarification round is only permitted for large
   * tasks that have not yet exhausted their allowed rounds.
   */
  hasAnswers?: boolean;
  /** Size of the task — used to determine the maximum clarification rounds. */
  taskSize?: string | null;
  /**
   * The 1-based number of the clarification round that produced the current
   * `hasAnswers = true` state. Used to decide whether another round is allowed.
   */
  completedRound?: number;
}

/**
 * Parses the raw Claude output into an ArchitectBlueprint.
 *
 * Attempts JSON parsing first. On failure, falls back to storing the raw text
 * as the `approach` field so downstream consumers still have something to work
 * with.
 *
 * @param raw     - Raw text returned by the LLM.
 * @param options - Controls when follow-up clarification questions are allowed.
 */
export function parseBlueprint(raw: string, options: ParseBlueprintOptions | boolean = {}): ArchitectBlueprint {
  // Support legacy boolean `hasAnswers` callers for backward compatibility.
  // When called with a plain `true`, treat it as "answers exist, cap reached"
  // so that clarification is suppressed unconditionally (legacy behaviour).
  const opts: ParseBlueprintOptions =
    typeof options === "boolean"
      ? { hasAnswers: options, completedRound: options ? 99 : 0 }
      : options;

  const hasAnswers = opts.hasAnswers ?? false;
  const taskSize = opts.taskSize ?? "medium";
  const completedRound = opts.completedRound ?? 0;

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

  // ── Clarification mode ───────────────────────────────────────────────────
  // Maximum allowed clarification rounds per task size:
  //   large  → 2 rounds
  //   others → 1 round
  const maxRounds = taskSize === "large" ? 2 : 1;

  // Allow clarification questions when:
  //   a) No answers have been provided yet (first round for any size), OR
  //   b) Answers exist but the task is large and round limit not yet reached.
  const allowClarification = !hasAnswers || completedRound < maxRounds;

  if (allowClarification && Array.isArray(parsed.clarificationQuestions)) {
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

  // skipPreview — boolean
  if (parsed.skipPreview === true) {
    blueprint.skipPreview = true;
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
  learningsStr?: string,
  clarificationRound?: number,
): string {
  const taskSize = task.size ?? "medium";
  const sections: string[] = [
    `Task ID: ${task.id}`,
    `Size: ${taskSize}`,
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

    // On the final clarification round (round 2+), instruct the LLM to produce a blueprint
    const isFinalRound = (clarificationRound ?? 1) >= 2;
    const instruction = isFinalRound
      ? "The user has answered all clarification questions across multiple rounds. You MUST now produce a full blueprint. Do NOT ask further questions."
      : "The user has answered your clarification questions. If you are satisfied, produce a blueprint. For large tasks, you may ask one more round of follow-up questions if critical details remain unclear.";

    sections.push(
      "",
      "<clarification_answers>",
      instruction,
      "",
      ...qaPairs,
      "</clarification_answers>",
    );
  }

  // Include relevant learnings from the hivemind
  if (learningsStr) {
    sections.push("", learningsStr);
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

    // ── Resolve model ─────────────────────────────────────────────────────
    const autonomousConfig = getAutonomousConfig();
    const model = config.model ?? getModelFor("architect");

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
    const clarificationRound = existingArchitect?.clarificationRound as
      | number
      | undefined;

    // Retrieve relevant learnings to inform the blueprint
    let learningsStr = "";
    try {
      const tags: string[] = [];
      if (task.type) tags.push(task.type);
      if (task.severity) tags.push(task.severity);

      const scopes = ["universal"];
      const repo = await getRepoById(task.repoId);
      if (repo) scopes.push(`repo:${repo.fullName}`);

      const relevant = await retrieveRelevantLearnings({
        scopes,
        tags: tags.length > 0 ? tags : ["general"],
        limit: 10,
      });

      if (relevant.length > 0) {
        learningsStr = [
          `<learnings>`,
          `These learnings come from past tasks. Apply them when designing the blueprint:`,
          ...relevant.map(
            (l) => `- [confidence: ${l.confidence}] (${l.scope}) ${l.content}`,
          ),
          `</learnings>`,
        ].join("\n");
      }
    } catch (err) {
      logger.warn({ taskId: task.id, err }, "Architect: failed to retrieve learnings (non-blocking)");
    }

    const userPrompt = buildUserPrompt(task, priorResults, clarificationAnswers, clarificationQuestions, learningsStr, clarificationRound);

    // ── Call Claude ───────────────────────────────────────────────────────
    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt,
    });

    // ── Parse response ────────────────────────────────────────────────────
    // Pass the task size and completed-round count so parseBlueprint can
    // correctly decide whether another clarification round is permitted.
    const hasAnswers = !!clarificationAnswers && clarificationAnswers.length > 0;
    const blueprint = parseBlueprint(response.text, {
      hasAnswers,
      taskSize: task.size,
      completedRound: clarificationRound ?? 0,
    });

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
