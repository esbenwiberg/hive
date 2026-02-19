import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { callClaude, callClaudeWithTools } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
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
  const commands: { label: string; args: string[] }[] = [
    { label: "lint", args: ["run", "lint", "--if-present"] },
    { label: "build", args: ["run", "build", "--if-present"] },
    { label: "test", args: ["run", "test", "--if-present"] },
  ];

  const failures: string[] = [];

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
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD~1"], {
      cwd: worktreePath,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // If HEAD~1 fails (e.g., first commit), fall back to showing all staged/tracked
    try {
      const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
        cwd: worktreePath,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "(no diff available)";
    }
  }
}

/**
 * Gets the list of changed file paths for context in fix prompts.
 */
async function getChangedFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD~1"], {
      cwd: worktreePath,
      timeout: SHELL_TIMEOUT_MS,
    });
    return stdout.trim().split("\n").filter(Boolean);
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
 * Returns the list of issues and cost in USD.
 */
async function claudeReview(
  diff: string,
  model: string,
): Promise<{ issues: string[]; costUsd: number }> {
  const truncatedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.substring(0, MAX_DIFF_CHARS) + "\n...(truncated)"
    : diff;

  const response = await callClaude({
    prompt: truncatedDiff,
    model,
    systemPrompt: getReviewPrompt(),
  });

  const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
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

  const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
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
 */
export async function reviewFix(
  worktreePath: string,
  milestoneSummary: string,
  model: string,
  maxIterations: number = 2,
): Promise<ReviewFixResult> {
  let totalCostUsd = 0;
  const allIssues: string[] = [];
  let passed = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.info({ iteration, maxIterations, worktreePath }, "review-fix iteration start");

    // Step 1: Run shell verification
    const verify = await quickVerify(worktreePath);
    const shellIssues = verify.failures;

    let reviewIssues: string[] = [];

    if (verify.passed) {
      // Step 2: Shell passed — ask Claude to review the diff for logical issues
      const diff = await getDiff(worktreePath);
      const review = await claudeReview(diff, model);
      totalCostUsd += review.costUsd;
      reviewIssues = review.issues;
    }

    // Combine all issues from this iteration
    const iterationIssues = [...shellIssues, ...reviewIssues];

    if (iterationIssues.length === 0) {
      // Everything is clean
      passed = true;
      logger.info({ iteration, worktreePath }, "review-fix passed — no issues found");
      break;
    }

    // Record the issues found
    allIssues.push(...iterationIssues);
    logger.info(
      { iteration, issueCount: iterationIssues.length, worktreePath },
      "review-fix found issues, requesting fix",
    );

    // Step 3: Ask Claude to fix
    const changedFiles = await getChangedFiles(worktreePath);
    const fix = await claudeFix(worktreePath, milestoneSummary, iterationIssues, changedFiles, model);
    totalCostUsd += fix.costUsd;

    // After the last iteration, do a final verify to see if fixes worked
    if (iteration === maxIterations) {
      const finalVerify = await quickVerify(worktreePath);
      if (finalVerify.passed) {
        // Final shell check passed — do one last Claude review
        const diff = await getDiff(worktreePath);
        const finalReview = await claudeReview(diff, model);
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
