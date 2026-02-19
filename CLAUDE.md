# CLAUDE.md — Hive Project

## What is this?

Autonomous task orchestration for engineering teams. Routes tasks through enrichment → gating → execution → review → PR creation, powered by Claude.

## Tech stack

Node.js 20, TypeScript (strict, ESM), Express + HTMX, PostgreSQL + Drizzle ORM, Anthropic Claude SDK, Azure Container Apps.

## Commands

```bash
npm run build        # TypeScript compilation (tsc)
npm run dev          # Dev mode with tsx watch
npm test             # Vitest
npm run typecheck    # Type check without emit
npm run db:migrate   # Run Drizzle migrations
npm run db:generate  # Generate Drizzle schema changes
npm run cli          # CLI for daemon/producer management
```

## Project structure

```
src/
  agents/       # Claude agent wrappers (router, gate, refiner, decomposer)
  auth/         # Entra ID auth, session, middleware
  daemon/       # Background orchestrator, scheduler, cleanup
  dashboard/    # Express routes + HTMX views (pure HTML-returning functions)
  db/           # Drizzle schema and queries
  domain/       # Types, state machine, autonomous config
  enrichers/    # Enrichment pipeline (architect, scorer, codebase, docs, etc.)
  execution/    # Worker, worktree, git provider, review gate, preview
  producers/    # Auto-discovery task producers
```

## Deploy

### Manual (preferred — GitHub Actions deploy is currently broken)

```bash
bash scripts/deploy.sh          # Uses git SHA as tag by default
bash scripts/deploy.sh v1.2.3   # Or pass an explicit tag
```

### Important: always use a unique image tag

Azure Container Apps will NOT create a new revision if the image tag hasn't changed. The deploy script defaults to `git rev-parse --short HEAD` to avoid this. Never deploy with bare `:latest`.

### GitHub Actions

Triggers on push to `main` via `.github/workflows/deploy.yml`. Already uses `${{ github.sha }}` as the tag, so unique revisions are handled correctly. Currently broken due to test failures.

### Infrastructure

- Azure Container Apps (North Europe), ACR registry `thehivehnv7pb`
- Secrets in Azure Key Vault, pulled as Container App secrets
- Health endpoint: `GET /api/health`

## Conventions

- Dashboard views (`src/dashboard/views/`) are pure functions returning HTML strings
- Use `escapeHtml()`, `badge()`, and component helpers from `./components.js`
- Enrichment data lives in `task.enrichment.<enricherName>` (architect, scorer, etc.)
- Commit messages: `feat:` / `fix:` / `refactor:` prefix style
- Build must pass (`npm run build`) before deploying
