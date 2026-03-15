import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { execInGroup, getNodeHeapLimitMB } from "./exec-group.js";
import { eq } from "drizzle-orm";
import logger from "../logger.js";
import { callClaudeWithTools } from "../agents/sdk.js";
import { getWorkerTools, createWorktreeToolExecutor, type PrismConfig } from "./worker-tools.js";
import { getById as getTask, updateStatus } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";
import { recordCost, checkBudget, getTotalCostForTask } from "../db/queries/costs.js";
import { register, unregister, heartbeat } from "../db/queries/active-agents.js";
import { addEvent } from "../db/queries/task-events.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "../agents/cost-utils.js";
import { retrieveRelevantLearnings, buildRetrievalTags } from "../db/queries/learnings.js";
import { createWorktree, cleanupWorktree, resolveGitCredentials } from "./worktree.js";
import { getGitProvider } from "./git-provider.js";
import { reviewChanges, validateBaseSha } from "./review-gate.js";
import { reviewFix, quickVerify } from "./milestone-review.js";
import { detectBuildSystem } from "./build-system.js";
import type { BuildSystemInfo } from "./build-system.js";
import { refineTask } from "../agents/refiner.js";
import { parseHiveYaml } from "../hive-yaml.js";
import type { PreviewConfig, BasePreviewConfig, ComposePreviewConfig, TestcontainersPreviewConfig, ProcessPreviewConfig } from "../hive-yaml.js";
import { previewManager, getExternalPreviewUrl, getLocalPreviewUrl } from "./preview/manager.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { loadPrompt } from "../prompt-cache.js";
import type { ArchitectBlueprint, ArchitectMilestone } from "../enrichers/architect.js";
import type { ReviewGateResult, WorkerResult, WorktreeInfo } from "../domain/types.js";

const MAX_REWORK_CYCLES = 2;

/**
 * Builds a PreviewConfig from repo.settings.preview when no `.hive.yaml` exists.
 * Returns null if the settings don't contain enough info for a valid config.
 */
export function buildPreviewConfigFromSettings(
  preview: Record<string, unknown>,
): PreviewConfig | null {
  const type = preview.type as string | undefined;
  if (!type || !["compose", "testcontainers", "process"].includes(type)) {
    return null;
  }

  const port = preview.port as number | undefined;
  if (typeof port !== "number") {
    return null;
  }

  const base: BasePreviewConfig = {
    type: type as BasePreviewConfig["type"],
    port,
    health_check: typeof preview.health_check === "string" ? preview.health_check : undefined,
    startup_timeout: typeof preview.startup_timeout === "number" ? preview.startup_timeout : undefined,
    env: preview.env && typeof preview.env === "object" ? (preview.env as Record<string, string>) : undefined,
  };

  if (type === "compose") {
    const compose_file = preview.compose_file as string | undefined;
    const app_service = preview.app_service as string | undefined;
    if (!compose_file || !app_service) return null;
    return { ...base, type: "compose", compose_file, app_service } as ComposePreviewConfig;
  }

  if (type === "testcontainers" || type === "process") {
    const start_command = preview.start_command as string | undefined;
    if (!start_command) return null;
    return { ...base, type, start_command } as TestcontainersPreviewConfig | ProcessPreviewConfig;
  }

  return null;
}

const execFileAsync = promisify(execFile);

function getFlowPrompt(): string {
  return loadPrompt("flow");
}

/** Builds a `## Build System` prompt section from detected build info. */
function buildSystemPromptSection(info: BuildSystemInfo, repoDir: string): string {
  const lines: string[] = [`## Build System`, `Type: ${info.type}`];
  if (info.npmDir) {
    const rel = info.npmDir === repoDir ? "./" : "./" + info.npmDir.slice(repoDir.length + 1);
    lines.push(`npm directory: ${rel}`);
    lines.push(
      `Dependencies are pre-installed. Do NOT run \`npm install\`, \`npm ci\`, or \`npm i\` — they waste time and may fail. ` +
      `Just run \`npm run build\`, \`npm run test\`, \`npm run lint\`, etc. directly.`,
    );
    if (rel !== "./") {
      lines.push(
        `The package.json is in \`${rel}\`, not the repo root. ` +
        `npm/npx commands via run_command automatically execute in the correct directory — ` +
        `do NOT use cd, --prefix, or bash wrappers to change directory. Just run \`npm\` or \`npx\` directly.`,
      );
    }
  }
  if (info.dotnetDir) {
    const rel = info.dotnetDir === repoDir ? "./" : "./" + info.dotnetDir.slice(repoDir.length + 1);
    lines.push(`dotnet directory: ${rel}`);
    lines.push(`Packages are pre-restored. Do NOT run \`dotnet restore\` — just run \`dotnet build\`, \`dotnet test\`, etc. directly.`);
  }
  return lines.join("\n");
}

/**
 * Reads project instruction files (CLAUDE.md, .cursorrules, etc.) from the
 * worktree root. Returns the full contents as a prompt section, or empty
 * string if none are found. Capped to prevent context overflow.
 */
const PROJECT_INSTRUCTION_FILES = ["CLAUDE.md", ".cursorrules"] as const;
const MAX_INSTRUCTIONS_CHARS = 12_000;

async function readProjectInstructions(worktreePath: string): Promise<string> {
  const sections: string[] = [];
  let totalChars = 0;

  for (const fileName of PROJECT_INSTRUCTION_FILES) {
    try {
      const content = await readFile(`${worktreePath}/${fileName}`, "utf-8");
      if (!content.trim()) continue;

      const trimmed = content.slice(0, MAX_INSTRUCTIONS_CHARS - totalChars);
      sections.push(`### ${fileName}\n\n${trimmed}`);
      totalChars += trimmed.length;

      if (totalChars >= MAX_INSTRUCTIONS_CHARS) break;
    } catch {
      // File doesn't exist — expected
    }
  }

  if (sections.length === 0) return "";

  return [
    "\n## Project Instructions",
    "These instructions come from the repository and MUST be followed:",
    "",
    ...sections,
  ].join("\n");
}

// ── PR helpers ────────────────────────────────────────────────────────────────

/**
 * Formats the architect blueprint as a markdown PR body.
 * Falls back to task description if no blueprint is available.
 */
function formatPRBody(taskId: string, taskBody: string, bp: ArchitectBlueprint | undefined): string {
  if (!bp || bp.skipped || !bp.approach) {
    return `## Task Description\n\n${taskBody}\n\n---\n_Automated by Hive - Task ${taskId}_`;
  }

  const sections: string[] = [`## Blueprint\n\n**Approach:** ${bp.approach}`];

  if (bp.keyFiles?.length) {
    sections.push(`\n**Key files:** ${bp.keyFiles.map(f => `\`${f}\``).join(", ")}`);
  }

  if (bp.checklist?.length) {
    sections.push(`\n### Checklist\n${bp.checklist.map(c => `- [ ] ${c}`).join("\n")}`);
  }

  if (bp.milestones?.length) {
    sections.push(`\n### Milestones\n${bp.milestones.map((m: ArchitectMilestone, i: number) =>
      `${i + 1}. **${m.title}** — ${m.description}${m.acceptanceCriteria?.length ? `\n${m.acceptanceCriteria.map(a => `   - ${a}`).join("\n")}` : ""}`
    ).join("\n")}`);
  }

  sections.push(`\n---\n_Automated by Hive - Task ${taskId}_`);
  return sections.join("\n");
}

interface ReworkCommentContext {
  cycle: number;
  source: "pr_feedback" | "review_gate" | "browser_validation" | "build_failure";
  feedbackComments?: string[];
}

/**
 * Formats the review gate result as a human-friendly PR comment.
 * When reworkContext is provided, produces a scoped "feedback fix" summary
 * instead of a full PR review summary.
 */
function formatReviewComment(taskId: string, result: ReviewGateResult, reworkContext?: ReworkCommentContext): string {
  // For PR feedback rework cycles, produce a scoped summary
  if (reworkContext?.source === "pr_feedback") {
    const sections: string[] = [`## Hive Feedback Fix (cycle ${reworkContext.cycle})\n`];

    if (reworkContext.feedbackComments?.length) {
      sections.push(
        `### Addressed Feedback\n${reworkContext.feedbackComments.map(c => `> ${c}`).join("\n")}`
      );
    }

    const v = result.verification;
    const checks = [
      `- Build: ${v.buildSucceeded ? "passed" : "not verified"}`,
      `- Tests: ${v.testsRun ? (v.testsPassed ? "passed" : "**failed**") : "not run"}`,
      `- Lint: ${v.lintClean ? "clean" : "not verified"}`,
    ];
    sections.push(`\n### Verification\n${checks.join("\n")}`);

    const nonInfoFindings = result.findings.filter(f => f.severity !== "info");
    if (nonInfoFindings.length > 0) {
      sections.push(`\n### Findings\n${nonInfoFindings.map(f =>
        `- **${f.severity}** ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""} — ${f.message}`
      ).join("\n")}`);
    } else {
      sections.push("\nNo issues found.");
    }

    sections.push(`\n---\n_Automated fix by Hive - Task ${taskId}_`);
    return sections.join("\n");
  }

  const sections: string[] = [`## Hive Review Summary\n`];

  // Verification status
  const v = result.verification;
  const checks = [
    `- Build: ${v.buildSucceeded ? "passed" : "not verified"}`,
    `- Tests: ${v.testsRun ? (v.testsPassed ? "passed" : "**failed**") : "not run"}`,
    `- Lint: ${v.lintClean ? "clean" : "not verified"}`,
  ];
  sections.push(`### Verification\n${checks.join("\n")}`);

  if (v.notes?.length) {
    sections.push(`\n${v.notes.map(n => `> ${n}`).join("\n")}`);
  }

  // Findings
  const nonInfoFindings = result.findings.filter(f => f.severity !== "info");
  const infoFindings = result.findings.filter(f => f.severity === "info");

  if (nonInfoFindings.length > 0) {
    sections.push(`\n### Findings\n${nonInfoFindings.map(f =>
      `- **${f.severity}** ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""} — ${f.message}`
    ).join("\n")}`);
  }

  if (infoFindings.length > 0) {
    sections.push(`\n### Notes\n${infoFindings.map(f =>
      `- ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""} ${f.message}`
    ).join("\n")}`);
  }

  if (result.findings.length === 0) {
    sections.push("\nNo issues found.");
  }

  // Security — separate blocking from advisory
  const blockingSecFindings = result.securityFindings.filter(f => !f.advisory);
  const advisorySecFindings = result.securityFindings.filter(f => f.advisory);

  if (blockingSecFindings.length > 0) {
    sections.push(`\n### Security\n${blockingSecFindings.map(f =>
      `- **${f.severity}** [${f.type}] ${f.file ? `\`${f.file}\`` : ""} — ${f.description}`
    ).join("\n")}`);
  }

  if (advisorySecFindings.length > 0) {
    sections.push(`\n### Security Notes (Advisory)\n${advisorySecFindings.map(f =>
      `- **${f.severity}** [${f.type}] ${f.file ? `\`${f.file}\`` : ""} — ${f.description}`
    ).join("\n")}`);
  }

  // Forced pass note: findings present but verdict is pass (auto-approved at max cycles)
  const hasOutstandingFindings = result.findings.length > 0 || blockingSecFindings.length > 0;
  if (result.verdict === "pass" && hasOutstandingFindings) {
    sections.push(`\n> **Note:** This PR was auto-approved after max rework cycles. Outstanding findings above are for human review.`);
  }

  sections.push(`\n---\n_Automated review by Hive - Task ${taskId}_`);
  return sections.join("\n");
}

// ── Milestone helpers ─────────────────────────────────────────────────────────

/**
 * Commits all changes in the worktree for the given milestone.
 * Silently succeeds when there is nothing to commit (empty working tree).
 */
async function commitMilestone(
  worktreePath: string,
  title: string,
  taskId: string,
): Promise<void> {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    await execFileAsync(
      "git",
      ["commit", "-m", `feat: ${title}\n\nTask: ${taskId}`],
      { cwd: worktreePath },
    );
  } catch (err: unknown) {
    // Exit code 1 from `git commit` means "nothing to commit" — that's fine.
    const code = (err as { code?: number }).code;
    if (code !== 1) {
      throw err;
    }
    logger.debug({ worktreePath, title }, "commitMilestone: nothing to commit");
  }
}

/**
 * Executes an architect blueprint milestone-by-milestone:
 *
 * For each milestone:
 *  1. Build a milestone-scoped prompt
 *  2. Call Claude for implementation
 *  3. Run reviewFix (lint/build/test + AI review-fix loop)
 *  4. Commit the milestone
 *  5. Accumulate a summary for subsequent milestones
 */
async function executeMilestones(
  task: { id: string; title: string; body: string },
  worktreePath: string,
  blueprint: ArchitectBlueprint,
  model: string,
  learningsStr: string,
  startFrom: number = 0,
  pushFn?: () => Promise<void>,
  prismConfig?: PrismConfig,
  buildSystemSection?: string,
  buildSettings?: { system?: string; npmDir?: string },
  buildInfo?: BuildSystemInfo,
  signal?: AbortSignal,
): Promise<{ totalCostUsd: number; reviewFixIssues: string[] }> {
  const milestones = blueprint.milestones!;
  let totalCostUsd = 0;
  const priorSummaries: string[] = [];
  const reviewFixIssues: string[] = [];

  // Read project instructions once for all milestones
  const projectInstructions = await readProjectInstructions(worktreePath);

  // Pre-populate summaries for already-completed milestones so Claude has context
  for (let j = 0; j < startFrom; j++) {
    priorSummaries.push(`${milestones[j].title} — completed (prior run)`);
  }

  if (startFrom > 0) {
    await addEvent(task.id, "milestone_resumed", "worker",
      `Resuming from milestone ${startFrom + 1}/${milestones.length} (${startFrom} already completed)`);
    logger.info(
      { taskId: task.id, startFrom, total: milestones.length },
      "Resuming milestones from prior progress",
    );
  }

  for (let i = startFrom; i < milestones.length; i++) {
    const ms = milestones[i];
    await addEvent(task.id, "milestone_started", "worker", `Milestone ${i + 1}/${milestones.length}: ${ms.title}`);
    await heartbeat(task.id);
    logger.info(
      { taskId: task.id, milestone: i + 1, total: milestones.length, title: ms.title },
      "Starting milestone",
    );

    // ── 1. Build milestone-scoped prompt ──────────────────────────────────
    const sections: string[] = [
      `## Task: ${task.title}`,
      "",
      task.body,
      "",
      `## Overall Approach`,
      blueprint.approach,
      "",
      `## Current Milestone (${i + 1}/${milestones.length}): ${ms.title}`,
      "",
      ms.description,
      "",
      `### Files to Modify`,
      ms.filesToModify.map((f) => `- ${f}`).join("\n"),
      "",
      `### Acceptance Criteria`,
      ms.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
    ];

    if (priorSummaries.length > 0) {
      sections.push(
        "",
        `## Prior Milestones (already committed)`,
        priorSummaries.map((s, idx) => `${idx + 1}. ${s}`).join("\n"),
      );
    }

    if (projectInstructions) {
      sections.push(projectInstructions);
    }

    if (learningsStr) {
      sections.push(learningsStr);
    }

    if (buildSystemSection) {
      sections.push("", buildSystemSection);
    }

    sections.push("", `## Working Directory`, worktreePath);

    const milestonePrompt = sections.join("\n");

    const systemPrompt = [
      getFlowPrompt(),
      "",
      "## Milestone Mode",
      "You are implementing a single milestone of a larger task.",
      "Focus exclusively on this milestone's scope.",
      "Only modify listed files unless absolutely necessary.",
      "Previous milestones have already been committed — build on their changes.",
      "Ensure your changes satisfy the milestone's acceptance criteria.",
    ].join("\n");

    // ── 2. Call Claude for implementation ─────────────────────────────────
    await addEvent(task.id, "claude_call_started", "worker", `Calling Claude (${model})`);
    await heartbeat(task.id);

    const msFiles = ms.filesToModify.map(f => `\`${f}\``).join(", ");
    const msHasWritten = (calls: string[]) => calls.includes("write_file") || calls.includes("edit_file");

    const response = await callClaudeWithTools({
      prompt: milestonePrompt,
      model,
      systemPrompt,
      tools: getWorkerTools(prismConfig),
      executeTool: createWorktreeToolExecutor(worktreePath, prismConfig, buildInfo),
      onTurnComplete: () => heartbeat(task.id),
      maxNudges: 2,
      midLoopNudge: ({ toolsCalled, turns }) => {
        if (msHasWritten(toolsCalled)) return null;
        if (turns >= 9) {
          return `FINAL WARNING: You have spent ${turns} turns without writing any files. Task will be TERMINATED if you do not call edit_file or write_file on your next turn. Modify ${msFiles} NOW.`;
        }
        if (turns >= 6) {
          return `WARNING: You have spent ${turns} turns without writing. Your next tool call MUST be edit_file or write_file to modify ${msFiles}. Do not read any more files.`;
        }
        if (turns >= 3) {
          return `IMPORTANT: You have spent ${turns} turns reading without writing. Stop exploring and call edit_file or write_file NOW to modify ${msFiles}.`;
        }
        return null;
      },
      shouldTerminate: async ({ toolsCalled, turns }) => {
        if (signal?.aborted) {
          return "Aborted: daemon shutdown";
        }
        if (turns >= 12 && !msHasWritten(toolsCalled)) {
          return `Terminated: ${turns} turns without any write — exploration spiral detected`;
        }
        if (turns % 5 === 0) {
          const taskCost = await getTotalCostForTask(task.id);
          const budgetLimit = getAutonomousConfig().budget.perTaskMax;
          if (taskCost >= budgetLimit) {
            return `Terminated: per-task budget exceeded ($${taskCost.toFixed(2)} >= $${budgetLimit} limit)`;
          }
        }
        return null;
      },
      postCompletionNudge: ({ toolsCalled }) => {
        if (!msHasWritten(toolsCalled)) {
          return `CRITICAL: You have not written any files. This milestone WILL FAIL unless you produce code changes. Call edit_file or write_file RIGHT NOW to modify ${msFiles}. Write your best implementation even if uncertain.`;
        }
        return null;
      },
    });

    const implCost = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    totalCostUsd += implCost;

    await addEvent(task.id, "claude_call_complete", "worker", `Claude complete (${response.cost.inputTokens}+${response.cost.outputTokens} tokens, $${implCost.toFixed(2)}, ${response.turns} turns)`, {
      inputTokens: response.cost.inputTokens,
      outputTokens: response.cost.outputTokens,
      costUsd: implCost,
    });
    await heartbeat(task.id);

    // ── 3. Review-fix loop ────────────────────────────────────────────────
    await addEvent(task.id, "review_fix_started", "worker", `Review-fix loop for milestone ${i + 1}/${milestones.length}`);
    const review = await reviewFix(worktreePath, ms.title, model, buildSettings, buildInfo, { skipInstall: true });
    totalCostUsd += review.costUsd;
    await addEvent(task.id, "review_fix_complete", "worker", `Review-fix ${review.passed ? "passed" : "failed"} (${review.iterations} iterations, $${review.costUsd.toFixed(2)})`);
    if (review.issues.length > 0) {
      reviewFixIssues.push(...review.issues.map((issue) => `[milestone: ${ms.title}] ${issue}`));
    }

    // ── 4. Commit the milestone ───────────────────────────────────────────
    await commitMilestone(worktreePath, ms.title, task.id);

    // ── 5. Persist progress so we can resume on failure ──────────────────
    await db
      .update(tasks)
      .set({ completedMilestones: i + 1, updatedAt: new Date() })
      .where(eq(tasks.id, task.id));

    // ── 5b. Push milestone to remote for recovery after worktree loss ──
    if (pushFn) {
      try {
        await pushFn();
      } catch (pushErr) {
        logger.warn({ taskId: task.id, milestone: i + 1, err: pushErr }, "Milestone push failed — will retry on next milestone");
      }
    }

    // ── 6. Accumulate summary ─────────────────────────────────────────────
    priorSummaries.push(`${ms.title} — completed (review ${review.passed ? "passed" : "had issues"})`);

    await addEvent(task.id, "milestone_complete", "worker", `Milestone ${i + 1}/${milestones.length} complete`);
    await heartbeat(task.id);

    logger.info(
      {
        taskId: task.id,
        milestone: i + 1,
        title: ms.title,
        reviewPassed: review.passed,
        milestoneCostUsd: implCost + review.costUsd,
      },
      "Milestone completed",
    );
  }

  return { totalCostUsd, reviewFixIssues };
}

/**
 * Executes a single flow task: creates worktree, runs Claude agent, reviews, pushes PR.
 * Handles rework cycles up to MAX_REWORK_CYCLES.
 */
export async function executeTask(taskId: string, signal?: AbortSignal): Promise<WorkerResult> {
  const startTime = Date.now();
  const config = getAutonomousConfig();

  /** Throws if the daemon signaled shutdown — checked before expensive operations. */
  const checkAbort = () => {
    if (signal?.aborted) {
      throw new Error("Task execution aborted by daemon shutdown");
    }
  };

  // Load task and repo
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const repo = await getRepo(task.repoId);
  if (!repo) throw new Error(`Repo ${task.repoId} not found for task ${taskId}`);

  // Build prism config if available (prefer repo-level prismSlug over fullName)
  const prismApiUrl = process.env.PRISM_API_URL || config.prism?.apiUrl;
  const repoSettingsRaw = (repo.settings ?? {}) as Record<string, unknown>;
  const prismSlug = (repoSettingsRaw.prismSlug as string) || repo.fullName;
  const prismConfig: PrismConfig | undefined = prismApiUrl && prismSlug
    ? {
        apiUrl: prismApiUrl,
        apiKey: process.env.PRISM_API_KEY || config.prism?.apiKey,
        repoSlug: encodeURIComponent(prismSlug),
      }
    : undefined;

  // Check budget
  const remaining = await checkBudget(task.createdBy);
  if (remaining <= 0) {
    await addEvent(
      taskId,
      "budget_exhausted",
      "worker",
      "Daily budget exhausted — task paused until tomorrow. Or bribe an admin with beers to bump your limit!",
    );
    throw new Error(`Budget exhausted for user ${task.createdBy}`);
  }

  // Always use the configured worker model from autonomous config
  const model = getModelFor("worker");
  const branchName = `hive/${taskId}`;
  let worktree: WorktreeInfo | undefined;
  const allReviewFixIssues: string[] = [];

  // Register first so if it fails, task status hasn't changed yet
  await register(taskId, "worker", model, "executing");

  // Transition to executing
  await updateStatus(taskId, "executing");

  try {
    // Reuse existing worktree on rework, or create a new one
    let reusedWorktree = false;
    if (task.worktreePath && task.worktreeBaseSha) {
      try {
        await access(task.worktreePath);
        // Verify it's still a valid git repo
        await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: task.worktreePath });
        worktree = {
          path: task.worktreePath,
          branch: branchName,
          repoFullName: repo.fullName,
          provider: repo.provider,
          createdAt: new Date(),
          baseSha: task.worktreeBaseSha,
        };
        reusedWorktree = true;
        await addEvent(taskId, "worktree_reused", "worker", "Reusing existing worktree from previous attempt");
        logger.info({ taskId, path: task.worktreePath }, "Reusing existing worktree");
      } catch {
        logger.warn({ taskId, path: task.worktreePath }, "Saved worktree missing or invalid — creating new");
      }
    }

    checkAbort();

    if (!worktree) {
      worktree = await createWorktree(
        repo.fullName,
        repo.provider,
        branchName,
        repo.defaultBranch ?? "main",
        task.createdBy,
        { repoId: repo.id, settings: (repo.settings ?? {}) as Record<string, unknown> },
        { depth: 50 },
      );
      await addEvent(taskId, "worktree_created", "worker", "Git worktree created");
    }

    // Persist worktree path and base SHA for potential rework reuse
    if (!reusedWorktree) {
      await db
        .update(tasks)
        .set({ worktreePath: worktree.path, worktreeBaseSha: worktree.baseSha, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      // Reset stale milestone progress when creating a fresh worktree
      // (but not when we recovered the branch from remote — commits are there)
      if ((task.completedMilestones ?? 0) > 0 && !worktree.recovered) {
        await db
          .update(tasks)
          .set({ completedMilestones: 0, updatedAt: new Date() })
          .where(eq(tasks.id, taskId));
        logger.warn({ taskId, staleCount: task.completedMilestones },
          "Reset stale completedMilestones — worktree was recreated");
      }
    }

    // Detect build system (using settings UI override if configured)
    const repoBuildCfg = (repo.settings ?? {}) as Record<string, unknown>;
    const buildSettings = repoBuildCfg.build as { system?: string; npmDir?: string } | undefined;
    const buildInfo = await detectBuildSystem(worktree.path, undefined, buildSettings);
    const buildSystemSection = buildSystemPromptSection(buildInfo, worktree.path);
    logger.info({ taskId, buildSystem: buildInfo.type, npmDir: buildInfo.npmDir, dotnetDir: buildInfo.dotnetDir }, "Detected build system for worker prompt");

    // Pre-install dependencies so the agent doesn't waste turns discovering they're missing.
    // Mirrors quickVerify's install steps. Failures are non-fatal — the agent can retry.
    checkAbort();
    const { NODE_ENV: _dropEnv, ...cleanInstallEnv } = process.env;
    cleanInstallEnv.NODE_OPTIONS = [cleanInstallEnv.NODE_OPTIONS, `--max-old-space-size=${getNodeHeapLimitMB()}`].filter(Boolean).join(" ");
    // Use execInGroup so the timeout kills the entire process group (NuGet sub-processes, etc.)
    const installOpts = { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: cleanInstallEnv };
    if (buildInfo.npmDir && (buildInfo.type === "npm" || buildInfo.type === "dotnet+npm")) {
      try {
        await addEvent(taskId, "dep_install", "worker", "Installing npm dependencies");
        await execInGroup("npm", ["install", "--prefer-offline", "--include=dev"], { ...installOpts, cwd: buildInfo.npmDir });
        logger.info({ taskId, npmDir: buildInfo.npmDir }, "Pre-installed npm dependencies");
      } catch (npmErr) {
        const reason = npmErr instanceof Error ? npmErr.message : String(npmErr);
        const output = (npmErr as { stderr?: string }).stderr || (npmErr as { stdout?: string }).stdout || "";
        const detail = output ? `\n${output.slice(-500).trim()}` : "";
        logger.warn({ taskId, npmDir: buildInfo.npmDir, err: npmErr }, "npm install failed — agent will need to handle it");
        await addEvent(taskId, "dep_install_failed", "worker", `npm install failed: ${reason.slice(0, 200)}${detail}`);
      }
    }
    if (buildInfo.dotnetDir && (buildInfo.type === "dotnet" || buildInfo.type === "dotnet+npm")) {
      try {
        await addEvent(taskId, "dep_install", "worker", "Restoring dotnet packages");
        await execInGroup("dotnet", ["restore", "/p:NuGetAudit=false"], { ...installOpts, cwd: buildInfo.dotnetDir });
        logger.info({ taskId, dotnetDir: buildInfo.dotnetDir }, "Pre-restored dotnet packages");
      } catch (dotnetErr) {
        const reason = dotnetErr instanceof Error ? dotnetErr.message : String(dotnetErr);
        const output = (dotnetErr as { stderr?: string }).stderr || (dotnetErr as { stdout?: string }).stdout || "";
        const detail = output ? `\n${output.slice(-500).trim()}` : "";
        logger.warn({ taskId, dotnetDir: buildInfo.dotnetDir, err: dotnetErr }, "dotnet restore failed — agent will need to handle it");
        await addEvent(taskId, "dep_install_failed", "worker", `dotnet restore failed: ${reason.slice(0, 200)}${detail}`);
      }
    }

    // Baseline verify removed — we assume main builds and tests pass.
    // The pre-existing failure filter (baselineFailures) is kept as an empty
    // set so the downstream filter at final verify is a no-op.
    const baselineFailures: Set<string> = new Set();

    // Retrieve relevant learnings for this task (non-blocking — failures degrade gracefully)
    let learningIds: number[] = [];
    let relevantLearnings: Awaited<ReturnType<typeof retrieveRelevantLearnings>> = [];
    try {
      relevantLearnings = await retrieveRelevantLearnings({
        scopes: ["universal", `repo:${repo.fullName}`],
        tags: buildRetrievalTags({ taskType: task.type, severity: task.severity, repoFullName: repo.fullName }),
        limit: 15,
      });

      learningIds = relevantLearnings.map((l) => l.id);
    } catch (learningsErr) {
      logger.warn({ taskId, err: learningsErr }, "Failed to retrieve learnings — proceeding without");
    }

    let learningsStr = "";
    if (relevantLearnings.length > 0) {
      const items = relevantLearnings
        .map((l) => `- [confidence: ${l.confidence}] (${l.scope}) ${l.content}`)
        .join("\n");
      learningsStr = `\n## Relevant Learnings\n\nThese learnings come from past tasks. Apply them where relevant:\n\n${items}`;
    }

    // Build enrichment string for the worker prompt.
    // For trivial/small tasks the architect blueprint already digests all enricher
    // data, so passing raw codebase/docs/git-history/dependencies is redundant noise.
    const taskSize = task.size ?? "medium";
    let enrichmentStr = "";

    if (task.enrichment) {
      const enrichObj = task.enrichment as Record<string, unknown>;

      if (taskSize === "trivial" || taskSize === "small") {
        // Format the architect blueprint as structured sections (matching the
        // milestone prompt format) instead of dumping raw JSON.  This gives
        // the worker model clear, actionable instructions.
        const bp = enrichObj.architect as ArchitectBlueprint | undefined;
        if (bp && !bp.skipped) {
          const parts: string[] = [];
          if (bp.approach) {
            parts.push(`\n## Implementation Plan\n\n${bp.approach}`);
          }
          if (bp.keyFiles?.length) {
            parts.push(`\n### Files to Modify\n\n${bp.keyFiles.map(f => `- ${f}`).join("\n")}`);
          }
          if (bp.checklist?.length) {
            // Filter out discovery-style items when exact files are already known
            const discoveryVerbs = /^(Search|Look for|Find|Locate|Identify)\b/i;
            const checklist = bp.keyFiles?.length
              ? bp.checklist.filter(c => !discoveryVerbs.test(c))
              : bp.checklist;
            if (checklist.length) {
              parts.push(`\n### Checklist\n\n${checklist.map(c => `- ${c}`).join("\n")}`);
            }
          }
          enrichmentStr = parts.join("\n");
        }
      } else {
        // Medium/large: full enrichment helps Claude navigate unfamiliar code
        enrichmentStr = `\n## Enrichment Context\n${JSON.stringify(task.enrichment, null, 2)}`;
      }

      // Guard against context overflow regardless of task size
      const INPUT_CHAR_BUDGET = 170_000 * 4;
      if (enrichmentStr.length > INPUT_CHAR_BUDGET * 0.8) {
        enrichmentStr = `\n## Enrichment Context\n${JSON.stringify(task.enrichment)}`;
        logger.info({ taskId, chars: enrichmentStr.length }, "Compacted enrichment JSON (removed pretty-print)");
      }
      if (enrichmentStr.length > INPUT_CHAR_BUDGET * 0.8) {
        const slim: Record<string, unknown> = {};
        for (const key of ["architect", "scorer", "prism"]) {
          if (enrichObj[key]) slim[key] = enrichObj[key];
        }
        enrichmentStr = `\n## Enrichment Context (trimmed)\n${JSON.stringify(slim)}`;
        logger.info({ taskId, chars: enrichmentStr.length }, "Trimmed enrichment to architect+scorer+prism only");
        await addEvent(taskId, "enrichment_trimmed", "worker", `Enrichment trimmed to architect+scorer+prism (${enrichmentStr.length} chars) — full enrichment was too large for context window`);
      }
      if (enrichmentStr.length > INPUT_CHAR_BUDGET * 0.8) {
        enrichmentStr = "";
        logger.warn({ taskId }, "Dropped enrichment entirely — too large for context window");
        await addEvent(taskId, "enrichment_dropped", "worker", "Enrichment dropped entirely — too large for context window. Worker is operating without enrichment context.");
      }
    }

    const retryStr = task.retryInstructions
      ? `\n## Retry Instructions (address this feedback)\n${task.retryInstructions}`
      : "";

    // Read project-level instructions (CLAUDE.md, .cursorrules) from the worktree
    const projectInstructions = await readProjectInstructions(worktree.path);

    // For small/trivial tasks, put structured plan BEFORE raw task body so the
    // agent sees exact file paths and actionable steps first, not discovery prose.
    const promptBody = (taskSize === "trivial" || taskSize === "small") && enrichmentStr
      ? [enrichmentStr, `\n## Original Task Description\n\n${task.body}`]
      : [task.body, enrichmentStr];

    const bpForHint = (task.enrichment as Record<string, unknown> | null)?.architect as ArchitectBlueprint | undefined;
    const firstFile = bpForHint?.keyFiles?.[0];
    const firstFileHint = firstFile
      ? ` Your FIRST tool call should be read_file on \`${firstFile}\`, then immediately edit it.`
      : "";

    // Rework cycles: lead with retry instructions so Claude focuses on the fix,
    // not on re-reading the full original task.  The original task body is included
    // as collapsed context at the end.
    const isReworkPrompt = (task.reworkCount ?? 0) > 0 && task.retryInstructions;
    const userPrompt = isReworkPrompt
      ? [
          `## Targeted Fix — Rework Cycle ${task.reworkCount}`,
          ``,
          `This is a TARGETED FIX. The code in this worktree already has a full implementation.`,
          `Your ONLY job is to address the specific feedback below. Do NOT redo or rewrite the existing work.`,
          ``,
          retryStr,
          ``,
          projectInstructions,
          ``,
          `## Working Directory`,
          worktree.path,
          ``,
          `## Branch`,
          branchName,
          ``,
          buildSystemSection,
          ``,
          `## Original Task (for context only — do NOT re-implement)`,
          `Title: ${task.title}`,
          ``,
          `## Reminder`,
          `Address ONLY the retry instructions above. Read the relevant files, make minimal targeted edits, and verify with a build.`,
        ].join("\n")
      : [
          `## Task: ${task.title}`,
          ``,
          ...promptBody,
          projectInstructions,
          learningsStr,
          retryStr,
          ``,
          `## Working Directory`,
          worktree.path,
          ``,
          `## Branch`,
          branchName,
          ``,
          buildSystemSection,
          ``,
          `## Reminder`,
          `You MUST call edit_file or write_file to implement changes. Do not just analyze or explain — write the code.${firstFileHint}`,
        ].join("\n");

    // Check for architect milestones
    const architectData = (task.enrichment as Record<string, unknown> | null)?.architect as ArchitectBlueprint | undefined;
    const hasMilestones = architectData?.milestones && architectData.milestones.length > 0;

    let implCostUsd: number;
    const isReworkCycle = (task.reworkCount ?? 0) > 0;
    if (hasMilestones && !isReworkCycle) {
      const startFrom = ((reusedWorktree || worktree?.recovered) && task.completedMilestones) ? task.completedMilestones : 0;

      // Resolve credentials early so milestones can push incrementally
      const milestoneCreds = await resolveGitCredentials(task.createdBy, repo.provider);
      const milestoneGitProvider = getGitProvider(repo.provider);
      const pushFn = async () => {
        await milestoneGitProvider.push(worktree!.path, branchName, milestoneCreds);
      };

      const { totalCostUsd, reviewFixIssues } = await executeMilestones(task, worktree.path, architectData!, model, learningsStr, startFrom, pushFn, prismConfig, buildSystemSection, buildSettings, buildInfo, signal);
      implCostUsd = totalCostUsd;
      allReviewFixIssues.push(...reviewFixIssues);
    } else {
      // Rework cycles (or non-milestone tasks): single targeted fix call.
      // On rework, the worktree already has the full implementation — only patch
      // the specific issues listed in retryInstructions (review findings).
      // Use a separately configurable rework model (falls back to worker model).
      const callModel = isReworkCycle
        ? (config.models.components["rework"] ?? model)
        : model;

      checkAbort();

      if (isReworkCycle) {
        await addEvent(taskId, "rework_fix_started", "worker", `Applying targeted review fixes (rework cycle ${task.reworkCount}, model: ${callModel})`);
      }
      // Single-call path (original behavior for tasks without milestones)
      await addEvent(taskId, "claude_call_started", "worker", `Calling Claude (${callModel})`);
      await heartbeat(taskId);

      const keyFiles = architectData?.keyFiles?.length
        ? architectData.keyFiles.map(f => `\`${f}\``).join(", ")
        : "the relevant files";
      const hasWritten = (calls: string[]) => calls.includes("write_file") || calls.includes("edit_file");

      // Wrap tool executor to log calls as task events for debuggability
      const baseExecutor = createWorktreeToolExecutor(worktree.path, prismConfig, buildInfo);
      const loggingExecutor = async (name: string, input: Record<string, unknown>) => {
        // Build a rich summary: for run_command show full command + args, for edit show char counts
        let summary: string;
        if (name === "run_command") {
          const cmd = input.command as string;
          const args = Array.isArray(input.args) ? (input.args as string[]).join(" ") : (typeof input.args === "string" ? input.args as string : "");
          summary = args ? `${cmd} ${args}` : cmd;
        } else if (name === "edit_file") {
          const oldLen = typeof input.old_string === "string" ? input.old_string.length : 0;
          const newLen = typeof input.new_string === "string" ? input.new_string.length : 0;
          summary = `${input.path} (${oldLen}→${newLen} chars)`;
        } else {
          summary = (input.path ?? input.query ?? "") as string;
        }
        try {
          const result = await baseExecutor(name, input);
          logger.info({ taskId, tool: name, input: summary }, "Tool call OK: %s(%s)", name, summary);
          addEvent(taskId, "tool_call", "worker", `${name}(${summary})`, { tool: name, input: summary }).catch(() => {});
          return result;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ taskId, tool: name, input: summary, error: errorMsg }, "Tool call FAILED: %s(%s) → %s", name, summary, errorMsg);
          addEvent(taskId, "tool_call_error", "worker", `${name}(${summary}) → ERROR: ${errorMsg}`, { tool: name, input: summary, error: errorMsg }).catch(() => {});
          throw err;
        }
      };

      // Per-size turn caps
      const turnCaps: Record<string, number> = { trivial: 8, small: 15, medium: 25, large: 30 };
      const maxTurns = turnCaps[taskSize] ?? 30;

      // Per-size write deadlines (terminate if no writes by this turn)
      const writeDeadline = (taskSize === "trivial" || taskSize === "small") ? 12 : 20;

      const response = await callClaudeWithTools({
        prompt: userPrompt,
        model: callModel,
        systemPrompt: getFlowPrompt(),
        tools: getWorkerTools(prismConfig),
        executeTool: loggingExecutor,
        onTurnComplete: () => heartbeat(taskId),
        maxTurns,
        maxNudges: 2,
        midLoopNudge: ({ toolsCalled, turns }) => {
          if (hasWritten(toolsCalled)) return null;
          if (turns >= 9) {
            return `FINAL WARNING: You have spent ${turns} turns without writing any files. Task will be TERMINATED if you do not call edit_file or write_file on your next turn. Modify ${keyFiles} NOW.`;
          }
          if (turns >= 6) {
            return `WARNING: You have spent ${turns} turns without writing. Your next tool call MUST be edit_file or write_file to modify ${keyFiles}. Do not read any more files.`;
          }
          if (turns >= 3) {
            return `IMPORTANT: You have spent ${turns} turns reading without writing any files. Stop exploring and start implementing NOW. Call edit_file or write_file to modify ${keyFiles}. Do not explain what you would do — write the code.`;
          }
          return null;
        },
        shouldTerminate: async ({ toolsCalled, turns }) => {
          if (signal?.aborted) {
            return "Aborted: daemon shutdown";
          }
          if (turns >= writeDeadline && !hasWritten(toolsCalled)) {
            return `Terminated: ${turns} turns without any write — exploration spiral detected (size: ${taskSize}, deadline: ${writeDeadline})`;
          }
          if (turns % 5 === 0) {
            const taskCost = await getTotalCostForTask(taskId);
            const budgetLimit = getAutonomousConfig().budget.perTaskMax;
            if (taskCost >= budgetLimit) {
              return `Terminated: per-task budget exceeded ($${taskCost.toFixed(2)} >= $${budgetLimit} limit)`;
            }
          }
          return null;
        },
        postCompletionNudge: ({ toolsCalled }) => {
          if (!hasWritten(toolsCalled)) {
            return `CRITICAL: You have not written any files. This task WILL FAIL unless you produce code changes. Call edit_file or write_file RIGHT NOW to modify ${keyFiles}. Write your best implementation even if you are uncertain.`;
          }
          return null;
        },
      });
      implCostUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);

      if (response.terminationReason) {
        logger.warn({ taskId, reason: response.terminationReason }, "Claude terminated early");
      }
      // Log Claude's final text (truncated) for debugging empty changesets
      if (response.text) {
        const snippet = response.text.slice(0, 500).replace(/\n/g, " ");
        logger.info({ taskId }, "Claude output: %s", snippet);
      }

      await addEvent(taskId, "claude_call_complete", "worker", `Claude complete (${callModel}, ${response.cost.inputTokens}+${response.cost.outputTokens} tokens, $${implCostUsd.toFixed(2)}, ${response.turns} turns)`, {
        inputTokens: response.cost.inputTokens,
        outputTokens: response.cost.outputTokens,
        costUsd: implCostUsd,
      });
      await heartbeat(taskId);
    }
    const implDurationMs = Date.now() - startTime;
    await recordCost(taskId, task.createdBy, "worker", model, implCostUsd, 1, implDurationMs);

    // Increment execution attempts
    await db
      .update(tasks)
      .set({
        executionAttempts: (task.executionAttempts ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // Empty-diff detection: catch cases where Claude produced no code changes.
    // Check both tracked-file diffs AND untracked new files — git diff alone
    // misses newly created files that haven't been staged yet.
    const validatedSha = await validateBaseSha(worktree.path, worktree.baseSha);
    // Log git status before diff check for debugging
    try {
      const { stdout: statusOut } = await execFileAsync("git", ["status", "--short"], { cwd: worktree.path });
      logger.info({ taskId, status: statusOut.trim() || "(clean)" }, "Worktree git status before diff check");
    } catch { /* non-critical */ }
    const { stdout: diffOutput } = await execFileAsync(
      "git", ["diff", "--name-only", validatedSha],
      { cwd: worktree.path },
    );
    const { stdout: untrackedOutput } = await execFileAsync(
      "git", ["ls-files", "--others", "--exclude-standard"],
      { cwd: worktree.path },
    );
    const hasChanges = !!(diffOutput.trim() || untrackedOutput.trim());
    if (untrackedOutput.trim()) {
      logger.info({ taskId, untracked: untrackedOutput.trim() }, "Detected untracked new files");
    }
    if (!hasChanges) {
      const reworkCount = task.reworkCount ?? 0;
      if (reworkCount === 0) {
        // First attempt with empty diff — send for automatic rework
        logger.warn({ taskId }, "Empty changeset — sending for rework with write_file reminder");
        await addEvent(taskId, "empty_changeset", "worker", "No files changed — reworking with write_file reminder");
        await db
          .update(tasks)
          .set({
            retryInstructions: [
              "CRITICAL: Your previous attempt produced no code changes.",
              "You MUST call edit_file or write_file to implement the solution.",
              architectData?.keyFiles?.length
                ? `Start by reading ${architectData.keyFiles[0]}, then immediately edit it.`
                : "Start by reading the target file, then immediately edit it.",
              "Do not just analyze or explain — write the code on your FIRST turn after reading.",
            ].join(" "),
            reworkCount: 1,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId));
        await updateStatus(taskId, "rework");
        return { success: false, branch: branchName, error: "Empty changeset — sent for rework" };
      }
      // Already reworked but still empty — fail the task
      const reason = "No code changes produced after rework attempt";
      logger.error({ taskId }, reason);
      await addEvent(taskId, "error", "worker", `Failed: ${reason}`);
      await db
        .update(tasks)
        .set({ failureReason: reason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
      return { success: false, branch: branchName, error: reason };
    }

    // Transition to reviewing
    await updateStatus(taskId, "reviewing");

    // Run review gate (pass learning IDs for feedback loop)
    await addEvent(taskId, "review_started", "worker", "Starting code review");
    await heartbeat(taskId);
    const reviewResult = await reviewChanges(taskId, worktree, learningIds, allReviewFixIssues.length > 0 ? allReviewFixIssues : undefined);
    await addEvent(taskId, "review_complete", "worker", `Review: ${reviewResult.verdict}`);
    await heartbeat(taskId);

    // ── Soft-pass filter: on rework cycles, only critical/major block ──────
    const reworkCount = task.reworkCount ?? 0;
    const maxCyclesReview = task.maxReworkCycles ?? MAX_REWORK_CYCLES;

    if (reworkCount > 0 && reviewResult.verdict === "rework") {
      const blockingFindings = reviewResult.findings.filter(
        f => f.severity === "critical" || f.severity === "major",
      );
      const blockingSecFindings = reviewResult.securityFindings.filter(
        f => (f.severity === "critical" || f.severity === "high") && !f.advisory,
      );

      if (blockingFindings.length === 0 && blockingSecFindings.length === 0) {
        reviewResult.verdict = "pass";
        await addEvent(taskId, "review_soft_pass", "worker",
          `Soft pass on rework cycle ${reworkCount}: ${reviewResult.findings.length} non-blocking finding(s) remaining`);
        logger.info({ taskId, reworkCount, remainingFindings: reviewResult.findings.length },
          "Review soft-passed — only minor/info findings remain");
      }
    }

    // ── Rework if under max cycles ─────────────────────────────────────────
    if (reviewResult.verdict === "rework" && reworkCount < maxCyclesReview) {
      await updateStatus(taskId, "rework");

      // Do NOT reset completedMilestones — rework uses a targeted single-call
      // fix against the existing worktree, not a full milestone re-execution.

      await refineTask(taskId, reviewResult);

      logger.info({ taskId, reworkCount: reworkCount + 1 }, "Task sent for rework");

      return { success: false, branch: branchName, reviewResult, error: "Sent for rework" };
    }

    // ── Max rework cycles exhausted — stop for human decision ──────────────
    if (reviewResult.verdict === "rework") {
      const reason = `Max rework cycles (${maxCyclesReview}) exhausted — manual intervention required`;
      await addEvent(taskId, "review_max_cycles", "worker",
        `Max rework cycles (${maxCyclesReview}) reached with outstanding findings — stopping for human review`);
      logger.warn({ taskId, reworkCount, maxCycles: maxCyclesReview },
        "Max rework cycles exhausted — failing task for human intervention");
      await db
        .update(tasks)
        .set({ failureReason: reason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
      return { success: false, branch: branchName, reviewResult, error: reason };
    }

    // ── Final build/test sanity check ─────────────────────────────────────
    // The review gate is diff-only (Claude reads code, never runs build/test).
    // Rework fixes or late-stage changes can introduce build errors that slip
    // through. Run quickVerify here to catch them before pushing.
    await addEvent(taskId, "final_verify_started", "worker", "Running final build/test verification");
    const finalVerify = await quickVerify(worktree.path, buildSettings, { skipInstall: true });

    // Filter out pre-existing failures that were already broken on the base branch.
    // This prevents rework loops caused by repo issues the agent didn't introduce.
    if (!finalVerify.passed && baselineFailures.size > 0) {
      const introduced = finalVerify.failures.filter(f => !baselineFailures.has(f));
      const inherited = finalVerify.failures.length - introduced.length;
      if (inherited > 0) {
        logger.info({ taskId, inherited, introduced: introduced.length },
          "Filtered out pre-existing failures from final verify");
        await addEvent(taskId, "baseline_filter", "worker",
          `Filtered ${inherited} pre-existing failure(s), ${introduced.length} introduced failure(s) remain`);
        finalVerify.failures = introduced;
        finalVerify.passed = introduced.length === 0;
      }
    }

    if (!finalVerify.passed) {
      logger.warn({ taskId, failures: finalVerify.failures }, "Final build/test verification failed after review pass");
      await addEvent(taskId, "final_verify_failed", "worker",
        `Final verification failed: ${finalVerify.failures.map(f => f.substring(0, 200)).join("; ")}`);

      if (reworkCount < maxCyclesReview) {
        // Send for another rework cycle with the build/test failures
        await updateStatus(taskId, "rework");
        const verifyReviewResult: ReviewGateResult = {
          verdict: "rework",
          findings: [
            ...finalVerify.failures.map(f => ({
              severity: "critical" as const,
              file: "",
              message: f.substring(0, 1500),
              category: "verification",
            })),
            // Lint warnings are non-blocking — reported for visibility but
            // "minor" severity won't trigger rework (soft-pass filter skips them).
            ...finalVerify.warnings.map(f => ({
              severity: "minor" as const,
              file: "",
              message: f.substring(0, 1500),
              category: "verification",
            })),
          ],
          securityFindings: [],
          verification: {
            testsRun: true,
            testsPassed: false,
            lintClean: finalVerify.warnings.length === 0,
            buildSucceeded: !finalVerify.failures.some(f => f.startsWith("npm build failed") || f.startsWith("dotnet build failed")),
            notes: finalVerify.failures,
          },
          costUsd: 0,
        };
        await refineTask(taskId, verifyReviewResult);
        logger.info({ taskId, reworkCount: reworkCount + 1 }, "Final verify failed — sent for rework");
        return { success: false, branch: branchName, reviewResult: verifyReviewResult, error: "Final build/test failed — rework" };
      }

      // At max cycles — stop for human intervention
      const verifyFailReason = `Max rework cycles (${maxCyclesReview}) exhausted with build/test failures — manual intervention required`;
      await addEvent(taskId, "final_verify_max_cycles", "worker",
        `Final verification failed at max rework cycles (${maxCyclesReview}) — stopping for human review`);
      logger.warn({ taskId, reworkCount }, "Final verify failed at max cycles — failing task for human intervention");
      await db
        .update(tasks)
        .set({ failureReason: verifyFailReason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
      return { success: false, branch: branchName, reviewResult, error: verifyFailReason };
    }

    // ── Verdict is now guaranteed "pass" — commit, push, PR ────────────────
    const creds = await resolveGitCredentials(task.createdBy, repo.provider);
    const gitProvider = getGitProvider(repo.provider);

    // Milestone-based tasks commit per-milestone on the first run.
    // Rework cycles use the single-call path, so changes need a commit here too.
    if (!hasMilestones || isReworkCycle) {
      const commitMsg = isReworkCycle
        ? `fix: address review feedback (cycle ${task.reworkCount})\n\nTask: ${taskId}`
        : `${task.title}\n\nTask: ${taskId}`;
      await gitProvider.commitAll(worktree.path, commitMsg);
    }
    await gitProvider.push(worktree.path, branchName, creds);

    // ── Preview + browser validation (before PR) ──────────────────────────
    let previewUrl: string | undefined;
    const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;
    const repoPreview = (repoSettings.preview ?? {}) as Record<string, unknown>;
    const previewEnabled = !task.skipPreview
      && ((repoPreview.enabled as boolean | undefined) ?? config.preview.enabled);

    // .hive.yaml takes precedence; fall back to repo settings
    const previewConfig = parseHiveYaml(worktree.path)
      ?? buildPreviewConfigFromSettings(repoPreview);

    if (previewConfig && previewEnabled) {
      try {
        const previewInfo = await previewManager.startPreview(taskId, worktree.path, previewConfig);
        previewUrl = getExternalPreviewUrl(previewInfo);
        const localPreviewUrl = getLocalPreviewUrl(previewInfo);
        logger.info({ taskId, previewUrl }, "Preview environment started");

        // Persist previewUrl on the task
        await db
          .update(tasks)
          .set({ previewUrl, updatedAt: new Date() })
          .where(eq(tasks.id, taskId));

        // Run browser validation (use container-local URL)
        try {
          const { validateWithBrowser } = await import("../agents/browser-validator.js");
          const validation = await validateWithBrowser(taskId, localPreviewUrl);

          if (validation.verdict === "fail") {
            // Stop preview to free resources
            try { await previewManager.stopPreview(taskId); } catch { /* swallow */ }

            const maxCycles = task.maxReworkCycles ?? MAX_REWORK_CYCLES;
            if ((task.reworkCount ?? 0) < maxCycles) {
              // Send for rework with browser findings
              await updateStatus(taskId, "rework");

              // Do NOT reset completedMilestones — rework uses targeted single-call fix.

              // Get changed files from the worktree for scope-aware refinement
              const browserSha = await validateBaseSha(worktree!.path, worktree!.baseSha);
              const browserChangedFiles = await execFileAsync(
                "git", ["diff", "--name-only", browserSha],
                { cwd: worktree!.path },
              ).then(r => r.stdout.trim().split("\n").filter(Boolean)).catch(() => [] as string[]);

              const browserReviewResult: ReviewGateResult = {
                verdict: "rework",
                findings: validation.findings.map((f) => ({
                  severity: "major" as const,
                  file: "",
                  message: f,
                  category: "browser-validation",
                })),
                securityFindings: [],
                verification: { testsRun: false, testsPassed: false, lintClean: false, buildSucceeded: false, notes: [] },
                costUsd: validation.costUsd,
                changedFiles: browserChangedFiles,
              };
              await refineTask(taskId, browserReviewResult);

              logger.info({ taskId, reworkCount: (task.reworkCount ?? 0) + 1 }, "Browser validation failed — sent for rework");
              return { success: false, branch: branchName, reviewResult: browserReviewResult, error: "Browser validation failed — rework" };
            }

            // Max rework cycles exhausted — stop for human intervention
            const browserFailReason = `Browser validation failed after max rework cycles (${maxCycles}) — manual intervention required`;
            const browserMaxResult: ReviewGateResult = {
              verdict: "rework",
              findings: validation.findings.map((f) => ({
                severity: "major" as const,
                file: "",
                message: f,
                category: "browser-validation",
              })),
              securityFindings: [],
              verification: { testsRun: false, testsPassed: false, lintClean: false, buildSucceeded: false, notes: [] },
              costUsd: validation.costUsd,
            };
            await addEvent(taskId, "browser_validation_max_cycles", "worker",
              `Browser validation failed at max rework cycles (${maxCycles}) — stopping for human review`);
            logger.warn({ taskId }, "Browser validation failed at max cycles — failing task for human intervention");
            await db
              .update(tasks)
              .set({ failureReason: browserFailReason, updatedAt: new Date() })
              .where(eq(tasks.id, taskId));
            await updateStatus(taskId, "failed");
            return { success: false, branch: branchName, reviewResult: browserMaxResult, error: browserFailReason };
          }
        } catch (validationErr) {
          logger.warn({ taskId, err: validationErr }, "Browser validation error — continuing to PR");
        }
      } catch (previewErr) {
        logger.warn({ taskId, err: previewErr }, "Failed to start preview — continuing without");
      }
    }

    // ── Create PR ─────────────────────────────────────────────────────────
    const prBody = formatPRBody(taskId, task.body, architectData);
    const prResult = await gitProvider.createPR(
      repo.fullName,
      branchName,
      repo.defaultBranch ?? "main",
      task.title,
      prBody,
      creds,
    );
    const prUrl = prResult.url;

    // Post review summary as a PR comment
    try {
      // Build rework context for scoped summaries on PR feedback fixes
      let reworkCtx: ReworkCommentContext | undefined;
      if (isReworkCycle) {
        const history = (task.reworkHistory as Array<Record<string, unknown>>) ?? [];
        const lastCycle = history[history.length - 1];
        const source = (lastCycle?.source as ReworkCommentContext["source"]) ?? "review_gate";
        const feedbackComments = source === "pr_feedback" && Array.isArray(lastCycle?.comments)
          ? (lastCycle.comments as Array<{ author: string; body: string }>).map(c => `**${c.author}**: ${c.body}`)
          : undefined;
        reworkCtx = { cycle: task.reworkCount ?? 1, source, feedbackComments };
      }
      const reviewComment = formatReviewComment(taskId, reviewResult, reworkCtx);
      await gitProvider.commentOnPR(repo.fullName, prUrl, reviewComment, creds);
      logger.info({ taskId, prUrl }, "Review summary posted as PR comment");
    } catch (commentErr) {
      logger.warn({ taskId, err: commentErr }, "Failed to post review comment on PR — continuing");
    }

    // Post preview URL as PR comment if preview is running
    if (previewUrl) {
      try {
        const timeoutMinutes = (repoPreview.cleanup_timeout_minutes as number | undefined) ?? config.preview.cleanup_timeout_minutes;
        const comment = [
          `## Preview Environment`,
          ``,
          `A preview environment is available for this PR:`,
          ``,
          `**URL:** ${previewUrl}`,
          ``,
          `_Preview will auto-cleanup when this PR is closed/merged or after ${timeoutMinutes} minutes of inactivity._`,
          ``,
          `---`,
          `_Automated by Hive - Task ${taskId}_`,
        ].join("\n");

        await gitProvider.commentOnPR(repo.fullName, prUrl, comment, creds);
        logger.info({ taskId, prUrl }, "Preview URL posted as PR comment");
      } catch (commentErr) {
        logger.warn({ taskId, err: commentErr }, "Failed to post preview comment on PR — continuing");
      }
    }

    // Update task with PR URL + preview URL and transition to done
    await db
      .update(tasks)
      .set({ prUrl, ...(previewUrl ? { previewUrl } : {}), updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await addEvent(taskId, "pr_created", "worker", prResult.reused ? "PR updated (reusing existing)" : "PR created", { prUrl });
    await updateStatus(taskId, "done");

    logger.info({ taskId, prUrl, previewUrl, reused: prResult.reused }, "Task execution complete — PR created");

    return { success: true, prUrl, previewUrl, branch: branchName, reviewResult };

  } catch (err) {
    // On unexpected error, try to transition to failed
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, err }, "Worker: unexpected error");

    try {
      await addEvent(taskId, "error", "worker", `Execution failed: ${reason}`);
      await db
        .update(tasks)
        .set({ failureReason: reason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
    } catch (transitionErr) {
      logger.error({ taskId, transitionErr }, "Worker: could not transition to failed");
    }

    return { success: false, error: reason };
  } finally {
    if (worktree) {
      // Preserve worktree for rework or when milestones are partially complete
      const currentTask = await getTask(taskId);
      const isRework = currentTask?.status === "rework";
      const hasPartialMilestones = currentTask?.status === "failed" && (currentTask?.completedMilestones ?? 0) > 0;
      const isMaxCyclesFailed = currentTask?.status === "failed"
        && (currentTask?.failureReason?.includes("Max rework cycles") || currentTask?.failureReason?.includes("Browser validation failed after max"));
      const preserveWorktree = isRework || hasPartialMilestones || isMaxCyclesFailed;

      if (preserveWorktree) {
        const reason = isRework ? "rework cycle" : "partial milestone progress";
        logger.info({ taskId, path: worktree.path, completedMilestones: currentTask?.completedMilestones }, `Worktree preserved for ${reason}`);
      } else {
        // Worktree cleanup deferred — preview manager owns cleanup when preview stops.
        const activePreview = previewManager.getPreviewInfo(taskId);
        if (!activePreview) {
          await cleanupWorktree(worktree);
          // Clear worktree columns on cleanup
          try {
            await db
              .update(tasks)
              .set({ worktreePath: null, worktreeBaseSha: null, updatedAt: new Date() })
              .where(eq(tasks.id, taskId));
          } catch { /* swallow — task may already be in terminal state */ }
        } else {
          logger.info({ taskId }, "Worktree cleanup deferred — preview is active");
        }
      }
    }
    await unregister(taskId);
  }
}

/**
 * Executes an epic task: decomposes into milestones and creates child tasks.
 */
export async function executeEpic(taskId: string): Promise<WorkerResult> {
  // Import here to avoid circular dependency
  const { decomposeEpic } = await import("../agents/decomposer.js");

  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.workflow !== "epic") throw new Error(`Task ${taskId} is not an epic`);

  await updateStatus(taskId, "executing");
  await register(taskId, "worker", "system", "decomposing");

  try {
    const milestones = await decomposeEpic(taskId);

    // Create child tasks for each milestone
    const { create: createTask } = await import("../db/queries/tasks.js");

    for (const milestone of milestones) {
      const child = await createTask({
        title: milestone.title,
        body: milestone.body,
        source: `epic:${taskId}`,
        repoId: task.repoId,
        createdBy: task.createdBy,
      });

      // Set epic metadata
      await db
        .update(tasks)
        .set({
          epicId: taskId,
          milestoneIndex: milestone.index,
          milestoneTotal: milestone.total,
          workflow: "flow",
        })
        .where(eq(tasks.id, child.id));
    }

    // Store the decomposition plan
    await db
      .update(tasks)
      .set({
        blueprint: JSON.stringify(milestones),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // State machine requires executing -> reviewing -> done; no actual review for epics
    await updateStatus(taskId, "reviewing");
    await updateStatus(taskId, "done");

    logger.info({ taskId, milestoneCount: milestones.length }, "Epic decomposed into milestones");

    return { success: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await db
        .update(tasks)
        .set({ failureReason: reason, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await updateStatus(taskId, "failed");
    } catch {
      // swallow
    }
    return { success: false, error: reason };
  } finally {
    await unregister(taskId);
  }
}

