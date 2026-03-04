# Agents Module

> **Location:** `src/agents/`
> **Purpose:** Core intelligence layer of The Hive — all LLM-powered components that classify, evaluate, execute, and learn from tasks live here.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [SDK — `sdk.ts`](#sdk--sdkts)
3. [Pipeline Orchestrator — `pipeline.ts`](#pipeline-orchestrator--pipelinets)
4. [Router — `router.ts`](#router--routerts)
5. [Gate — `gate.ts`](#gate--gatets)
6. [Decomposer — `decomposer.ts`](#decomposer--decomposerts)
7. [Refiner — `refiner.ts`](#refiner--refinerts)
8. [Feedback Loop — `feedback-loop.ts`](#feedback-loop--feedback-loopts)
9. [Gate Analyst — `gate-analyst.ts`](#gate-analyst--gate-analystts)
10. [Browser Validator — `browser-validator.ts`](#browser-validator--browser-validatorts)
11. [Code Quality Analyst — `code-quality-analyst.ts`](#code-quality-analyst--code-quality-analystts)
12. [Keeper — `keeper.ts`](#keeper--keeperts)
13. [Retrospective — `retrospective.ts`](#retrospective--retrospectivets)
14. [Retry Utilities — `retry.ts`](#retry-utilities--retryts)
15. [Cost Utilities — `cost-utils.ts`](#cost-utilities--cost-utilsts)
16. [Cross-Cutting Concerns](#cross-cutting-concerns)
17. [Agent Integration Examples](#agent-integration-examples)

---

## Module Overview

The `src/agents/` directory implements every intelligent component in The Hive. Each file is a self-contained agent that:

1. **Reads a task** from the database using a task ID.
2. **Calls Claude** via the shared SDK.
3. **Parses and validates** the LLM response.
4. **Transitions task state** in the database.
5. **Records costs** and logs structured events.

### File Map

| File | Role | Claude call style |
|---|---|---|
| `sdk.ts` | Thin Anthropic wrapper | — (infrastructure) |
| `pipeline.ts` | Orchestrator — sequences all agents | — (calls other agents) |
| `router.ts` | Classifies a task: type, size, workflow | `callClaude` (single-turn) |
| `gate.ts` | Approve / reject / rework decision | `callClaude` (single-turn) |
| `decomposer.ts` | Splits an epic into sub-tasks | `callClaude` (single-turn) |
| `refiner.ts` | Enriches task with implementation plan | `callClaude` (single-turn) |
| `feedback-loop.ts` | Re-runs worker after a rework verdict | `callClaude` (single-turn) |
| `gate-analyst.ts` | Detects patterns across gate decisions | `callClaude` (single-turn) |
| `browser-validator.ts` | Headless browser UI validation | `callClaudeWithTools` (agentic) |
| `code-quality-analyst.ts` | Static code quality analysis | `callClaude` (single-turn) |
| `keeper.ts` | Curates the learning knowledge base | `callClaude` (single-turn) |
| `retrospective.ts` | Weekly analysis of outcomes + learnings | `callClaude` (single-turn) |
| `retry.ts` | Exponential backoff helper | — (utility) |
| `cost-utils.ts` | Token-to-USD estimation helper | — (utility) |

### Agent Lifecycle Pattern

Every stateful agent follows this pattern:

```
taskId received
  └─ getById(taskId)          // load + validate task status
  └─ register(taskId, ...)    // mark active in DB
  └─ callClaude(...)          // LLM call
  └─ parse + validate response
  └─ updateStatus(taskId, nextStatus)
  └─ recordCost(...)
  └─ unregister(taskId)       // always in finally block
```

---

## SDK — `sdk.ts`

The SDK is the single point of contact with the Anthropic API. All agents use it; no agent calls `new Anthropic()` directly.

### Key Types

```ts
interface SdkRequest {
  prompt: string;
  model?: string;           // defaults to "claude-sonnet-4-6"
  maxTokens?: number;       // defaults to 4 096
  systemPrompt?: string;    // attached with cache_control: "ephemeral"
  dryRun?: boolean;         // skips API call; returns stub (for testing)
}

interface SdkResponse {
  text: string;             // concatenation of all text blocks
  cost: CostMeta;           // model, inputTokens, outputTokens, cache hits
}

interface AgenticRequest {
  prompt: string;
  model?: string;           // defaults to "claude-sonnet-4-6"
  maxTokens?: number;       // defaults to 16 384
  systemPrompt?: string;
  tools: Tool[];            // Anthropic tool definitions
  executeTool: (name: string, input: Record<string, unknown>)
    => Promise<string | ToolResultContent>;
  maxTurns?: number;        // defaults to 30
  onTurnComplete?: (turn: number) => void; // heartbeat callback
}

interface AgenticResponse {
  text: string;             // all text blocks across all turns
  cost: CostMeta;           // cumulative across turns
  turns: number;            // actual turn count used
}
```

### Prompt Caching Strategy

We use a combination of **explicit breakpoints** and **automatic caching** to minimise input token costs:

| Layer | Mechanism | What it caches |
|---|---|---|
| System prompt | Explicit `cache_control` on the text block | Stable system instructions — shared across all calls with the same prompt |
| Tools (agentic only) | Explicit `cache_control` on the last tool definition | Entire tools + system prefix — avoids re-encoding tool schemas every turn |
| Conversation history (agentic only) | Top-level `cache_control` on the request body (automatic caching) | Growing message history — breakpoint moves forward each turn automatically |

**How the three layers interact:** Anthropic allows up to 4 cache breakpoints per request. We use 3 (system, last tool, automatic), leaving 1 slot free. On each agentic turn the automatic breakpoint advances to the last message, so previous turns are read from cache at 10% of the base input price. Cache writes cost 25% more than base but pay for themselves after ~2 cache reads.

**Cache lifetime:** 5 minutes (default). Each cache hit refreshes the TTL, so the cache stays warm throughout a multi-turn agentic session. For single-turn calls (`callClaude`), the system prompt cache is shared across rapid-fire pipeline calls (router, gate, refiner, etc.) hitting the same prompt within the TTL window.

### `callClaude(req: SdkRequest): Promise<SdkResponse>`

Simple single-turn wrapper. Used by every non-agentic agent.

- The system prompt is sent with an explicit `cache_control: "ephemeral"` breakpoint.
- When `dryRun: true`, the API is never called. This is used by the pipeline for smoke-testing wiring.
- Handles `BadRequestError` context-limit errors automatically: if the model rejects the request because `max_tokens` would exceed the context window, the SDK recalculates a reduced `max_tokens` and retries once.

### `callClaudeWithTools(req: AgenticRequest): Promise<AgenticResponse>`

Multi-turn agentic loop. Used by `browser-validator`.

**Turn loop:**
1. Send messages → get assistant response.
2. Collect text blocks; push assistant message to history.
3. If `stop_reason !== "tool_use"`, exit loop.
4. Execute each `tool_use` block via `executeTool`; collect results.
5. Push tool results as a new user message; go to step 1.

**Caching:** Uses all three caching layers (see above). The top-level `cache_control` enables automatic caching so conversation history is incrementally cached each turn.

**Context management** (critical for long-running browser sessions):
- After 4+ turns, older tool-result blocks are proactively **compacted** to 200 characters (keeping the most recent 3 turn-pairs verbatim).
- Before each turn the SDK estimates next-turn token usage and reduces `max_tokens` to stay within the 200k context limit.
- Emergency compaction (200 chars → 100 chars, preserve 1 turn-pair) triggers if even `MIN_OUTPUT_TOKENS = 4096` won't fit.

### Lazy Client Singleton

```ts
let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}
```

The Anthropic client is created once on first use. Tests can reset this by reloading the module or mocking the SDK.

---

## Pipeline Orchestrator — `pipeline.ts`

The pipeline is the highest-level coordinator. When the daemon picks up a `queued` task, it calls `runPipeline(taskId)` and the pipeline drives it from there.

### Task Flow

```
queued
  └─ [worker agent runs in worker dir / git worktree]
       └─ executes the actual code change
  └─ enriching
       ├─ refiner       → adds enrichment / implementation plan
       ├─ code-quality  → checks code quality
       ├─ browser-validator (if UI task) → takes screenshots, validates
       └─ gate          → approve | rework | reject
  └─ approved
       └─ [done] or [rework loop]
  └─ rework
       └─ feedback-loop → re-runs worker with gate reasoning
       └─ [back to enriching ...]
  └─ done | failed | rejected
```

### Key Responsibilities

- **Worktree isolation:** creates a dedicated git worktree for each task under a temporary directory so concurrent tasks don't interfere with each other.
- **Rework loop:** if the gate sends the task back as `rework`, the pipeline increments `reworkCount` and re-runs the worker + gate sequence. A configurable max-rework limit prevents infinite loops.
- **Resource cleanup:** the worktree directory is removed in a `finally` block regardless of success or failure.
- **Status broadcasting:** status transitions are persisted to the DB; the dashboard SSE stream picks them up in real time.

### Entry Point

```ts
export async function runPipeline(taskId: string): Promise<void>
```

Called by the daemon's task runner. The function is idempotent for `queued` tasks — it checks the task status before proceeding and throws if the task is not in the expected state.

---

## Router — `router.ts`

Transitions a task from `pending` → `queued` by using Claude to classify the task.

### What It Classifies

| Field | Valid values | Fallback |
|---|---|---|
| `type` | `bug`, `feature`, `security`, `refactor`, `improvement` | `config.classification.defaultType` |
| `size` | `trivial`, `small`, `medium`, `large` | `config.classification.defaultSize` |
| `workflow` | `flow`, `epic` | `flow` |
| `model` | *(always resolved from config, never from LLM output)* | `getModelFor("worker")` |
| `maxTurns` | positive integer (optional) | *(not set)* |
| `maxBudgetUsd` | positive float (optional) | *(not set)* |

The model field is intentionally **not** trusted from LLM output — the router prompt may suggest a model, but the actual value is always resolved via `getModelFor("worker")` from the autonomous config.

### Flow

```
pending task
  └─ register(taskId, "router", model, "classifying")
  └─ callClaude({ systemPrompt: loadPrompt("router"), userPrompt })
  └─ parseClassification(response.text)   // JSON with fallbacks for invalid values
  └─ updateClassification(taskId, result)
  └─ updateStatus(taskId, "queued")
  └─ recordCost(...)
  └─ unregister(taskId)       // finally
```

### User Prompt Structure

```
Task ID: <id>
Source: <source>

<user_provided_title>
<title>
</user_provided_title>

<user_provided_body>
<body>
</user_provided_body>
```

### Error Handling

If `parseClassification` receives invalid JSON or unknown enum values, it applies defaults from the autonomous config rather than throwing. This ensures every task gets routed even if Claude produces a partial or malformed response.

---

## Gate — `gate.ts`

Evaluates an enriched task and decides whether to `approve`, `reject`, or send back for `rework`.

### Gate Modes

Controlled by `config.gate.mode`:

| Mode | Behaviour |
|---|---|
| `human` | Moves task to `ready`; a human must approve via the dashboard. No LLM call. |
| `ai` | Always calls Claude to evaluate. |
| `auto` | Auto-approves `trivial` and `small` tasks; falls through to Claude for `medium`/`large`. |

### Verdict → Status Mapping

| Verdict | Target status |
|---|---|
| `approve` | `approved` |
| `reject` | `rejected` |
| `rework` | `rework` |

### Optimistic Locking

Before making the LLM call, the gate performs an atomic `UPDATE … WHERE status = 'enriching'` and checks the returning row. If another process already claimed the task (race condition), the gate throws immediately without making an API call:

```ts
const [claimed] = await db.update(tasks)
  .set({ updatedAt: new Date() })
  .where(and(eq(tasks.id, taskId), eq(tasks.status, "enriching")))
  .returning({ id: tasks.id });

if (!claimed) throw new Error(`Gate: task ${taskId} was already claimed`);
```

### Gate Analyst Integration

After recording the decision, the gate fires `analyzeGatePatterns(...)` as a **fire-and-forget** call:

```ts
void analyzeGatePatterns(taskId, result.verdict, result.reasoning, repo?.fullName)
  .catch(err => logger.error(...));  // never blocks or rethrows
```

This triggers the gate analyst to look for systemic patterns without delaying the gate response.

### User Prompt Structure

```
Task ID: <id>
Type: <type>
Size: <size>
Source: <source>
Workflow: <workflow>

<user_provided_title>...</user_provided_title>
<user_provided_body>...</user_provided_body>
<enrichment_data>{ ... JSON ... }</enrichment_data>
```

---

## Decomposer — `decomposer.ts`

Splits an `epic` workflow task into ordered sub-tasks. Called by the pipeline when `task.workflow === "epic"`.

### Behaviour

- Calls Claude with the task's title, body, and enrichment data.
- Parses the response as a JSON array of sub-task definitions.
- Creates each sub-task in the database linked to the parent epic.
- Sub-tasks enter the pipeline as independent `pending` tasks that are then routed and executed individually.

### Output Shape (from Claude)

```json
[
  {
    "title": "Sub-task title",
    "body": "Detailed description",
    "order": 1
  },
  ...
]
```

### Cost Recording

Each decomposer invocation records cost under the `"decomposer"` agent name, attributed to the same `createdBy` user as the parent epic.

---

## Refiner — `refiner.ts`

Enriches a task with an implementation plan before the gate evaluates it. Transitions the task status to `enriching`.

### Behaviour

- Loads the `refiner` prompt from the prompt cache.
- Sends the task's title, body, type, size, and source to Claude.
- Stores the response as `task.enrichment` (a JSON blob containing the implementation plan, risk notes, and acceptance criteria).
- The gate and gate analyst both read `task.enrichment` when making their decisions.

### Enrichment Shape

The exact schema is defined by the `refiner` prompt in `src/prompts/`, but typically includes:

```json
{
  "implementationPlan": "...",
  "acceptanceCriteria": ["...", "..."],
  "risks": ["..."],
  "estimatedComplexity": "low | medium | high"
}
```

### Prompt Loading

```ts
const systemPrompt = loadPrompt("refiner");
```

Prompts are loaded from disk via `prompt-cache.ts`, which caches them in memory after the first read. This avoids repeated filesystem access across concurrent pipeline runs.

---

## Feedback Loop — `feedback-loop.ts`

Re-runs the worker agent after the gate returns a `rework` verdict. Includes the gate's reasoning so the worker can address the specific issues identified.

### When It Runs

The pipeline calls `runFeedbackLoop(taskId)` when:
1. The gate verdict is `rework`.
2. The pipeline's rework counter has not exceeded the configured maximum.

### What It Does

1. Loads the task, its gate decision history (most recent `rework` decision reasoning), and the current enrichment.
2. Builds a user prompt that includes:
   - Original task description.
   - What the worker previously did (from `task.workerOutput` or similar).
   - Gate reasoning explaining why it was rejected.
   - Instructions to address those specific concerns.
3. Calls Claude (single-turn).
4. Stores the revised plan / output back on the task.
5. Transitions the task back to `enriching` so the gate will re-evaluate.

### Rework Loop Safety

The pipeline enforces a maximum rework count (configured in `autonomous.config.yaml` under `gate.maxReworks`). When exceeded, the pipeline transitions the task to `failed` with a `failureReason` of `"max reworks exceeded"`.

---

## Gate Analyst — `gate-analyst.ts`

Analyses patterns in gate decisions to surface systemic quality problems and update the learning knowledge base.

### When It Runs

Called fire-and-forget by the gate after every AI evaluation:

```ts
void analyzeGatePatterns(taskId, verdict, reasoning, repoFullName)
```

### What It Does

1. Queries recent gate decisions for the same repository (or globally if no repo).
2. Looks for repeated patterns: e.g., "gate keeps rejecting for missing tests", "rework rate spiking on `feature` type tasks".
3. Calls Claude with a summary of recent decisions to identify systemic issues.
4. Records new learnings (via `createLearning`) or reinforces existing ones (via `reinforceLearning`) to improve future decisions.
5. All database writes are wrapped in try/catch so a failure here never surfaces to the gate caller.

### Output

Gate analyst outputs are persisted as learnings, not returned to the caller. They influence future router, refiner, and gate prompts indirectly through the learning context injected at runtime.

---

## Browser Validator — `browser-validator.ts`

Uses the **agentic loop** (`callClaudeWithTools`) to launch a headless browser, navigate the application, take screenshots, and validate UI correctness.

### When It Runs

Called by the pipeline for tasks with a UI component (e.g., `type: "feature"` tasks that touch frontend code). Determined by task metadata or enrichment data.

### Tools Provided to Claude

The browser validator defines a set of Playwright-backed tools exposed to Claude:

| Tool | Description |
|---|---|
| `navigate` | Navigate to a URL |
| `screenshot` | Take a full-page or element screenshot |
| `click` | Click an element by CSS selector |
| `type` | Type text into an input field |
| `wait` | Wait for an element or condition |
| `evaluate` | Run arbitrary JS in the page context |
| `scroll` | Scroll the page or an element |

Screenshots are returned as `ImageBlockParam` (base64 PNG), allowing Claude to **see** the rendered UI and make assertions about correctness.

### Agentic Loop Configuration

```ts
callClaudeWithTools({
  model: getModelFor("browser-validator"),
  maxTokens: 16_384,
  maxTurns: 30,
  systemPrompt: loadPrompt("browser-validator"),
  tools: [...],
  executeTool: async (name, input) => { ... }
})
```

The `onTurnComplete` callback is used to heartbeat the active-agent registration so the daemon doesn't consider the agent stale during long browser sessions.

### Output

Returns a structured validation report stored on the task, including:
- Pass/fail status.
- List of visual or functional issues found.
- Screenshots as evidence (stored references, not inline).

---

## Code Quality Analyst — `code-quality-analyst.ts`

Performs static analysis of code changes produced by the worker, identifying quality issues before the gate evaluates the task.

### When It Runs

Called by the pipeline after the worker completes but before the gate, as part of the enrichment phase.

### What It Analyses

- Code style and formatting inconsistencies.
- Potential bugs (null dereferences, missing error handling, type mismatches).
- Security concerns (hardcoded secrets, injection risks).
- Test coverage adequacy.
- Adherence to project conventions (detected from the repository's coding patterns).

### How It Works

1. Reads the diff produced by the worker (git diff of the worktree vs base branch).
2. Calls Claude with the diff and a structured prompt requesting a quality report.
3. Parses the JSON response into a quality report.
4. Stores the report in `task.enrichment.codeQuality`.
5. Records cost under `"code-quality-analyst"`.

### Output Shape

```json
{
  "score": 0.85,
  "issues": [
    { "severity": "warning", "file": "src/foo.ts", "line": 42, "message": "..." }
  ],
  "summary": "Overall code quality is good with minor concerns."
}
```

A low quality score may influence the gate to issue a `rework` verdict.

---

## Keeper — `keeper.ts`

Curates the learning knowledge base by deduplicating, archiving stale entries, and promoting high-confidence learnings to a wider scope.

### When It Runs

Called periodically by the daemon (not tied to a specific task). Scheduled in `autonomous.config.yaml` under the keeper settings.

### Entry Point

```ts
export async function curateLearnings(): Promise<void>
```

### What It Does

1. Loads all active (non-superseded) learnings from the database (up to 200).
2. Builds a summary of each learning including: `id`, `scope`, `category`, `confidence`, `reinforcements`, `contradictions`, `lastUsedAt`, `content`.
3. Appends the `dismissedContext` (learnings previously rejected so Claude doesn't re-propose them).
4. Sends to Claude with the system prompt embedded in `KEEPER_SYSTEM_PROMPT`.
5. Parses the JSON response and applies three types of actions:

| Action | Database operation |
|---|---|
| `duplicates` | `supersedeLearning(removeId, keepId)` for each duplicate |
| `archiveIds` | `supersedeLearning(id, -1)` (sentinel for self-archived) |
| `promotions` | `UPDATE learnings SET scope = newScope` |

6. Also runs `archiveStale()` — an automated query-based check that archives learnings below a confidence threshold regardless of the LLM's suggestions.
7. Records a `learning-event` for every change for auditability.

### KeeperResult Shape (from Claude)

```json
{
  "duplicates": [{ "keepId": 5, "removeIds": [3, 7] }],
  "archiveIds": [12, 19],
  "promotions": [{ "id": 8, "newScope": "universal" }]
}
```

### Conservation Principle

The system prompt instructs Claude to be **conservative**. Empty arrays for all fields is a valid and expected output when the knowledge base is healthy.

---

## Retrospective — `retrospective.ts`

Runs a weekly analysis over completed tasks, costs, and learnings to identify systemic trends and propose knowledge base updates.

### When It Runs

Called by the daemon on a weekly schedule. The last run timestamp is stored in `config` as `"lastRetrospectiveRun"`.

### Entry Point

```ts
export async function runRetrospective(): Promise<RetrospectiveReport>
```

### Data Gathered

| Source | What's collected |
|---|---|
| `tasks` table | All `done`/`failed` tasks since last run: status, reworkCount, failureReason, type |
| `costs` table | Cost per agent (sum + call count) since last run |
| `learnings` table | All active learnings (up to 200): confidence, reinforcements, contradictions, lastUsedAt |
| `learning-events` table | Most recent 100 events |

### Metrics Computed (before LLM call)

```
totalTasks      = done + failed tasks in period
firstPassRate   = first-pass (reworkCount=0) done tasks / total
reworkRate      = reworked (reworkCount>0) done tasks / total
failureRate     = failed tasks / total
totalCostUsd    = sum of all agent costs in period
```

These are pre-computed and embedded in the prompt so Claude doesn't need to calculate them.

### RetrospectiveReport Shape

```ts
interface RetrospectiveReport {
  summary: string;
  metrics: {
    totalTasks: number;
    firstPassRate: number;
    reworkRate: number;
    failureRate: number;
    totalCostUsd: number;
  };
  topLearnings: { id: number; content: string; reinforcements: number }[];
  decayingLearnings: { id: number; content: string; confidence: number }[];
  blindSpots: string[];
  proposals: {
    action: "create" | "promote" | "deprecate";
    scope: string | null;
    category: string | null;
    content: string | null;
    tags: string[] | null;
    targetId: number | null;
  }[];
  costInsights: string;
}
```

### Proposal Application

After parsing, proposals are applied immediately:

| `action` | Operation |
|---|---|
| `create` | `createLearning(...)` with `confidence: 0.50` |
| `promote` | `reinforceLearning(targetId)` |
| `deprecate` | `contradictLearning(targetId, delta: 0.15)` |

Failed proposals are caught individually and logged as warnings — one bad proposal doesn't abort the rest.

### Persistence

The full report is stored in the config store as `"lastRetrospectiveReport"` so the dashboard can display it without re-running the analysis.

---

## Retry Utilities — `retry.ts`

Provides generic exponential backoff for any async operation. Used by agents to handle transient Anthropic API errors (rate limits, temporary server errors).

### Interface

```ts
interface RetryOptions {
  maxRetries?: number;    // default: 3
  baseDelayMs?: number;   // default: 1 000 ms
  maxDelayMs?: number;    // default: 30 000 ms
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>
```

### Backoff Formula

```
delay = min(baseDelayMs * 2^(attempt - 1) + jitter, maxDelayMs)
```

Jitter is a random value in `[0, baseDelayMs * 0.1]` added to prevent thundering herd when multiple agents retry simultaneously.

### Default `shouldRetry` Predicate

Retries on:
- HTTP 429 (rate limit)
- HTTP 5xx (server errors)
- Network errors (ECONNRESET, ETIMEDOUT)

Does **not** retry on:
- 400 Bad Request (prompt too long, invalid params)
- 401 Unauthorized (bad API key)
- 403 Forbidden

### Usage Example

```ts
import { withRetry } from "./retry.js";

const response = await withRetry(
  () => callClaude({ prompt, model }),
  { maxRetries: 5, baseDelayMs: 2_000 }
);
```

---

## Cost Utilities — `cost-utils.ts`

Provides token-count-to-USD estimation used by all agents before calling `recordCost`.

### Entry Point

```ts
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputCostPerM?: number,   // $/million input tokens
  outputCostPerM?: number   // $/million output tokens
): number
```

### Fallback Behaviour

When `inputCostPerM` or `outputCostPerM` are not provided, `estimateCostUsd` calls `getAutonomousConfig()` to read the rates from `autonomous.config.yaml`:

```yaml
models:
  inputCostPerM: 3.00    # $ per million input tokens
  outputCostPerM: 15.00  # $ per million output tokens
```

This means agents can call `estimateCostUsd(inputTokens, outputTokens)` without passing rates explicitly, and the config serves as the single source of truth.

### Precision

Returns a `number` rounded to 6 decimal places (sub-cent precision). The `costs` table stores this as a `NUMERIC(10, 6)` column.

---

## Cross-Cutting Concerns

### Active Agent Registration

Every stateful agent registers itself on entry and unregisters in a `finally` block:

```ts
await register(taskId, agentName, model, "phase-description");
try {
  // ... work ...
} finally {
  await unregister(taskId);
}
```

The `active_agents` table is polled by the dashboard to show which agents are currently running and on which tasks.

### Structured Logging

All agents use the shared `logger` (pino) with consistent structured fields:

```ts
logger.info({ taskId, verdict, confidence }, "Gate: AI evaluation complete");
logger.error({ taskId, err }, "Gate agent failed to evaluate task");
```

Key fields used across agents:

| Field | Description |
|---|---|
| `taskId` | Always present for task-scoped agents |
| `costUsd` | Estimated cost for the LLM call |
| `durationMs` | Wall-clock time for the agent operation |
| `model` | Which Claude model was used |
| `err` | Error object (pino serializes `message` + `stack`) |

### Prompt Loading

All agents that use file-based prompts call `loadPrompt(name)` from `src/prompt-cache.ts`:

```ts
import { loadPrompt } from "../prompt-cache.js";
const systemPrompt = loadPrompt("router");
```

Prompts are read from `src/prompts/<name>.md` (or `.txt`) and cached in memory. The cache is **not** invalidated at runtime — a process restart is required to pick up prompt changes.

### Model Resolution

Agents never hard-code a model string. They always call:

```ts
import { getModelFor } from "../domain/autonomous-config.js";
const model = getModelFor("router"); // returns the configured model for this agent role
```

This allows operators to swap models per-agent role via `autonomous.config.yaml` without code changes.

### Cost Recording Pattern

Every agent that makes an LLM call records cost immediately after the call:

```ts
const costUsd = estimateCostUsd(
  response.cost.inputTokens,
  response.cost.outputTokens,
);

await recordCost(
  taskId,          // task the cost belongs to
  task.createdBy,  // user who owns the task
  AGENT_NAME,      // e.g. "router", "gate", "decomposer"
  response.cost.model,
  costUsd,
  1,               // call count (always 1 per invocation)
  durationMs,
);
```

---

## Agent Integration Examples

### Calling the Router from Tests

```ts
import { routeTask } from "../agents/router.js";

// Create a task with status "pending" in the test DB first, then:
const result = await routeTask(taskId);
// result: { type, size, workflow, model, maxTurns?, maxBudgetUsd? }
```

### Dry-Running the SDK in Tests

```ts
import { callClaude } from "../agents/sdk.js";

const response = await callClaude({
  prompt: "test prompt",
  dryRun: true,
});
// response.text === "[dry-run] prompt length=11"
// response.cost.inputTokens === 0
```

### Adding a New Single-Turn Agent

Follow this template for any new stateful agent:

```ts
import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { getById, updateStatus } from "../db/queries/tasks.js";
import { register, unregister } from "../db/queries/active-agents.js";
import { recordCost } from "../db/queries/costs.js";

const AGENT_NAME = "my-agent";

export async function runMyAgent(taskId: string): Promise<void> {
  const task = await getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== "expected-status") {
    throw new Error(`Task ${taskId} has unexpected status: ${task.status}`);
  }

  const startTime = Date.now();
  const model = getModelFor(AGENT_NAME);

  await register(taskId, AGENT_NAME, model, "processing");

  try {
    const response = await callClaude({
      prompt: buildPrompt(task),
      model,
      systemPrompt: "...",
    });

    // parse response, update task, transition status
    await updateStatus(taskId, "next-status");

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    await recordCost(taskId, task.createdBy, AGENT_NAME, model, costUsd, 1, Date.now() - startTime);

    logger.info({ taskId }, "My agent complete");
  } catch (err) {
    logger.error({ taskId, err }, "My agent failed");
    throw err;
  } finally {
    await unregister(taskId);
  }
}
```

### Adding a New Agentic (Tool-Use) Agent

Use `callClaudeWithTools` and provide an `executeTool` dispatcher:

```ts
import { callClaudeWithTools } from "./sdk.js";

const response = await callClaudeWithTools({
  prompt: userPrompt,
  model: getModelFor("my-agentic-agent"),
  systemPrompt: loadPrompt("my-agentic-agent"),
  tools: [
    {
      name: "read_file",
      description: "Read the contents of a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  executeTool: async (name, input) => {
    if (name === "read_file") {
      return await fs.readFile(input.path as string, "utf-8");
    }
    throw new Error(`Unknown tool: ${name}`);
  },
  maxTurns: 20,
  onTurnComplete: (turn) => {
    // e.g. update heartbeat / refresh active-agent registration
    logger.debug({ turn }, "Agent turn complete");
  },
});
```

---

---

## Blueprint Validation Mode (Architect Enricher)

When a task is created from a user-supplied blueprint (`task.blueprintSource === true`), the
architect enricher shifts from **plan generation** to **plan validation**. Everything else in
the enrichment pipeline runs identically — there is no short-circuit for blueprint-sourced tasks.

### What changes

| Aspect | Normal task | Blueprint-sourced task |
|---|---|---|
| Architect role | Generate a milestone plan | Validate the user-supplied blueprint |
| System prompt | Standard architect prompt | Architect prompt + blueprint validation addendum |
| User prompt | Task title + body | Task title + body + raw blueprint markdown |
| Output fields | `milestones`, `questions`, `awaitingInput` | Same output schema — validation errors surface as `questions` |
| `awaitingInput` | Set when architect needs clarification | Set when blueprint has gaps or contradictions |
| Pipeline flow after architect | Standard approval gate | Same — no bypass |

### Validation behaviour

The architect receives the blueprint text inside a `<blueprint>` XML tag and is instructed to:

1. **Parse** the milestone list, acceptance criteria, and file lists.
2. **Validate** that every milestone has a non-empty title, at least one acceptance criterion,
   and at least one file to modify.
3. **Flag gaps** — if a milestone references a file that doesn't exist in the codebase context,
   the architect raises it as a clarifying question rather than blocking outright.
4. **Ask questions** — if any milestone is ambiguous or the overall scope is unclear, the
   architect sets `awaitingInput: true` and returns its questions. The task enters the
   `awaiting-input` state and the user is notified via the dashboard, exactly as it would be
   for a normally-created task.
5. **Approve** — if the blueprint is coherent and complete, the architect sets
   `awaitingInput: false` and the pipeline continues to the approval gate.

### Enricher pipeline for blueprint tasks

`getEnrichersForTask()` (exported from `src/enrichers/index.ts`) is the correct function to
call when building the enricher list for a task. For blueprint-sourced tasks it returns the
**same full pipeline** as `getEnabledEnrichers()` — the function exists to make the
no-short-circuit guarantee explicit and auditable at the call site:

```ts
// src/enrichers/index.ts
export function getEnrichersForTask(task: Task, config: AutonomousConfig): Enricher[] {
  // Blueprint-sourced tasks always run the full pipeline.
  // We still respect the config's enabled-enricher list so operators can
  // disable specific enrichers globally, but we never skip enrichers
  // solely because the task has a blueprint source.
  return getEnabledEnrichers(config);
}
```

Enrichers that run for every blueprint task:

| Enricher | Why it still runs |
|---|---|
| `codebaseEnricher` | Architect needs file-tree context to validate file references |
| `gitHistoryEnricher` | Provides recent-commit context for risk assessment |
| `dependenciesEnricher` | Detects dependency version constraints that milestones may miss |
| `docsEnricher` | Surfaces existing docs the blueprint should align with |
| `prismEnricher` (scorer) | Produces cost / risk estimates — blueprint does not bypass scoring |
| `architectEnricher` | Validates blueprint; may set `awaitingInput: true` |
| `scorerEnricher` | Final complexity and budget signal for the gate |

### Gate and approval flow

A blueprint-sourced task that passes architect validation enters the **standard approval gate
flow** — there is no auto-approval bypass. The gate evaluates the enriched task (including the
blueprint and the architect's validation notes) using the same approve / reject / rework
logic as any other task. The gate mode (`human`, `ai`, `auto`) is respected exactly as normal.

### Prompt files

- `src/prompts/architect.md` — base architect prompt
- `src/prompts/architect-blueprint-addendum.md` — injected when `task.blueprintSource === true`;
  instructs the architect to validate rather than generate

---

## See Also

- [`docs/internal/architecture.md`](../architecture.md) — system-wide data flow and component map
- [`docs/internal/modules/database.md`](./database.md) — database schema and query layer
- [`docs/internal/modules/daemon.md`](./daemon.md) *(upcoming)* — task scheduling and agent dispatch
- `src/blueprints/` — blueprint schema, parser, and template
- `src/prompts/` — system prompts loaded by each agent
- `autonomous.config.yaml` — model assignments, gate mode, cost rates
