import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_FILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

    const pkgPath = join(repoDir, "package.json");

    let pkgJson: Record<string, unknown>;
    try {
      const raw = await readFile(pkgPath, "utf-8");
      pkgJson = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No package.json or invalid JSON — return empty result
      const durationMs = Date.now() - startTime;
      return {
        data: {
          dependencies: {},
          devDependencies: {},
          lockFile: null,
          scripts: [],
        },
        durationMs,
      };
    }

    const dependencies = (pkgJson.dependencies ?? {}) as Record<string, string>;
    const devDependencies = (pkgJson.devDependencies ?? {}) as Record<string, string>;
    const scripts = Object.keys((pkgJson.scripts ?? {}) as Record<string, string>);
    const engines = pkgJson.engines as Record<string, string> | undefined;

    // Detect lock file
    let lockFile: string | null = null;
    for (const lf of LOCK_FILES) {
      if (await fileExists(join(repoDir, lf))) {
        lockFile = lf;
        break;
      }
    }

    const durationMs = Date.now() - startTime;

    const data: Record<string, unknown> = {
      dependencies,
      devDependencies,
      lockFile,
      scripts,
    };

    if (engines) {
      data.engines = engines;
    }

    return {
      data,
      durationMs,
    };
  },
};
