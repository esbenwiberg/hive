# The Hive — System Architecture

> **The Hive** is an autonomous task orchestration platform for engineering teams. It accepts task descriptions from users or automated producers, routes and enriches them with codebase context, gates them through an AI-driven approval process, executes the implementation via Claude (with real git tooling), and opens a pull request on GitHub or Azure DevOps — end to end without human intervention.

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Key Components](#key-components)
3. [Pipeline Data Flow](#pipeline-data-flow)
4. [State Machine](#state-machine)
5. [Infrastructure & Deployment](#infrastructure--deployment)
6. [Multi-User Architecture](#multi-user-architecture)
7. [Cross-Cutting Concerns](#cross-cutting-concerns)

---

## High-Level Overview

```
Task Sources          Pipeline Stages              Outputs
──────────────        ────────────────             ───────
Dashboard (User)  ──► Route → Enrich → Gate ──► Execute → Review → PR / ADO Pull Request
Producers (Auto)  ──►                                              └─► Preview environment
External API      ──►                                              └─► Learnings (feedback loop)
```

The system runs as a single Node.js process that serves both the **Express dashboard** and the **background daemon**. The daemon polls PostgreSQL for queued tasks and drives them through the pipeline concurrently (up to 5 tasks at a time, 2 per user).

---

## Key Components

### 1. Daemon (`src/daemon/`)

The heartbeat of the system. On startup it:

- Recovers stale tasks (stuck > 30 min in transitional states → `FAILED`)
- Clears abandoned `active_agents` records
- Starts three concurrent schedulers:
  - **Task Scheduler** (5-second poll) — picks `QUEUED` tasks and calls `runPipeline()`
  - **Producer Scheduler** (15 min) — runs all producers against all repos
  - **Maintenance Scheduler** (60 s) — runs retrospective (24 h cadence), learning decay (24 h), and preview cleanup

### 2. Agents (`src/agents/`)

Stateless async functions that each wrap a Claude API call. They implement the intelligence of each pipeline stage:

| Agent | Stage | Responsibility |
|---|---|---|
| `router` | PENDING → QUEUED | Classify task type, size, workflow, optional model override |
| `decomposer` | QUEUED | Break epics into ordered milestones |
| `enrichers/*` | ENRICHING | Gather codebase context (6 sequential enrichers) |
| `gate-analyst` | READY → APPROVED/REJECTED | AI gate decision (value/risk/feasibility) |
| `keeper` (worker) | APPROVED → EXECUTING | Orchestrate git worktree, call Claude with tools, commit |
| `refiner` | EXECUTING | Fix broken builds/tests inside the execution loop |
| `feedback-loop` | REVIEWING | Apply previous review findings as learnings to re-execution |
| `retrospective` | DONE | Synthesise learnings from completed tasks |
| `browser-validator` | REVIEWING | Headless browser check of preview environments |
| `code-quality-analyst` | post-review | Detect recurring review-finding patterns; generate learnings |

All agents use `callClaude()` / `callClaudeWithTools()` from `src/agents/sdk.ts`, which handles retry on overload, cost recording, and active-agent registration.

### 3. Enrichers (`src/enrichers/`)

Run sequentially during the `ENRICHING` stage. Each implements the `Enricher` interface (`base.ts`) and writes its output to `task.enrichment` (JSONB). Results accumulate across the chain:

| Order | Enricher | What it adds |
|---|---|---|
| 1 | `codebase` | File tree + keyword-matched relevant source files |
| 2 | `docs` | README and documentation files |
| 3 | `git-history` | Last 50 commits, hotspot files, active authors |
| 4 | `dependencies` | `package.json` / lockfile dependency list |
| 5 | `architect` | Implementation blueprint (milestones or checklist + approach); clarification questions |
| 6 | `scorer` | Value / complexity / risk scores; token & cost estimates; approve/reject/rework verdict |

Each enricher's run is recorded in `enrichment_runs` for cost tracking and debugging.

### 4. Producers (`src/producers/`)

Automated task generators. They scan repos on a schedule and create new tasks when they find actionable issues. All implement the `Producer` interface from `base.ts`:

| Producer | What it creates |
|---|---|
| `bug-hunter` | Bug investigation tasks from file-tree analysis |
| `security-scanner` | Security vulnerability tasks |
| `feature-scout` | Feature opportunity tasks |
| `doc-auditor` | Documentation gap tasks |
| `log-scanner` | Tasks derived from error log patterns |
| `self-monitor` | Self-improvement tasks for Hive itself |

Producers perform duplicate detection (`isDuplicate()`) before inserting to prevent spam.

### 5. Execution (`src/execution/`)

The layer that translates an approved task into actual code changes:

- **`worktree.ts`** — Creates a per-task git worktree (`hive/{taskId}` branch), resolves credentials from Azure Key Vault
- **`worker.ts`** (the `keeper` agent entry point) — Budget check → clone → Claude coding loop → review gate → push → PR creation
- **`review-gate.ts`** — Diffs the full changeset and calls Claude for a structured code review (quality, security, test coverage, acceptance criteria)
- **`milestone-review.ts`** — Per-milestone review within the execution loop for epic tasks
- **`git-provider.ts`** — Unified interface for GitHub REST/GraphQL and Azure DevOps REST APIs
- **`browser-tools.ts`** / **`worker-tools.ts`** — Tool definitions passed to Claude for file I/O, shell, and browser actions

### 6. Dashboard (`src/dashboard/`)

An Express + HTMX + TailwindCSS web application:

- **`server.ts`** — App bootstrap, middleware, route mounting
- **`routes/`** — REST + HTML endpoints (see [External API docs](../external/api.md))
- **`views/`** — Server-rendered HTML templates
- **`public/`** — Static assets

Authentication is enforced via Microsoft Entra ID (Azure AD) OIDC. Session data is stored in PostgreSQL via `connect-pg-simple`.

### 7. Database (`src/db/`)

PostgreSQL 16 accessed through **Drizzle ORM**:

- **`schema.ts`** — All table definitions (see [DB module guide](./modules/db.md))
- **`connection.ts`** — Shared `pg.Pool` and `drizzle` instance
- **`queries/`** — One file per domain entity, each exporting typed query functions
- **`migrate.ts`** — Runs Drizzle migrations on startup

### 8. Domain (`src/domain/`)

Shared types and business logic with no external I/O dependencies:

- **`types.ts`** — Core TypeScript interfaces (`TaskRow`, `SessionUser`, `GitCredentials`, `TaskStatus` enum, etc.)
- **`state-machine.ts`** — `ALLOWED_TRANSITIONS` map enforcing valid status progressions
- **`autonomous-config.ts`** — Parses and caches `autonomous.config.yaml`; exposes `getAutonomousConfig()` / `getModelFor()`
- **`config.ts`** — CRUD helpers for the `global_config` DB table (runtime key-value store)

### 9. Auth (`src/auth/`)

- **`entra.ts`** — MSAL `ConfidentialClientApplication` wrapper; `getAuthUrl()`, `handleCallback()`, `refreshToken()`
- **`session.ts`** — `express-session` + `connect-pg-simple` configuration
- **`middleware.ts`** — `requireAuth` and `requireRole` Express middleware

---

## Pipeline Data Flow

Below is the complete flow a task travels from creation to merged PR:

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. TASK CREATION                              Status: PENDING       │
│     Source: dashboard form | producer | API                         │
│     Stored in: tasks table (title, body, source, type, repoId)      │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ daemon polls every 5 s
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. ROUTING                                    Status: PENDING→QUEUED│
│     Agent: router (Claude)                                          │
│     Input:  task title + body                                       │
│     Output: type, size, workflow (flow|epic), optional model        │
│     Stores: task.taskType, task.size, task.workflow                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. ENRICHMENT                                 Status: ENRICHING     │
│     6 enrichers run sequentially in a cloned repo worktree          │
│                                                                     │
│     codebase → docs → git-history → dependencies → architect → scorer│
│                                                                     │
│     Each enricher:                                                  │
│       • reads task + previous enrichment output from DB             │
│       • calls Claude (or reads files directly)                      │
│       • writes result back to task.enrichment (JSONB merge)         │
│       • records cost + timing in enrichment_runs                    │
│                                                                     │
│     Architect may emit clarification questions → Status: READY      │
│     (user answers, or AI auto-answers, then re-runs architect)      │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. GATE EVALUATION                        Status: READY→APPROVED   │
│     Mode controlled by autonomous.config.yaml gating.mode:          │
│       human  — task waits in READY; dashboard shows approve/reject  │
│       ai     — gate-analyst (Claude) decides automatically          │
│       auto   — trivial/small auto-approve; larger tasks use AI      │
│                                                                     │
│     Gate decision stored in gate_decisions table                    │
│     Rejected tasks → REJECTED (terminal); rework → back to QUEUED  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  5. EXECUTION                                  Status: EXECUTING     │
│     keeper agent (worker.ts):                                       │
│       a. Budget check (daily limit + per-task max)                  │
│       b. Resolve git credentials (Azure Key Vault)                  │
│       c. Create git worktree → branch hive/{taskId}                 │
│       d. Retrieve relevant learnings from DB                        │
│       e. Call Claude with tools (read/write files, run shell)       │
│                                                                     │
│     For EPIC workflow: milestone loop (decomposer pre-splits)       │
│       • execute milestone → review-fix loop → commit → next         │
│                                                                     │
│     For FLOW workflow: single Claude pass                           │
│       • execute → lint/build/test → review-fix if failures          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  6. REVIEW GATE                                Status: REVIEWING     │
│     review-gate.ts diffs full changeset (merge-base → HEAD)         │
│     Claude reviews: quality, security, tests, acceptance criteria   │
│     Verdict:                                                        │
│       PASS   → commit + push + create PR → Status: DONE            │
│       REWORK → re-execute with feedback (≤2 cycles)                 │
│       FAIL   → Status: FAILED                                       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  7. POST-COMPLETION                            Status: DONE/MERGED   │
│     • PR created on GitHub or Azure DevOps                          │
│     • Optional preview environment spun up (Docker)                 │
│     • retrospective agent synthesises learnings                     │
│     • code-quality-analyst checks for recurring review patterns     │
│     • Learning events recorded for future task context              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## State Machine

The `TaskStatus` enum and `ALLOWED_TRANSITIONS` map (in `src/domain/state-machine.ts`) define all valid status progressions. No code may transition a task to an arbitrary status — it must pass `canTransition()`.

```
PENDING ──► QUEUED ──► ENRICHING ──► READY ──► APPROVED ──► EXECUTING ──► REVIEWING ──► DONE ──► MERGED
   │           │            │          │            │              │            │
   │           │            │          │            │              │            ├──► REWORK ──► EXECUTING
   │           │            │          │            │              │            └──► FAILED
   │           │            │          │            │              └──► FAILED
   │           │            │          │            └──► FAILED
   │           │            │          └──► REJECTED
   │           │            └──► REJECTED
   │           └──► FAILED
   └──► REJECTED
   (CANCELLED reachable from most active states)
```

---

## Infrastructure & Deployment

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript (ESM) |
| Web framework | Express 4 |
| Frontend | HTMX + TailwindCSS (server-rendered) |
| Database | PostgreSQL 16 via Drizzle ORM |
| AI engine | Anthropic Claude (Sonnet / Opus configurable per agent) |
| Auth | Microsoft Entra ID (MSAL) + express-session |
| Git providers | GitHub (REST + GraphQL) and Azure DevOps (REST v7.1) |
| Secrets | Azure Key Vault (git tokens per user) |
| Container | Docker (2-stage build: builder → node:20-alpine) |
| Hosting | Azure Container Apps |
| Image registry | Azure Container Registry |
| CI/CD | GitHub Actions (`.github/workflows/`) |
| Preview envs | Docker via TLS daemon (ports 4001–4099, 30-min TTL) |

The application reads configuration from:
1. **Environment variables** — `DATABASE_URL`, `ANTHROPIC_API_KEY`, `SESSION_SECRET`, Azure credentials, etc.
2. **`autonomous.config.yaml`** — Pipeline behaviour (gating mode, budgets, enrichment flags, model assignments)
3. **`global_config` DB table** — Runtime-mutable settings (editable from the dashboard)

---

## Multi-User Architecture

The Hive is a **shared multi-user system** with per-user isolation enforced at several layers:

| Concern | Mechanism |
|---|---|
| Authentication | Entra ID OIDC; sessions in `sessions` (PostgreSQL) |
| Authorisation | Role hierarchy: `viewer < user < admin`; `requireRole()` middleware |
| Budget isolation | `daily_cost_usd` and `max_cost_per_task_usd` enforced per `userId` in `costs` table |
| Task ownership | Every task has a `createdBy` (userId FK); users see only their own tasks unless admin |
| Git credentials | Stored encrypted per-user in Azure Key Vault, retrieved at execution time |
| Concurrency limits | Max 2 concurrent tasks per user, 5 system-wide (configured in daemon) |
| Repo access | Repos registered per-user; `repos` table has `userId` FK |

---

## Cross-Cutting Concerns

### Logging

`src/logger.ts` exports a **pino** logger. In development it pretty-prints; in production it outputs JSON. A ring-buffer (`src/log-buffer.ts`) captures the last N log lines so the dashboard's `/api/logs` endpoint can stream them without a separate log aggregator.

### Cost Tracking

Every Claude call produces token counts that flow through `estimateCostUsd()` and are inserted into the `costs` table with `taskId`, `userId`, `phase`, `inputTokens`, `outputTokens`, `costUsd`. The daemon enforces budget limits before starting execution.

### Prompt Management

System prompts live in `src/prompts.ts` (inline) and in prompt files loaded via `src/prompt-cache.ts`. The cache avoids re-reading files on every call.

### Learnings (Feedback Loop)

A lightweight RAG-like system: after each completed task the `retrospective` agent generates structured learnings (scope: `universal` or `repo:<owner/name>`) stored in the `learnings` table. The execution worker retrieves relevant learnings and injects them into the Claude prompt, creating a continuously improving feedback loop.

### Notifications

`src/notifications.ts` sends real-time notifications to connected dashboard clients when task status changes (using Server-Sent Events or polling, wired through the dashboard routes).
