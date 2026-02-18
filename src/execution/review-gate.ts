import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { callClaude } from "../agents/sdk.js";
import { getById } from "../db/queries/tasks.js";
import { recordReview } from "../db/queries/code-reviews.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { ReviewGateResult, WorktreeInfo } from "../domain/types.js";

const execFileAsync = promisify(execFile);

let reviewPrompt: string | undefined;

function getReviewPrompt(): string {
  if (!reviewPrompt) {
    reviewPrompt = readFileSync(resolve("prompts/review-gate.md"), "utf-8");
  }
  return reviewPrompt;
}

/**
 * Gets the git diff between the feature branch and the default branch.
 */
async function getGitDiff(worktreePath: string): Promise<string> {
  try {
    // Find the merge-base with the default branch to capture all commits on the feature branch
    const { stdout: mergeBase } = await execFileAsync("git", ["merge-base", "origin/HEAD", "HEAD"], { cwd: worktreePath });
    const base = mergeBase.trim();
    const { stdout } = await execFileAsync("git", ["diff", "--stat", `${base}..HEAD`], { cwd: worktreePath });
    const { stdout: fullDiff } = await execFileAsync("git", ["diff", `${base}..HEAD`], { cwd: worktreePath, maxBuffer: 1024 * 1024 });
    return `${stdout}\n\n${fullDiff}`;
  } catch {
    // Fallback: try HEAD~1 for repos without origin/HEAD configured
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD~1..HEAD"], { cwd: worktreePath });
      const { stdout: fullDiff } = await execFileAsync("git", ["diff", "HEAD~1..HEAD"], { cwd: worktreePath, maxBuffer: 1024 * 1024 });
      return `${stdout}\n\n${fullDiff}`;
    } catch {
      // If no commits yet or single commit, diff against empty tree
      try {
        const { stdout } = await execFileAsync("git", ["diff", "--cached"], { cwd: worktreePath });
        return stdout;
      } catch {
        return "(no diff available)";
      }
    }
  }
}

/**
 * Gets the list of changed files.
 */
async function getChangedFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout: mergeBase } = await execFileAsync("git", ["merge-base", "origin/HEAD", "HEAD"], { cwd: worktreePath });
    const base = mergeBase.trim();
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}..HEAD`], { cwd: worktreePath });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    // Fallback: try HEAD~1 for repos without origin/HEAD configured
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD~1..HEAD"], { cwd: worktreePath });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  const config = getAutonomousConfig();
  return (inputTokens * config.models.inputCostPerM + outputTokens * config.models.outputCostPerM) / 1_000_000;
}

/**
 * Parses the Claude response into a ReviewGateResult.
 * Handles markdown code fences around JSON.
 */
export function parseReviewResult(text: string): ReviewGateResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

  try {
    const parsed = JSON.parse(cleaned);

    const verdict = parsed.verdict;
    if (!["pass", "rework", "fail"].includes(verdict)) {
      throw new Error(`Invalid verdict: ${verdict}`);
    }

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
): Promise<ReviewGateResult> {
  const startTime = Date.now();
  const config = getAutonomousConfig();
  const model = config.models.gate;

  await register(taskId, "review-gate", model, "reviewing");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const diff = await getGitDiff(worktreeInfo.path);
    const changedFiles = await getChangedFiles(worktreeInfo.path);

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

    logger.info({ taskId, verdict: result.verdict, costUsd }, "Review gate complete");

    return result;
  } finally {
    await unregister(taskId);
  }
}
