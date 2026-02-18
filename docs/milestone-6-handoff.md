# Milestone 6 Handoff: Producers + Notifications

## 1. Context for Milestone 7

### Key Exports and Files

**Producer Runs DB** (`src/db/queries/producer-runs.ts`)
- `recordRun({ producer, repo?, tasksCreated, duplicatesSkipped, errors, costUsd, durationMs })` — inserts row, returns it
- `listRecent(producer, limit?)` — recent runs ordered by createdAt DESC

**Producer Base** (`src/producers/base.ts`)
- `Producer` interface: `{ name: string; run(ctx: ProducerContext): Promise<ProducerResult> }`
- `ProducerContext`: `{ repoId, repoFullName, createdBy, dryRun? }`
- `ProducerResult`: `{ tasksCreated, duplicatesSkipped, errors, costUsd }`
- `isDuplicate(source, title)` — checks for non-terminal duplicates in tasks table

**Five Producer Singletons:**
- `logScanner` from `src/producers/log-scanner.js`
- `bugHunter` from `src/producers/bug-hunter.js`
- `securityScanner` from `src/producers/security-scanner.js`
- `featureScout` from `src/producers/feature-scout.js`
- `selfMonitor` from `src/producers/self-monitor.js`

**Notifications** (`src/notifications.ts`)
- `sendNotification(payload: NotificationPayload)` — Slack/Teams webhook sender, vault-based URL lookup
- `notifyTasksCreated(producerName, repoName, taskTitles, taskIds)` — convenience wrapper

**Azure Monitor** (`src/integrations/azure-monitor.ts`)
- `runKqlQuery(config: AzureMonitorConfig, kql, timespan?)` — REST API KQL query, returns `Record<string, unknown>[]`
- Requires `AZURE_MONITOR_WORKSPACE_ID` env var or gracefully returns `[]`

**Daemon** (`src/daemon/daemon.ts`)
- `ALL_PRODUCERS` array and `PRODUCER_MAP` in `cli.ts` list all five producers
- Producer schedulers: 5 `Scheduler` instances, default 15min interval (`HIVE_PRODUCER_INTERVAL_MS`)
- `HIVE_DAEMON_USER_ID` env var (default "1") — validated before use

**CLI** (`src/cli.ts`)
- `run <producer-name>` sub-command for manual one-shot runs
- `--repo <repoId>` flag or `HIVE_DEFAULT_REPO_ID` env var

### Dashboard Architecture Patterns

1. **Route files** at `src/dashboard/routes/<name>.ts` — Express Router with `requireAuth`, export default Router
2. **View files** at `src/dashboard/views/<name>.ts` — pure functions returning HTML strings, import `layout` and `components`
3. **Register in `src/dashboard/server.ts`** — import router and `app.use("/", router)`
4. **Sidebar nav links** already exist in `layout.ts` for Costs, Producers, Hivemind, Settings (currently 404)
5. **Components** in `components.ts`: `escapeHtml`, `button`, `badge`, `card`, `statusBadge`, `statCard`, `table`, `input`, `textarea`, `select`, `modal`, `emptyState`, `pipelineSteps`
6. **HTMX patterns**: `HX-Trigger` header for toasts, `hx-trigger="every Ns"` for polling, partials for HTMX swaps
7. **Auth**: `requireAuth` for all routes, `requireRole("admin")` for write operations

### Database Tables Ready

- `producer_runs` — fully migrated, queries in `src/db/queries/producer-runs.ts`
- `costs` — has indexes on `(userId, createdAt)`, `taskId`, `createdAt`; existing queries: `recordCost`, `getTodayTotal`, `checkBudget`
- `global_config` — key-value store; `getConfig(key)` / `setConfig(key, value)` in `src/domain/config.ts`
- `repos.settings` — jsonb column for per-repo overrides

### Test Patterns

- 346 tests across 35 files, all passing
- TRUNCATE list in `tests/setup.ts` includes `producer_runs`
- DB tests use `useTestDb()` + `cleanupTables()`
- Numeric columns from pg are strings — always `parseFloat()`

---

## 2. Suggested Amendments to Milestone 7

### Existing Files Need Updates (Not New Files)

1. **`src/db/queries/repos.ts`** — needs `updateSettings(repoId, settings)` function added
2. **`src/db/queries/costs.ts`** — needs aggregation queries: `getDailyTotals`, `getBreakdownByUser/Repo/Model/Agent`, `getMonthlyTotals`
3. **`src/dashboard/server.ts`** — needs new router registrations for costs, settings, producers, prompts

### `src/prompts.ts` Must Target `prompts/` at Project Root

The prompts directory is `/home/ewi/repos/orcha-clones/hive/prompts/` (not `src/prompts/`). Has nested `enrichers/` subdirectory. Use `path.resolve("prompts")`.

### Producer Config via `global_config`

There is no per-producer config table. Use `global_config` with keys like `producer:log-scanner:config` via existing `getConfig`/`setConfig` helpers.

### Cost Sparklines

Recommend inline SVG paths generated server-side to stay consistent with zero-JS-framework architecture.

### Prompt Editor Safety

- Use `requireRole("admin")` for write operations
- Validate filenames stay within `prompts/` directory (path traversal prevention)
- Only allow `.md` files

### Gotchas

- `costs.repo` is nullable text (not FK to repos) — handle NULLs when grouping
- `producer_runs.errors` is jsonb array — parse as `string[]`
- `autonomous.config.yaml` is file-based — settings page should display as read-only or provide write + `reloadConfig()`
