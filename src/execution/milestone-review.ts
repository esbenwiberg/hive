import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { callClaude, callClaudeWithTools } from "../agents/sdk.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { WORKER_TOOLS, createWorktreeToolExecutor } from "./worker-tools.js";
import { loadPrompt } from "../prompt-cache.js";
import { detectBuildSystem } from "./build-system.js";
import type { BuildSystemInfo } from "./build-system.js";
import { execInGroup } from "./exec-group.js";

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
const MAX_DIFF_CHARS = 200_000;

// Lock / generated / vendored files excluded from milestone review diffs.
const REVIEW_EXCLUDED_PATHSPECS = [
  // Lock files
  ":!**/package-lock.json",
  ":!**/yarn.lock",
  ":!**/pnpm-lock.yaml",
  ":!**/Cargo.lock",
  ":!**/Gemfile.lock",
  ":!**/composer.lock",
  ":!**/Pipfile.lock",
  ":!**/poetry.lock",
  ":!**/packages.lock.json",
  // Minified / source maps
  ":!**/*.min.js",
  ":!**/*.min.css",
  ":!**/*.js.map",
  ":!**/*.css.map",
  // Vendored / generated directories
  ":!**/node_modules/**",
  ":!**/vendor/**",
  ":!**/dist/**",
  ":!**/.next/**",
  ":!**/.nuxt/**",
  ":!**/build/**",
  ":!**/__pycache__/**",
  ":!**/.venv/**",
  ":!**/venv/**",
  ":!**/target/**",
  ":!**/bin/Debug/**",
  ":!**/bin/Release/**",
  ":!**/obj/**",
];

function getReviewPrompt(): string {
  return loadPrompt("enrichers/milestone-review");
}

function getFixPrompt(): string {
  return loadPrompt("enrichers/milestone-fix");
}

// ── quickVerify ──────────────────────────────────────────────────────────────

/**
 * Runs a single shell command, pushing a failure message if it errors.
 */
async function runStep(
  bin: string,
  args: string[],
  cwd: string,
  label: string,
  failures: string[],
): Promise<boolean> {
  try {
    // Strip NODE_ENV=production so target-repo npm installs include devDependencies.
    // Set CI=true so tools like vitest/jest disable interactive/watch mode.
    const { NODE_ENV: _drop, ...cleanEnv } = process.env;
    cleanEnv.CI = "true";
    cleanEnv.NODE_OPTIONS = [cleanEnv.NODE_OPTIONS, "--max-old-space-size=1536"].filter(Boolean).join(" ");

    // Use process-group-aware exec so timeout kills all descendant processes
    await execInGroup(bin, args, {
      cwd,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: cleanEnv,
    });
    logger.debug({ step: label, cwd }, "quickVerify step passed");
    return true;
  } catch (err: unknown) {
    const error = err as { code?: string; stdout?: string; stderr?: string; message?: string };

    // ENOENT = binary not installed — skip gracefully instead of failing the task
    if (error.code === "ENOENT") {
      logger.info({ step: label, bin, cwd }, "quickVerify step skipped — tool not installed");
      return true;
    }

    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    const detail = output || error.message || "unknown error";
    const message = `${label} failed: ${detail}`;
    failures.push(message);
    logger.warn({ step: label, cwd }, message);
    return false;
  }
}

/**
 * Runs lint, build, and test appropriate for the repo's build system.
 * Detects npm / dotnet / dotnet+npm automatically (or via .hive.yaml override).
 * Collects ALL failures rather than stopping at the first one.
 */
export async function quickVerify(
  worktreePath: string,
  buildSettings?: { system?: string; npmDir?: string },
  options?: { skipInstall?: boolean },
): Promise<QuickVerifyResult> {
  const failures: string[] = [];
  const skipInstall = options?.skipInstall ?? false;

  const info = await detectBuildSystem(worktreePath, undefined, buildSettings);
  logger.info({ worktreePath, buildSystem: info.type, skipInstall }, "quickVerify: detected build system");

  // ── npm steps ────────────────────────────────────────────────────────────
  if (info.type === "npm" || info.type === "dotnet+npm") {
    const npmDir = info.npmDir ?? worktreePath;

    if (!skipInstall) {
      const installed = await runStep(
        "npm", ["install", "--prefer-offline", "--include=dev"],
        npmDir, "npm install", failures,
      );

      if (!installed) {
        logger.warn({ npmDir }, "quickVerify: npm install failed — skipping npm build/test");
        if (info.type === "npm") return { passed: false, failures };
      }
    }

    await runStep("npm", ["run", "lint", "--if-present"], npmDir, "npm lint", failures);
    await runStep("npm", ["run", "build", "--if-present"], npmDir, "npm build", failures);
    await runStep("npm", ["run", "test", "--if-present"], npmDir, "npm test", failures);
  }

  // ── dotnet steps ─────────────────────────────────────────────────────────
  if (info.type === "dotnet" || info.type === "dotnet+npm") {
    const dotnetDir = info.dotnetDir ?? worktreePath;

    if (!skipInstall) {
      const restored = await runStep(
        "dotnet", ["restore", "/p:NuGetAudit=false"],
        dotnetDir, "dotnet restore", failures,
      );

      if (!restored) {
        logger.warn({ dotnetDir }, "quickVerify: dotnet restore failed — skipping dotnet build/test");
        if (info.type === "dotnet") return { passed: false, failures };
      }
    }

    const built = await runStep("dotnet", ["build", "--no-restore"], dotnetDir, "dotnet build", failures);
    if (built) {
      await runStep("dotnet", ["test", "--no-build"], dotnetDir, "dotnet test", failures);
    } else {
      logger.warn({ dotnetDir }, "quickVerify: dotnet build failed — skipping dotnet test");
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
    const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", ...REVIEW_EXCLUDED_PATHSPECS], {
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
      execFileAsync("git", ["diff", "--name-only", "HEAD", "--", ...REVIEW_EXCLUDED_PATHSPECS], { cwd: worktreePath, timeout: SHELL_TIMEOUT_MS }),
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
  maxTurns: number,
  buildInfo?: BuildSystemInfo,
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
    executeTool: createWorktreeToolExecutor(worktreePath, undefined, buildInfo),
    maxTurns,
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
  buildSettings?: { system?: string; npmDir?: string },
  buildInfo?: BuildSystemInfo,
  options?: { skipInstall?: boolean },
): Promise<ReviewFixResult> {
  const autonomousConfig = getAutonomousConfig();
  const maxIterations = autonomousConfig.reviewFix.maxIterations;
  const fixMaxTurns = autonomousConfig.reviewFix.fixMaxTurns;
  const reviewModel = getModelFor("milestone-review");
  const fixModel = autonomousConfig.models.components["milestone-fix"] ?? model;

  let totalCostUsd = 0;
  const allIssues: string[] = [];
  let passed = false;
  let priorIterationIssues: string[] | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.info({ iteration, maxIterations, worktreePath, reviewModel, fixModel }, "review-fix iteration start");

    // Step 1: Run shell verification
    const verify = await quickVerify(worktreePath, buildSettings, options);
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
    const fix = await claudeFix(worktreePath, milestoneSummary, iterationIssues, changedFiles, fixModel, fixMaxTurns, buildInfo);
    totalCostUsd += fix.costUsd;
    logger.info({ iteration, costUsd: fix.costUsd, worktreePath }, "review-fix claudeFix done");

    // After the last iteration, do a final verify to see if fixes worked
    if (iteration === maxIterations) {
      const finalVerify = await quickVerify(worktreePath, buildSettings, options);
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
