import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";
import logger from "../logger.js";

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
 * Splits a camelCase or PascalCase string into lowercase segments.
 * e.g. "ResourceCreatedHandler" → ["resource", "created", "handler"]
 */
function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/);
}

/**
 * Splits a file path into matchable segments: directory names, file name parts
 * (split on -, _, ., and camelCase boundaries), all lowercased.
 */
function pathSegments(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const segments: string[] = [];
  for (const part of parts) {
    // Split on common separators
    const tokens = part.split(/[-_.]/);
    for (const token of tokens) {
      // Further split camelCase/PascalCase
      segments.push(...splitCamelCase(token));
    }
  }
  return segments.filter((s) => s.length > 0);
}

/**
 * Extracts keywords from task title and body for file matching.
 *
 * Title keywords are weighted higher than body keywords. Common programming
 * terms, UI vocabulary, and short words are filtered out to reduce noise.
 */
function extractKeywords(task: TaskRow): { title: string[]; body: string[] } {
  const split = (text: string) =>
    text
      .toLowerCase()
      .split(/[\s\-_/\\.,;:!?()[\]{}'"<>|=+*&#@~`]+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  const titleKw = [...new Set(split(task.title))];
  const bodyKw = [...new Set(split(task.body ?? ""))].filter(
    (w) => !titleKw.includes(w),
  );

  return { title: titleKw, body: bodyKw };
}

/** Words that are too generic to be useful for file-path matching. */
const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "not", "nor", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some", "such",
  "than", "too", "very", "just", "also", "now", "then", "here", "there",
  "when", "where", "why", "how", "what", "which", "who", "whom", "this",
  "that", "these", "those", "its", "they", "them", "their",
  // Programming verbs & generic terms
  "create", "read", "update", "delete", "make", "build", "show", "hide",
  "enable", "disable", "toggle", "click", "press", "open", "close",
  "start", "stop", "send", "receive", "load", "save", "store", "fetch",
  "push", "pull", "call", "return", "check", "validate", "handle",
  "render", "display", "print", "write", "copy", "move", "remove",
  "pass", "fail", "test", "debug", "error", "warn", "info", "true",
  "false", "null", "undefined", "default", "value", "values", "type",
  "name", "title", "text", "label", "description", "content", "data",
  "item", "items", "list", "array", "object", "string", "number",
  "boolean", "function", "method", "class", "interface", "component",
  "module", "import", "export", "require", "const", "variable",
  // UI vocabulary
  "button", "input", "form", "modal", "dialog", "popup", "dropdown",
  "select", "option", "field", "state", "props", "style", "color",
  "width", "height", "size", "margin", "padding", "border", "font",
  "icon", "image", "link", "page", "view", "layout", "header",
  "footer", "sidebar", "panel", "card", "table", "column", "row",
  "cell", "grid", "section", "container", "wrapper", "body",
  "disabled", "enabled", "selected", "active", "visible", "hidden",
  "required", "optional", "readonly", "editable",
  // Requirement language
  "currently", "shows", "should", "needs", "must", "only", "even",
  "still", "already", "below", "above", "based", "changes", "change",
  "added", "adds", "keeps", "kept", "tries", "tried", "considered",
  "limited", "full", "dynamically", "outside", "inside", "within",
]);

const MAX_SCAN_FILES = 10_000;

/**
 * Recursively scans a directory, collecting file paths while skipping ignored dirs.
 * Stops after MAX_SCAN_FILES to stay bounded on large monorepos.
 */
async function scanDir(dir: string, counter: { count: number; capped: boolean } = { count: 0, capped: false }): Promise<string[]> {
  const files: string[] = [];

  if (counter.capped) return files;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (counter.capped) break;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await scanDir(fullPath, counter);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(fullPath);
      counter.count++;
      if (counter.count >= MAX_SCAN_FILES) {
        counter.capped = true;
        break;
      }
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

    const scanCounter = { count: 0, capped: false };
    const allFiles = await scanDir(repoDir, scanCounter);
    if (scanCounter.capped) {
      logger.warn({ repoDir, scanned: scanCounter.count, limit: MAX_SCAN_FILES }, "codebase enricher: file scan capped — working with partial results");
    }
    const keywords = extractKeywords(task);
    const allKw = [...keywords.title, ...keywords.body];

    // Score files by keyword matches against path segments.
    // Title keywords count double. Require at least 2 points to be included.
    const scored: { path: string; score: number }[] = [];
    for (const filePath of allFiles) {
      const relative = filePath.slice(repoDir.length + 1);
      const segments = pathSegments(relative);

      let score = 0;
      for (const kw of keywords.title) {
        if (segments.some((seg) => seg === kw || seg.includes(kw))) {
          score += 2; // title keywords worth double
        }
      }
      for (const kw of keywords.body) {
        if (segments.some((seg) => seg === kw || seg.includes(kw))) {
          score += 1;
        }
      }

      if (score >= 2) {
        scored.push({ path: relative, score });
      }
    }

    // Sort by relevance score descending
    scored.sort((a, b) => b.score - a.score);
    const relatedFiles = scored.map((s) => s.path);

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
          scanCapped: scanCounter.capped,
          testFileCount,
          fileTypes,
          relatedFiles: relatedFiles.slice(0, 50), // cap at 50
          keywordsUsed: allKw,
        },
      },
      durationMs,
    };
  },
};
