import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Well-known doc files to look for in the repo root. */
const ROOT_DOC_FILES = [
  "README.md",
  "README.rst",
  "README.txt",
  "README",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  ".hive.yaml",
  "openapi.yaml",
  "openapi.json",
  "swagger.yaml",
  "swagger.json",
  "api.yaml",
  "api.json",
];

/** Directories that commonly contain documentation. */
const DOC_DIRS = ["docs", "doc", "documentation"];

/** Max chars to read from each doc for the summary. */
const SUMMARY_LENGTH = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks whether a path exists and is a file.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Checks whether a path exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads the first SUMMARY_LENGTH characters of a file.
 */
async function readSummary(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf-8");
    return content.slice(0, SUMMARY_LENGTH);
  } catch {
    return "";
  }
}

/**
 * Scans a directory (non-recursively) for documentation files.
 */
async function scanDocDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return files;
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const docsEnricher: Enricher = {
  name: "docs",

  async run(
    _task: TaskRow,
    repoDir: string,
    _priorResults: Record<string, unknown>,
    _config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    const docsFound: Array<{ path: string; summary: string }> = [];

    // Check well-known root doc files
    for (const fileName of ROOT_DOC_FILES) {
      const fullPath = join(repoDir, fileName);
      if (await isFile(fullPath)) {
        const summary = await readSummary(fullPath);
        docsFound.push({
          path: fileName,
          summary,
        });
      }
    }

    // Scan doc directories
    for (const dirName of DOC_DIRS) {
      const dirPath = join(repoDir, dirName);
      if (await isDirectory(dirPath)) {
        const files = await scanDocDir(dirPath);
        for (const filePath of files) {
          const relative = filePath.slice(repoDir.length + 1);
          const summary = await readSummary(filePath);
          docsFound.push({
            path: relative,
            summary,
          });
        }
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      data: {
        docs: {
          count: docsFound.length,
          files: docsFound,
        },
      },
      durationMs,
    };
  },
};
