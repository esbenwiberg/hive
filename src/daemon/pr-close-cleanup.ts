import logger from "../logger.js";
import { previewManager } from "../execution/preview/manager.js";
import { getGitProvider } from "../execution/git-provider.js";
import { resolveGitCredentials } from "../execution/worktree.js";
import { cleanupWorktree } from "../execution/worktree.js";
import { getById as getTask } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";
import { addPreviewLog } from "../db/queries/preview-logs.js";

/**
 * Fire-and-forget structural reindex of the main branch after a PR merges.
 * Uses the slug (owner/repo) to find the Prism project — same lookup as the
 * enricher. Non-blocking; failures are logged but never propagate.
 */
function triggerPostMergePrismReindex(repoFullName: string, taskId: string): void {
  const prismDbUrl = process.env.PRISM_DATABASE_URL;
  if (!prismDbUrl) return;

  (async () => {
    try {
      const prism = await import("@prism/core");
      prism.setActiveConnectionString(prismDbUrl);

      const project = await prism.getProjectBySlug(repoFullName);
      if (!project) {
        logger.debug({ repoFullName }, "PR-close cleanup: no Prism project found for repo, skipping reindex");
        return;
      }

      // Incremental structural only — semantic layer is handled by the 24h daemon tick
      await prism.runPipeline(project, { layers: ["structural"], fullReindex: false });
      logger.info({ repoFullName, taskId, projectId: project.id }, "PR-close cleanup: Prism structural reindex complete");
    } catch (err) {
      logger.warn({ repoFullName, taskId, err }, "PR-close cleanup: Prism structural reindex failed (non-blocking)");
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
          await addPreviewLog(taskId, "pr-close", `Worktree cleaned up at ${info.worktreePath}`);
        } catch (wtErr) {
          logger.error({ taskId, err: wtErr }, "PR-close cleanup: failed to clean up worktree");
        }

        // On merge: trigger incremental structural reindex of main branch
        if (prState === "merged") {
          triggerPostMergePrismReindex(repo.fullName, taskId);
        }
      }
    } catch (err) {
      logger.error({ taskId, err }, "PR-close cleanup: error checking task");
    }
  }
}
