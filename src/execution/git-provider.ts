import { execFile } from "node:child_process";
import logger from "../logger.js";
import type { GitCredentials } from "../domain/types.js";
import { parseAdoRepoName, createPullRequest, listPullRequests, createPRComment as adoCreatePRComment, getPullRequest, getPRThreadComments } from "../integrations/azure-devops.js";

// ── Helper ──────────────────────────────────────────────────────────────────

function redactArgs(args: string[]): string[] {
  return args.map(a => a.replace(/https:\/\/[^@]+@/, "https://***@"));
}

/**
 * Runs a git command via execFile and returns stdout.
 * Prevents credential prompts by setting GIT_TERMINAL_PROMPT=0.
 */
function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          logger.debug({ args: redactArgs(args), cwd, stderr: stderr.toString() }, "git command failed");
          reject(error);
          return;
        }
        resolve(stdout.toString().trim());
      },
    );
  });
}

// ── PR Number Extractors ────────────────────────────────────────────────────

/**
 * Extracts the PR number from a GitHub pull request URL.
 * e.g. "https://github.com/owner/repo/pull/42" → 42
 */
export function extractGitHubPRNumber(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Cannot extract PR number from GitHub URL: ${prUrl}`);
  }
  return parseInt(match[1], 10);
}

/**
 * Extracts the PR number from an Azure DevOps pull request URL.
 * e.g. "https://dev.azure.com/org/project/_git/repo/pullrequest/77" → 77
 */
export function extractAdoPRNumber(prUrl: string): number {
  const match = prUrl.match(/\/pullrequest\/(\d+)/);
  if (!match) {
    throw new Error(`Cannot extract PR number from Azure DevOps URL: ${prUrl}`);
  }
  return parseInt(match[1], 10);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PRComment {
  id: number;
  body: string;
  author: string;
  createdAt: string; // ISO 8601
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface CloneOptions {
  depth?: number;
}

export interface GitProvider {
  clone(repoUrl: string, targetDir: string, branch: string, creds: GitCredentials, opts?: CloneOptions): Promise<void>;
  createBranch(repoDir: string, branchName: string): Promise<void>;
  commitAll(repoDir: string, message: string): Promise<void>;
  push(repoDir: string, branch: string, creds: GitCredentials): Promise<void>;
  createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
    creds: GitCredentials,
  ): Promise<{ url: string; reused: boolean }>;
  commentOnPR(
    repoFullName: string,
    prUrl: string,
    comment: string,
    creds: GitCredentials,
  ): Promise<void>;
  getPRState(
    repoFullName: string,
    prUrl: string,
    creds: GitCredentials,
  ): Promise<"open" | "closed" | "merged">;
  fetchBranch(repoDir: string, branch: string, creds: GitCredentials): Promise<boolean>;
  getPRComments(repoFullName: string, prUrl: string, creds: GitCredentials): Promise<PRComment[]>;
}

// ── GitHubProvider ──────────────────────────────────────────────────────────

export class GitHubProvider implements GitProvider {
  async clone(
    repoFullName: string,
    targetDir: string,
    branch: string,
    creds: GitCredentials,
    opts?: CloneOptions,
  ): Promise<void> {
    const url = `https://x-access-token:${creds.token}@github.com/${repoFullName}.git`;
    const sanitizedUrl = `https://github.com/${repoFullName}.git`;
    logger.info({ repoFullName, branch, targetDir }, "Cloning GitHub repo");
    const args = ["clone", "--branch", branch, "--single-branch"];
    if (opts?.depth) args.push("--depth", String(opts.depth));
    args.push(url, targetDir);
    await execGit(args, process.cwd());
    // Strip embedded token from .git/config to avoid credentials persisting on disk
    await execGit(["remote", "set-url", "origin", sanitizedUrl], targetDir);
  }

  async createBranch(repoDir: string, branchName: string): Promise<void> {
    logger.info({ repoDir, branchName }, "Creating branch");
    await execGit(["checkout", "-b", branchName], repoDir);
  }

  async commitAll(repoDir: string, message: string): Promise<void> {
    logger.info({ repoDir, message }, "Committing all changes");
    await execGit(["add", "-A"], repoDir);
    try {
      await execGit(["commit", "-m", message], repoDir);
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code !== 1) throw err;
      logger.debug({ repoDir }, "commitAll: nothing to commit");
    }
  }

  async push(
    repoDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<void> {
    // Set the remote URL with embedded token to authenticate the push
    const remoteUrl = await execGit(["remote", "get-url", "origin"], repoDir);
    let authedUrl: string;
    if (remoteUrl.includes("@")) {
      authedUrl = remoteUrl.replace(
        /https:\/\/[^@]*@/,
        `https://x-access-token:${creds.token}@`,
      );
    } else {
      authedUrl = remoteUrl.replace(
        /https:\/\//,
        `https://x-access-token:${creds.token}@`,
      );
    }
    await execGit(["remote", "set-url", "origin", authedUrl], repoDir);

    // Fetch before push so --force-with-lease has current tracking refs.
    // Use FETCH_HEAD instead of refs/remotes/origin/<branch> because
    // single-branch clones don't create tracking refs for other branches.
    let leaseFlag = "--force-with-lease";
    try {
      await execGit(["fetch", "origin", branch], repoDir);
      const remoteSha = await execGit(["rev-parse", "FETCH_HEAD"], repoDir);
      leaseFlag = `--force-with-lease=${branch}:${remoteSha}`;
    } catch { /* branch may not exist yet — use bare --force-with-lease */ }

    logger.info({ repoDir, branch }, "Pushing branch");
    await execGit(["push", leaseFlag, "origin", branch], repoDir);
  }

  async createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
    creds: GitCredentials,
  ): Promise<{ url: string; reused: boolean }> {
    logger.info({ repoFullName, head, base, title }, "Creating GitHub PR");

    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repo format: "${repoFullName}" (expected owner/repo)`);
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body, head, base }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      // 422 with "already exists" — find and return the existing PR URL.
      if (response.status === 422 && text.includes("A pull request already exists")) {
        logger.info({ repoFullName, head }, "PR already exists — fetching existing PR URL");
        const [headOwner] = repoFullName.split("/");
        const listResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(`${headOwner}:${head}`)}&state=open`,
          {
            headers: {
              Authorization: `Bearer ${creds.token}`,
              Accept: "application/vnd.github+json",
            },
          },
        );
        if (listResponse.ok) {
          const prs = (await listResponse.json()) as Array<{ html_url: string }>;
          if (prs.length > 0) {
            logger.info({ prUrl: prs[0].html_url }, "Reusing existing GitHub PR");
            return { url: prs[0].html_url, reused: true };
          }
        }
      }
      throw new Error(`GitHub PR creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { html_url: string };
    logger.info({ prUrl: data.html_url }, "GitHub PR created");
    return { url: data.html_url, reused: false };
  }

  async commentOnPR(
    repoFullName: string,
    prUrl: string,
    comment: string,
    creds: GitCredentials,
  ): Promise<void> {
    const prNumber = extractGitHubPRNumber(prUrl);
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repo format: "${repoFullName}" (expected owner/repo)`);
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: comment }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub PR comment failed (${response.status}): ${text}`);
    }

    logger.info({ repoFullName, prNumber }, "GitHub PR comment posted");
  }

  async getPRState(
    repoFullName: string,
    prUrl: string,
    creds: GitCredentials,
  ): Promise<"open" | "closed" | "merged"> {
    const prNumber = extractGitHubPRNumber(prUrl);
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repo format: "${repoFullName}" (expected owner/repo)`);
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub get PR state failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { state: string; merged: boolean };

    if (data.merged) return "merged";
    if (data.state === "closed") return "closed";
    return "open";
  }

  async fetchBranch(
    repoDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<boolean> {
    const remoteUrl = await execGit(["remote", "get-url", "origin"], repoDir);
    const authedUrl = remoteUrl.includes("@")
      ? remoteUrl.replace(/https:\/\/[^@]*@/, `https://x-access-token:${creds.token}@`)
      : remoteUrl.replace(/https:\/\//, `https://x-access-token:${creds.token}@`);
    await execGit(["remote", "set-url", "origin", authedUrl], repoDir);
    try {
      await execGit(["fetch", "origin", branch], repoDir);
      return true;
    } catch {
      return false;
    } finally {
      await execGit(["remote", "set-url", "origin", remoteUrl], repoDir);
    }
  }

  async getPRComments(
    repoFullName: string,
    prUrl: string,
    creds: GitCredentials,
  ): Promise<PRComment[]> {
    const prNumber = extractGitHubPRNumber(prUrl);
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repo format: "${repoFullName}" (expected owner/repo)`);
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub get PR comments failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as Array<{
      id: number;
      body: string;
      user: { login: string } | null;
      created_at: string;
    }>;

    return data
      .filter((c) => !c.body.includes("_Automated by Hive") && !c.body.includes("_Automated review by Hive"))
      .map((c) => ({
        id: c.id,
        body: c.body,
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
      }));
  }
}

// ── AzureDevOpsProvider ─────────────────────────────────────────────────────

export class AzureDevOpsProvider implements GitProvider {
  async clone(
    repoFullName: string,
    targetDir: string,
    branch: string,
    creds: GitCredentials,
    opts?: CloneOptions,
  ): Promise<void> {
    // repoFullName format: org/project/repo
    const [org, project, repo] = repoFullName.split("/");
    if (!org || !project || !repo) {
      throw new Error(
        `Invalid Azure DevOps repo format: "${repoFullName}" (expected org/project/repo)`,
      );
    }

    const encOrg = encodeURIComponent(org);
    const encProject = encodeURIComponent(project);
    const encRepo = encodeURIComponent(repo);
    const url = `https://${creds.token}@dev.azure.com/${encOrg}/${encProject}/_git/${encRepo}`;
    const sanitizedUrl = `https://dev.azure.com/${encOrg}/${encProject}/_git/${encRepo}`;
    logger.info({ repoFullName, branch, targetDir }, "Cloning Azure DevOps repo");
    const args = ["clone", "--branch", branch, "--single-branch"];
    if (opts?.depth) args.push("--depth", String(opts.depth));
    args.push(url, targetDir);
    await execGit(args, process.cwd());
    // Strip embedded token from .git/config to avoid credentials persisting on disk
    await execGit(["remote", "set-url", "origin", sanitizedUrl], targetDir);
  }

  async createBranch(repoDir: string, branchName: string): Promise<void> {
    logger.info({ repoDir, branchName }, "Creating branch");
    await execGit(["checkout", "-b", branchName], repoDir);
  }

  async commitAll(repoDir: string, message: string): Promise<void> {
    logger.info({ repoDir, message }, "Committing all changes");
    await execGit(["add", "-A"], repoDir);
    try {
      await execGit(["commit", "-m", message], repoDir);
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code !== 1) throw err;
      logger.debug({ repoDir }, "commitAll: nothing to commit");
    }
  }

  async push(
    repoDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<void> {
    // Set the remote URL with embedded token to authenticate the push
    const remoteUrl = await execGit(["remote", "get-url", "origin"], repoDir);
    const [org, project, repo] = remoteUrl
      .replace(/^https:\/\/([^@]+@)?dev\.azure\.com\//, "")
      .replace(/\/_git\//, "/")
      .split("/");
    const authedUrl = `https://${creds.token}@dev.azure.com/${org}/${project}/_git/${repo}`;
    await execGit(["remote", "set-url", "origin", authedUrl], repoDir);

    // Fetch before push so --force-with-lease has current tracking refs.
    // Use FETCH_HEAD instead of refs/remotes/origin/<branch> because
    // single-branch clones don't create tracking refs for other branches.
    let leaseFlag = "--force-with-lease";
    try {
      await execGit(["fetch", "origin", branch], repoDir);
      const remoteSha = await execGit(["rev-parse", "FETCH_HEAD"], repoDir);
      leaseFlag = `--force-with-lease=${branch}:${remoteSha}`;
    } catch { /* branch may not exist yet — use bare --force-with-lease */ }

    logger.info({ repoDir, branch }, "Pushing branch");
    await execGit(["push", leaseFlag, "origin", branch], repoDir);
  }

  async createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
    creds: GitCredentials,
  ): Promise<{ url: string; reused: boolean }> {
    const { org, project, repo } = parseAdoRepoName(repoFullName);
    try {
      const result = await createPullRequest(org, project, repo, head, base, title, body, creds.token);
      return { url: result.url, reused: false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("(409)") || msg.includes("TF401179")) {
        logger.info({ repoFullName, head }, "ADO PR already exists — looking up existing PR");
        const existing = await listPullRequests(org, project, repo, head, creds.token);
        if (existing.length > 0) {
          logger.info({ prUrl: existing[0].url }, "Reusing existing ADO PR");
          return { url: existing[0].url, reused: true };
        }
      }
      throw err;
    }
  }

  async commentOnPR(
    repoFullName: string,
    prUrl: string,
    comment: string,
    creds: GitCredentials,
  ): Promise<void> {
    const { org, project, repo } = parseAdoRepoName(repoFullName);
    const prId = extractAdoPRNumber(prUrl);
    await adoCreatePRComment(org, project, repo, prId, comment, creds.token);
  }

  async getPRState(
    repoFullName: string,
    prUrl: string,
    creds: GitCredentials,
  ): Promise<"open" | "closed" | "merged"> {
    const { org, project, repo } = parseAdoRepoName(repoFullName);
    const prId = extractAdoPRNumber(prUrl);
    const pr = await getPullRequest(org, project, repo, prId, creds.token);

    // ADO statuses: active, completed, abandoned, notSet
    if (pr.status === "completed") return "merged";
    if (pr.status === "abandoned") return "closed";
    return "open";
  }

  async fetchBranch(
    repoDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<boolean> {
    const remoteUrl = await execGit(["remote", "get-url", "origin"], repoDir);
    const [org, project, repo] = remoteUrl
      .replace(/^https:\/\/([^@]+@)?dev\.azure\.com\//, "")
      .replace(/\/_git\//, "/")
      .split("/");
    const authedUrl = `https://${creds.token}@dev.azure.com/${org}/${project}/_git/${repo}`;
    await execGit(["remote", "set-url", "origin", authedUrl], repoDir);
    try {
      await execGit(["fetch", "origin", branch], repoDir);
      return true;
    } catch {
      return false;
    } finally {
      await execGit(["remote", "set-url", "origin", remoteUrl], repoDir);
    }
  }

  async getPRComments(
    repoFullName: string,
    prUrl: string,
    creds: GitCredentials,
  ): Promise<PRComment[]> {
    const { org, project, repo } = parseAdoRepoName(repoFullName);
    const prId = extractAdoPRNumber(prUrl);
    const comments = await getPRThreadComments(org, project, repo, prId, creds.token);

    return comments
      .filter((c) => !c.body.includes("_Automated by Hive") && !c.body.includes("_Automated review by Hive"))
      .map((c) => ({
        id: c.id,
        body: c.body,
        author: c.author,
        createdAt: c.createdAt,
      }));
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function getGitProvider(provider: string): GitProvider {
  switch (provider) {
    case "github":
      return new GitHubProvider();
    case "azure_devops":
      return new AzureDevOpsProvider();
    default:
      throw new Error(`Unknown git provider: ${provider}`);
  }
}
