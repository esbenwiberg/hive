import { rm, mkdir, appendFile, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { getByUserAndProvider } from "../db/queries/user-credentials.js";
import { getSecret, repoSecretName } from "../vault/keyvault.js";
import { getGitProvider } from "./git-provider.js";
import type { GitCredentials, WorktreeInfo } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export const WORKTREE_BASE = "/tmp/hive-worktrees";

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
  repoSettings?: { repoId?: number; settings?: Record<string, unknown> },
): Promise<WorktreeInfo> {
  const creds = await resolveGitCredentials(userId, provider);
  const dirName = `${branch.replace(/\//g, "-")}-${Date.now()}`;
  const worktreePath = `${WORKTREE_BASE}/${dirName}`;

  // Ensure the parent directory exists; git clone will create worktreePath itself
  await mkdir(WORKTREE_BASE, { recursive: true });

  const gitProvider = getGitProvider(provider);
  await gitProvider.clone(repoFullName, worktreePath, defaultBranch, creds);

  // Record the base SHA before creating the feature branch (used for diffing)
  const { stdout: defaultHeadRaw } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  let baseSha = defaultHeadRaw.trim();

  // Try to recover an existing remote branch (e.g. from a previous run that pushed milestones)
  let recovered = false;
  const hasBranch = await gitProvider.fetchBranch(worktreePath, branch, creds);
  if (hasBranch) {
    // Use FETCH_HEAD explicitly — single-branch clones don't create
    // remote tracking refs for other branches, so `git checkout <branch>`
    // would fail with "pathspec did not match".
    await execFileAsync("git", ["checkout", "-b", branch, "FETCH_HEAD"], { cwd: worktreePath });
    recovered = true;

    // The recovered branch may have been forked from an older commit on the
    // default branch.  If main has advanced since then, `baseSha` (current
    // main HEAD) would cause the diff to include unrelated changes from main.
    // Use merge-base to find the true fork point.
    try {
      const { stdout: mergeBaseRaw } = await execFileAsync(
        "git", ["merge-base", defaultHeadRaw.trim(), "HEAD"], { cwd: worktreePath },
      );
      baseSha = mergeBaseRaw.trim();
      logger.info({ repoFullName, branch, baseSha, defaultHead: defaultHeadRaw.trim() },
        "Recovered branch: baseSha set to merge-base");
    } catch (mbErr) {
      // If merge-base fails (e.g. disjoint histories), keep the default-branch HEAD.
      // The diff may include extra changes but at least won't crash.
      logger.warn({ repoFullName, branch, err: mbErr },
        "merge-base failed for recovered branch — falling back to default branch HEAD");
    }

    logger.info({ repoFullName, branch, path: worktreePath }, "Recovered existing remote branch");
  } else {
    await gitProvider.createBranch(worktreePath, branch);
  }

  // Set git identity so commits are attributed to The Hive
  await execFileAsync("git", ["config", "user.name", "The Hive"], { cwd: worktreePath });
  await execFileAsync("git", ["config", "user.email", "hive@thehive.ai"], { cwd: worktreePath });

  // Exclude preview artifacts from git tracking so `git add -A` never picks them up
  const excludes = ["\ndocker-compose.hive-preview.yml\n"];

  // Inject private package registry auth files
  if (repoSettings?.settings && repoSettings.repoId) {
    const s = repoSettings.settings;

    // npm — .npmrc
    const npm = s.npm as Record<string, unknown> | undefined;
    if (npm?.url && npm.tokenVaultId) {
      const token = await getSecret(npm.tokenVaultId as string);
      if (token) {
        const registryUrl = npm.url as string;
        const lines: string[] = [];
        // URL without protocol for auth line
        const hostPath = registryUrl.replace(/^https?:\/\//, "");
        if (npm.scope) {
          lines.push(`${npm.scope as string}:registry=${registryUrl}`);
        }
        // Azure DevOps Artifacts feeds require base64 _password, not _authToken
        const isAzureDevOps = /pkgs\.dev\.azure\.com|\.pkgs\.visualstudio\.com/.test(registryUrl);
        if (isAzureDevOps) {
          lines.push(`//${hostPath}/:username=hive`);
          lines.push(`//${hostPath}/:_password=${Buffer.from(token).toString("base64")}`);
        } else {
          lines.push(`//${hostPath}/:_authToken=${token}`);
        }
        const npmrcContent = lines.join("\n") + "\n";

        // Write .npmrc at repo root
        await writeFile(`${worktreePath}/.npmrc`, npmrcContent);
        excludes.push(".npmrc\n");

        // Also write into npm subdirectory if package.json isn't at root
        const build = s.build as Record<string, unknown> | undefined;
        const npmDir = build?.npmDir as string | undefined;
        if (npmDir) {
          const subPath = `${worktreePath}/${npmDir.replace(/^\.\//, "")}`;
          try {
            await access(subPath);
            await writeFile(`${subPath}/.npmrc`, npmrcContent);
            logger.info({ repoFullName, npmDir }, "Injected .npmrc into npm subdirectory");
          } catch {
            // Subdirectory doesn't exist yet — root .npmrc is enough
          }
        }
        logger.info({ repoFullName, isAzureDevOps }, "Injected .npmrc for private npm registry");
      }
    }

    // NuGet — nuget.config
    const nuget = s.nuget as Record<string, unknown> | undefined;
    if (nuget?.url && nuget.tokenVaultId) {
      const token = await getSecret(nuget.tokenVaultId as string);
      if (token) {
        // Only write if no existing nuget.config
        let exists = false;
        try { await access(`${worktreePath}/nuget.config`); exists = true; } catch { /* does not exist */ }
        if (!exists) {
          const xml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            "<configuration>",
            "  <packageSources>",
            `    <add key="private" value="${nuget.url as string}" />`,
            "  </packageSources>",
            "  <packageSourceCredentials>",
            "    <private>",
            '      <add key="Username" value="hive" />',
            `      <add key="ClearTextPassword" value="${token}" />`,
            "    </private>",
            "  </packageSourceCredentials>",
            "</configuration>",
          ].join("\n") + "\n";
          await writeFile(`${worktreePath}/nuget.config`, xml);
          excludes.push("nuget.config\n");
          logger.info({ repoFullName }, "Injected nuget.config for private NuGet feed");
        }
      }
    }
  }

  await appendFile(`${worktreePath}/.git/info/exclude`, excludes.join(""));

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
