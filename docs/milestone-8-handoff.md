# Milestone 8 Handoff Report for Milestone 9

## 1. Context for Milestone 9

### Existing Dockerfile and docker-compose.yaml

Both files already exist and are functional. The Dockerfile is a two-stage build (builder + runtime) on `node:20-alpine`. The runtime stage installs `git` via `apk`. The compose file defines `postgres` (16-alpine) and `app` services with a health check on postgres.

**`Dockerfile`** (current state):
- Stage 1 (builder): `npm ci`, copies source, `npm run build` (runs `tsc`).
- Stage 2 (runtime): `node:20-alpine`, installs `git`, copies `package.json` + `package-lock.json`, runs `npm ci --omit=dev`, copies `dist/` and `drizzle/` from builder.
- Exposes port 3000, entry point `node dist/index.js`.
- **Missing from blueprint**: `gh` CLI is not installed. The worker uses `getGitProvider()` which calls git operations directly, but the blueprint says "runtime with git, gh CLI". If any code path needs `gh`, it must be added.

**`docker-compose.yaml`** (current state):
- `postgres`: image `postgres:16-alpine`, user/password/db all `hive`, volume `pgdata`, health check.
- `app`: builds from `.`, depends on healthy postgres, port 3000, env vars `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV`, plus empty `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_TENANT_ID`.

### Complete environment variable inventory

The following environment variables are read across the codebase. The Bicep templates and Container App definition must provide all of these:

| Variable | Required | Source | Used by |
|----------|----------|--------|---------|
| `DATABASE_URL` | Yes (hard fail) | `src/db/connection.ts` | Drizzle ORM pool |
| `ANTHROPIC_API_KEY` | Yes (at runtime) | `src/agents/sdk.ts` (via Anthropic SDK auto-read) | All agent calls |
| `SESSION_SECRET` | Yes in production | `src/auth/session.ts` | Express sessions |
| `ENTRA_CLIENT_ID` | Yes for auth | `src/auth/entra.ts` | Microsoft Entra login |
| `ENTRA_CLIENT_SECRET` | Yes for auth | `src/auth/entra.ts` | Microsoft Entra login |
| `ENTRA_TENANT_ID` | Yes for auth | `src/auth/entra.ts` | Microsoft Entra login |
| `REDIRECT_URI` | Yes in production | `src/dashboard/server.ts` | OAuth callback URL |
| `AZURE_KEYVAULT_URI` | Optional (falls back to in-memory store) | `src/vault/keyvault.ts` | User git tokens |
| `AZURE_MONITOR_WORKSPACE_ID` | Optional | `src/integrations/azure-monitor.ts` | Log Analytics |
| `NODE_ENV` | Optional (defaults to non-production) | `src/logger.ts`, `src/auth/session.ts`, `src/dashboard/server.ts` | Logging format, session security, error messages |
| `PORT` | Optional (default `3000`) | `src/index.ts` | HTTP listen port |
| `LOG_LEVEL` | Optional (default `debug`/`info`) | `src/logger.ts` | Pino log level |
| `HIVE_MODE` | Optional (`daemon` to start daemon) | `src/index.ts` | Enables background task processing |
| `HIVE_MAX_WORKERS` | Optional (default `5`) | `src/index.ts` | Concurrent task limit |
| `HIVE_POLL_MS` | Optional (default `5000`) | `src/index.ts` | Task polling interval |
| `HIVE_PRODUCER_INTERVAL_MS` | Optional (default `900000` / 15min) | `src/daemon/daemon.ts` | Producer scan interval |
| `HIVE_DAEMON_USER_ID` | Optional (default `1`) | `src/daemon/daemon.ts` | User ID for daemon-created tasks |
| `HIVE_WORKTREE_DIR` | Optional (default `/tmp/hive-worktrees`) | `src/execution/worktree.ts` | Base path for git clones |
| `HIVE_DEFAULT_REPO_ID` | Optional | `src/cli.ts` | CLI default repo |

### Key secrets that must go in Key Vault

1. `ANTHROPIC_API_KEY` -- the Anthropic API key for Claude calls
2. `SESSION_SECRET` -- express session signing key
3. `ENTRA_CLIENT_SECRET` -- Microsoft Entra app client secret
4. Per-user git tokens (already managed by `src/vault/keyvault.ts` using naming convention `hive-user-{userId}-{provider}-{label}`)

### Database migration strategy

Migrations run automatically on startup (`src/index.ts` calls `migrate()` before listening). The migration reads from `./drizzle/` directory (relative to CWD). In the Docker image, `drizzle/` is copied to `/app/drizzle`. The `CMD` is `node dist/index.js` which runs from `/app`, so the relative path resolves correctly. No separate migration job is needed -- the app self-migrates.

**Caution for CI**: Tests require a running PostgreSQL. The test setup (`tests/setup.ts`) defaults to `postgresql://hive:hive@localhost:5432/hive_test`. The CI workflow needs a postgres service container with a `hive_test` database, or the `DATABASE_URL` env var must be set explicitly.

### Build and test commands

| Command | Purpose |
|---------|---------|
| `npm run build` | `tsc` -- compiles TypeScript to `dist/` |
| `npm test` | `vitest run` -- 461 tests across 41 files |
| `npm run db:migrate` | Direct migration execution via `tsx src/db/migrate.ts` |
| `npm run db:generate` | `drizzle-kit generate` -- generates new migration SQL from schema changes |
| `npm run dev` | `tsx watch src/index.ts` -- development with hot reload |

**No lint script exists yet.** The blueprint calls for `ci.yml` to run "lint + test" but there is no `lint` script in `package.json` and no ESLint/Prettier config. Milestone 9 either needs to add a linter or the CI workflow should skip the lint step and just run tests + typecheck (`tsc --noEmit`).

### Static assets path

The dashboard serves static files from `src/dashboard/public/` (resolved at runtime from `path.resolve("src", "dashboard", "public")`). This works for both `tsx` dev mode and compiled mode only if the `src/` directory is available at runtime. **The current Dockerfile does NOT copy `src/` to the runtime stage** -- it only copies `dist/` and `drizzle/`. This means static files will 404 in the Docker container. This must be fixed: either copy the public directory separately, or adjust the path resolution to use `dist/` in production.

### Worktree storage

`HIVE_WORKTREE_DIR` defaults to `/tmp/hive-worktrees`. In Azure Container Apps, ephemeral storage is limited. The blueprint mentions "Azure Files for worktree storage" but the current code writes to local disk. If Azure Files is mounted at a specific path, set `HIVE_WORKTREE_DIR` to that mount point. The worktree lifecycle is: `createWorktree()` clones the repo, worker executes, `cleanupWorktree()` deletes the directory (in a `finally` block). Clones do not persist across container restarts.

### Logging

Pino logger writes structured JSON to stdout in production (`NODE_ENV=production`). In dev it uses `pino-pretty` with color. Azure Container Apps + Log Analytics will capture stdout automatically. No special log driver config is needed.

### Health check endpoint

`GET /api/health` returns `{ "status": "ok" }` with 200. Use this for Container App health probes and CI deployment verification.

### Daemon mode

The app runs in two modes:
1. **Web-only** (default): just the Express dashboard.
2. **Daemon mode** (`HIVE_MODE=daemon`): web + background task processing (pipeline execution, producer scheduling, retrospective, decay).

For production, set `HIVE_MODE=daemon` to enable the full system. The daemon gracefully drains on SIGTERM (5-minute timeout).

### Key Vault integration

`src/vault/keyvault.ts` uses `DefaultAzureCredential` from `@azure/identity`. In Azure Container Apps with Managed Identity, this will authenticate automatically -- no additional config needed beyond granting the Managed Identity "Key Vault Secrets Officer" role on the Key Vault resource. The `AZURE_KEYVAULT_URI` env var must be set to `https://<vault-name>.vault.azure.net/`.

---

## 2. Suggested Amendments to Milestone 9

### Dockerfile needs `src/dashboard/public/` copied

The current Dockerfile copies `dist/` and `drizzle/` but not `src/dashboard/public/`. The Express server resolves static assets from `path.resolve("src", "dashboard", "public")`. Either:
- Copy `src/dashboard/public/` into the runtime image, or
- Change the static path logic to use `dist/dashboard/public/` and ensure TypeScript compilation copies those files (tsc won't copy .js files that aren't .ts source).

Recommended fix: add `COPY --from=builder /app/src/dashboard/public ./src/dashboard/public` to the Dockerfile runtime stage.

### Dockerfile needs `prompts/` directory copied

The worker loads prompts from `prompts/*.md` at runtime via `readFileSync(resolve("prompts/flow.md"))`. The Dockerfile does not copy the `prompts/` directory. Add `COPY --from=builder /app/prompts ./prompts` to the runtime stage.

### Dockerfile needs `autonomous.config.yaml` copied

`src/domain/autonomous-config.ts` loads `autonomous.config.yaml` from the project root via `resolve("autonomous.config.yaml")`. This file is not copied to the runtime image. Add `COPY --from=builder /app/autonomous.config.yaml ./` to the runtime stage.

### No lint tool is configured

The blueprint says `ci.yml` runs "lint + test on PR" but there is no ESLint or Prettier config and no `lint` script in `package.json`. Options:
1. Add ESLint + config as part of Milestone 9 (adds scope).
2. Replace lint with `tsc --noEmit` for type checking only (simpler, still catches real errors).
3. Skip lint in CI and just run tests.

Recommendation: use `tsc --noEmit` as the "lint" step in CI. Add a `typecheck` script to `package.json`. This catches actual errors without the overhead of configuring ESLint.

### docker-compose.yaml is mostly ready

The existing `docker-compose.yaml` is functional for local dev. The blueprint says "Updated for local dev (postgres + app)" -- it already is. The only change needed is adding any new env vars that Milestone 9 introduces (e.g., `HIVE_MODE=daemon`, `ANTHROPIC_API_KEY`).

### CI needs a test database

Tests connect to `hive_test` database by default. The `ci.yml` workflow needs:
- A PostgreSQL service container.
- `DATABASE_URL` set to point at it.
- The database name must be `hive_test` (or override via `DATABASE_URL`).

### Container App needs sufficient ephemeral storage

The app clones git repos to `HIVE_WORKTREE_DIR` (default `/tmp/hive-worktrees`). Azure Container Apps' default ephemeral storage may be limited. The Bicep template should either:
- Mount Azure Files at the worktree path for persistent + larger storage, or
- Set `ephemeralStorage` to a sufficient size in the Container App definition (check Azure limits for the selected workload profile).

### Managed Identity scope

The Container App's Managed Identity needs these role assignments:
- **Key Vault Secrets Officer** on the Key Vault (for reading/writing user tokens + shared secrets).
- **AcrPull** on the Container Registry (for pulling images).
- **No PostgreSQL role needed** -- connection uses password auth via `DATABASE_URL` connection string.

### Bicep should provision Log Analytics workspace

The blueprint lists "Azure Log Analytics workspace (for container logs)" in the resources. The Container App Environment requires a Log Analytics workspace at creation. This is a dependency -- provision it in `main.bicep` before the Container App Environment.

### No other changes needed

The blueprint's file list (`Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `infra/main.bicep`, `infra/container-app.bicep`, `infra/parameters.json`, `docker-compose.yaml`) is accurate. The `infra/` and `.github/` directories do not exist yet and must be created from scratch.
