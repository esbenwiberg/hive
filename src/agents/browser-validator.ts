import logger from "../logger.js";
import { callClaudeWithTools } from "./sdk.js";
import { loadPrompt } from "../prompt-cache.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { register, unregister, heartbeat } from "../db/queries/active-agents.js";
import { recordCost } from "../db/queries/costs.js";
import { addEvent } from "../db/queries/task-events.js";
import { getById } from "../db/queries/tasks.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrowserValidationResult {
  verdict: "pass" | "fail";
  findings: string[];
  costUsd: number;
}

// ── Parser ───────────────────────────────────────────────────────────────────

function parseValidationResult(text: string): { verdict: "pass" | "fail"; findings: string[] } {
  // Strip all markdown code fences (```json ... ```)
  const cleaned = text.replace(/```(?:json)?\s*\n?/g, "").trim();

  // Try to find the last JSON object (Claude often emits text before the final JSON)
  const jsonBlocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        jsonBlocks.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // Try each JSON block (last first — Claude's final answer is usually last)
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonBlocks[i]);
      if (parsed && typeof parsed === "object" && "verdict" in parsed) {
        const verdict = parsed.verdict === "pass" ? "pass" : "fail";
        const findings = Array.isArray(parsed.findings) ? parsed.findings.map(String) : [];
        return { verdict, findings };
      }
    } catch { /* try next block */ }
  }

  return { verdict: "fail", findings: ["Failed to parse validation output"] };
}

// ── Agent ────────────────────────────────────────────────────────────────────

/**
 * Runs browser-based validation against a live preview environment.
 * Launches headless Chromium, navigates to the preview URL, and uses
 * Claude to interactively verify task requirements.
 */
export async function validateWithBrowser(
  taskId: string,
  previewUrl: string,
): Promise<BrowserValidationResult> {
  const startTime = Date.now();
  const config = getAutonomousConfig();
  const model = getModelFor("browser-validator");

  // Dynamic import to avoid loading Playwright when not needed
  const { BROWSER_TOOLS, createBrowserSession, closeBrowserSession, createBrowserToolExecutor } =
    await import("../execution/browser-tools.js");

  const task = await getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  await register(taskId, "browser-validator", model, "validating");
  await addEvent(taskId, "browser_validation_started", "browser-validator", `Validating preview at ${previewUrl}`);

  const session = await createBrowserSession();

  try {
    const browserExecutor = createBrowserToolExecutor(session);

    const userPrompt = [
      `## Task: ${task.title}`,
      ``,
      task.body,
      ``,
      `## Preview URL`,
      previewUrl,
      ``,
      `Navigate to the preview URL and verify that the task requirements are met.`,
    ].join("\n");

    const response = await callClaudeWithTools({
      prompt: userPrompt,
      model,
      systemPrompt: loadPrompt("browser-validator"),
      tools: BROWSER_TOOLS,
      executeTool: browserExecutor,
      maxTurns: 15,
      onTurnComplete: () => heartbeat(taskId),
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    await recordCost(taskId, task.createdBy, "browser-validator", model, costUsd, response.turns, durationMs);

    let result: { verdict: "pass" | "fail"; findings: string[] };
    try {
      result = parseValidationResult(response.text);
    } catch {
      result = { verdict: "fail", findings: ["Failed to parse validation result"] };
    }

    await addEvent(
      taskId,
      "browser_validation_complete",
      "browser-validator",
      `Browser validation: ${result.verdict} (${result.findings.length} findings, $${costUsd.toFixed(2)})`,
      { verdict: result.verdict, findings: result.findings },
    );

    logger.info(
      { taskId, verdict: result.verdict, findings: result.findings.length, costUsd, turns: response.turns },
      "Browser validation complete",
    );

    return { verdict: result.verdict, findings: result.findings, costUsd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, err }, "Browser validation failed");
    await addEvent(taskId, "browser_validation_error", "browser-validator", `Error: ${msg}`);

    return { verdict: "fail", findings: [`Browser validation error: ${msg}`], costUsd: 0 };
  } finally {
    await closeBrowserSession(session);
    await unregister(taskId);
  }
}
