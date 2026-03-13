import { resolveGitCredentials } from "../execution/worktree.js";
import { createTaskWithDedup } from "./base.js";
import logger from "../logger.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

interface GitHubIssuesConfig {
  label?: string;
  maxPerRun?: number;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}

const MAX_BODY_CHARS = 10_000;

/**
 * Polls GitHub Issues with a configurable label and creates Hive tasks.
 *
 * No LLM calls — pure API polling. Zero cost per run (aside from
 * semantic dedup in createTaskWithDedup on first encounter).
 *
 * Config (per-repo `producers["github-issues"].config`):
 *   - label: GitHub label to filter by (default: "hive")
 *   - maxPerRun: max issues to ingest per tick (default: 10)
 */
export class GitHubIssuesProducer implements Producer {
  name = "github-issues";
  needsRepo = false;
  intervalMs = 60_000; // 1 minute

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    // Only works with GitHub repos
    if (ctx.provider && ctx.provider !== "github") {
      logger.debug(
        { repo: ctx.repoFullName, provider: ctx.provider },
        "github-issues: skipping non-GitHub repo",
      );
      return result;
    }

    const config = (ctx.config ?? {}) as GitHubIssuesConfig;
    const label = config.label ?? "hive";
    const maxPerRun = Math.min(config.maxPerRun ?? 10, 100);
    const source = `producer:${this.name}`;

    // Parse owner/repo
    const parts = ctx.repoFullName.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      result.errors.push(
        `Invalid GitHub repo format: "${ctx.repoFullName}" (expected owner/repo)`,
      );
      return result;
    }
    const [owner, repo] = parts;

    // Resolve GitHub token
    let token: string;
    try {
      const creds = await resolveGitCredentials(ctx.createdBy, "github");
      token = creds.token;
    } catch (err) {
      result.errors.push(
        `Failed to resolve GitHub credentials: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    // Fetch open issues with the configured label
    let issues: GitHubIssue[];
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=${maxPerRun}&sort=created&direction=asc`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        result.errors.push(
          `GitHub API error (${response.status}): ${text.slice(0, 200)}`,
        );
        return result;
      }

      issues = (await response.json()) as GitHubIssue[];
    } catch (err) {
      result.errors.push(
        `GitHub API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    // GitHub Issues API includes PRs — filter them out
    issues = issues.filter((i) => !i.pull_request);

    for (const issue of issues) {
      try {
        const title = `[#${issue.number}] ${issue.title}`;
        const rawBody = issue.body ?? "";
        const body = [
          rawBody.slice(0, MAX_BODY_CHARS),
          "",
          "---",
          `_Source: ${issue.html_url}_`,
        ].join("\n");

        const { skipped } = await createTaskWithDedup({
          title,
          body,
          source,
          repoId: ctx.repoId,
          createdBy: ctx.createdBy,
          dryRun: ctx.dryRun,
        });

        if (skipped) {
          result.duplicatesSkipped++;
        } else {
          result.tasksCreated++;
        }
        // Swap label so the issue isn't re-fetched on future ticks.
        // This must run for duplicates too — issues ingested before the
        // label-swap code was deployed still carry the trigger label and
        // would otherwise consume all maxPerRun slots forever.
        if (!ctx.dryRun) {
          await this._swapLabel(owner, repo, issue.number, label, token);
        }
      } catch (err) {
        result.errors.push(
          `Failed to process issue #${issue.number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  /** Remove the trigger label and add a "grabbed" label so the issue isn't polled again. */
  private async _swapLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    triggerLabel: string,
    token: string,
  ): Promise<void> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`;

    const [addRes, removeRes] = await Promise.allSettled([
      fetch(base, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ labels: [`${triggerLabel}:grabbed`] }),
      }),
      fetch(`${base}/${encodeURIComponent(triggerLabel)}`, {
        method: "DELETE",
        headers,
      }),
    ]);

    if (addRes.status === "rejected" || removeRes.status === "rejected") {
      logger.warn(
        { issueNumber, owner, repo },
        "github-issues: failed to swap label on issue",
      );
    }
  }
}

export const githubIssuesProducer = new GitHubIssuesProducer();
export default githubIssuesProducer;
