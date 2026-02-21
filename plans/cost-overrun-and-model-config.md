# Blueprint: Cost Overrun Controls + Per-Agent Model Config

## Overview

Add mid-execution budget enforcement (dollars + turns) with task suspension on overrun, per-agent model configuration, and a 3-level cascade (global -> per-repo -> per-task) for all limits.

**Current state**: Budget is only checked *before* execution starts. Once a task begins, it runs unchecked. `perTaskMax` ($25 default) and `task.maxBudgetUsd` are stored but never enforced. Per-agent model selection doesn't exist -- everything falls back to `config.models.gate`.

---

## 1. Cost Overrun Enforcement

### 1a. Abort Mechanism

New error class in `src/agents/sdk.ts`:

```typescript
export class BudgetExceededError extends Error {
  constructor(public reason: 'budget' | 'turns', public detail: string) {
    super(`Budget exceeded (${reason}): ${detail}`);
    this.name = 'BudgetExceededError';
  }
}
```

New callback type replacing the current `(turn: number) => void`:

```typescript
export interface TurnInfo {
  turn: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// In AgenticRequest:
onTurnComplete?: (info: TurnInfo) => void;  // was (turn: number) => void
```

When `onTurnComplete` throws `BudgetExceededError`, it propagates out of the `callClaudeWithTools` loop naturally -- the SDK's `for` loop does not catch callback errors. The partial token counts are already accumulated, so cost can still be recorded.

Update the single existing call site in the SDK loop (line ~146):

```typescript
// Before:
req.onTurnComplete?.(turns);
// After:
req.onTurnComplete?.({ turn: turns, totalInputTokens, totalOutputTokens });
```

### 1b. Limit Resolution -- `resolveTaskLimits()`

New function in `src/execution/worker.ts`:

```typescript
interface TaskLimits {
  maxBudgetUsd: number;
  maxTurns: number;
}

function resolveTaskLimits(
  task: { maxBudgetUsd?: number | null; maxTurns?: number | null },
  repoSettings: { perTaskMax?: number; maxTurns?: number },
  globalConfig: { budget: BudgetConfig }
): TaskLimits {
  return {
    maxBudgetUsd: task.maxBudgetUsd ?? repoSettings.perTaskMax ?? globalConfig.budget.perTaskMax,
    maxTurns: task.maxTurns ?? repoSettings.maxTurns ?? globalConfig.budget.maxTurns,
  };
}
```

3-level cascade: **task wins > repo wins > global default**. Most specific value takes precedence. `null`/`undefined` means "inherit from parent".

### 1c. Mid-Execution Budget Callback

Built inside `executeTask()` (worker.ts), shared across milestone and single-call paths:

```typescript
// Mutable ref accumulates cost across milestones + review cycles
const runningCostRef = { usd: 0 };
const limits = resolveTaskLimits(task, repo.settings, config);

function makeBudgetCallback(taskId: string, limits: TaskLimits): (info: TurnInfo) => void {
  return (info: TurnInfo) => {
    // Turn check
    if (info.turn > limits.maxTurns) {
      throw new BudgetExceededError('turns', `${info.turn}/${limits.maxTurns} turns`);
    }

    // Cost check (running total + current call's tokens so far)
    const currentCallCost = estimateCostUsd(info.totalInputTokens, info.totalOutputTokens);
    const totalCost = runningCostRef.usd + currentCallCost;
    if (totalCost > limits.maxBudgetUsd) {
      throw new BudgetExceededError('budget', `$${totalCost.toFixed(2)}/$${limits.maxBudgetUsd}`);
    }
  };
}
```

Key detail: `runningCostRef.usd` is incremented after each `callClaudeWithTools` returns (and after each review-fix cycle in milestones), so the callback sees the cumulative cost from all prior calls plus the tokens-so-far of the current call. This is synchronous -- `estimateCostUsd()` is a pure calculation.

### 1d. Suspension on Overrun

In `executeTask()`, catch `BudgetExceededError`:

```typescript
try {
  // ... execute milestones or single call ...
} catch (err) {
  if (err instanceof BudgetExceededError) {
    logger.warn({ taskId, reason: err.reason, detail: err.detail }, 'Task suspended: budget exceeded');
    await suspendTask(taskId);                              // executing -> suspended (already valid transition)
    await recordCost(taskId, task.createdBy, 'worker', model, runningCostRef.usd, turns, durationMs);
    await logEvent(taskId, 'budget_exceeded', { reason: err.reason, detail: err.detail });
    return { success: false, reason: err.detail };
  }
  throw err; // re-throw non-budget errors
}
```

The state machine already allows `executing -> suspended`. Suspended tasks show Resume/Cancel actions in the dashboard. A resumed task goes back to `pending` and re-enters the queue.

### 1e. Existing Call Sites to Update

Every caller of `callClaudeWithTools` that uses `onTurnComplete` must update from `(turn: number)` to `(info: TurnInfo)`:

| File | Current callback | Change |
|------|-----------------|--------|
| `worker.ts:425` (single-call) | `() => heartbeat(taskId)` | `(info) => { heartbeat(taskId); budgetCallback(info); }` |
| `worker.ts:270` (milestones) | `() => heartbeat(task.id)` | `(info) => { heartbeat(task.id); budgetCallback(info); }` |
| `review-gate.ts:115` | `() => heartbeat(taskId)` | `(info) => { heartbeat(taskId); }` (no budget check -- review is already bounded) |
| Other agents (router, gate, etc.) | No callback set | No change needed |

After each milestone completes, update the running cost ref:

```typescript
const result = await callClaudeWithTools({ ..., onTurnComplete: budgetCallback });
const implCost = estimateCostUsd(result.cost.inputTokens, result.cost.outputTokens);
runningCostRef.usd += implCost;
// ... review-fix cycle ...
runningCostRef.usd += review.costUsd;
```

---

## 2. Per-Agent Model Configuration

### 2a. Expand ModelConfig

In `src/domain/autonomous-config.ts`:

```typescript
export interface ModelConfig {
  router: string;          // routing/classification agent
  gate: string;            // gate + lightweight single-call agents (default fallback)
  worker?: string;         // execution agent (Claude + tools)
  reviewGate?: string;     // review agent
  enricher?: string;       // architect + scorer enrichers
  inputCostPerM: number;
  outputCostPerM: number;
}
```

Three new optional fields. When unset, each falls back to `gate`. This covers the 5 meaningful agent roles:

| Role | Agents using it |
|------|----------------|
| `router` | Router |
| `gate` | Gate, Refiner, Decomposer, Code Quality Analyst, Gate Analyst, Browser Validator, Feedback Loop, Retrospective, Keeper |
| `worker` | Worker (execution) |
| `reviewGate` | Review Gate, Milestone Review |
| `enricher` | Architect enricher, Scorer enricher |

Defaults: all `undefined` (use `gate`).

### 2b. Per-Agent Model Resolution (one-line changes)

| File:Line | Current | New |
|-----------|---------|-----|
| `worker.ts:337` | `task.model ?? config.models.gate` | `task.model ?? config.models.worker ?? config.models.gate` |
| `review-gate.ts:106` | `config.models.gate` | `config.models.reviewGate ?? config.models.gate` |
| `architect.ts:209` | `config.model ?? autonomousConfig.models.gate` | `config.model ?? autonomousConfig.models.enricher ?? autonomousConfig.models.gate` |
| `scorer.ts:292` | `config.model ?? autonomousConfig.models.gate` | `config.model ?? autonomousConfig.models.enricher ?? autonomousConfig.models.gate` |
| `milestone-review.ts` | Model passed as param from worker | No change (inherits worker's model) |

### 2c. Add `models` to ConfigOverrides

```typescript
export interface ConfigOverrides {
  classification?: Partial<ClassificationConfig>;
  gate?: Partial<GateConfig>;
  budget?: Partial<BudgetConfig>;
  clarification?: Partial<ClarificationConfig>;
  models?: Partial<Pick<ModelConfig, 'router' | 'gate' | 'worker' | 'reviewGate' | 'enricher'>>;
}
```

Update `mergeOverrides()` to include models:

```typescript
export function mergeOverrides(base: AutonomousConfig, overrides: ConfigOverrides): AutonomousConfig {
  return {
    ...base,
    classification: { ...base.classification, ...overrides.classification },
    gate: { ...base.gate, ...overrides.gate },
    budget: { ...base.budget, ...overrides.budget },
    clarification: { ...base.clarification, ...overrides.clarification },
    models: { ...base.models, ...overrides.models },  // NEW
  };
}
```

---

## 3. Settings UI/Route Changes

### 3a. Global Settings -- New Models Card

Add to `globalSettingsPartial()` in `src/dashboard/views/settings.ts`:

```
+----------------------------+
| Models                     |
|                            |
| Router:      [_________]   |
| Gate:        [_________]   |
| Worker:      [_________]   |
| Review Gate: [_________]   |
| Enricher:    [_________]   |
|                            |
| (empty = use default)      |
+----------------------------+
```

Each is a text input. Empty string means "use fallback". Pre-filled with current config values.

### 3b. Global Settings -- maxTurns in Budget Card

Add a `maxTurns` input to the existing Budget card, below `perTaskMax`:

```
+----------------------------+
| Budget                     |
|                            |
| Daily default ($): [100]   |
| Per-task max ($):  [25]    |
| Max turns:         [30]    |  <-- NEW
+----------------------------+
```

### 3c. Repo Settings -- maxTurns Override

Add `maxTurns` input to the repo settings card, near the existing per-repo budget inputs:

```
Per-task max ($):  [___]  (amber dot if overriding)
Max turns:         [___]  (amber dot if overriding)   <-- NEW
```

Stored in `repo.settings.maxTurns`.

### 3d. Settings Route Changes

**POST /settings/global** (`src/dashboard/routes/settings.ts`):

Parse new fields from form body:
- `maxTurns` -> `overrides.budget.maxTurns` (integer, >= 1)
- `modelRouter`, `modelGate`, `modelWorker`, `modelReviewGate`, `modelEnricher` -> `overrides.models.*` (strings, trimmed, empty = omit)

**POST /settings/repos/:id**:

Parse `maxTurns_${repoId}` from form body. Store in `settings.maxTurns`. Empty = unset (inherit global).

---

## 4. 3-Level Cascade Summary

```
                  global config          repo.settings         task fields
                  ─────────────          ─────────────         ───────────
perTaskMax        budget.perTaskMax  ->   perTaskMax       ->   maxBudgetUsd
maxTurns          budget.maxTurns   ->   maxTurns         ->   maxTurns
model             models.worker     ->   (not applicable) ->   task.model
```

Resolution: most specific non-null value wins.

- Global defaults set in `autonomous.config.yaml` or via Settings UI (persisted as `ConfigOverrides` in DB).
- Per-repo overrides stored in `repos.settings` JSONB column.
- Per-task values set by the router agent when it classifies/routes a task.

---

## 5. Files to Modify

| # | File | Changes |
|---|------|---------|
| 1 | `src/domain/autonomous-config.ts` | Expand `ModelConfig` (3 optional fields), add `maxTurns` to `BudgetConfig`, add `models` to `ConfigOverrides`, update `mergeOverrides()`, update DEFAULTS |
| 2 | `src/agents/sdk.ts` | Add `BudgetExceededError` class, add `TurnInfo` interface, change `onTurnComplete` signature, update callback invocation in loop |
| 3 | `src/execution/worker.ts` | Add `resolveTaskLimits()`, build budget callback, catch `BudgetExceededError` + suspend, update model resolution, update `onTurnComplete` call sites, track `runningCostRef` across milestones |
| 4 | `src/execution/review-gate.ts` | Update model resolution (`reviewGate ?? gate`), update `onTurnComplete` signature |
| 5 | `src/enrichers/architect.ts` | Update model resolution (`enricher ?? gate`) |
| 6 | `src/enrichers/scorer.ts` | Update model resolution (`enricher ?? gate`) |
| 7 | `src/dashboard/views/settings.ts` | Add Models card to global settings, add `maxTurns` to Budget card, add per-repo `maxTurns` input |
| 8 | `src/dashboard/routes/settings.ts` | Parse/validate new fields in both POST handlers |
| 9 | Tests | Update mocks for new `TurnInfo` signature, add `resolveTaskLimits` unit tests, add `BudgetExceededError` handling tests |

---

## 6. Implementation Order

1. **Types first**: `autonomous-config.ts` -- expand interfaces, defaults, merge logic
2. **SDK plumbing**: `sdk.ts` -- `BudgetExceededError`, `TurnInfo`, callback signature
3. **Enforcement core**: `worker.ts` -- `resolveTaskLimits`, budget callback, suspension handler, running cost tracking
4. **Model resolution**: `worker.ts`, `review-gate.ts`, `architect.ts`, `scorer.ts` -- one-line changes each
5. **Settings UI**: `settings.ts` view -- Models card, maxTurns inputs
6. **Settings routes**: `settings.ts` route -- parse/validate/persist new fields
7. **Tests**: Update mocks, add new test cases

Steps 1-2 are foundational. Steps 3-4 can be done together. Steps 5-6 can be done together. Step 7 throughout.

---

## 7. Edge Cases & Notes

- **Heartbeat stays fire-and-forget**: The budget callback is synchronous (just math + throw), so it can coexist with the async heartbeat in the same `onTurnComplete`.
- **Milestone boundary costs**: `runningCostRef.usd` must be incremented after each milestone's implementation call AND after each review-fix cycle to avoid double-counting or undercounting.
- **Resume after suspension**: Task goes `suspended -> pending -> routing/executing`. The accumulated cost from the prior attempt is already recorded. A new execution starts fresh cost tracking but the daily budget check still accounts for all prior costs.
- **Router-set limits**: The router already suggests `maxTurns` and `maxBudgetUsd` per task. These become the most specific level in the cascade, meaning the router's recommendations are finally enforced.
- **Cost estimation accuracy**: `estimateCostUsd()` uses global `inputCostPerM`/`outputCostPerM` from config. If different models have different pricing, the estimate will be approximate. This is acceptable for guardrail purposes -- exact billing isn't the goal.
- **No per-repo model override**: The cascade for models is global -> task (set by router). Per-repo model overrides are omitted to keep complexity down. Per-repo already has enricher model overrides in the enricher config.
