# Database Module

> **Location:** `src/db/`
> **Purpose:** Owns all PostgreSQL persistence for The Hive — schema definition, connection management, migration execution, and query helpers organised per domain entity.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [Connection — `connection.ts`](#connection--connectionts)
3. [Schema — `schema.ts`](#schema--schemats)
   - [Table Reference](#table-reference)
   - [Table Details](#table-details)
4. [Migration System — `migrate.ts`](#migration-system--migratets)
5. [Query Layer — `queries/`](#query-layer--queries)
   - [tasks.ts](#tasksts)
   - [repos.ts](#reposts)
   - [users.ts](#usersts)
   - [costs.ts](#coststs)
   - [active-agents.ts](#active-agentsts)
   - [task-events.ts](#task-eventsts)
   - [enrichment-runs.ts](#enrichment-runsts)
   - [producer-runs.ts](#producer-runsts)
   - [gate-decisions.ts](#gate-decisionsts)
   - [code-reviews.ts](#code-reviewsts)
   - [learnings.ts](#learningsts)
   - [learning-events.ts](#learning-eventsts)
   - [preview-instances.ts](#preview-instancests)
   - [preview-logs.ts](#preview-logsts)
6. [Schema–Domain Type Mapping](#schemadomain-type-mapping)
7. [Data Access Patterns](#data-access-patterns)
8. [Multi-User Isolation and Access Control](#multi-user-isolation-and-access-control)
9. [Indexes and Query Performance](#indexes-and-query-performance)
10. [Common Operational Queries](#common-operational-queries)

---

## Module Overview

The database module is the single source of truth for all persisted state in The Hive. It is built on three layers:

| Layer | Files | Responsibility |
|---|---|---|
| **Connection** | `connection.ts` | Singleton `pg.Pool` + Drizzle ORM client |
| **Schema** | `schema.ts` | Table definitions, constraints, indexes, and inferred TypeScript row types |
| **Queries** | `queries/*.ts` | Domain-focused query helpers exported by entity |

All application code accesses the database exclusively through the query helpers — no raw SQL or direct schema imports appear outside this module (except for `InferSelectModel` row types).

### File Map

```
src/db/
├── connection.ts          # Pool + db singleton
├── schema.ts              # All table definitions + row type exports
├── migrate.ts             # Drizzle migrator with journal reading
└── queries/
    ├── tasks.ts           # CRUD, status transitions, filtering
    ├── repos.ts           # upsertRepo, getById, settings
    ├── users.ts           # upsertUser, role management, daily-budget
    ├── costs.ts           # recordCost, aggregates, budget checks
    ├── active-agents.ts   # register, heartbeat, unregister, cleanupStale
    ├── task-events.ts     # addEvent, listEvents
    ├── enrichment-runs.ts # recordRun, getLatest
    ├── producer-runs.ts   # recordRun, listRecent
    ├── gate-decisions.ts  # recordDecision, getLatest
    ├── code-reviews.ts    # recordReview, getLatestForTask
    ├── learnings.ts       # CRUD, retrieval, decay, curation helpers
    ├── learning-events.ts # recordEvent, listForLearning
    ├── preview-instances.ts # read-only join for preview dashboard data
    └── preview-logs.ts    # appendLog, getLogs
```

---

## Connection — `connection.ts`

```ts
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db   = drizzle(pool, { schema });
```

### Key Points

- **`DATABASE_URL`** is validated at module load time. The process fails fast (during import) if the variable is missing, rather than failing on the first query.
- **`pool`** is exported separately so `migrate.ts` can end the pool after migrations complete, without importing the full Drizzle client.
- **`db`** is the Drizzle client — the only way query helpers access PostgreSQL. It is passed the full schema so Drizzle's relational query API (`.query.*`) is available, although most queries use the `db.select()` / `db.update()` builder style.
- The `Pool` uses `pg`'s default settings (10 connections). Connection limits are not tuned in code; production sizing is handled via the `DATABASE_URL` and container environment.

### TypeScript Consideration

The `pg` package is imported as a CommonJS default export (`import pg from "pg"`) with `const { Pool } = pg`. This pattern is necessary because the `pg` package does not have fully ESM-compatible named exports.

---

## Schema — `schema.ts`

Drizzle's `pgTable` factory is used for every table. All timestamps use `{ withTimezone: true }` (stored as `timestamptz` in PostgreSQL), captured via the shared `const tz` constant.

### Table Reference

| Table | PK type | FK relationships | Purpose |
|---|---|---|---|
| `users` | `serial` | — | Application users (Entra ID–backed) |
| `user_credentials` | `serial` | `users.id` | Per-provider git token references (Key Vault) |
| `repos` | `serial` | — | Registered git repositories |
| `tasks` | `text` (HIVE-YYYYMMDD-XXXX) | `users.id` × 2, `repos.id` | Core task entity |
| `costs` | `serial` | `tasks.id`, `users.id` | Per-agent cost ledger entries |
| `gate_decisions` | `serial` | `tasks.id`, `users.id` | AI gate + human approval records |
| `code_reviews` | `serial` | `tasks.id` | Automated code review results |
| `active_agents` | `text` (task_id) | `tasks.id` | Live agent heartbeats |
| `task_events` | `serial` | `tasks.id` | Append-only task activity timeline |
| `enrichment_runs` | `serial` | `tasks.id` | Per-enricher execution records |
| `producer_runs` | `serial` | — | Per-producer scheduled-run records |
| `preview_logs` | `serial` | `tasks.id` | Preview environment log lines |
| `learnings` | `serial` | — | Knowledge-base entries (confidence-weighted) |
| `learning_events` | `serial` | `learnings.id`, `tasks.id` | Audit trail for learning mutations |
| `user_repo_access` | `serial` | `users.id` × 3, `repos.id` | Explicit repo access grants |
| `sessions` | `text` (sid) | — | Express session store (connect-pg-simple) |
| `global_config` | `text` (key) | — | Key/value store for system config |

### Table Details

#### `users`

```ts
export const users = pgTable("users", {
  id:          serial("id").primaryKey(),
  entraOid:    text("entra_oid").unique().notNull(),
  email:       text("email").unique().notNull(),
  displayName: text("display_name").notNull(),
  role:        text("role").notNull().default("user"),   // "user" | "admin"
  dailyBudget: numeric("daily_budget", { precision: 10, scale: 2 }).default("100.00"),
  createdAt:   timestamp("created_at", tz).defaultNow(),
  updatedAt:   timestamp("updated_at", tz).defaultNow(),
});
```

`entraOid` is the Microsoft Entra (Azure AD) Object ID — the stable identifier used to upsert users on every login. `role` controls dashboard permissions (admin can manage all repos, view all tasks). `dailyBudget` enforces per-user AI spend limits checked on every task dispatch.

#### `user_credentials`

```ts
export const userCredentials = pgTable("user_credentials", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => users.id),
  provider:      text("provider").notNull(),            // "github" | "ado"
  vaultSecretId: text("vault_secret_id").notNull(),     // Azure Key Vault secret URI
  label:         text("label").default("default"),
  createdAt:     timestamp("created_at", tz).defaultNow(),
}, (t) => [unique().on(t.userId, t.provider, t.label)]);
```

Git credentials are **never stored in the database**. Only the Key Vault secret URI (or name) is stored; the actual token is fetched from Azure Key Vault at runtime. The `(userId, provider, label)` unique constraint ensures one credential set per user per provider per label.

#### `repos`

```ts
export const repos = pgTable("repos", {
  id:            serial("id").primaryKey(),
  provider:      text("provider").notNull(),     // "github" | "ado"
  fullName:      text("full_name").notNull(),    // "org/repo"
  defaultBranch: text("default_branch").default("main"),
  settings:      jsonb("settings").notNull().default({}),
  createdAt:     timestamp("created_at", tz).defaultNow(),
  updatedAt:     timestamp("updated_at", tz).defaultNow(),
}, (t) => [unique().on(t.provider, t.fullName)]);
```

`settings` is a flexible JSONB bag for repo-level configuration — producer opt-ins, preview TTL overrides, documentation settings. Key known sub-keys:

```json
{
  "producers": {
    "log-scanner":  { "enabled": true },
    "doc-auditor":  { "enabled": false }
  },
  "preview": {
    "cleanup_timeout_minutes": 60
  },
  "docs": {
    "enabled": true
  }
}
```

#### `tasks`

The primary domain entity. Notable columns:

| Column | Type | Purpose |
|---|---|---|
| `id` | `text` | Generated as `HIVE-YYYYMMDD-XXXX` |
| `status` | `text` | One of 14 `TaskStatus` values |
| `source` | `text` | `"user"` \| `"producer:name"` |
| `type` | `text` | `TaskType` enum value |
| `severity` | `text` | Enricher-assigned risk level |
| `size` | `text` | `TaskSize` enum value |
| `workflow` | `text` | `"flow"` \| `"epic"` |
| `enrichment` | `jsonb` | Full enricher output (structured context) |
| `gateVerdict` | `text` | `"approve"` \| `"reject"` |
| `reworkHistory` | `jsonb` | Array of rework instruction objects |
| `retryInstructions` | `text` | Human-provided rework guidance |
| `epicId` | `text` | Links milestone tasks to their parent epic |
| `milestoneIndex` / `milestoneTotal` | `integer` | Position in an epic milestone sequence |
| `blueprint` | `text` | Epic blueprint text (only on epic tasks) |
| `previewPort` / `previewStatus` / `previewUrl` | — | Preview environment tracking |
| `worktreePath` / `worktreeBaseSha` | `text` | Git worktree on disk (persisted across restarts) |
| `suspendedFrom` | `text` | Status before graceful-shutdown suspension |
| `completedMilestones` | `integer` | Count of finished milestones in an epic |
| `visibility` | `text` | `"public"` \| `"private"` |

#### `costs`

Each agent invocation records one row here. The `agent` column identifies the pipeline stage (`"enricher"`, `"gate"`, `"executor"`, `"reviewer"`, etc.). Budget enforcement (`checkBudget`) queries this table aggregating `costUsd` for the current calendar day.

#### `active_agents`

```ts
export const activeAgents = pgTable("active_agents", {
  taskId:          text("task_id").primaryKey().references(() => tasks.id),
  agent:           text("agent").notNull(),
  model:           text("model").notNull(),
  phase:           text("phase"),
  startedAt:       timestamp("started_at", tz).defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", tz).defaultNow(),
});
```

One row per live task, keyed on `taskId` (not `serial`). This makes upsert-and-update patterns natural and avoids orphan rows for tasks that are re-dispatched. `lastHeartbeatAt` is updated by the execution loop every N seconds; a stale heartbeat signals a crashed agent.

#### `learnings`

The knowledge-base table supporting the confidence-weighted learning system:

| Column | Purpose |
|---|---|
| `scope` | Hierarchical scope string (e.g., `"org/repo"`, `"global"`) |
| `category` | Topic label (`"testing"`, `"architecture"`, `"security"`, …) |
| `content` | Human-readable learning text |
| `confidence` | `numeric(3,2)` in [0.00, 1.00]; starts at 0.50 |
| `reinforcements` | Times an agent confirmed this learning |
| `contradictions` | Times an agent contradicted this learning |
| `sourceTaskIds` | `text[]` of tasks that informed this learning |
| `tags` | `text[]` for overlap-based retrieval |
| `supersededBy` | `integer` FK to newer learning, or `-1` (archived sentinel) |
| `dismissedAt` / `dismissedBy` | Set when an admin manually dismisses the learning |

Three GIN/B-tree indexes support fast retrieval: `scope`, `tags` (GIN for `&&` overlap queries), and `confidence`.

#### `global_config`

```ts
export const globalConfig = pgTable("global_config", {
  key:       text("key").primaryKey(),
  value:     jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", tz).defaultNow(),
});
```

A simple key-value store for system-wide state that needs to survive restarts. Currently used to track `lastRetrospectiveRun` and `lastDecayRun` timestamps, and to persist `autonomous.config.yaml` overrides made through the dashboard.

#### `sessions`

Managed by `connect-pg-simple`. The schema matches the library's expected column layout: `sid` (primary key), `sess` (JSONB session blob), `expire` (timestamp for TTL expiry). Never queried directly by application code.

---

## Migration System — `migrate.ts`

Migrations are SQL files generated by `drizzle-kit generate` and stored in `drizzle/`. They are executed automatically on application startup before the HTTP server and daemon are initialised.

### Migration File Naming

```
drizzle/
├── 0000_jazzy_nuke.sql           # Initial schema
├── 0001_oval_calypso.sql         # task_events table
├── 0002_warm_black_tom.sql       # tasks.suspended_from column
├── 0003_task_visibility.sql      # tasks.visibility column + index
├── 0004_user_repo_access.sql     # user_repo_access table
├── 0005_rich_chat.sql            # learnings.dismissed_at/by columns
├── 0006_dark_william_stryker.sql # tasks.preview_url column
├── 0007_gifted_starfox.sql       # tasks.skip_preview column
├── 0008_worktree_persistence.sql # tasks.worktree_path / worktree_base_sha
├── 0009_milestone_resume.sql     # tasks.completed_milestones column
└── 0010_max_rework_cycles.sql    # tasks.max_rework_cycles column
```

Files use `drizzle-kit`'s default naming convention: sequential 4-digit prefix + random slug. The production-safe names (`0003_task_visibility.sql`, `0004_user_repo_access.sql`, etc.) were written manually for clarity.

### Migration Runner

```ts
export async function migrate(): Promise<void>
```

`migrate.ts` reads the Drizzle migration journal (`drizzle/meta/_journal.json`) before delegating to Drizzle's built-in migrator:

```ts
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf-8"));
const entries = journal.entries as { idx: number; tag: string; when: number }[];
logger.info({ count: entries.length }, "DB: running migrations");

await drizzleMigrate(db, { migrationsFolder: "drizzle" });
```

The journal is read for logging purposes (reports the count of pending migrations). Actual migration tracking is handled by Drizzle's internal `__drizzle_migrations` table in PostgreSQL.

After migrations, the pool is **not** closed here — `migrate.ts` does not call `pool.end()`. The connection is reused by the application.

### Adding a New Migration

```bash
# 1. Edit src/db/schema.ts
# 2. Generate the SQL diff
npx drizzle-kit generate

# 3. Review the generated file in drizzle/
# 4. Apply on next application startup (automatic)
```

Never edit existing migration files after they have been applied to any environment. Always add a new migration file for schema changes.

### Drizzle Kit Configuration

```ts
// drizzle.config.ts
export default defineConfig({
  schema:      "./src/db/schema.ts",
  out:         "./drizzle",
  dialect:     "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

---

## Query Layer — `queries/`

Each file exports a set of focused, named async functions for one entity. Functions do not expose raw Drizzle query builders — callers receive plain TypeScript values (row objects or primitives). This isolates Drizzle from the rest of the codebase and makes mocking straightforward in tests.

### `tasks.ts`

The most complex query file. Key exports:

| Function | Signature | Description |
|---|---|---|
| `createTask` | `(data) → Task` | Insert with generated ID via `generateTaskId()` |
| `getTask` | `(id) → Task \| undefined` | Full row fetch by primary key |
| `list` | `(filters, limit?) → Task[]` | Filtered list with visibility guard |
| `updateStatus` | `(id, status) → void` | Status transition + `updatedAt` bump |
| `suspendTask` | `(id, fromStatus) → void` | Sets `status="suspended"`, records `suspendedFrom` |
| `findSuspended` | `() → Task[]` | Returns all tasks with `status="suspended"` |
| `updateTask` | `(id, patch) → Task` | Partial update (enrichment, prUrl, etc.) |
| `cancelTask` | `(id) → void` | Sets `status="cancelled"` |
| `deleteTask` | `(id) → void` | Hard delete (cascades to child rows) |
| `getTaskCount` | `(filters) → number` | Aggregate count for pagination |

#### `list()` Filter Behaviour

```ts
export async function list(
  filters: TaskFilters,
  limit = 50,
): Promise<Task[]>
```

Filters are applied using `and(...conditions)`. Conditions are built conditionally — only non-undefined filter values add a clause. Supported filters:

| Filter field | SQL clause |
|---|---|
| `status` | `eq(tasks.status, status)` |
| `statuses` | `inArray(tasks.status, statuses)` |
| `repoId` | `eq(tasks.repoId, repoId)` |
| `createdBy` | `eq(tasks.createdBy, createdBy)` |
| `search` | `ilike(tasks.title, '%term%')` OR `ilike(tasks.body, '%term%')` |
| `visibility` | `eq(tasks.visibility, visibility)` |

Results are ordered by `createdAt DESC`.

#### Visibility Enforcement

The `list()` function does not automatically filter by `visibility` unless the caller passes `visibility` in the filters. Visibility enforcement is the responsibility of the route handler, which reads the user's session and applies the appropriate filter:

```ts
// In a route handler (dashboard API):
const filters: TaskFilters = {
  ...(user.role !== "admin" && { visibility: "public" }),
  // or for private tasks: createdBy: user.id
};
const tasks = await list(filters);
```

Private tasks are only visible to their creator and admins. See [Multi-User Isolation](#multi-user-isolation-and-access-control).

---

### `repos.ts`

| Function | Description |
|---|---|
| `upsertRepo(data)` | `INSERT … ON CONFLICT (provider, full_name) DO UPDATE SET … RETURNING` |
| `getRepoById(id)` | Select by primary key |
| `getRepoByFullName(provider, fullName)` | Select by natural key |
| `updateRepoSettings(id, settings)` | JSONB replace of the `settings` column |
| `listRepos()` | All repos ordered by `full_name` |

`upsertRepo` is the standard entry point when a task is created: the dashboard ensures the target repo exists (creating it if needed) before inserting the task.

---

### `users.ts`

| Function | Description |
|---|---|
| `upsertUser(entraOid, email, displayName)` | Insert-or-update on login; returns existing or created user |
| `getUserById(id)` | Select by PK |
| `getUserByOid(oid)` | Select by Entra OID |
| `listUsers()` | All users (admin panel) |
| `updateUserRole(id, role)` | Admin: promote/demote |
| `updateUserBudget(id, dailyBudget)` | Admin: set per-user spend limit |

`upsertUser` uses a PostgreSQL `ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()` pattern, keeping the user record in sync with their Entra profile on every login.

---

### `costs.ts`

| Function | Description |
|---|---|
| `recordCost(data)` | Insert one cost row; returns inserted row |
| `checkBudget(userId)` | Returns remaining daily budget in USD |
| `getCostsByTask(taskId)` | All cost rows for a task |
| `getCostSummary(opts)` | Aggregated costs (by user, date range, etc.) |
| `getDailyCosts(userId, days)` | Per-day spend for the past N days |

#### Budget Check

```ts
export async function checkBudget(userId: number): Promise<number>
```

Queries the sum of `cost_usd` for the user's cost rows whose `created_at` is within the current calendar day (UTC). Returns `user.daily_budget - sum`, clamped to 0 if overspent. The query joins `users` to read `daily_budget` in a single round-trip:

```sql
SELECT u.daily_budget - COALESCE(SUM(c.cost_usd), 0) AS remaining
FROM   users u
LEFT   JOIN costs c ON c.user_id = u.id
  AND  c.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
WHERE  u.id = $1
GROUP  BY u.daily_budget
```

---

### `active-agents.ts`

| Function | Description |
|---|---|
| `registerAgent(taskId, agent, model, phase?)` | Upsert one row (one agent per task) |
| `heartbeat(taskId)` | UPDATE `last_heartbeat_at = now()` |
| `unregisterAgent(taskId)` | DELETE the row for this task |
| `getActiveAgents()` | All rows (for the status dashboard endpoint) |
| `cleanupStale(thresholdMs)` | DELETE rows where `last_heartbeat_at < now() - threshold` |

The upsert in `registerAgent` uses `ON CONFLICT (task_id) DO UPDATE` — re-using the same row when a task is re-dispatched (e.g., after rework).

---

### `task-events.ts`

| Function | Description |
|---|---|
| `addEvent(taskId, event, agent, message, metadata?)` | INSERT one event row |
| `getEvents(taskId)` | All events for a task, ordered by `created_at ASC` |

Event rows are **never updated or deleted** — they form an append-only audit trail. The `event` column is a free-form string label (e.g., `"started"`, `"enriched"`, `"approved"`, `"executed"`, `"reviewed"`, `"pr_opened"`, `"failed"`, `"suspended"`, `"resumed"`, `"budget_exhausted"`).

---

### `enrichment-runs.ts`

| Function | Description |
|---|---|
| `recordRun(data)` | INSERT one enrichment-run row |
| `getRunsForTask(taskId)` | All enrichment runs for a task, ordered by `created_at ASC` |
| `getLatestRunForEnricher(taskId, enricher)` | Most recent run for a specific enricher |

`status` values: `"success"` | `"failed"` | `"skipped"`. `result` is the enricher's structured JSONB output.

---

### `producer-runs.ts`

| Function | Description |
|---|---|
| `recordRun(data)` | INSERT one producer-run row; returns row |
| `listRecent(limit?)` | Ordered by `created_at DESC`; feeds the dashboard panel |

Unlike `enrichment_runs`, producer runs are not tied to a specific task — a single run may create zero or more tasks.

---

### `gate-decisions.ts`

| Function | Description |
|---|---|
| `recordDecision(data)` | INSERT one gate-decision row |
| `getLatestForTask(taskId)` | Most recent gate decision for a task |
| `listForTask(taskId)` | All decisions (AI + human) for audit view |

`source` values: `"ai"` (automated gate) | `"human"` (dashboard approval/rejection). `decidedBy` is `NULL` for AI decisions, and a `users.id` FK for human ones.

---

### `code-reviews.ts`

| Function | Description |
|---|---|
| `recordReview(data)` | INSERT one code-review row |
| `getLatestForTask(taskId)` | Most recent review (highest `rework_cycle`) |
| `listForTask(taskId)` | All review results across rework cycles |

`verdict` values: `"pass"` | `"rework"` | `"fail"`. `findings` and `securityFindings` are JSONB arrays of structured finding objects (see `ReviewFinding` / `SecurityFinding` in `src/domain/types.ts`).

---

### `learnings.ts`

The most feature-rich query file, supporting the full lifecycle of knowledge-base entries.

| Function | Description |
|---|---|
| `createLearning(data)` | INSERT with optional confidence, tags, sourceTaskIds |
| `getLearningById(id)` | Select by PK |
| `retrieveRelevantLearnings(opts)` | Scope + tag overlap query, sorted by confidence; updates `last_used_at` |
| `reinforceLearning(id, taskId)` | `reinforcements += 1`, `confidence += 0.05` (cap 1.0) |
| `contradictLearning(id, taskId, amount?)` | `contradictions += 1`, `confidence -= amount` (floor 0.0) |
| `supersedeLearning(oldId, newId)` | Set `superseded_by` on old learning |
| `applyMonthlyDecay()` | Multiply `confidence * 0.95` for unused learnings; return count |
| `archiveStale()` | Set `superseded_by = -1` for low-confidence, unused learnings |
| `dismissLearning(id, userId)` | Admin dismiss: set `dismissed_at/by`, `superseded_by = -1` |
| `getDismissedLearnings(limit?)` | Dismissed learnings for admin UI |
| `buildDismissedContext()` | Text block of dismissed learnings for prompt injection |
| `listLearnings(opts)` | Paginated list with scope/category/confidence filters |
| `getLearningStats()` | Dashboard aggregate: total, active, archived, dismissed, avg confidence |

#### Retrieval Query

`retrieveRelevantLearnings` is the primary read path for agents injecting context into prompts:

```ts
// Scope hierarchy: specific repo first, then global
const rows = await retrieveRelevantLearnings({
  scopes: ["github/org/repo", "global"],
  tags:   ["typescript", "testing"],
  limit:  15,
});
```

The query uses PostgreSQL array overlap (`&&`) for tag matching and orders by `(confidence DESC, reinforcements DESC)`. `last_used_at` is updated in a separate `UPDATE` after the `SELECT` — the two operations are **not** wrapped in a transaction, so `last_used_at` may lag slightly under high concurrency, which is acceptable for this use case.

#### Archival Sentinel

`superseded_by = -1` is used as a self-archival sentinel (no FK constraint exists on this column). Both `archiveStale()` and `dismissLearning()` set this value. `retrieveRelevantLearnings` excludes rows where `superseded_by IS NOT NULL`, which covers both superseded (positive FK) and archived/dismissed (-1) states.

---

### `learning-events.ts`

| Function | Description |
|---|---|
| `recordEvent(data)` | INSERT one learning-event row |
| `listForLearning(learningId, limit?)` | Ordered by `created_at DESC` |

`event_type` values: `"created"`, `"reinforced"`, `"contradicted"`, `"superseded"`, `"archived"`, `"dismissed"`.

---

### `preview-instances.ts`

A read-only query file — no `INSERT` or `UPDATE`. Provides a JOIN view of tasks and repos for the preview-instances dashboard panel:

```ts
export interface PreviewInstanceRow {
  taskId:      string;
  title:       string;
  repoFullName: string;
  previewPort: number | null;
  previewStatus: string | null;
  previewUrl:  string | null;
  previewStartedAt: Date | null;
}

export async function listPreviewInstances(): Promise<PreviewInstanceRow[]>
```

Returns all tasks with a non-null `preview_port`, joined to their repo name. Used by the dashboard's `/api/previews` endpoint.

---

### `preview-logs.ts`

| Function | Description |
|---|---|
| `appendLog(taskId, source, message)` | INSERT one preview-log row |
| `getLogsForTask(taskId, limit?)` | Ordered by `created_at ASC`; streamed to dashboard UI |

`source` values: `"stdout"` | `"stderr"` | `"system"`.

---

## Schema–Domain Type Mapping

`schema.ts` exports an `InferSelectModel`-derived row type for each table. These are the raw database representations. The domain layer (`src/domain/types.ts`) defines richer TypeScript types used throughout the application:

| Schema export | Domain equivalent | Notes |
|---|---|---|
| `TaskRow` | `Task` (from `tasks.ts` query return) | Same shape; query helpers return `TaskRow` directly |
| `RepoRow` | Used directly | No domain wrapper needed |
| `CodeReviewRow` | `ReviewGateResult` | `ReviewGateResult` is the agent output type; `CodeReviewRow` is the persisted form |
| `ActiveAgentRow` | No domain type | Used directly from schema export |
| `TaskEventRow` | No domain type | Used directly |
| `LearningRow` | No domain type | Used directly |
| `LearningEventRow` | No domain type | Used directly |
| `UserCredentialRow` | No domain type | Used directly |
| `UserRepoAccessRow` | No domain type | Used directly |
| `EnrichmentRunRow` | No domain type | Used directly |

**Key distinction:** `ReviewGateResult` (in `domain/types.ts`) is the in-memory result produced by the code-review agent. `CodeReviewRow` is what gets persisted — the agent serialises its structured findings into JSONB columns before calling `recordReview()`.

---

## Data Access Patterns

### Upsert Pattern

Used for `users` and `repos` — entities that may already exist when referenced:

```ts
// users.ts
const [user] = await db
  .insert(users)
  .values({ entraOid, email, displayName })
  .onConflictDoUpdate({
    target: users.entraOid,
    set: { email, displayName, updatedAt: new Date() },
  })
  .returning();
return user;
```

The `returning()` call ensures the caller always receives the final row, whether it was inserted or updated.

### Conditional-Column Update Pattern

Partial updates use Drizzle's object spread pattern:

```ts
// tasks.ts — updateTask()
const [updated] = await db
  .update(tasks)
  .set({
    ...patch,          // only provided fields
    updatedAt: new Date(),
  })
  .where(eq(tasks.id, id))
  .returning();
```

This avoids overwriting columns that weren't in the patch. TypeScript narrows the `patch` argument to a `Partial<TaskRow>` subset, preventing accidental full-row replacement.

### Aggregate with SQL Template Tag

For complex aggregations that exceed Drizzle's builder capabilities:

```ts
// costs.ts — checkBudget()
const [row] = await db
  .select({
    remaining: sql<number>`${users.dailyBudget} - COALESCE(SUM(${costs.costUsd}), 0)`,
  })
  .from(users)
  .leftJoin(costs, and(
    eq(costs.userId, users.id),
    sql`${costs.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
  ))
  .where(eq(users.id, userId))
  .groupBy(users.dailyBudget);
```

The `sql` template tag is used selectively — only when the Drizzle builder cannot express the required SQL. Simple CRUD operations use the builder exclusively.

### Atomic Increment

Confidence scores and counters use database-side arithmetic to avoid read-modify-write races:

```ts
// learnings.ts — reinforceLearning()
await db.update(learnings).set({
  reinforcements: sql`${learnings.reinforcements} + 1`,
  confidence:     sql`least(1.0, ${learnings.confidence} + 0.05)::numeric(3,2)`,
  updatedAt:      new Date(),
}).where(eq(learnings.id, id));
```

This pattern is used consistently for all counter/score mutations. No optimistic locking is needed because the arithmetic is applied server-side in a single `UPDATE`.

### No Transactions (by Design)

The query helpers do not use explicit transactions. Reasons:

- Most mutations affect a single row (low conflict risk).
- Operations that span multiple tables (e.g., `recordCost` + `addEvent`) are acceptable with eventual consistency — a failed cost record does not warrant rolling back the event.
- The exception is `migrate.ts`, where Drizzle's migrator wraps each migration file in a transaction automatically.

---

## Multi-User Isolation and Access Control

The Hive supports multiple users sharing the same system. Isolation is enforced at two levels:

### 1. Task Visibility

Tasks have a `visibility` column (`"public"` | `"private"`):

- **`public`** — visible to all authenticated users (default).
- **`private`** — visible only to the task creator and admins.

The dashboard API route handlers enforce this by passing the appropriate filter to `list()`:

```ts
// Non-admin users see only:
// - Their own tasks (any visibility)
// - Other users' public tasks
const filters: TaskFilters = user.role === "admin"
  ? {}  // admins see everything
  : {
      // The route resolves this into:
      // WHERE (visibility = 'public' OR created_by = user.id)
    };
```

Private tasks created by a producer on behalf of a user inherit the `createdBy` of the system user (`HIVE_DAEMON_USER_ID`).

### 2. Repository Access Control

Repository access is managed through two complementary mechanisms:

#### a. `user_repo_access` Table

```ts
export const userRepoAccess = pgTable("user_repo_access", {
  userId:    integer("user_id").notNull().references(() => users.id),
  repoId:    integer("repo_id").notNull().references(() => repos.id),
  grantedBy: integer("granted_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", tz).defaultNow(),
}, (t) => [
  unique().on(t.userId, t.repoId),
  index("user_repo_access_user_idx").on(t.userId),
  index("user_repo_access_repo_idx").on(t.repoId),
]);
```

Explicit grants (managed by admins) control which repos a user can interact with. The dashboard checks this table when a user attempts to create a task for a repo or modify repo settings.

#### b. Git Credential Isolation

Each user stores their own `user_credentials` row referencing their personal Key Vault secret. When executing a task, the pipeline resolves credentials for the task's `createdBy` user — a different user's token is never used. This means even if a task is visible to multiple users, it executes with the creator's git identity.

### 3. Budget Isolation

`checkBudget(userId)` queries costs attributed to a specific `user_id`. Each user's spending is tracked independently. A high-spending user cannot deplete another user's budget.

### 4. Admin Override

Users with `role = "admin"` bypass visibility filters in API routes and have access to all management endpoints (user management, repo access grants, global config). Admin status is checked via `req.session.user.role` in route middleware — not re-queried from the database on each request.

---

## Indexes and Query Performance

All performance-critical query patterns have corresponding indexes:

| Index | Table | Columns | Used by |
|---|---|---|---|
| `tasks_status_idx` | `tasks` | `status` | `list({ status })`, daemon tick |
| `tasks_repo_id_idx` | `tasks` | `repo_id` | `list({ repoId })` |
| `tasks_created_by_idx` | `tasks` | `created_by` | `list({ createdBy })`, budget queries |
| `tasks_created_at_idx` | `tasks` | `created_at` | Time-ordered lists |
| `tasks_visibility_idx` | `tasks` | `visibility` | Visibility-filtered lists |
| `costs_user_created_idx` | `costs` | `(user_id, created_at)` | `checkBudget` — composite for daily scan |
| `costs_task_idx` | `costs` | `task_id` | `getCostsByTask` |
| `costs_created_idx` | `costs` | `created_at` | Time-range aggregates |
| `task_events_task_created_idx` | `task_events` | `(task_id, created_at)` | `getEvents(taskId)` |
| `enrichment_runs_task_idx` | `enrichment_runs` | `task_id` | `getRunsForTask` |
| `preview_logs_task_created_idx` | `preview_logs` | `(task_id, created_at)` | `getLogsForTask` |
| `learnings_scope_idx` | `learnings` | `scope` | `retrieveRelevantLearnings` scope filter |
| `learnings_tags_idx` (GIN) | `learnings` | `tags` | `&&` array overlap operator |
| `learnings_confidence_idx` | `learnings` | `confidence` | `listLearnings({ minConfidence })` |
| `user_repo_access_user_idx` | `user_repo_access` | `user_id` | Access-check lookups |
| `user_repo_access_repo_idx` | `user_repo_access` | `repo_id` | Admin repo-view access list |

The `costs_user_created_idx` composite index is the most latency-sensitive: it is queried on every daemon tick (budget check per candidate task). PostgreSQL can satisfy this query with an index scan over `(user_id, created_at)` without touching the table.

---

## Common Operational Queries

```sql
-- Current task status distribution
SELECT status, COUNT(*) FROM tasks GROUP BY status ORDER BY count DESC;

-- Tasks stuck in transitional states for > 30 minutes
SELECT id, status, updated_at, NOW() - updated_at AS age
FROM tasks
WHERE status IN ('executing', 'reviewing', 'enriching', 'rework')
  AND updated_at < NOW() - INTERVAL '30 minutes'
ORDER BY updated_at;

-- Daily spend per user (last 7 days)
SELECT u.email, DATE(c.created_at) AS day, SUM(c.cost_usd) AS total_usd
FROM costs c JOIN users u ON u.id = c.user_id
WHERE c.created_at >= NOW() - INTERVAL '7 days'
GROUP BY u.email, day
ORDER BY day DESC, total_usd DESC;

-- Active agents with heartbeat lag
SELECT task_id, agent, model, phase,
       NOW() - last_heartbeat_at AS heartbeat_lag
FROM active_agents
ORDER BY heartbeat_lag DESC;

-- Learning knowledge-base health
SELECT
  COUNT(*)                               FILTER (WHERE superseded_by IS NULL)     AS active,
  COUNT(*)                               FILTER (WHERE superseded_by = -1 AND dismissed_at IS NULL) AS archived,
  COUNT(*)                               FILTER (WHERE dismissed_at IS NOT NULL)  AS dismissed,
  ROUND(AVG(confidence::numeric)         FILTER (WHERE superseded_by IS NULL), 2) AS avg_confidence
FROM learnings;

-- Top learning categories by count
SELECT category, COUNT(*) FROM learnings
WHERE superseded_by IS NULL
GROUP BY category ORDER BY count DESC LIMIT 10;
```

---

## See Also

- [`docs/internal/modules/domain.md`](./domain.md) — domain types and business logic built on top of this schema
- [`docs/internal/modules/agents.md`](./agents.md) — agents that write to `learnings`, `costs`, `task_events`
- [`docs/internal/modules/execution.md`](./execution.md) — pipeline that writes to `active_agents`, `code_reviews`, `costs`
- [`docs/internal/modules/daemon.md`](./daemon.md) — daemon that reads `tasks` on every tick and manages `active_agents`
- [`docs/internal/modules/producers.md`](./producers.md) — producers that create tasks via `src/db/queries/tasks.ts`
- `src/db/schema.ts` — canonical table definitions
- `src/db/queries/` — all query helpers
- `drizzle/` — SQL migration history
