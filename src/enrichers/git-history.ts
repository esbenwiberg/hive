import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Runs a git command in the given directory, returning stdout trimmed.
 * Returns null if the command fails (e.g. not a git repo).
 */
async function gitCmd(repoDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      maxBuffer: 1024 * 1024, // 1 MB
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// ── Filters ─────────────────────────────────────────────────────────────────

/** File extensions that are documentation/config noise for code tasks. */
const DOC_EXTS = new Set([
  ".md", ".rst", ".adoc", ".gitkeep", ".editorconfig",
  ".prettierrc", ".eslintignore", ".gitignore", ".gitattributes",
]);

function isDocOrConfig(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  if (lastDot >= 0 && DOC_EXTS.has(lower.slice(lastDot))) return true;
  // Common doc/meta directories
  if (/^(\.|)(ai|documentation|memorybank|changes|githooks)\//i.test(filePath)) return true;
  return false;
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const gitHistoryEnricher: Enricher = {
  name: "git-history",

  async run(
    task: TaskRow,
    repoDir: string,
    priorResults: Record<string, unknown>,
    _config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    // Recent commits (last 50)
    const logOutput = await gitCmd(repoDir, ["log", "--oneline", "-50"]);

    if (logOutput === null) {
      // Not a git repo or git not available
      const durationMs = Date.now() - startTime;
      return {
        data: {
          gitHistory: {
            recentCommits: [],
            hotspots: [],
            contributors: [],
            warning: "Not a git repository or git is not available",
          },
        },
        durationMs,
      };
    }

    const recentCommits = logOutput
      ? logOutput.split("\n").filter((l) => l.length > 0)
      : [];

    // Active contributors (last 30 days)
    // git log --format='%an' --since='30 days ago' | sort | uniq -c | sort -rn
    // We run git log to get author names, then deduplicate in JS to avoid shell piping
    const authorsOutput = await gitCmd(repoDir, [
      "log",
      "--format=%an",
      "--since=30 days ago",
    ]);

    const contributors: string[] = [];
    if (authorsOutput) {
      const counts = new Map<string, number>();
      for (const name of authorsOutput.split("\n")) {
        if (name.length === 0) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      // Sort by count descending, format as "count name"
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [name, count] of sorted) {
        contributors.push(`${count} ${name}`);
      }
    }

    // Change frequency hotspots (last 30 days, top 20)
    // git log --name-only --format='' --since='30 days ago' | sort | uniq -c | sort -rn | head -20
    const filesOutput = await gitCmd(repoDir, [
      "log",
      "--name-only",
      "--format=",
      "--since=30 days ago",
    ]);

    // Collect file change counts, separating code from docs/config
    const codeHotspots: string[] = [];
    const docHotspots: string[] = [];
    const taskRelevantHotspots: string[] = [];

    if (filesOutput) {
      const counts = new Map<string, number>();
      for (const file of filesOutput.split("\n")) {
        if (file.length === 0) continue;
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

      // Extract task keywords from codebase enricher or task title
      const codebaseData = priorResults.codebase as Record<string, unknown> | undefined;
      const taskKeywords: string[] = Array.isArray(codebaseData?.keywordsUsed)
        ? (codebaseData.keywordsUsed as string[])
        : task.title.toLowerCase().split(/[\s\-_/\\.,;:!?()[\]{}'"<>|]+/).filter((w) => w.length >= 4);

      for (const [file, count] of sorted) {
        const entry = `${count} ${file}`;
        const lower = file.toLowerCase();

        // Check task relevance
        if (taskKeywords.some((kw) => lower.includes(kw))) {
          if (taskRelevantHotspots.length < 20) taskRelevantHotspots.push(entry);
        }

        if (isDocOrConfig(file)) {
          if (docHotspots.length < 10) docHotspots.push(entry);
        } else {
          if (codeHotspots.length < 20) codeHotspots.push(entry);
        }
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      data: {
        gitHistory: {
          recentCommits,
          hotspots: codeHotspots,       // code-only hotspots (backward compat key)
          docHotspots,                   // separated doc/config changes
          taskRelevantHotspots,          // files matching task keywords
          contributors,
        },
      },
      durationMs,
    };
  },
};
