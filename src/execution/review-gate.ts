import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { getById } from "../db/queries/tasks.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { recordReview } from "../db/queries/code-reviews.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { fireAndForgetFeedback } from "../agents/feedback-loop.js";
import { analyzeReviewPatterns } from "../agents/code-quality-analyst.js";
import { loadPrompt } from "../prompt-cache.js";
import type { ReviewGateResult, WorktreeInfo } from "../domain/types.js";

const execFileAsync = promisify(execFile);

function getReviewPrompt(): string {
  return loadPrompt("review-gate");
}

/**
 * Gets the git diff of all changes in the worktree (committed + uncommitted)
 * relative to the base SHA the feature branch was created from.
 */
async function getGitDiff(worktreePath: string, baseSha: string): Promise<string> {
  try {
    // Diff from the base commit to the working tree — captures both committed and uncommitted changes
    const { stdout } = await execFileAsync("git", ["diff", "--stat", baseSha], { cwd: worktreePath, timeout: 120_000 });
    const { stdout: fullDiff } = await execFileAsync("git", ["diff", baseSha], { cwd: worktreePath, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return `${stdout}\n\n${fullDiff}`;
  } catch {
    return "(no diff available)";
  }
}

/**
 * Gets the list of changed files (committed + uncommitted) relative to the base SHA.
 */
async function getChangedFiles(worktreePath: string, baseSha: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", baseSha], { cwd: worktreePath, timeout: 120_000 });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Parses the Claude response into a ReviewGateResult.
 * Handles markdown code fences around JSON.
 */
export function parseReviewResult(text: string): ReviewGateResult {
  // Try multiple strategies to extract JSON from Claude's response:
  // 1. Extract from markdown code fence (handles preamble/postamble text)
  // 2. Find first { ... last } in the text
  // 3. Strip simple fences and parse directly
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  const bracketMatch = !fenceMatch ? text.match(/(\{[\s\S]*\})/) : null;
  const cleaned = (fenceMatch?.[1] ?? bracketMatch?.[1] ?? text).trim();

  try {
    const parsed = JSON.parse(cleaned);

    // Normalize any non-pass verdict to "rework" — fail is no longer terminal
    const rawVerdict = parsed.verdict;
    const verdict = rawVerdict === "pass" ? "pass" : "rework";

    return {
      verdict,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      securityFindings: Array.isArray(parsed.securityFindings) ? parsed.securityFindings : [],
      verification: parsed.verification ?? {
        testsRun: false,
        testsPassed: false,
        lintClean: false,
        buildSucceeded: false,
        notes: [],
      },
      costUsd: 0, // Set by caller
    };
  } catch (err) {
    logger.warn({ text: text.substring(0, 200) }, "Failed to parse review result, defaulting to rework");
    return {
      verdict: "rework",
      findings: [{ severity: "major", file: "", message: "Could not parse review response", category: "correctness" }],
      securityFindings: [],
      verification: { testsRun: false, testsPassed: false, lintClean: false, buildSucceeded: false, notes: ["Review response was not valid JSON"] },
      costUsd: 0,
    };
  }
}

/**
 * Reviews code changes in a worktree. Returns the review result.
 * The task should already be in 'reviewing' status.
 */
export async function reviewChanges(
  taskId: string,
  worktreeInfo: WorktreeInfo,
  learningIds?: number[],
): Promise<ReviewGateResult> {
  const startTime = Date.now();
  const config = getAutonomousConfig();
  const model = config.models.gate;

  await register(taskId, "review-gate", model, "reviewing");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const diff = await getGitDiff(worktreeInfo.path, worktreeInfo.baseSha);
    const changedFiles = await getChangedFiles(worktreeInfo.path, worktreeInfo.baseSha);

    const userPrompt = [
      `## Task: ${task.title}`,
      ``,
      task.body,
      ``,
      `## Changed Files`,
      changedFiles.map(f => `- ${f}`).join("\n"),
      ``,
      `## Git Diff`,
      "```",
      diff.substring(0, 50000), // Truncate very large diffs
      "```",
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: getReviewPrompt(),
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    const result = parseReviewResult(response.text);
    result.costUsd = costUsd;

    await recordReview(
      taskId,
      result.verdict,
      task.reworkCount ?? 0,
      result.findings,
      result.securityFindings,
      result.verification,
      costUsd,
    );

    await recordCost(taskId, task.createdBy, "review-gate", model, costUsd, 1, durationMs);

    // Fire-and-forget feedback loop — never blocks or throws
    const findingsText = result.findings
      .map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`)
      .join("\n");
    void fireAndForgetFeedback(taskId, result.verdict, learningIds ?? [], findingsText || undefined);

    // Fire-and-forget review pattern analysis — never blocks or throws
    if (result.findings.length > 0) {
      const repo = await getRepoById(task.repoId);
      void analyzeReviewPatterns(taskId, result.findings, repo?.fullName).catch((err) => {
        logger.error({ taskId, err }, "Review pattern analysis failed (non-blocking)");
      });
    }

    logger.info({ taskId, verdict: result.verdict, costUsd }, "Review gate complete");

    return result;
  } finally {
    await unregister(taskId);
  }
}
