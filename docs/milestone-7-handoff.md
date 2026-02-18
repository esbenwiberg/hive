# Milestone 7 Handoff Report for Milestone 8

## 1. Context for Milestone 8

### Database: learnings + learning_events tables are ALREADY created

The `learnings` and `learning_events` tables already exist in both the Drizzle schema and the migration file. No new migration is needed.

**`src/db/schema.ts`** -- Schema definitions and types:
- `learnings` table: `id`, `scope` (text, indexed), `category` (text), `content` (text), `confidence` (numeric(3,2) default 0.50), `reinforcements` (int default 0), `contradictions` (int default 0), `sourceTaskIds` (text[]), `tags` (text[], GIN-indexed), `createdAt`, `updatedAt`, `lastUsedAt`, `supersededBy` (int, nullable self-ref).
- `learning_events` table: `id`, `learningId` (FK to learnings.id), `eventType` (text), `taskId` (FK to tasks.id, nullable), `evidence` (text), `createdAt`.
- Indexes: `learnings_scope_idx`, `learnings_tags_idx` (GIN), `learnings_confidence_idx`.
- **No row types exported yet** -- Milestone 8 should add `export type LearningRow = InferSelectModel<typeof learnings>` and `export type LearningEventRow = InferSelectModel<typeof learningEvents>` to the bottom of `schema.ts`, matching the existing pattern (see `TaskRow`, `RepoRow`, etc. on lines 294-298).

**`tests/setup.ts`** -- `cleanupTables()` currently truncates a fixed list of tables. Milestone 8 MUST add `learnings, learning_events` to the TRUNCATE statement, otherwise test data will leak between tests.

### Key files and exports to use

**Agent SDK** (`src/agents/sdk.ts`):
- `callClaude(req: SdkRequest): Promise<SdkResponse>` -- thin wrapper for the Anthropic API. Accepts `prompt`, `model?`, `maxTokens?`, `systemPrompt?`, `dryRun?`. Returns `{ text, cost: { model, inputTokens, outputTokens } }`.
- All agents use this. The feedback-loop and retrospective agents should follow the same pattern.

**Cost tracking** (`src/db/queries/costs.ts`):
- `recordCost(taskId, userId, agent, model, costUsd, turns?, durationMs?)` -- every agent call records cost. The new agents (feedback-loop, retrospective) must do the same.
- Cost estimation helper: `(inputTokens * config.models.inputCostPerM + outputTokens * config.models.outputCostPerM) / 1_000_000`. This is duplicated in `worker.ts`, `review-gate.ts`, `gate.ts`, `refiner.ts`. Consider extracting to a shared utility.

**Active agent tracking** (`src/db/queries/active-agents.ts`):
- `register(taskId, agent, model, phase)` / `unregister(taskId)` -- must wrap agent calls in register/unregister. See `refiner.ts` for the cleanest example of this pattern.

**Autonomous config** (`src/domain/autonomous-config.ts`):
- `getAutonomousConfig(): AutonomousConfig` -- singleton, loaded from `autonomous.config.yaml`. Provides `models.gate`, `models.router`, `models.inputCostPerM`, `models.outputCostPerM`.
- Milestone 8 may want to add a `hivemind` section to `AutonomousConfig` for configuring confidence decay rate, retrospective schedule, etc.

**Prompts** (`src/prompts.ts`):
- `listPromptFiles()`, `readPrompt(relativePath)`, `writePrompt(relativePath, content)`, `validatePromptPath(relativePath)`.
- Prompts live in `/prompts/*.md`. Existing prompts: `flow.md`, `gate.md`, `router.md`, `review-gate.md`, `milestone.md`, plus `enrichers/*.md` subdirectory.
- New prompts `prompts/feedback-loop.md` and `prompts/retrospective.md` just need to be dropped in. The prompt editor dashboard already supports any `.md` file in the prompts directory.

**Domain types** (`src/domain/types.ts`):
- `SessionUser`, `TaskStatus`, `TaskStatusValue`, `ReviewGateResult`, `ReviewFinding`, `SecurityFinding`, `WorkerResult`, `WorktreeInfo`, `MilestoneSpec`.
- `ReviewGateResult` is what the feedback-loop will consume (it contains `verdict`, `findings`, `securityFindings`, `verification`, `costUsd`).

**Dashboard patterns** (`src/dashboard/`):
- Views return raw HTML strings (no templating engine). Import `layout()` from `views/layout.ts` for the full page wrapper. Import component helpers from `views/components.ts` (`escapeHtml`, `badge`, `card`, `statCard`, `table`, `button`, `statusBadge`, `emptyState`, `select`, `textarea`, `modal`, `pipelineSteps`).
- Routes are Express routers. Register them in `src/dashboard/server.ts` with `app.use("/", hivemindRouter)`.
- HTMX is loaded globally. Use `hx-get`/`hx-post` + `hx-target` + `hx-swap` for partial updates. See `costs.ts` routes for the dimension-switching pattern. POST routes are protected by CSRF Origin check middleware in `server.ts`.
- Auth: `req.session.user` is a `SessionUser`. Admin check: `req.session.user.role === "admin"`.
- The nav sidebar in `views/layout.ts` already has a "Hivemind" link pointing to `/hivemind` (line 40-43). It is already wired up.

**Worker integration points** (`src/execution/worker.ts`):
- Line 77-97: builds the user prompt before calling Claude. This is where `retrieveLearnings()` should inject relevant knowledge. The natural injection point is between the enrichment context and the retry instructions sections.
- The worker already has access to `task.repoId` (for scope), `task.type` (for category filtering), and `task.enrichment` (for tags/context).

**Review gate integration points** (`src/execution/review-gate.ts`):
- Line 164-176: after `parseReviewResult()` and `recordReview()`, before returning. This is where the feedback-loop call should go. The function already has `taskId` and the `ReviewGateResult` available.
- Important: the feedback-loop call should be fire-and-forget (catch errors, don't block the review gate return) to avoid breaking the execution pipeline.

**Daemon integration points** (`src/daemon/daemon.ts`):
- The `Daemon` class manages `Scheduler` instances (one for the main task loop, one per producer). Adding a retrospective scheduler follows the same pattern: create a `Scheduler` in `start()`, push to `producerSchedulers` (or a new array), and stop in `stop()`.
- For confidence decay: add another `Scheduler` with a daily interval, or bundle it with the retrospective tick.

**Global config** (`src/domain/config.ts`):
- `getConfig(key)` / `setConfig(key, value)` -- reads/writes the `global_config` table. Use this to store the last retrospective run date, hivemind settings, etc.

**Notifications** (`src/notifications.ts`):
- `sendNotification(payload)` / `notifyTasksCreated(producer, repo, titles, ids)` -- Slack and Teams webhook integration. The retrospective agent could send a weekly summary notification using `sendNotification()`.

### Patterns to follow

1. **Agent structure**: See `src/agents/refiner.ts` (cleanest example, 119 lines). Pattern is: register active agent -> load/build prompt -> callClaude -> estimate + record cost -> update DB -> unregister in finally block.

2. **Query file structure**: Each table gets `src/db/queries/<table>.ts`. Export individual async functions. Use drizzle-orm query builder. Parse numeric columns with `parseFloat()` (pg returns strings for numeric types).

3. **Test structure**: DB query tests go in `tests/db/`, dashboard view/route tests go in `tests/dashboard/`. Use vitest. DB tests call `useTestDb()` and `cleanupTables()` in beforeEach. View tests are pure unit tests that call the view function and assert HTML content.

4. **Route patterns**: Each route file exports a default Express Router. Full-page routes render `layout(title, content, user)`. HTMX partial routes return raw HTML fragments. Admin-only routes check `req.session.user?.role === "admin"` and return 403.

5. **Import style**: All internal imports use `.js` extensions (ESM). Types use `import type`.

### Database tables ready for use

| Table | Status | Notes |
|-------|--------|-------|
| `learnings` | Schema + migration exist | No query file yet -- Milestone 8 creates `src/db/queries/learnings.ts` |
| `learning_events` | Schema + migration exist | No query file yet -- Milestone 8 creates `src/db/queries/learning-events.ts` |
| `tasks` | Full CRUD exists | `getById()`, `updateStatus()`, `list()`, `create()` in `src/db/queries/tasks.ts` |
| `code_reviews` | Read/write exists | `recordReview()`, `listByTask()`, `getLatestByTask()` in `src/db/queries/code-reviews.ts` |
| `gate_decisions` | Read/write exists | `recordDecision()`, `listByTask()` in `src/db/queries/gate-decisions.ts` |
| `costs` | Full aggregation exists | `recordCost()`, `checkBudget()`, `getDailyBreakdown()`, etc. in `src/db/queries/costs.ts` |
| `global_config` | Read/write exists | `getConfig()`, `setConfig()` in `src/domain/config.ts` |

---

## 2. Suggested Amendments to Milestone 8

### Schema: No changes needed

The `learnings` and `learning_events` tables in `src/db/schema.ts` are already defined with the correct columns, indexes (scope, tags GIN, confidence), and foreign keys. The migration file already creates them. **Do not re-add or regenerate the migration.**

### Test setup requires update

The `cleanupTables()` function in `tests/setup.ts` must be updated to include `learnings` and `learning_events` in the TRUNCATE list. This should be done in the first sub-task that touches the DB, not deferred.

### Row type exports needed

Add `LearningRow` and `LearningEventRow` type exports to `src/db/schema.ts` (matching the existing pattern at the bottom of the file). This is a prerequisite for the query files.

### Missing file: `src/agents/keeper.ts` does not exist

The blueprint says "keeper.ts -- Rewritten" but there is no existing `keeper.ts` to rewrite. This is a new file. Adjust the plan accordingly -- it should be created fresh, not rewritten.

### Missing files: `gate-analyst.ts` and `code-quality-analyst.ts` do not exist

Same situation. These are listed as modified but they do not exist. They are new files to create.

### Duplicate cost estimation should be extracted

The `estimateCostUsd()` helper is copy-pasted in 4 files (`worker.ts`, `review-gate.ts`, `gate.ts`, `refiner.ts`). Before adding it to 3 more agent files, consider extracting it to a shared location (e.g., `src/agents/sdk.ts` or a new `src/agents/utils.ts`). This is optional but recommended to reduce drift.

### The Hivemind nav link is already wired

The sidebar in `src/dashboard/views/layout.ts` already includes a "Hivemind" link pointing to `/hivemind`. The dashboard route just needs to be registered.

### Worker prompt injection strategy

The worker builds prompts as string concatenation (lines 85-97 in `worker.ts`). The `retrieveLearnings()` call should return a formatted string block that can be inserted into the prompt array. Suggested format: a new section like `## Relevant Learnings` between the enrichment and retry sections. Keep the injection conditional -- if no learnings are retrieved, omit the section entirely to avoid wasting tokens.

### Retrospective scheduling

The blueprint says "schedules retrospective agent" in the daemon. The daemon's `Scheduler` class runs on a fixed interval. For a weekly retrospective, use a 24-hour interval scheduler that checks `global_config` for the last run timestamp, and only runs if 7+ days have elapsed. This avoids the complexity of cron-like scheduling. The `setConfig("lastRetrospectiveRun", new Date().toISOString())` / `getConfig("lastRetrospectiveRun")` pattern is ready to use.

### No other changes needed

The blueprint's file list and approach are otherwise accurate. The planned query files (`learnings.ts`, `learning-events.ts`), agent files (`feedback-loop.ts`, `retrospective.ts`, `keeper.ts`, `gate-analyst.ts`, `code-quality-analyst.ts`), dashboard files (`routes/hivemind.ts`, `views/hivemind.ts`), and prompt files (`feedback-loop.md`, `retrospective.md`) all need to be created from scratch. The integration points in `worker.ts`, `review-gate.ts`, and `daemon.ts` are well-defined and ready for modification.
