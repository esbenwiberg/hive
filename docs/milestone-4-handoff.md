# Milestone 4 Handoff: Execution & Worker Pipeline

## 1. Context for Milestone 5

### Execution Pipeline Now Complete (Route → Enrich → Gate → Execute)

Milestone 4 added the execution phase and completed the full synchronous pipeline. Key integration points:

- **`src/agents/pipeline.ts`** now includes **Step 6** (lines 105-122): after gate approval, it automatically calls `executeTask()` or `executeEpic()` based on the task's workflow type.
- The pipeline is idempotent and can be run on any task in `pending` status. It's called per-task, not as a daemon loop yet.

### Key Exports for Milestone 5

**Worker execution** (`src/execution/worker.ts`):
- `executeTask(taskId)` → Handles full flow task lifecycle: worktree setup → Claude agent → review gate → PR creation → status transitions. Returns `WorkerResult { success, prUrl?, branch?, reviewResult?, error? }`. Manages rework cycles (up to 2) and budget enforcement.
- `executeEpic(taskId)` → Decomposes epic into milestones via `decomposeEpic()`, creates child flow tasks with `epicId`, `milestoneIndex`, `milestoneTotal` metadata. Returns `WorkerResult { success, error? }`.
- Both functions call `register(taskId, "worker", model, "executing/reviewing")` at start and `unregister(taskId)` in finally block.
- Both handle budget exhaustion before starting (throw Error if remaining ≤ 0).
- Max rework cycles is a constant `MAX_REWORK_CYCLES = 2` (line 19).

**Git operations** (`src/execution/git-provider.ts`, `src/execution/worktree.ts`):
- `GitProvider` interface: `{ clone, createBranch, commitAll, push, createPR }`.
- Implementations: `GitHubProvider` (REST API via fetch) and `AzureDevOpsProvider` (ADO REST API).
- `getGitProvider(provider: string)` factory returns the right provider.
- `createWorktree(repoFullName, provider, branch, defaultBranch, userId)` → Creates isolated clone in `/tmp/hive-worktrees/`, returns `WorktreeInfo { path, branch, repoFullName, provider, createdAt }`.
- `cleanupWorktree(worktree)` → Recursively deletes the worktree directory.
- `resolveGitCredentials(userId, provider)` → Looks up `user_credentials` table, fetches token from vault, returns `{ provider, token }`.

**Code review gate** (`src/execution/review-gate.ts`):
- `reviewChanges(taskId, worktree)` → Runs Claude review agent on the git diff, records review verdict. Returns `ReviewGateResult { verdict: "pass"|"rework"|"fail", findings[], securityFindings[], verification, costUsd }`.
- `parseReviewResult(text)` → Parses JSON from Claude response (handles markdown fences).
- `getGitDiff(worktreePath)` and `getChangedFiles(worktreePath)` helper functions.
- Calls `register(taskId, "review-gate", model, "reviewing")` and records results via `recordReview()`.

**Task refinement** (`src/agents/refiner.ts`):
- `refineTask(taskId, reviewResult)` → Takes rework verdict + findings, calls Claude to generate refined retry instructions. Updates task: `retryInstructions`, `reworkCount`, `reworkHistory`. Returns refined instructions string.
- Stores full rework cycle history in `reworkHistory` JSONB array with { cycle, findings, securityFindings, refinedInstructions, timestamp }.

**Decomposition** (`src/agents/decomposer.ts`):
- `decomposeEpic(taskId)` → Loads epic task, calls Claude with `prompts/milestone.md`, parses response into `MilestoneSpec[]`. Returns array of { title, body, index, total }.
- Registers/unregisters active agent during execution.

### New Domain Types

All added to `src/domain/types.ts`:
- `WorktreeInfo { path, branch, repoFullName, provider, createdAt }`
- `ReviewFinding { severity, file, line?, message, category }`
- `SecurityFinding { severity, type, description, file? }`
- `VerificationResult { testsRun, testsPassed, lintClean, buildSucceeded, notes[] }`
- `ReviewGateResult { verdict, findings[], securityFindings[], verification, costUsd }`
- `GitCredentials { provider, token, username? }`
- `WorkerResult { success, prUrl?, branch?, reviewResult?, error? }`
- `MilestoneSpec { title, body, index, total }`

### Database Tables Ready for Milestone 5

All schema columns were already present in Milestone 3:
- `tasks.executionAttempts` (integer, default 0) — incremented each time Claude is called in worker.
- `tasks.prUrl` (text, nullable) — set after successful PR creation.
- `tasks.failureReason` (text, nullable) — set on task failure.
- `tasks.reworkCount` (integer, default 0) — incremented by refiner.
- `tasks.reworkHistory` (jsonb, default []) — accumulated history entries by refiner.
- `tasks.retryInstructions` (text, nullable) — set by refiner for rework cycles.
- `tasks.epicId` (text, nullable) — set by worker when creating child tasks.
- `tasks.milestoneIndex`, `tasks.milestoneTotal` (integer) — set for epic children.
- `tasks.blueprint` (text, nullable) — stores decomposition plan as JSON string.

**`code_reviews` table** created in schema (lines 150-162):
- Columns: `id`, `task_id` (FK), `verdict`, `rework_cycle`, `findings` (jsonb), `security_findings` (jsonb), `verification` (jsonb), `cost_usd`, `created_at`.
- Already in migration and test cleanup.
- Query file `src/db/queries/code-reviews.ts` exists with: `recordReview()`, `listByTask()`, `getLatestByTask()`.

**`user_credentials` table** created (lines 36-46):
- Columns: `id`, `user_id` (FK), `provider`, `vault_secret_id`, `label`, `created_at`.
- Unique constraint on (user_id, provider, label).
- Query file `src/db/queries/user-credentials.ts` exists with: `getByUserAndProvider()`, `getByUser()`, `create()`, `deleteByUserAndProvider()`.

**`active_agents` table** (lines 175-183):
- `taskId` (PK, FK to tasks.id), `agent`, `model`, `phase`, `startedAt`.
- Already has `register()`, `unregister()`, `listActive()`, `cleanupStale(maxAgeMs)` query functions.

### New Prompts

Created in `prompts/`:
- `prompts/flow.md` — System prompt for executing flow tasks. Claude acts as developer, takes working directory + enrichment + retry instructions.
- `prompts/milestone.md` — System prompt for epic decomposition. Claude breaks epic into ordered milestones.
- `prompts/review-gate.md` — System prompt for code review gate. Claude evaluates changes for correctness, security, style.

### Azure DevOps Integration

`src/integrations/azure-devops.ts`:
- `createPullRequest(org, project, repo, sourceBranch, targetBranch, title, body, token)` → ADO REST API call, returns PR URL.
- `getPullRequest(org, project, repo, prId, token)` → Fetches PR details.
- `parseAdoRepoName(fullName)` → Parses "org/project/repo" format into components.
- Wired into `AzureDevOpsProvider.createPR()` in git-provider.ts.

### Key Patterns Established in Milestone 4

1. **Worker lifecycle**: register → worktree → agent call → review → (pass: PR create/done | rework: refine/rework | fail: failed) → unregister.
2. **Cost estimation**: `(inputTokens * inputCostPerM + outputTokens * outputCostPerM) / 1_000_000`. Used in worker, refiner, decomposer, review-gate.
3. **Rework flow**: verdict "rework" → `refineTask()` → `updateStatus(taskId, "rework")` → daemon will re-execute → new cycle.
4. **Epic handling**: workflow="epic" → `executeEpic()` → `decomposeEpic()` → create child tasks → mark parent as done.
5. **Git credentials**: resolved at execution time via vault lookup, not stored in process memory.
6. **Active agent tracking**: Every major agent (worker, review-gate, refiner, decomposer) registers/unregisters itself during execution.

### What the Daemon Should Know

The pipeline calls `runPipeline(taskId)` synchronously. It checks that the task is `pending`, routes it, enriches it, gates it, and executes it. The **daemon's job in Milestone 5** is to:

- Poll the database for tasks in states where work can be done (e.g., `queued` → enrich, `approved` → execute, `rework` → execute again).
- Call `runPipeline()` when a `queued` task is found (or handle `approved`/`rework` tasks separately).
- Manage a worker pool so multiple tasks can run in parallel.
- Track active agents and clean up stale ones.
- Handle graceful shutdown when the daemon stops.

The pipeline itself is stateless and idempotent — it can be called multiple times on the same task without harm. The daemon just needs to orchestrate when to call it.

---

## 2. Suggested Amendments to Milestone 5

### Files Already Created — Do Not Recreate

1. **`src/execution/worker.ts`**, **`src/execution/git-provider.ts`**, **`src/execution/worktree.ts`**, **`src/execution/review-gate.ts`** — All exist and are fully functional.
2. **`src/agents/refiner.ts`**, **`src/agents/decomposer.ts`** — Both exist with full implementations.
3. **`src/integrations/azure-devops.ts`** — ADO integration exists.
4. **`src/db/queries/code-reviews.ts`**, **`src/db/queries/user-credentials.ts`** — Both query files exist.
5. **`prompts/flow.md`**, **`prompts/milestone.md`**, **`prompts/review-gate.md`** — All system prompts exist.

### Entry Point Modification Needed

**`src/index.ts`** currently only starts the Express server. Milestone 5 must extend this to:
- Start the Daemon class alongside the Express server.
- Wire daemon start/stop into the graceful shutdown handler.
- Option: add a command-line flag (e.g., `HIVE_MODE=daemon` or `--with-daemon`) to conditionally start the daemon.

Current structure (lines 8-32):
```ts
await migrate();
const server = app.listen(PORT, ...);
const shutdown = (signal) => { server.close(); pool.end(); };
```

Should become something like:
```ts
await migrate();
const server = app.listen(PORT, ...);
const daemon = process.env.HIVE_MODE === "daemon" ? new Daemon() : null;
if (daemon) await daemon.start();
const shutdown = (signal) => {
  if (daemon) await daemon.stop();
  server.close();
  pool.end();
};
```

### Expected Milestone 5 Files

Based on the blueprint, create:
1. **`src/daemon/daemon.ts`** — Main Daemon class with `start()`, `stop()`, poll loop, worker pool, budget checking.
2. **`src/daemon/stale-tasks.ts`** — Query for tasks stuck in a status too long (e.g., `executing` for > 1 hour).
3. **`src/daemon/scheduler.ts`** — Producer scheduling logic if needed (currently probably not — just poll for next work).
4. **`src/cli.ts`** (if not using `HIVE_MODE` env var) — CLI entry point to start daemon in background.

### Database Queries Likely Needed in Daemon

- **Tasks by status**: `listByStatus(status, limit)` — Query for `queued`, `approved`, `rework` tasks.
- **Stale task detection**: A query that finds tasks in `executing`/`reviewing` status for longer than a threshold (e.g., 30 min).
- **Active agent cleanup**: Already have `cleanupStale(maxAgeMs)` — daemon should call this periodically.

Current `src/db/queries/tasks.ts` has `list(filters)` with status filter, so you can call `list({ status: "approved" }, 10)` to get up to 10 approved tasks. Add a `listByStatus(status)` convenience function if needed.

### Key Design Decisions for Milestone 5

1. **Sequential vs Parallel**: The blueprint says "manages the worker pool" — does this mean multiple tasks run concurrently? If so, each task needs its own worktree and git credentials. The current worker implementation supports this (no shared state). Daemon should use a pool (e.g., `pLimit` or Bullmq) to queue tasks.

2. **Poll interval**: How often should the daemon check the database? 5 seconds? 30 seconds? This should be configurable in `autonomous.config.yaml` or env var.

3. **Budget enforcement**: The worker already checks `checkBudget()` before executing. The daemon should also respect per-user daily budgets when deciding whether to queue a task. If a user is over budget, skip their tasks.

4. **Graceful shutdown**: When SIGTERM is received, the daemon should:
   - Stop accepting new work from the poll.
   - Wait for active workers to finish (with a timeout, e.g., 5 min).
   - Unregister any stale agents.
   - Close the database pool.

5. **Monitoring/metrics**: The dashboard already shows active agents. The daemon could optionally emit logs with task throughput, error rates, etc. (not blocking for Milestone 5).

### Risks and Gotchas

1. **Concurrent worktree cleanup**: If two tasks try to clean up the same worktree directory simultaneously, they might race. The current implementation uses `rm -rf` which is idempotent, but file system races are possible. Consider adding a unique suffix (already done: `dirName = ${branch}-${Date.now()}`).

2. **Database connection pool exhaustion**: If the daemon runs many concurrent tasks and each opens a connection, the pool can be exhausted. Use a bounded worker pool (e.g., max 5 concurrent tasks).

3. **Stale active_agents rows**: If a worker crashes without calling `unregister()`, its row in `active_agents` will persist. The daemon should periodically call `cleanupStale(60 * 1000)` (1 minute) to remove orphaned entries.

4. **No idempotency for failed transitions**: If a task fails to transition out of `executing` status (e.g., DB error), it will remain in the status. The daemon should handle this by retrying the transition or logging a critical error.

5. **Epic child task ordering**: The decomposer returns milestones in order. The daemon should process them sequentially (or at least not in parallel) to maintain the workflow's intended structure. Store the `milestoneIndex` and have the daemon check that all earlier milestones are complete before executing a later one.

6. **Git provider selection**: The worker gets the provider from `repo.provider` (e.g., "github", "azure-devops"). Ensure all repos in the system have this field populated before Milestone 5. The dashboard might need a check to warn if a repo's provider is missing.

7. **No retry logic in daemon**: The worker calls `refineTask()` and transitions to `rework` on rework verdict. The daemon must re-poll and execute the rework task. This already works, but ensure the poll loop checks for `rework` status.

### Testing Recommendations

- **Unit tests for Daemon**: Mock `pool`, `db.select()`, timers. Test poll loop logic, worker pool queueing, shutdown.
- **Integration tests**: Use a test database, create tasks in `queued`/`approved` status, verify daemon transitions them correctly.
- **Concurrency tests**: Spin up multiple task executions, verify they don't interfere (e.g., worktree cleanup, active agent tracking).
- **Graceful shutdown test**: Start daemon, trigger SIGTERM, verify active workers are allowed to finish, then daemon exits.
