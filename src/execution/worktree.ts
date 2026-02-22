import { rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { getByUserAndProvider } from "../db/queries/user-credentials.js";
import { getSecret } from "../vault/keyvault.js";
import { getGitProvider } from "./git-provider.js";
import type { GitCredentials, WorktreeInfo } from "../domain/types.js";

const execFileAsync = promisify(execFile);

const WORKTREE_BASE = "/tmp/hive-worktrees";

/**
 * Resolves git credentials for a user by looking up their stored token.
 * Throws if no credentials are found for the user+provider combination.
 */
export async function resolveGitCredentials(
  userId: number,
  provider: string,
): Promise<GitCredentials> {
  const cred = await getByUserAndProvider(userId, provider);
  if (!cred) {
    throw new Error(`No ${provider} credentials found for user ${userId}`);
  }

  const token = await getSecret(cred.vaultSecretId);
  if (!token) {
    throw new Error(
      `Secret ${cred.vaultSecretId} not found in vault for user ${userId}`,
    );
  }

  return { provider, token };
}

/**
 * Creates an isolated working directory by cloning the repo and creating a feature branch.
 * Returns WorktreeInfo with the path, branch, and metadata.
 */
export async function createWorktree(
  repoFullName: string,
  provider: string,
  branch: string,
  defaultBranch: string,
  userId: number,
): Promise<WorktreeInfo> {
  const creds = await resolveGitCredentials(userId, provider);
  const dirName = `${branch.replace(/\//g, "-")}-${Date.now()}`;
  const worktreePath = `${WORKTREE_BASE}/${dirName}`;

  // Ensure the parent directory exists; git clone will create worktreePath itself
  await mkdir(WORKTREE_BASE, { recursive: true });

  const gitProvider = getGitProvider(provider);
  await gitProvider.clone(repoFullName, worktreePath, defaultBranch, creds);

  // Record the base SHA before creating the feature branch (used for diffing)
  const { stdout: baseShaRaw } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  const baseSha = baseShaRaw.trim();

  // Try to recover an existing remote branch (e.g. from a previous run that pushed milestones)
  let recovered = false;
  const hasBranch = await gitProvider.fetchBranch(worktreePath, branch, creds);
  if (hasBranch) {
    // Use FETCH_HEAD explicitly — single-branch clones don't create
    // remote tracking refs for other branches, so `git checkout <branch>`
    // would fail with "pathspec did not match".
    await execFileAsync("git", ["checkout", "-b", branch, "FETCH_HEAD"], { cwd: worktreePath });
    recovered = true;
    logger.info({ repoFullName, branch, path: worktreePath }, "Recovered existing remote branch");
  } else {
    await gitProvider.createBranch(worktreePath, branch);
  }

  // Set git identity so commits are attributed to The Hive
  await execFileAsync("git", ["config", "user.name", "The Hive"], { cwd: worktreePath });
  await execFileAsync("git", ["config", "user.email", "hive@thehive.ai"], { cwd: worktreePath });

  logger.info({ repoFullName, branch, path: worktreePath, baseSha, recovered }, "Worktree created");

  return {
    path: worktreePath,
    branch,
    repoFullName,
    provider,
    createdAt: new Date(),
    baseSha,
    recovered,
  };
}

/**
 * Cleans up a worktree by recursively deleting its directory.
 */
export async function cleanupWorktree(worktree: WorktreeInfo): Promise<void> {
  try {
    await rm(worktree.path, { recursive: true, force: true });
    logger.info({ path: worktree.path }, "Worktree cleaned up");
  } catch (err) {
    logger.error({ path: worktree.path, err }, "Failed to clean up worktree");
  }
}
