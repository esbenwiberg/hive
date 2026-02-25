import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import { retrieveRelevantLearnings } from "../db/queries/learnings.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { addEvent } from "../db/queries/task-events.js";
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
 * Builds the user prompt sent to Claude alongside the architect system prompt.
 */
function buildUserPrompt(
  task: TaskRow,
  priorResults: Record<string, unknown>,
  clarificationAnswers?: string[],
  clarificationQuestions?: string[],
  learningsStr?: string,
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

  // Include relevant learnings from the hivemind
  if (learningsStr) {
    sections.push("", learningsStr);
  }

  return sections.join("\n");
}

// ── Validate-only helpers ─────────────────────────────────────────────────────

/**
 * Shape returned by the validate-only LLM prompt.
 */
export interface ValidateOnlyResult {
  valid: boolean;
  warnings?: string[];
}

/**
 * Parses the validate-only LLM response into a ValidateOnlyResult.
 * Wraps JSON.parse in try/catch and returns a safe fallback on failure.
 */
export function parseValidateOnlyResult(raw: string): ValidateOnlyResult {
  const cleaned = stripCodeFences(raw);
  // Find the first JSON object in the response
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { valid: false, warnings: ["Failed to parse validation output: no JSON object found"] };
  }
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const valid = parsed.valid === true;
    const warnings = Array.isArray(parsed.warnings)
      ? (parsed.warnings as unknown[]).map(String)
      : [];
    return { valid, warnings: warnings.length > 0 ? warnings : undefined };
  } catch {
    return { valid: false, warnings: ["Failed to parse validation output"] };
  }
}

/**
 * Builds the user prompt for validate-only mode (external blueprints).
 */
function buildValidateOnlyPrompt(
  task: TaskRow,
  blueprint: ArchitectBlueprint,
): string {
  return [
    `Task ID: ${task.id}`,
    `Task title: ${task.title}`,
    "",
    "<external_blueprint>",
    JSON.stringify(blueprint, null, 2),
    "</external_blueprint>",
    "",
    "Validate the blueprint above. Return JSON only.",
  ].join("\n");
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

    // ── External blueprint validate-only path ─────────────────────────────
    if (task.blueprintSource === "external" && task.externalBlueprint != null) {
      const externalBlueprint = task.externalBlueprint as unknown as ArchitectBlueprint;

      const validateSystemPrompt = loadPrompt("enrichers/architect-validate");

      const validateUserPrompt = buildValidateOnlyPrompt(task, externalBlueprint);

      const response = await callClaude({
        prompt: validateUserPrompt,
        model,
        systemPrompt: validateSystemPrompt,
      });

      const validationResult = parseValidateOnlyResult(response.text);

      const costUsd = estimateCostUsd(
        response.cost.inputTokens,
        response.cost.outputTokens,
        autonomousConfig.models.inputCostPerM,
        autonomousConfig.models.outputCostPerM,
      );

      const durationMs = Date.now() - startTime;

      if (!validationResult.valid && validationResult.warnings && validationResult.warnings.length > 0) {
        // Persist each warning as a task event visible in the dashboard
        for (const warning of validationResult.warnings) {
          try {
            await addEvent(
              task.id,
              "blueprint_warning",
              "architect",
              warning,
              { source: "validate-only", blueprintSource: "external" },
            );
          } catch (err) {
            logger.warn({ taskId: task.id, err }, "Architect: failed to persist blueprint warning event (non-blocking)");
          }
        }
        logger.warn(
          { taskId: task.id, warnings: validationResult.warnings },
          "Architect validate-only: external blueprint has semantic warnings",
        );
      } else {
        logger.info({ taskId: task.id }, "Architect validate-only: external blueprint passed semantic validation");
      }

      // Always pass through the external blueprint as the resolved architect output
      return {
        data: { architect: externalBlueprint },
        costUsd,
        durationMs,
      };
    }

    // ── Normal generation path (blueprintSource === 'architect' or absent) ─

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

    const userPrompt = buildUserPrompt(task, priorResults, clarificationAnswers, clarificationQuestions, learningsStr);

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
