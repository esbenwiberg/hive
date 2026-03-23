import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { callClaudeWithTools, extractJson } from "../agents/sdk.js";
import { getById } from "../db/queries/tasks.js";
import { getById as getRepoById } from "../db/queries/repos.js";
import { recordReview } from "../db/queries/code-reviews.js";
import { recordCost } from "../db/queries/costs.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { fireAndForgetFeedback } from "../agents/feedback-loop.js";
import { analyzeReviewPatterns } from "../agents/code-quality-analyst.js";
import { loadPrompt } from "../prompt-cache.js";
import { REVIEW_TOOLS, createWorktreeToolExecutor } from "./worker-tools.js";
import type { ReviewGateResult, SecurityFinding, VerificationResult, WorktreeInfo } from "../domain/types.js";
import type { ArchitectBlueprint } from "../enrichers/architect.js";

const execFileAsync = promisify(execFile);

// Lock / generated / vendored files excluded from review diffs and changed-file
// lists.  These inflate diffs, aren't human-reviewable, and cause the worker to
// waste context trying to revert them when flagged as "out-of-scope".
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
  return loadPrompt("review-gate");
}

/**
 * Validates that baseSha is an ancestor of the current HEAD and returns a
 * corrected baseSha if not.  When the worktree was recovered from a remote
 * branch but baseSha wasn't updated (e.g. loaded from the database), the diff
 * would include unrelated changes from main.  This safety check prevents that.
 */
export async function validateBaseSha(worktreePath: string, baseSha: string): Promise<string> {
  try {
    // `merge-base --is-ancestor A B` exits 0 if A is an ancestor of B, 1 otherwise
    await execFileAsync("git", ["merge-base", "--is-ancestor", baseSha, "HEAD"], { cwd: worktreePath });
    return baseSha; // baseSha is a valid ancestor — no correction needed
  } catch {
    // baseSha is NOT an ancestor of HEAD — likely stale (main advanced past the branch fork)
    logger.warn({ worktreePath, baseSha }, "baseSha is not an ancestor of HEAD — recomputing merge-base");
    try {
      const { stdout } = await execFileAsync("git", ["merge-base", baseSha, "HEAD"], { cwd: worktreePath });
      const corrected = stdout.trim();
      logger.info({ worktreePath, original: baseSha, corrected }, "baseSha corrected via merge-base");
      return corrected;
    } catch {
      // Last resort: fall back to original baseSha so the review still runs
      logger.warn({ worktreePath, baseSha }, "merge-base also failed — using original baseSha");
      return baseSha;
    }
  }
}

/**
 * Gets the git diff of all changes in the worktree (committed + uncommitted)
 * relative to the base SHA the feature branch was created from.
 */
async function getGitDiff(worktreePath: string, baseSha: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "-U10", baseSha, "--", ...REVIEW_EXCLUDED_PATHSPECS], { cwd: worktreePath, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    logger.warn({ worktreePath, baseSha, err }, "Failed to get git diff for review");
    return "(no diff available)";
  }
}

/**
 * Gets a compact stat summary for the given files relative to baseSha.
 */
async function getFileStat(worktreePath: string, baseSha: string, files: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", baseSha, "--", ...files], { cwd: worktreePath, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return files.map(f => `  ${f} (stat unavailable)`).join("\n");
  }
}

const MAX_REVIEW_DIFF_CHARS = 2_000_000;

/**
 * Truncates a diff at file boundaries. Files that don't fit get a stat-only
 * summary so the reviewer knows they changed and by how much.
 */
async function truncateDiff(
  diff: string,
  changedFiles: string[],
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) return diff;

  // Split into per-file sections (each starts with "diff --git")
  const fileDiffs = diff.split(/(?=^diff --git )/m).filter(Boolean);

  let result = "";
  const includedFiles = new Set<string>();

  for (const fileDiff of fileDiffs) {
    if (result.length + fileDiff.length > MAX_REVIEW_DIFF_CHARS) {
      // If nothing included yet, hard-truncate the first chunk so we never exceed the cap
      if (result.length === 0) {
        result = fileDiff.substring(0, MAX_REVIEW_DIFF_CHARS) + "\n...(truncated)";
        const match = fileDiff.match(/^diff --git a\/(.+?) b\//);
        if (match) includedFiles.add(match[1]);
      }
      break;
    }
    result += fileDiff;
    const match = fileDiff.match(/^diff --git a\/(.+?) b\//);
    if (match) includedFiles.add(match[1]);
  }

  const truncatedFiles = changedFiles.filter(f => !includedFiles.has(f));
  if (truncatedFiles.length > 0) {
    const stat = await getFileStat(worktreePath, baseSha, truncatedFiles);
    result += `\n\n(diff truncated — stat-only summary for remaining ${truncatedFiles.length} file(s))\n${stat}`;
  }

  return result;
}

/**
 * Gets the list of changed files (committed + uncommitted) relative to the base SHA.
 */
async function getChangedFiles(worktreePath: string, baseSha: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", baseSha, "--", ...REVIEW_EXCLUDED_PATHSPECS], { cwd: worktreePath, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.trim().split("\n").filter(Boolean);
  } catch (err) {
    logger.warn({ worktreePath, baseSha, err }, "Failed to get changed files for review");
    return [];
  }
}

/**
 * Captures the current HEAD SHA of the worktree.
 */
async function getHeadSha(worktreePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses the Claude response into a ReviewGateResult.
 * Handles markdown code fences around JSON.
 */
export function parseReviewResult(text: string): ReviewGateResult {
  try {
    const parsed = extractJson(text) as Record<string, unknown>;

    // Normalize any non-pass verdict to "rework" — fail is no longer terminal
    const rawVerdict = parsed.verdict;
    const verdict = rawVerdict === "pass" ? "pass" : "rework";

    return {
      verdict,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      securityFindings: Array.isArray(parsed.securityFindings)
        ? parsed.securityFindings.map((sf: Record<string, unknown>) => ({
            severity: sf.severity as SecurityFinding["severity"],
            type: sf.type as string,
            description: sf.description as string,
            file: sf.file as string | undefined,
            ...(sf.advisory ? { advisory: true as const } : {}),
          }))
        : [],
      verification: (parsed.verification as VerificationResult) ?? {
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
  reviewFixIssues?: string[],
  actualVerification?: { buildSucceeded: boolean; testsPassed: boolean; lintClean: boolean; failures: string[]; warnings: string[] },
): Promise<ReviewGateResult> {
  const startTime = Date.now();
  const model = getModelFor("review-gate");

  await register(taskId, "review-gate", model, "reviewing");

  try {
    const task = await getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const safeSha = await validateBaseSha(worktreeInfo.path, worktreeInfo.baseSha);
    const headSha = await getHeadSha(worktreeInfo.path);

    // Determine rework state and whether we can narrow the diff
    const reworkCount = task.reworkCount ?? 0;
    const reworkHistory = (task.reworkHistory as Array<{
      cycle: number;
      findings?: Array<{ severity: string; file: string; message: string }>;
      securityFindings?: Array<{ severity: string; type: string; description: string }>;
      reviewHeadSha?: string;
    }>) ?? [];
    const lastCycle = reworkCount > 0 && reworkHistory.length > 0
      ? reworkHistory[reworkHistory.length - 1]
      : undefined;
    const lastReviewSha = lastCycle?.reviewHeadSha;

    // On rework with a known prior review SHA, narrow the diff to only what
    // changed since that review.  This structurally prevents the reviewer from
    // finding new issues on code it already approved.
    const isNarrowedRework = reworkCount > 0 && !!lastReviewSha;
    const diffBaseSha = isNarrowedRework ? lastReviewSha! : safeSha;

    const diff = await getGitDiff(worktreeInfo.path, diffBaseSha);
    const changedFiles = await getChangedFiles(worktreeInfo.path, diffBaseSha);
    // Full changed-file list (from branch base) for recording purposes
    const allChangedFiles = isNarrowedRework
      ? await getChangedFiles(worktreeInfo.path, safeSha)
      : changedFiles;

    // Extract expected file scope from architect blueprint
    const enrichment = task.enrichment as Record<string, unknown> | null;
    const architect = enrichment?.architect as ArchitectBlueprint | undefined;
    let expectedFiles: string[] = [];
    if (architect && !architect.skipped) {
      if (architect.milestones?.length) {
        const set = new Set<string>();
        for (const ms of architect.milestones) {
          for (const f of ms.filesToModify) set.add(f);
        }
        expectedFiles = [...set];
      } else if (architect.keyFiles?.length) {
        expectedFiles = architect.keyFiles;
      }
    }

    const promptSections = [
      `## Task: ${task.title}`,
      ``,
      task.body,
      ``,
    ];

    // On narrowed rework, inject the prior findings as a checklist FIRST —
    // this is the reviewer's primary job.
    if (isNarrowedRework && lastCycle) {
      const priorFindings = [
        ...(lastCycle.findings ?? []).map(f => `- [ ] [${f.severity}] ${f.file}: ${f.message}`),
        ...(lastCycle.securityFindings ?? []).map(f => `- [ ] [${f.severity}] [security/${f.type}]: ${f.description}`),
      ];

      promptSections.push(
        `## Rework Review — Cycle ${reworkCount}`,
        ``,
        `This is a **narrowed rework review**. The diff below shows ONLY changes made since the last review.`,
        ``,
        `### Prior Findings Checklist`,
        `Verify whether each finding was addressed:`,
        ...priorFindings,
        ``,
        `### Your Job`,
        `1. Check each prior finding above — was it fixed?`,
        `2. Check the delta diff below for new bugs or regressions introduced by the fix`,
        `3. Do NOT review code outside this delta — it was already approved`,
        `4. If all prior findings are addressed and the fix is clean, verdict is "pass"`,
        ``,
      );
    }

    if (!isNarrowedRework && expectedFiles.length > 0) {
      const outOfScope = changedFiles.filter(f => !expectedFiles.includes(f));
      promptSections.push(
        `## Expected File Scope (rough guide — not a strict boundary)`,
        `Architect suggested: ${expectedFiles.map(f => `\`${f}\``).join(", ")}`,
        `Actually changed: ${changedFiles.map(f => `\`${f}\``).join(", ")}`,
        ...(outOfScope.length > 0
          ? [`Additional files not in architect's list: ${outOfScope.map(f => `\`${f}\``).join(", ")} — these may be valid related changes.`]
          : [`All changes are within the suggested scope.`]),
        ``,
      );
    }

    const reviewDiff = await truncateDiff(diff, changedFiles, worktreeInfo.path, diffBaseSha);

    // Inject actual build/test verification results so the reviewer sees real data
    // instead of guessing from the diff.
    if (actualVerification) {
      promptSections.push(
        `## Build & Test Verification (actual results)`,
        `- **Build**: ${actualVerification.buildSucceeded ? "PASSED" : "FAILED"}`,
        `- **Tests**: ${actualVerification.testsPassed ? "PASSED" : "FAILED"}`,
        `- **Lint**: ${actualVerification.lintClean ? "clean" : "warnings present"}`,
      );
      if (actualVerification.failures.length > 0) {
        promptSections.push(
          `- **Failures**:`,
          ...actualVerification.failures.map(f => `  - ${f.substring(0, 300)}`),
        );
      }
      if (actualVerification.warnings.length > 0) {
        promptSections.push(
          `- **Warnings**:`,
          ...actualVerification.warnings.map(w => `  - ${w.substring(0, 300)}`),
        );
      }
      promptSections.push(
        ``,
        `Use these actual results for the "verification" section of your response — do not guess.`,
        ``,
      );
    }

    const wasTruncated = reviewDiff.length < diff.length;

    promptSections.push(
      `## Changed Files${isNarrowedRework ? " (since last review)" : ""}`,
      changedFiles.map(f => `- ${f}`).join("\n"),
      ``,
      `## Git Diff${isNarrowedRework ? " (delta since last review)" : ""}`,
      ...(wasTruncated
        ? [`**Note: This diff was truncated by the system (${Math.round(diff.length / 1024)}KB → ${Math.round(reviewDiff.length / 1024)}KB). Only review code visible below. Do not flag missing context as an issue.**`]
        : []),
      "```",
      reviewDiff,
      "```",
    );

    // On non-narrowed rework (no reviewHeadSha available), fall back to the
    // old approach: full diff + rework context section.
    if (reworkCount > 0 && !isNarrowedRework && lastCycle) {
      promptSections.push(``, `## Rework Context`);
      promptSections.push(`This is rework cycle ${reworkCount}. The code has been revised to address prior review findings.`);

      const priorFindings = [
        ...(lastCycle.findings ?? []).map(f => `- [${f.severity}] ${f.file}: ${f.message}`),
        ...(lastCycle.securityFindings ?? []).map(f => `- [${f.severity}] [security/${f.type}]: ${f.description}`),
      ];
      if (priorFindings.length > 0) {
        promptSections.push(``, `### Prior Cycle Findings`, ...priorFindings);
      }

      promptSections.push(``, `Focus on whether the prior issues have been addressed. Do not introduce new minor/info findings on unchanged code.`);
    }

    const userPrompt = promptSections.join("\n");

    logger.info(
      { taskId, reworkCount, isNarrowedRework, diffBaseSha, diffChars: diff.length, changedFileCount: changedFiles.length },
      "Review gate prompt built",
    );

    // Capture structured review data if Claude uses the submit_review tool
    let submittedReview: Record<string, unknown> | undefined;

    const response = await callClaudeWithTools({
      prompt: userPrompt,
      model,
      maxTokens: 16384,
      systemPrompt: getReviewPrompt(),
      tools: REVIEW_TOOLS,
      executeTool: createWorktreeToolExecutor(worktreeInfo.path, undefined, undefined, {
        readOnly: true,
        onSubmitReview: (data) => { submittedReview = data; },
      }),
      maxTurns: 10,
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    // Prefer structured tool submission over free-form text parsing
    const result = submittedReview
      ? parseReviewResult(JSON.stringify(submittedReview))
      : parseReviewResult(response.text);
    result.costUsd = costUsd;
    result.changedFiles = allChangedFiles;
    result.reviewHeadSha = headSha;

    await recordReview(
      taskId,
      result.verdict,
      task.reworkCount ?? 0,
      result.findings,
      result.securityFindings,
      result.verification,
      costUsd,
      changedFiles,
    );

    await recordCost(taskId, task.createdBy, "review-gate", model, costUsd, response.turns, durationMs);

    // Fire-and-forget feedback loop — never blocks or throws
    const gateFindings = result.findings
      .map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`)
      .join("\n");
    const reviewFixSection = reviewFixIssues && reviewFixIssues.length > 0
      ? `\n\n## Review-Fix Issues (recurring per-milestone problems)\n${reviewFixIssues.join("\n")}`
      : "";
    const findingsText = (gateFindings + reviewFixSection) || undefined;
    void fireAndForgetFeedback(taskId, result.verdict, learningIds ?? [], findingsText);

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
