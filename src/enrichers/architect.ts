import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import { retrieveRelevantLearnings, buildRetrievalTags } from "../db/queries/learnings.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { parseBlueprint as parseBlueprintMarkdown } from "../blueprints/parser.js";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";
import type { BlueprintTaskContext } from "../domain/types.js";

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
 * Infers task size from the number of milestones in a user-supplied blueprint.
 *
 * 0 milestones → 'small'
 * 1–2 milestones → 'medium'
 * 3+ milestones → 'large'
 */
export function inferSizeFromMilestoneCount(count: number): "small" | "medium" | "large" {
  if (count === 0) return "small";
  if (count <= 2) return "medium";
  return "large";
}

/**
 * Builds the user prompt sent to Claude alongside the architect system prompt.
 *
 * When `blueprintContext` is provided the prompt signals to the architect that
 * it is operating in **blueprint validation mode**: it should validate and
 * clarify the pre-written blueprint rather than generating one from scratch.
 */
function buildUserPrompt(
  task: TaskRow,
  priorResults: Record<string, unknown>,
  clarificationAnswers?: string[],
  clarificationQuestions?: string[],
  learningsStr?: string,
  blueprintContext?: BlueprintTaskContext,
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

  // ── Blueprint validation mode ───────────────────────────────────────────
  // When the task was created from a user-supplied blueprint, surface it so
  // the architect can validate and refine rather than generate from scratch.
  if (blueprintContext) {
    const inferredSize = blueprintContext.inferredSize ?? "medium";
    const milestoneCount = blueprintContext.milestoneCount ?? 0;

    // Override the size shown at the top of the prompt with the inferred value
    // (the TaskRow may not have been updated yet when the enricher runs).
    sections[0] = `Task ID: ${task.id}`;
    sections[1] = `Size (inferred from blueprint — ${milestoneCount} milestone(s)): ${inferredSize}`;

    sections.push(
      "",
      "<blueprint_mode>",
      "This task was created from a user-supplied blueprint. You are operating in",
      "BLUEPRINT VALIDATION MODE. Your job is NOT to generate a new blueprint from",
      "scratch. Instead:",
      "  1. Review the blueprint below for correctness, completeness, and coherence.",
      "  2. If the blueprint is sound, adopt it directly as your output.",
      "  3. If you spot gaps, ambiguities, or risks, surface them as clarification",
      "     questions rather than silently discarding the user's intent.",
      "  4. Do NOT ask questions that the blueprint has already answered.",
      `  5. Inferred task size: ${inferredSize} (${milestoneCount} milestone(s)).`,
      "</blueprint_mode>",
      "",
      "<user_supplied_blueprint_markdown>",
      blueprintContext.rawMarkdown,
      "</user_supplied_blueprint_markdown>",
      "",
      "<user_supplied_blueprint_parsed>",
      JSON.stringify(blueprintContext.parsed ?? blueprintContext.blueprint, null, 2),
      "</user_supplied_blueprint_parsed>",
    );
  }

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

    // Retrieve relevant learnings to inform the blueprint
    let learningsStr = "";
    let hivemindData: { learnings: { confidence: string; scope: string; content: string; category: string }[]; count: number } | undefined;
    try {
      const scopes = ["universal"];
      const repo = await getRepoById(task.repoId);
      if (repo) scopes.push(`repo:${repo.fullName}`);

      const relevant = await retrieveRelevantLearnings({
        scopes,
        tags: buildRetrievalTags({ taskType: task.type, severity: task.severity, repoFullName: repo?.fullName }),
        limit: 6,
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

        // Store for enrichment data so hivemind learnings are visible in the UI
        hivemindData = {
          learnings: relevant.map((l) => ({
            confidence: String(l.confidence),
            scope: l.scope,
            content: l.content,
            category: l.category,
          })),
          count: relevant.length,
        };
      }
    } catch (err) {
      logger.warn({ taskId: task.id, err }, "Architect: failed to retrieve learnings (non-blocking)");
    }

    // ── Blueprint validation mode ─────────────────────────────────────────
    // When the task was created from a user-supplied blueprint, parse and
    // validate it before calling the LLM. If invalid, throw immediately.
    let blueprintContext: BlueprintTaskContext | undefined;

    if (task.blueprintSource === "user" && task.userBlueprintMarkdown) {
      const parseResult = parseBlueprintMarkdown(task.userBlueprintMarkdown, { requireMilestones: false });

      if (!parseResult.ok) {
        const errorLines = parseResult.errors
          .map((e) => `  - [${e.field}] ${e.message}`)
          .join("\n");
        throw new Error(
          `User-supplied blueprint failed validation with ${parseResult.errors.length} error(s):\n${errorLines}`,
        );
      }

      const parsedBp = parseResult.blueprint;
      const milestoneCount = parsedBp.milestones?.length ?? 0;

      blueprintContext = {
        rawMarkdown: task.userBlueprintMarkdown,
        parsed: parsedBp,
        milestoneCount,
        inferredSize: inferSizeFromMilestoneCount(milestoneCount),
      };

      logger.info(
        { taskId: task.id, milestoneCount, inferredSize: blueprintContext.inferredSize },
        "Architect enricher: user blueprint validated, entering validation mode",
      );
    }

    const userPrompt = buildUserPrompt(
      task,
      priorResults,
      clarificationAnswers,
      clarificationQuestions,
      learningsStr,
      blueprintContext,
    );

    // ── Call Claude ───────────────────────────────────────────────────────
    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt,
    });

    // ── Parse response (skip clarification if answers already provided) ──
    const hasAnswers = !!clarificationAnswers && clarificationAnswers.length > 0;
    const blueprint = parseBlueprint(response.text, hasAnswers);

    // When operating in blueprint validation mode, stamp the inferred size
    // onto the blueprint so that downstream consumers can use it without
    // needing to know the blueprint source.
    if (blueprintContext?.inferredSize) {
      (blueprint as unknown as Record<string, unknown>).inferredSize = blueprintContext.inferredSize;
    }

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
        blueprintSource: task.blueprintSource ?? "architect",
        blueprintInferredSize: blueprintContext?.inferredSize,
        durationMs,
      },
      "Architect enricher completed",
    );

    const data: Record<string, unknown> = { architect: blueprint };
    if (hivemindData) {
      data.hivemind = hivemindData;
    }

    return {
      data,
      costUsd,
      durationMs,
    };
  },
};
