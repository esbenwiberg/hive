# Execution Module

> **Location:** `src/execution/`
> **Purpose:** Translates an approved task into real code changes — managing isolated git worktrees, orchestrating Claude's agentic coding loop, running review gates, and delivering the result as a pull request with an optional preview environment.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [Worktree Management — `worktree.ts`](#worktree-management--worktreeets)
3. [Worker (Task Executor) — `worker.ts`](#worker-task-executor--workerts)
4. [Git Provider Abstraction — `git-provider.ts`](#git-provider-abstraction--git-providerts)
5. [Review Gate — `review-gate.ts`](#review-gate--review-gatets)
6. [Milestone Review — `milestone-review.ts`](#milestone-review--milestone-reviewts)
7. [Worker Tools — `worker-tools.ts`](#worker-tools--worker-toolsts)
8. [Browser Tools — `browser-tools.ts`](#browser-tools--browser-toolsts)
9. [Preview System — `preview/`](#preview-system--preview)
   - [Manager — `preview/manager.ts`](#manager--previewmanagerts)
   - [Proxy — `preview/proxy.ts`](#proxy--previewproxysts)
   - [Remote Docker — `preview/remote-docker.ts`](#remote-docker--previewremote-dockerts)
   - [Validator — `preview/validator.ts`](#validator--previewvalidatorts)
   - [Types — `preview/types.ts`](#types--previewtypests)
10. [Execution Flow Walkthrough](#execution-flow-walkthrough)
11. [Epic vs. Flow Execution](#epic-vs-flow-execution)
12. [Rework and Retry Mechanics](#rework-and-retry-mechanics)
13. [Preview Environments](#preview-environments)
14. [Cross-Cutting Concerns](#cross-cutting-concerns)

---

## Module Overview

The `src/execution/` module is the "hands" of The Hive — where decisions made by agents become actual code. It sits between the approved task in the database and the opened pull request on GitHub or Azure DevOps.

### File Map

| File / Directory | Responsibility |
|---|---|
| `worktree.ts` | Clone repos; create/delete isolated `git` working directories |
| `worker.ts` | Main entry point: budget check → worktree → Claude loop → review → PR |
| `git-provider.ts` | Unified interface for GitHub and Azure DevOps REST APIs |
| `review-gate.ts` | Full-diff code review via Claude; returns pass / rework / fail verdict |
| `milestone-review.ts` | Per-milestone lint/build/test loop + AI fix for epic tasks |
| `worker-tools.ts` | Tool definitions (file I/O, shell) that Claude uses to write code |
| `browser-tools.ts` | Playwright-backed browser tool definitions for UI validation |
| `preview/manager.ts` | Lifecycle manager for Docker-based preview environments |
| `preview/proxy.ts` | Express router that proxies HTTP traffic to running previews |
| `preview/remote-docker.ts` | TLS-authenticated remote Docker client for preview container ops |
| `preview/validator.ts` | Health-check polling for newly started preview containers |
| `preview/types.ts` | Shared TypeScript interfaces for the preview subsystem |

### Key Design Principles

- **Isolation** — each task gets its own cloned git repository under `/tmp/hive-worktrees/`, preventing any cross-task interference.
- **Idempotency on rework** — the worktree is reused across rework cycles to preserve milestone progress; a fresh clone only happens when no valid prior worktree exists.
- **Provider abstraction** — all git hosting differences (GitHub vs. Azure DevOps) are hidden behind the `GitProvider` interface; the worker never speaks directly to a hosting API.
- **Graceful degradation** — failures in optional paths (learnings retrieval, preview startup, review commenting) are caught and logged without aborting the task.

---

## Worktree Management — `worktree.ts`

The worktree module provides the two lifecycle operations for isolated working directories.

### Constants

```ts
const WORKTREE_BASE = "/tmp/hive-worktrees";
```

All worktrees are created under this base path. Each directory is named `{branch-slug}-{timestamp}` to guarantee uniqueness.

### `resolveGitCredentials(userId, provider)`

```ts
async function resolveGitCredentials(
  userId: number,
  provider: string,
): Promise<GitCredentials>
```

Looks up the user's stored credential record in `user_credentials` (by `userId` + `provider`), then fetches the actual token from **Azure Key Vault** using the stored `vaultSecretId`. Throws if no credential row exists or the vault lookup fails.

This is the **only** place where git tokens are resolved from the vault. All callers pass credentials through from here.

### `createWorktree(repoFullName, provider, branch, defaultBranch, userId)`

```ts
async function createWorktree(
  repoFullName: string,
  provider: string,
  branch: string,           // e.g. "hive/task-abc123"
  defaultBranch: string,
  userId: number,
): Promise<WorktreeInfo>
```

**Steps:**

1. Calls `resolveGitCredentials` to get the user's token.
2. Creates the `WORKTREE_BASE` directory if needed (`mkdir -p`).
3. Calls `gitProvider.clone(repoFullName, worktreePath, defaultBranch, creds)` — clones the repo at the default branch tip.
4. Records `baseSha` with `git rev-parse HEAD` (the merge-base for later diffing).
5. Calls `gitProvider.createBranch(worktreePath, branch)` to switch to `hive/{taskId}`.
6. Sets `user.name = "The Hive"` and `user.email = "hive@thehive.ai"` in the local git config.
7. Returns a `WorktreeInfo` struct.

```ts
interface WorktreeInfo {
  path: string;         // absolute path on disk
  branch: string;       // git branch name
  repoFullName: string; // "owner/repo"
  provider: string;     // "github" | "ado"
  createdAt: Date;
  baseSha: string;      // SHA of default branch HEAD at clone time
}
```

### `cleanupWorktree(worktree)`

```ts
async function cleanupWorktree(worktree: WorktreeInfo): Promise<void>
```

Recursively deletes `worktree.path` with `rm -rf`. Errors are caught and logged — cleanup failure is never propagated to callers.

> **Note:** The worker only passes `worktree.path` to the delete operation. Other fields can be empty strings when called by daemon cleanup routines that only have the path.

---

## Worker (Task Executor) — `worker.ts`

`worker.ts` is the primary entry point for task execution. It exposes two public functions:

| Function | Used for |
|---|---|
| `executeTask(taskId)` | `flow` workflow tasks (and individual epic milestones) |
| `executeEpic(taskId)` | `epic` workflow — decomposes into child tasks |

### `executeTask(taskId): Promise<WorkerResult>`

The main execution path. High-level phases:

```
1. Load task + repo from DB
2. Budget check (remaining daily budget)
3. Register as active agent ("worker")
4. Transition status → executing
5. Resolve or reuse worktree
6. Retrieve relevant learnings (non-blocking)
7. Build user prompt (with enrichment trimming)
8. Execute: milestones loop OR single Claude pass
9. Record cost + increment executionAttempts
10. Empty-diff detection (auto-rework if nothing changed)
11. Transition → reviewing
12. Run review gate
13. On PASS: commit + push + start preview + create PR → done
14. On rework: refine task + transition → rework
15. On max cycles: fail task
16. FINALLY: conditional worktree cleanup + unregister
```

#### Budget Check

```ts
const remaining = await checkBudget(task.createdBy);
if (remaining <= 0) {
  await addEvent(taskId, "budget_exhausted", ...);
  throw new Error(`Budget exhausted for user ${task.createdBy}`);
}
```

The `checkBudget` query compares today's total spend for the user against their configured `daily_cost_usd` limit. Budget exhaustion throws immediately without touching task status — the daemon will retry the task when the budget resets.

#### Worktree Reuse

On rework cycles, the worker checks whether `task.worktreePath` still exists on disk and is a valid git repository:

```ts
if (task.worktreePath && task.worktreeBaseSha) {
  try {
    await access(task.worktreePath);
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: task.worktreePath });
    worktree = { path: task.worktreePath, ... };
    reusedWorktree = true;
  } catch {
    // fall through to create new worktree
  }
}
```

If the worktree is reused, `completedMilestones` is respected so epic tasks resume from where they left off.

#### Enrichment Trimming

The worker applies progressive trimming when the enrichment context is too large for the context window (rough budget: 170k tokens × 4 chars/token):

| Step | Action |
|---|---|
| 1 | Remove JSON pretty-printing (`JSON.stringify(obj)` instead of `null, 2`) |
| 2 | Keep only `architect` and `scorer` fields |
| 3 | Drop enrichment entirely |

Each step is logged with the character count so operators can diagnose context size issues.

#### Empty-Diff Detection

After Claude completes, the worker checks `git diff --name-only {baseSha}`. If the diff is empty:

- **First attempt**: automatically sets `retryInstructions` with a "you MUST call write_file" reminder, increments `reworkCount`, and transitions to `rework`.
- **Second attempt**: transitions to `failed` with reason "No code changes produced after rework attempt".

#### Worktree Lifecycle in `finally`

The `finally` block makes a deliberate decision about whether to preserve or delete the worktree:

| Condition | Action |
|---|---|
| Status is `rework` | Preserve (for next execution cycle) |
| Status is `failed` with partial milestones | Preserve (resume possible) |
| Status is `failed` from max rework cycles | Preserve (for debugging) |
| Preview is active | Defer cleanup to preview manager |
| All other cases | Delete immediately |

### `executeEpic(taskId): Promise<WorkerResult>`

Epic execution is simpler — it delegates to the decomposer agent:

1. Calls `decomposeEpic(taskId)` → array of `{ title, body, index, total }`.
2. Creates a child `task` row in the DB for each milestone, linked to the epic via `epicId`.
3. Each child task enters the pipeline independently as a `flow` task.
4. Transitions the parent epic: `executing → reviewing → done`.

There is no actual code generation in `executeEpic` itself — all implementation happens in the children's `executeTask` calls.

### `WorkerResult`

```ts
interface WorkerResult {
  success: boolean;
  prUrl?: string;
  previewUrl?: string;
  branch?: string;
  reviewResult?: ReviewGateResult;
  error?: string;
}
```

The daemon discards this return value in most cases, relying on the task's DB status instead.

---

## Git Provider Abstraction — `git-provider.ts`

The `GitProvider` interface provides a uniform API over GitHub REST/GraphQL and Azure DevOps REST v7.1, so the worker never has hosting-specific conditionals.

### Interface

```ts
interface GitProvider {
  clone(repoFullName: string, targetPath: string, branch: string, creds: GitCredentials): Promise<void>;
  createBranch(worktreePath: string, branch: string): Promise<void>;
  commitAll(worktreePath: string, message: string): Promise<void>;
  push(worktreePath: string, branch: string, creds: GitCredentials): Promise<void>;
  createPR(repoFullName: string, head: string, base: string, title: string, body: string, creds: GitCredentials): Promise<string>;
  commentOnPR(repoFullName: string, prUrl: string, body: string, creds: GitCredentials): Promise<void>;
  getPRState(repoFullName: string, prUrl: string, creds: GitCredentials): Promise<"open" | "closed" | "merged">;
}
```

### `getGitProvider(provider: string): GitProvider`

Factory function that returns the correct implementation:
- `"github"` → GitHub implementation (REST + GraphQL)
- `"ado"` → Azure DevOps implementation (REST v7.1)

### GitHub Implementation Details

- **Clone:** uses `git clone` with a token-authenticated HTTPS URL (`https://x-access-token:{token}@github.com/{repo}.git`).
- **Push:** similarly embeds token in the remote URL.
- **PR creation:** calls `POST /repos/{owner}/{repo}/pulls` via GitHub REST API.
- **PR commenting:** calls `POST /repos/{owner}/{repo}/issues/{number}/comments`.
- **PR state:** calls `GET /repos/{owner}/{repo}/pulls/{number}` and maps `state`/`merged_at`.

### Azure DevOps Implementation Details

- **Clone:** uses `git clone` with basic-auth HTTPS URL.
- **PR creation:** calls `POST /_apis/git/repositories/{repo}/pullrequests?api-version=7.1`.
- **Repo name parsing:** uses `parseAdoRepoName()` to split the compound ADO repo identifier.

---

## Review Gate — `review-gate.ts`

After code generation completes, `reviewChanges()` performs a structured AI review of the entire changeset before the PR is created.

### Entry Point

```ts
export async function reviewChanges(
  taskId: string,
  worktree: WorktreeInfo,
  learningIds: number[],
): Promise<ReviewGateResult>
```

### How It Works

1. **Compute the diff:** `git diff {baseSha}..HEAD` on the worktree — this captures every change made since the branch was created.
2. **Build the review prompt:** includes the full unified diff, the task description, enrichment data, and the IDs of learnings that were applied during implementation (for feedback loop attribution).
3. **Call Claude** (single-turn, using `getModelFor("review-gate")`).
4. **Parse the structured response** into a `ReviewGateResult`.

### `ReviewGateResult`

```ts
interface ReviewGateResult {
  verdict: "pass" | "rework" | "fail";
  findings: Finding[];          // code quality issues
  securityFindings: SecurityFinding[];
  verification: VerificationStatus;
  costUsd: number;
}

interface Finding {
  severity: "info" | "minor" | "major" | "critical";
  file?: string;
  line?: number;
  message: string;
  category: string;
}

interface SecurityFinding {
  severity: "low" | "medium" | "high" | "critical";
  type: string;
  file?: string;
  description: string;
}

interface VerificationStatus {
  buildSucceeded: boolean;
  testsRun: boolean;
  testsPassed: boolean;
  lintClean: boolean;
  notes: string[];
}
```

### Verdict Logic

The review prompt instructs Claude to issue:
- `pass` — code is correct and ready to merge.
- `rework` — fixable problems exist; the task should be reworked.
- `fail` — fundamental issues that cannot be fixed without starting over.

The worker maps these verdicts to task transitions:
- `pass` → push + PR + `done`
- `rework` → `refineTask()` + status `rework` (up to `MAX_REWORK_CYCLES = 2`)
- `fail` / max cycles exceeded → `failed`

---

## Milestone Review — `milestone-review.ts`

For epic tasks broken into architect milestones, each milestone goes through an inner review-fix loop before being committed.

### Entry Point

```ts
export async function reviewFix(
  worktreePath: string,
  milestoneTitle: string,
  model: string,
): Promise<{ passed: boolean; iterations: number; costUsd: number }>
```

### What It Does

1. **Run lint/build/test** in the worktree using shell commands appropriate to the project's toolchain (detected from `package.json`, `Makefile`, etc.).
2. If verification fails, **call Claude** with the error output and the milestone description to produce a fix.
3. Apply the fix (Claude uses file-write tools) and repeat — up to a configurable max iterations.
4. Return whether the milestone passed and how many iterations were needed.

This inner loop is separate from the outer `reviewChanges()` call that inspects the full diff. It focuses on keeping each milestone in a compilable, testable state so the next milestone builds on a solid foundation.

---

## Worker Tools — `worker-tools.ts`

Worker tools are the Anthropic tool definitions that Claude uses inside the agentic coding loop. They give Claude the ability to read and write files, run shell commands, and inspect the filesystem.

### `WORKER_TOOLS`

```ts
export const WORKER_TOOLS: Tool[]
```

An array of tool definitions passed to `callClaudeWithTools`. Each tool has a name, description, and JSON schema for its inputs.

| Tool | Description |
|---|---|
| `read_file` | Read the full contents of a file |
| `write_file` | Write (overwrite) a file with new contents |
| `list_directory` | List files and subdirectories |
| `run_command` | Execute a shell command in the worktree (build, test, lint, git) |
| `search_files` | Search for a pattern across all files in the worktree |

### `createWorktreeToolExecutor(worktreePath)`

```ts
export function createWorktreeToolExecutor(
  worktreePath: string,
): (name: string, input: Record<string, unknown>) => Promise<string | ToolResultContent>
```

Returns a `executeTool` function pre-bound to `worktreePath`. All file paths passed by Claude are resolved relative to this directory, preventing path traversal outside the isolated worktree.

#### Path Safety

```ts
const resolvedPath = resolve(worktreePath, input.path as string);
if (!resolvedPath.startsWith(worktreePath)) {
  return "Error: path traversal outside worktree is not allowed";
}
```

#### `run_command` Constraints

Shell commands are executed with `execFile` (not `exec`), which prevents shell injection. Commands run with `cwd` set to the worktree path. There is a configurable timeout; long-running commands (e.g., slow test suites) are terminated after the limit.

---

## Browser Tools — `browser-tools.ts`

Browser tools are a separate set of Anthropic tool definitions that enable Claude to control a headless Playwright browser during UI validation.

### Tool Definitions

```ts
export const BROWSER_TOOLS: Tool[]
```

| Tool | Description |
|---|---|
| `navigate` | Navigate to a URL |
| `screenshot` | Capture a full-page or element screenshot (returns base64 PNG) |
| `click` | Click an element by CSS selector |
| `type_text` | Type text into a focused input field |
| `wait_for` | Wait for an element to appear or a condition to be true |
| `evaluate` | Execute JavaScript in the page context |
| `scroll` | Scroll the page or a specific element |
| `get_text` | Extract the text content of an element |

### Screenshot Return Format

Screenshots are returned as `ToolResultContent` arrays containing an `image` block:

```ts
{
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "<base64-encoded PNG>",
  }
}
```

This allows Claude to visually inspect the rendered UI and make assertions about layout, content, and correctness without parsing HTML.

### Browser Lifecycle

The browser and page objects are created by the calling agent (`browser-validator.ts`) and passed to the tool executor. `browser-tools.ts` itself is stateless — it only defines the tool schemas and an executor factory.

---

## Preview System — `preview/`

The preview subsystem manages ephemeral Docker-based environments that let developers (and the browser validator) interact with the application as built from the task's branch.

### Manager — `preview/manager.ts`

`previewManager` is a **singleton** exported as:

```ts
export const previewManager: PreviewManager;
```

#### In-Memory State

```ts
// Map<taskId, PreviewInfo>
private previews: Map<string, PreviewInfo>
```

All running previews are tracked in memory. The manager is the authoritative source for which previews are currently active; the database (`tasks.previewStatus`) is kept in sync but is secondary.

#### `startPreview(taskId, worktreePath, config)`

```ts
async startPreview(
  taskId: string,
  worktreePath: string,
  config: PreviewConfig,
): Promise<PreviewInfo>
```

**Steps:**

1. Allocates an available port from the pool (`4001`–`4099`).
2. Selects the appropriate start strategy based on `config.type`:
   - `"compose"` — runs `docker compose up -d --build` using the specified compose file and service.
   - `"testcontainers"` — runs the project's `start_command` inside Docker.
   - `"process"` — spawns the `start_command` as a local child process in the worktree.
3. Calls `startContainer()` / `startProcess()` via the remote Docker client or `child_process.spawn`.
4. Polls the health-check URL (from `config.health_check`) using the **validator** until healthy or until `startup_timeout` (default: 60 s) expires.
5. Updates `tasks.previewStatus = 'running'` and `tasks.previewStartedAt` in the DB.
6. Stores the `PreviewInfo` in the in-memory map.

#### `stopPreview(taskId)`

```ts
async stopPreview(taskId: string): Promise<void>
```

1. Looks up the `PreviewInfo` from the in-memory map.
2. Calls the appropriate stop method (docker stop, process kill, compose down).
3. Updates `tasks.previewStatus = 'stopped'` in the DB.
4. Removes the entry from the in-memory map.

#### `cleanupExpired(getTimeoutMs?)`

```ts
async cleanupExpired(
  getTimeoutMs?: (taskId: string) => Promise<number | undefined>,
): Promise<string[]>
```

Iterates over all running previews and stops any that have exceeded their timeout. Returns the list of task IDs that were stopped. Per-repo timeout overrides are resolved via the optional `getTimeoutMs` callback, allowing repos to configure their own `cleanup_timeout_minutes`.

#### `getRunningPreviews()`

```ts
getRunningPreviews(): Map<string, PreviewInfo>
```

Returns a snapshot of the current in-memory previews map. Used by daemon cleanup routines.

#### `getPreviewInfo(taskId)`

```ts
getPreviewInfo(taskId: string): PreviewInfo | undefined
```

Used by the worker `finally` block to decide whether to defer worktree cleanup.

### Proxy — `preview/proxy.ts`

An Express router that proxies browser requests from the dashboard to running preview environments.

**Route pattern:** `GET /preview/:taskId/*`

```ts
export const previewRouter: Router;
```

For each request:
1. Requires the user to be authenticated (`requireAuth`).
2. Looks up the preview's host and port from `previewManager`.
3. If not found or not running, returns `404`.
4. Uses `http-proxy-middleware` to forward the request to `http://{host}:{port}`.

This allows the dashboard to display preview environments in an `<iframe>` without exposing the Docker container's port directly to the internet.

### Remote Docker — `preview/remote-docker.ts`

Manages TLS-authenticated connections to a remote Docker daemon used for spinning up preview containers.

```ts
export function getDockerClient(): RemoteDockerClient
```

The client reads the following environment variables for TLS configuration:
- `DOCKER_HOST` — e.g. `tcp://10.0.0.5:2376`
- `DOCKER_TLS_CERT`, `DOCKER_TLS_KEY`, `DOCKER_TLS_CA` — PEM-encoded certificate material

Operations exposed:
- `runContainer(image, options)` — `docker run` equivalent
- `stopContainer(containerId)` — `docker stop`
- `removeContainer(containerId)` — `docker rm`
- `composePull(worktreePath, composeFile)` — `docker compose pull`
- `composeUp(worktreePath, composeFile, service)` — `docker compose up -d --build`
- `composeDown(worktreePath, composeFile)` — `docker compose down`

All operations are executed via `execFile` with the appropriate `DOCKER_HOST` and TLS environment variables set.

### Validator — `preview/validator.ts`

Polls a preview environment's health-check endpoint until it becomes ready or a timeout expires.

```ts
export async function waitForHealthy(
  url: string,
  timeoutMs: number,
  intervalMs?: number,
): Promise<void>
```

- Sends `GET {url}` every `intervalMs` (default: 2 000 ms).
- Resolves when the response status is `2xx`.
- Throws with a `"Preview health check timed out"` message if `timeoutMs` elapses.

Also exports a logging helper:

```ts
export async function addPreviewLog(
  taskId: string,
  phase: string,
  message: string,
): Promise<void>
```

Writes a row to the `preview_logs` table for audit and dashboard display.

### Types — `preview/types.ts`

Key types used across the preview subsystem:

```ts
interface PreviewInfo {
  taskId: string;
  host: string;
  port: number;
  worktreePath: string;
  startedAt: Date;
  process?: ChildProcess;  // for "process" type previews
  containerId?: string;    // for Docker-based previews
}
```

`PreviewConfig` and `PreviewStatus` are re-exported from `../../hive-yaml.js` and `../../domain/types.js` respectively:

```ts
// From hive-yaml.ts:
type PreviewConfig =
  | ComposePreviewConfig
  | TestcontainersPreviewConfig
  | ProcessPreviewConfig;

// From domain/types.ts:
type PreviewStatus = "running" | "stopped" | "failed";
```

---

## Execution Flow Walkthrough

A complete execution cycle from daemon trigger to merged PR:

```
Daemon picks APPROVED task
  └─ calls executeTask(taskId)
       │
       ├─ 1. Load task + repo from DB
       ├─ 2. checkBudget(userId)             ← throws if exhausted
       ├─ 3. register(taskId, "worker", ...)
       ├─ 4. updateStatus → "executing"
       │
       ├─ 5. Worktree setup
       │      ├─ Try to reuse task.worktreePath (rework cycle)
       │      └─ Otherwise: createWorktree → clone + branch
       │
       ├─ 6. retrieveRelevantLearnings(...)   ← non-blocking, graceful fail
       │
       ├─ 7. Build user prompt
       │      └─ Progressive enrichment trimming if needed
       │
       ├─ 8a. [Epic milestones] executeMilestones(...)
       │       └─ For each milestone:
       │            ├─ callClaudeWithTools(milestonePrompt, WORKER_TOOLS)
       │            ├─ reviewFix(worktreePath, ms.title, model)
       │            ├─ commitMilestone(...)
       │            └─ Update tasks.completedMilestones
       │
       ├─ 8b. [Single pass] callClaudeWithTools(userPrompt, WORKER_TOOLS)
       │
       ├─ 9. recordCost + increment executionAttempts
       │
       ├─ 10. Empty-diff detection
       │       ├─ Empty + first attempt → rework with write_file reminder
       │       └─ Empty + already reworked → fail
       │
       ├─ 11. updateStatus → "reviewing"
       │
       ├─ 12. reviewChanges(taskId, worktree, learningIds)
       │
       ├─ 13. On verdict "pass":
       │       ├─ commitAll (single-pass only) + push
       │       ├─ [Optional] previewManager.startPreview(...)
       │       ├─ [Optional] validateWithBrowser(...)
       │       ├─ gitProvider.createPR(...)
       │       ├─ gitProvider.commentOnPR(reviewSummary)
       │       ├─ [Optional] gitProvider.commentOnPR(previewUrl)
       │       └─ updateStatus → "done"
       │
       ├─ 14. On verdict "rework" (within cycle limit):
       │       ├─ refineTask(taskId, reviewResult)
       │       └─ updateStatus → "rework"
       │
       └─ 15. On max cycles exceeded:
               ├─ set failureReason
               └─ updateStatus → "failed"
       │
       └─ FINALLY:
               ├─ Conditional worktree cleanup
               └─ unregister(taskId)
```

---

## Epic vs. Flow Execution

| Dimension | Flow | Epic |
|---|---|---|
| Entry point | `executeTask()` | `executeEpic()` → child `executeTask()` per milestone |
| Code generation | Single Claude multi-turn call (or milestone loop) | Each child task is a full flow pipeline run |
| Review | One `reviewChanges()` at the end | `reviewFix()` per milestone + one final `reviewChanges()` |
| Commits | One commit (or per-milestone) | One commit per milestone, linked to parent epic |
| PR | One PR per task | One PR per child task |
| Resumability | `completedMilestones` counter preserved across reworks | Each child task is independent and resumable individually |

### Milestone Execution Detail

When the enrichment data contains an `architect.milestones` array (set by the `architect` enricher), `executeTask` invokes `executeMilestones()` instead of a single Claude pass:

```ts
async function executeMilestones(
  task, worktreePath, blueprint, model, learningsStr, startFrom
): Promise<{ totalCostUsd: number }>
```

Each milestone receives a **focused prompt** that includes:
- The overall task description and approach.
- Only the current milestone's description, files to modify, and acceptance criteria.
- A summary of previously completed milestones (so Claude has continuity context).
- Relevant learnings.

The `startFrom` parameter allows resuming from a partially completed set of milestones when a worktree is reused across rework cycles.

---

## Rework and Retry Mechanics

Rework is distinct from retry:

| Term | Meaning |
|---|---|
| **Rework** | The review gate returned `rework`; the task needs to be re-executed with gate feedback |
| **Retry** | The daemon picks up a `rework`-status task and calls `executeTask` again |

### Rework Cycle Flow

```
executing → reviewing → rework         (review gate: rework verdict)
                           │
             (daemon picks up rework task)
                           │
             executeTask(taskId)
               └─ reusedWorktree = true (path still valid)
               └─ prompt includes task.retryInstructions
               └─ reworkCount incremented in task row
               └─ back to reviewing → pass/rework/fail
```

### `MAX_REWORK_CYCLES = 2`

The constant is defined in `worker.ts`. Tasks never exceed 2 rework cycles; the third failure transitions to `failed`. This prevents infinite loops while allowing the system to self-correct common issues.

### `retryInstructions`

Set by `refineTask()` (in `src/agents/refiner.ts`) after a rework verdict. Content is the gate's reasoning explaining what needs to change. Injected into the user prompt as `## Retry Instructions` on the next execution attempt.

---

## Preview Environments

Preview environments allow developers to interact with the implemented changes before merging. The system supports three preview strategies:

### Strategy 1: `compose`

```yaml
# .hive.yaml
preview:
  type: compose
  compose_file: docker-compose.yml
  app_service: app
  port: 3000
  health_check: /health
```

Uses `docker compose up -d --build` on a remote Docker daemon. The `app_service` is the Docker Compose service name that exposes `port`.

### Strategy 2: `testcontainers`

```yaml
preview:
  type: testcontainers
  start_command: npm run start:test
  port: 8080
  startup_timeout: 120
```

Runs an arbitrary command that starts a containerised environment (often using Testcontainers Java/Node library). The process is managed by the preview manager.

### Strategy 3: `process`

```yaml
preview:
  type: process
  start_command: npm start
  port: 3000
```

Spawns the `start_command` as a local child process directly in the worktree directory. Simpler than Docker but no isolation.

### Configuration Precedence

```
1. .hive.yaml in repo root (highest priority)
2. repo.settings.preview (set via dashboard)
3. autonomous.config.yaml preview defaults
```

### Port Allocation

Ports are allocated from a fixed pool (`4001`–`4099`). The manager tracks which ports are in use and picks the first available one. With a maximum of 99 simultaneous previews, this bounds resource usage.

### TTL and Cleanup

The default TTL is `30 minutes` (from `autonomous.config.yaml: preview.cleanup_timeout_minutes`). Individual repos can override this via `repo.settings.preview.cleanup_timeout_minutes`. Cleanup is handled by the daemon's `cleanupExpiredPreviews()` scheduler (see [daemon.md](./daemon.md)).

---

## Cross-Cutting Concerns

### Structured Logging

All execution logging uses the shared pino logger with consistent fields:

```ts
logger.info({ taskId, prUrl, previewUrl }, "Task execution complete — PR created");
logger.warn({ taskId, path: task.worktreePath }, "Saved worktree missing — creating new");
logger.error({ taskId, err }, "Worker: unexpected error");
```

Key fields: `taskId`, `path` (worktree path), `prUrl`, `previewUrl`, `milestone`, `total`, `model`, `costUsd`, `err`.

### Task Events

The worker emits granular `task_events` records throughout execution for dashboard display and debugging:

| Event type | When emitted |
|---|---|
| `worktree_created` | After successful `createWorktree` |
| `worktree_reused` | When existing worktree is re-used for rework |
| `claude_call_started` | Before calling `callClaudeWithTools` |
| `claude_call_complete` | After the agentic loop returns (includes token counts, cost) |
| `milestone_started` | Beginning of each architect milestone |
| `milestone_complete` | After milestone commit |
| `milestone_resumed` | When resuming from `startFrom > 0` |
| `review_fix_started` | Before per-milestone `reviewFix` loop |
| `review_fix_complete` | After `reviewFix` returns |
| `review_started` | Before `reviewChanges` |
| `review_complete` | After review gate verdict |
| `pr_created` | After PR URL is returned |
| `empty_changeset` | When git diff is empty |
| `budget_exhausted` | When user's daily limit is reached |
| `error` | On any unhandled exception |

### Heartbeating

Long-running operations (milestone loops, multi-turn Claude calls) call `heartbeat(taskId)` from `src/db/queries/active-agents.ts` between turns. This updates `active_agents.lastHeartbeatAt`, which the stale-task daemon monitor uses to distinguish genuinely stuck agents from legitimately long ones.

```ts
// In callClaudeWithTools:
onTurnComplete: () => heartbeat(taskId),
```

### Cost Attribution

All LLM costs are attributed at the per-agent level:

```ts
await recordCost(taskId, task.createdBy, "worker", model, implCostUsd, 1, implDurationMs);
```

For milestone-based tasks, costs from each milestone's Claude call accumulate in `totalCostUsd` and are recorded as a single `worker` cost entry at the end of all milestones.

### Security: Path Traversal Prevention

The `createWorktreeToolExecutor` validates every file path Claude provides:

```ts
const resolvedPath = resolve(worktreePath, relativePath);
if (!resolvedPath.startsWith(worktreePath)) {
  return "Error: path traversal outside worktree is not allowed";
}
```

This prevents a prompt-injected path like `../../etc/passwd` from escaping the worktree sandbox.

---

## See Also

- [`docs/internal/architecture.md`](../architecture.md) — full pipeline data flow and state machine
- [`docs/internal/modules/daemon.md`](./daemon.md) — how the daemon schedules and dispatches execution
- [`docs/internal/modules/agents.md`](./agents.md) — SDK, review gate, and agent lifecycle patterns
- [`docs/internal/modules/enrichers.md`](./enrichers.md) — how the architect enricher produces the blueprint consumed here
- `src/hive-yaml.ts` — `.hive.yaml` schema and `parseHiveYaml()` parser
- `autonomous.config.yaml` — preview defaults, budget limits, model assignments
