import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getById, updateClassification, updateStatus } from "../db/queries/tasks.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { recordCost } from "../db/queries/costs.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { loadPrompt } from "../prompt-cache.js";

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

const VALID_TYPES = new Set(["bug", "feature", "security", "refactor", "improvement"]);
const VALID_SIZES = new Set(["trivial", "small", "medium", "large"]);
const VALID_WORKFLOWS = new Set(["flow", "epic"]);

// ── Prompt loader ────────────────────────────────────────────────────────────

function loadRouterPrompt(): string {
  return loadPrompt("router");
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
    : config.models.router;

  const result: RouterResult = { type, size, workflow, model };

  if (typeof parsed.maxTurns === "number" && parsed.maxTurns > 0) {
    result.maxTurns = Math.floor(parsed.maxTurns);
  }

  if (typeof parsed.maxBudgetUsd === "number" && parsed.maxBudgetUsd > 0) {
    result.maxBudgetUsd = parsed.maxBudgetUsd;
  }

  return result;
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
  const config = getAutonomousConfig();
  const routerModel = config.models.router;

  // Register as active agent
  await register(taskId, ROUTER_AGENT, routerModel, "classifying");

  try {
    const systemPrompt = loadRouterPrompt();

    const userPrompt = [
      `Task ID: ${task.id}`,
      `Source: ${task.source}`,
      "",
      "<user_provided_title>",
      task.title,
      "</user_provided_title>",
      "",
      "<user_provided_body>",
      task.body,
      "</user_provided_body>",
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model: routerModel,
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
      config.models.inputCostPerM,
      config.models.outputCostPerM,
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
