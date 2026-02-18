# Milestone 2 Handoff Report

## 1. Context for Milestone 3

### Database: All tables are ready

The full schema in `src/db/schema.ts` already defines every table Milestone 3 needs:

- **`enrichmentRuns`** — `id`, `taskId`, `enricher`, `status`, `result` (jsonb), `costUsd`, `durationMs`, `error`, `createdAt`. Indexed on `taskId`.
- **`costs`** — `id`, `taskId`, `userId`, `agent`, `model`, `repo`, `costUsd`, `turns`, `durationMs`, `createdAt`. Indexed on `(userId, createdAt)`, `(taskId)`, `(createdAt)`.
- **`gateDecisions`** — `id`, `taskId`, `verdict`, `source`, `decidedBy`, `reasoning`, `taskContext` (jsonb), `createdAt`.
- **`activeAgents`** — `taskId` (PK), `agent`, `model`, `phase`, `startedAt`.
- **`tasks`** — Has `enrichment` (jsonb), `gateVerdict`, `gateReasoning`, `size`, `type`, `workflow`, `model`, `maxTurns`, `maxBudgetUsd` columns.
- **`users`** — Has `dailyBudget` column (numeric, defaults to "100.00").
- **`globalConfig`** — Key-value config store for classification/gate/enricher/budget settings.

Important: `numeric` columns come back as strings from pg driver. Always `parseFloat()` them.

### Task queries: `src/db/queries/tasks.ts`

Exports: `create(data)`, `getById(id)`, `list(filters, limit?, offset?)` returns `{tasks, total}`, `updateStatus(id, newStatus, userId?)`, `countByStatus()`.

**Note:** No general `update()` function exists — only `updateStatus`. M3 needs to add field updaters for classification/enrichment/gate fields.

### State machine: `src/domain/state-machine.ts`

Exports: `ALLOWED_TRANSITIONS`, `canTransition(from, to)`, `getAvailableActions(status)` returns `{action, targetStatus, label}[]`.

Pipeline flow: `pending -> queued -> enriching -> ready -> (gate) -> approved -> executing`.

### Domain types: `src/domain/types.ts`

Exports: `SessionUser`, `TaskStatus` (13 states incl. `APPROVED`), `TaskType`, `TaskSize`, `Workflow`, `generateTaskId()`, `TaskFilters`.

### Config: `src/domain/config.ts`

Exports `getConfig(key)` and `setConfig(key, value)` for global_config table. No YAML parser installed. No 3-layer merge implemented.

### Vault: `src/vault/keyvault.ts`

Exports: `getSecret(name)`, `setSecret(name, value)`, `deleteSecret(name)`, `userSecretName(userId, provider, label)`. Falls back to in-memory Map when no `AZURE_KEYVAULT_URI`.

### Repo queries: `src/db/queries/repos.ts`

Exports: `findOrCreate(provider, fullName, defaultBranch?)`, `getById(id)`, `listAll()`. Repos table has `settings` jsonb for per-repo overrides.

### Route mounting pattern

Routes mount as `app.use("/", router)` in `src/dashboard/server.ts`. Currently mounts dashboardRouter, taskRouter, profileRouter.

Human gate actions: existing `POST /api/tasks/:id/transition` accepts `{targetStatus}` and validates via state machine. Already wired to UI buttons.

### HTMX toast pattern

```ts
res.setHeader("HX-Trigger", JSON.stringify({
  showToast: { message: "...", type: "success" | "error" | "info" }
}));
```

### Test setup: `tests/setup.ts`

`cleanupTables()` truncates `users, sessions, tasks, repos CASCADE`. DB tests mock `../../src/db/connection.js`.

### ESM conventions

All imports use `.js` extensions. `"module": "NodeNext"` in tsconfig, `"type": "module"` in package.json.

### What doesn't exist yet

- `@anthropic-ai/sdk` package not installed
- `yaml` package not installed
- No `prompts/` directory
- No `autonomous.config.yaml`
- No `cli.ts`
- No `src/agents/` directory

---

## 2. Suggested Amendments to Milestone 3

### Amendment 1: Add general `update()` to task queries
Current `tasks.ts` only has `updateStatus()`. Router needs to set `size/type/model/workflow/maxTurns/maxBudgetUsd`. Enricher needs to set `enrichment`. Gate needs `gateVerdict/gateReasoning`. Add `updateClassification()` and `updateEnrichment()` helpers.

### Amendment 2: Install missing npm packages
Add `@anthropic-ai/sdk` and `yaml` to package.json.

### Amendment 3: Human gate routes already exist — do not duplicate
Blueprint lists `POST /api/tasks/:id/approve, /reject, /rework` as new. The existing `POST /api/tasks/:id/transition` already handles this. Instead, add gate decision recording (insert into gate_decisions) when transitioning `ready -> approved/rejected`.

### Amendment 4: Extend `cleanupTables()` in test setup
Add `enrichment_runs, costs, gate_decisions, active_agents` to the TRUNCATE statement.

### Amendment 5: Add `approved` and `rework` to statusBadge color map
In `components.ts`, statusBadge() is missing these statuses. Add `approved: "emerald"`, `rework: "amber"`.

### Amendment 6: Dashboard already queries active_agents
`routes/dashboard.ts` already does `db.select().from(activeAgents)` and renders them. No dashboard route changes needed.

### Amendment 7: Config needs 3-layer merge or simplified approach
Current config.ts only does DB reads. Either install `yaml` and implement full merge, or seed `global_config` with defaults at startup and skip YAML layer.

### Amendment 8: No CLI exists yet
Verification references `npm run cli -- triage/enrich`. Either create a minimal CLI or adjust verification to use programmatic tests.
