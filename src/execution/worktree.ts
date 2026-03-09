import { rm, mkdir, appendFile, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "../logger.js";
import { getByUserAndProvider } from "../db/queries/user-credentials.js";
import { getSecret, repoSecretName } from "../vault/keyvault.js";
import { getGitProvider } from "./git-provider.js";
import type { GitCredentials, WorktreeInfo } from "../domain/types.js";

const execFileAsync = promisify(execFile);

/** Escape special characters for safe interpolation into XML attribute values. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
        const hostPath = registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (npm.scope) {
          lines.push(`${npm.scope as string}:registry=${registryUrl}`);
        } else {
          lines.push(`registry=${registryUrl}`);
        }
        lines.push("always-auth=true");
        // Azure DevOps Artifacts feeds require base64 _password + email on two URL paths
        const isAzureDevOps = /pkgs\.dev\.azure\.com|\.pkgs\.visualstudio\.com/.test(registryUrl);
        if (isAzureDevOps) {
          const b64 = Buffer.from(token.trim()).toString("base64");
          // Collect auth paths: the registry URL itself + the parent /npm/ path if applicable
          const authPaths = [hostPath];
          const npmParent = hostPath.replace(/\/npm\/registry\/?$/, "/npm");
          if (npmParent !== hostPath && npmParent !== hostPath + "/") {
            authPaths.push(npmParent);
          }
          for (const p of authPaths) {
            lines.push(`//${p}/:username=hive`);
            lines.push(`//${p}/:_password=${b64}`);
            lines.push(`//${p}/:email=hive@thehive.ai`);
          }
        } else {
          lines.push(`//${hostPath}/:_authToken=${token.trim()}`);
        }
        const npmrcContent = lines.join("\n") + "\n";

        // Write .npmrc at repo root
        await writeFile(`${worktreePath}/.npmrc`, npmrcContent);
        excludes.push(".npmrc\n");

        // Also write .npmrc into every subdirectory that has a package.json,
        // since npm won't walk above the project root (nearest package.json).
        // Use explicit setting first, then auto-scan one level of subdirs.
        const build = s.build as Record<string, unknown> | undefined;
        const explicitNpmDir = build?.npmDir as string | undefined;
        const npmSubDirs: string[] = [];

        if (explicitNpmDir) {
          npmSubDirs.push(explicitNpmDir.replace(/^\.\//, ""));
        } else {
          // Auto-scan: find subdirs with package.json
          try {
            const entries = await readdir(worktreePath, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
              try {
                await access(join(worktreePath, entry.name, "package.json"));
                npmSubDirs.push(entry.name);
              } catch { /* no package.json here */ }
            }
          } catch { /* readdir failed — skip */ }
        }

        for (const subDir of npmSubDirs) {
          const subPath = join(worktreePath, subDir);
          try {
            await access(subPath);
            await writeFile(join(subPath, ".npmrc"), npmrcContent);
            logger.info({ repoFullName, subDir }, "Injected .npmrc into npm subdirectory");
          } catch { /* dir doesn't exist */ }
        }

        logger.info({ repoFullName, isAzureDevOps, npmSubDirs }, "Injected .npmrc for private npm registry");
      }
    }

    // NuGet — nuget.config
    const nuget = s.nuget as Record<string, unknown> | undefined;
    if (nuget?.url && nuget.tokenVaultId) {
      const token = await getSecret(nuget.tokenVaultId as string);
      if (!token) {
        logger.error({ repoFullName, vaultId: nuget.tokenVaultId }, "NuGet token missing from Key Vault — dotnet restore will likely fail for private feeds");
      } else {
        // Check for existing nuget.config (case-insensitive — Windows repos often use NuGet.Config)
        let existingName: string | null = null;
        try {
          const entries = await readdir(worktreePath);
          existingName = entries.find(e => e.toLowerCase() === "nuget.config") ?? null;
        } catch { /* readdir failed — assume not exists */ }

        if (existingName) {
          // Merge credentials into the repo's existing nuget.config
          const merged = await mergeNugetCredentials(
            join(worktreePath, existingName),
            nuget.url as string,
            token,
          );
          if (merged) {
            logger.info({ repoFullName, existingName }, "Merged credentials into existing nuget.config for private NuGet feed");
          } else {
            logger.warn({ repoFullName, existingName }, "Failed to merge credentials into existing nuget.config — dotnet restore may fail for private feeds");
          }
        } else {
          const xml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            "<configuration>",
            "  <packageSources>",
            `    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />`,
            `    <add key="private" value="${escapeXml(nuget.url as string)}" />`,
            "  </packageSources>",
            "  <packageSourceCredentials>",
            "    <private>",
            '      <add key="Username" value="hive" />',
            `      <add key="ClearTextPassword" value="${escapeXml(token)}" />`,
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

/**
 * Merges private feed credentials into an existing nuget.config file.
 * Finds the package source matching `feedUrl` (or adds it), then injects
 * `<packageSourceCredentials>` with the provided token.
 * Returns true on success, false if the XML couldn't be patched.
 */
async function mergeNugetCredentials(
  configPath: string,
  feedUrl: string,
  token: string,
): Promise<boolean> {
  try {
    let content = await readFile(configPath, "utf-8");

    // Collect all non-nuget.org package source keys — we'll inject credentials
    // for every private feed (same PAT typically covers all feeds in one org).
    const sourceKeys: string[] = [];
    const sourcesSection = content.match(/<packageSources>([\s\S]*?)<\/packageSources>/i)?.[1] ?? "";
    const sourceRegex = /<add\s+key="([^"]+)"\s+[^>]*value="([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = sourceRegex.exec(sourcesSection)) !== null) {
      const [, key, url] = m;
      if (!/nuget\.org/i.test(url)) sourceKeys.push(key);
    }

    if (sourceKeys.length === 0) {
      // No private feeds found — add one for our configured URL
      sourceKeys.push("hive-private");
      const sourceEntry = `    <add key="hive-private" value="${escapeXml(feedUrl)}" />\n  `;
      if (/<\/packageSources>/i.test(content)) {
        content = content.replace(/<\/packageSources>/i, `${sourceEntry}</packageSources>`);
      } else {
        return false;
      }
    }

    // Build credential blocks for all private feeds
    const credBlocks = sourceKeys.map((key) => {
      // Encode characters invalid in XML element names (dots, hyphens,
      // underscores and alphanumerics are all valid — only encode the rest).
      const elName = key.replace(/[^a-zA-Z0-9._-]/g, (ch) => {
        const hex = ch.charCodeAt(0).toString(16).padStart(4, "0");
        return `_x${hex}_`;
      });
      return [
        `    <${elName}>`,
        `      <add key="Username" value="hive" />`,
        `      <add key="ClearTextPassword" value="${escapeXml(token)}" />`,
        `    </${elName}>`,
      ].join("\n");
    }).join("\n");

    if (/<packageSourceCredentials>/i.test(content)) {
      // Append our credential block inside the existing section
      content = content.replace(
        /<\/packageSourceCredentials>/i,
        `${credBlocks}\n  </packageSourceCredentials>`,
      );
    } else {
      // No credentials section yet — add one before </configuration>
      const credSection = [
        "  <packageSourceCredentials>",
        credBlocks,
        "  </packageSourceCredentials>",
      ].join("\n");
      content = content.replace(/<\/configuration>/i, `${credSection}\n</configuration>`);
    }

    await writeFile(configPath, content);
    return true;
  } catch (err) {
    logger.error({ configPath, err }, "Failed to merge NuGet credentials into existing config");
    return false;
  }
}
