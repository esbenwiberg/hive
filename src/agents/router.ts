import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getById, updateClassification, updateStatus } from "../db/queries/tasks.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { recordCost } from "../db/queries/costs.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface RouterResult {
  type: string;
  size: string;
  workflow: string;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const ROUTER_AGENT = "router";
const ROUTER_MODEL = "claude-sonnet-4-20250514";

const VALID_TYPES = new Set(["bug", "feature", "security", "refactor", "improvement"]);
const VALID_SIZES = new Set(["trivial", "small", "medium", "large"]);
const VALID_WORKFLOWS = new Set(["flow", "epic"]);

// ── Prompt loader ────────────────────────────────────────────────────────────

let routerPrompt: string | undefined;

function loadRouterPrompt(): string {
  if (!routerPrompt) {
    routerPrompt = readFileSync(resolve("prompts/router.md"), "utf-8");
  }
  return routerPrompt;
}

// ── Parse & validate ─────────────────────────────────────────────────────────

function parseClassification(text: string): RouterResult {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Router response is not a JSON object");
  }

  const config = getAutonomousConfig();

  const type = VALID_TYPES.has(parsed.type) ? parsed.type : config.classification.defaultType;
  const size = VALID_SIZES.has(parsed.size) ? parsed.size : config.classification.defaultSize;
  const workflow = VALID_WORKFLOWS.has(parsed.workflow) ? parsed.workflow : "flow";
  const model = typeof parsed.model === "string" && parsed.model.length > 0
    ? parsed.model
    : ROUTER_MODEL;

  const result: RouterResult = { type, size, workflow, model };

  if (typeof parsed.maxTurns === "number" && parsed.maxTurns > 0) {
    result.maxTurns = Math.floor(parsed.maxTurns);
  }

  if (typeof parsed.maxBudgetUsd === "number" && parsed.maxBudgetUsd > 0) {
    result.maxBudgetUsd = parsed.maxBudgetUsd;
  }

  return result;
}

// ── Cost estimation ──────────────────────────────────────────────────────────

/**
 * Rough cost estimate based on token counts.
 * Uses approximate Claude pricing: $3/M input, $15/M output for Sonnet.
 */
function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Routes a pending task by classifying it with Claude.
 *
 * Flow:
 * 1. Load task, validate it's pending
 * 2. Register as active agent
 * 3. Call Claude with the router prompt + task description
 * 4. Parse classification, update task fields
 * 5. Transition status: pending -> queued
 * 6. Record cost, unregister
 */
export async function routeTask(taskId: string): Promise<RouterResult> {
  const task = await getById(taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (task.status !== "pending") {
    throw new Error(`Task ${taskId} is not pending (status: ${task.status})`);
  }

  const startTime = Date.now();

  // Register as active agent
  await register(taskId, ROUTER_AGENT, ROUTER_MODEL, "classifying");

  try {
    const systemPrompt = loadRouterPrompt();

    const userPrompt = [
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Body: ${task.body}`,
      `Source: ${task.source}`,
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model: ROUTER_MODEL,
      systemPrompt,
    });

    const classification = parseClassification(response.text);

    // Update classification fields on the task
    await updateClassification(taskId, classification);

    // Transition: pending -> queued
    await updateStatus(taskId, "queued");

    // Record cost
    const costUsd = estimateCostUsd(
      response.cost.inputTokens,
      response.cost.outputTokens,
    );
    const durationMs = Date.now() - startTime;

    await recordCost(
      taskId,
      task.createdBy,
      ROUTER_AGENT,
      response.cost.model,
      costUsd,
      1,
      durationMs,
    );

    logger.info({ taskId, classification }, "Task routed successfully");

    return classification;
  } catch (err) {
    logger.error({ taskId, err }, "Router failed to classify task");
    throw err;
  } finally {
    await unregister(taskId);
  }
}
