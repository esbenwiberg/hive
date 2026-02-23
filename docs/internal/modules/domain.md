# Domain Module

> **Location:** `src/domain/`
> **Purpose:** Core business logic, canonical type definitions, and the task state machine that govern how The Hive models and transitions work throughout the entire codebase.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [Types — `types.ts`](#types--typests)
   - [SessionUser](#sessionuser)
   - [TaskStatus — 14 States](#taskstatus--14-states)
   - [TaskType](#tasktype)
   - [TaskSize](#tasksize)
   - [Workflow](#workflow)
   - [TaskVisibility](#taskvisibility)
   - [Task ID Generation](#task-id-generation)
   - [Execution Types](#execution-types)
   - [Task Filters](#task-filters)
3. [State Machine — `state-machine.ts`](#state-machine--state-machinets)
   - [Allowed Transitions](#allowed-transitions)
   - [Transition Validation](#transition-validation)
4. [Config — `config.ts`](#config--configts)
5. [Autonomous Config — `autonomous-config.ts`](#autonomous-config--autonomous-configts)
   - [Config Structure](#config-structure)
   - [Load Order](#load-order)
   - [Persistence](#persistence)
6. [Relationship to Database Schema](#relationship-to-database-schema)
7. [Conventions and Patterns](#conventions-and-patterns)

---

## Module Overview

The domain module is the lowest-level application layer: it imports nothing from the rest of the source tree except the database connection (for `config.ts`). All other modules — agents, enrichers, producers, execution, daemon, dashboard — import their canonical types from here.

```
src/domain/
├── types.ts              # All shared TypeScript types, enums, validators, ID generator
├── state-machine.ts      # TaskStatus transition graph + canTransition() guard
├── config.ts             # global_config key-value read/write helpers
└── autonomous-config.ts  # autonomous.config.yaml loader with DB persistence
```

The module deliberately has no runtime logic beyond validation and configuration loading — it does not spawn processes, call external APIs, or send events. This keeps it easily testable and side-effect-free.

---

## Types — `types.ts`

`types.ts` is the single source of truth for every discriminated union, enum, interface, and utility type used across the codebase. Importing from `src/domain/types.ts` is the correct pattern for any module that needs task or execution types.

### SessionUser

```ts
export interface SessionUser {
  id:          number;   // users.id PK
  entraOid:    string;   // Microsoft Entra Object ID
  email:       string;
  displayName: string;
  role:        string;   // "user" | "admin"
}
```

`SessionUser` is the session payload stored in Express session (see `req.session.user`). It is populated on authentication callback and never re-queried from the database during a request lifecycle — the session store is the source of truth until it expires. The `role` field is used in route middleware to gate admin-only endpoints.

### TaskStatus — 14 States

```ts
export const TaskStatus = {
  PENDING:   "pending",
  QUEUED:    "queued",
  ENRICHING: "enriching",
  READY:     "ready",
  EXECUTING: "executing",
  REVIEWING: "reviewing",
  DONE:      "done",
  MERGED:    "merged",
  FAILED:    "failed",
  REJECTED:  "rejected",
  CANCELLED: "cancelled",
  REWORK:    "rework",
  APPROVED:  "approved",
  SUSPENDED: "suspended",
} as const;

export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];
```

**State descriptions:**

| Status | Description |
|---|---|
| `pending` | Task created, not yet enqueued for processing |
| `queued` | Task has been picked up by the daemon and is in the active queue |
| `enriching` | Enrichers are gathering context (type, size, severity, etc.) |
| `ready` | Enrichment complete; awaiting gate decision |
| `approved` | Human (or auto-approve config) has approved the task for execution |
| `executing` | Execution agent is actively coding in a git worktree |
| `reviewing` | Code review agent is evaluating the produced diff |
| `rework` | Review failed; task is returned for a new execution cycle |
| `done` | Execution complete; PR opened (or code pushed) |
| `merged` | PR has been merged (terminal success state) |
| `failed` | Unrecoverable error; task will not be retried |
| `rejected` | Gate or human rejected the task (terminal) |
| `cancelled` | User or admin cancelled the task (terminal) |
| `suspended` | Task was gracefully paused mid-pipeline (e.g., on daemon shutdown) |

**Terminal states:** `done`, `merged`, `failed`, `rejected`, `cancelled`. Tasks in these states are never dispatched by the daemon. Note that `done` is not fully terminal from a pipeline perspective — the daemon watches `done` tasks for PR merge events to transition them to `merged`.

**See also:** [State Machine](#state-machine--state-machinets) for valid transition paths between these states.

### TaskType

```ts
export const TaskType = {
  BUG:         "bug",
  FEATURE:     "feature",
  SECURITY:    "security",
  REFACTOR:    "refactor",
  IMPROVEMENT: "improvement",
} as const;

export type TaskTypeValue = (typeof TaskType)[keyof typeof TaskType];
```

`TaskType` is assigned by the enricher pipeline (specifically the classification enricher). It influences which workflow is chosen, which agent prompts are used, and how the code review agent weights findings. `security` tasks receive stricter review thresholds.

Validation helper:

```ts
export function isValidTaskType(v: string): v is TaskTypeValue {
  return TASK_TYPE_VALUES.has(v as TaskTypeValue);
}
```

### TaskSize

```ts
export const TaskSize = {
  TRIVIAL: "trivial",
  SMALL:   "small",
  MEDIUM:  "medium",
  LARGE:   "large",
} as const;

export type TaskSizeValue = (typeof TaskSize)[keyof typeof TaskSize];
```

`TaskSize` is estimated by the enricher based on the scope of the change described in the task body. Size affects:

- The agent model chosen (`LARGE` tasks may use a more capable model).
- `maxTurns` and `maxBudgetUsd` defaults applied if not explicitly set.
- Whether the task is eligible for the `epic` workflow (only `LARGE` tasks).

Validation helper:

```ts
export function isValidTaskSize(v: string): v is TaskSizeValue {
  return TASK_SIZE_VALUES.has(v as TaskSizeValue);
}
```

### Workflow

```ts
export const Workflow = {
  FLOW: "flow",   // single-turn execution
  EPIC: "epic",   // multi-milestone, decomposed execution
} as const;

export type WorkflowValue = (typeof Workflow)[keyof typeof Workflow];
```

**`flow`** (default): A task is executed end-to-end in a single agent session. Used for trivial, small, and medium tasks.

**`epic`**: A `LARGE` task is first decomposed into a sequence of milestones (by the epic-planning agent). Each milestone is created as a separate child task (`epicId` linking back to the parent). Milestones execute sequentially, building on each other's worktree. The parent epic task tracks progress via `completedMilestones` / `milestoneTotal`.

### TaskVisibility

```ts
export const TaskVisibility = {
  PUBLIC:  "public",
  PRIVATE: "private",
} as const;

export type TaskVisibilityValue = (typeof TaskVisibility)[keyof typeof TaskVisibility];
```

Controls who can see a task in the dashboard:

- **`public`**: All authenticated users can see the task and its events. This is the default.
- **`private`**: Only the task creator and admin users can see the task.

Validation helper:

```ts
export function isValidVisibility(v: string): v is TaskVisibilityValue {
  return TASK_VISIBILITY_VALUES.has(v as TaskVisibilityValue);
}
```

### Task ID Generation

```ts
export function generateTaskId(): string {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, "0");
  const d   = String(now.getDate()).padStart(2, "0");
  const hex = randomBytes(2).toString("hex");  // 4 hex characters
  return `HIVE-${y}${m}${d}-${hex}`;
}
```

Generated IDs have the format `HIVE-YYYYMMDD-XXXX` where `XXXX` is 4 random hex characters. Examples: `HIVE-20250115-a3f2`, `HIVE-20250115-8c1d`.

The date prefix makes IDs naturally sortable by creation date and human-readable in logs, PR titles, and git branch names. The 4-character random suffix provides 65,536 possible values per day — sufficient given that the system is expected to handle tens of tasks per day, not thousands.

The ID is generated in application code (not by PostgreSQL), allowing the ID to be known before the database insert. This is important for the task pipeline, which needs to reference the ID in multiple places (branch names, event messages) before and during the insert transaction.

### Execution Types

These interfaces describe the in-memory shapes passed between pipeline stages. They are not persisted as-is — they are serialised into JSONB columns when stored.

#### `WorktreeInfo`

```ts
export interface WorktreeInfo {
  path:         string;   // absolute path to git worktree on disk
  branch:       string;   // feature branch name
  repoFullName: string;   // "org/repo"
  provider:     string;   // "github" | "ado"
  createdAt:    Date;
  baseSha:      string;   // commit SHA the branch was created from
}
```

Used by the execution module when creating an isolated git worktree for a task. `baseSha` is recorded on `tasks.worktree_base_sha` and is used to compute the diff passed to the code-review agent.

#### `ReviewFinding`

```ts
export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "info";
  file:     string;
  line?:    number;
  message:  string;
  category: string;   // e.g., "correctness", "style", "performance"
}
```

An individual code issue surfaced by the review agent. Arrays of `ReviewFinding` are stored in `code_reviews.findings` (JSONB).

#### `SecurityFinding`

```ts
export interface SecurityFinding {
  severity:    "critical" | "high" | "medium" | "low";
  type:        string;   // e.g., "injection", "auth-bypass", "secrets-exposure"
  description: string;
  file?:       string;
}
```

A security-specific issue. Arrays of `SecurityFinding` are stored in `code_reviews.security_findings` (JSONB). Any `critical` security finding causes the review verdict to be `"fail"` regardless of other findings.

#### `VerificationResult`

```ts
export interface VerificationResult {
  testsRun:       boolean;
  testsPassed:    boolean;
  lintClean:      boolean;
  buildSucceeded: boolean;
  notes:          string[];
}
```

The outcome of the automated verification phase run by the code-review agent (tests, lint, build). Stored in `code_reviews.verification` (JSONB).

#### `ReviewGateResult`

```ts
export interface ReviewGateResult {
  verdict:          "pass" | "rework" | "fail";
  findings:         ReviewFinding[];
  securityFindings: SecurityFinding[];
  verification:     VerificationResult;
  costUsd:          number;
}
```

The complete result returned by the code-review agent. When persisted, `costUsd` is stored in `code_reviews.cost_usd`, and the structured fields are stored in their respective JSONB columns.

**Verdict semantics:**

| Verdict | Meaning |
|---|---|
| `"pass"` | Code quality acceptable; proceed to PR creation |
| `"rework"` | Issues found but fixable; queue another execution cycle (up to `maxReworkCycles`) |
| `"fail"` | Critical issues or rework limit reached; task marked failed |

#### `GitCredentials`

```ts
export interface GitCredentials {
  provider: string;   // "github" | "ado"
  token:    string;   // PAT or OAuth token fetched from Key Vault
  username?: string;  // optional git committer username
}
```

Resolved at execution time by fetching the token from Azure Key Vault using the user's `user_credentials.vault_secret_id`. The `token` value is never logged or persisted.

#### `WorkerResult`

```ts
export interface WorkerResult {
  success:      boolean;
  prUrl?:       string;
  previewUrl?:  string;
  branch?:      string;
  reviewResult?: ReviewGateResult;
  error?:       string;
}
```

Returned by the execution worker to the daemon after a task's full pipeline cycle (execution → review → PR creation). The daemon uses this to update the task's final status.

#### `PreviewStatus`

```ts
export type PreviewStatus = "starting" | "running" | "failed" | "stopped";
```

Lifecycle states of a preview environment. Stored in `tasks.preview_status`.

#### `MilestoneSpec`

```ts
export interface MilestoneSpec {
  title: string;
  body:  string;
  index: number;   // 0-based position in the milestone sequence
  total: number;   // total milestones in this epic
}
```

Used when the epic-planning agent decomposes a large task into child milestone tasks. Each `MilestoneSpec` becomes one child task row with `tasks.milestone_index = index` and `tasks.milestone_total = total`.

### Task Filters

```ts
export interface TaskFilters {
  status?:     string;
  statuses?:   string[];
  repoId?:     number;
  createdBy?:  number;
  search?:     string;
  visibility?: string;
}
```

Passed to `db/queries/tasks.ts#list()`. At most one of `status` / `statuses` should be provided. `search` performs a case-insensitive substring match on `title` and `body`. See the [database module](./database.md#tasksts) for filter implementation details.

---

## State Machine — `state-machine.ts`

The state machine defines which status transitions are valid and provides a guard function used throughout the pipeline.

### Allowed Transitions

```
pending    → queued
queued     → enriching
enriching  → ready, failed
ready      → approved, rejected, queued
approved   → executing, failed
executing  → reviewing, failed, suspended
reviewing  → done, rework, failed, suspended
rework     → executing, failed
done       → merged, failed
merged     → (terminal)
failed     → (terminal)
rejected   → (terminal)
cancelled  → (terminal)
suspended  → executing, reviewing, failed
```

Visualised as a flow diagram:

```
                          ┌──────────────────────────────────┐
                          ▼                                  │
pending → queued → enriching → ready → approved → executing → reviewing
                      │          │         │           │           │
                      │          │         │           │      ┌────┴────┐
                      │          │         │      suspended   rework   done
                      │          │         │           │           │     │
                      └──────────┴─────────┴─► failed ◄────────────┘    │
                                              rejected                merged
                                              cancelled
```

Key observations:

- **`suspended`** can resume to `executing` or `reviewing` depending on which phase was interrupted (`suspendedFrom` column records the pre-suspension status).
- **`rework`** feeds back to `executing` — the same execution agent is re-invoked with rework instructions.
- **`ready → queued`** is used when a task that had been ready is re-queued (e.g., after an auto-approve config change).
- **`failed`** is reachable from almost every active state — it represents any unrecoverable error.

### Transition Validation

```ts
export function canTransition(
  from: string,
  to:   string,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}
```

`canTransition` is called by the daemon and pipeline orchestrator before every status update. If a transition is invalid, the caller logs an error and does not call `updateStatus()`. This prevents the system from entering an inconsistent state caused by race conditions or bugs.

Usage pattern:

```ts
import { canTransition } from "../domain/state-machine.js";
import { updateStatus }  from "../db/queries/tasks.js";

if (!canTransition(task.status, TaskStatus.EXECUTING)) {
  logger.error({ taskId, from: task.status, to: "executing" }, "Invalid transition — skipping");
  return;
}
await updateStatus(taskId, TaskStatus.EXECUTING);
```

The state machine does not enforce transitions at the database level (no CHECK constraint). Enforcement is application-side via `canTransition`. This trade-off was made to allow the database to record recovery operations (e.g., an admin manually moving a task to `cancelled`) without requiring database schema changes.

---

## Config — `config.ts`

A thin wrapper around the `global_config` table, providing typed read and write access to system-wide key-value configuration.

```ts
export async function getConfig<T = unknown>(key: string): Promise<T | null>
export async function setConfig<T = unknown>(key: string, value: T): Promise<void>
```

### Usage

```ts
import { getConfig, setConfig } from "../domain/config.js";

// Read a stored timestamp
const lastRun = await getConfig<string>("lastRetrospectiveRun");
// → "2025-01-15T03:00:00.000Z" or null if never set

// Write a value
await setConfig("lastDecayRun", new Date().toISOString());
```

### Implementation

`getConfig` uses `eq(globalConfig.key, key)` and returns `row.value as T` (type assertion, not validation — the caller is responsible for knowing the stored type).

`setConfig` uses `INSERT … ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.

### Known Config Keys

| Key | Type | Purpose |
|---|---|---|
| `lastRetrospectiveRun` | `string` (ISO date) | Timestamp of last learning retrospective cycle |
| `lastDecayRun` | `string` (ISO date) | Timestamp of last learning-confidence decay pass |
| `autonomous.config` | `object` | Persisted overrides from the dashboard autonomous-config editor |

The `autonomous.config` key stores the full YAML config as a parsed JSON object. This allows dashboard changes to survive application restarts without modifying files on disk.

---

## Autonomous Config — `autonomous-config.ts`

Manages the system's operational configuration — the settings that control which producers are active, budget caps, model selection, enricher and gate behaviour, and the learning system parameters.

### Config Structure

```ts
export interface AutonomousConfig {
  // Execution
  defaultModel:       string;      // e.g., "claude-opus-4-5"
  maxTurns:           number;      // default per-task turn limit
  maxBudgetUsd:       number;      // default per-task budget cap

  // Producers
  producers: {
    [producerName: string]: {
      enabled:  boolean;
      schedule: string;           // cron expression
      repos?:   string[];         // filter to specific repos
    };
  };

  // Enrichers
  enrichers: {
    [enricherName: string]: {
      enabled: boolean;
    };
  };

  // Gate
  gate: {
    autoApprove:      boolean;    // skip human approval step
    autoApproveTypes: string[];   // TaskType values to auto-approve
  };

  // Learning
  learning: {
    enabled:              boolean;
    retrospectiveCronUtc: string;  // cron for retrospective runs
    decayCronUtc:         string;  // cron for confidence decay
  };

  // Rework
  maxReworkCycles: number;         // global default; per-task override in tasks table
}
```

(The exact interface is defined inline in `autonomous-config.ts` — this is a representative summary. The canonical source is `src/domain/autonomous-config.ts`.)

### Load Order

`autonomous-config.ts` exports a `loadAutonomousConfig()` function that resolves configuration through a two-level priority chain:

```
1. File: autonomous.config.yaml  (base defaults, version-controlled)
       ↓
2. Database: global_config['autonomous.config']  (dashboard overrides, higher priority)
       ↓
3. Result: deep-merged object
```

The file is read with `readFileSync` and parsed with the `yaml` package. The database override (if present) is deep-merged on top, so individual dashboard changes override specific keys without requiring a full config rewrite.

This design means:

- **Defaults** live in the file, are version-controlled, and apply on fresh installations.
- **Dashboard changes** are stored in the database, survive application restarts, and do not require file system access or redeployment.
- **Developers** can test config changes by editing the YAML file locally without touching the database.

### Example `autonomous.config.yaml`

```yaml
defaultModel:   claude-opus-4-5
maxTurns:       40
maxBudgetUsd:   5.00
maxReworkCycles: 2

producers:
  log-scanner:
    enabled: true
    schedule: "0 */6 * * *"   # every 6 hours
  doc-auditor:
    enabled: false
    schedule: "0 8 * * 1"     # weekly Monday 08:00

enrichers:
  classifier:   { enabled: true }
  size-estimator: { enabled: true }
  risk-scorer:  { enabled: true }

gate:
  autoApprove: false
  autoApproveTypes: ["bug"]

learning:
  enabled: true
  retrospectiveCronUtc: "0 3 * * 0"   # Sunday 03:00 UTC
  decayCronUtc:         "0 4 1 * *"   # 1st of month 04:00 UTC
```

### Persistence

When a user saves config through the dashboard:

```ts
import { setConfig }           from "../domain/config.js";
import { loadAutonomousConfig } from "../domain/autonomous-config.js";

// Parse and validate the incoming YAML/JSON
const parsed = parseConfig(incoming);

// Persist to database (overrides file-based defaults)
await setConfig("autonomous.config", parsed);

// The next call to loadAutonomousConfig() will pick up the change
const config = await loadAutonomousConfig();
```

The daemon calls `loadAutonomousConfig()` on each tick, so changes take effect within one daemon cycle (default: 30 seconds) without restarting the process.

---

## Relationship to Database Schema

The domain module and the database schema are deliberately kept separate:

| Concern | Defined in | Notes |
|---|---|---|
| TypeScript enum values | `src/domain/types.ts` | `TaskStatus`, `TaskType`, etc. |
| Column types / constraints | `src/db/schema.ts` | `text("status")` — no DB-level enum |
| Row TypeScript types | `src/db/schema.ts` | `InferSelectModel` exports |
| Validation logic | `src/domain/types.ts` | `isValidTaskType()`, `isValidVisibility()` |
| Transition logic | `src/domain/state-machine.ts` | `canTransition()` |
| Business workflows | `src/domain/autonomous-config.ts` | Config that drives pipeline behaviour |

The database stores `status` as plain `text` with no PostgreSQL `ENUM` constraint. This is intentional: adding a new status value requires only a code change in `src/domain/types.ts` and `src/domain/state-machine.ts` — no migration needed. The trade-off is that invalid status strings can be stored if the application-level validation is bypassed; this risk is accepted in exchange for deployment agility.

### Type Flow Example: Task Lifecycle

```
User submits task
      ↓
Dashboard API validates type, size via isValidTaskType(), isValidTaskSize()
      ↓
db/queries/tasks.ts#createTask() — inserts with status="pending"
      ↓
Daemon calls canTransition("pending", "queued") → true
      ↓
db/queries/tasks.ts#updateStatus(id, TaskStatus.QUEUED)
      ↓
Enricher pipeline runs, calls updateStatus(id, TaskStatus.ENRICHING)
      ...
      ↓
Execution agent produces WorkerResult
      ↓
Daemon writes ReviewGateResult to code_reviews table (JSONB serialised)
      ↓
canTransition("reviewing", "done") → true
      ↓
updateStatus(id, TaskStatus.DONE)
```

At no point does the domain module know about the database schema directly. The database module imports `TaskStatus` from `src/domain/types.ts` for reference in query helpers, but the schema itself is type-agnostic.

---

## Conventions and Patterns

### `as const` Enums

All value sets use the `as const` pattern rather than TypeScript `enum`:

```ts
export const TaskStatus = { PENDING: "pending", ... } as const;
export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];
```

This produces literal union types (`"pending" | "queued" | ...`) rather than the nominal types that TypeScript enums produce. Advantages:

- No runtime enum object compiled into JavaScript — the values are inlined as literals.
- Compatible with Zod schemas and JSON validation without extra configuration.
- Values are just strings — easy to store, log, and compare.

### Validation Set Pattern

Each enum has a corresponding `Set` for O(1) validation:

```ts
const TASK_TYPE_VALUES = new Set(Object.values(TaskType));

export function isValidTaskType(v: string): v is TaskTypeValue {
  return TASK_TYPE_VALUES.has(v as TaskTypeValue);
}
```

These sets are initialised once at module load and reused for every validation call. Route handlers use these guards to return `400 Bad Request` for invalid enum values before touching the database.

### No Side Effects at Module Load

`types.ts` and `state-machine.ts` are pure: they have no async operations, no database calls, and no file I/O. They can be imported freely in any context (tests, scripts, agents) without triggering side effects.

`config.ts` and `autonomous-config.ts` import the database connection, so importing them triggers the `DATABASE_URL` validation in `connection.ts`. This is acceptable because these modules are only imported by the runtime server, not by test utilities or scripts that run without a database.

### Stable Public API

Downstream modules should import from the domain layer using consistent paths:

```ts
// ✓ Correct — use the canonical export path
import { TaskStatus, type TaskStatusValue, generateTaskId } from "../domain/types.js";
import { canTransition } from "../domain/state-machine.js";
import { loadAutonomousConfig }                             from "../domain/autonomous-config.js";
import { getConfig, setConfig }                             from "../domain/config.js";

// ✗ Avoid — importing from db/schema.ts for type-only enum values
import { tasks } from "../db/schema.js";  // only when you need the Drizzle table object
```

---

## See Also

- [`docs/internal/modules/database.md`](./database.md) — how domain types map to database columns and query helpers
- [`docs/internal/modules/execution.md`](./execution.md) — uses `WorktreeInfo`, `ReviewGateResult`, `WorkerResult`, `canTransition`
- [`docs/internal/modules/daemon.md`](./daemon.md) — uses `TaskStatus`, `canTransition`, `loadAutonomousConfig`
- [`docs/internal/modules/agents.md`](./agents.md) — uses `ReviewFinding`, `SecurityFinding`, `VerificationResult`
- `src/domain/types.ts` — canonical type definitions
- `src/domain/state-machine.ts` — transition graph and guard
- `src/domain/config.ts` — global config key-value helpers
- `src/domain/autonomous-config.ts` — operational config loader
