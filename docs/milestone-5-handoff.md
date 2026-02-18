# Milestone 5 Handoff: Daemon Orchestration

## 1. Context for Milestone 6

### Key Exports and Files

**Scheduler** (`src/daemon/scheduler.ts`)
- `Scheduler` class: `constructor(intervalMs, tick: () => Promise<void>)`, `start()`, `stop()`
- Built-in mutual exclusion (skips overlapping ticks)
- Producers should each get their own `Scheduler` instance, wired inside `Daemon.start()`

**Daemon** (`src/daemon/daemon.ts`)
- `Daemon` class with `start()` / `stop()` lifecycle
- Integration point: add producer schedulers alongside the task poll scheduler
- Producers should be started/stopped in `Daemon.start()`/`Daemon.stop()`, same graceful drain pattern

**Task creation** (`src/db/queries/tasks.ts`)
- `create({ title, body, source, type, size, workflow, repoId, createdBy })` — status defaults to "pending"
- Producers use `source` field: `"producer:bug-hunter"`, `"producer:log-scanner"`, etc.
- `list({ status }, limit)` — use for dedup checks

**`producer_runs` table** — Already defined and migrated in schema. `src/db/queries/producer-runs.ts` needs to be written.

**Repos** (`src/db/queries/repos.ts`)
- `findOrCreate(provider, fullName, defaultBranch?)` — returns `{ id, provider, fullName, settings }`
- `settings` JSONB column holds per-repo overrides (enabled producers, scan schedules)

**AI client** (`src/agents/sdk.ts`)
- `callClaude({ prompt, model?, systemPrompt?, dryRun? })` — returns `{ text, cost }`

**Config** (`src/domain/autonomous-config.ts`)
- `getAutonomousConfig()` — models, budget, enricher settings

**Vault** (`src/vault/keyvault.ts`)
- `getSecret(name)`, `setSecret(name, value)` — for notification webhook URLs

### Patterns to Follow

1. DB modules in `src/db/queries/<noun>.ts` — plain async functions, no classes
2. All numeric columns from pg come back as strings — always `parseFloat()`
3. `source` field on tasks identifies origin: `"producer:<name>"`
4. Errors are caught and logged, never thrown out of producer `run()` methods
5. Module imports use `.js` extension (ESM project)
6. Costs recorded per agent call via `recordCost()`

### Database Tables Ready

- `producer_runs` — fully migrated
- `tasks.source` — dedup anchor
- `repos.settings` — per-repo producer config
- `global_config` — producer schedules / enable flags

---

## 2. Suggested Amendments to Milestone 6

### `src/daemon/scheduler.ts` — Already Built
No changes needed. Add `private producerSchedulers: Scheduler[]` inside Daemon, start in `start()`, stop in `stop()`.

### `src/notifications.ts` — Store Webhooks in Key Vault
Use `src/vault/keyvault.ts` pattern: `getSecret("hive-slack-webhook")`. In-memory fallback works for dev. Env vars are acceptable as secondary fallback.

### `src/producers/self-monitor.ts` — Query DB, Not Logs
Pino writes to stdout; no log files on disk. Query the DB instead: count `tasks` by `status = 'failed'` in last hour, check `producer_runs.errors`, check `costs` for budget overruns.

### `src/producers/base.ts` — Dedup Strategy
Before creating a task, query `tasks` where `source = 'producer:<name>'` AND `title` matches AND `status NOT IN ('failed', 'cancelled', 'merged', 'done')`. If found, skip and increment `duplicatesSkipped`.

### `src/integrations/azure-monitor.ts` — Check Dependencies
Confirm `@azure/monitor-query` is in `package.json` before starting — it may not be installed.

### Test Setup — Update TRUNCATE List
`tests/setup.ts` `cleanupTables()` must include `producer_runs` in the TRUNCATE list, or tests will have isolation failures.
