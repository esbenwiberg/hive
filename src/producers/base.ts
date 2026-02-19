import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq, and, notInArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProducerContext {
  repoId: number;
  repoFullName: string;
  repoDir?: string;
  createdBy: number;
  dryRun?: boolean;
  config?: Record<string, unknown>;
}

export interface ProducerResult {
  tasksCreated: number;
  duplicatesSkipped: number;
  errors: string[];
  costUsd: number;
}

export interface Producer {
  name: string;
  /** When true the daemon will shallow-clone the repo before running. */
  needsRepo?: boolean;
  run(ctx: ProducerContext): Promise<ProducerResult>;
}

// ── Repo summary helpers ────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  ".turbo", "__pycache__", ".venv", "vendor",
]);

const MAX_TREE_FILES = 200;
const MAX_README_CHARS = 3000;

/**
 * Collects a shallow file tree and README content from a local repo clone.
 * Returns undefined if the directory doesn't exist.
 */
export function gatherRepoSummary(repoDir: string): string | undefined {
  if (!existsSync(repoDir)) return undefined;

  // Collect file tree (breadth-first, capped)
  const files: string[] = [];
  const queue: string[] = [repoDir];

  while (queue.length > 0 && files.length < MAX_TREE_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        files.push(relative(repoDir, full));
        if (files.length >= MAX_TREE_FILES) break;
      }
    }
  }

  const tree = files.join("\n");

  // Read README
  let readme = "";
  for (const name of ["README.md", "readme.md", "README.rst", "README"]) {
    const p = join(repoDir, name);
    if (existsSync(p)) {
      try {
        readme = readFileSync(p, "utf-8").slice(0, MAX_README_CHARS);
      } catch { /* ignore */ }
      break;
    }
  }

  const parts = [`## File tree\n${tree}`];
  if (readme) parts.push(`## README\n${readme}`);
  return parts.join("\n\n");
}

// ── Title validation ────────────────────────────────────────────────────────

const REFUSAL_PATTERNS = [
  /I don't have the ability to/i,
  /I cannot directly access/i,
  /I can't (?:access|analyze|browse|review|read)/i,
  /I don't have access to/i,
  /share the relevant code/i,
  /provide (?:the |a )?(?:link|source code|relevant)/i,
  /I would need you to/i,
  /I'd be happy to (?:help|analyze) .* (?:if|once) you/i,
];

/**
 * Returns true if the title looks like an LLM refusal rather than
 * a genuine task title.
 */
export function isRefusalTitle(title: string): boolean {
  if (title.length > 200) return true;
  return REFUSAL_PATTERNS.some((re) => re.test(title));
}

// ── Duplicate check ─────────────────────────────────────────────────────────

/**
 * Checks whether a task with the given source and title already exists
 * in a non-terminal status. Returns true if a duplicate is found.
 */
export async function isDuplicate(
  source: string,
  title: string,
): Promise<boolean> {
  const terminalStatuses = ["failed", "cancelled", "merged", "done"];

  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.source, source),
        eq(tasks.title, title),
        notInArray(tasks.status, terminalStatuses),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
