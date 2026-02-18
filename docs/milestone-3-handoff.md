# Milestone 3 Handoff: Pipeline Agents (Route -> Enrich -> Gate)

## 1. Context for Milestone 4

### State Machine Transitions Already Wired

The state machine (`src/domain/state-machine.ts`) already has all transitions Milestone 4 needs:

```
approved -> executing, cancelled
executing -> reviewing, failed, cancelled
reviewing -> done, rework, failed
done -> merged
failed -> pending
rework -> executing, cancelled
```

The `updateStatus()` function in `src/db/queries/tasks.ts` validates transitions via `canTransition()` before writing. It also sets `approvedBy` when transitioning to `approved` or `ready`.

### Key Exports Milestone 4 Should Use

**SDK + resilience (`src/agents/sdk.ts`, `src/agents/retry.ts`)**
- `callClaude({ prompt, model?, maxTokens?, systemPrompt?, dryRun? })` -> `{ text, cost: { model, inputTokens, outputTokens } }`. Lazy singleton Anthropic client. Use `dryRun: true` for testing without real API calls.
- `withRetry(fn, { maxRetries?, baseDelayMs?, jitter? })` -> exponential backoff wrapper. Use it around `callClaude` calls in the worker and review gate.
- `CircuitBreaker` class with `.call(fn)` method. States: closed/open/half-open. Configurable `failureThreshold` (default 5) and `resetTimeoutMs` (default 30s).
- `setSleep(fn)` -> test helper to avoid real delays.

**Cost tracking (`src/db/queries/costs.ts`)**
- `recordCost(taskId, userId, agent, model, costUsd, turns?, durationMs?)` -> records a row in `costs` table.
- `checkBudget(userId, dailyBudget?)` -> returns remaining USD for today. Reads `users.dailyBudget` if no explicit budget.
- `getTodayTotal(userId)` / `getTodayTotalGlobal()` / `getUserTotal(userId)`.

The worker should call `checkBudget()` before each Claude turn and `recordCost()` after each turn. The `agent` string should identify the component (e.g. `"worker"`, `"review-gate"`, `"refiner"`, `"decomposer"`).

**Active agent tracking (`src/db/queries/active-agents.ts`)**
- `register(taskId, agent, model, phase?)` -> upsert, since `taskId` is PK.
- `unregister(taskId)` -> delete row.
- `cleanupStale(maxAgeMs)` -> removes rows older than threshold.

Pattern: call `register()` at the start of worker execution, update `phase` as you progress through the flow, call `unregister()` in a `finally` block. The dashboard already shows active agents.

**Gate decisions (`src/db/queries/gate-decisions.ts`)**
- `recordDecision(taskId, verdict, source, decidedBy?, reasoning?, taskContext?)`.
- `listByTask(taskId)` -> returns decisions ordered by `createdAt` desc.

The review gate should use this same table with `source: "review-gate"` to record its pass/fail/rework verdicts.

**Enrichment data (`src/db/queries/enrichment-runs.ts`)**
- `mergeResults(taskId)` -> returns merged JSONB from all completed enrichment runs. The worker can call this to get the enrichment context gathered by the pipeline.

**Task queries (`src/db/queries/tasks.ts`)**
- `getById(id)` -> returns full `TaskRow` including `enrichment`, `model`, `maxTurns`, `maxBudgetUsd`, `workflow`, `type`, `size`, `epicId`, `milestoneIndex`, `blueprint`, `reworkCount`, `reworkHistory`, `retryInstructions`, `prUrl`, `executionAttempts`, `failureReason`.
- `updateStatus(id, newStatus, userId?)` -> validates via state machine, sets `approvedBy` for approve/ready.
- `updateClassification(id, data)` -> sets type/size/model/workflow/maxTurns/maxBudgetUsd.
- `updateEnrichment(id, enrichment)` -> sets enrichment JSONB.

For Milestone 4, you will likely need new task query functions:
- `incrementExecutionAttempts(id)` -> bump `execution_attempts`
- `setPrUrl(id, url)` -> set `pr_url`
- `incrementReworkCount(id, historyEntry)` -> bump `rework_count`, append to `rework_history`
- `setRetryInstructions(id, instructions)` -> set `retry_instructions`

**Autonomous config (`src/domain/autonomous-config.ts`)**
- `getAutonomousConfig()` -> returns cached `AutonomousConfig` with: `classification`, `gate: { mode }`, `budget: { dailyDefault, perTaskMax }`, `enrichers[]`.
- Config file: `autonomous.config.yaml` at project root.
- Milestone 4 may want to add worker-specific config fields (e.g. `maxReworkCycles`, `workerConcurrency`).

**Task schema columns already present for Milestone 4** (in `src/db/schema.ts`):
- `executionAttempts` (integer, default 0)
- `prUrl` (text, nullable)
- `failureReason` (text, nullable)
- `reworkCount` (integer, default 0)
- `reworkHistory` (jsonb, default [])
- `retryInstructions` (text, nullable)
- `epicId` (text, nullable)
- `milestoneIndex` (integer, nullable)
- `milestoneTotal` (integer, nullable)
- `blueprint` (text, nullable)

**`code_reviews` table already exists** (in schema and migration):
- Columns: `id`, `task_id`, `verdict`, `rework_cycle`, `findings` (jsonb), `security_findings` (jsonb), `verification` (jsonb), `cost_usd`, `created_at`.
- Already included in `tests/setup.ts` TRUNCATE.
- No query file yet -- `src/db/queries/code-reviews.ts` needs to be created.

**`user_credentials` table already exists**:
- Columns: `id`, `user_id`, `provider`, `vault_secret_id`, `label`, `created_at`.
- Unique constraint on `(user_id, provider, label)`.
- Exported type: `UserCredentialRow` from `src/db/schema.ts`.
- No query file yet -- needed for resolving per-user git credentials at execution time.

**Repos table** (`src/db/queries/repos.ts`):
- `getById(id)` -> returns `RepoRow` with `provider`, `fullName`, `defaultBranch`, `settings` (jsonb).
- `findOrCreate(provider, fullName, defaultBranch?)`.

### Patterns Established

1. **Agent registration pattern**: Every agent function registers itself with `active-agents`, does work in a try block, and unregisters in a `finally` block. See `src/agents/router.ts` and `src/agents/gate.ts`.

2. **Cost recording pattern**: Calculate `estimateCostUsd(inputTokens, outputTokens)` using `(input * 3 + output * 15) / 1_000_000`. Track `startTime = Date.now()` at beginning, compute `durationMs = Date.now() - startTime`. Call `recordCost()` with the agent name.

3. **Prompt loading pattern**: Prompts are in `prompts/*.md`. Loaded once with `readFileSync` and cached in a module-level variable. JSON output format is parsed with `JSON.parse()` after stripping markdown code fences.

4. **Pipeline error handling pattern** (from `src/agents/pipeline.ts`): On failure, call `updateStatus(taskId, 'failed')` and set `failureReason` directly on the task. Silently catch transition errors to avoid masking the original error.

5. **Enricher interface pattern** (`src/enrichers/base.ts`): Each enricher implements `{ name, run(task, repoDir, priorResults, config) }`. Results are `{ data, costUsd?, durationMs }`. Enrichers run sequentially; each gets merged prior results.

6. **Test patterns**: Tests use `vitest`. DB tests call `useTestDb()` and `cleanupTables()` in `beforeEach`. Agent tests mock `src/agents/sdk.ts` and `src/db/queries/*` with `vi.mock()`. Pipeline tests mock at the module level. See `tests/agents/pipeline.test.ts` for the orchestration test pattern.

7. **Dashboard view pattern**: Views are plain TypeScript functions returning HTML strings. HTMX is used for interactivity. The task detail panel (`src/dashboard/views/tasks.ts`) already shows enrichment data and gate decisions.

### File Layout Convention

```
src/agents/         -- Agent logic (router, gate, pipeline; add refiner, decomposer)
src/enrichers/      -- Enrichment modules (base + 4 enrichers)
src/execution/      -- [NEW] Worker, worktree, git-provider, review-gate
src/integrations/   -- [NEW] Azure DevOps REST client
src/db/queries/     -- One file per table (tasks, costs, gate-decisions, etc.)
src/domain/         -- Types, state machine, autonomous config
src/dashboard/      -- Express routes + HTML view functions
src/auth/           -- Entra ID auth, session, middleware
prompts/            -- Markdown prompts for LLM agents
tests/              -- Mirrors src/ structure
```

---

## 2. Suggested Amendments to Milestone 4

### Already created -- do not recreate

1. **`src/db/queries/code-reviews.ts`** is listed as a Milestone 4 deliverable. The `code_reviews` table and schema already exist (`src/db/schema.ts` lines 150-162, migration in `drizzle/0000_jazzy_nuke.sql`). The table is already included in `tests/setup.ts` cleanup. You only need to create the query file, not the schema/migration.

2. **`src/domain/types.ts`** is listed for adding `WorktreeInfo`, `ReviewGateResult`, etc. The file already exists with `TaskStatus`, `TaskSize`, `TaskType`, `Workflow`, `SessionUser`, `TaskFilters`, and helpers. Add new types there; do not create a new file.

### Missing files the blueprint should add

1. **`src/db/queries/user-credentials.ts`** -- No query file exists yet for the `user_credentials` table. The worker needs this to resolve per-user git credentials (look up `vault_secret_id` by `userId` + `provider`). The blueprint mentions "per-user git credentials are resolved at execution time" but does not list a query file for this table.

2. **`src/integrations/keyvault.ts`** (or similar) -- The blueprint mentions "Key Vault" for credentials but does not list a file for the Azure Key Vault client. `@azure/keyvault-secrets` and `@azure/identity` are already in `package.json`. A thin wrapper is needed to fetch secrets by `vault_secret_id`.

### Approach adjustments

1. **Pipeline `PLACEHOLDER_REPO_DIR`**: In `src/agents/pipeline.ts` (line 12), the enricher step currently passes `"/tmp/placeholder"` as `repoDir`. Once the worktree module exists, the pipeline should be updated to pass the actual repo directory. However, since Milestone 4's worker runs after approval (not during the enrich step), this is not blocking -- just note it for later integration.

2. **Budget enforcement should be integrated into the worker loop**: `checkBudget(userId)` from `src/db/queries/costs.ts` returns remaining USD. The worker should call this before each Claude turn and abort if over budget. The `perTaskMax` from `autonomous.config.yaml` (`budget.perTaskMax: 25.00`) and `maxBudgetUsd` from the task's classification should both be checked.

3. **Rework flow**: The state machine allows `rework -> executing`. The refiner agent should read `reworkHistory` and `retryInstructions` from the task row, rewrite/refine the task, then transition back to executing. The review gate's rework verdict should populate `retryInstructions` before transitioning to rework.

4. **Epic workflow and decomposer**: The `workflow` field on tasks is set by the router ("flow" or "epic"). The decomposer needs to handle epic tasks differently -- it should create child tasks with `epicId` pointing to the parent and `milestoneIndex`/`milestoneTotal` set. The `blueprint` column stores the decomposition plan.

5. **The `estimateCostUsd()` helper is duplicated** in both `router.ts` and `gate.ts`. Consider extracting it to a shared location (e.g. `src/agents/sdk.ts` or a new `src/agents/cost-utils.ts`) so the worker and review gate can reuse it.

### Risks and gotchas

1. **Git operations in tests**: The `git-history` enricher uses `child_process.execFile("git", ...)`. The worker and worktree module will need the same. For unit tests, mock `child_process` or use temporary git repos. The existing `tests/enrichers/git-history.test.ts` shows how this was handled.

2. **The `active_agents` table has `taskId` as PK** (not composite). This means only one agent can be registered per task at a time. If the worker and review gate need to be registered simultaneously, either unregister the worker before starting review, or change the PK. Current pattern is register/unregister sequentially per phase.

3. **The `costs` table `userId` is required** (NOT NULL, FK to users). The worker must always pass the task creator's `userId` (`task.createdBy`) when recording costs, not a system user ID.

4. **No `src/execution/` or `src/integrations/` directories exist yet**. These are entirely new -- create them from scratch.

5. **Dashboard actions for executing/reviewing**: The state machine actions map in `getAvailableActions()` already includes actions for `approved` ("Execute"), `executing` ("Review", "Mark Failed"), `reviewing` ("Complete", "Rework", "Mark Failed"), `done` ("Merge"), and `rework` ("Execute"). These will work for manual triggering via the dashboard. The worker automation needs to call `updateStatus()` directly.
