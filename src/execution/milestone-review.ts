import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { callClaude, callClaudeWithTools } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { WORKER_TOOLS, createWorktreeToolExecutor } from "./worker-tools.js";
import { loadPrompt } from "../prompt-cache.js";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────────

export interface QuickVerifyResult {
  passed: boolean;
  failures: string[];
}

export interface ReviewFixResult {
  passed: boolean;
  iterations: number;
  issues: string[];
  costUsd: number;
}

interface ClaudeReviewResponse {
  issues: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const SHELL_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 50_000;

function getReviewPrompt(): string {
  return loadPrompt("enrichers/milestone-review");
}

function getFixPrompt(): string {
  return loadPrompt("enrichers/milestone-fix");
}

// ── quickVerify ──────────────────────────────────────────────────────────────

/**
 * Runs lint, build, and test sequentially via npm with `--if-present`.
 * Collects ALL failures rather than stopping at the first one.
 */
export async function quickVerify(worktreePath: string): Promise<QuickVerifyResult> {
  const failures: string[] = [];

  // Install dependencies first — worktrees don't inherit node_modules from the parent.
  try {
    await execFileAsync("npm", ["install", "--prefer-offline"], {
      cwd: worktreePath,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    logger.debug({ worktreePath }, "quickVerify: npm install passed");
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    const detail = output || error.message || "unknown error";
    failures.push(`install failed: ${detail}`);
    logger.warn({ worktreePath }, `quickVerify: npm install failed — skipping build/test`);
    return { passed: false, failures };
  }

  const commands: { label: string; args: string[] }[] = [
    { label: "lint", args: ["run", "lint", "--if-present"] },
    { label: "build", args: ["run", "build", "--if-present"] },
    { label: "test", args: ["run", "test", "--if-present"] },
  ];

  for (const cmd of commands) {
    try {
      await execFileAsync("npm", cmd.args, {
        cwd: worktreePath,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      logger.debug({ step: cmd.label, worktreePath }, "quickVerify step passed");
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      const detail = output || error.message || "unknown error";
      const message = `${cmd.label} failed: ${detail}`;
      failures.push(message);
      logger.warn({ step: cmd.label, worktreePath }, message);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Gets the git diff for review. Falls back gracefully.
 */
async function getDiff(worktreePath: string): Promise<string> {
  // Diff against HEAD (not HEAD~1): reviewFix runs before commitMilestone, so milestone
  // changes are still uncommitted. HEAD~1 would pull in the previous committed milestone,
  // causing the reviewer to see a growing compound diff and flag already-reviewed code.
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
      cwd: worktreePath,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout || "(no diff available)";
  } catch {
    return "(no diff available)";
  }
}

/**
 * Gets the list of changed file paths for context in fix prompts.
 * Includes both modified tracked files and new untracked files.
 */
async function getChangedFiles(worktreePath: string): Promise<string[]> {
  try {
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: worktreePath, timeout: SHELL_TIMEOUT_MS }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath, timeout: SHELL_TIMEOUT_MS }),
    ]);
    return [...tracked.trim().split("\n"), ...untracked.trim().split("\n")].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Parses a Claude JSON response, stripping markdown code fences if present.
 */
function parseReviewJson(text: string): ClaudeReviewResponse {
  const cleaned = text
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as ClaudeReviewResponse;
    if (!Array.isArray(parsed.issues)) {
      return { issues: [] };
    }
    return parsed;
  } catch {
    logger.warn({ text: text.substring(0, 200) }, "Failed to parse review JSON, treating as no issues");
    return { issues: [] };
  }
}

/**
 * Asks Claude to review the diff for logical issues.
 * When `priorIssues` is provided, the prompt focuses on verifying those are fixed + new issues.
 * Returns the list of issues and cost in USD.
 */
async function claudeReview(
  diff: string,
  model: string,
  priorIssues?: string[],
): Promise<{ issues: string[]; costUsd: number }> {
  const truncatedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.substring(0, MAX_DIFF_CHARS) + "\n...(truncated)"
    : diff;

  let prompt = truncatedDiff;
  if (priorIssues && priorIssues.length > 0) {
    const issueList = priorIssues.map((i) => `- ${i}`).join("\n");
    prompt = [
      "## Previously Identified Issues",
      issueList,
      "",
      "Verify these are resolved AND check for any NEW issues introduced by the fixes.",
      "",
      truncatedDiff,
    ].join("\n");
  }

  const response = await callClaude({
    prompt,
    model,
    systemPrompt: getReviewPrompt(),
  });

  const { cost } = response;
  const costUsd = estimateCostUsd(
    cost.inputTokens, cost.outputTokens,
    undefined, undefined,
    cost.cacheCreationInputTokens, cost.cacheReadInputTokens,
  );
  const parsed = parseReviewJson(response.text);

  return { issues: parsed.issues, costUsd };
}

/**
 * Asks Claude to fix the identified issues using tools to read and write files directly.
 * Returns cost in USD.
 */
async function claudeFix(
  worktreePath: string,
  milestoneSummary: string,
  errors: string[],
  changedFiles: string[],
  model: string,
): Promise<{ costUsd: number }> {
  const prompt = [
    "## Milestone",
    milestoneSummary,
    "",
    "## Errors / Issues to Fix",
    errors.map((e) => `- ${e}`).join("\n"),
    "",
    "## Changed Files",
    changedFiles.map((f) => `- ${f}`).join("\n"),
    "",
    "## Working Directory",
    worktreePath,
    "",
    "Read the files above, apply the minimal fixes needed, and verify with a build.",
  ].join("\n");

  const response = await callClaudeWithTools({
    prompt,
    model,
    systemPrompt: getFixPrompt(),
    tools: WORKER_TOOLS,
    executeTool: createWorktreeToolExecutor(worktreePath),
  });

  const { cost } = response;
  const costUsd = estimateCostUsd(
    cost.inputTokens, cost.outputTokens,
    undefined, undefined,
    cost.cacheCreationInputTokens, cost.cacheReadInputTokens,
  );
  return { costUsd };
}

// ── reviewFix ────────────────────────────────────────────────────────────────

/**
 * Per-milestone review-fix loop:
 *
 * 1. Run `quickVerify()` (lint, build, test)
 * 2. If shell passes, call Claude for a code review of the diff
 * 3. If shell or Claude finds issues, call Claude to generate fixes
 * 4. Re-run quickVerify + optional Claude re-review
 * 5. Repeat up to `maxIterations`
 * 6. Return consolidated result
 *
 * Uses separately configurable models for review (milestone-review) and fix (milestone-fix).
 * The `model` parameter is used as fallback for the fix model.
 */
export async function reviewFix(
  worktreePath: string,
  milestoneSummary: string,
  model: string,
  maxIterations: number = 2,
): Promise<ReviewFixResult> {
  const reviewModel = getModelFor("milestone-review");
  const fixModel = getModelFor("milestone-fix") !== getModelFor("default")
    ? getModelFor("milestone-fix")
    : model; // fall back to worker model if milestone-fix not explicitly configured

  let totalCostUsd = 0;
  const allIssues: string[] = [];
  let passed = false;
  let priorIterationIssues: string[] | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.info({ iteration, maxIterations, worktreePath, reviewModel, fixModel }, "review-fix iteration start");

    // Step 1: Run shell verification
    const verify = await quickVerify(worktreePath);
    const shellIssues = verify.failures;
    logger.info({ iteration, passed: verify.passed, failureCount: shellIssues.length, worktreePath }, "review-fix quickVerify done");

    let reviewIssues: string[] = [];

    if (verify.passed) {
      // Step 2: Shell passed — ask Claude to review the diff for logical issues
      const diff = await getDiff(worktreePath);
      logger.info({ iteration, diffChars: diff.length, worktreePath }, "review-fix calling claudeReview");
      const review = await claudeReview(diff, reviewModel, priorIterationIssues);
      totalCostUsd += review.costUsd;
      reviewIssues = review.issues;
      logger.info({ iteration, issueCount: reviewIssues.length, costUsd: review.costUsd, worktreePath }, "review-fix claudeReview done");
    }

    // Combine all issues from this iteration
    const iterationIssues = [...shellIssues, ...reviewIssues];

    if (iterationIssues.length === 0) {
      // Everything is clean
      passed = true;
      logger.info({ iteration, worktreePath }, "review-fix passed — no issues found");
      break;
    }

    // Record the issues found and thread them for incremental review
    allIssues.push(...iterationIssues);
    priorIterationIssues = iterationIssues;
    logger.info(
      { iteration, issueCount: iterationIssues.length, worktreePath },
      "review-fix found issues, requesting fix",
    );

    // Step 3: Ask Claude to fix
    const changedFiles = await getChangedFiles(worktreePath);
    logger.info({ iteration, issueCount: iterationIssues.length, changedFileCount: changedFiles.length, worktreePath }, "review-fix calling claudeFix");
    const fix = await claudeFix(worktreePath, milestoneSummary, iterationIssues, changedFiles, fixModel);
    totalCostUsd += fix.costUsd;
    logger.info({ iteration, costUsd: fix.costUsd, worktreePath }, "review-fix claudeFix done");

    // After the last iteration, do a final verify to see if fixes worked
    if (iteration === maxIterations) {
      const finalVerify = await quickVerify(worktreePath);
      if (finalVerify.passed) {
        // Final shell check passed — do one last Claude review (incremental)
        const diff = await getDiff(worktreePath);
        const finalReview = await claudeReview(diff, reviewModel, priorIterationIssues);
        totalCostUsd += finalReview.costUsd;

        if (finalReview.issues.length === 0) {
          passed = true;
          logger.info({ iteration, worktreePath }, "review-fix passed after final fix");
        } else {
          allIssues.push(...finalReview.issues);
        }
      } else {
        allIssues.push(...finalVerify.failures);
      }
    }
  }

  logger.info(
    { passed, iterations: Math.min(maxIterations, allIssues.length > 0 ? maxIterations : 1), costUsd: totalCostUsd, worktreePath },
    "review-fix loop complete",
  );

  return {
    passed,
    iterations: maxIterations,
    issues: allIssues,
    costUsd: totalCostUsd,
  };
}
