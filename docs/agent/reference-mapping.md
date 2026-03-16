# Broken Reference Mapping — docs/agent/index.md

This file records the audit of all 108 broken path references found in `docs/agent/index.md`.
Each reference is classified as **relocated** (new path recorded) or **deleted** (file removed).

All paths in the doc are relative (no `src/` prefix). The actual files live under `src/`.

---

## Auth

| Broken path in doc | Status | Correct path |
|---|---|---|
| `auth/middleware.ts` | ✅ EXISTS | `src/auth/middleware.ts` — path prefix `src/` needed |
| `auth/session.ts` | ✅ EXISTS | `src/auth/session.ts` |
| `auth/entra.ts` | ✅ EXISTS | `src/auth/entra.ts` |

> All three auth files exist — the doc links are missing the `src/` prefix.

---

## Dashboard / Server

| Broken path in doc | Status | Correct path |
|---|---|---|
| `dashboard/server.ts` | ✅ EXISTS | `src/dashboard/server.ts` |

---

## Dashboard / Views

| Broken path in doc | Status | Correct path |
|---|---|---|
| `dashboard/views/costs.ts` | ✅ EXISTS | `src/dashboard/views/costs.ts` |
| `dashboard/views/dashboard.ts` | ✅ EXISTS | `src/dashboard/views/dashboard.ts` |
| `dashboard/views/instances.ts` | ✅ EXISTS | `src/dashboard/views/instances.ts` |
| `dashboard/views/profile.ts` | ✅ EXISTS | `src/dashboard/views/profile.ts` |
| `dashboard/views/health.ts` | ✅ EXISTS | `src/dashboard/views/health.ts` |
| `dashboard/views/logs.ts` | ✅ EXISTS | `src/dashboard/views/logs.ts` |
| `dashboard/views/hivemind.ts` | ✅ EXISTS | `src/dashboard/views/hivemind.ts` |
| `dashboard/views/layout.ts` | ✅ EXISTS | `src/dashboard/views/layout.ts` |
| `dashboard/views/prompts.ts` | ✅ EXISTS | `src/dashboard/views/prompts.ts` |
| `dashboard/views/tasks.ts` | ✅ EXISTS | `src/dashboard/views/tasks.ts` |
| `dashboard/views/permissions.ts` | ✅ EXISTS | `src/dashboard/views/permissions.ts` |
| `dashboard/views/producers.ts` | ✅ EXISTS | `src/dashboard/views/producers.ts` |
| `dashboard/views/settings.ts` | ✅ EXISTS | `src/dashboard/views/settings.ts` |
| `dashboard/views/workflow.ts` | ✅ EXISTS | `src/dashboard/views/workflow.ts` |
| `dashboard/views/changelog.ts` | ✅ EXISTS | `src/dashboard/views/changelog.ts` |
| `dashboard/views/components.ts` | ✅ EXISTS | `src/dashboard/views/components.ts` |
| `dashboard/views/tasks.test.ts` | ✅ EXISTS | `src/dashboard/views/tasks.test.ts` |

---

## Dashboard / Routes

| Broken path in doc | Status | Correct path |
|---|---|---|
| `dashboard/routes/costs.ts` | ✅ EXISTS | `src/dashboard/routes/costs.ts` |
| `dashboard/routes/dashboard.ts` | ✅ EXISTS | `src/dashboard/routes/dashboard.ts` |
| `dashboard/routes/instances.ts` | ✅ EXISTS | `src/dashboard/routes/instances.ts` |
| `dashboard/routes/profile.ts` | ✅ EXISTS | `src/dashboard/routes/profile.ts` |
| `dashboard/routes/health.ts` | ✅ EXISTS | `src/dashboard/routes/health.ts` |
| `dashboard/routes/logs.ts` | ✅ EXISTS | `src/dashboard/routes/logs.ts` |
| `dashboard/routes/hivemind.ts` | ✅ EXISTS | `src/dashboard/routes/hivemind.ts` |
| `dashboard/routes/preview-test.ts` | ✅ EXISTS | `src/dashboard/routes/preview-test.ts` |
| `dashboard/routes/tasks.ts` | ✅ EXISTS | `src/dashboard/routes/tasks.ts` |
| `dashboard/routes/permissions.ts` | ✅ EXISTS | `src/dashboard/routes/permissions.ts` |
| `dashboard/routes/producers.ts` | ✅ EXISTS | `src/dashboard/routes/producers.ts` |
| `dashboard/routes/settings.ts` | ✅ EXISTS | `src/dashboard/routes/settings.ts` |

> **Note:** The doc does NOT list these new route files that now exist in `src/dashboard/routes/`:
> `changelog.ts`, `diagram.ts`, `prompts.ts`, `repos.ts`, `workflow.ts`
> These are missing from the doc entirely (additions for Milestone 2/3).

---

## Vault

| Broken path in doc | Status | Correct path |
|---|---|---|
| `vault/keyvault.ts` | ✅ EXISTS | `src/vault/keyvault.ts` |

---

## Execution

| Broken path in doc | Status | Correct path |
|---|---|---|
| `execution/worker.ts` | ✅ EXISTS | `src/execution/worker.ts` |
| `execution/disk-cleaner.ts` | ✅ EXISTS | `src/execution/disk-cleaner.ts` |
| `execution/milestone-review.ts` | ✅ EXISTS | `src/execution/milestone-review.ts` |
| `execution/preview/manager.ts` | ✅ EXISTS | `src/execution/preview/manager.ts` |
| `execution/preview/remote-docker.ts` | ✅ EXISTS | `src/execution/preview/remote-docker.ts` |
| `execution/preview/validator.ts` | ✅ EXISTS | `src/execution/preview/validator.ts` |
| `execution/preview/types.ts` | ✅ EXISTS | `src/execution/preview/types.ts` |
| `execution/worker-tools.ts` | ✅ EXISTS | `src/execution/worker-tools.ts` |
| `execution/build-system.ts` | ✅ EXISTS | `src/execution/build-system.ts` |
| `execution/browser-tools.ts` | ✅ EXISTS | `src/execution/browser-tools.ts` |
| `execution/worktree.ts` | ✅ EXISTS | `src/execution/worktree.ts` |
| `execution/git-provider.ts` | ✅ EXISTS | `src/execution/git-provider.ts` |
| `execution/review-gate.ts` | ✅ EXISTS | `src/execution/review-gate.ts` |

> **New files not in doc:** `src/execution/exec-group.ts`, `src/execution/preview/proxy.ts`

---

## Producers

| Broken path in doc | Status | Correct path |
|---|---|---|
| `producers/base.ts` | ✅ EXISTS | `src/producers/base.ts` |
| `producers/doc-auditor.ts` | ✅ EXISTS | `src/producers/doc-auditor.ts` |
| `producers/maintenance.ts` | ✅ EXISTS | `src/producers/maintenance.ts` |
| `producers/feature-scout.ts` | ✅ EXISTS | `src/producers/feature-scout.ts` |
| `producers/bug-hunter.ts` | ✅ EXISTS | `src/producers/bug-hunter.ts` |
| `producers/self-monitor.ts` | ✅ EXISTS | `src/producers/self-monitor.ts` |
| `producers/security-scanner.ts` | ✅ EXISTS | `src/producers/security-scanner.ts` |
| `producers/log-scanner.ts` | ✅ EXISTS | `src/producers/log-scanner.ts` |

> **New files not in doc:** `src/producers/ado-work-items.ts`, `src/producers/github-issues.ts`

---

## Enrichers

| Broken path in doc | Status | Correct path |
|---|---|---|
| `enrichers/base.ts` | ✅ EXISTS | `src/enrichers/base.ts` |
| `enrichers/index.ts` | ✅ EXISTS | `src/enrichers/index.ts` |
| `enrichers/docs.ts` | ✅ EXISTS | `src/enrichers/docs.ts` |
| `enrichers/codebase.ts` | ✅ EXISTS | `src/enrichers/codebase.ts` |
| `enrichers/git-history.ts` | ✅ EXISTS | `src/enrichers/git-history.ts` |
| `enrichers/scorer.ts` | ✅ EXISTS | `src/enrichers/scorer.ts` |
| `enrichers/dependencies.ts` | ✅ EXISTS | `src/enrichers/dependencies.ts` |
| `enrichers/prism.ts` | ✅ EXISTS | `src/enrichers/prism.ts` |
| `enrichers/architect.ts` | ✅ EXISTS | `src/enrichers/architect.ts` |

---

## Agents

| Broken path in doc | Status | Correct path |
|---|---|---|
| `agents/sdk.ts` | ✅ EXISTS | `src/agents/sdk.ts` |
| `agents/pipeline.ts` | ✅ EXISTS | `src/agents/pipeline.ts` |
| `agents/router.ts` | ✅ EXISTS | `src/agents/router.ts` |
| `agents/gate.ts` | ✅ EXISTS | `src/agents/gate.ts` |
| `agents/gate-analyst.ts` | ✅ EXISTS | `src/agents/gate-analyst.ts` |
| `agents/keeper.ts` | ✅ EXISTS | `src/agents/keeper.ts` |
| `agents/decomposer.ts` | ✅ EXISTS | `src/agents/decomposer.ts` |
| `agents/refiner.ts` | ✅ EXISTS | `src/agents/refiner.ts` |
| `agents/retrospective.ts` | ✅ EXISTS | `src/agents/retrospective.ts` |
| `agents/feedback-loop.ts` | ✅ EXISTS | `src/agents/feedback-loop.ts` |
| `agents/retry.ts` | ✅ EXISTS | `src/agents/retry.ts` |
| `agents/cost-utils.ts` | ✅ EXISTS | `src/agents/cost-utils.ts` |
| `agents/browser-validator.ts` | ✅ EXISTS | `src/agents/browser-validator.ts` |
| `agents/code-quality-analyst.ts` | ✅ EXISTS | `src/agents/code-quality-analyst.ts` |

---

## Daemon

| Broken path in doc | Status | Correct path |
|---|---|---|
| `daemon/daemon.ts` | ✅ EXISTS | `src/daemon/daemon.ts` |
| `daemon/scheduler.ts` | ✅ EXISTS | `src/daemon/scheduler.ts` |
| `daemon/preview-cleanup.ts` | ✅ EXISTS | `src/daemon/preview-cleanup.ts` |
| `daemon/pr-close-cleanup.ts` | ✅ EXISTS | `src/daemon/pr-close-cleanup.ts` |
| `daemon/pr-feedback-poll.ts` | ✅ EXISTS | `src/daemon/pr-feedback-poll.ts` |
| `daemon/stale-tasks.ts` | ✅ EXISTS | `src/daemon/stale-tasks.ts` |

---

## Integrations

| Broken path in doc | Status | Correct path |
|---|---|---|
| `integrations/azure-monitor.ts` | ✅ EXISTS | `src/integrations/azure-monitor.ts` |
| `integrations/azure-devops.ts` | ✅ EXISTS | `src/integrations/azure-devops.ts` |

---

## Database

| Broken path in doc | Status | Correct path |
|---|---|---|
| `db/schema.ts` | ✅ EXISTS | `src/db/schema.ts` |
| `db/migrate.ts` | ✅ EXISTS | `src/db/migrate.ts` |
| `db/queries/tasks.ts` | ✅ EXISTS | `src/db/queries/tasks.ts` |
| `db/queries/task-events.ts` | ✅ EXISTS | `src/db/queries/task-events.ts` |
| `db/queries/users.ts` | ✅ EXISTS | `src/db/queries/users.ts` |
| `db/queries/user-credentials.ts` | ✅ EXISTS | `src/db/queries/user-credentials.ts` |
| `db/queries/user-repo-access.ts` | ✅ EXISTS | `src/db/queries/user-repo-access.ts` |
| `db/queries/repos.ts` | ✅ EXISTS | `src/db/queries/repos.ts` |
| `db/queries/costs.ts` | ✅ EXISTS | `src/db/queries/costs.ts` |
| `db/queries/active-agents.ts` | ✅ EXISTS | `src/db/queries/active-agents.ts` |
| `db/queries/code-reviews.ts` | ✅ EXISTS | `src/db/queries/code-reviews.ts` |
| `db/queries/gate-decisions.ts` | ✅ EXISTS | `src/db/queries/gate-decisions.ts` |
| `db/queries/learnings.ts` | ✅ EXISTS | `src/db/queries/learnings.ts` |
| `db/queries/learning-events.ts` | ✅ EXISTS | `src/db/queries/learning-events.ts` |
| `db/queries/enrichment-runs.ts` | ✅ EXISTS | `src/db/queries/enrichment-runs.ts` |
| `db/queries/preview-instances.ts` | ✅ EXISTS | `src/db/queries/preview-instances.ts` |
| `db/queries/preview-logs.ts` | ✅ EXISTS | `src/db/queries/preview-logs.ts` |
| `db/queries/producer-runs.ts` | ✅ EXISTS | `src/db/queries/producer-runs.ts` |

---

## Domain

| Broken path in doc | Status | Correct path |
|---|---|---|
| `domain/types.ts` | ✅ EXISTS | `src/domain/types.ts` |
| `domain/config.ts` | ✅ EXISTS | `src/domain/config.ts` |
| `domain/autonomous-config.ts` | ✅ EXISTS | `src/domain/autonomous-config.ts` |
| `domain/state-machine.ts` | ✅ EXISTS | `src/domain/state-machine.ts` |

---

## Summary

**Total broken references in doc: 108**

All 108 broken references fall into a single pattern: the doc uses paths like `auth/middleware.ts` but the actual files live at `src/auth/middleware.ts`. Every single referenced file **still exists** — none have been deleted. The fix for Milestone 2 is to update every Markdown link in `docs/agent/index.md` from `foo/bar.ts` → `../../src/foo/bar.ts` (relative from `docs/agent/`) or use an absolute repo path like `src/foo/bar.ts`.

### Classification

| Category | Count | Status |
|---|---|---|
| Relocated (path prefix `src/` missing) | 108 | All 108 references need path updated |
| Deleted (file gone) | 0 | None |

### New files not yet documented (bonus — for Milestone 2/3 consideration)

- `src/dashboard/routes/changelog.ts`
- `src/dashboard/routes/diagram.ts`
- `src/dashboard/routes/prompts.ts`
- `src/dashboard/routes/repos.ts`
- `src/dashboard/routes/workflow.ts`
- `src/execution/exec-group.ts`
- `src/execution/preview/proxy.ts`
- `src/producers/ado-work-items.ts`
- `src/producers/github-issues.ts`
- `src/db/connection.ts`
- `src/blueprints/parser.ts`
- `src/hive-yaml.ts`
- `src/index.ts`
- `src/log-buffer.ts`
- `src/logger.ts`
- `src/notifications.ts`
- `src/prompt-cache.ts`
- `src/prompts.ts`
- `src/telemetry.ts`
- `src/utils/retry.ts`
- `src/cli.ts`
- `src/dashboard/views/diagram.ts`
- `src/dashboard/views/repos.ts`
