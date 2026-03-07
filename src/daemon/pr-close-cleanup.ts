import logger from "../logger.js";
import { previewManager } from "../execution/preview/manager.js";
import { getGitProvider } from "../execution/git-provider.js";
import { resolveGitCredentials } from "../execution/worktree.js";
import { cleanupWorktree } from "../execution/worktree.js";
import { getById as getTask, updateStatus, getDoneTasksWithPR } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";
import { addPreviewLog } from "../db/queries/preview-logs.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getAutonomousConfig } from "../domain/autonomous-config.js";

/**
 * Fire-and-forget structural reindex request after a PR merges.
 * Posts to the Prism API; Prism queues and deduplicates the request.
 * Non-blocking; failures are logged but never propagate.
 */
function triggerPostMergePrismReindex(repoFullName: string, taskId: string, repoSettings?: Record<string, unknown>): void {
  const prismConfig = getAutonomousConfig().prism;
  const apiUrl = process.env.PRISM_API_URL || prismConfig.apiUrl;
  if (!apiUrl) return;

  const apiKey = process.env.PRISM_API_KEY || prismConfig.apiKey;
  const slug = encodeURIComponent((repoSettings?.prismSlug as string) || repoFullName);

  (async () => {
    try {
      const response = await fetch(`${apiUrl}/api/projects/${slug}/reindex`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ layers: ["structural"] }),
      });

      if (!response.ok && response.status !== 404) {
        logger.warn({ repoFullName, taskId, status: response.status }, "PR-close cleanup: Prism reindex request failed");
      } else {
        logger.info({ repoFullName, taskId }, "PR-close cleanup: Prism structural reindex queued");
      }
    } catch (err) {
      logger.warn({ repoFullName, taskId, err }, "PR-close cleanup: Prism reindex request failed (non-blocking)");
    }
  })();
}

/**
 * Checks all running previews and stops any whose PR has been closed or merged.
 * Runs on a 60s polling interval. Each task is handled independently so one
 * failure doesn't block others.
 */
export async function cleanupClosedPRPreviews(): Promise<void> {
  const running = previewManager.getRunningPreviews();
  if (running.size === 0) return;

  for (const [taskId, info] of running) {
    try {
      const task = await getTask(taskId);
      if (!task || !task.prUrl) {
        // No PR URL — can't check state, skip
        continue;
      }

      const repo = await getRepo(task.repoId);
      if (!repo) {
        logger.warn({ taskId }, "PR-close cleanup: repo not found, skipping");
        continue;
      }

      let creds;
      try {
        creds = await resolveGitCredentials(task.createdBy, repo.provider);
      } catch (credErr) {
        logger.warn({ taskId, err: credErr }, "PR-close cleanup: could not resolve creds, skipping");
        continue;
      }

      const gitProvider = getGitProvider(repo.provider);
      const prState = await gitProvider.getPRState(repo.fullName, task.prUrl, creds);

      if (prState === "closed" || prState === "merged") {
        await addPreviewLog(taskId, "pr-close", `PR ${prState} — stopping preview`);
        logger.info({ taskId, prState }, "PR-close cleanup: stopping preview");

        await previewManager.stopPreview(taskId);

        // Clean up the worktree
        try {
          await cleanupWorktree({
            path: info.worktreePath,
            branch: "",
            repoFullName: "",
            provider: "",
            createdAt: new Date(),
            baseSha: "",
          });
          await db
            .update(tasks)
            .set({ worktreePath: null, worktreeBaseSha: null, updatedAt: new Date() })
            .where(eq(tasks.id, taskId));
          await addPreviewLog(taskId, "pr-close", `Worktree cleaned up at ${info.worktreePath}`);
        } catch (wtErr) {
          logger.error({ taskId, err: wtErr }, "PR-close cleanup: failed to clean up worktree");
        }

        // On merge: trigger incremental structural reindex of main branch
        if (prState === "merged") {
          triggerPostMergePrismReindex(repo.fullName, taskId, (repo.settings ?? {}) as Record<string, unknown>);
        }
      }
    } catch (err) {
      logger.error({ taskId, err }, "PR-close cleanup: error checking task");
    }
  }
}

/**
 * Polls all tasks in 'done' status with a PR URL and automatically
 * transitions them to 'merged' once their PR is merged.
 * Runs on the same 60s interval as cleanupClosedPRPreviews.
 */
export async function autoMergeDoneTasks(): Promise<void> {
  const doneTasks = await getDoneTasksWithPR();
  if (doneTasks.length === 0) return;

  for (const task of doneTasks) {
    try {
      const repo = await getRepo(task.repoId);
      if (!repo) continue;

      let creds;
      try {
        creds = await resolveGitCredentials(task.createdBy, repo.provider);
      } catch (credErr) {
        logger.warn({ taskId: task.id, err: credErr }, "Auto-merge: could not resolve creds, skipping");
        continue;
      }

      const gitProvider = getGitProvider(repo.provider);
      const prState = await gitProvider.getPRState(repo.fullName, task.prUrl!, creds);

      if (prState === "merged") {
        await updateStatus(task.id, "merged");
        logger.info({ taskId: task.id }, "Auto-merge: transitioned to merged after PR merge");
        triggerPostMergePrismReindex(repo.fullName, task.id, (repo.settings ?? {}) as Record<string, unknown>);
      }
    } catch (err) {
      logger.error({ taskId: task.id, err }, "Auto-merge: error checking task");
    }
  }
}
