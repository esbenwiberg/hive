import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  "__pycache__",
  "bin",
  "obj",
  ".vs",
  "TestResults",
  "packages",
]);

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /tests?\//,
  /__tests__\//,
  /Tests\.cs$/,
  /Spec\.cs$/,
  /\.Tests\//,
  /Tests\//,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts keywords from task title and body for file matching.
 * Splits on whitespace and special chars, lowercases, removes short/common words.
 */
function extractKeywords(task: TaskRow): string[] {
  const text = `${task.title} ${task.body}`.toLowerCase();
  const words = text.split(/[\s\-_/\\.,;:!?()[\]{}'"<>|=+*&#@~`]+/);

  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "and", "but", "or",
    "not", "no", "nor", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some", "such",
    "than", "too", "very", "just", "also", "now", "then", "here", "there",
    "when", "where", "why", "how", "what", "which", "who", "whom", "this",
    "that", "these", "those", "it", "its",
  ]);

  return words.filter((w) => w.length > 2 && !stopWords.has(w));
}

/**
 * Recursively scans a directory, collecting file paths while skipping ignored dirs.
 */
async function scanDir(dir: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await scanDir(fullPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const codebaseEnricher: Enricher = {
  name: "codebase",

  async run(
    task: TaskRow,
    repoDir: string,
    _priorResults: Record<string, unknown>,
    _config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    const allFiles = await scanDir(repoDir);
    const keywords = extractKeywords(task);

    // Find files that match keywords from the task
    const relatedFiles: string[] = [];
    for (const filePath of allFiles) {
      const relative = filePath.slice(repoDir.length + 1);
      const lower = relative.toLowerCase();

      if (keywords.some((kw) => lower.includes(kw))) {
        relatedFiles.push(relative);
      }
    }

    // Build file types breakdown
    const fileTypes: Record<string, number> = {};
    for (const filePath of allFiles) {
      const ext = extname(filePath) || "(no ext)";
      fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
    }

    // Count test files
    let testFileCount = 0;
    for (const filePath of allFiles) {
      const relative = filePath.slice(repoDir.length + 1);
      if (TEST_PATTERNS.some((p) => p.test(relative))) {
        testFileCount++;
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      data: {
        codebase: {
          totalFiles: allFiles.length,
          testFileCount,
          fileTypes,
          relatedFiles: relatedFiles.slice(0, 50), // cap at 50
          keywordsUsed: keywords,
        },
      },
      durationMs,
    };
  },
};
