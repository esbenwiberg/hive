import { rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { getByUserAndProvider } from "../db/queries/user-credentials.js";
import { getSecret } from "../vault/keyvault.js";
import { getGitProvider } from "./git-provider.js";
import type { GitCredentials, WorktreeInfo } from "../domain/types.js";

const execFileAsync = promisify(execFile);

const WORKTREE_BASE = process.env.HIVE_WORKTREE_DIR ?? "/tmp/hive-worktrees";

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
  await gitProvider.createBranch(worktreePath, branch);

  // Set git identity so commits are attributed to The Hive
  await execFileAsync("git", ["config", "user.name", "The Hive"], { cwd: worktreePath });
  await execFileAsync("git", ["config", "user.email", "hive@thehive.ai"], { cwd: worktreePath });

  logger.info({ repoFullName, branch, path: worktreePath }, "Worktree created");

  return {
    path: worktreePath,
    branch,
    repoFullName,
    provider,
    createdAt: new Date(),
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
