# Milestone 10 Handoff Report — Preview Environments

## 1. Summary of What Was Built (Milestone 10)

Milestone 10 adds preview environments to The Hive: after the review gate passes, the system can spin up the implemented application, validate it over HTTP, and keep it running so the task creator can inspect it via a dashboard link before approving the PR.

---

### Feature overview

After `reviewChanges()` returns a `pass` verdict, `executeTask()` in `src/execution/worker.ts` checks the repo's worktree for a `.hive.yaml` file. If that file contains a `preview:` section, `previewManager.startPreview()` is called. The `previewUrl` is written into `WorkerResult` so downstream callers can surface the link. Worktree cleanup is deferred until the preview is stopped.

The preview lifecycle runs through five values of `tasks.preview_status`:

```
starting → running → stopped
                 ↘ failed
```

---

### Key files and exports

#### `src/hive-yaml.ts`

Parses `.hive.yaml` from a repo worktree. The only public export is `parseHiveYaml(worktreePath: string): PreviewConfig | null`.

`PreviewConfig` is a discriminated union on `type`:

```typescript
// Three concrete shapes:
ComposePreviewConfig       // type: "compose"  — docker compose up
TestcontainersPreviewConfig // type: "testcontainers" — app manages its own containers
ProcessPreviewConfig       // type: "process"  — spawn directly in-container
```

Required fields per type:

| Field | compose | testcontainers | process |
|---|---|---|---|
| `type` | required | required | required |
| `port` | required | required | required |
| `compose_file` | required | — | — |
| `app_service` | required | — | — |
| `start_command` | — | required | required |
| `health_check` | optional | optional | optional |
| `startup_timeout` | optional | optional | optional |
| `env` | optional | optional | optional |

Example `.hive.yaml` files:

```yaml
# Compose
preview:
  type: compose
  compose_file: docker-compose.test.yml
  app_service: web
  port: 3000
  health_check: /api/health
  startup_timeout: 120

# Process
preview:
  type: process
  start_command: node server.js
  port: 3000
  health_check: /health
  startup_timeout: 30
```

---

#### `src/execution/preview/types.ts`

Barrel of re-exports for the preview subsystem:

```typescript
export type { PreviewConfig } from "../../hive-yaml.js";
export type { PreviewStatus } from "../../domain/types.js";

export interface PreviewInfo {
  taskId: string;
  type: "compose" | "testcontainers" | "process";
  port: number;
  host: string;
  worktreePath: string;
  startedAt: Date;
  childProcess?: ChildProcess;   // present for process/testcontainers
  composeProject?: string;       // present for compose (hive-{taskId})
}
```

---

#### `src/execution/preview/manager.ts`

`PreviewManager` class manages all active previews in memory. Singleton exported as `previewManager`.

Public API:

```typescript
startPreview(taskId, worktreePath, config): Promise<PreviewInfo>
stopPreview(taskId): Promise<void>
getPreviewInfo(taskId): PreviewInfo | undefined
getRunningPreviews(): ReadonlyMap<string, PreviewInfo>
extendPreview(taskId): Promise<void>   // resets startedAt, extending the timeout
cleanupExpired(): Promise<string[]>    // returns cleaned-up taskIds
allocatePort(): number                 // picks next available port from port_range
freePort(port): void
```

Internal behavior:

- `startPreview` enforces `max_concurrent`, calls `docker compose up -d` (compose type) or `spawn("sh", ["-c", command])` (process/testcontainers), then polls the `health_check` path every 2 seconds up to `startup_timeout`. Failure triggers `stopPreview` and sets `preview_status = "failed"`.
- `stopPreview` calls `docker compose down --remove-orphans` or `SIGTERM`-kills the child process, frees the port, and sets `preview_status = "stopped"`.
- Port allocation scans `port_range` linearly and tracks allocations in `usedPorts: Set<number>`.
- All lifecycle events are written to `preview_logs` via `addPreviewLog`.
- Database columns updated: `tasks.preview_port`, `tasks.preview_status`, `tasks.preview_started_at`.

Limitation: remote Docker host (rsync + dockerode over TLS) is implemented as a `TODO` comment in `startCompose`. Currently only local Docker is wired up. The config and TLS cert references are present; the rsync step remains to be built.

---

#### `src/execution/preview/validator.ts`

`validatePreview(taskId, previewUrl, healthCheckPath): Promise<ValidationResult>`

Makes HTTP GET requests to the health-check endpoint and (when distinct) the root path. Returns:

```typescript
interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

interface ValidationCheck {
  endpoint: string;
  status: number;
  passed: boolean;
  notes: string;
}
```

Each check expects HTTP 200. Errors (connection refused, timeout) are captured as `passed: false`. Results are logged to `preview_logs`.

---

#### `src/execution/preview/proxy.ts`

Express `Router` mounted at `/preview/:taskId/*` in `src/dashboard/server.ts`. Auth-protected (`requireAuth`). Reverse-proxies to `http://{info.host}:{info.port}` using `http-proxy-middleware`. HTML in error responses is XSS-safe via `escapeHtml` from `src/dashboard/views/components.ts`.

Behavior:
- No in-memory info for `taskId` → 404
- `previewStatus === "starting"` → 503 with "Preview Starting" message
- Otherwise → proxies, rewriting `/preview/:taskId/*` to `/*` on the target

---

#### `src/db/queries/preview-logs.ts`

```typescript
addPreviewLog(taskId: string, source: string, message: string): Promise<PreviewLogRow>
getPreviewLogs(taskId: string, limit?: number): Promise<PreviewLogRow[]>
```

`source` is a short string identifying the component (`"manager"`, `"health"`, `"validator"`, `"cleanup"`). Logs are ordered by `created_at DESC`.

---

#### `src/daemon/preview-cleanup.ts`

`cleanupExpiredPreviews(): Promise<void>` — called by `daemon.ts` on a 60-second interval.

1. Snapshots worktree paths from in-memory previews.
2. Calls `previewManager.cleanupExpired()` to stop any previews past `cleanup_timeout_minutes`.
3. For each expired preview, calls `cleanupWorktree()` to delete the on-disk worktree.
4. Runs a secondary DB query for tasks with `preview_status = 'running'` and `preview_started_at` older than the timeout that are not tracked in memory (handles post-restart orphans), setting them to `"stopped"`.

---

#### `autonomous.config.yaml` — `preview:` section

```yaml
preview:
  enabled: true
  max_concurrent: 3
  cleanup_timeout_minutes: 30
  docker_host:
    ip: ""                       # set to Docker host VM private IP in prod
    port: 2376
    tls_cert_vault_secret: docker-tls-cert
    tls_key_vault_secret: docker-tls-key
    tls_ca_vault_secret: docker-tls-ca
  port_range: [4001, 4099]
```

`PreviewSettings` interface in `src/domain/autonomous-config.ts`:

```typescript
interface DockerHostConfig {
  ip: string;
  port: number;
  tls_cert_vault_secret: string;
  tls_key_vault_secret: string;
  tls_ca_vault_secret: string;
}

interface PreviewSettings {
  enabled: boolean;
  max_concurrent: number;
  cleanup_timeout_minutes: number;
  docker_host: DockerHostConfig;
  port_range: [number, number];
}
```

---

#### Infrastructure

`infra/docker-host.bicep` provisions a Standard_B2s Ubuntu 24.04 VM with:
- Docker CE installed via `infra/scripts/install-docker.sh`
- TLS-secured daemon on `tcp://0.0.0.0:2376` (mutual TLS, CA + server + client certs)
- TLS SAN includes both private and public IPs (dynamically detected from IMDS at provision time)
- NSG rules: allow SSH (22), Docker API (2376), preview ports (4001-4099) from `allowedSourceAddressPrefix` only; deny all other inbound
- Parameter `allowedSourceAddressPrefix` is required (no default) to prevent accidental open access
- Outputs: `vmPrivateIp`, `vmPublicIp`, `vmResourceId`
- Called conditionally from `infra/main.bicep`

Post-provision manual step: client certs (`ca.pem`, `client-cert.pem`, `client-key.pem`) from `/etc/docker/tls/` must be uploaded to Key Vault. Commands are documented in the install script.

---

#### Dashboard UI

`src/dashboard/views/tasks.ts` — `previewSection()` renders:
- Status badge (starting / running / failed / stopped)
- Clickable "Open Preview" link (when running)
- Stop and Extend buttons (POST to `/api/tasks/:id/preview/stop` and `/api/tasks/:id/preview/extend`)

`src/dashboard/routes/tasks.ts` — two new POST routes:
- `POST /api/tasks/:id/preview/stop` — calls `previewManager.stopPreview()`
- `POST /api/tasks/:id/preview/extend` — calls `previewManager.extendPreview()`

---

#### Integration test

`tests/execution/preview/integration.test.ts` — skipped when `DATABASE_URL` is not set. Tests the full lifecycle for `type=process`:
1. Creates a temporary `.hive.yaml` and a minimal Node.js HTTP server script.
2. Parses the YAML, seeds a DB task, calls `startPreview`.
3. Asserts `preview_status = "running"` in DB.
4. Calls `validatePreview` and asserts all checks pass.
5. Calls `stopPreview` and asserts `preview_status = "stopped"`.
6. Verifies `preview_logs` contains entries for each lifecycle stage.

---

### Patterns established

- **Per-repo preview config**: `.hive.yaml` at the repo root, parsed at execution time, not stored in DB.
- **Discriminated union config**: `PreviewConfig` type uses `type` as discriminant; switch statements in `PreviewManager` dispatch per-type.
- **DB mirrors in-memory state**: `preview_status` in the DB is the authoritative record for the dashboard and cleanup daemon; the in-memory `Map<string, PreviewInfo>` is the runtime authority for stop/extend.
- **Cleanup daemon is two-tier**: in-memory expiry plus a DB reconciliation pass handles post-restart orphans without a separate lock or heartbeat.
- **Worktree ownership**: the worker defers worktree cleanup when a preview is active; the cleanup daemon takes ownership when the preview expires.

---

### Known limitations and TODOs

1. **Remote Docker host is not wired up.** `startCompose` has a `TODO` for the rsync step. Currently, `type=compose` and `type=testcontainers` only work against a local Docker daemon. To use the Docker host VM, the rsync-over-SSH step must be implemented in `startCompose`/`startTestContainers`, and dockerode must be configured with the TLS certs from Key Vault.

2. **VNet integration not implemented.** The Container App and the Docker host VM are on separate networks. The `allowedSourceAddressPrefix` NSG parameter is the only restriction. For proper network isolation, VNet integration on the Container App Environment (commented as a TODO in `infra/main.bicep` line 109) is needed.

3. **Validator is HTTP-only.** `validatePreview` checks for HTTP 200. There is no agent-driven validation (the blueprint envisioned a gate agent making semantic HTTP requests). This can be extended by passing a validator prompt to the Claude SDK with the preview URL.

4. **No port detection feedback to compose.** For `type=compose`, the `PORT` environment variable is set but the allocated port is not mapped through `docker compose` port bindings. If the compose service uses a fixed internal port, the reverse proxy target must be the service's internal port, not the allocated one.

5. **`type=compose` cleanup uses `--remove-orphans` not `-v`.** The blueprint specified `down -v` to remove volumes. The current implementation uses `--remove-orphans` without `-v`. Persistent volumes will not be removed on cleanup.

6. **Client TLS cert upload is a manual post-provision step.** The Bicep extension runs the install script, but uploading the generated client certs to Key Vault still requires a manual `az keyvault secret set` command documented in the install script.

---

## 2. Blueprint Completion Summary

The Hive v2 is a 10-milestone rebuild of the autonomous task orchestration system. All 10 milestones are complete.

---

### What was built across all 10 milestones

**M1: Scaffold + Database + Auth**

Foundation: Express app, full PostgreSQL schema (13 tables) with Drizzle ORM, Azure Entra ID sign-in via MSAL, per-user sessions stored in PostgreSQL, Tailwind CSS design system, Inter/JetBrains Mono typography, pino logging. Every subsequent milestone builds on top of this authenticated, database-backed shell.

Key files: `src/db/schema.ts`, `src/auth/entra.ts`, `src/auth/middleware.ts`, `src/auth/session.ts`, `src/dashboard/views/layout.ts`, `src/dashboard/views/components.ts`.

---

**M2: Task CRUD + Dashboard Core**

Full task management UI: create tasks, view and filter by status/repo/user, detail slide-over panel, HTMX-powered partial updates, command palette (Cmd+K), keyboard shortcuts (j/k navigate, a approve, r reject), toast notification system. Per-user token management via Key Vault.

Key files: `src/domain/types.ts`, `src/domain/state-machine.ts`, `src/db/queries/tasks.ts`, `src/dashboard/views/tasks.ts`, `src/dashboard/public/commands.ts`, `src/dashboard/public/htmx-ext.ts`.

---

**M3: Pipeline Agents — Route, Enrich, Gate**

Three-stage pipeline: the router classifies tasks (type, size, model, workflow); multiple enrichers run sequentially (codebase, docs, git-history, dependencies), each building on prior results, writing to `enrichment_runs` and merging into `tasks.enrichment`; the gate evaluates tasks (human or AI), recording decisions in `gate_decisions`. Cost tracking to the `costs` table per agent call.

Key files: `src/agents/router.ts`, `src/agents/gate.ts`, `src/enrichers/base.ts`, `src/enrichers/codebase.ts`, `src/enrichers/docs.ts`, `src/enrichers/git-history.ts`, `src/enrichers/dependencies.ts`, `src/db/queries/costs.ts`.

---

**M4: Worker + Git + Review Gate**

Task execution: isolated git worktrees on ephemeral local disk, per-user git credentials from Key Vault, Claude agent runs implementation, review gate verifies (lint + build + test + code review + security review). On pass: push branch + create PR. On rework: refine + retry (max 2 cycles). Epic workflow: large tasks decomposed into sequential milestones.

Key files: `src/execution/worker.ts`, `src/execution/worktree.ts`, `src/execution/git-provider.ts`, `src/execution/review-gate.ts`, `src/agents/refiner.ts`, `src/agents/decomposer.ts`.

---

**M5: Daemon Orchestration**

`Daemon` class replaces module-scope globals: polls PostgreSQL every 5 seconds for work, sequences pipeline stages, manages a concurrent worker pool, enforces per-user limits, tracks active agents in the `active_agents` table (survives restart), and handles graceful shutdown. Stale task detection queries for tasks stuck in a status beyond a configurable threshold.

Key files: `src/daemon/daemon.ts`, `src/daemon/stale-tasks.ts`, `src/daemon/scheduler.ts`.

---

**M6: Producers + Notifications**

Auto-discovery of tasks: five producers (log-scanner, bug-hunter, security-scanner, feature-scout, self-monitor) run on configurable schedules, scan repos, and create deduplicated tasks. Producer runs recorded in `producer_runs`. Slack/Teams webhook notifications for configurable events.

Key files: `src/producers/base.ts`, `src/producers/*.ts`, `src/notifications.ts`, `src/integrations/azure-monitor.ts`.

---

**M7: Full Dashboard**

Completed all remaining dashboard pages: cost reports with daily/monthly breakdowns by user, repo, agent, and model; global and per-repo settings management (3-layer config: file defaults → DB → repo overrides); producer status and configuration; system prompt browser and editor.

Key files: `src/dashboard/routes/costs.ts`, `src/dashboard/routes/settings.ts`, `src/dashboard/routes/producers.ts`, `src/dashboard/views/costs.ts`, `src/dashboard/views/settings.ts`.

---

**M8: Hivemind — Structured Learning System**

Replaces flat markdown knowledge files with a structured `learnings` table: confidence scores (0.00–1.00), scope hierarchy (`universal | lang:x | framework:x | repo:x`), category tags, reinforcement/contradiction counters, and a `learning_events` audit trail. Feedback loop runs after every task: pass reinforces in-prompt learnings; rework creates anti-pattern learnings; human PR feedback creates high-confidence (0.80) learnings. Weekly retrospective agent analyzes trends and proposes promotions and deprecations. Relevance-based retrieval injects the top 15–20 learnings into worker prompts.

Key files: `src/agents/feedback-loop.ts`, `src/agents/retrospective.ts`, `src/agents/keeper.ts`, `src/db/queries/learnings.ts`, `src/db/queries/learning-events.ts`, `src/dashboard/views/hivemind.ts`.

---

**M9: Deployment — Container Apps + CI/CD**

Production deployment pipeline: multi-stage Dockerfile (builder + node:20-alpine runtime with git and gh CLI), GitHub Actions workflows (CI on PR: typecheck + tests with PostgreSQL service container; deploy on merge: build → push to ACR → update Container App revision → health check). Bicep infrastructure: Container App (1 vCPU/2GB, ephemeral `/repos` disk, managed identity), PostgreSQL Flexible Server (B1ms), Azure Key Vault, Azure Container Registry, Log Analytics workspace.

Key files: `Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `infra/main.bicep`, `infra/container-app.bicep`.

---

**M10: Preview Environments**

Per-repo preview configuration via `.hive.yaml` (three types: compose, testcontainers, process). `PreviewManager` singleton starts/stops/health-checks previews, tracks them in memory, and mirrors status to the database. Reverse proxy exposes running previews at `/preview/:taskId/*` through the authenticated dashboard. A cleanup daemon stops expired previews and deferred worktrees. A dedicated Docker host VM (B2s, Docker CE with TLS) is provisioned via Bicep for compose and testcontainers workloads.

Key files: `src/hive-yaml.ts`, `src/execution/preview/manager.ts`, `src/execution/preview/proxy.ts`, `src/execution/preview/validator.ts`, `src/daemon/preview-cleanup.ts`, `src/db/queries/preview-logs.ts`, `infra/docker-host.bicep`, `infra/scripts/install-docker.sh`.

---

### Architecture achieved

```
Browser (Entra ID session)
  └─ Express dashboard (HTMX, Tailwind, command palette)
       ├─ Task CRUD, gate approval, cost reports, settings, Hivemind
       └─ /preview/:taskId/* → reverse proxy → preview environment

Daemon (every 5s poll)
  └─ route → enrich (4 enrichers) → gate → execute → review → PR
       └─ if .hive.yaml: start preview → validate → keep running for human

Learning loop (every task completion)
  └─ reinforce/contradict learnings → inject top-N into next worker prompt
       └─ weekly retrospective → metrics + proposals → dashboard report

Producers (scheduled)
  └─ scan repos → create tasks (deduplicated)

Infrastructure (Azure)
  ├─ Container App — app runtime
  ├─ PostgreSQL Flexible Server — all state
  ├─ Key Vault — per-user git tokens, Anthropic key, Docker TLS certs
  ├─ Container Registry — Docker images
  └─ Docker Host VM (B2s) — preview environment containers
```

---

### Known limitations and areas for future work

**Preview environments (M10)**
- Remote Docker host not fully wired (rsync + dockerode TLS). Currently compose/testcontainers previews use local Docker only.
- Validator is HTTP-only; agent-driven semantic validation is not implemented.
- VNet integration between Container App and Docker host VM is not configured.

**Enrichers (M3)**
- All four enrichers run sequentially even when only one or two are relevant. Per-task enricher selection based on task type or repo config would reduce cost.

**Epic workflow (M4)**
- Milestone decomposition runs once; there is no re-decomposition if an early milestone changes the implementation landscape significantly.

**Hivemind (M8)**
- Monthly confidence decay requires a scheduled job or a long-running daemon timer. Not yet wired into a calendar-based schedule in the daemon.
- Learning superseding logic (replacing an old learning with a newer contradicting one) is described in the schema but the automatic superseding heuristic in `keeper.ts` may need tuning in practice.

**Multi-user concurrency (M5)**
- The daemon enforces a per-user concurrent worker limit but there is no queuing — tasks beyond the limit are simply deferred to the next poll cycle. Under burst load, tasks may wait several poll cycles.

**Notifications (M6)**
- Slack and Teams webhook targets are configured globally. Per-user or per-repo notification routing is not implemented.

**Scaling (general)**
- The system is designed for a single Container App replica. If scaled to multiple replicas, the in-memory `PreviewManager` map and the daemon's in-process scheduler would diverge. A distributed lock or moving preview state entirely to the DB would be needed.

**Testing**
- Integration tests require a live `DATABASE_URL`. The preview integration test is skipped in CI (no Docker daemon in the test environment). End-to-end preview validation against a real compose stack has no automated test.
