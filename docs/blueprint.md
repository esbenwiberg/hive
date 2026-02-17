# The Hive — Rebuild Blueprint

## Goal

Rebuild The Hive from the ground up as a multi-user (10 individuals) autonomous task orchestration system, replacing file-based state with PostgreSQL, deploying on Azure Container Apps instead of a VM, adding Azure Entra ID authentication, and per-user git credentials via Azure Key Vault — while preserving the core pipeline, agent SDK integration, HTMX dashboard, and git worktree execution model that proved out in v1.

**Milestones: 10**

## Non-Goals

- SaaS / multi-tenant with teams/orgs (just 10 individual users, same org)
- Redis, message queues, or separate worker services (single container is sufficient)
- SSE/WebSocket (HTMX polling is fine for 10 users)
- Frontend framework (keep Express + HTMX + Tailwind — no React/Vue/Svelte)
- Kubernetes, Docker Swarm, or any container orchestration beyond Container Apps
- Mobile support or PWA
- Migrating v1 data (clean start)

## Acceptance Criteria

- [ ] User can sign in via Azure Entra ID ("Sign in with Microsoft")
- [ ] User can add their GitHub token and/or Azure DevOps PAT (stored in Key Vault)
- [ ] User can create tasks manually via dashboard
- [ ] Tasks flow through the full pipeline: route → enrich (multiple enrichers) → gate → execute → review → PR
- [ ] Multiple enrichers run per task (codebase, docs, git-history, dependencies), results merged into task.enrichment
- [ ] Human gate works: tasks needing approval appear in dashboard, user can approve/reject
- [ ] AI gate works: low-risk tasks auto-approved
- [ ] Worker creates isolated git worktree, implements changes, pushes branch, creates PR
- [ ] Worker uses the task creator's git credentials (from Key Vault)
- [ ] Review gate runs lint/build/test + code review + security review
- [ ] Rework loop: failed review → refine → re-execute (max 2 cycles)
- [ ] Preview environments: gate agent spins up the app, validates it works, then human can validate via dashboard link
- [ ] Per-repo preview config via `.hive.yaml` (start command, port, health check, dependencies)
- [ ] Epic workflow: large tasks decomposed into milestones, executed sequentially
- [ ] Per-user cost tracking with configurable daily budgets
- [ ] Producers discover tasks automatically on schedule
- [ ] All state in PostgreSQL (no file-based state, no JSONL ledgers)
- [ ] Dashboard shows: tasks, costs, agents, health, producers, settings, hivemind
- [ ] Polished UX/UI with Tailwind CSS — feels like a modern product, not an admin panel
- [ ] Consistent design system: typography, spacing, color palette, component patterns
- [ ] Keyboard shortcuts for power users (approve task, navigate between views)
- [ ] Roles: viewer (read-only), user (create/approve own tasks), admin (full access)
- [ ] Deployed via GitHub Actions → ACR → Azure Container Apps
- [ ] Git worktrees on ephemeral local disk (re-cloned on container restart)
- [ ] Logging via Pino → stdout → Azure Monitor / Log Analytics
- [ ] `npm test` passes with >80% coverage on core modules

## Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────┐
│                   Azure Container App                    │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   Express     │  │   Daemon     │  │   Producers   │  │
│  │   Dashboard   │  │   (class)    │  │   (scheduled) │  │
│  │   + Auth MW   │  │   Pipeline   │  │               │  │
│  │   + HTMX      │  │   Workers    │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                  │                   │          │
│         └──────────┬───────┴───────────────────┘          │
│                    │                                      │
│              ┌─────▼─────┐                                │
│              │  Drizzle   │                                │
│              │  ORM       │                                │
│              └─────┬─────┘                                │
│                    │                                      │
│              ┌─────┤  Local disk: /repos (ephemeral cache) │
│              │     │  (git clones + worktrees, re-cloned  │
│              │     │   on restart — not precious state)    │
└──────────────┼─────┼──────────────────────────────────────┘
               │     │
               ▼     ▼
         ┌───────────┐   ┌───────────┐   ┌─────────┐
         │ PostgreSQL│   │ Key Vault │   │  ACR    │
         │ Flex Srvr │   │ (tokens)  │   │ (images)│
         └───────────┘   └───────────┘   └─────────┘
```

### Data Model (PostgreSQL)

```
users
  id              serial PK
  entra_oid       text UNIQUE NOT NULL    -- Azure AD object ID
  email           text UNIQUE NOT NULL
  display_name    text NOT NULL
  role            text NOT NULL DEFAULT 'user'  -- viewer | user | admin
  daily_budget    numeric(10,2) DEFAULT 100.00
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()

user_credentials
  id              serial PK
  user_id         integer FK → users
  provider        text NOT NULL            -- github | azure_devops
  vault_secret_id text NOT NULL            -- Key Vault secret name
  label           text                     -- friendly name
  created_at      timestamptz DEFAULT now()
  UNIQUE(user_id, provider, label)

repos
  id              serial PK
  provider        text NOT NULL            -- github | azure_devops
  full_name       text NOT NULL            -- owner/repo or project/repo
  default_branch  text DEFAULT 'main'
  settings        jsonb NOT NULL DEFAULT '{}'  -- per-repo overrides (RepoSettings shape)
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()
  UNIQUE(provider, full_name)

-- repos.settings is a RepoSettings object (same shape for every repo):
-- {
--   classification: { overrides by task type/size },
--   gate: { mode, auto_approve_below_usd },
--   enrichers: { codebase: {enabled, model, budget}, docs: {...}, ... },
--   review_gate: { verification: {commands}, code_review: {enabled}, security_review: {enabled} },
--   preview: { type, compose_file, start, port, health_check, startup_timeout, env },
--   producers: { bug_hunter: {enabled, poll_interval}, security_scanner: {...}, ... },
--   notifications: { slack_webhook, events[] }
-- }
-- Any field not set falls back to global defaults.

tasks
  id              text PK                  -- HIVE-YYYYMMDD-xxxx
  created_by      integer FK → users
  approved_by     integer FK → users (nullable)
  repo_id         integer FK → repos
  source          text NOT NULL            -- user | producer:<name>
  status          text NOT NULL            -- (enum: 13 states)
  type            text                     -- bug | feature | security | refactor | improvement
  severity        text
  title           text NOT NULL
  body            text NOT NULL            -- markdown task description
  -- classification
  size            text                     -- trivial | small | medium | large
  workflow        text                     -- flow | epic
  model           text                     -- resolved model string
  max_turns       integer
  max_budget_usd  numeric(10,2)
  -- enrichment (merged results from all enrichers)
  enrichment      jsonb                    -- merged {related_files, patterns, test_coverage, deps, ...}
  -- gate
  gate_verdict    text
  gate_reasoning  text
  -- execution
  execution_attempts integer DEFAULT 0
  pr_url          text
  failure_reason  text
  -- rework
  rework_count    integer DEFAULT 0
  rework_history  jsonb DEFAULT '[]'
  retry_instructions text
  -- epic
  epic_id         text FK → tasks(id)     -- parent epic (for milestones)
  milestone_index integer
  milestone_total integer
  blueprint       text
  -- preview environment
  preview_port    integer                  -- allocated port (null if no preview)
  preview_status  text                     -- null | starting | running | failed | stopped
  preview_started_at timestamptz
  -- timestamps
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()

costs
  id              serial PK
  task_id         text FK → tasks
  user_id         integer FK → users       -- task creator
  agent           text NOT NULL            -- router | enricher | gate | worker | ...
  model           text NOT NULL
  repo            text
  cost_usd        numeric(10,4) NOT NULL
  turns           integer
  duration_ms     integer
  created_at      timestamptz DEFAULT now()

  -- indexes: (user_id, created_at), (task_id), (created_at)

gate_decisions
  id              serial PK
  task_id         text FK → tasks
  verdict         text NOT NULL
  source          text NOT NULL            -- human | ai | auto
  decided_by      integer FK → users (nullable, for human decisions)
  reasoning       text
  task_context    jsonb
  created_at      timestamptz DEFAULT now()

code_reviews
  id              serial PK
  task_id         text FK → tasks
  verdict         text NOT NULL            -- pass | rework | fail
  rework_cycle    integer DEFAULT 0
  findings        jsonb                    -- [{category, severity, description}]
  security_findings jsonb
  verification    jsonb                    -- {lint, build, test results}
  cost_usd        numeric(10,4)
  created_at      timestamptz DEFAULT now()

active_agents
  task_id         text PK FK → tasks
  agent           text NOT NULL            -- router | enricher | worker | ...
  model           text NOT NULL
  phase           text
  started_at      timestamptz DEFAULT now()
  -- daemon deletes row when agent completes
  -- survives restart (unlike v1 in-memory Map)

enrichment_runs
  id              serial PK
  task_id         text FK → tasks
  enricher        text NOT NULL            -- codebase | docs | git-history | dependencies | custom
  status          text NOT NULL            -- pending | running | completed | failed
  result          jsonb                    -- enricher-specific output
  cost_usd        numeric(10,4)
  duration_ms     integer
  error           text
  created_at      timestamptz DEFAULT now()
  -- index: (task_id)
  -- daemon merges all completed results into tasks.enrichment

producer_runs
  id              serial PK
  producer        text NOT NULL
  repo            text
  tasks_created   integer DEFAULT 0
  duplicates_skipped integer DEFAULT 0
  errors          jsonb DEFAULT '[]'
  cost_usd        numeric(10,4)
  duration_ms     integer
  created_at      timestamptz DEFAULT now()

preview_logs
  id              serial PK
  task_id         text FK → tasks
  source          text NOT NULL            -- agent | system | cleanup
  message         text NOT NULL
  created_at      timestamptz DEFAULT now()
  -- index: (task_id, created_at)

learnings
  id              serial PK
  scope           text NOT NULL            -- universal | lang:<x> | framework:<x> | repo:<full_name>
  category        text NOT NULL            -- convention | pattern | anti-pattern | process | domain | cost
  content         text NOT NULL            -- the learning itself
  confidence      numeric(3,2) DEFAULT 0.50
  reinforcements  integer DEFAULT 0
  contradictions  integer DEFAULT 0
  source_task_ids text[]
  tags            text[]                   -- searchable tags for relevance retrieval
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()
  last_used_at    timestamptz
  superseded_by   integer FK → learnings
  -- indexes: (scope), (tags GIN), (confidence DESC)

learning_events
  id              serial PK
  learning_id     integer FK → learnings
  event_type      text NOT NULL            -- reinforced | contradicted | created | updated | superseded | decayed
  task_id         text FK → tasks
  evidence        text
  created_at      timestamptz DEFAULT now()

sessions
  sid             text PK
  sess            jsonb NOT NULL
  expire          timestamptz NOT NULL

global_config
  key             text PK                  -- 'classification', 'gate', 'enrichers', 'review_gate',
                                           --  'budget', 'producers', 'notifications', 'preview', 'heartbeat'
  value           jsonb NOT NULL
  updated_at      timestamptz DEFAULT now()

-- Settings resolution order:
--   1. repos.settings (per-repo overrides)   ← most specific
--   2. global_config (DB)                    ← global defaults in DB (editable via dashboard)
--   3. autonomous.config.yaml                ← file-based defaults (deploy-time)
-- Deep-merged: repo settings override global, global overrides file defaults.
-- Example: repo sets gate.mode = "ai", global has gate.mode = "human" → repo wins.
```

### Request Flow

```
Browser → Express (auth middleware checks Entra ID session)
  → Route handler (reads/writes via Drizzle)
  → HTMX partial or full page response

Daemon loop (every 5s):
  → Poll DB: SELECT tasks WHERE status IN ('pending','approved','rework') LIMIT 1
  → Run pipeline stage (route/enrich/gate/execute)
  → For enrichment: run all enabled enrichers sequentially
    → Each enricher writes to enrichment_runs (can use prior enricher output)
    → Daemon merges completed results into tasks.enrichment jsonb
  → UPDATE task SET status = next_state
  → INSERT INTO costs/gate_decisions/code_reviews
  → DELETE FROM active_agents when done
```

### Key Differences from v1

| Aspect | v1 | v2 |
|--------|----|----|
| Task state | Folder-based (inbox/pending/, etc.) | PostgreSQL `tasks.status` column |
| Queue polling | Chokidar file watcher | DB poll every 5s |
| Cost tracking | JSONL append file | `costs` table |
| Gate decisions | JSONL append file | `gate_decisions` table |
| Active agents | In-memory Map (lost on crash) | `active_agents` table (survives restart) |
| Auth | None | Azure Entra ID |
| Credentials | Global env vars | Per-user, Key Vault |
| Config | YAML file only | YAML defaults + DB overrides |
| Daemon state | Module-scope globals | `Daemon` class instance |
| Deploy | SSH + docker compose | GitHub Actions → ACR → Container Apps |
| Crash recovery | Scan folders for orphans | Query `active_agents` table on startup |
| Enrichment | Single monolithic enricher | Multiple pluggable enrichers (same pattern as producers) |
| Validation | Lint/build/test only | Preview environments: spin up app, agent validates, human validates via link |
| Heartbeat | Write JSON file | `UPDATE config SET value = ... WHERE key = 'heartbeat'` |
| Dashboard styling | Inline CSS in template strings, dark theme only | Tailwind CSS, design system, polished UX |

## UX/UI Design

### Design Philosophy

The current dashboard is a functional admin panel — inline CSS in TypeScript template strings, no design system, built for one person. The rebuild is a multi-user product that people use daily. It should feel fast, clean, and intentional.

**Design inspirations:**
- **Linear** — keyboard-first navigation, clean task lists, status badges, command palette (Cmd+K)
- **Vercel Dashboard** — deployment status cards, real-time updates, dark/light theme, clear hierarchy
- **GitHub Actions** — workflow run visualization, step-by-step pipeline progress, log viewers
- **Railway** — service cards, resource usage meters, deployment timeline
- **Supabase** — sidebar navigation, data tables with inline actions, clean forms

### Tech Stack

- **Tailwind CSS** — utility-first, consistent spacing/colors/typography, no custom CSS files
- **Tailwind UI patterns** — use established component patterns (not the paid library, just the patterns)
- **HTMX** — server-rendered partials with smooth swaps (no full page reloads)
- **View templates in `.ts` files** — but using Tailwind classes instead of inline `<style>` blocks
- **Inter font** — clean, modern, excellent at small sizes (via Google Fonts or self-hosted)

### Design System

```
Colors (CSS variables + Tailwind config):
  --bg-primary:     slate-900     # main background
  --bg-surface:     slate-800     # cards, panels
  --bg-elevated:    slate-700     # dropdowns, modals
  --border:         slate-600
  --text-primary:   slate-50
  --text-secondary: slate-400
  --accent:         amber-400     # The Hive brand color
  --success:        emerald-400
  --danger:         red-400
  --info:           blue-400
  --warning:        amber-300

Typography:
  Font: Inter (400, 500, 600)
  Monospace: JetBrains Mono (code, logs, task IDs)
  Scale: text-xs(11) text-sm(13) text-base(15) text-lg(18) text-xl(20)

Spacing:
  Consistent 4px grid (Tailwind default)
  Card padding: p-4 (compact) or p-6 (spacious)
  Section gaps: space-y-6
  Sidebar width: w-64

Components:
  Cards:          rounded-lg bg-slate-800 border border-slate-700 shadow-sm
  Buttons:        rounded-md px-3 py-1.5 text-sm font-medium transition
  Badges:         rounded-full px-2 py-0.5 text-xs font-medium
  Tables:         divide-y divide-slate-700, hover:bg-slate-750
  Modals:         backdrop-blur-sm, slide-in animation
  Sidebar:        fixed left, bg-slate-900, border-r border-slate-800
  Toast/alerts:   fixed bottom-right, slide-up animation
```

### Key UX Patterns

**1. Command Palette (Cmd+K)**
Quick access to everything — navigate to task, approve, create task, switch views.
Inspired by Linear, VS Code, GitHub.

**2. Sidebar Navigation**
```
┌──────────┬──────────────────────────────────────┐
│ 🐝 Hive  │  Dashboard                           │
│          │                                      │
│ Dashboard│  ┌─────────┐ ┌─────────┐ ┌────────┐ │
│ Tasks    │  │ Active  3│ │ Pending 7│ │ Cost   │ │
│ Costs    │  │ agents   │ │ tasks    │ │ $47.20 │ │
│ Producers│  └─────────┘ └─────────┘ └────────┘ │
│ Hivemind │                                      │
│ Settings │  Recent Tasks                        │
│          │  ┌──────────────────────────────────┐ │
│──────────│  │ HIVE-0217-a3f2  Fix auth bug     │ │
│ Profile  │  │ ● Running  repo/api  2m ago      │ │
│ ewi@...  │  ├──────────────────────────────────┤ │
│          │  │ HIVE-0217-b1c4  Add user search  │ │
│          │  │ ◉ Awaiting review  repo/web      │ │
└──────────┴──────────────────────────────────────┘
```

**3. Task Pipeline Visualization**
Show where each task is in the pipeline — not just a status badge, but a visual step indicator:
```
Route ──→ Enrich ──→ Gate ──→ Execute ──→ Review ──→ PR
  ✓          ✓        ✓       ● running
```

**4. Live Agent Activity**
Show what agents are doing right now — model, task, elapsed time, cost so far:
```
┌─ Active Agents ────────────────────────────────────┐
│  ● Worker (Sonnet)     HIVE-a3f2  Fix auth bug     │
│    Running for 3m 42s  $2.15 so far  45 turns      │
│                                                     │
│  ● Enricher (Haiku)    HIVE-c8d1  Add search       │
│    Running for 12s     $0.03 so far  3 turns        │
└─────────────────────────────────────────────────────┘
```

**5. Inline Actions**
Approve/reject/rework directly from task list — no need to open a modal for simple actions.
Modal only for viewing full details, enrichment breakdown, gate reasoning.

**6. Keyboard Shortcuts**
- `Cmd+K` — Command palette
- `j/k` — Navigate task list (vim-style)
- `a` — Approve selected task
- `r` — Reject selected task
- `n` — New task
- `1-5` — Switch sidebar tabs

**7. Toast Notifications**
Non-intrusive bottom-right toasts for:
- Task completed / failed
- Preview environment ready
- Budget warning
- Agent circuit breaker tripped

**8. Responsive**
Works on laptop (1440px), large monitor (1920px+), and tablet (768px) for quick checks.
Sidebar collapses to icons on smaller screens.

## Folder/File Layout

```
the-hive/
├── src/
│   ├── index.ts                    -- Entry point
│   ├── cli.ts                      -- Commander CLI (daemon, status, costs, etc.)
│   │
│   ├── db/
│   │   ├── schema.ts               -- Drizzle table definitions
│   │   ├── migrate.ts              -- Run migrations on startup
│   │   ├── connection.ts           -- pg pool + Drizzle instance
│   │   └── queries/
│   │       ├── tasks.ts            -- Task CRUD + state transitions
│   │       ├── costs.ts            -- Cost recording + aggregation
│   │       ├── users.ts            -- User lookup/create
│   │       ├── gate-decisions.ts   -- Gate decision recording
│   │       ├── code-reviews.ts     -- Code review recording
│   │       ├── enrichment-runs.ts  -- Per-enricher result tracking
│   │       ├── learnings.ts        -- Learning CRUD, relevance retrieval, reinforce/contradict
│   │       ├── learning-events.ts  -- Learning event history
│   │       └── active-agents.ts    -- Agent registration/cleanup
│   │
│   ├── auth/
│   │   ├── entra.ts                -- MSAL config + Entra ID strategy
│   │   ├── middleware.ts           -- requireAuth, requireRole
│   │   └── session.ts             -- express-session + connect-pg-simple
│   │
│   ├── vault/
│   │   └── keyvault.ts            -- Azure Key Vault client (get/set user tokens)
│   │
│   ├── domain/
│   │   ├── types.ts               -- Domain types, enums, interfaces (incl. RepoSettings shape)
│   │   ├── state-machine.ts       -- Allowed status transitions + validation
│   │   └── config.ts              -- 3-layer config: YAML defaults → global_config DB → repo.settings
│   │
│   ├── agents/
│   │   ├── sdk.ts                 -- Claude Agent SDK wrapper (retry + circuit breaker)
│   │   ├── retry.ts               -- Exponential backoff + circuit breaker
│   │   ├── router.ts              -- Task classification
│   │   ├── gate.ts                -- AI gate evaluation
│   │   ├── refiner.ts             -- Task rewriting for rework
│   │   ├── decomposer.ts          -- Epic → milestone breakdown
│   │   ├── keeper.ts              -- Learning curation, confidence management, superseding
│   │   ├── feedback-loop.ts       -- Post-task: reinforce/contradict/extract learnings
│   │   ├── retrospective.ts       -- Weekly intelligence report + learning proposals
│   │   ├── gate-analyst.ts        -- Gate trends → feeds into learnings
│   │   └── code-quality-analyst.ts -- Code review patterns → feeds into learnings
│   │
│   ├── enrichers/
│   │   ├── base.ts                -- Enricher interface + sequential runner
│   │   ├── codebase.ts            -- Related files, patterns, test coverage (port v1 enricher)
│   │   ├── docs.ts                -- README, API specs, architecture docs
│   │   ├── git-history.ts         -- Recent commits, blame, change frequency
│   │   └── dependencies.ts        -- package.json, lock files, vulnerability info
│   │
│   ├── execution/
│   │   ├── worker.ts              -- Task execution (flow + epic workflows)
│   │   ├── review-gate.ts         -- Post-impl verification
│   │   ├── worktree.ts            -- Git worktree management
│   │   ├── git-provider.ts        -- GitHub + Azure DevOps abstraction
│   │   └── preview/
│   │       ├── manager.ts         -- PreviewManager: start/stop/cleanup previews
│   │       ├── proxy.ts           -- Express reverse proxy for /preview/:taskId/*
│   │       └── validator.ts       -- Agent-driven preview validation logic
│   │
│   ├── daemon/
│   │   ├── daemon.ts              -- Daemon class (orchestration loop)
│   │   ├── scheduler.ts           -- Producer scheduling
│   │   └── stale-tasks.ts         -- DB-based stale detection
│   │
│   ├── producers/
│   │   ├── base.ts                -- Producer interface + dedup
│   │   ├── log-scanner.ts
│   │   ├── bug-hunter.ts
│   │   ├── security-scanner.ts
│   │   ├── feature-scout.ts
│   │   └── self-monitor.ts
│   │
│   ├── dashboard/
│   │   ├── server.ts              -- Express app setup
│   │   ├── routes/
│   │   │   ├── auth.ts            -- Login/logout/callback
│   │   │   ├── dashboard.ts       -- Home page
│   │   │   ├── tasks.ts           -- Task list/detail/actions
│   │   │   ├── costs.ts           -- Cost reports
│   │   │   ├── settings.ts        -- Global settings + per-repo settings
│   │   │   ├── profile.ts         -- User profile + tokens
│   │   │   ├── hivemind.ts        -- Knowledge browser
│   │   │   └── producers.ts       -- Producer status
│   │   ├── views/
│   │   │   ├── layout.ts          -- Shell: sidebar, topbar, Tailwind + Inter font
│   │   │   ├── components.ts      -- Reusable: cards, badges, buttons, tables, modals, toasts
│   │   │   ├── dashboard.ts       -- Home: status cards, active agents, recent tasks
│   │   │   ├── tasks.ts           -- Task list, pipeline visualization, detail panel
│   │   │   ├── costs.ts           -- Cost charts, breakdowns by user/repo/agent
│   │   │   ├── settings.ts        -- Global + repo settings forms
│   │   │   ├── profile.ts         -- User profile, token management
│   │   │   └── hivemind.ts        -- Knowledge browser
│   │   └── public/
│   │       ├── commands.ts        -- Command palette (Cmd+K) + keyboard shortcuts
│   │       └── htmx-ext.ts        -- HTMX extensions (toast notifications, etc.)
│   │
│   ├── integrations/
│   │   ├── azure-devops.ts        -- Azure DevOps REST API
│   │   └── azure-monitor.ts       -- KQL queries
│   │
│   ├── notifications.ts           -- Slack/Teams webhooks
│   ├── prompts.ts                 -- Agent prompt loading
│   └── logger.ts                  -- Pino setup
│
├── drizzle/
│   └── migrations/                -- SQL migration files
│
├── prompts/                       -- Agent system prompts (.md)
│   ├── flow.md
│   ├── gate.md
│   ├── router.md
│   ├── milestone.md
│   ├── enrichers/
│   │   ├── codebase.md            -- Codebase enricher prompt
│   │   ├── docs.md                -- Documentation enricher prompt
│   │   ├── git-history.md         -- Git history enricher prompt
│   │   └── dependencies.md        -- Dependencies enricher prompt
│   └── ...
│
├── tests/
│   ├── db/                        -- DB query tests (against test DB)
│   ├── agents/                    -- Agent tests (mocked SDK)
│   ├── execution/                 -- Worker/worktree tests
│   ├── dashboard/                 -- Route tests (supertest)
│   ├── auth/                      -- Auth middleware tests
│   └── fixtures/
│
├── infra/
│   ├── main.bicep                 -- Azure resource definitions
│   ├── container-app.bicep        -- Container App config
│   └── parameters.json            -- Environment-specific params
│
├── .github/
│   └── workflows/
│       ├── ci.yml                 -- Test + lint on PR
│       └── deploy.yml             -- Build → ACR → Container Apps on merge to main
│
├── Dockerfile                     -- Multi-stage build
├── docker-compose.yaml            -- Local dev (app + postgres)
├── drizzle.config.ts              -- Drizzle kit config
├── tailwind.config.ts             -- Tailwind theme (colors, fonts, custom utilities)
├── autonomous.config.yaml         -- Global defaults (classification, pipeline, etc.)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Milestones

---

### Milestone 1: Scaffold + Database + Auth

**Intent:** Get a deployable app that does nothing but let users sign in via Entra ID, see a landing page, and store their session in PostgreSQL. This validates the entire auth + DB + deploy chain before writing any business logic.

**Key files created:**
- `package.json` (deps: express, drizzle-orm, pg, @azure/msal-node, @azure/identity, @azure/keyvault-secrets, pino, htmx, tailwindcss)
- `tsconfig.json`
- `drizzle.config.ts`
- `tailwind.config.ts` — Custom theme: Hive color palette, Inter font, JetBrains Mono for code
- `src/db/schema.ts` — Full schema (all tables)
- `src/db/connection.ts` — Pool + Drizzle instance
- `src/db/migrate.ts` — Auto-migrate on startup
- `src/auth/entra.ts` — MSAL config, login/callback/logout
- `src/auth/middleware.ts` — requireAuth, requireRole, injectUser
- `src/auth/session.ts` — express-session + connect-pg-simple
- `src/db/queries/users.ts` — findOrCreateByEntraOid
- `src/dashboard/server.ts` — Express app with auth routes + static file serving
- `src/dashboard/views/layout.ts` — App shell: sidebar nav, topbar with user avatar, Tailwind + Inter font via CDN
- `src/dashboard/views/components.ts` — Design system foundation: button, badge, card, input helpers
- `src/logger.ts` — Pino to stdout
- `src/index.ts` — Entry point
- `docker-compose.yaml` — Local dev: app + postgres
- `Dockerfile` — Multi-stage build
- `drizzle/migrations/0001_initial.sql`

**Verification:**
```bash
docker compose up -d postgres
npm run db:migrate
npm run dev
# Visit http://localhost:3000 → redirected to Microsoft login
# After login → see "Welcome, <name>" + role badge
npm test -- tests/auth/ tests/db/
```

---

### Milestone 2: Task CRUD + Dashboard Core

**Intent:** Users can create tasks, view them, filter by status/user/repo. The dashboard shows the task list with HTMX-powered filtering and detail panels. This milestone establishes the full UX — sidebar navigation, command palette, keyboard shortcuts, toast notifications, pipeline visualization. No pipeline execution yet — just manual state management via the UI.

**Key files created/modified:**
- `src/domain/types.ts` — Enums (TaskStatus, TaskType, TaskSize, Workflow, etc.)
- `src/domain/state-machine.ts` — Allowed transitions map + `canTransition(from, to)`
- `src/domain/config.ts` — Load YAML defaults + DB config overrides
- `src/db/queries/tasks.ts` — create, getById, list (with filters), updateStatus, count
- `src/db/queries/repos.ts` — findOrCreate
- `src/dashboard/routes/tasks.ts` — GET /tasks, GET /api/tasks, POST /api/tasks, POST /api/tasks/:id/action
- `src/dashboard/routes/dashboard.ts` — GET / (home page: status cards, active agents, recent tasks)
- `src/dashboard/views/components.ts` — Full component library: cards, badges, buttons, tables, modals, toasts, pipeline step indicator, stat cards
- `src/dashboard/views/tasks.ts` — Task list with inline actions (approve/reject), pipeline visualization, detail slide-over panel, create form
- `src/dashboard/views/dashboard.ts` — Home page: Linear-style overview with status cards + recent activity
- `src/dashboard/public/commands.ts` — Command palette (Cmd+K): search tasks, navigate views, quick actions. Keyboard shortcuts: j/k navigate, a approve, r reject, n new task
- `src/dashboard/public/htmx-ext.ts` — Toast notification system (bottom-right, slide-up), HTMX event handlers
- `src/vault/keyvault.ts` — Get/set secrets (user tokens)
- `src/dashboard/routes/profile.ts` — User profile page, add/remove tokens
- `src/dashboard/views/profile.ts` — Token management UI

**Verification:**
```bash
npm run dev
# Create a task via dashboard form
# See it in task list with "pending" status
# Filter by status, by repo — tabs update via HTMX
# View task detail in slide-over panel (not modal)
# Use Cmd+K → search for task → navigate
# Use j/k to move through task list, 'a' to approve
# Add a GitHub token via profile page
# Admin: manually change task status → toast notification appears
# Resize browser to 768px → sidebar collapses to icons
npm test -- tests/db/tasks tests/dashboard/tasks
```

---

### Milestone 3: Pipeline Agents (Route → Enrich → Gate)

**Intent:** Wire up the first three pipeline stages. A pending task gets classified by the router, enriched by multiple enrichers (codebase, docs, git-history, dependencies — same plugin pattern as producers), and presented to the gate (human or AI). Each enricher writes to the `enrichment_runs` table; results are merged into `tasks.enrichment`. Cost tracking goes to the `costs` table. Gate decisions go to the `gate_decisions` table.

**Enricher architecture** (mirrors producers):
- `Enricher` interface: `{ name: string; run(task, repoDir, priorResults, config): Promise<EnrichmentResult> }`
- `runEnrichers(task, enabledEnrichers, config)`: runs all enabled enrichers **sequentially**, each receiving prior enrichers' output, merges into single `enrichment` jsonb
- Sequential means later enrichers can build on earlier context (e.g. docs enricher finds README → codebase enricher references it)
- Each enricher can be enabled/disabled per config
- New enrichers added by implementing the interface + registering in config

**Built-in enrichers:**
- **codebase** — Related files, patterns, test coverage (port of v1 enricher)
- **docs** — README, API specs, architecture docs, .hive.yaml
- **git-history** — Recent commits, blame info, change frequency hotspots
- **dependencies** — package.json analysis, lock file, known vulnerabilities

**Key files created/modified:**
- `src/agents/sdk.ts` — Claude SDK wrapper (port from v1, add cost recording to DB)
- `src/agents/retry.ts` — Exponential backoff + circuit breaker (port from v1)
- `src/agents/router.ts` — Task classification → updates task.size/type/model/workflow
- `src/enrichers/base.ts` — Enricher interface, `runEnrichers()` runner, result merger
- `src/enrichers/codebase.ts` — Port of v1 enricher
- `src/enrichers/docs.ts` — Documentation analysis
- `src/enrichers/git-history.ts` — Git log/blame analysis
- `src/enrichers/dependencies.ts` — Dependency/vulnerability analysis
- `src/agents/gate.ts` — AI gate evaluation → inserts gate_decision, updates task.status
- `src/db/queries/costs.ts` — recordCost, getTodayTotal, getUserTotal, checkBudget
- `src/db/queries/gate-decisions.ts` — recordDecision, listByTask
- `src/db/queries/enrichment-runs.ts` — recordRun, listByTask, mergeResults
- `src/db/queries/active-agents.ts` — register, unregister, listActive, cleanupStale
- `src/dashboard/routes/tasks.ts` — POST /api/tasks/:id/approve, /reject, /rework (human gate)
- `src/dashboard/views/tasks.ts` — Gate decision display, enrichment breakdown, approve/reject buttons
- `prompts/router.md`, `prompts/gate.md` — Agent system prompts
- `prompts/enrichers/*.md` — Per-enricher system prompts
- `autonomous.config.yaml` — Classification rules, gate mode, budget settings, enricher config:
  ```yaml
  enrichers:
    codebase: { enabled: true, model: sonnet, max_turns: 30, budget: 3.0 }
    docs: { enabled: true, model: haiku, max_turns: 10, budget: 0.5 }
    git_history: { enabled: true, model: haiku, max_turns: 10, budget: 0.5 }
    dependencies: { enabled: true, model: haiku, max_turns: 10, budget: 0.5 }
    # runs sequentially in listed order — later enrichers can use prior results
  ```

**Verification:**
```bash
npm run dev
# Create a task, then manually trigger: npm run cli -- triage <task-id>
# Verify task gets classification (check DB)
# Trigger: npm run cli -- enrich <task-id>
# Verify: enrichment_runs table has 4 rows (one per enricher)
# Verify: tasks.enrichment has merged results from all enrichers
# Verify: costs table has entries for each enricher
# If gate=human: task appears in "needs approval" tab
# If gate=ai: task auto-approved
# Check gate_decisions table has entry
# Disable one enricher in config, re-enrich → verify only 3 run
npm test -- tests/agents/ tests/enrichers/
```

---

### Milestone 4: Worker + Git + Review Gate

**Intent:** Approved tasks get executed. Worker creates a git worktree using the task creator's credentials (from Key Vault), runs the Claude agent, then the review gate verifies the output. On pass → push + PR. On rework → refine + retry. Per-user git credentials are resolved at execution time.

**Key files created/modified:**
- `src/execution/worktree.ts` — Create/cleanup worktrees on local ephemeral disk (port from v1, add per-user creds)
- `src/execution/git-provider.ts` — GitHub + Azure DevOps abstraction (port from v1)
- `src/execution/worker.ts` — Flow + epic workflows (port, adapt to DB state)
- `src/execution/review-gate.ts` — Verification + code review + security review
- `src/agents/refiner.ts` — Task rewriting for rework
- `src/agents/decomposer.ts` — Epic → milestone breakdown
- `src/db/queries/code-reviews.ts` — Record review results
- `src/integrations/azure-devops.ts` — Azure DevOps REST API (port from v1)
- `prompts/flow.md`, `prompts/milestone.md` — Worker system prompts
- `src/domain/types.ts` — WorktreeInfo, ReviewGateResult, etc.

**Verification:**
```bash
# Create + approve a small task targeting a test repo
npm run cli -- execute <task-id>
# Verify: worktree created, changes committed, PR created
# Verify: review gate ran (check code_reviews table)
# Verify: task status = completed, pr_url set
# Test rework: create task that will fail review, verify rework cycle
# Test epic: create large task, verify decomposition into milestones
npm test -- tests/execution/
```

---

### Milestone 5: Daemon Orchestration

**Intent:** Replace the v1 module-scope daemon with a `Daemon` class that polls the database for work, sequences pipeline stages, manages the worker pool, and tracks active agents in the DB. This is the "turn it on and walk away" milestone.

**Key files created/modified:**
- `src/daemon/daemon.ts` — `Daemon` class with:
  - `start()` / `stop()` lifecycle
  - DB poll loop (every 5s): pick next pending/approved/rework task
  - Pipeline sequencing: route → enrich → gate → execute
  - Worker pool: concurrent execution up to `max_concurrent_workers`
  - Active agent tracking via DB (survives restart)
  - Budget checking before processing
  - Per-user concurrent limit (max 2 workers per user)
  - Graceful shutdown (finish in-flight, update DB)
- `src/daemon/stale-tasks.ts` — Query for tasks stuck in status too long
- `src/daemon/scheduler.ts` — Producer scheduling (setInterval, mutual exclusion)
- `src/cli.ts` — `daemon` command starts Daemon class
- `src/dashboard/routes/dashboard.ts` — Show active agents from DB

**Verification:**
```bash
npm run cli -- daemon
# Submit 3 tasks via dashboard
# Verify: tasks automatically flow through pipeline
# Verify: active agents visible on dashboard during execution
# Kill daemon (Ctrl+C), restart → verify active_agents table correct, tasks resume
# Verify: per-user budget enforcement (exceed limit → task deferred)
npm test -- tests/daemon/
```

---

### Milestone 6: Producers + Notifications

**Intent:** Auto-discovery of tasks. Producers (log-scanner, bug-hunter, security-scanner, feature-scout, self-monitor) run on configurable schedules, scan repos, and create tasks. Notifications go to Slack/Teams. Producer runs tracked in DB.

**Key files created/modified:**
- `src/producers/base.ts` — Producer interface + dedup (check DB instead of scanning files)
- `src/producers/log-scanner.ts` — Port from v1
- `src/producers/bug-hunter.ts` — Port from v1
- `src/producers/security-scanner.ts` — Port from v1
- `src/producers/feature-scout.ts` — Port from v1
- `src/producers/self-monitor.ts` — Port from v1 (scan Pino logs or DB for errors)
- `src/db/queries/producer-runs.ts` — Record runs
- `src/notifications.ts` — Slack/Teams webhooks (port from v1)
- `src/integrations/azure-monitor.ts` — KQL queries (port from v1)
- `src/daemon/scheduler.ts` — Wire producer scheduling into Daemon

**Verification:**
```bash
npm run cli -- daemon
# Configure a producer target in settings
# Wait for scheduled run (or trigger manually: npm run cli -- run bug-hunter)
# Verify: tasks created in DB with source=producer:bug-hunter
# Verify: producer_runs table has entry
# Verify: Slack/Teams notification sent for new tasks
npm test -- tests/producers/
```

---

### Milestone 7: Full Dashboard

**Intent:** Complete all remaining dashboard pages for features that already work from earlier milestones: cost reports, global + per-repo settings management, producer status/config, and prompt editor. These are the "admin power user" screens.

**Key files created/modified:**
- `src/dashboard/routes/costs.ts` — Cost reports (daily/monthly, by user/repo/agent/model)
- `src/dashboard/routes/settings.ts` — Global settings + per-repo settings (RepoSettings form)
- `src/dashboard/routes/producers.ts` — Producer status, last run, target configuration
- `src/dashboard/views/costs.ts` — Cost report views: summary cards, breakdown tables, trend sparklines
- `src/dashboard/views/settings.ts` — Two-tab layout: "Global Defaults" + "Repos" (list of repo cards, each with same RepoSettings form, overrides highlighted)
- `src/dashboard/views/producers.ts` — Producer cards with health, schedule, last run stats
- `src/prompts.ts` — Prompt loading (from prompts/ directory)
- `src/dashboard/routes/prompts.ts` — Prompt browser + editor
- `src/dashboard/views/prompts.ts` — Sidebar file list + editor with monospace textarea

**Verification:**
```bash
npm run dev
# Cost reports: view daily/monthly breakdown by user, repo, agent, model
# Settings: change global classification rules, gate mode, enrichers, budgets
# Settings: add a repo, configure per-repo overrides (gate mode, preview, enrichers)
# Settings: verify overrides take precedence over global defaults
# Producers: see status, trigger manual run, edit targets
# Prompts: browse and edit agent system prompts
npm test -- tests/dashboard/
```

---

### Milestone 8: Hivemind — Structured Learning System

**Intent:** Build a next-level knowledge system that makes The Hive measurably smarter over time. Replace v1's flat markdown files with structured learnings that have confidence scores, scoped retrieval, feedback loops from task outcomes, and a weekly retrospective agent. Every completed task either reinforces or contradicts existing knowledge, and human PR feedback becomes the highest-value learning source.

**Schema:**
```sql
learnings
  id              serial PK
  scope           text NOT NULL       -- universal | lang:typescript | framework:express | repo:owner/name
  category        text NOT NULL       -- convention | pattern | anti-pattern | process | domain | cost
  content         text NOT NULL       -- the learning itself (markdown)
  confidence      numeric(3,2) DEFAULT 0.50  -- 0.00 to 1.00
  reinforcements  integer DEFAULT 0   -- times confirmed by positive outcomes
  contradictions  integer DEFAULT 0   -- times contradicted by negative outcomes
  source_task_ids text[]              -- tasks that contributed to this learning
  tags            text[]              -- searchable: ['auth', 'validation', 'testing', 'express']
  created_at      timestamptz
  updated_at      timestamptz
  last_used_at    timestamptz         -- last time retrieved for a task prompt
  superseded_by   integer FK → learnings

learning_events
  id              serial PK
  learning_id     integer FK → learnings
  event_type      text NOT NULL       -- reinforced | contradicted | created | updated | superseded | decayed
  task_id         text FK → tasks
  evidence        text                -- what happened that triggered this
  created_at      timestamptz
```

**Feedback loop (runs after every task completion):**
- PASS first try → reinforce learnings that were in this task's prompt (+0.05 confidence)
- PASS first try → extract agent proposes new candidate learnings from successful patterns
- REWORK needed → analyze rework feedback, create anti-pattern learning if recurring
- REWORK needed → contradict learnings that were in prompt but didn't prevent the issue (-0.05)
- FAILED → strengthen anti-pattern learnings, strong contradiction for prompt learnings (-0.10)
- Human PR feedback → parse comments, create high-confidence learnings (0.80 initial)

**Relevance-based retrieval (replaces "dump everything"):**
- Filter by scope hierarchy: universal → language → framework → repo
- Filter by tag overlap with task context (derived from enrichment)
- Sort by confidence DESC, reinforcements DESC
- Limit to top 15-20 most relevant learnings per task prompt

**Confidence lifecycle:**
- Created: 0.50 (or 0.80 for human PR feedback)
- Reinforced: min(1.0, confidence + 0.05)
- Contradicted: max(0.0, confidence - 0.05)
- Monthly decay: confidence *= 0.95 (if not used in 30 days)
- Auto-archived: confidence < 0.2 AND reinforcements < 3
- Superseded: newer contradicting learning with higher confidence replaces it

**Retrospective agent (weekly or every N tasks):**
- Analyzes all completed tasks in period
- Reports: first-pass rate, rework rate, failure rate, cost trends
- Identifies: top performing learnings, decaying learnings, blind spots (recurring failures with no learning)
- Proposes: new learnings, promotions (repo → universal), deprecations
- Cost insights: which enrichers/learnings actually impact outcomes
- Posted to dashboard as weekly summary

**Key files created/modified:**
- `src/db/schema.ts` — Add learnings + learning_events tables
- `src/db/queries/learnings.ts` — CRUD, retrieve by relevance, reinforce, contradict, decay
- `src/db/queries/learning-events.ts` — Record events, query history
- `src/agents/feedback-loop.ts` — Post-task analysis: reinforce/contradict/extract new learnings
- `src/agents/retrospective.ts` — Weekly analysis agent: metrics, trends, proposals
- `src/agents/keeper.ts` — Rewritten: curates learnings, manages confidence, handles superseding
- `src/agents/gate-analyst.ts` — Feeds patterns into learnings (not separate markdown)
- `src/agents/code-quality-analyst.ts` — Feeds patterns into learnings
- `src/execution/worker.ts` — Updated: calls `retrieveLearnings()` to inject relevant knowledge into prompt
- `src/execution/review-gate.ts` — Updated: calls feedback-loop after verdict
- `src/daemon/daemon.ts` — Updated: schedules retrospective agent, runs confidence decay
- `src/dashboard/routes/hivemind.ts` — Knowledge explorer, weekly report, learning detail
- `src/dashboard/views/hivemind.ts` — Learning cards with confidence bars, scope filters, category tabs, weekly report view, trend charts
- `prompts/feedback-loop.md` — "Analyze this task outcome and propose learning updates"
- `prompts/retrospective.md` — "Analyze the last N tasks and produce a weekly intelligence report"

**Verification:**
```bash
npm run dev
# Complete a task successfully → check: related learnings reinforced
# Complete a task with rework → check: anti-pattern learning created
# Submit human PR feedback → check: high-confidence learning created
# View Hivemind page → see learnings with confidence bars, scoped by repo
# Filter: universal vs repo-specific learnings
# Run retrospective manually: npm run cli -- retrospective
# Check: weekly report on dashboard with metrics + proposals
# Verify: subsequent tasks for same repo include relevant learnings in prompt
# Verify: irrelevant learnings NOT in prompt (check agent logs)
# Wait 30 days (or simulate) → check: unused learnings decay
npm test -- tests/agents/feedback-loop tests/agents/retrospective tests/db/learnings
```

---

### Milestone 9: Deployment — Container Apps + CI/CD

**Intent:** Production deployment pipeline. Dockerfile builds the app, GitHub Actions pushes to ACR, deploys to Azure Container Apps. Azure Files for worktree storage. Key Vault for secrets. PostgreSQL Flexible Server provisioned. Bicep templates for infrastructure-as-code.

**Key files created/modified:**
- `Dockerfile` — Multi-stage build (builder + runtime with git, gh CLI)
- `.github/workflows/ci.yml` — On PR: lint + test
- `.github/workflows/deploy.yml` — On merge to main: build → ACR → Container Apps
- `infra/main.bicep` — Resource group, Container App Environment, PostgreSQL, Key Vault, ACR
- `infra/container-app.bicep` — Container App definition (env vars, scaling, ephemeral storage)
- `infra/parameters.json` — Environment-specific values
- `docker-compose.yaml` — Updated for local dev (postgres + app)

**Azure resources provisioned:**
- Azure Container App (1 replica, 1 vCPU / 2GB RAM, always-on, ephemeral local disk for repos)
- Azure Database for PostgreSQL Flexible Server (Burstable B1ms)
- Azure Key Vault (per-user git tokens + Anthropic API key)
- Azure Container Registry (Basic tier)
- Azure Log Analytics workspace (for container logs)
- Managed Identity (Container App → Key Vault + ACR access)

**Verification:**
```bash
# Local:
docker compose up  # App + Postgres locally
npm test           # All tests pass

# Deploy infra:
az deployment group create -g the-hive -f infra/main.bicep -p infra/parameters.json

# Push to main → GitHub Actions:
# 1. Runs tests
# 2. Builds Docker image
# 3. Pushes to ACR
# 4. Updates Container App revision
# 5. Health check passes

# Verify:
curl https://the-hive.<region>.azurecontainerapps.io/api/health
# Login via browser → full functionality
```

---

### Milestone 10: Preview Environments

**Intent:** Gate agents spin up the application under test — including all its dependencies (Postgres, Redis, Cosmos emulator, etc.) — validate the implementation by actually hitting it, and keep it running for human validation via a dashboard link. Uses a dedicated Docker host VM for full container support. Each preview is fully isolated (own containers, own network). Repos that use TestContainers just work.

**Why a dedicated Docker host (not shared services or DinD):**
- **Full isolation**: each preview gets its own Postgres, Cosmos emulator, Redis — no shared state, no schema conflicts
- **TestContainers works natively**: .NET repos using TestContainers + Cosmos emulator just work — they need a real Docker daemon
- **Any docker-compose.yml works**: no restrictions on what services a repo can spin up
- **Image caching**: after first pull, subsequent previews start fast
- **Cost**: ~$50/month for a B2s VM. Worth it for real validation

**Three preview types** (per-repo `.hive.yaml`):
```yaml
# Type 1: compose — The Hive uses repo's docker-compose for full stack
preview:
  type: compose
  compose_file: docker-compose.test.yml
  app_service: web                       # which service is the app
  port: 3000
  health_check: /api/health
  startup_timeout: 120s

# Type 2: testcontainers — app manages its own containers via TestContainers
preview:
  type: testcontainers
  start: dotnet run --project src/Api --launch-profile Preview
  port: 5000
  health_check: /health
  startup_timeout: 180s                  # Cosmos emulator is slow to start
  env:
    ASPNETCORE_ENVIRONMENT: Preview

# Type 3: process — no Docker, run directly in The Hive container
preview:
  type: process
  start: npm start
  port: 3000
  health_check: /
  startup_timeout: 30s
```

**How it works:**
1. Worker finishes implementation in worktree
2. Review gate runs lint/build/test (existing M4 behavior)
3. If `.hive.yaml` has `preview:` config:
   a. **type=compose**: PreviewManager rsyncs worktree to Docker host, runs `docker compose -p hive-{taskId} up -d`, waits for health check
   b. **type=testcontainers**: rsyncs worktree, runs start command on Docker host — TestContainers spins up its own containers on the same daemon
   c. **type=process**: spawns child process directly in The Hive container (no Docker needed)
4. Gate agent gets preview URL, validates via HTTP requests (checks the feature actually works)
5. If pass + human gate → preview stays running, dashboard shows clickable link
6. Human clicks link → Express reverse-proxies through to Docker host:PORT
7. Human approves → PR created, preview torn down (`docker compose down -v`)
8. Auto-cleanup after configurable timeout (default 30min)
9. If no `preview:` config → existing behavior (just lint/build/test)

**Architecture:**
```
Container App (The Hive)                    Docker Host VM (B2s: 2 vCPU, 4GB)
┌────────────────────────┐                  ┌──────────────────────────────────┐
│                        │                  │                                  │
│  Express (:3000)       │   Docker API     │  Preview: HIVE-123               │
│  ├── /preview/:taskId  │ ──over TLS──→    │  ├── app (node:20 → :3000)       │
│  │   reverse proxy ────│──────────────→   │  ├── postgres:16                 │
│  │                     │                  │  └── redis:7                     │
│  PreviewManager        │                  │  Network: hive-123-net           │
│  ├── docker (dockerode)│                  │                                  │
│  ├── startPreview()    │                  │  Preview: HIVE-456               │
│  │   → rsync worktree  │                  │  ├── app (dotnet:8 → :5000)      │
│  │   → compose up      │                  │  ├── cosmos-emulator (TestCont.) │
│  ├── stopPreview()     │                  │  └── azurite                     │
│  │   → compose down -v │                  │  Network: hive-456-net           │
│  └── cleanupStale()    │                  │                                  │
│                        │                  │  (max 3-5 concurrent)            │
└────────────────────────┘                  └──────────────────────────────────┘
```

**Key files created/modified:**
- `src/execution/preview/manager.ts` — `PreviewManager` class:
  - Uses `dockerode` to talk to Docker host via TLS API (port 2376)
  - `startPreview(taskId, worktree, hiveYaml)`:
    - type=compose: rsync worktree to Docker host, `docker compose -p hive-{taskId} up -d`, poll health check
    - type=testcontainers: rsync worktree, run start command on Docker host
    - type=process: spawn local child process, allocate port
  - `stopPreview(taskId)` → `docker compose -p hive-{taskId} down -v`, free port
  - `cleanupStale()` → kill previews past timeout
  - Port allocation: 4001-4099 on Docker host, mapped back through reverse proxy
- `src/execution/preview/proxy.ts` — Express reverse proxy middleware:
  - `GET /preview/:taskId/*` → proxy to `docker-host:PORT` (compose/testcontainers) or `localhost:PORT` (process)
  - Auth-protected (must be logged in)
  - WebSocket passthrough (for apps that use WS)
- `src/execution/preview/validator.ts` — Agent validation logic:
  - Injects preview URL into gate agent prompt
  - Agent uses HTTP requests to validate feature behavior
  - Collects validation results + screenshots (if applicable)
- `src/execution/review-gate.ts` — Updated: after verification passes, start preview if configured
- `src/db/queries/preview-logs.ts` — Log preview lifecycle events
- `src/dashboard/views/tasks.ts` — "Preview available" link + status + auto-cleanup countdown
- `src/dashboard/routes/tasks.ts` — Preview proxy route + manual stop/extend buttons
- `src/hive-yaml.ts` — Parse `preview:` config section (type, compose_file, port, health_check, env, startup_timeout)
- `autonomous.config.yaml`:
  ```yaml
  preview:
    enabled: true
    max_concurrent: 3
    cleanup_timeout_minutes: 30
    docker_host:
      ip: 10.0.1.5                    # Docker host VM private IP
      port: 2376
      tls_cert_vault_secret: docker-tls-cert
      tls_key_vault_secret: docker-tls-key
      tls_ca_vault_secret: docker-tls-ca
    port_range: [4001, 4099]
  ```
- `infra/docker-host.bicep` — Docker host VM: B2s, Docker Engine, TLS certs, firewall (only allow Container App outbound IP on 2376)

**Verification:**
```bash
# Setup: Docker host VM provisioned with Docker + TLS
# TLS certs stored in Key Vault

npm run dev
# Test type=compose: task for Node.js repo with docker-compose.test.yml
#   → verify: docker compose project running on Docker host
#   → verify: health check passes
#   → visit /preview/HIVE-xxx/ → see running app with Postgres
#   → approve → compose down -v, containers cleaned up

# Test type=testcontainers: task for .NET repo using TestContainers + Cosmos
#   → verify: app starts, TestContainers spins up Cosmos emulator
#   → verify: health check passes
#   → visit /preview/HIVE-xxx/ → see running .NET app

# Test type=process: task for simple Node.js app (no deps)
#   → verify: spawned directly in The Hive container
#   → no Docker host involved

# Test cleanup: start preview, wait 30min → auto-cleaned
# Test concurrent: start 3 previews simultaneously → all work
# Test limit: try to start 4th when max_concurrent=3 → queued or rejected

npm test -- tests/execution/preview/
```

---

## Risks & Unknowns

| Risk | Impact | Probe |
|------|--------|-------|
| Container App disk limits | Ephemeral disk for repo clones has size limits (Container Apps default ~1-5GB) | Check: Container App ephemeral storage quota. If insufficient for many repos, request larger disk or prune clones aggressively |
| Re-clone time on restart | Container restart loses all repo clones, first task per repo needs fresh clone | Acceptable: ~30s per repo. With 10-20 repos, worst case ~10 min warmup. Clones are cached after first use |
| Entra ID app registration | Requires Azure AD admin to register the app + configure redirect URIs | Check: does the team have Azure AD admin access? Register app early in M1 |
| Key Vault latency | Fetching per-user tokens on every git operation could add latency | Benchmark: Key Vault `getSecret()` latency. If >500ms, cache tokens in-memory with 5min TTL |
| Drizzle migration on Container App | Auto-migrate on startup could race if multiple replicas start simultaneously | Not a concern for 1 replica. If scaling later, use a migration job |
| Claude Agent SDK `bypassPermissions` | Requires SDK to support this in non-CLI context | Already verified working in v1 — port the exact same pattern |
| Azure DevOps PR creation | v1 had issues with URL encoding for project/repo paths | Already fixed in v1 (`36b60bd`) — port the fix |
| HTMX + Express session | HTMX polls with cookies; session expiry during long operations could cause 401 | Set session TTL to 24h, add HTMX `responseError` handler for 401 → redirect to login |
| Cost of PostgreSQL Flexible Server | Burstable B1ms may be underpowered under heavy agent load | Monitor: if query latency >100ms, upgrade to B2s (~$26/month) |
| Preview port exposure | Previews run on Docker host ports 4001+, not directly accessible | Solution: Express reverse proxy on :3000 at `/preview/:taskId/*` proxies to Docker host:PORT. Auth required. Docker host firewall blocks all external access |
| Docker host resource limits | 3 concurrent previews with Cosmos emulator could exhaust 4GB RAM | Monitor: if hitting limits, upgrade Docker host to B4s (4 vCPU, 8GB, ~$100/month) or reduce max_concurrent |
| Preview security | Agent-written code runs on Docker host | Mitigation: Docker host is isolated (firewall: only Container App can reach it). Each preview in its own Docker network. Auto-cleanup after timeout. No internet egress from preview containers |
| Cosmos emulator startup time | Azure Cosmos emulator takes 60-90s to start | Set startup_timeout to 180s for repos using it. Agent waits for health check before validating |
| Docker host VM management | Another VM to patch/maintain | Mitigate: enable Azure auto-patching. Docker host is stateless (all images pulled, no persistent data). Can be rebuilt from Bicep anytime |
| Worktree transfer to Docker host | Need to copy worktree files to Docker host for building | Use rsync over SSH or Docker volume mount. For large repos, only copy changed files (git diff --name-only) |

---

## Monthly Cost Estimate

| Resource | Tier | Monthly |
|----------|------|---------|
| Container App | 1 vCPU / 2GB, always-on | ~$55 |
| PostgreSQL | Burstable B1ms + 32GB storage | ~$15 |
| Docker Host VM | B2s (2 vCPU / 4GB) for preview environments | ~$50 |
| Container Registry | Basic | ~$5 |
| Key Vault | ~50 operations/day | ~$1 |
| Log Analytics | ~1GB/month ingestion | ~$3 |
| **Total infra** | | **~$129/month** |
| Anthropic API | Variable | $variable |

---

Next: /probe 'Milestone 1: Scaffold + Database + Auth'
