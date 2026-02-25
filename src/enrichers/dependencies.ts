import { readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";
import { detectBuildSystem } from "../execution/build-system.js";

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_FILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;
const PACKAGE_REFERENCE_RE = /PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursively find *.csproj files up to maxDepth levels deep. */
async function findCsproj(dir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".csproj")) {
      results.push(join(dir, entry.name));
    } else if (entry.isDirectory() && maxDepth > 0) {
      results.push(...await findCsproj(join(dir, entry.name), maxDepth - 1));
    }
  }
  return results;
}

// ── Branch helpers ────────────────────────────────────────────────────────────

async function readNpmDeps(
  pkgDir: string,
): Promise<Record<string, unknown>> {
  const pkgPath = join(pkgDir, "package.json");

  let pkgJson: Record<string, unknown>;
  try {
    const raw = await readFile(pkgPath, "utf-8");
    pkgJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      dependencies: {},
      devDependencies: {},
      lockFile: null,
      scripts: [],
    };
  }

  const dependencies = (pkgJson.dependencies ?? {}) as Record<string, string>;
  const devDependencies = (pkgJson.devDependencies ?? {}) as Record<string, string>;
  const scripts = Object.keys((pkgJson.scripts ?? {}) as Record<string, string>);
  const engines = pkgJson.engines as Record<string, string> | undefined;

  let lockFile: string | null = null;
  for (const lf of LOCK_FILES) {
    if (await fileExists(join(pkgDir, lf))) {
      lockFile = lf;
      break;
    }
  }

  const data: Record<string, unknown> = { dependencies, devDependencies, lockFile, scripts };
  if (engines) data.engines = engines;
  return data;
}

async function readDotnetDeps(
  dotnetDir: string,
): Promise<Record<string, unknown>> {
  const csprojFiles = await findCsproj(dotnetDir, 3);
  const nugetPackages: Record<string, string> = {};

  for (const csproj of csprojFiles) {
    let content: string;
    try {
      content = await readFile(csproj, "utf-8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    PACKAGE_REFERENCE_RE.lastIndex = 0;
    while ((match = PACKAGE_REFERENCE_RE.exec(content)) !== null) {
      nugetPackages[match[1]] = match[2];
    }
  }

  const projects = csprojFiles.map((p) => p.slice(dotnetDir.length + 1));

  return {
    dependencies: {},
    devDependencies: {},
    lockFile: null,
    scripts: [],
    nugetPackages,
    projects,
  };
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const dependenciesEnricher: Enricher = {
  name: "dependencies",

  async run(
    _task: TaskRow,
    repoDir: string,
    _priorResults: Record<string, unknown>,
    _config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    const info = await detectBuildSystem(repoDir);

    let data: Record<string, unknown>;

    if (info.type === "npm") {
      data = await readNpmDeps(info.npmDir ?? repoDir);
    } else if (info.type === "dotnet") {
      data = await readDotnetDeps(info.dotnetDir ?? repoDir);
    } else {
      // dotnet+npm — merge both
      const [npmData, dotnetData] = await Promise.all([
        readNpmDeps(info.npmDir ?? repoDir),
        readDotnetDeps(info.dotnetDir ?? repoDir),
      ]);
      data = { ...npmData, ...dotnetData };
    }

    data.buildSystem = info.type;

    const durationMs = Date.now() - startTime;
    return { data, durationMs };
  },
};
