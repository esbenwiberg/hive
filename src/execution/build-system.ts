import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { parseHiveBuildConfig } from "../hive-yaml.js";

// ── Types ─────────────────────────────────────────────────────────────────────

import type { BuildSystemType } from "../hive-yaml.js";
export type { BuildSystemType };

export interface BuildSystemInfo {
  type: BuildSystemType;
  npmDir: string | null;    // absolute path to dir containing package.json
  dotnetDir: string | null; // absolute path to dir containing .sln or root .csproj
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if any *.sln file exists at the given directory (non-recursive). */
async function hasSln(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && e.name.endsWith(".sln"));
}

/** Returns true if any *.csproj file exists at dir or one level deep. */
async function hasCsproj(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  // Check root
  if (entries.some((e) => e.isFile() && e.name.endsWith(".csproj"))) {
    return true;
  }

  // Check one level of subdirs
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let sub;
    try {
      sub = await readdir(join(dir, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    if (sub.some((e) => e.isFile() && e.name.endsWith(".csproj"))) {
      return true;
    }
  }

  return false;
}

// Preferred subdir names when scanning for package.json
const PREFERRED_NPM_DIRS = new Set(["client", "frontend", "web", "app"]);

/**
 * Scans one level of subdirs for a package.json.
 * Prefers dirs named client/frontend/web/app over others.
 */
async function findNpmSubdir(repoDir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(repoDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Check preferred dirs first
  for (const name of dirs) {
    if (PREFERRED_NPM_DIRS.has(name)) {
      if (await fileExists(join(repoDir, name, "package.json"))) {
        return join(repoDir, name);
      }
    }
  }

  // Fall back to first match
  for (const name of dirs) {
    if (await fileExists(join(repoDir, name, "package.json"))) {
      return join(repoDir, name);
    }
  }

  return null;
}

// ── detectBuildSystem ─────────────────────────────────────────────────────────

/**
 * Detects the build system used by a repository.
 *
 * Detection order:
 * 1. Check `.hive.yaml` build section for an override.
 * 2. Look for .sln at root → dotnet.
 * 3. Glob *.csproj at depth ≤ 1 → dotnet.
 * 4. Look for package.json at root → npm.
 * 5. Scan one level of subdirs for package.json (prefers client/frontend/web/app).
 * 6. Combine to determine type: dotnet | npm | dotnet+npm.
 *
 * @param repoDir   Absolute path to the repository root.
 * @param override  Force a specific build system type (still populates roots).
 */
export async function detectBuildSystem(
  repoDir: string,
  override?: BuildSystemType,
): Promise<BuildSystemInfo> {
  // Read .hive.yaml build config
  const hiveBuild = parseHiveBuildConfig(repoDir);
  const effectiveOverride = override ?? hiveBuild?.system;
  const hiveNpmDir = hiveBuild?.npmDir ? join(repoDir, hiveBuild.npmDir) : undefined;

  // Detect dotnet
  const dotnetPresent = (await hasSln(repoDir)) || (await hasCsproj(repoDir));
  const dotnetDir = dotnetPresent ? repoDir : null;

  // Detect npm
  let npmDir: string | null = null;
  if (await fileExists(join(repoDir, "package.json"))) {
    npmDir = repoDir;
  } else if (hiveNpmDir) {
    // .hive.yaml told us where npm lives
    npmDir = hiveNpmDir;
  } else {
    npmDir = await findNpmSubdir(repoDir);
  }

  // Determine type from detection (before applying override)
  let detectedType: BuildSystemType;
  if (dotnetPresent && npmDir) {
    detectedType = "dotnet+npm";
  } else if (dotnetPresent) {
    detectedType = "dotnet";
  } else {
    detectedType = "npm";
  }

  const finalType = effectiveOverride ?? detectedType;

  // When override forces dotnet-only but we found npm, clear it
  // When override forces npm-only but we found dotnet, clear it
  const finalNpmDir = finalType === "dotnet" ? null : (npmDir ?? repoDir);
  const finalDotnetDir = finalType === "npm" ? null : (dotnetDir ?? repoDir);

  return {
    type: finalType,
    npmDir: finalNpmDir,
    dotnetDir: finalDotnetDir,
  };
}
