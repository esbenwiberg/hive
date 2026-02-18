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

// ── Enricher ─────────────────────────────────────────────────────────────────

export const gitHistoryEnricher: Enricher = {
  name: "git-history",

  async run(
    _task: TaskRow,
    repoDir: string,
    _priorResults: Record<string, unknown>,
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

    const hotspots: string[] = [];
    if (filesOutput) {
      const counts = new Map<string, number>();
      for (const file of filesOutput.split("\n")) {
        if (file.length === 0) continue;
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      const sorted = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      for (const [file, count] of sorted) {
        hotspots.push(`${count} ${file}`);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      data: {
        gitHistory: {
          recentCommits,
          hotspots,
          contributors,
        },
      },
      durationMs,
    };
  },
};
