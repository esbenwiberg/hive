import { execFile } from "node:child_process";
import logger from "../logger.js";
import type { GitCredentials } from "../domain/types.js";
import { parseAdoRepoName, createPullRequest } from "../integrations/azure-devops.js";

// ── Helper ──────────────────────────────────────────────────────────────────

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
          logger.error({ args, cwd, stderr: stderr.toString() }, "git command failed");
          reject(error);
          return;
        }
        resolve(stdout.toString().trim());
      },
    );
  });
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface GitProvider {
  clone(repoUrl: string, targetDir: string, branch: string, creds: GitCredentials): Promise<void>;
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
  ): Promise<string>;
}

// ── GitHubProvider ──────────────────────────────────────────────────────────

export class GitHubProvider implements GitProvider {
  async clone(
    repoFullName: string,
    targetDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<void> {
    const url = `https://x-access-token:${creds.token}@github.com/${repoFullName}.git`;
    logger.info({ repoFullName, branch, targetDir }, "Cloning GitHub repo");
    await execGit(
      ["clone", "--branch", branch, "--single-branch", url, targetDir],
      process.cwd(),
    );
  }

  async createBranch(repoDir: string, branchName: string): Promise<void> {
    logger.info({ repoDir, branchName }, "Creating branch");
    await execGit(["checkout", "-b", branchName], repoDir);
  }

  async commitAll(repoDir: string, message: string): Promise<void> {
    logger.info({ repoDir, message }, "Committing all changes");
    await execGit(["add", "-A"], repoDir);
    await execGit(["commit", "-m", message], repoDir);
  }

  async push(
    repoDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<void> {
    // Set the remote URL with embedded token to authenticate the push
    const remoteUrl = await execGit(["remote", "get-url", "origin"], repoDir);
    const authedUrl = remoteUrl.replace(
      /https:\/\/[^@]*@/,
      `https://x-access-token:${creds.token}@`,
    );
    await execGit(["remote", "set-url", "origin", authedUrl], repoDir);

    logger.info({ repoDir, branch }, "Pushing branch");
    await execGit(["push", "origin", branch], repoDir);
  }

  async createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
    creds: GitCredentials,
  ): Promise<string> {
    logger.info({ repoFullName, head, base, title }, "Creating GitHub PR");

    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls`,
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
      throw new Error(`GitHub PR creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { html_url: string };
    logger.info({ prUrl: data.html_url }, "GitHub PR created");
    return data.html_url;
  }
}

// ── AzureDevOpsProvider ─────────────────────────────────────────────────────

export class AzureDevOpsProvider implements GitProvider {
  async clone(
    repoFullName: string,
    targetDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<void> {
    // repoFullName format: org/project/repo
    const [org, project, repo] = repoFullName.split("/");
    if (!org || !project || !repo) {
      throw new Error(
        `Invalid Azure DevOps repo format: "${repoFullName}" (expected org/project/repo)`,
      );
    }

    const url = `https://${creds.token}@dev.azure.com/${org}/${project}/_git/${repo}`;
    logger.info({ repoFullName, branch, targetDir }, "Cloning Azure DevOps repo");
    await execGit(
      ["clone", "--branch", branch, "--single-branch", url, targetDir],
      process.cwd(),
    );
  }

  async createBranch(repoDir: string, branchName: string): Promise<void> {
    logger.info({ repoDir, branchName }, "Creating branch");
    await execGit(["checkout", "-b", branchName], repoDir);
  }

  async commitAll(repoDir: string, message: string): Promise<void> {
    logger.info({ repoDir, message }, "Committing all changes");
    await execGit(["add", "-A"], repoDir);
    await execGit(["commit", "-m", message], repoDir);
  }

  async push(
    repoDir: string,
    branch: string,
    creds: GitCredentials,
  ): Promise<void> {
    // Set the remote URL with embedded token to authenticate the push
    const remoteUrl = await execGit(["remote", "get-url", "origin"], repoDir);
    const [org, project, repo] = remoteUrl
      .replace(/^https:\/\/[^@]*@dev\.azure\.com\//, "")
      .replace(/\/_git\//, "/")
      .split("/");
    const authedUrl = `https://${creds.token}@dev.azure.com/${org}/${project}/_git/${repo}`;
    await execGit(["remote", "set-url", "origin", authedUrl], repoDir);

    logger.info({ repoDir, branch }, "Pushing branch");
    await execGit(["push", "origin", branch], repoDir);
  }

  async createPR(
    repoFullName: string,
    head: string,
    base: string,
    title: string,
    body: string,
    creds: GitCredentials,
  ): Promise<string> {
    const { org, project, repo } = parseAdoRepoName(repoFullName);
    const result = await createPullRequest(org, project, repo, head, base, title, body, creds.token);
    return result.url;
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
