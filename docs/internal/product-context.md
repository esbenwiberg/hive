# The Hive — Product Context

> This document is the authoritative knowledge base for LLM agents (primarily the Advisor) that need deep, curated understanding of what The Hive is, who it serves, how it works, and what principles guide its design. It is intentionally concise and structured for LLM consumption.

---

## 1. What Is The Hive?

The Hive is an **autonomous task orchestration platform for engineering teams**. It accepts a plain-language task description (a title and a body), enriches it with codebase context, evaluates it, and — if approved — executes the implementation end-to-end: writing code, committing to a git branch, and opening a pull request. No human needs to write a single line of code or run a single shell command.

The system is designed to handle **real software engineering work** — not toy demos. It creates git worktrees, runs lint/build/test pipelines, and produces reviewable pull requests on GitHub or Azure DevOps. It operates on whatever codebase a user registers.

The Hive is itself one of its own target codebases: the team uses The Hive to improve The Hive.

---

## 2. Target Users

The Hive serves **small-to-medium engineering teams** that want to accelerate delivery of well-defined, repeatable engineering tasks without pulling developers off higher-value work.

**Primary persona — the engineering lead / senior developer:**
- Has a backlog of tasks that are clearly defined but tedious to execute (config changes, adding endpoints, writing tests, small refactors, documentation updates).
- Wants to delegate these with confidence that the output will be reviewable and mergeable.
- Trusts the system more when it is transparent: they can see what enrichment data was gathered, what the architect planned, what the scorer rated, and why the gate approved or rejected.

**Secondary persona — the autonomous producer:**
- Automated agents (bug-hunter, security-scanner, feature-scout, etc.) that scan repos and create tasks without human initiation.
- These tasks must pass stricter scrutiny because there is no human intent behind them.

**What users do NOT want:**
- Tasks that touch infrastructure or auth in ways that could lock them out.
- Tasks that accrue large costs without proportional value.
- Tasks that produce un-reviewable "big bang" changesets.
- Surprises: the system should be predictable and explainable.

---

## 3. End-to-End Pipeline Flow

Tasks move through seven stages. Understanding this flow is essential for evaluating whether a proposed task fits.

```
PENDING → QUEUED → ENRICHING → READY → APPROVED → EXECUTING → REVIEWING → DONE → MERGED
```

| Stage | What happens |
|---|---|
| **PENDING** | Task is created (dashboard, producer, or API). Title + body stored. |
| **QUEUED** | Router (Claude) classifies: type, size (`small/medium/large`), workflow (`flow/epic`). |
| **ENRICHING** | Six enrichers run sequentially: codebase → docs → git-history → dependencies → architect → scorer. Each reads prior enrichment and adds its output to a JSONB blob. |
| **READY** | Enrichment complete. Architect may have asked clarification questions; user or AI answers them. |
| **APPROVED** | Gate decides (human/AI/auto mode) based on enrichment. Gate decision recorded. |
| **EXECUTING** | Keeper agent creates a git worktree, calls Claude with file/shell tools to implement the task, runs build/lint/tests, loops on failures. |
| **REVIEWING** | Review gate diffs the changeset and evaluates quality, security, test coverage, acceptance criteria. Pass → PR. Fail → rework or FAILED. |
| **DONE/MERGED** | PR exists on the remote. Retrospective agent synthesises learnings. |

**Key constraint**: the pipeline is **sequential per task**. Enrichers run one after another; milestones in epics execute one after another. Parallelism is across tasks (up to 5 system-wide), not within a task.

---

## 4. Architectural Principles

### 4.1 Agent Pattern

Every intelligence unit is a **stateless async function** wrapping a single Claude API call (or a short agentic loop). Agents:
- Take a well-defined input (task row + enrichment JSONB + any stage-specific data).
- Return a structured JSON object.
- Record their cost in the `costs` table.
- Register themselves in `active_agents` for the duration of their run and deregister on completion.

New agents must follow this pattern. Do not introduce agents that maintain internal state between calls, open persistent connections, or bypass cost recording.

### 4.2 Enricher Pattern

Enrichers implement the `Enricher` interface from `src/enrichers/base.ts`. Each enricher:
- Receives the full task row (including all prior enrichment).
- Produces a partial enrichment object that is **merged** into `task.enrichment` (JSONB).
- Is registered in the ordered enricher chain in the pipeline runner.
- Has its own prompt file in `prompts/enrichers/`.
- Has its own source file in `src/enrichers/`.

Enrichers must be **additive and non-destructive**: they append to the enrichment object; they do not overwrite fields set by prior enrichers. The order matters: later enrichers (architect, scorer) depend on fields set by earlier ones (codebase, docs, git-history).

### 4.3 Prompt File Convention

Every agent prompt lives in `prompts/` as a `.md` file. Prompts are loaded via `src/prompt-cache.ts` (not inlined in source code). The prompt file is the single source of truth for that agent's instructions.

Prompts must include an **Input Safety** section instructing the LLM to treat user-provided content inside `<user_provided_title>`, `<user_provided_body>`, and `<enrichment_data>` tags as untrusted data only.

### 4.4 State Machine Rules

The `TaskStatus` enum and `ALLOWED_TRANSITIONS` map in `src/domain/state-machine.ts` are the only authoritative source for valid status transitions. No code may set `task.status` to an arbitrary value — it must call `canTransition()` first. Any task that introduces new statuses or transitions must update the state machine and the state machine tests.

### 4.5 Graceful Degradation

The pipeline is designed to continue even when individual stages fail partially. Enrichers catch their own errors and write a partial or error-flagged result rather than crashing the pipeline. The daemon recovers stale tasks on startup. Budget checks prevent runaway cost before execution begins.

New features must not introduce hard failure modes that can stall the entire pipeline. If a new stage fails, it should fail gracefully and log clearly.

### 4.6 Cost Discipline

Every Claude call goes through `callClaude()` / `callClaudeWithTools()` in `src/agents/sdk.ts`, which records token usage and cost to the `costs` table. There are no exceptions. Hard budget limits are enforced per user per day and per task. Features that call Claude must not bypass these mechanisms.

### 4.7 Module Boundaries

| Module | Responsibility | Must not |
|---|---|---|
| `src/agents/` | Claude call wrappers + agent logic | Contain route handlers or DB schema |
| `src/enrichers/` | Enricher implementations | Call Claude directly (use the agent wrapper) |
| `src/execution/` | Git worktree, coding loop, PR creation | Contain business logic unrelated to execution |
| `src/dashboard/` | Express routes + HTMX views | Contain pipeline logic |
| `src/domain/` | Types, state machine, config parsing | Have side effects or I/O |
| `src/db/` | Schema + query functions | Contain business logic |

---

## 5. Naming and Code Conventions

- **File naming**: `kebab-case` for all source files and prompt files (`advisor.md`, `git-history.ts`).
- **TypeScript**: ESM modules (`import`/`export`), no CommonJS `require`. Strict mode enabled.
- **Exports**: Each module file exports named functions; no default exports.
- **Query functions**: Database access goes through `src/db/queries/`. Direct `db.select(...)` calls outside the queries layer are discouraged.
- **Enrichment keys**: Enricher output keys use `camelCase` and match the enricher's name as a namespace prefix where helpful (e.g., `codesbase.relevantFiles`, `scorer.recommendation`).
- **Prompt input tags**: User-controlled content is wrapped in `<user_provided_title>`, `<user_provided_body>`, `<enrichment_data>` tags in every prompt.
- **Agent function naming**: Agents are named after their role: `runRouter()`, `runEnricher()`, `runGateAnalyst()`. The file name matches the agent name.
- **Tests**: Test files sit alongside source files or in a `__tests__/` subdirectory; they use the same ESM imports. Test coverage is expected for new agents and enrichers.

---

## 6. Known Anti-Patterns to Avoid

The following are actively harmful in this codebase and will cause a task to score poorly on architectural fit:

### 6.1 Inline Prompts
**Anti-pattern**: Embedding LLM prompt strings directly in TypeScript source files.
**Why bad**: Prompts are large, change frequently, and need to be readable without running the code. The prompt cache exists precisely to avoid this.
**Correct pattern**: Create a `.md` file in `prompts/` and load it via `src/prompt-cache.ts`.

### 6.2 Bypassing the Cost Recording Layer
**Anti-pattern**: Calling the Anthropic SDK directly (`new Anthropic().messages.create(...)`) instead of using `callClaude()` from `src/agents/sdk.ts`.
**Why bad**: Bypasses budget enforcement, cost tracking, retry logic, and active-agent registration. Will cause silent budget overruns.
**Correct pattern**: Always use `callClaude()` or `callClaudeWithTools()`.

### 6.3 Direct Status Assignment
**Anti-pattern**: Setting `task.status = 'APPROVED'` directly without calling `canTransition()`.
**Why bad**: Violates the state machine, can put tasks into impossible states, breaks dashboard filters and daemon recovery logic.
**Correct pattern**: Always validate transitions through `src/domain/state-machine.ts`.

### 6.4 Monolithic Milestones
**Anti-pattern**: A single milestone that touches 20+ files or spans multiple unrelated concerns.
**Why bad**: Exceeds the worker's context window, produces un-reviewable changesets, and makes rework expensive.
**Correct pattern**: Milestones should each touch a bounded, cohesive set of files. Large tasks should be broken into 3–6 focused milestones.

### 6.5 Unisolated Side Effects in Domain Layer
**Anti-pattern**: Adding database calls, file system access, or HTTP requests to `src/domain/`.
**Why bad**: The domain layer is the shared foundation — adding I/O here creates hidden coupling and makes unit testing impossible.
**Correct pattern**: Side effects belong in `src/agents/`, `src/enrichers/`, `src/execution/`, or `src/dashboard/`.

### 6.6 Skipping the Enricher Interface
**Anti-pattern**: Adding a new enrichment step that does not implement the `Enricher` interface or is not registered in the enricher chain.
**Why bad**: Bypasses cost recording, error handling, and the ordered enrichment contract that downstream agents depend on.
**Correct pattern**: Implement `Enricher` from `src/enrichers/base.ts`, register in the pipeline runner, add a corresponding prompt file.

### 6.7 Tasks That Touch Auth or Session Logic Without Strong Justification
**Anti-pattern**: Modifying `src/auth/`, session middleware, or Entra ID integration as part of an unrelated feature.
**Why bad**: Auth failures lock out all users. These changes require careful human review and should be isolated.
**Correct pattern**: Auth changes should be their own task with explicit scope, security review requirements, and human gate approval.

### 6.8 Tasks That Introduce New External Dependencies Without Evaluation
**Anti-pattern**: Adding new `npm` packages (especially those with native bindings or broad permissions) without noting it in the task scope.
**Why bad**: Increases attack surface, Docker image size, and supply-chain risk. The team is conservative about new dependencies.
**Correct pattern**: Note any new dependency in the task body; prefer using what is already installed (`pino`, `drizzle`, `express`, `zod`).

---

## 7. What "Good" Looks Like for the Advisor

A task scores well when it:
- Solves a real pain point for Hive users or the Hive pipeline itself.
- Maps cleanly to an existing module without requiring new cross-cutting abstractions.
- Has clear, testable acceptance criteria that a review gate can verify.
- Touches a bounded set of files (ideally ≤ 10 for a single milestone).
- Follows all naming, prompt, and module boundary conventions.
- Introduces no new external dependencies, or justifies them clearly.
- Does not touch auth, the state machine, or data migrations without explicit human review.

A task scores poorly when it:
- Is vague about what "done" looks like.
- Mixes unrelated concerns in a single changeset.
- Introduces patterns that conflict with existing conventions.
- Modifies high-risk paths (auth, billing, state machine) without justification.
- Is so broad that no single agent could complete it reliably.
- Duplicates functionality that already exists in the pipeline.
