/**
 * Disk cleaner module – scans for orphan worktrees, leftover preview
 * artefacts, and stale temp/build directories.  Cross-references the
 * filesystem against active task records in the DB.
 */

import { readdir, stat, rm, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, normalize } from "node:path";
import logger from "../logger.js";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { WORKTREE_BASE } from "./worktree.js";
import { PREVIEW_DIR_PREFIX } from "../daemon/preview-cleanup.js";

export { WORKTREE_BASE };

const execFileAsync = promisify(execFile);

/** Prefix used by temp/build directories */
const TEMP_DIR_PREFIX = "hive-tmp-";

// ─── Public types ─────────────────────────────────────────────────────────────

export type DiskItemType = "worktree" | "preview" | "temp";

export interface DiskItem {
  /** Absolute path on disk */
  path: string;
  /** Category of the item */
  type: DiskItemType;
  /** Estimated size in bytes */
  sizeBytes: number;
  /** Directory creation timestamp */
  createdAt: Date;
  /** Human-readable reason why this item is considered orphaned/stale */
  reason: string;
}

export interface CleanResult {
  freedBytes: number;
  removedCount: number;
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively computes the total size of a directory in bytes.
 * Falls back to 0 on any error (e.g. permission denied).
 */
export async function dirSizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const full = `${dirPath}/${entry.name}`;
        if (entry.isDirectory()) {
          total += await dirSizeBytes(full);
        } else {
          try {
            const s = await stat(full);
            total += s.size;
          } catch {
            // ignore unreadable files
          }
        }
      }),
    );
  } catch {
    // ignore unreadable directories
  }
  return total;
}

/**
 * Parses the output of `git worktree list --porcelain` and returns an array
 * of worktree paths listed by git.
 *
 * Example block:
 *   worktree /tmp/hive-worktrees/hive-HIVE-20260222-…
 *   HEAD abc123
 *   branch refs/heads/feature-x
 *
 *   worktree /bare
 *   HEAD def456
 *   bare
 */
export function parseGitWorktreeList(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

/**
 * Fetches the set of task IDs that are currently "active" – i.e. not in a
 * terminal state.  Terminal states are: completed, failed, cancelled.
 */
export async function getActiveTaskIds(): Promise<Set<string>> {
  const TERMINAL = ["completed", "failed", "cancelled"] as const;

  // Fetch all non-terminal tasks' ids
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      // status NOT IN terminal list
      inArray(tasks.status, ["pending", "approved", "ready", "running", "reviewing", "rework", "suspended"]),
    );

  return new Set(rows.map((r) => r.id));
}

/**
 * Checks whether a directory name looks like it belongs to a task whose ID is
 * not in the provided active-task set.  Hive task IDs match the pattern
 * `HIVE-YYYYMMDD-xxxxxxxx` – we scan the directory name for any such token.
 *
 * Returns the extracted task ID if the directory appears to be for an orphan
 * task, or null if we cannot determine ownership (→ conservatively kept).
 */
function extractTaskId(dirName: string): string | null {
  const match = dirName.match(/HIVE-\d{8}-\d+/);
  return match ? match[0] : null;
}

// ─── scan() ───────────────────────────────────────────────────────────────────

/**
 * Scans the filesystem for orphan worktrees, stale preview artefacts, and
 * stale temp directories.  Returns a structured list of candidates for
 * cleanup.
 */
export async function scan(): Promise<DiskItem[]> {
  const results: DiskItem[] = [];

  // 1. Determine which task IDs are still active in the DB
  let activeTaskIds: Set<string>;
  try {
    activeTaskIds = await getActiveTaskIds();
  } catch (err) {
    logger.error({ err }, "disk-cleaner: failed to query active task IDs");
    throw err;
  }

  // 2. Read the worktree base directory
  let entries: string[];
  try {
    entries = await readdir(WORKTREE_BASE);
  } catch (err: unknown) {
    // If the base directory doesn't exist yet there's nothing to clean
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  // 3. Collect git-tracked worktree paths so we can report accurate reasons
  let gitWorktreePaths: Set<string>;
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", WORKTREE_BASE,
      "worktree", "list", "--porcelain",
    ]);
    gitWorktreePaths = new Set(parseGitWorktreeList(stdout));
  } catch {
    // git may not be initialised in the base dir – that's fine, we still
    // check filesystem directories
    gitWorktreePaths = new Set();
  }

  // 4. Classify each directory
  await Promise.all(
    entries.map(async (name) => {
      const fullPath = `${WORKTREE_BASE}/${name}`;

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(fullPath);
      } catch {
        return; // skip unreadable entries
      }

      if (!info.isDirectory()) return;

      const createdAt = info.birthtime ?? info.mtime;
      const taskId = extractTaskId(name);

      // ── Preview artefact directories ──────────────────────────────────────
      if (name.startsWith(PREVIEW_DIR_PREFIX)) {
        const isOrphan = taskId ? !activeTaskIds.has(taskId) : true;
        if (isOrphan) {
          results.push({
            path: fullPath,
            type: "preview",
            sizeBytes: await dirSizeBytes(fullPath),
            createdAt,
            reason: taskId
              ? `Preview artefact for task ${taskId} which is no longer active`
              : "Preview artefact with no recognisable task ID",
          });
        }
        return;
      }

      // ── Temp / build directories ──────────────────────────────────────────
      if (name.startsWith(TEMP_DIR_PREFIX)) {
        // Temp dirs older than 24 h are considered stale
        const ageMs = Date.now() - createdAt.getTime();
        const staleThresholdMs = 24 * 60 * 60 * 1000;
        if (ageMs > staleThresholdMs) {
          results.push({
            path: fullPath,
            type: "temp",
            sizeBytes: await dirSizeBytes(fullPath),
            createdAt,
            reason: `Temp directory older than 24 hours (age: ${Math.round(ageMs / 3600_000)}h)`,
          });
        }
        return;
      }

      // ── Worktree directories ──────────────────────────────────────────────
      // Everything else in the base dir is assumed to be a worktree clone
      if (taskId === null) {
        // No task ID recognisable – flag as orphan only if also not in git list
        if (!gitWorktreePaths.has(fullPath)) {
          results.push({
            path: fullPath,
            type: "worktree",
            sizeBytes: await dirSizeBytes(fullPath),
            createdAt,
            reason: "Worktree directory with no recognisable task ID and not tracked by git",
          });
        }
        return;
      }

      const isOrphanTask = !activeTaskIds.has(taskId);
      if (isOrphanTask) {
        const isGitTracked = gitWorktreePaths.has(fullPath);
        results.push({
          path: fullPath,
          type: "worktree",
          sizeBytes: await dirSizeBytes(fullPath),
          createdAt,
          reason: isGitTracked
            ? `Orphan worktree for task ${taskId} (task no longer active, still listed in git worktree list)`
            : `Orphan worktree for task ${taskId} (task no longer active)`,
        });
      }
    }),
  );

  logger.info(
    { total: results.length, worktreeBase: WORKTREE_BASE },
    "disk-cleaner: scan complete",
  );

  return results;
}

// ─── validatePaths() ──────────────────────────────────────────────────────────

/**
 * Validates that every path to be deleted:
 *  1. Is an absolute path
 *  2. Does not contain path-traversal sequences after normalisation
 *  3. Is strictly inside WORKTREE_BASE (after symlink resolution)
 *
 * Resolves symlinks (using realpath()) before checking against WORKTREE_BASE,
 * preventing symlink-based escape attempts. Throws on the first invalid path.
 */
export async function validatePaths(paths: string[]): Promise<void> {
  const base = resolve(WORKTREE_BASE);

  for (const p of paths) {
    if (!p.startsWith("/")) {
      throw new Error(`Rejected non-absolute path: ${p}`);
    }

    const normalised = normalize(resolve(p));

    // Must be a direct child of WORKTREE_BASE (not the base itself)
    if (normalised === base) {
      throw new Error(`Rejected attempt to delete the worktree base directory: ${p}`);
    }

    // Check the normalised path first
    if (!normalised.startsWith(base + "/")) {
      throw new Error(
        `Rejected path-traversal attempt: ${p} resolves to ${normalised} which is outside ${base}`,
      );
    }

    // Resolve symlinks to prevent symlink-based escape attempts (e.g., a symlink
    // pointing outside the base directory). If the path doesn't exist, we can't
    // resolve symlinks but we've already validated the normalised path above.
    let realPath: string;
    try {
      realPath = await realpath(normalised);
    } catch {
      // Path doesn't exist yet (or is unreadable) – validated normalised path is sufficient
      continue;
    }

    // Check the real (symlink-resolved) path
    if (!realPath.startsWith(base + "/")) {
      throw new Error(
        `Rejected path-traversal attempt: ${p} resolves to real path ${realPath} which is outside ${base}`,
      );
    }
  }
}

// ─── clean() ─────────────────────────────────────────────────────────────────

/**
 * Deletes the specified paths from disk.  Validates each path before
 * deletion to prevent path-traversal attacks.
 *
 * Returns the number of freed bytes, the number of successfully removed
 * items, and any per-item error messages.
 */
export async function clean(paths: string[]): Promise<CleanResult> {
  // Fail fast if any path is invalid – do not perform partial deletes
  await validatePaths(paths);

  let freedBytes = 0;
  let removedCount = 0;
  const errors: string[] = [];

  await Promise.all(
    paths.map(async (p) => {
      const normalised = normalize(resolve(p));
      try {
        const size = await dirSizeBytes(normalised);
        await rm(normalised, { recursive: true, force: true });
        freedBytes += size;
        removedCount++;
        logger.info({ path: normalised, sizeBytes: size }, "disk-cleaner: removed item");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${normalised}: ${msg}`);
        logger.error({ path: normalised, err }, "disk-cleaner: failed to remove item");
      }
    }),
  );

  logger.info(
    { removedCount, freedBytes, errorCount: errors.length },
    "disk-cleaner: clean complete",
  );

  return { freedBytes, removedCount, errors };
}
