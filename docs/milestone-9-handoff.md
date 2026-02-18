# Milestone 9 Handoff Report for Milestone 10

## 1. Context for Milestone 10

### Database schema is ready for previews

The `tasks` table already has preview-specific columns, created in the initial migration (`drizzle/0000_jazzy_nuke.sql`):

- `preview_port` (integer, nullable) -- allocated port for the preview
- `preview_status` (text, nullable) -- current preview lifecycle state
- `preview_started_at` (timestamptz, nullable) -- when the preview was started

The `preview_logs` table is also already created with schema and index:

```sql
CREATE TABLE "preview_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES tasks(id),
  "source" text NOT NULL,
  "message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);
CREATE INDEX "preview_logs_task_created_idx" ON "preview_logs" USING btree ("task_id","created_at");
```

The Drizzle ORM schema definitions for both are in `/home/ewi/repos/orcha-clones/hive/src/db/schema.ts` (lines 221-233 for `previewLogs`, lines 101-103 for the task preview columns). **No migration is needed for Milestone 10.**

### Key files and exports to integrate with

**Execution pipeline** (`/home/ewi/repos/orcha-clones/hive/src/execution/`):

- `worker.ts` -- `executeTask(taskId)` is the main execution entry point. After implementation, it calls `reviewChanges()`. The flow is: implement -> review -> (pass: push+PR | rework: retry | fail). **Milestone 10 must hook in between review pass and PR creation** -- if `.hive.yaml` has preview config, start the preview before pushing the PR.
- `review-gate.ts` -- `reviewChanges(taskId, worktreeInfo, learningIds?)` returns `ReviewGateResult` with verdict `pass|rework|fail`. The blueprint says to start preview after review passes. The integration point is in `worker.ts` lines 150-177, in the `if (reviewResult.verdict === "pass")` block.
- `worktree.ts` -- `createWorktree()` returns `WorktreeInfo { path, branch, repoFullName, provider, createdAt }`. The worktree path is where the code lives. `cleanupWorktree()` deletes it. The worktree is cleaned up in the `finally` block of `executeTask()`. **Important**: if a preview is running from the worktree, cleanup must be deferred until after the preview is stopped. The current `finally` block unconditionally calls `cleanupWorktree(worktree)`.
- `git-provider.ts` -- `GitProvider` interface and `getGitProvider(provider)` factory. Has `clone`, `createBranch`, `commitAll`, `push`, `createPR`.

**Domain types** (`/home/ewi/repos/orcha-clones/hive/src/domain/types.ts`):

- `WorktreeInfo` -- used by preview manager (contains `path` for rsync source)
- `ReviewGateResult` -- verdict, findings, verification
- `TaskStatus` -- 13 states. No "preview" state exists yet. The blueprint mentions showing preview status in the dashboard but the state machine in `state-machine.ts` does not have a preview-related state. Preview status is tracked via the `preview_status` column on the tasks table, separate from the main task status.
- `WorkerResult` -- returned from `executeTask()`, includes `success`, `prUrl`, `branch`, `reviewResult`

**Autonomous config** (`/home/ewi/repos/orcha-clones/hive/src/domain/autonomous-config.ts`):

- `getAutonomousConfig()` returns the singleton config loaded from `autonomous.config.yaml`
- The current config has sections: `classification`, `gate`, `budget`, `models`, `enrichers`
- **Milestone 10 must add a `preview` section** to both the `AutonomousConfig` interface and the `autonomous.config.yaml` file
- Pattern: add new properties to the interface, add defaults in `DEFAULTS`, spread in `loadConfig()`

**Dashboard** (`/home/ewi/repos/orcha-clones/hive/src/dashboard/`):

- `server.ts` -- Express app. Routes mounted with `app.use("/", router)`. **Add preview proxy route here.** Health check is at `GET /api/health`. Auth middleware is `injectUser` + `requireAuth` (from `src/auth/middleware.ts`).
- `views/tasks.ts` -- `taskDetailPanel(task)` renders the task detail slide-over. It already renders `task.prUrl` as a link. **Add preview link/status here**, checking `task.previewStatus` and `task.previewPort`.
- `views/components.ts` -- Design system components: `badge`, `button`, `statusBadge`, `card`, `input`, etc. Use these for any new UI elements.
- `routes/tasks.ts` -- Task CRUD + transition routes. Add preview-related routes (start/stop/extend) here or in a dedicated preview router.

**Key Vault** (`/home/ewi/repos/orcha-clones/hive/src/vault/keyvault.ts`):

- `getSecret(name)`, `setSecret(name, value)`, `deleteSecret(name)` -- for reading Docker TLS certs from Key Vault
- Falls back to in-memory store when `AZURE_KEYVAULT_URI` is not set (dev mode)

**Logger** (`/home/ewi/repos/orcha-clones/hive/src/logger.ts`):

- `import logger from "../logger.js"` -- pino logger, structured JSON in production

**Database connection** (`/home/ewi/repos/orcha-clones/hive/src/db/connection.ts`):

- `import { db } from "../db/connection.js"` -- Drizzle ORM instance
- `import { pool } from "../db/connection.js"` -- raw pg Pool

### Patterns established to follow

1. **File organization**: execution logic in `src/execution/`, database queries in `src/db/queries/`, views as pure HTML-returning functions in `src/dashboard/views/`, routes in `src/dashboard/routes/`.

2. **Query files**: one file per table in `src/db/queries/`. Preview logs should go in `src/db/queries/preview-logs.ts`. Pattern: export named async functions that use `db` from `../connection.js` and schema from `../schema.js`.

3. **View functions**: pure functions returning HTML strings. No side effects. Accept typed parameters (usually `TaskRow`, `SessionUser`). Use `escapeHtml()` from `components.ts` for all user content.

4. **Error handling**: routes use `try/catch` with `next(err)`. Express error handler in `server.ts` returns HTMX-friendly errors via `HX-Trigger` header for HTMX requests, plain text for non-HTMX.

5. **HTMX patterns**: routes check `req.headers["hx-request"]` to decide between partial and full page responses. Use `hx-get`/`hx-post`, `hx-target`, `hx-swap`. Toasts via `HX-Trigger: showToast`.

6. **Module resolution**: all imports use `.js` extensions (`"./foo.js"`) per Node.js ESM convention. TypeScript compiles to `dist/` with `NodeNext` module resolution.

7. **Config pattern**: YAML-based config with TypeScript interface, defaults, singleton loader. See `autonomous-config.ts`.

8. **Infra pattern**: Bicep modules in `infra/`. `main.bicep` is the orchestrator that deploys shared resources and calls child modules. `container-app.bicep` is a child module called from `main.bicep`. Follow this pattern for `docker-host.bicep`.

9. **Secrets in Container App**: secrets are referenced from Key Vault via `keyVaultUrl` in `container-app.bicep`. The managed identity has Secrets Officer role. If adding new secrets (Docker TLS certs), add them to Key Vault and reference them in the container app config.

10. **Testing**: vitest with `vitest run`. Config in `vitest.config.ts`. Tests in `tests/` directory mirroring `src/` structure.

### Container App infrastructure context

The Container App (`infra/container-app.bicep`) runs with:
- 1 vCPU / 2Gi memory
- 1 replica (min and max)
- Ephemeral `/repos` volume (EmptyDir) for git clones
- Managed identity for Key Vault and ACR access
- External ingress on port 3000

The managed identity resource ID and client ID are passed to the container app. If the Docker host VM needs to trust the same identity or use separate credentials, that must be configured in `docker-host.bicep`.

The Container App Environment resource ID is available in `container-app.bicep` as `containerAppEnv.id`. Networking: the current setup does not use VNet integration (there is a TODO comment about it in `main.bicep` line 109). For the Docker host VM to be reachable only from the Container App, VNet integration or a different network approach is needed. The blueprint mentions "firewall: only allow Container App outbound IP on 2376" but without VNet, the Container App's outbound IP is shared/dynamic. Consider VNet integration as part of this milestone.

### Environment variables

All 16 environment variables are configured in both `docker-compose.yaml` (local dev) and `container-app.bicep` (production). See the Milestone 8 handoff for the complete inventory. New variables needed for Milestone 10:
- Docker host connection details (or read from `autonomous.config.yaml`)

### Dockerfile

The Dockerfile (`/home/ewi/repos/orcha-clones/hive/Dockerfile`) is a two-stage build:
- Runtime stage: `node:20-alpine` with `git` and `github-cli`
- Copies: `dist/`, `drizzle/`, `src/dashboard/public/`, `prompts/`, `autonomous.config.yaml`
- Creates `/repos` directory
- `HEALTHCHECK` pings `/api/health`
- If `type=process` previews spawn child processes inside the container, the Dockerfile may need additional runtime dependencies (e.g., `dotnet` for .NET repos, `python` for Python repos). More likely, `type=process` is only for Node.js apps that can run with the existing `node` runtime.

### CI/CD Workflows

- `.github/workflows/test.yml` -- reusable workflow with PostgreSQL service, typecheck, and tests
- `.github/workflows/ci.yml` -- calls test.yml on PRs to main
- `.github/workflows/deploy.yml` -- calls test.yml, then builds+pushes Docker image to ACR, updates Container App, runs health check

The deploy workflow uses OIDC for Azure login. If `docker-host.bicep` needs to be deployed, it could be added to the deploy workflow or run separately via `az deployment group create`.

### Dependencies not yet installed

The blueprint mentions `dockerode` for Docker API communication. This is not in `package.json` yet. Milestone 10 must install it:
```
npm install dockerode
npm install -D @types/dockerode
```

For the reverse proxy, `http-proxy-middleware` or a lightweight alternative may be needed (or use Node.js `http.request` directly). Express does not include a built-in proxy.

---

## 2. Suggested Amendments to Milestone 10

### Worktree cleanup must be deferred for previews

The current `executeTask()` in `worker.ts` unconditionally cleans up the worktree in its `finally` block (line 222-224). If a preview is started from that worktree (for `type=process`, where the process runs locally), the worktree will be deleted while the preview is still running. For `type=compose` and `type=testcontainers`, the worktree is rsynced to the Docker host so this is less of a concern.

**Amendment**: `worker.ts` must conditionally skip `cleanupWorktree()` when a preview is active. The preview manager should take ownership of worktree cleanup when the preview is torn down. This is not called out in the blueprint's file list but is a required change to `src/execution/worker.ts`.

### The `preview_status` column exists but has no defined values

The schema has `preview_status` as a plain `text` column with no constraints. Milestone 10 should define the valid values (e.g., "starting", "running", "stopping", "stopped", "failed", "timeout") and optionally add them to `domain/types.ts` as a const enum, following the pattern of `TaskStatus`.

### No new DB migration needed

All preview-related tables and columns (`preview_logs`, `tasks.preview_port`, `tasks.preview_status`, `tasks.preview_started_at`) already exist in the schema and the initial migration. No `drizzle-kit generate` step is needed unless Milestone 10 discovers it needs additional columns.

### The `src/db/queries/preview-logs.ts` file does not exist yet

The blueprint lists this as a key file. While the `preview_logs` table and Drizzle schema exist, there is no query file yet. It needs to be created. This is correctly identified in the blueprint.

### `autonomous.config.yaml` needs a preview section

The current config file has `classification`, `gate`, `budget`, and `enrichers` sections. The `AutonomousConfig` interface and `loadConfig()` function in `autonomous-config.ts` need to be extended with a `preview` section. The blueprint shows the YAML structure. Add a `PreviewConfig` interface and wire it into the loader following the existing spread-defaults pattern.

### `src/hive-yaml.ts` is a new file -- correct

No `.hive.yaml` parser exists yet. This file will parse per-repo preview configuration. It should be placed at `src/hive-yaml.ts` as the blueprint specifies.

### VNet integration may be needed for Docker host security

The blueprint says the Docker host VM should only accept connections from the Container App on port 2376. Currently, the Container App has no VNet integration (main.bicep line 109 has a TODO about this). Without VNet integration, the Container App uses shared Azure outbound IPs, making firewall rules unreliable.

**Options**:
1. Add VNet integration to Container App Environment + put Docker host VM on the same VNet (recommended but adds scope).
2. Use a public Docker host with TLS client certificates for authentication (simpler but less secure).
3. Use SSH tunneling from Container App to Docker host.

The blueprint's architecture diagram shows the connection as "Docker API over TLS", and the config has `tls_cert_vault_secret` etc. Option 2 (TLS client certs from Key Vault) is likely the intended approach. The firewall rule is an additional layer, not the primary security mechanism.

### Reverse proxy needs `http-proxy-middleware` or equivalent

The blueprint lists `src/execution/preview/proxy.ts` as an Express reverse proxy. Express has no built-in proxy. Options:
1. `http-proxy-middleware` (most common, supports WebSocket passthrough)
2. `http-proxy` (lower level)
3. Manual `http.request` piping

Recommendation: use `http-proxy-middleware` for simplicity and WebSocket support. Install:
```
npm install http-proxy-middleware
```

### `docker-host.bicep` needs careful scoping

The blueprint says this Bicep module provisions a B2s VM with Docker Engine, TLS certs, and a firewall. This is a significant piece of infrastructure:
- Ubuntu VM with cloud-init to install Docker Engine
- Generate and store TLS certs in Key Vault (or use certs already in Key Vault)
- NSG rules restricting inbound to port 2376 from Container App
- SSH key for rsync file transfer

This module should be called from `main.bicep` following the pattern of `container-app.bicep` (a child module).

### Consider making the Docker host optional for local development

In local dev (docker-compose.yaml), there is no Docker host VM. For local testing of preview functionality:
- `type=process` works directly (spawn child process)
- `type=compose` could target the local Docker daemon (localhost:2375 or Unix socket)
- `type=testcontainers` could also use the local Docker daemon

The `PreviewManager` should allow connection to a local Docker daemon when the Docker host config is not set, similar to how `keyvault.ts` falls back to in-memory storage.

### No other blueprint changes needed

The planned file list is accurate. All files listed are either new or correctly identified as modifications. The approach of using dockerode + rsync + reverse proxy is sound. The three preview types cover the major deployment patterns.
