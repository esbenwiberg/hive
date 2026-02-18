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

It supports 10 concurrent users, each with their own git credentials, cost budgets, and approval workflows.

### The Pipeline

```
                    ┌─────────┐
                    │  Task   │  User creates via dashboard, or producer discovers automatically
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │  Route  │  Claude classifies: type, size, model, workflow
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │ Enrich  │  4 enrichers gather context: codebase, docs, git history, dependencies
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │  Gate   │  Human approval, AI evaluation, or auto-approve (configurable)
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │Execute  │  Claude implements changes in isolated git worktree
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │ Review  │  Lint + build + test, code review, security review
                    └────┬────┘
                         │
               ┌─────────┼─────────┐
               │         │         │
          ┌────▼───┐ ┌───▼───┐ ┌──▼───┐
          │  Pass  │ │Rework │ │ Fail │
          │  → PR  │ │→ Retry│ │      │
          └────────┘ └───────┘ └──────┘
```

## Features

- **Full pipeline automation** — route, enrich, gate, execute, review, PR
- **Multiple enrichers** — codebase analysis, documentation, git history, dependency scanning run sequentially, each building on prior results
- **Three gate modes** — human approval, AI evaluation, or auto-approve for low-risk tasks
- **Rework loop** — failed reviews trigger refinement and re-execution (max 2 cycles)
- **Epic workflows** — large tasks decomposed into sequential milestones, each executed independently
- **Preview environments** — spin up the app under test (Docker Compose, TestContainers, or process) for validation before merging
- **5 producers** — auto-discover tasks by scanning logs, hunting bugs, finding security issues, scouting features, and self-monitoring
- **Hivemind** — structured learning system with confidence scores, feedback loops, and weekly retrospectives
- **Per-user cost tracking** — daily budgets, per-task limits, cost breakdown by agent/model/repo
- **Azure Entra ID auth** — "Sign in with Microsoft", role-based access (viewer/user/admin)
- **Per-user git credentials** — GitHub tokens and Azure DevOps PATs stored in Key Vault
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
| Testing | Vitest 3 |
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
  codebase:  { enabled: true, model: sonnet, max_turns: 30, budget: 3.0 }
  docs:      { enabled: true, model: haiku,  max_turns: 10, budget: 0.5 }
  git_history: { enabled: true, model: haiku, max_turns: 10, budget: 0.5 }
  dependencies: { enabled: true, model: haiku, max_turns: 10, budget: 0.5 }

preview:
  enabled: true
  max_concurrent: 3
  cleanup_timeout_minutes: 30
  port_range: [4001, 4099]
```

Settings can be overridden per-repo via the dashboard (stored in `repos.settings` JSONB column). Resolution order: repo settings > global DB config > YAML file defaults.

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
├── agents/          # Claude agent wrappers (router, gate, refiner, decomposer, ...)
├── auth/            # Entra ID auth, session, middleware
├── daemon/          # Background orchestrator, scheduler, cleanup
├── dashboard/       # Express routes + HTMX views
│   ├── routes/      # HTTP handlers
│   └── views/       # HTML template functions (Tailwind)
├── db/
│   ├── queries/     # One file per table
│   └── schema.ts    # Drizzle table definitions
├── domain/          # Types, state machine, config
├── enrichers/       # Codebase, docs, git-history, dependencies
├── execution/       # Worker, worktree, git provider, review gate, preview
├── producers/       # Auto task discovery (5 producers)
├── integrations/    # Azure DevOps, Azure Monitor
└── vault/           # Key Vault client
```

### Database

PostgreSQL 16 with Drizzle ORM. Key tables:

- `users` — Entra ID users with roles and budgets
- `tasks` — 13-state pipeline with enrichment, gate, review, preview tracking
- `costs` — Per-agent, per-model cost records
- `learnings` — Hivemind knowledge base with confidence scores
- `enrichment_runs` — Per-enricher results
- `preview_logs` — Preview lifecycle events

Migrations in `drizzle/`. Auto-run on startup via `src/db/migrate.ts`.

## Deployment

### Azure Resources (Bicep)

```bash
az deployment group create \
  -g the-hive \
  -f infra/main.bicep \
  -p infra/parameters.json \
  -p postgresAdminPassword='<password>' \
  -p dockerHostAdminSshPublicKey='<ssh-pub-key>'
```

Provisions:
- **Container App** — 1 vCPU / 2GB, always-on, external ingress on :3000
- **PostgreSQL Flexible Server** — Burstable B1ms, 32GB storage
- **Key Vault** — Stores user git tokens, API keys, Docker TLS certs
- **Container Registry** — Basic tier for Docker images
- **Log Analytics** — Container logs and metrics
- **Docker Host VM** (optional) — B2s Ubuntu for preview environments

### CI/CD

- **PRs** → `ci.yml` runs TypeScript check + full test suite
- **Merge to main** → `deploy.yml` builds Docker image, pushes to ACR, updates Container App, verifies health check

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
