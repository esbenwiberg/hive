import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { getById, updateStatus } from "../db/queries/tasks.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { recordCost } from "../db/queries/costs.js";
import { recordDecision } from "../db/queries/gate-decisions.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { analyzeGatePatterns } from "./gate-analyst.js";

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

let gatePrompt: string | undefined;

function loadGatePrompt(): string {
  if (!gatePrompt) {
    gatePrompt = readFileSync(resolve("prompts/gate.md"), "utf-8");
  }
  return gatePrompt;
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
 * Evaluates a task at the gate stage.
 *
 * Flow depends on gate mode (from autonomous config):
 *
 * - **human**: transitions task to 'ready' for human approval. No LLM call.
 * - **ai**: calls Claude to evaluate the task, records decision, transitions.
 * - **auto**: auto-approves trivial/small tasks; falls through to AI for others.
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
  const mode = config.gate.mode;

  // ── Human mode: transition to ready and return ──────────────────────────
  if (mode === "human") {
    await updateStatus(taskId, "ready");
    logger.info({ taskId, mode }, "Gate: task moved to ready for human approval");
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

  const gateModel = config.models.gate;

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
    ].join("\n");

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
    void analyzeGatePatterns(taskId, result.verdict, result.reasoning).catch((err) => {
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
