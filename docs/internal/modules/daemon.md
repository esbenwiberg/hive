# Daemon Module

> **Location:** `src/daemon/`
> **Purpose:** The heartbeat of The Hive — a class-based background process that polls for work, dispatches tasks into the pipeline, and performs housekeeping (stale-task recovery, preview cleanup, PR-close cleanup, producer runs, and knowledge-base maintenance).

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [Scheduler — `scheduler.ts`](#scheduler--schedulerts)
3. [Daemon Class — `daemon.ts`](#daemon-class--daemonts)
   - [Constructor and Configuration](#constructor-and-configuration)
   - [Startup Sequence — `start()`](#startup-sequence--start)
   - [Graceful Shutdown — `stop()`](#graceful-shutdown--stop)
   - [Task Runner Tick — `_tick()`](#task-runner-tick--_tick)
   - [Task Dispatch — `_dispatch()`](#task-dispatch--_dispatch)
   - [Producer Runner — `_runProducer()`](#producer-runner--_runproducer)
   - [Retrospective Tick](#retrospective-tick)
   - [Learning Decay Tick](#learning-decay-tick)
4. [Stale Task Handler — `stale-tasks.ts`](#stale-task-handler--stale-tasksts)
5. [PR-Close Cleanup — `pr-close-cleanup.ts`](#pr-close-cleanup--pr-close-cleanupts)
6. [Preview Cleanup — `preview-cleanup.ts`](#preview-cleanup--preview-cleanupts)
7. [Scheduler Configuration Reference](#scheduler-configuration-reference)
8. [Task Lifecycle and Daemon Interaction](#task-lifecycle-and-daemon-interaction)
9. [Concurrency Model](#concurrency-model)
10. [Startup Sequence (End-to-End)](#startup-sequence-end-to-end)
11. [Monitoring and Observability](#monitoring-and-observability)

---

## Module Overview

The daemon runs entirely within the same Node.js process as the Express dashboard — there is no separate daemon binary. The application entry point instantiates a `Daemon` class and calls `daemon.start()` after the HTTP server is listening. All scheduling is handled by independent `Scheduler` instances (one per concern), each running a callback on a fixed interval with mutual exclusion.

### File Map

| File | Responsibility |
|---|---|
| `scheduler.ts` | Mutual-exclusion interval scheduler primitive |
| `daemon.ts` | `Daemon` class: wires up all schedulers, manages in-flight state |
| `stale-tasks.ts` | Query helper: find tasks stuck in transitional states |
| `pr-close-cleanup.ts` | Stop previews and worktrees when a PR is closed or merged |
| `preview-cleanup.ts` | Expire preview environments that have exceeded their TTL |

### Scheduler Summary

| Scheduler | Default interval | What it runs |
|---|---|---|
| Task runner | 5 s | Pick `pending`, `approved`, `rework` tasks → dispatch pipeline |
| Per-producer schedulers | 15 min (staggered) | One scheduler per producer, staggered evenly |
| Preview cleanup | 60 s | `cleanupExpiredPreviews()` |
| PR-close cleanup | 60 s | `cleanupClosedPRPreviews()` |
| Retrospective | 24 h interval; 7-day gap gate | `runRetrospective()` |
| Decay | 24 h interval; 30-day gap gate | `applyMonthlyDecay()` + `curateLearnings()` |

---

## Scheduler — `scheduler.ts`

The `Scheduler` class is a small but important primitive: it runs a callback on a fixed interval with **mutual exclusion** — if the previous tick is still running when the next interval fires, the new tick is silently skipped.

### Class API

```ts
class Scheduler {
  constructor(
    tickMs: number,
    tickFn: () => Promise<void>,
    opts?: { label?: string; initialDelayMs?: number },
  );

  start(): void;          // begins the interval
  stop(): Promise<void>;  // clears interval; waits for in-progress tick to finish
}
```

### Mutual-Exclusion Pattern

```ts
private async _tick(): Promise<void> {
  if (this.running) {
    logger.debug({ label: this.label }, "Scheduler: tick skipped (previous still running)");
    return;
  }
  this.running = true;
  try {
    await this.tickFn();
  } catch (err) {
    logger.error({ label: this.label, err }, "Scheduler: tick error");
  } finally {
    this.running = false;
  }
}
```

This prevents overlapping ticks from piling up when a tick function is slow (e.g., a long producer run or a slow database query). The error from one tick is logged and swallowed, and the next tick runs normally.

### `initialDelayMs` Option

Producers use the `initialDelayMs` option to stagger their start times:

```ts
const staggerMs = Math.floor(producerIntervalMs / ALL_PRODUCERS.length);
ALL_PRODUCERS.forEach((producer, i) => {
  new Scheduler(producerIntervalMs, () => _runProducer(producer), {
    label: `producer:${producer.name}`,
    initialDelayMs: i * staggerMs,
  });
});
```

This prevents all producers from firing simultaneously on startup and hitting the AI API concurrently.

### `stop()` is Async

Unlike `start()`, `stop()` returns a `Promise` that resolves only after any in-progress tick has completed. The `Daemon.stop()` method awaits all scheduler stops before proceeding to task suspension.

### Default Interval

```ts
const DEFAULT_TICK_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
```

This default is only used when a `Scheduler` is instantiated without providing `tickMs`. In practice, the `Daemon` always supplies explicit intervals.

---

## Daemon Class — `daemon.ts`

### Constructor and Configuration

```ts
export class Daemon {
  constructor(opts?: DaemonOptions);
}

interface DaemonOptions {
  pollIntervalMs?: number;       // task-runner interval  (default: 5 000 ms)
  maxConcurrent?: number;        // system-wide concurrency cap (default: 5)
  maxPerUser?: number;           // per-user concurrency cap  (default: 2)
  producerIntervalMs?: number;   // per-producer interval     (default: 15 min, env-overridable)
}
```

The `producerIntervalMs` can also be set via the `HIVE_PRODUCER_INTERVAL_MS` environment variable — useful for development (e.g., setting a 60-second interval to accelerate testing).

#### In-Memory State

```ts
private readonly activeTaskIds  = new Set<string>();        // currently dispatched task IDs
private readonly userCounts     = new Map<number, number>(); // userId → active count
private readonly budgetNotified = new Set<string>();         // taskIds already notified of budget exhaustion
private stopping = false;
```

These structures live for the lifetime of the `Daemon` instance. They are authoritative for concurrency decisions — not the database. This avoids extra DB round-trips on every tick and relies on the `finally` block in `_dispatch` to keep counts accurate.

---

### Startup Sequence — `start()`

```ts
async start(): Promise<void>
```

Called once by the application entry point after the HTTP server is listening.

```
start()
  │
  ├─ 1. cleanupStale(STALE_THRESHOLD_MS)
  │      └─ DELETE FROM active_agents WHERE lastHeartbeatAt < (now - 30 min)
  │
  ├─ 2. findStaleTasks(STALE_THRESHOLD_MS)
  │      └─ SELECT tasks stuck in transitional states > 30 min
  │      └─ For each: updateStatus(taskId, "failed")
  │
  ├─ 3. findSuspended()
  │      └─ SELECT tasks with status = "suspended"
  │      └─ For each:
  │           ├─ executing | reviewing → "approved"
  │           └─ others → "pending"
  │      └─ addEvent("resumed", ...)
  │
  ├─ 4. scheduler.start()                    [5 s: task runner]
  │
  ├─ 5. Per-producer schedulers (staggered)  [15 min: one per producer]
  │
  ├─ 6. retrospectiveScheduler.start()       [24 h: retrospective]
  │
  ├─ 7. decayScheduler.start()               [24 h: decay + archival + curation]
  │
  ├─ 8. previewCleanupScheduler.start()      [60 s: expired preview TTL]
  │
  └─ 9. prCloseCleanupScheduler.start()      [60 s: closed PR preview cleanup]
```

The startup sequence performs synchronous DB recovery (steps 1–3) **before** any schedulers start. This prevents a recovered task from being dispatched while stale cleanup is still in progress.

#### Suspended Task Recovery

The `suspended` status is a graceful-shutdown mechanism: when `stop()` is called, in-flight tasks are transitioned to `suspended` so they survive a rolling deploy. On next startup, they are transitioned back to `pending` or `approved` and re-queued normally.

```ts
const resumeTo =
  task.suspendedFrom === "executing" || task.suspendedFrom === "reviewing"
    ? "approved"   // skip re-enrichment; go straight to execution
    : "pending";   // re-run the full pipeline from scratch
```

---

### Graceful Shutdown — `stop()`

```ts
async stop(): Promise<void>
```

Called by the process signal handler (`SIGTERM`, `SIGINT`).

```
stop()
  │
  ├─ 1. stopping = true            ← _tick() no-ops on next poll
  │
  ├─ 2. Await all producerSchedulers.stop()
  ├─ 3. Await retrospectiveScheduler.stop()
  ├─ 4. Await decayScheduler.stop()
  ├─ 5. Await previewCleanupScheduler.stop()
  ├─ 6. Await prCloseCleanupScheduler.stop()
  ├─ 7. Await scheduler.stop()     ← task runner last
  │
  └─ 8. Suspend in-flight tasks
          └─ For each taskId in activeTaskIds:
               └─ suspendTask(taskId)   (sets status = "suspended")
               └─ addEvent("suspended", ...)
          └─ Wait 10 s (SUSPEND_DRAIN_MS) for _dispatch finally blocks to finish
```

The 10-second drain period allows the `_dispatch` `finally` blocks (which clean up `activeTaskIds` and `userCounts`) to complete before the process exits.

---

### Task Runner Tick — `_tick()`

```ts
private async _tick(): Promise<void>
```

Runs every 5 seconds. Finds the next batch of dispatchable tasks and dispatches them concurrently (fire-and-forget).

#### Candidate Query

```ts
const [pendingResult, approvedResult, reworkResult] = await Promise.all([
  list({ status: "pending"  }, 10),
  list({ status: "approved" }, 10),
  list({ status: "rework"   }, 10),
]);
const candidates = [...pending, ...approved, ...rework]
  .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
```

All three status buckets are queried in parallel (max 10 each) and merged into a single list sorted oldest-first. This ensures old tasks aren't starved by newer ones.

#### Guard Sequence (per candidate)

For each candidate task, in order:

| Guard | Action on fail |
|---|---|
| `this.stopping` | Return (drain) |
| `activeTaskIds.size >= maxConcurrent` | Return (system full) |
| `activeTaskIds.has(task.id)` | Skip (already dispatched) |
| `userCounts.get(createdBy) >= maxPerUser` | Skip (user full) |
| `checkBudget(createdBy) <= 0` | Skip + notify once |

Budget checks are **cached per-user within a single tick** to avoid repeated vault/DB lookups:

```ts
const budgetCache = new Map<number, number>();
let remaining = budgetCache.get(task.createdBy) ?? await checkBudget(task.createdBy);
budgetCache.set(task.createdBy, remaining);
```

#### Budget Notification

When a task is skipped due to exhausted budget, a `budget_exhausted` event is added to the task's timeline — but only **once per task** (tracked via `budgetNotified`). This prevents event spam when the budget stays exhausted across many ticks. The flag is cleared when budget recovers.

#### Dispatch

Tasks that pass all guards are dispatched immediately:

```ts
this.activeTaskIds.add(task.id);
this.userCounts.set(task.createdBy, userCount + 1);
void this._dispatch(task).catch(err => { ... });
```

The `void` is intentional — dispatch is fire-and-forget. The tick doesn't await dispatch completions; it moves on to process remaining candidates. The `finally` block in `_dispatch` cleans up the tracking structures when the pipeline finishes.

---

### Task Dispatch — `_dispatch()`

```ts
private async _dispatch(
  task: { id: string; status: string; createdBy: number }
): Promise<void>
```

Routes the task to the appropriate pipeline based on its current status:

| Status | Handler |
|---|---|
| `"pending"` | `runPipeline(task.id)` — full pipeline (enrich → approve → execute) |
| `"approved"` | `executeTask(task.id)` — skip enrichment, go straight to execution |
| `"rework"` | `executeTask(task.id)` — re-execute with rework instructions |
| anything else | Log warning and skip |

#### Error Safety Net

```ts
} catch (err) {
  await addEvent(task.id, "error", "daemon", `Dispatch failed: ${reason}`);
  await updateStatus(task.id, "failed");
}
```

If the pipeline throws an unhandled error, the task is transitioned to `failed` so it doesn't sit in a dispatchable state and get retried indefinitely.

#### Cleanup (always)

```ts
} finally {
  this.activeTaskIds.delete(task.id);
  const current = this.userCounts.get(task.createdBy) ?? 0;
  this.userCounts.set(task.createdBy, Math.max(0, current - 1));
}
```

The `finally` block always runs, even if the dispatch errors or is suspended. This keeps the in-memory concurrency counters accurate.

---

### Producer Runner — `_runProducer()`

```ts
private async _runProducer(producer: Producer): Promise<void>
```

Runs a single producer against all repos it is enabled for.

#### Producer Enablement

```ts
// Global producers (e.g., self-monitor) run against HIVE_SELF_REPO only
if (producer.global) { ... }

// doc-auditor is gated on repo.settings.docs.enabled
if (producer.name === "doc-auditor") {
  const docs = repoSettings.docs as { enabled?: boolean } | undefined;
  if (!docs?.enabled) continue;
}

// All other producers require explicit opt-in in repo.settings.producers
const entry = producersMap[producer.name];
if (!entry || entry.enabled !== true) continue;
```

Producers are **disabled by default** for all repos. A repo owner must explicitly enable each producer in their repo settings via the dashboard.

#### Repo Cloning (when `producer.needsRepo`)

Some producers (e.g., `log-scanner`, `doc-auditor`) need access to the repo's file system:

```ts
if (producer.needsRepo) {
  cloneDir = `/tmp/hive-producer-clones/${repo.id}-${producer.name}-${Date.now()}`;
  await gitProvider.clone(repo.fullName, cloneDir, defaultBranch, creds, { depth: 1 });
  repoDir = cloneDir;
}
```

A **shallow clone** (`--depth 1`) is used for producer runs to minimise clone time. The clone is always deleted in the `finally` block.

#### Run Recording

Every producer run (success or failure) is recorded in the `producer_runs` table:

```ts
await recordRun({
  producer: producer.name,
  repo: repo.fullName,
  tasksCreated: result.tasksCreated,
  duplicatesSkipped: result.duplicatesSkipped,
  errors: result.errors,
  costUsd: result.costUsd,
  durationMs,
});
```

This feeds the "Producer Activity" dashboard panel.

---

### Retrospective Tick

```ts
private async _retrospectiveTick(): Promise<void>
```

**Scheduler interval:** 24 h  
**Gap gate:** 7 days (`RETROSPECTIVE_MIN_GAP_MS`)

On each 24-hour tick, the method checks `global_config.lastRetrospectiveRun`. If fewer than 7 days have elapsed, the tick is silently skipped. This means the retrospective runs approximately weekly, regardless of how long the daemon has been running.

When it does run:

```ts
const report = await runRetrospective();
// report: { metrics: { totalTasks, firstPassRate, ... }, proposals, blindSpots }
```

See [`docs/internal/modules/agents.md`](./agents.md) for the retrospective agent.

---

### Learning Decay Tick

```ts
private async _decayTick(): Promise<void>
```

**Scheduler interval:** 24 h  
**Gap gate:** 30 days (`DECAY_MIN_GAP_MS`)

Even when the gap gate prevents a full decay run, the tick still runs **archival and curation** on every 24-hour tick:

```ts
// Always:
const archived = await archiveStale();   // move low-confidence learnings to archive
await curateLearnings();                  // keeper agent: merge + prune

// Only when 30-day gap has elapsed:
const decayed = await applyMonthlyDecay();  // reduce confidence scores
await setConfig("lastDecayRun", new Date().toISOString());
```

This keeps the learnings table lean even during periods between full decay cycles.

---

## Stale Task Handler — `stale-tasks.ts`

The stale-task handler prevents tasks from permanently sticking in transitional states (e.g., if the process crashes mid-execution, leaving a task `executing` with no live agent).

### Threshold

```ts
export const STALE_THRESHOLD_MS = 1_800_000; // 30 minutes
```

### `findStaleTasks(thresholdMs)`

```ts
export async function findStaleTasks(thresholdMs: number): Promise<Task[]>
```

Returns all tasks in a transitional state (`executing`, `reviewing`, `enriching`, `rework`) whose `updatedAt` is older than `thresholdMs`.

This query is used twice:
1. **At startup** in `Daemon.start()` — transitions found tasks to `failed`.
2. **Potentially by monitoring tools** — it can be called independently to inspect stale tasks.

### `STALE_THRESHOLD_MS` vs. Heartbeat

The stale query uses `tasks.updatedAt` rather than `active_agents.lastHeartbeatAt` to avoid a join and to catch the case where the `active_agents` row was never created (crash before `register()` was called). Both columns participate in health monitoring:

| Signal | Used for |
|---|---|
| `tasks.updatedAt` | Stale detection on startup (30-minute window) |
| `active_agents.lastHeartbeatAt` | Live dashboard monitoring; `cleanupStale()` on startup |

### On-Startup-Only Recovery

`findStaleTasks` is called once at startup, not on each scheduler tick. This is intentional: a task that becomes stale mid-operation will be recovered on the next container restart. Running recovery on every tick would add DB load without meaningful benefit and could create race conditions with the pipeline's own error handling.

---

## PR-Close Cleanup — `pr-close-cleanup.ts`

When a pull request is closed (merged or abandoned), The Hive stops any running preview environment and cleans up the git worktree.

### Entry Point

```ts
export async function cleanupClosedPRPreviews(): Promise<void>
```

Called by the `prCloseCleanupScheduler` every 60 seconds.

### Detection Logic

```ts
// Tasks with a prUrl and a currently running preview
const tasksWithPreviews = await db
  .select()
  .from(tasks)
  .where(and(
    isNotNull(tasks.prUrl),
    eq(tasks.previewStatus, "running"),
  ));
```

For each such task:

1. Resolve the user's git credentials via `resolveGitCredentials(task.createdBy, repo.provider)`.
2. Call `gitProvider.getPRState(repo.fullName, task.prUrl, creds)`.
3. If state is `"closed"` or `"merged"`:
   - `previewManager.stopPreview(taskId)` — terminate the container/process.
   - `cleanupWorktree({ path: task.worktreePath, ... })` — delete the disk directory.
   - Update `tasks.previewStatus = 'stopped'`, clear `tasks.worktreePath` and `tasks.worktreeBaseSha`.
4. Per-task errors are caught and logged without aborting cleanup of other tasks.

### Why Poll Instead of Webhooks?

The Hive does not consume GitHub/ADO webhooks. Polling every 60 seconds provides acceptable latency (max 60-second delay between PR close and cleanup) without the infrastructure complexity of webhook ingestion, signature validation, and retry handling. For the typical use case (30-minute preview TTL), previews are cleaned up well within the TTL window after a PR is merged.

### Fresh Credential Resolution

Credentials are fetched from Azure Key Vault on every cleanup call rather than cached. This guards against token rotation between the task creation and PR-close event. The added latency (one Key Vault call per running preview per 60-second tick) is acceptable.

---

## Preview Cleanup — `preview-cleanup.ts`

Separate from PR-close cleanup, the preview cleanup handles TTL-based expiry regardless of PR state.

### Entry Point

```ts
export async function cleanupExpiredPreviews(): Promise<void>
```

Called by the `previewCleanupScheduler` every 60 seconds.

### TTL Resolution

The cleanup routine supports per-repo timeout overrides:

```ts
const getTimeoutMs = async (taskId: string): Promise<number | undefined> => {
  // Returns repo.settings.preview.cleanup_timeout_minutes * 60_000
  // or undefined (falls back to default: 30 min)
};

const expiredTaskIds = await previewManager.cleanupExpired(getTimeoutMs);
```

`previewManager.cleanupExpired()` iterates its in-memory map, comparing each preview's `startedAt` against the resolved TTL. It stops and removes any preview that has exceeded its TTL and returns the list of stopped task IDs.

### Post-Stop Cleanup Steps

For each expired task ID returned by `cleanupExpired`:

1. Look up the task's `worktreePath`.
2. `cleanupWorktree({ path: worktreePath, ... })` — delete the disk directory.
3. Update `tasks.previewStatus = 'stopped'`, clear `tasks.worktreePath`, `tasks.worktreeBaseSha`.
4. Insert a `preview_logs` row recording the cleanup event.

### Idempotency with PR-Close Cleanup

Both cleanup routines may attempt to stop the same preview in the same 60-second window. `previewManager.stopPreview()` is idempotent: if a preview is not found in the in-memory map, it returns cleanly without error.

---

## Scheduler Configuration Reference

### Intervals

| Scheduler | Default interval | Environment override |
|---|---|---|
| Task runner | 5 000 ms | `DaemonOptions.pollIntervalMs` (constructor) |
| Per-producer | 900 000 ms (15 min) | `HIVE_PRODUCER_INTERVAL_MS` env var |
| Preview cleanup | 60 000 ms (60 s) | Hardcoded (`PREVIEW_CLEANUP_INTERVAL_MS`) |
| PR-close cleanup | 60 000 ms (60 s) | Hardcoded (`PR_CLOSE_CLEANUP_INTERVAL_MS`) |
| Retrospective | 86 400 000 ms (24 h) | Hardcoded (`MAINTENANCE_INTERVAL_MS`) |
| Decay | 86 400 000 ms (24 h) | Hardcoded (`MAINTENANCE_INTERVAL_MS`) |

### Concurrency Limits

| Limit | Value | Configured via |
|---|---|---|
| Max concurrent tasks (system) | 5 | `DaemonOptions.maxConcurrent` (default: `DEFAULT_MAX_CONCURRENT = 5`) |
| Max concurrent tasks (per user) | 2 | `DaemonOptions.maxPerUser` (default: `DEFAULT_MAX_PER_USER = 2`) |
| Stale task threshold | 30 min | `STALE_THRESHOLD_MS = 1_800_000` in `stale-tasks.ts` |
| Default preview TTL | 30 min | `autonomous.config.yaml: preview.cleanup_timeout_minutes` |
| Retrospective gap | 7 days | `RETROSPECTIVE_MIN_GAP_MS` in `daemon.ts` |
| Decay gap | 30 days | `DECAY_MIN_GAP_MS` in `daemon.ts` |

### Per-Repo Preview TTL Override

Repos can override the preview TTL via their settings (editable in the dashboard):

```json
// repo.settings (JSONB in DB)
{
  "preview": {
    "cleanup_timeout_minutes": 60
  }
}
```

### HIVE_DAEMON_USER_ID

The `_runProducer` method reads `process.env.HIVE_DAEMON_USER_ID` (default: `"1"`) to determine which user to attribute automatically-created producer tasks to. This must be set to the ID of the Hive system user in production.

---

## Task Lifecycle and Daemon Interaction

The daemon touches tasks at three distinct lifecycle phases:

### 1. Startup Recovery

```
Daemon starts
  ├─ cleanupStale() → DELETE stale active_agents rows (heartbeat-based)
  ├─ findStaleTasks() → tasks stuck in transitional state > 30 min → "failed"
  └─ findSuspended() → tasks suspended from prior deploy → back to "pending"/"approved"
```

### 2. Task Dispatch (every 5 s)

```
_tick()
  └─ Candidates: pending + approved + rework (oldest first)
  └─ Guards: system concurrency, per-user concurrency, budget
  └─ _dispatch(task)
       ├─ pending  → runPipeline()   [enrich → approve → execute]
       ├─ approved → executeTask()   [execute → review → PR]
       └─ rework   → executeTask()   [re-execute with rework instructions]
```

### 3. Maintenance (60 s and 24 h)

```
previewCleanupScheduler (60 s)
  └─ cleanupExpiredPreviews() → stop TTL-expired previews + remove worktrees

prCloseCleanupScheduler (60 s)
  └─ cleanupClosedPRPreviews() → stop previews for merged/closed PRs

retrospectiveScheduler (24 h / 7-day gate)
  └─ runRetrospective() → analyse completed tasks → synthesise learnings

decayScheduler (24 h / 30-day gate)
  └─ applyMonthlyDecay() → reduce confidence of unused learnings
  └─ archiveStale() → archive below-threshold learnings
  └─ curateLearnings() → keeper agent: merge duplicates, prune irrelevant
```

### Status Transitions Driven by Daemon

| Transition | Cause |
|---|---|
| `stuck-state → failed` | `findStaleTasks()` at startup |
| `suspended → pending / approved` | `findSuspended()` at startup |
| `queued/pending → [pipeline]` | `_tick()` → `runPipeline()` |
| `approved/rework → [execution]` | `_tick()` → `executeTask()` |
| `any → failed` | `_dispatch()` error safety net |
| `any → suspended` | `stop()` graceful shutdown |

The daemon **never** changes `previewStatus` directly — that is delegated to `previewManager` and the cleanup functions. It also never directly manages individual pipeline state transitions beyond the safety net; those are owned by the agents.

---

## Concurrency Model

### Single-Process Architecture

The Hive runs as a **single Node.js process**. All schedulers share the same event loop. Concurrency is achieved through:

1. **`Promise.allSettled`** — not used in the current tick model; dispatch is fire-and-forget via `void promise.catch()`.
2. **Non-blocking I/O** — concurrent `await`s for DB queries, HTTP calls, and `execFile` operations happen within the event loop naturally.
3. **Scheduler mutual exclusion** — the `running` flag in `Scheduler` prevents overlapping ticks of the same scheduler type.
4. **In-memory concurrency tracking** — `activeTaskIds` and `userCounts` provide fast, consistent concurrency checks without additional DB queries per candidate.

### Why Not a Queue (Redis/BullMQ)?

The design decision to use DB polling instead of a message queue reflects:

- **Simplicity:** fewer infrastructure dependencies (only PostgreSQL is required).
- **Durability:** tasks survive restarts because their state is in PostgreSQL, not an in-memory queue.
- **Observability:** task state is always visible in the database and dashboard without a separate queue inspector.
- **Volume:** The Hive is designed for team-scale workloads (tens of tasks per day), not high-throughput batch processing.

### Pipeline Isolation

Each `_dispatch(task)` call is fully independent. Shared state is limited to:

| Shared state | Access pattern |
|---|---|
| PostgreSQL database | Async queries; optimistic locking via `updatedAt` |
| `previewManager` singleton | Single-threaded in-memory map (no mutex needed) |
| `activeTaskIds` / `userCounts` | Single-threaded `Set`/`Map` (modified only in `_tick` and `_dispatch finally`) |
| `budgetNotified` | Single-threaded `Set` (modified only in `_tick`) |

---

## Startup Sequence (End-to-End)

```
Application entry point (src/index.ts)
  │
  ├─ Load environment variables
  ├─ Run DB migrations (Drizzle migrate)
  ├─ Start Express HTTP server on port 3000
  └─ new Daemon(opts).start()
       │
       ├─ 1. cleanupStale(1_800_000)          ← DELETE stale active_agents
       ├─ 2. findStaleTasks(1_800_000)         ← fail stuck tasks
       ├─ 3. findSuspended()                   ← resume suspended tasks
       ├─ 4. scheduler.start()                 ← task runner (5 s)
       ├─ 5. per-producer schedulers (staggered by producerIntervalMs/N)
       ├─ 6. retrospectiveScheduler.start()    ← 24 h / 7-day gate
       ├─ 7. decayScheduler.start()            ← 24 h / 30-day gate
       ├─ 8. previewCleanupScheduler.start()   ← 60 s
       └─ 9. prCloseCleanupScheduler.start()   ← 60 s
```

Each `Scheduler.start()` fires the first tick immediately (not after waiting for the first interval), so the system begins processing queued tasks within seconds of startup.

---

## Monitoring and Observability

### Log Patterns

All scheduler activity uses pino-structured logs. Key log events:

| Log message | Level | When |
|---|---|---|
| `"Daemon started"` | info | `start()` complete; includes config summary |
| `"Daemon stopped"` | info | `stop()` complete |
| `"Daemon: stale task transitioned to failed"` | info | Stale recovery at startup |
| `"Daemon: suspended task resumed"` | info | Suspended recovery at startup |
| `"Daemon: cleaned up stale active-agent rows"` | info | `cleanupStale()` found rows |
| `"Daemon: task suspended"` | info | During graceful shutdown |
| `"Daemon: per-user concurrency limit reached, skipping task"` | debug | Tick guard |
| `"Daemon: user budget exhausted, skipping task"` | warn | Budget guard |
| `"Daemon: dispatch error"` | error | Unhandled pipeline error |
| `"Daemon: producer run completed"` | info | Normal producer result |
| `"Daemon: producer run completed with errors"` | warn | Producer partial failure |
| `"Daemon: producer run failed"` | error | Producer hard failure |
| `"Daemon: retrospective not due yet, skipping"` | debug | Gap gate in effect |
| `"Daemon: starting weekly retrospective"` | info | Retrospective begins |
| `"Daemon: monthly decay not due yet, skipping"` | debug | Gap gate in effect |

### Dashboard Visibility

| Concern | Dashboard surface |
|---|---|
| Task status | Task list and detail page (reflects pipeline state) |
| Active agents | `/api/status` — exposes `active_agents` rows with heartbeat timestamps |
| Preview status | Task detail page: `previewStatus`, `previewUrl` |
| Task events | Timeline on task page (`addEvent` calls) |
| Producer activity | "Producer Activity" panel — `producer_runs` table |
| Learnings health | Settings → Learnings panel — decay/confidence scores |

### Health Check

`GET /health` always returns `200 OK` while the process is alive. Container orchestrators (Azure Container Apps) use this to confirm the process — and therefore the daemon — is running.

### Stale Agent Detection (Manual Query)

For operational debugging:

```sql
-- Find agents that haven't heartbeated in 10+ minutes
SELECT task_id, agent_type, last_heartbeat_at
FROM active_agents
WHERE last_heartbeat_at < NOW() - INTERVAL '10 minutes';

-- Find tasks that have been in a transitional state for 20+ minutes
SELECT id, status, updated_at
FROM tasks
WHERE status IN ('executing', 'reviewing', 'enriching', 'rework')
  AND updated_at < NOW() - INTERVAL '20 minutes';
```

---

## See Also

- [`docs/internal/architecture.md`](../architecture.md) — full system overview and daemon's role in the pipeline
- [`docs/internal/modules/execution.md`](./execution.md) — `executeTask()`, worktree model, preview manager details
- [`docs/internal/modules/agents.md`](./agents.md) — `runPipeline()`, retrospective, keeper agents
- [`docs/internal/modules/producers.md`](./producers.md) — producer interface, duplicate detection, `needsRepo` pattern
- `src/domain/autonomous-config.ts` — `autonomous.config.yaml` schema including preview defaults
- `src/db/queries/active-agents.ts` — `register()`, `unregister()`, `heartbeat()`, `cleanupStale()`
- `src/db/queries/tasks.ts` — `list()`, `updateStatus()`, `suspendTask()`, `findSuspended()`
