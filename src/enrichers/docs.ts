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

/** Structured doc directories (checked first, take priority). */
const STRUCTURED_DOC_DIRS = ["docs/internal", "docs/external"] as const;

/** Legacy/generic doc directories. */
const LEGACY_DOC_DIRS = ["docs", "doc", "documentation"];

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
 * Scans a directory for documentation files, optionally recursing one level
 * into subdirectories.
 */
async function scanDocDir(dir: string, recurse = false): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        files.push(full);
      } else if (recurse && entry.isDirectory()) {
        // One level of recursion
        try {
          const subEntries = await readdir(full, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile()) {
              files.push(join(full, sub.name));
            }
          }
        } catch {
          // Subdirectory not readable, skip
        }
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

    type DocEntry = { path: string; summary: string };
    const internal: DocEntry[] = [];
    const external: DocEntry[] = [];
    const other: DocEntry[] = [];

    // Track paths already collected to avoid duplicates when legacy dirs
    // overlap with structured dirs (e.g. docs/ contains docs/internal/)
    const seen = new Set<string>();

    const collectEntry = async (filePath: string, bucket: DocEntry[]) => {
      const relative = filePath.slice(repoDir.length + 1);
      if (seen.has(relative)) return;
      seen.add(relative);
      const summary = await readSummary(filePath);
      bucket.push({ path: relative, summary });
    };

    // 1. Check structured doc directories (recurse one level)
    for (const dirName of STRUCTURED_DOC_DIRS) {
      const dirPath = join(repoDir, dirName);
      if (await isDirectory(dirPath)) {
        const bucket = dirName === "docs/internal" ? internal : external;
        const files = await scanDocDir(dirPath, true);
        for (const filePath of files) {
          await collectEntry(filePath, bucket);
        }
      }
    }

    // 2. Check well-known root doc files → other
    for (const fileName of ROOT_DOC_FILES) {
      const fullPath = join(repoDir, fileName);
      if (await isFile(fullPath)) {
        await collectEntry(fullPath, other);
      }
    }

    // 3. Scan legacy doc directories → other (skip files already seen)
    for (const dirName of LEGACY_DOC_DIRS) {
      const dirPath = join(repoDir, dirName);
      if (await isDirectory(dirPath)) {
        const files = await scanDocDir(dirPath);
        for (const filePath of files) {
          await collectEntry(filePath, other);
        }
      }
    }

    const allFiles = [...internal, ...external, ...other];
    const durationMs = Date.now() - startTime;

    return {
      data: {
        docs: {
          count: allFiles.length,
          internal,
          external,
          other,
          files: allFiles, // backward compat
        },
      },
      durationMs,
    };
  },
};
