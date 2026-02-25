import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq, and, notInArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";
import { callClaude, extractJson } from "../agents/sdk.js";
import { getOpenTasksForDedup, create as createTaskRecord } from "../db/queries/tasks.js";
import logger from "../logger.js";

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
  /** When true, runs once per daemon tick against the self-repo (not per-repo). */
  global?: boolean;
  run(ctx: ProducerContext): Promise<ProducerResult>;
}

// ── Repo summary helpers ────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  ".turbo", "__pycache__", ".venv", "vendor",
  "bin", "obj", ".vs", "TestResults", "packages",
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

/**
 * Result of a semantic duplicate check.
 * - `isDuplicate: false` — no near-identical task found, safe to create.
 * - `isDuplicate: true`  — a near-identical open task exists; `matchedTaskId`
 *   holds its ID so callers can log or surface it.
 */
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedTaskId?: string;
}

/**
 * Performs a semantic near-duplicate check for a proposed task.
 *
 * 1. Fetches recent non-terminal tasks from the DB (`getOpenTasksForDedup`).
 * 2. If no candidates exist, returns `{ isDuplicate: false }` immediately
 *    (no LLM call is made).
 * 3. Sends a single batched prompt to the LLM asking it to compare the
 *    proposed title+body against each candidate and return a JSON verdict.
 * 4. If the LLM identifies any near-identical match, returns
 *    `{ isDuplicate: true, matchedTaskId }` and emits a warning log.
 *
 * @param proposedTitle - Title of the task that is about to be created.
 * @param proposedBody  - Full markdown body of the proposed task.
 * @param options.producerType - Passed to `getOpenTasksForDedup` to restrict
 *   candidates to the same source (optional but recommended).
 * @param options.dryRun - When true, skips the LLM call and always returns false.
 */
export async function checkForDuplicate(
  proposedTitle: string,
  proposedBody: string,
  options: { producerType?: string; dryRun?: boolean } = {},
): Promise<DuplicateCheckResult> {
  // 1. Fetch candidates from the DB.
  const candidates = await getOpenTasksForDedup({
    producerType: options.producerType,
    limit: 50,
  });

  // 2. Short-circuit when there is nothing to compare against.
  if (candidates.length === 0) {
    return { isDuplicate: false };
  }

  // 3. Skip LLM in dry-run mode.
  if (options.dryRun) {
    return { isDuplicate: false };
  }

  // 4. Build a single batched prompt.
  const candidateList = candidates
    .map(
      (c, idx) =>
        `[${idx + 1}] ID: ${c.id}\nTitle: ${c.title}\nBody (first 400 chars): ${(c.body ?? "").slice(0, 400)}`,
    )
    .join("\n\n");

  const prompt = `You are a duplicate-task detector. Your job is to decide whether a PROPOSED task is semantically near-identical to any of the EXISTING open tasks listed below.

"Near-identical" means the tasks describe substantially the same problem or feature — not just using similar words, but actually requesting the same change. Minor wording differences, different formatting, or slightly broader/narrower scope do NOT make two tasks near-identical unless the core intent is the same.

## PROPOSED TASK
Title: ${proposedTitle}
Body: ${proposedBody.slice(0, 800)}

## EXISTING OPEN TASKS
${candidateList}

Respond with ONLY a JSON object — no prose, no markdown fences. Use this schema:
{
  "isDuplicate": true | false,
  "matchedId": "<task-id of the first near-identical match, or null if none>"
}`;

  let response: { isDuplicate: boolean; matchedId: string | null };
  try {
    const { text } = await callClaude({
      prompt,
      maxTokens: 256,
      systemPrompt:
        "You are a precise duplicate-detection assistant. Return only valid JSON.",
    });
    response = extractJson(text) as typeof response;
  } catch (err) {
    // If the LLM call fails we log and fall through (allow creation).
    logger.warn(
      { err, proposedTitle },
      "checkForDuplicate: LLM call failed, allowing task creation",
    );
    return { isDuplicate: false };
  }

  if (response.isDuplicate && response.matchedId) {
    logger.warn(
      { proposedTitle, matchedTaskId: response.matchedId },
      "Duplicate task detected — skipping creation",
    );
    return { isDuplicate: true, matchedTaskId: response.matchedId };
  }

  return { isDuplicate: false };
}

// ── Shared task-creation flow ────────────────────────────────────────────────

/**
 * Parameters for the shared task-creation helper.
 */
export interface CreateTaskParams {
  title: string;
  body: string;
  source: string;
  type?: string;
  size?: string;
  workflow?: string;
  repoId: number;
  createdBy: number;
  visibility?: string;
  skipPreview?: boolean;
  /** When true, skips both the exact-title and semantic duplicate checks. */
  dryRun?: boolean;
}

/**
 * Result returned by `createTaskWithDedup`.
 */
export interface CreateTaskResult {
  /** The newly created task, or undefined if the task was skipped. */
  task?: Awaited<ReturnType<typeof createTaskRecord>>;
  /** Whether the task was skipped because a near-duplicate already exists. */
  skipped: boolean;
  /** The ID of the existing task that caused the skip, if any. */
  matchedTaskId?: string;
}

/**
 * Shared task-creation helper used by all producers.
 *
 * Before inserting a new task this function runs two duplicate checks:
 *  1. **Exact-title check** (`isDuplicate`) — fast DB-only check.
 *  2. **Semantic check** (`checkForDuplicate`) — LLM-assisted near-duplicate
 *     detection against recent open tasks from the same source.
 *
 * If either check finds a duplicate the function returns
 * `{ skipped: true, matchedTaskId? }` without touching the DB.
 * Otherwise it inserts the task and returns `{ skipped: false, task }`.
 */
export async function createTaskWithDedup(
  params: CreateTaskParams,
): Promise<CreateTaskResult> {
  // 0. Refusal title check — reject LLM non-answers immediately.
  if (isRefusalTitle(params.title)) {
    logger.warn(
      { title: params.title, source: params.source },
      "Refusal-style title detected — skipping task creation",
    );
    return { skipped: true };
  }

  // 1. Fast exact-title check.
  const exactMatch = await isDuplicate(params.source, params.title);
  if (exactMatch) {
    logger.warn(
      { title: params.title, source: params.source },
      "Exact-title duplicate detected — skipping task creation",
    );
    return { skipped: true };
  }

  // 2. Semantic near-duplicate check via LLM.
  const semanticCheck = await checkForDuplicate(params.title, params.body, {
    producerType: params.source,
    dryRun: params.dryRun,
  });

  if (semanticCheck.isDuplicate) {
    // Warning already logged inside checkForDuplicate.
    return { skipped: true, matchedTaskId: semanticCheck.matchedTaskId };
  }

  // 3. No duplicate found — create the task.
  if (params.dryRun) {
    logger.info(
      { title: params.title, source: params.source },
      "[dry-run] Would create task (skipped DB insert)",
    );
    return { skipped: false };
  }

  const task = await createTaskRecord({
    title: params.title,
    body: params.body,
    source: params.source,
    type: params.type,
    size: params.size,
    workflow: params.workflow,
    repoId: params.repoId,
    createdBy: params.createdBy,
    visibility: params.visibility,
    skipPreview: params.skipPreview,
  });

  return { skipped: false, task };
}
