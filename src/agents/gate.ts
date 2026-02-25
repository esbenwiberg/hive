import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { getById, updateStatus } from "../db/queries/tasks.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { recordCost } from "../db/queries/costs.js";
import { recordDecision } from "../db/queries/gate-decisions.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { analyzeGatePatterns } from "./gate-analyst.js";
import { loadPrompt } from "../prompt-cache.js";
import type { AdvisorVerdictResponse } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface GateVerdict {
  verdict: "approve" | "reject" | "rework";
  reasoning: string;
  confidence: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const GATE_AGENT = "gate";

const VALID_VERDICTS = new Set(["approve", "reject", "rework"]);

const VERDICT_TO_STATUS: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  rework: "rework",
};

// ── Prompt loader ────────────────────────────────────────────────────────────

function loadGatePrompt(): string {
  return loadPrompt("gate");
}

// ── Parse & validate ─────────────────────────────────────────────────────────

function parseVerdict(text: string): GateVerdict {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Gate response is not a JSON object");
  }

  if (!VALID_VERDICTS.has(parsed.verdict)) {
    throw new Error(`Invalid verdict: ${parsed.verdict}`);
  }

  const reasoning = typeof parsed.reasoning === "string"
    ? parsed.reasoning
    : "No reasoning provided";

  const confidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;

  return {
    verdict: parsed.verdict,
    reasoning,
    confidence,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Gate Agent (Pipeline Stage 5: READY → APPROVED or HUMAN_REVIEW)
 *
 * Final decision point. Consumes advisor verdict and applies approval logic.
 *
 * ============================================================================
 * CRITICAL OVERRIDE RULE:
 * If advisorVerdict.escalate === true, gate MUST escalate to human review.
 * This rule applies regardless of verdict value, confidence score, or any
 * other signal. This check happens FIRST and is non-negotiable.
 * ============================================================================
 *
 * Flow:
 *   1. Extract advisorVerdict from enrichment
 *   2. FIRST CHECK: If escalate === true → return human review (STOP)
 *   3. Else: apply verdict-based approval logic
 *      - 'approve': likely approve (apply confidence thresholds)
 *      - 'caution': escalate to human or require preconditions
 *      - 'rework': recommend human review or rejection
 *   4. Return final approval or human review decision
 *
 * Gate Mode Integration:
 *   - **human**: transitions task to 'ready' for human approval. No LLM call.
 *   - **ai**: calls Claude to evaluate the task, records decision, transitions.
 *   - **auto**: auto-approves trivial/small tasks; falls through to AI for others.
 *
 * Advisor Integration:
 *   Advisor confidence < 0.5 forces escalate=true (mandatory), which gate
 *   respects immediately. Additional confidence-based thresholds may be
 *   applied to advisor verdict='approve' or 'caution' verdicts.
 */
export async function evaluateGate(taskId: string): Promise<void> {
  const task = await getById(taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (task.status !== "enriching") {
    throw new Error(`Task ${taskId} is not in enriching status (status: ${task.status})`);
  }

  const config = getAutonomousConfig();
  let mode = config.gate.mode;

  // ── CRITICAL CHECK: Advisor escalation (FIRST, before any approval logic) ─
  const enrichment = (task.enrichment ?? {}) as Record<string, unknown>;
  const advisorVerdict = enrichment.advisor as AdvisorVerdictResponse | undefined;

  if (advisorVerdict?.escalate === true) {
    logger.warn(
      {
        taskId,
        advisorScore: advisorVerdict.confidenceScore,
        advisorVerdict: advisorVerdict.verdict,
      },
      "Gate: advisor flagged escalation — forcing human approval mode",
    );
    mode = "human";
  }

  // ── Human mode: transition to ready and return ──────────────────────────
  if (mode === "human") {
    await updateStatus(taskId, "ready");
    logger.info(
      {
        taskId,
        mode,
        advisorEscalate: advisorVerdict?.escalate ?? false,
      },
      "Gate: task moved to ready for human approval"
    );
    return;
  }

  // ── Auto mode: auto-approve trivial/small tasks ────────────────────────
  if (mode === "auto" && (task.size === "trivial" || task.size === "small")) {
    await recordDecision(
      taskId,
      "approve",
      "auto",
      undefined,
      `Auto-approved: task size is ${task.size}`,
      { size: task.size, type: task.type },
    );
    await updateStatus(taskId, "approved");
    logger.info({ taskId, mode, size: task.size }, "Gate: auto-approved small task");
    return;
  }

  // ── AI mode (or auto mode fall-through for medium/large) ───────────────
  const startTime = Date.now();

  // Optimistic lock: atomically claim the task to prevent concurrent gate evaluations
  const [claimed] = await db
    .update(tasks)
    .set({ updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "enriching")))
    .returning({ id: tasks.id });

  if (!claimed) {
    throw new Error(`Gate: task ${taskId} was already claimed by another evaluator`);
  }

  const gateModel = getModelFor("gate");

  await register(taskId, GATE_AGENT, gateModel, "evaluating");

  try {
    const systemPrompt = loadGatePrompt();

    const taskContext: Record<string, unknown> = {
      id: task.id,
      title: task.title,
      body: task.body,
      type: task.type,
      size: task.size,
      source: task.source,
      workflow: task.workflow,
      enrichment: task.enrichment,
    };

    // Build user prompt with advisor assessment section
    const advisorSection = advisorVerdict
      ? [
          "",
          "## Advisor Assessment",
          `Verdict: ${advisorVerdict.verdict}`,
          `Overall Score: ${advisorVerdict.confidenceScore.toFixed(2)}`,
          `Reasoning: ${advisorVerdict.reasoning}`,
          `Escalate: ${advisorVerdict.escalate}`,
          advisorVerdict.recommendations.length > 0
            ? `Recommendations: ${advisorVerdict.recommendations.join("; ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const userPrompt = [
      `Task ID: ${task.id}`,
      `Type: ${task.type ?? "unclassified"}`,
      `Size: ${task.size ?? "unknown"}`,
      `Source: ${task.source}`,
      `Workflow: ${task.workflow ?? "flow"}`,
      "",
      "<user_provided_title>",
      task.title,
      "</user_provided_title>",
      "",
      "<user_provided_body>",
      task.body,
      "</user_provided_body>",
      "",
      "<enrichment_data>",
      JSON.stringify(task.enrichment ?? {}, null, 2),
      "</enrichment_data>",
      advisorSection,
    ]
      .filter(Boolean)
      .join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model: gateModel,
      systemPrompt,
    });

    const result = parseVerdict(response.text);
    const targetStatus = VERDICT_TO_STATUS[result.verdict];

    // Record gate decision
    await recordDecision(
      taskId,
      result.verdict,
      "ai",
      undefined,
      result.reasoning,
      taskContext,
    );

    // Write verdict to task record so the dashboard can display it
    await db
      .update(tasks)
      .set({ gateVerdict: result.verdict, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    // Transition task status
    await updateStatus(taskId, targetStatus);

    // Record cost
    const costUsd = estimateCostUsd(
      response.cost.inputTokens,
      response.cost.outputTokens,
      config.models.inputCostPerM,
      config.models.outputCostPerM,
    );
    const durationMs = Date.now() - startTime;

    await recordCost(
      taskId,
      task.createdBy,
      GATE_AGENT,
      response.cost.model,
      costUsd,
      1,
      durationMs,
    );

    // Fire-and-forget gate pattern analysis — never blocks or throws
    const repo = await getRepoById(task.repoId);
    void analyzeGatePatterns(taskId, result.verdict, result.reasoning, repo?.fullName).catch((err) => {
      logger.error({ taskId, err }, "Gate pattern analysis failed (non-blocking)");
    });

    logger.info(
      { taskId, verdict: result.verdict, confidence: result.confidence },
      "Gate: AI evaluation complete",
    );
  } catch (err) {
    logger.error({ taskId, err }, "Gate agent failed to evaluate task");
    throw err;
  } finally {
    await unregister(taskId);
  }
}
