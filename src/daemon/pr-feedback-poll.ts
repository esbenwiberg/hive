import logger from "../logger.js";
import { getGitProvider } from "../execution/git-provider.js";
import { resolveGitCredentials } from "../execution/worktree.js";
import { list, updateStatus } from "../db/queries/tasks.js";
import { getById as getRepo } from "../db/queries/repos.js";
import { addEvent } from "../db/queries/task-events.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Polls DONE tasks with PRs for new human comments.
 * If new comments are found after the task's updatedAt, triggers a rework cycle
 * so Hive addresses the feedback and pushes fixes to the same PR.
 */
export async function pollPRFeedback(): Promise<void> {
  const { tasks: doneTasks } = await list({ status: "done" }, 100);
  const tasksWithPRs = doneTasks.filter((t) => t.prUrl);

  if (tasksWithPRs.length === 0) return;

  logger.debug({ count: tasksWithPRs.length }, "PR feedback poll: checking done tasks with PRs");

  for (const task of tasksWithPRs) {
    try {
      const repo = await getRepo(task.repoId);
      if (!repo) {
        logger.warn({ taskId: task.id }, "PR feedback poll: repo not found, skipping");
        continue;
      }

      let creds;
      try {
        creds = await resolveGitCredentials(task.createdBy, repo.provider);
      } catch (credErr) {
        logger.warn({ taskId: task.id, err: credErr }, "PR feedback poll: could not resolve creds, skipping");
        continue;
      }

      const gitProvider = getGitProvider(repo.provider);
      const allComments = await gitProvider.getPRComments(repo.fullName, task.prUrl!, creds);

      // Filter to comments after the task was last updated (when PR was created/last reworked)
      const taskUpdatedAt = new Date(task.updatedAt!).getTime();
      const newComments = allComments.filter(
        (c) => new Date(c.createdAt).getTime() > taskUpdatedAt,
      );

      if (newComments.length === 0) continue;

      logger.info(
        { taskId: task.id, commentCount: newComments.length },
        "PR feedback poll: new human comments found, triggering rework",
      );

      // Build retry instructions from the comments with explicit fix guidance
      const commentLines = newComments
        .map((c) => `- **${c.author}**: ${c.body}`)
        .join("\n");
      const retryInstructions = [
        `PR reviewer feedback that MUST be addressed:`,
        ``,
        commentLines,
        ``,
        `Instructions: Read the files related to the feedback above, make the specific changes requested, then run a build to verify. Keep changes minimal — only fix what the reviewer asked for.`,
      ].join("\n");

      // Update rework state
      const currentHistory = (task.reworkHistory as Array<Record<string, unknown>>) ?? [];
      const newHistory = [
        ...currentHistory,
        {
          cycle: (task.reworkCount ?? 0) + 1,
          source: "pr_feedback",
          comments: newComments.map((c) => ({ author: c.author, body: c.body })),
        },
      ];

      await db
        .update(tasks)
        .set({
          retryInstructions,
          reworkCount: (task.reworkCount ?? 0) + 1,
          reworkHistory: newHistory,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      // Transition to rework
      await updateStatus(task.id, "rework");

      await addEvent(
        task.id,
        "pr_feedback_rework",
        "pr-feedback-poll",
        `${newComments.length} new PR comment(s) from: ${[...new Set(newComments.map((c) => c.author))].join(", ")}`,
      );
    } catch (err) {
      logger.error({ taskId: task.id, err }, "PR feedback poll: error processing task");
    }
  }
}
