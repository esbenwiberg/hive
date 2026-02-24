<div align="center">

# The Hive

**Autonomous task orchestration for engineering teams.**

Route, enrich, gate, execute, and review code changes — end to end — powered by Claude.

[![CI](https://github.com/esbenwiberg/hive/actions/workflows/ci.yml/badge.svg)](https://github.com/esbenwiberg/hive/actions/workflows/ci.yml)
[![Deploy](https://github.com/esbenwiberg/hive/actions/workflows/deploy.yml/badge.svg)](https://github.com/esbenwiberg/hive/actions/workflows/deploy.yml)

</div>

---

## What is The Hive?

The Hive is a self-hosted system that turns task descriptions into pull requests. You describe what needs to change, and The Hive classifies the task, gathers context from your codebase, decides whether it's safe to proceed, implements the changes in an isolated git worktree, reviews its own work, and opens a PR — all without human intervention (unless you want it).

It supports multiple concurrent users, each with their own git credentials, cost budgets, repo access permissions, and approval workflows.

### The Pipeline

```
                    ┌─────────┐
                    │ PENDING │  User creates via dashboard, or producer discovers
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │ QUEUED  │  Router classifies: type, size, model, workflow
                    └────┬────┘
                         │
                    ┌────▼──────┐
                    │ ENRICHING │  6 enrichers run sequentially:
                    │           │  codebase → docs → git history → dependencies
                    │           │  → architect (blueprint + clarification) → scorer
                    └────┬──────┘
                         │
                    ┌────▼────┐
                    │  READY  │  Gate: human approval, AI evaluation, or auto-approve
                    └────┬────┘
                         │
                    ┌────▼──────┐
                    │ APPROVED  │
                    └────┬──────┘
                         │
                    ┌────▼───────┐
                    │ EXECUTING  │  Claude + tools (read/write/list/run) in isolated worktree
                    │            │  Multi-turn agentic loop, milestone support
                    └────┬───────┘
                         │
                    ┌────▼───────┐
                    │ REVIEWING  │  Code review gate (verdict: pass or rework)
                    └────┬───────┘
                         │
               ┌─────────┼─────────┐
               │                   │
          ┌────▼───┐          ┌────▼───┐
          │  DONE  │          │ REWORK │  Max 2 cycles, then FAILED
          │  → PR  │          │→ retry │
          └────┬───┘          └────────┘
               │
          ┌────▼───┐
          │ MERGED │
          └────────┘

  Also: FAILED (retry/re-review/re-approve), SUSPENDED, CANCELLED, REJECTED
```

## Features

- **Full pipeline automation** — route, enrich, gate, execute, review, PR (14 task states)
- **6 enrichers** — codebase, docs, git history, dependencies, architect (blueprint + clarification), scorer — run sequentially, each building on prior results
- **Tool use execution** — Claude implements changes via read/write/list/run tools in a multi-turn agentic loop
- **Three gate modes** — human approval, AI evaluation, or auto-approve for low-risk tasks
- **Rework loop** — failed reviews trigger refinement and re-execution (max 2 cycles), with manual re-review and re-approve paths
- **Epic workflows** — large tasks decomposed into sequential milestones, each executed independently
- **Preview environments** — spin up the app under test (Docker Compose, TestContainers, or process) for validation before merging
- **6 producers** — auto-discover tasks by scanning logs, hunting bugs, finding security issues, scouting features, auditing docs, and self-monitoring
- **Hivemind** — structured learning system with confidence scores, feedback loops, and weekly retrospectives
- **Per-user cost tracking** — daily budgets, per-task limits, cost breakdown by agent/model/repo
- **Azure Entra ID auth** — "Sign in with Microsoft", role-based access (viewer/user/admin)
- **Per-user git credentials** — GitHub tokens and Azure DevOps PATs stored in Key Vault
- **Browser validation** — optional headless Playwright checks for preview environments
- **Per-user repo access** — fine-grained permissions controlling which repos each user can see and work on
- **Per-task skipPreview** — user, architect, or worker can skip preview for individual tasks
- **Bulk actions** — admin-only bulk delete and task reset
- **Debug panel** — lazy-loaded per-task debug info in slide-over detail view
- **Estimated cost** — scorer predicts token/cost before execution; actual cost tracked alongside
- **HTMX dashboard** — fast, server-rendered UI with Tailwind CSS, keyboard shortcuts, command palette

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript 5.7 |
| Web | Express 4, HTMX 2, Tailwind CSS 3 |
| Database | PostgreSQL 16, Drizzle ORM |
| AI | Anthropic Claude (via `@anthropic-ai/sdk`) |
| Auth | Azure Entra ID (MSAL), express-session |
| Secrets | Azure Key Vault |
| Infra | Azure Container Apps, Bicep IaC |
| CI/CD | GitHub Actions → ACR → Container Apps |
| Testing | Vitest 3, Playwright (browser validation) |
| Logging | Pino → stdout → Azure Monitor |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Azure Container App                     │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   Express     │  │   Daemon     │  │   Producers    │  │
│  │   Dashboard   │  │   Pipeline   │  │   (scheduled)  │  │
│  │   + Entra ID  │  │   Workers    │  │                │  │
│  │   + HTMX      │  │              │  │                │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         └──────────┬───────┴──────────────────┘           │
│                    │                                      │
│              ┌─────▼─────┐    /repos (ephemeral)          │
│              │  Drizzle   │    git clones + worktrees     │
│              │  ORM       │    re-cloned on restart        │
│              └─────┬─────┘                                │
└────────────────────┼──────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
  ┌───────────┐ ┌──────────┐ ┌─────────┐
  │ PostgreSQL│ │Key Vault │ │  ACR    │
  │ Flex Srvr │ │ (tokens) │ │(images) │
  └───────────┘ └──────────┘ └─────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- An Anthropic API key

### 1. Clone and install

```bash
git clone https://github.com/esbenwiberg/hive.git
cd hive
npm install
```

### 2. Start PostgreSQL

```bash
docker compose up -d postgres
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set:
#   ANTHROPIC_API_KEY=sk-ant-...
#   DATABASE_URL=postgresql://hive:hive@localhost:5432/hive
#   SESSION_SECRET=<random-string>
```

### 4. Run migrations and start

```bash
npm run db:migrate
npm run dev
```

The dashboard is at [http://localhost:3000](http://localhost:3000).

> **Note:** Azure Entra ID is required for authentication. For local development without Entra ID configured, see [Auth Configuration](#auth-configuration) below.

### 5. Run with daemon (full autonomous mode)

```bash
npm run cli -- daemon
```

This starts the Express server, the pipeline daemon (polls for work every 5s), and the producer scheduler.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `SESSION_SECRET` | — | Session encryption key |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `ENTRA_CLIENT_ID` | — | Azure Entra ID app client ID |
| `ENTRA_CLIENT_SECRET` | — | Azure Entra ID app client secret |
| `ENTRA_TENANT_ID` | — | Azure AD tenant ID |
| `AZURE_KEYVAULT_URI` | — | Key Vault URI (omit for in-memory fallback) |
| `REDIRECT_URI` | — | OAuth callback URL |
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Pino log level |
| `HIVE_MODE` | — | Set to `daemon` to start daemon with server |
| `HIVE_MAX_WORKERS` | `5` | Max concurrent task workers |
| `HIVE_POLL_MS` | `5000` | Daemon poll interval (ms) |
| `HIVE_WORKTREE_DIR` | `/repos` | Git worktree storage path |

### autonomous.config.yaml

The main configuration file controls pipeline behavior:

```yaml
classification:
  defaultType: improvement
  defaultSize: medium

gate:
  mode: human          # human | ai | auto

budget:
  dailyDefault: 100.00
  perTaskMax: 25.00

enrichers:
  - { name: codebase,     enabled: true }
  - { name: docs,         enabled: true }
  - { name: git-history,  enabled: true }
  - { name: dependencies, enabled: true }
  - { name: architect,    enabled: true }
  - { name: scorer,       enabled: true }

preview:
  enabled: true
  max_concurrent: 3
  cleanup_timeout_minutes: 30
  port_range: [4001, 4099]
```

Settings can be overridden per-repo via the dashboard (stored in `repos.settings` JSONB column). Resolution order: repo settings > global DB config > YAML file defaults.

#### Azure AI Foundry Support

The Hive supports **Azure AI Foundry** as an alternative (or complement) to the Anthropic public API. You can route each pipeline component to a different provider and model — for example, use a cheap Azure-hosted Haiku deployment for the review gate but a powerful GPT-4.1 for the worker.

Three provider types are supported in `autonomous.config.yaml` under `models.componentProviders`:

| Type | Backend | Use case |
|---|---|---|
| `anthropic` | Anthropic public API | Default; uses `ANTHROPIC_API_KEY` |
| `azure-openai` | Azure AI Foundry (OpenAI-compatible endpoint) | GPT-4o, GPT-4.1, o-series, etc. |
| `azure-anthropic` | Anthropic models deployed on Azure AI Foundry | Claude on Azure without leaving your tenant |

```yaml
models:
  default:
    type: anthropic
    model: claude-sonnet-4-6

  componentProviders:
    # Route the review gate to a cheap Haiku on Azure AI Foundry
    review-gate:
      type: azure-anthropic
      endpoint: https://my-project.services.ai.azure.com
      deploymentName: claude-3-5-haiku
      apiKey: $AZURE_FOUNDRY_API_KEY
      model: claude-3-5-haiku-20241022

    # Use a powerful GPT deployment for code execution
    worker:
      type: azure-openai
      endpoint: https://my-resource.openai.azure.com
      deploymentName: gpt-4-1-deployment
      apiKey: $AZURE_OPENAI_API_KEY
      model: gpt-4.1
```

For a fully commented example covering all eight component names, see the `models:` block in [`autonomous.config.yaml`](./autonomous.config.yaml).

For technical details on the provider abstraction layer, see [`docs/internal/modules/agents.md` — Providers section](./docs/internal/modules/agents.md).

### Auth Configuration

The Hive uses Azure Entra ID for authentication. You need to register an application in Azure AD:

1. Go to Azure Portal → Azure Active Directory → App registrations → New registration
2. Set redirect URI to `http://localhost:3000/auth/callback` (dev) or your production URL
3. Create a client secret
4. Set `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, and `ENTRA_TENANT_ID` in your `.env`

Roles: `viewer` (read-only), `user` (create/approve tasks), `admin` (full access).

## Preview Environments

Repos can opt in to preview environments by adding a `.hive.yaml` file:

```yaml
# Docker Compose — full stack with dependencies
preview:
  type: compose
  compose_file: docker-compose.test.yml
  app_service: web
  port: 3000
  health_check: /api/health
  startup_timeout: 120s

# TestContainers — app manages its own containers
preview:
  type: testcontainers
  start: dotnet run --project src/Api
  port: 5000
  health_check: /health
  startup_timeout: 180s

# Process — run directly, no Docker
preview:
  type: process
  start: npm start
  port: 3000
  health_check: /
  startup_timeout: 30s
```

After the review gate passes, The Hive starts the preview, validates it via HTTP health checks, and shows a clickable link on the dashboard for human validation. Previews auto-clean after 30 minutes.

## CLI

```bash
# Start server + daemon + producers
npm run cli -- daemon

# Run a specific producer manually
npm run cli -- run bug-hunter --repo 1
npm run cli -- run security-scanner --repo 1
npm run cli -- run log-scanner --repo 1
npm run cli -- run feature-scout --repo 1
npm run cli -- run doc-auditor --repo 1
npm run cli -- run self-monitor
```

## Development

### Running tests

```bash
# Start test database
docker compose up -d postgres

# Run all tests
npm test

# Run specific test file
npx vitest run tests/agents/router.test.ts

# Type check
npm run typecheck
```

### Project structure

```
src/
├── agents/          # Claude agent wrappers (router, gate, refiner, decomposer, browser-validator, ...)
├── auth/            # Entra ID auth, session, middleware
├── daemon/          # Background orchestrator, scheduler, cleanup
├── dashboard/       # Express routes + HTMX views
│   ├── routes/      # HTTP handlers (tasks, costs, settings, workflow, hivemind, ...)
│   └── views/       # HTML template functions (Tailwind)
├── db/
│   ├── queries/     # One file per table (16 query modules)
│   └── schema.ts    # Drizzle table definitions
├── domain/          # Types, state machine (14 states), config
├── enrichers/       # Codebase, docs, git-history, dependencies, architect, scorer
├── execution/       # Worker, worktree, git provider, review gate, browser tools, preview
├── producers/       # Auto task discovery (6 producers)
├── integrations/    # Azure DevOps, Azure Monitor
└── vault/           # Key Vault client
```

### Database

PostgreSQL 16 with Drizzle ORM. Key tables:

- `users` — Entra ID users with roles and budgets
- `tasks` — 14-state pipeline with enrichment, gate, review, preview tracking
- `costs` — Per-agent, per-model cost records
- `learnings` — Hivemind knowledge base with confidence scores
- `learning_events` — Feedback loop events for learning entries
- `enrichment_runs` — Per-enricher results
- `code_reviews` — Review gate verdicts and findings
- `gate_decisions` — Gate approval/rejection records
- `active_agents` — Currently running agent tracking
- `task_events` — Activity log / heartbeat events per task
- `producer_runs` — Producer execution history
- `preview_instances` — Active preview environments
- `preview_logs` — Preview lifecycle events
- `user_repo_access` — Per-user repo permissions
- `user_credentials` — Encrypted git credentials (Key Vault refs)

Migrations in `drizzle/`. Auto-run on startup via `src/db/migrate.ts`.

## Deployment

### One-command setup

The setup script creates everything — resource group, Entra ID app, all Azure infrastructure, Key Vault secrets, GitHub Actions service principal with OIDC, and deploys the first container image:

```bash
./infra/setup.sh \
  --anthropic-key sk-ant-... \
  --github-repo esbenwiberg/hive
```

With preview environments:

```bash
./infra/setup.sh \
  --anthropic-key sk-ant-... \
  --github-repo esbenwiberg/hive \
  --deploy-docker-host \
  --docker-host-ssh-key ~/.ssh/id_rsa.pub
```

Run `./infra/setup.sh --help` for all options. The script is re-runnable — it skips resources that already exist.

To tear everything down:

```bash
./infra/teardown.sh
```

### What gets created

| Resource | Purpose | Tier |
|----------|---------|------|
| Resource Group | Container for all resources | — |
| Container App | The Hive application | 1 vCPU / 2GB |
| PostgreSQL Flexible Server | Database | Burstable B1ms, 32GB |
| Key Vault | API keys, git tokens, TLS certs | Standard |
| Container Registry | Docker images | Basic |
| Log Analytics | Container logs + metrics | PerGB2018 |
| Managed Identity | ACR pull + Key Vault access | — |
| Entra ID App | User authentication (OAuth) | — |
| GitHub Actions SP | CI/CD with OIDC (no stored secrets) | — |
| Docker Host VM | Preview environments (optional) | B2s |

### Manual Bicep deployment

If you prefer to run Bicep directly:

```bash
az deployment group create \
  -g the-hive \
  -f infra/main.bicep \
  -p postgresAdminPassword='<password>'
```

Then seed Key Vault secrets manually — see `infra/setup.sh` for the full list.

### CI/CD

After setup, every push to `main` automatically:

1. Runs TypeScript check + full test suite
2. Builds Docker image and pushes to ACR
3. Updates Container App to the new revision
4. Verifies health check passes

PRs run the test suite via `ci.yml`.

### Estimated monthly cost

| Resource | Tier | Monthly |
|----------|------|---------|
| Container App | 1 vCPU / 2GB | ~$55 |
| PostgreSQL | Burstable B1ms | ~$15 |
| Docker Host VM | B2s (optional) | ~$50 |
| Container Registry | Basic | ~$5 |
| Key Vault | ~50 ops/day | ~$1 |
| Log Analytics | ~1GB/month | ~$3 |
| **Total infra** | | **~$79–129/month** |

*Plus Anthropic API costs (variable).*

## License

Private repository. All rights reserved.
