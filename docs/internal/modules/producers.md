# Producers Module

> **Location:** `src/producers/`
> **Purpose:** Autonomous task generation layer — producers discover work items from a variety of signals (code analysis, logs, security scans, documentation gaps) and inject them into The Hive pipeline as new tasks.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [Base Abstractions — `base.ts`](#base-abstractions--basets)
   - [Core Types](#core-types)
   - [Repo Summary Helper](#repo-summary-helper)
   - [Title Validation](#title-validation)
   - [Duplicate Detection](#duplicate-detection)
3. [Producer Implementations](#producer-implementations)
   - [Bug Hunter — `bug-hunter.ts`](#bug-hunter--bug-hunterts)
   - [Feature Scout — `feature-scout.ts`](#feature-scout--feature-scoults)
   - [Security Scanner — `security-scanner.ts`](#security-scanner--security-scannerts)
   - [Doc Auditor — `doc-auditor.ts`](#doc-auditor--doc-auditorts)
   - [Log Scanner — `log-scanner.ts`](#log-scanner--log-scannerts)
   - [Self Monitor — `self-monitor.ts`](#self-monitor--self-monitorts)
   - [Maintenance Producer — `maintenance.ts`](#maintenance-producer--maintenancets)
4. [Producer Registration and Scheduling](#producer-registration-and-scheduling)
5. [Task Creation Workflow](#task-creation-workflow)
6. [Deduplication and Safety Guards](#deduplication-and-safety-guards)
7. [Producer Output Examples](#producer-output-examples)
8. [Integration Patterns](#integration-patterns)
9. [Adding a New Producer](#adding-a-new-producer)
10. [See Also](#see-also)

---

## Module Overview

Producers are the entry point of the autonomous pipeline. While human users can submit tasks directly through the dashboard, producers run on a schedule and generate tasks automatically by analysing different data sources.

Each producer:

1. **Examines a signal** — source code, logs, monitoring data, or documentation.
2. **Calls Claude** (most producers) to reason about what tasks would be valuable.
3. **Checks for duplicates** before writing anything to the database.
4. **Creates tasks** via `src/db/queries/tasks.ts` so they enter the standard pipeline.
5. **Returns a `ProducerResult`** summarising what was created, skipped, and what errored.

### File Map

| File | Signal source | Uses LLM | `needsRepo` | `global` |
|---|---|---|---|---|
| `base.ts` | — (shared utilities) | No | — | — |
| `bug-hunter.ts` | Repository source code | Yes | Yes | No |
| `feature-scout.ts` | Repository source code | Yes | Yes | No |
| `security-scanner.ts` | Repository source code | Yes | Yes | No |
| `doc-auditor.ts` | Repository documentation files | No | Yes | No |
| `log-scanner.ts` | Azure Monitor (KQL) | No | No | Yes |
| `self-monitor.ts` | In-process log buffer | No | No | Yes |
| `maintenance.ts` | Repository source code | Yes | Yes | No |

### Relationship to the Pipeline

```
Daemon tick
  └─ for each registered producer:
       └─ producer.run(ctx)
            └─ discovers work items
            └─ isDuplicate() check
            └─ create(task)          ← inserts into tasks table
                 └─ task status: "pending"
                      └─ Router → Queued → Pipeline → Done
```

Producers only create tasks. They do not enrich, route, or execute them — that is the responsibility of the agents pipeline. Once a producer calls `create()`, the normal enrichment and execution flow takes over automatically.

---

## Base Abstractions — `base.ts`

All shared types, helpers, and guards used by every producer live in `base.ts`. No producer imports from another producer; they all import only from `base.ts`.

### Core Types

#### `ProducerContext`

Passed by the daemon to every producer's `run()` method. Contains everything a producer needs to know about its operating environment:

```ts
interface ProducerContext {
  repoId: number;          // database ID of the target repository
  repoFullName: string;    // e.g. "acme-corp/backend-api"
  repoDir?: string;        // path to the local shallow clone (set when needsRepo: true)
  createdBy: number;       // user ID that owns auto-created tasks
  dryRun?: boolean;        // when true, log what would be created but don't write to DB
  config?: Record<string, unknown>; // producer-specific config from autonomous.config.yaml
}
```

#### `ProducerResult`

The return value from every `run()` call. The daemon records this in the `producer_runs` table for observability:

```ts
interface ProducerResult {
  tasksCreated: number;       // how many new tasks were inserted
  duplicatesSkipped: number;  // how many candidates were dropped due to deduplication
  errors: string[];           // non-fatal error messages (producer continues on error)
  costUsd: number;            // total LLM cost incurred by this run
}
```

#### `Producer` Interface

The contract every producer must satisfy:

```ts
interface Producer {
  name: string;
  /** When true the daemon will shallow-clone the repo before running. */
  needsRepo?: boolean;
  /** When true, runs once per daemon tick against the self-repo (not per-repo). */
  global?: boolean;
  run(ctx: ProducerContext): Promise<ProducerResult>;
}
```

- **`needsRepo: true`** — the daemon ensures a shallow clone of the repository is present at `ctx.repoDir` before calling `run()`. Producers that analyse source code set this flag.
- **`global: true`** — the daemon runs the producer exactly once per tick, passing the self-repo context (The Hive's own repository). Used for infrastructure-level monitors that operate on process-level data rather than per-repo data.

### Repo Summary Helper

```ts
export function gatherRepoSummary(repoDir: string): string | undefined
```

Builds a compact textual summary of a local repository clone for inclusion in LLM prompts. Returns `undefined` if `repoDir` does not exist (allowing producers to handle the missing-clone case gracefully).

**What it collects:**

| Section | Details |
|---|---|
| File tree | Breadth-first traversal, capped at **200 files** |
| README | First **3 000 characters** of any recognised README file |

**Directories skipped during tree walk:**

```
node_modules  .git  dist  build  .next  coverage
.turbo  __pycache__  .venv  vendor
```

**Output format:**

```
## File tree
src/index.ts
src/agents/router.ts
src/db/schema.ts
...

## README
# My Project
A brief description...
```

This summary is embedded directly into the LLM prompt so Claude can make repository-aware suggestions without having to read individual files.

### Title Validation

```ts
export function isRefusalTitle(title: string): boolean
```

Protects against LLM refusals being inserted as task titles. Returns `true` (indicating the title should be discarded) when:

- The title is longer than **200 characters** (a genuine task title is always concise), or
- The title matches any of the refusal patterns:

```
"I don't have the ability to…"
"I cannot directly access…"
"I can't access/analyze/browse/review/read…"
"I don't have access to…"
"share the relevant code…"
"provide the link/source code/relevant…"
"I would need you to…"
"I'd be happy to help … if/once you…"
```

LLM producers call `isRefusalTitle(title)` on every candidate before the duplicate check. A refusal title is logged as an error and the candidate is skipped.

### Duplicate Detection

```ts
export async function isDuplicate(source: string, title: string): Promise<boolean>
```

Queries the `tasks` table for an existing task matching both `source` and `title` that is **not** in a terminal status. Returns `true` if a duplicate is found.

**Terminal statuses** (not considered live duplicates):

```
failed  |  cancelled  |  merged  |  done
```

This means if a bug was fixed (status: `done`) and the same bug is discovered again in a future scan, a new task will be created. Only active, in-flight tasks block new creation.

**Deduplication key:** `(source, title)` — the `source` field is typically the producer name (e.g. `"bug-hunter"`, `"security-scanner"`), providing namespace isolation between producers.

---

## Producer Implementations

### Bug Hunter — `bug-hunter.ts`

Analyses repository source code and uses Claude to surface potential bugs, logic errors, and code quality issues that warrant a dedicated fix task.

#### Signal Source

A shallow clone of the target repository (`needsRepo: true`). The producer reads the file tree and README via `gatherRepoSummary()` and sends it to Claude as context.

#### How It Works

```
ctx.repoDir → gatherRepoSummary()
  └─ Claude prompt: "Identify up to N potential bugs in this repository…"
       └─ JSON response: array of { title, body } candidates
            └─ for each candidate:
                 ├─ isRefusalTitle(title)?  → skip
                 ├─ isDuplicate("bug-hunter", title)?  → skip
                 └─ create({ title, body, source: "bug-hunter", type: "bug", ... })
```

#### Configuration (`autonomous.config.yaml`)

```yaml
producers:
  bugHunter:
    enabled: true
    maxTasksPerRun: 3      # Claude is asked to return at most this many bugs
    model: claude-sonnet-4-6
```

The `maxTasksPerRun` cap prevents the bug hunter from flooding the queue on a first run against a codebase with many issues.

#### LLM Prompt Strategy

The system prompt instructs Claude to act as a senior code reviewer. The user prompt includes:

```
Repository: <repoFullName>

<repo_summary>
## File tree
...
## README
...
</repo_summary>

Identify up to <maxTasksPerRun> potential bugs or code quality issues in this repository.
Return a JSON array of objects with "title" and "body" fields.
```

Claude is explicitly told to return **only** issues it can reason about from the file tree and README — it must not hallucinate specific line numbers or file paths it hasn't seen.

#### Output Shape (from Claude)

```json
[
  {
    "title": "Missing null check before accessing user.profile in auth middleware",
    "body": "In the authentication middleware, `user.profile` is accessed without a null check. If a user record lacks a profile (e.g. newly created accounts), this will throw a TypeError at runtime."
  },
  {
    "title": "Potential race condition in task status update",
    "body": "The task status is read and then updated in two separate queries without a transaction, creating a window where concurrent requests could both see the same status and both proceed."
  }
]
```

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"bug-hunter"` |
| `type` | `"bug"` |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` |
| `createdBy` | from `ctx.createdBy` |

---

### Feature Scout — `feature-scout.ts`

Scouts for valuable feature opportunities by analysing a repository's existing capabilities and identifying gaps or enhancements that would meaningfully improve the codebase.

#### Signal Source

Same as Bug Hunter: repository file tree and README (`needsRepo: true`).

#### How It Works

```
ctx.repoDir → gatherRepoSummary()
  └─ Claude prompt: "Identify up to N feature improvements for this repository…"
       └─ JSON response: array of { title, body } candidates
            └─ for each candidate:
                 ├─ isRefusalTitle(title)?  → skip
                 ├─ isDuplicate("feature-scout", title)?  → skip
                 └─ create({ title, body, source: "feature-scout", type: "feature", ... })
```

#### Configuration (`autonomous.config.yaml`)

```yaml
producers:
  featureScout:
    enabled: true
    maxTasksPerRun: 3
    model: claude-sonnet-4-6
```

#### LLM Prompt Strategy

The system prompt instructs Claude to think as a product-minded senior engineer. The user prompt asks for concrete, actionable improvements — not vague aspirations:

```
Repository: <repoFullName>

<repo_summary>...</repo_summary>

Identify up to <maxTasksPerRun> concrete feature improvements or enhancements.
Focus on changes that would have high value and are achievable without a major rewrite.
Return a JSON array of objects with "title" and "body" fields.
```

#### Output Shape (from Claude)

```json
[
  {
    "title": "Add rate limiting to public API endpoints",
    "body": "The public API currently has no rate limiting. Adding per-IP rate limiting (e.g. 100 req/min) would protect against abuse and improve reliability for legitimate users."
  },
  {
    "title": "Implement request caching for expensive dashboard queries",
    "body": "Several dashboard API routes perform full table scans on every request. A short TTL cache (30–60 seconds) for these endpoints would reduce database load significantly."
  }
]
```

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"feature-scout"` |
| `type` | `"feature"` |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` |
| `createdBy` | from `ctx.createdBy` |

---

### Security Scanner — `security-scanner.ts`

Reviews repository source code for security vulnerabilities, misconfigurations, and risky patterns, creating high-priority security tasks for issues found.

#### Signal Source

Repository file tree and README (`needsRepo: true`). Like Bug Hunter and Feature Scout, it uses `gatherRepoSummary()` to build repository context.

#### How It Works

```
ctx.repoDir → gatherRepoSummary()
  └─ Claude prompt: "Identify up to N security vulnerabilities in this repository…"
       └─ JSON response: array of { title, body } candidates
            └─ for each candidate:
                 ├─ isRefusalTitle(title)?  → skip
                 ├─ isDuplicate("security-scanner", title)?  → skip
                 └─ create({ title, body, source: "security-scanner", type: "security", ... })
```

#### Configuration (`autonomous.config.yaml`)

```yaml
producers:
  securityScanner:
    enabled: true
    maxTasksPerRun: 3
    model: claude-sonnet-4-6
```

#### LLM Prompt Strategy

The system prompt instructs Claude to act as a security engineer conducting a lightweight threat model. The prompt emphasises actionable, reproducible issues over theoretical concerns:

```
Repository: <repoFullName>

<repo_summary>...</repo_summary>

Identify up to <maxTasksPerRun> security vulnerabilities or risk areas.
Focus on: injection risks, authentication gaps, secrets exposure, insecure dependencies,
and missing input validation.
Return a JSON array of objects with "title" and "body" fields.
```

#### Output Shape (from Claude)

```json
[
  {
    "title": "Session secret falls back to a hardcoded default in development",
    "body": "The SESSION_SECRET environment variable has a hardcoded fallback value ('dev-secret') in the application config. If this is ever deployed without setting the env var, sessions can be trivially forged."
  },
  {
    "title": "Missing CSRF protection on state-mutating API routes",
    "body": "POST/PUT/DELETE routes under /api/ do not enforce CSRF tokens. Any page that can embed cross-origin requests (e.g. via a form or fetch) could trigger unintended state changes on behalf of authenticated users."
  }
]
```

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"security-scanner"` |
| `type` | `"security"` |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` |
| `createdBy` | from `ctx.createdBy` |

---

### Doc Auditor — `doc-auditor.ts`

Crawls a repository's documentation files to detect outdated, missing, or incomplete documentation, and creates improvement tasks without involving an LLM.

#### Signal Source

Actual documentation files found in the repository (`needsRepo: true`). This is the only code-reading producer — it directly reads file contents rather than just the tree summary.

#### How It Works

Unlike the LLM-based producers, the Doc Auditor uses a rule-based approach:

```
ctx.repoDir → scan for doc files (*.md, *.rst, *.txt in docs/, README*)
  └─ for each doc file:
       ├─ read contents
       ├─ apply heuristic rules to detect issues:
       │    ├─ empty or near-empty files (< threshold chars)
       │    ├─ placeholder text ("TODO", "FIXME", "TBD", "Coming soon")
       │    ├─ broken internal links ([text](./path) where path doesn't exist)
       │    └─ stale markers (dates more than N months in the past)
       └─ for each issue found:
            ├─ isDuplicate("doc-auditor", title)?  → skip
            └─ create({ title, body, source: "doc-auditor", type: "improvement", ... })
```

#### File Discovery

The auditor scans for documentation using these heuristics:

- Files matching `**/*.md`, `**/*.rst` under `docs/`, `doc/`, or project root
- `README*` files at any level
- Capped at a reasonable maximum to avoid scanning generated output directories

#### Output Shape (rule-derived, no LLM)

```json
[
  {
    "title": "docs/api.md contains placeholder content",
    "body": "The file docs/api.md exists but contains only TODO placeholders and no actual API documentation. This should be completed with accurate endpoint descriptions."
  },
  {
    "title": "Broken internal link in docs/architecture.md",
    "body": "docs/architecture.md contains a link to ./modules/legacy.md which does not exist in the repository. The link should be updated or the target file created."
  }
]
```

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"doc-auditor"` |
| `type` | `"improvement"` |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` |
| `createdBy` | from `ctx.createdBy` |
| `costUsd` | always `0` (no LLM call) |

---

### Log Scanner — `log-scanner.ts`

Queries Azure Monitor (Log Analytics) using KQL to find error patterns and anomalies in production logs, converting recurring issues into tracked tasks.

#### Signal Source

Azure Monitor via the `runKqlQuery` integration (`src/integrations/azure-monitor.ts`). This producer does **not** need a repository clone (`needsRepo` is unset) and runs as a global producer (`global: true`) — once per daemon tick, not once per monitored repository.

#### How It Works

```
Azure Monitor workspace
  └─ runKqlQuery(config, kql, timespan)
       └─ rows: [{ errorMessage, count, firstSeen, lastSeen, ... }]
            └─ for each row above threshold:
                 ├─ isDuplicate("log-scanner", title)?  → skip
                 └─ create({ title, body, source: "log-scanner", type: "bug", ... })
```

#### Configuration (`autonomous.config.yaml`)

```yaml
producers:
  logScanner:
    enabled: true
    workspaceId: "<azure-log-analytics-workspace-id>"
    timespan: PT24H          # ISO 8601 duration — look-back window
    minOccurrences: 5        # minimum error count before creating a task
    kql: |
      AppExceptions
      | where TimeGenerated > ago(24h)
      | summarize count() by OuterMessage
      | where count_ >= 5
      | order by count_ desc
      | take 10
```

The KQL query is fully configurable. The example above surfaces the top-10 exception messages that occurred at least 5 times in the last 24 hours.

#### Azure Authentication

The integration uses `DefaultAzureCredential` from `@azure/identity`, which resolves credentials from the environment in this order: environment variables → workload identity → managed identity → Azure CLI. No secrets are stored in code.

If `AZURE_MONITOR_WORKSPACE_ID` is unset or the credential cannot be obtained, `runKqlQuery` returns an empty array and logs a warning — the producer will create zero tasks for that tick without crashing.

#### Title Construction

Each log scanner task title is derived directly from the KQL result row:

```
"Recurring error in production: <OuterMessage>"
```

The body includes occurrence count, timespan, and first/last seen timestamps as returned by the KQL query.

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"log-scanner"` |
| `type` | `"bug"` |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` (the self-repo) |
| `createdBy` | from `ctx.createdBy` |
| `costUsd` | always `0` (no LLM call) |

---

### Self Monitor — `self-monitor.ts`

Watches The Hive's own in-process log buffer for repeated errors or warnings and auto-creates tasks to address its own operational problems.

#### Signal Source

The in-process `logBuffer` singleton (`src/log-buffer.ts`). This producer is `global: true` — it has no per-repo context and does not need a clone.

#### How It Works

```
logBuffer.getEntries()
  └─ group by (level, message template)
       └─ for each group with count ≥ threshold:
            ├─ isDuplicate("self-monitor", title)?  → skip
            └─ create({ title, body, source: "self-monitor", type: "bug", ... })
```

The log buffer retains a rolling window of recent log entries in memory. The self-monitor groups them by normalised message (with variable parts like IDs and timestamps stripped) to detect repeated patterns.

#### Configuration (`autonomous.config.yaml`)

```yaml
producers:
  selfMonitor:
    enabled: true
    minOccurrences: 3        # minimum repeated log entries to trigger a task
    levels: [error, warn]    # which log levels to monitor
    windowMinutes: 60        # rolling window to look back
```

#### Title Construction

```
"Repeated <LEVEL> in Hive daemon: <normalised message>"
```

Example:

```
"Repeated ERROR in Hive daemon: Gate agent failed to evaluate task"
```

The task body includes a sample of the raw log entries (with full structured fields) to give the executing agent enough context to reproduce and fix the issue.

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"self-monitor"` |
| `type` | `"bug"` |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` (the self-repo) |
| `createdBy` | from `ctx.createdBy` |
| `costUsd` | always `0` (no LLM call) |

---

### Maintenance Producer — `maintenance.ts`

Scans repository source code for technical debt signals — legacy patterns, outdated dependencies, overgrown functions, duplicated logic, dead code, and stale type definitions — and creates prioritised maintenance (`chore`) tasks. Unlike the other LLM producers, every finding is scored on a four-axis matrix so the daemon can rank work by concrete value rather than discovery order.

#### Signal Source

Repository file tree and README (`needsRepo: true`). The producer builds context via `gatherRepoSummary()` and passes it to Claude with a dedicated system prompt loaded from `src/prompts/producers/maintenance.md` via `loadPrompt()`.

#### Scan Categories

The LLM is instructed to look for findings across exactly six categories:

| Category | What it flags |
|---|---|
| `legacy` | Deprecated APIs, old framework patterns, archaic language constructs that should be modernised (e.g. `var`, CommonJS `require` in an ESM codebase, callback-style code where async/await is standard) |
| `outdated-deps` | Package dependencies that are significantly behind their latest stable release, especially those with known issues or breaking changes in newer versions |
| `complexity` | Functions or modules that have grown too large or too deeply nested — high cyclomatic complexity, god objects, or files that violate the single-responsibility principle |
| `duplication` | Similar or identical code blocks scattered across multiple files that could be extracted into a shared utility or module |
| `dead-code` | Exported symbols, entire modules, feature flags, or commented-out blocks that are no longer referenced anywhere in the codebase |
| `stale-types` | TypeScript type definitions, interfaces, or enums that have drifted from the shapes they describe — missing fields, wrong types, or types that reference removed properties |

The LLM returns **up to 8 findings** per run, sorted by priority. The prompt instructs Claude to prefer concrete, actionable items over vague "clean this up" suggestions.

#### Four-Axis Scoring System

Each finding carries four scores on a **1–5 scale**, which the producer uses to compute a composite priority:

| Axis | Scale | Meaning |
|---|---|---|
| `value` | 1 (trivial) → 5 (high) | How much does fixing this improve correctness, performance, or developer experience? |
| `complexity` | 1 (trivial) → 5 (very hard) | How much effort is required to implement the fix? |
| `risk` | 1 (safe) → 5 (dangerous) | How likely is the change to introduce regressions or require careful coordination? |
| `block` | 1 (not blocking) → 5 (actively blocking) | Is this debt actively preventing other work from progressing? |

##### Priority Formula

```
priority = (value × 2) + (block × 2) − complexity − risk
```

The formula is evaluated **server-side** after parsing the LLM response — this guards against arithmetic errors in the model's output. The resulting priority is an integer that ranges roughly from −8 (very costly/risky with little payoff) to +16 (high value, blocking, low effort and risk).

Findings are sorted **descending by priority** before task creation, so the most impactful maintenance work lands at the top of the queue.

##### Size Mapping

Task size (`small` / `medium` / `large`) is derived from the `complexity` score:

| Complexity score | Task size |
|---|---|
| 1 | `small` |
| 2–3 | `medium` |
| 4–5 | `large` |

#### How It Works

```
ctx.repoDir → gatherRepoSummary()
  └─ Claude prompt (system: maintenance.md prompt):
       "Analyse this repository for technical debt across 6 categories.
        Return up to 8 findings as a JSON array with title, body,
        category, scores (value/complexity/risk/block), and priority."
       └─ JSON response: MaintenanceFinding[]
            └─ server-side: recompute priority, sort descending
            └─ for each finding:
                 ├─ isRefusalTitle(title)?  → skip
                 ├─ isDuplicate("producer:maintenance", title)?  → skip
                 └─ create({ title, body + score table,
                              source: "producer:maintenance",
                              type: "chore", size, ... })
```

#### Deduplication

The maintenance producer uses the source key `"producer:maintenance"` for deduplication (not just `"maintenance"`). `isDuplicate("producer:maintenance", title)` is called before every task creation. Any finding whose title matches an existing, non-terminal task (i.e. not `done`, `failed`, `cancelled`, or `merged`) is skipped and counted in `duplicatesSkipped`.

This means the producer is safe to run on a daily schedule — previously created maintenance tasks that are still being worked on will not be duplicated.

#### Score Table in Task Body

To give agents and reviewers full context, the score breakdown is appended to every task body as a Markdown table:

```markdown
---
**Maintenance analysis scores**

| Axis       | Score |
|------------|-------|
| Value      | 4/5   |
| Complexity | 2/5   |
| Risk       | 1/5   |
| Block      | 3/5   |
| **Priority** | **12** |

_Category: legacy_
```

This makes scoring decisions visible and auditable without needing to inspect producer logs.

#### LLM Response Schema

Claude is instructed to return a JSON array conforming to this shape:

```jsonc
[
  {
    "title": "Replace callback-style fs.readFile with fs/promises throughout",
    "body": "12 files still use the callback form of fs.readFile/fs.writeFile…",
    "category": "legacy",
    "scores": {
      "value": 3,
      "complexity": 2,
      "risk": 1,
      "block": 1
    },
    "priority": 8
  }
]
```

The parser in `parseFindings()` is defensive: it strips markdown fences, handles `NONE` and `[]` gracefully, clamps all scores to `[1, 5]`, re-derives `priority` from the formula, and drops any entry with an empty or refusal title.

#### Configuration (`autonomous.config.yaml`)

```yaml
producers:
  maintenance:
    enabled: true
    model: claude-sonnet-4-6   # inherits getModelFor("producer") if omitted
```

No `maxTasksPerRun` knob is exposed — the prompt hard-caps Claude at 8 findings, which is the practical maximum for a single LLM context without diluting quality.

#### Output Shape (from Claude)

```json
[
  {
    "title": "Extract duplicated pagination logic into a shared usePagination hook",
    "body": "Substantially similar pagination state management appears in 6 different list components. Extracting it into a shared hook would reduce ~200 lines of duplication and make future pagination changes apply consistently.",
    "category": "duplication",
    "scores": { "value": 4, "complexity": 2, "risk": 1, "block": 1 },
    "priority": 11
  },
  {
    "title": "Remove dead feature-flag code for the deprecated beta dashboard",
    "body": "FEATURE_BETA_DASHBOARD is always false in every environment config and the flag was sunset 6 months ago. The guarded code branches (~300 lines) are unreachable and should be removed.",
    "category": "dead-code",
    "scores": { "value": 3, "complexity": 1, "risk": 2, "block": 1 },
    "priority": 7
  }
]
```

#### Created Task Fields

| Field | Value |
|---|---|
| `source` | `"producer:maintenance"` |
| `type` | `"chore"` (all categories map to `chore`) |
| `size` | `"small"` / `"medium"` / `"large"` (derived from `complexity` score) |
| `status` | `"pending"` |
| `repoId` | from `ctx.repoId` |
| `createdBy` | from `ctx.createdBy` |

#### Example `ProducerResult`

```json
{
  "tasksCreated": 5,
  "duplicatesSkipped": 2,
  "errors": [],
  "costUsd": 0.004621
}
```

Interpretation: Claude returned 7 findings. 2 were duplicates of in-flight tasks. 5 new maintenance tasks were created, ordered by priority.

---

## Producer Registration and Scheduling

Producers are not self-scheduling. They are registered in the daemon and invoked on a regular interval via the `Scheduler` abstraction in `src/daemon/scheduler.ts`.

### How the Daemon Runs Producers

```
daemon tick (every N minutes, configurable)
  └─ for each repo in DB:
  │    └─ for each producer where needsRepo is true or undefined:
  │         ├─ if needsRepo: shallow-clone repo to temp dir
  │         ├─ producer.run(ctx)
  │         ├─ record ProducerResult in producer_runs table
  │         └─ if needsRepo: clean up temp dir
  └─ for each global producer (global: true):
       └─ producer.run(ctx)   // ctx.repoId = self-repo
            └─ record ProducerResult
```

### The `Scheduler` Guarantee

The scheduler in `src/daemon/scheduler.ts` enforces **mutual exclusion**: if the previous tick is still running when the next interval fires, the new tick is skipped entirely. This ensures producers never run concurrently against the same repository.

```ts
// from scheduler.ts
if (this.running) {
  logger.warn("Scheduler: previous tick still running, skipping");
  return;
}
```

### Producer Run Records

Every invocation is persisted to the `producer_runs` table via `src/db/queries/producer-runs.ts`:

```ts
await recordProducerRun({
  producerName: producer.name,
  repoId: ctx.repoId,
  tasksCreated: result.tasksCreated,
  duplicatesSkipped: result.duplicatesSkipped,
  errors: result.errors,
  costUsd: result.costUsd,
});
```

This table is the primary source for the dashboard's producer health view and cost attribution per producer.

---

## Task Creation Workflow

When a producer decides to create a task, it calls `create()` from `src/db/queries/tasks.ts`. The call signature accepted by producers is:

```ts
await create({
  title: "Fix null check in auth middleware",
  body: "Detailed description of what needs to be done and why.",
  source: "bug-hunter",         // producer name — used for deduplication
  type: "bug",                  // or "feature", "security", "improvement"
  repoId: ctx.repoId,
  createdBy: ctx.createdBy,
});
```

The `create` function:

1. **Generates a unique task ID** using `generateTaskId()` from `src/domain/types.ts`.
2. **Inserts the task** with `status: "pending"`.
3. **Returns the full task row** so the producer can log the new ID.

After insertion the task is visible in the dashboard immediately and will be picked up by the daemon's task runner on the next processing tick.

### Status Progression After Producer Creation

```
pending  (producer created)
  └─ routing    (router agent classifies type/size/workflow)
  └─ queued     (ready for pipeline pickup)
  └─ running    (worker agent executing)
  └─ enriching  (refiner + code quality + gate)
  └─ approved / rejected / rework
  └─ done / failed / merged
```

Producers never set a `type` that overrides routing — the router may refine the type further if its classification differs from the producer's suggestion. However, in practice the router tends to honour the producer's `type` since it is already well-reasoned.

---

## Deduplication and Safety Guards

Every producer follows this three-layer safety pattern before writing to the database:

### Layer 1 — LLM Refusal Filter (`isRefusalTitle`)

```ts
if (isRefusalTitle(candidate.title)) {
  result.errors.push(`Skipped refusal title: "${candidate.title.slice(0, 60)}..."`);
  continue;
}
```

Prevents situations where Claude cannot analyse a repository (e.g. the README is in a non-English language or references private assets) and returns a help-seeking response instead of task candidates.

### Layer 2 — Duplicate Check (`isDuplicate`)

```ts
if (await isDuplicate(source, candidate.title)) {
  result.duplicatesSkipped++;
  continue;
}
```

Ensures idempotency across ticks. Running the same producer daily against the same repository will not re-create tasks that are already being worked on.

### Layer 3 — Dry Run Mode

```ts
if (ctx.dryRun) {
  logger.info({ title: candidate.title }, "DryRun: would create task");
  result.tasksCreated++;  // counted but not actually inserted
  continue;
}
```

The daemon can pass `dryRun: true` in the context, which causes producers to simulate their full logic and return accurate counts without writing anything. Used by the `/api/producers/preview` endpoint in the dashboard.

### Non-Fatal Error Handling

Producers do not abort on a single failure. Each candidate is processed independently:

```ts
try {
  // process candidate
} catch (err) {
  result.errors.push(`Failed to create task "${title}": ${err.message}`);
  // continue to next candidate
}
```

The `errors` array in `ProducerResult` captures these non-fatal issues. The daemon logs them and records them in `producer_runs.errors` but does not treat a partial failure as a run failure.

---

## Producer Output Examples

### Example: Bug Hunter `ProducerResult`

```json
{
  "tasksCreated": 2,
  "duplicatesSkipped": 1,
  "errors": [],
  "costUsd": 0.003847
}
```

Interpretation: Claude returned 3 bug candidates. One matched an existing in-flight task (duplicate skipped). Two new tasks were inserted. The LLM call cost $0.003847.

### Example: Security Scanner `ProducerResult` (with errors)

```json
{
  "tasksCreated": 1,
  "duplicatesSkipped": 0,
  "errors": [
    "Skipped refusal title: \"I cannot directly access the repository's source code without…\"",
    "Failed to create task \"...\": duplicate key value violates unique constraint"
  ],
  "costUsd": 0.002103
}
```

Interpretation: Claude returned 3 candidates. One was a refusal title. One hit a DB constraint (race condition between two daemon ticks). One was successfully inserted.

### Example: Log Scanner `ProducerResult`

```json
{
  "tasksCreated": 3,
  "duplicatesSkipped": 7,
  "errors": [],
  "costUsd": 0
}
```

Interpretation: KQL returned 10 error patterns. 7 already had active tasks. 3 new tasks were created. No LLM cost.

### Example: Self Monitor `ProducerResult` (nothing to do)

```json
{
  "tasksCreated": 0,
  "duplicatesSkipped": 0,
  "errors": [],
  "costUsd": 0
}
```

Interpretation: The log buffer contained no repeated error patterns above the configured threshold. The system is healthy; no tasks created.

---

## Integration Patterns

### Reading Producer Configuration

LLM-based producers read their configuration from the autonomous config:

```ts
import { getAutonomousConfig } from "../domain/autonomous-config.js";

const config = getAutonomousConfig();
const maxTasksPerRun = config.producers?.bugHunter?.maxTasksPerRun ?? 3;
const model = config.producers?.bugHunter?.model ?? getModelFor("bug-hunter");
```

Non-LLM producers (doc-auditor, log-scanner, self-monitor) read config values passed directly in `ctx.config`:

```ts
const minOccurrences = (ctx.config?.minOccurrences as number) ?? 5;
const timespan = (ctx.config?.timespan as string) ?? "PT24H";
```

### Calling the LLM

LLM producers use the shared `callClaude` SDK, just like agents:

```ts
import { callClaude } from "../agents/sdk.js";

const response = await callClaude({
  prompt: buildPrompt(ctx, repoSummary, maxTasksPerRun),
  model,
  systemPrompt: SYSTEM_PROMPT,
  dryRun: ctx.dryRun,
});
```

Passing `ctx.dryRun` to `callClaude` ensures that in dry-run mode, no API call is made but the flow continues with a stub response.

### Cost Tracking

LLM producers accumulate cost across all candidates in the run and return the total in `ProducerResult.costUsd`:

```ts
let totalCostUsd = 0;

// after each LLM call:
const costUsd = estimateCostUsd(
  response.cost.inputTokens,
  response.cost.outputTokens
);
totalCostUsd += costUsd;

return { tasksCreated, duplicatesSkipped, errors, costUsd: totalCostUsd };
```

Non-LLM producers return `costUsd: 0`.

### Parsing LLM Responses

All LLM producers parse Claude's JSON response with defensive fallback logic:

```ts
let candidates: { title: string; body: string }[] = [];
try {
  // strip markdown fences if present
  const raw = response.text.replace(/^```json\n?|```$/gm, "").trim();
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    candidates = parsed.filter(
      (c) => typeof c.title === "string" && typeof c.body === "string"
    );
  }
} catch (err) {
  result.errors.push(`Failed to parse LLM response: ${err.message}`);
}
```

If parsing fails entirely, the producer returns with `tasksCreated: 0` and the parse error in `errors[]`.

---

## Adding a New Producer

Follow these steps to add a new producer to The Hive.

### Step 1 — Create the producer file

```ts
// src/producers/my-producer.ts
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import logger from "../logger.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

const PRODUCER_NAME = "my-producer";

export const myProducer: Producer = {
  name: PRODUCER_NAME,
  needsRepo: false,  // true if you need ctx.repoDir
  global: false,     // true if this runs once per tick, not per-repo

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    // 1. Gather signal data
    const candidates = await gatherCandidates(ctx);

    // 2. Process each candidate
    for (const candidate of candidates) {
      try {
        // 3. Check for duplicates
        if (await isDuplicate(PRODUCER_NAME, candidate.title)) {
          result.duplicatesSkipped++;
          continue;
        }

        // 4. Respect dry-run mode
        if (ctx.dryRun) {
          logger.info({ title: candidate.title }, "DryRun: would create task");
          result.tasksCreated++;
          continue;
        }

        // 5. Create the task
        await create({
          title: candidate.title,
          body: candidate.body,
          source: PRODUCER_NAME,
          type: "improvement",  // choose the appropriate type
          repoId: ctx.repoId,
          createdBy: ctx.createdBy,
        });

        result.tasksCreated++;
        logger.info({ title: candidate.title }, "my-producer: task created");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to create task "${candidate.title}": ${msg}`);
      }
    }

    return result;
  },
};
```

### Step 2 — Register in the daemon

Open `src/daemon/daemon.ts` and add your producer to the producers list:

```ts
import { myProducer } from "../producers/my-producer.js";

const producers: Producer[] = [
  bugHunter,
  featureScout,
  securityScanner,
  docAuditor,
  logScanner,
  selfMonitor,
  myProducer,   // ← add here
];
```

### Step 3 — Add configuration (if needed)

If your producer has configurable parameters, add them to `autonomous.config.yaml`:

```yaml
producers:
  myProducer:
    enabled: true
    someThreshold: 10
```

And read them in your producer:

```ts
const threshold = (ctx.config?.someThreshold as number) ?? 10;
```

---

## See Also

- [`docs/internal/architecture.md`](../architecture.md) — end-to-end system data flow and component relationships
- [`docs/internal/modules/agents.md`](./agents.md) — the pipeline that processes tasks created by producers
- [`docs/internal/modules/daemon.md`](./daemon.md) — how producers are scheduled and invoked
- [`docs/internal/modules/database.md`](./database.md) — `producer_runs` table schema and task creation queries
- [`src/producers/base.ts`](../../../src/producers/base.ts) — shared types, helpers, and guards
- `autonomous.config.yaml` — enable/disable producers and tune thresholds
- `src/integrations/azure-monitor.ts` — KQL execution layer used by `log-scanner`
- `src/log-buffer.ts` — in-process log ring-buffer used by `self-monitor`
