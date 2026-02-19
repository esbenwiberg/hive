# Architect + Scorer Enrichers & Sequential Milestone Execution

Add two AI-powered enrichers to the Hive pipeline (architect and scorer) and modify the execution worker to implement tasks milestone-by-milestone with a review-fix verification loop. The architect can ask clarification questions before building its blueprint, with the answering mode configurable (human/ai/auto) like the gate.

**Milestones: 8**

## Non-goals

- Changing the epic decomposer system (epics still create child tasks)
- Hard-coding scorer results into gate logic (informational only)
- New database migration (questions/answers/blueprints fit in existing `tasks.enrichment` JSONB)
- Switching from raw Anthropic API to Claude Code CLI

## Acceptance Criteria

- [ ] Architect enricher produces size-aware blueprints: skips trivial, simple plan for small, milestones for medium/large
- [ ] Architect generates clarification questions when task is ambiguous; pipeline pauses for answers
- [ ] Clarification answer mode is configurable: human (dashboard), ai (Claude answers), auto (skip trivial/small, AI for rest)
- [ ] Scorer enricher evaluates blueprints on value/complexity/risk/feasibility (1-10) and estimates cost in USD
- [ ] Both enrichers configurable (enabled/disabled, model override) via `autonomous.config.yaml` and per-repo settings
- [ ] Worker executes milestones sequentially when blueprint has milestones, falls back to single-call for trivial/small
- [ ] Per-milestone review-fix loop: shell verification + Claude review, iterate up to 2 times
- [ ] Each milestone committed individually in worktree
- [ ] Rework cycle uses single rework call (current behavior preserved)
- [ ] All existing tests pass; new tests added
- [ ] `npm run build` passes with no type errors

## Architecture

```
Pipeline: pending → ROUTE → queued → ENRICH → [questions?] → gate → execute → review → done

ENRICH (6 sequential enrichers):
  1. codebase    (filesystem)
  2. docs        (filesystem)
  3. git-history (git commands)
  4. dependencies (package.json)
  5. architect   (Claude → questions or blueprint)   ← NEW
  6. scorer      (Claude → scores + cost estimate)   ← NEW

ARCHITECT CLARIFICATION FLOW (configurable like gate):
  Phase 1 (first run — no answers yet):
    → Claude analyzes task + enrichment context
    → If ambiguities: returns clarificationQuestions[]
    → Pipeline checks clarification.mode:
        "human" → task → "ready", questions shown in dashboard
        "ai"    → Claude auto-answers questions, architect re-runs immediately
        "auto"  → skip questions for trivial/small, AI-answer for medium/large
    → After answers available: task → "enriching", re-runs architect only
  Phase 2 (answers available):
    → Claude builds blueprint using task + enrichment + answers
    → Continue to scorer → gate → execute

EXECUTE (modified worker):
  if milestones:
    for each milestone:
      → callClaude (milestone-scoped prompt)
      → review-fix loop (inspired by /review-fix):
          1. quickVerify: npm run lint/build/test
          2. Claude reviews diff for logical issues
          3. if issues: Claude fixes → re-verify → repeat (max 2 iterations)
      → git commit milestone
  else:
    → callClaude (single shot, as today)
  then: full review gate → rework/pass/fail
```

### Key interfaces

```typescript
// enrichment.architect
interface ArchitectBlueprint {
  approach: string;
  architectureNotes?: string;
  milestones?: ArchitectMilestone[];   // medium/large
  keyFiles?: string[];                  // small
  checklist?: string[];                 // small
  clarificationQuestions?: string[];    // Phase 1: questions for user/AI
  clarificationAnswers?: string[];     // Phase 2: answers (from user or AI)
  awaitingInput?: boolean;              // true = pipeline should pause
}

// enrichment.scorer
interface ScorerResult {
  scores: {
    value:       { score: number; reasoning: string };
    complexity:  { score: number; reasoning: string };
    risk:        { score: number; reasoning: string };
    feasibility: { score: number; reasoning: string };
  };
  costEstimate: {
    totalUsd: number;
    breakdown: { enrichment: number; execution: number; review: number };
    reasoning: string;
  };
  recommendation: "approve" | "reject" | "rework";
  summary: string;
}
```

### Config addition (`autonomous.config.yaml`)

```yaml
clarification:
  mode: human   # human | ai | auto

enrichers:
  # ...existing 4...
  - name: architect
    enabled: true
  - name: scorer
    enabled: true
```

## File Layout

```
prompts/
  architect.md              ← NEW: system prompt for architect (questions + blueprint)
  scorer.md                 ← NEW: system prompt for scorer
  flow.md                   ← MODIFY: add milestone mode section

src/enrichers/
  architect.ts              ← NEW: two-phase architect enricher + types
  scorer.ts                 ← NEW: scorer enricher + types
  index.ts                  ← MODIFY: register both enrichers

src/agents/
  pipeline.ts               ← MODIFY: handle architect questions + auto-answer

src/domain/
  state-machine.ts          ← MODIFY: add ready → enriching transition
  autonomous-config.ts      ← MODIFY: add ClarificationConfig type

src/execution/
  worker.ts                 ← MODIFY: milestone execution loop
  milestone-review.ts       ← NEW: review-fix loop (shell + Claude)

src/dashboard/
  routes/tasks.ts           ← MODIFY: add POST /api/tasks/:id/clarify endpoint

autonomous.config.yaml      ← MODIFY: add clarification + enricher entries

tests/enrichers/
  architect.test.ts         ← NEW
  scorer.test.ts            ← NEW
tests/execution/
  milestone-review.test.ts  ← NEW
```

## Milestones

### Milestone 1: Architect enricher + prompt

**Intent:** Create the two-phase architect enricher that can generate clarification questions or a blueprint.

**Files:**
- `prompts/architect.md` (create)
- `src/enrichers/architect.ts` (create)

**Details:**

**`prompts/architect.md`** — System prompt with two modes:
- When no `clarificationAnswers` in input: analyze task + enrichment, decide if questions are needed. If yes, return `{ clarificationQuestions: [...], awaitingInput: true }`. If task is clear enough, produce the blueprint directly.
- When `clarificationAnswers` present: use them to build a definitive blueprint.
- Output schema varies by size: small → approach/keyFiles/checklist, medium → 2-4 milestones, large → 3-6 milestones.
- Each milestone: `{ title, description, filesToModify[], acceptanceCriteria[] }`

**`src/enrichers/architect.ts`**:
- Export types: `ArchitectBlueprint`, `ArchitectMilestone`
- Skip trivial tasks (return `{ skipped: true }`, no Claude call)
- For small/medium/large: call Claude with task + `priorResults` JSON + any existing answers
- `parseBlueprint()`: strip code fences, validate JSON, coerce types. On failure: store raw text as fallback `approach`
- Model: `config.model` if set, else `getAutonomousConfig().models.gate`
- Cost tracking via `estimateCostUsd()`

**Verify:** `npm run build`

---

### Milestone 2: Scorer enricher + prompt

**Intent:** Create the scorer enricher that evaluates blueprints and estimates implementation cost.

**Files:**
- `prompts/scorer.md` (create)
- `src/enrichers/scorer.ts` (create)

**Details:**

**`prompts/scorer.md`** — Instructs Claude to:
- Score value/complexity/risk/feasibility (1-10 each with reasoning)
- Estimate cost breakdown (enrichment + execution + review) based on milestone count, task size, model costs ($3/M input, $15/M output)
- Give a recommendation (approve/reject/rework) and one-line summary

**`src/enrichers/scorer.ts`**:
- Export types: `ScorerResult`, `TaskScores`, `CostEstimate`
- Reads `priorResults.architect` for the blueprint
- If architect was skipped/missing: heuristic scores without Claude call (e.g. trivial → low complexity/risk, high feasibility)
- `parseScorerResult()`: clamp scores 1-10, validate recommendation enum. On failure: mid-range defaults with `"parse_error"` note
- Model: `config.model` if set, else gate model

**Verify:** `npm run build`

---

### Milestone 3: Config, registration, and state machine

**Intent:** Wire enrichers into the pipeline, add clarification config, update state machine.

**Files:**
- `src/enrichers/index.ts` (modify)
- `autonomous.config.yaml` (modify)
- `src/domain/autonomous-config.ts` (modify)
- `src/domain/state-machine.ts` (modify)

**Details:**

**`src/enrichers/index.ts`**: Import and append `architectEnricher` (5th) and `scorerEnricher` (6th) to `ALL_ENRICHERS`. Order matters — architect needs prior 4, scorer needs architect.

**`autonomous.config.yaml`**: Add:
```yaml
clarification:
  mode: human
enrichers:
  # ...existing...
  - name: architect
    enabled: true
  - name: scorer
    enabled: true
```

**`src/domain/autonomous-config.ts`**: Add `ClarificationConfig` type:
```typescript
export interface ClarificationConfig {
  mode: "human" | "ai" | "auto";
}
```
Add to `AutonomousConfig` interface and `DEFAULTS` (default: `{ mode: "human" }`). Update `loadConfig()` to parse new section.

**`src/domain/state-machine.ts`**: Add `TaskStatus.ENRICHING` to `ALLOWED_TRANSITIONS[TaskStatus.READY]` array. This enables `ready → enriching` for when a user submits clarification answers and the task re-enters enrichment.

**Verify:** `npm run build`

---

### Milestone 4: Pipeline clarification flow

**Intent:** Modify the pipeline to detect architect questions, pause for human/AI answers, and resume enrichment.

**Files:**
- `src/agents/pipeline.ts` (modify)
- `src/dashboard/routes/tasks.ts` (modify)

**Details:**

**`src/agents/pipeline.ts`** — After Step 4 (enrichment), before Step 5 (gate):
```
1. Reload task, check enrichment.architect.awaitingInput
2. If awaitingInput:
   a. Read clarification.mode from config
   b. If "human": transition to "ready", return early (dashboard shows questions)
   c. If "ai": call Claude to answer questions, store answers in enrichment,
      clear awaitingInput, re-run architect enricher only (Phase 2)
   d. If "auto": skip for trivial/small (clear questions, proceed),
      AI-answer for medium/large
3. If not awaitingInput: proceed to gate as normal
```

For AI-answering: a simple `callClaude()` with the task context + enrichment + questions, asking it to answer each question concisely. Store answers in `enrichment.architect.clarificationAnswers`, then re-run the architect enricher (pass updated enrichment as priorResults).

**`src/dashboard/routes/tasks.ts`** — Add `POST /api/tasks/:id/clarify`:
- Requires auth
- Reads `{ answers: string[] }` from body
- Loads task, validates it's in `ready` status and has `enrichment.architect.clarificationQuestions`
- Stores answers in `enrichment.architect.clarificationAnswers`, clears `awaitingInput`
- Transitions task back to `enriching` (uses the new state machine transition)
- Returns updated task list partial with HTMX toast

**Verify:** `npm run build`

---

### Milestone 5: Milestone review-fix loop

**Intent:** Create the per-milestone verification module: shell verify + Claude review, fix and re-verify up to 2 times.

**Files:**
- `src/execution/milestone-review.ts` (create)

**Details:**

**`quickVerify(worktreePath)`**: Run `npm run lint --if-present`, `npm run build --if-present`, `npm run test --if-present` via `child_process.execFile`. 120s timeout each. Returns `{ passed: boolean, failures: string[] }`.

**`reviewFix(worktreePath, milestoneSummary, model, maxIterations=2)`** — The review-fix loop:
1. `quickVerify()` — run shell commands
2. If all pass: call Claude with the diff for a quick code review (catch logical issues)
3. If shell or Claude finds issues: build fix prompt (errors + changed files + working dir), call Claude to fix
4. Re-run `quickVerify()` + optional Claude re-review
5. Repeat up to `maxIterations`
6. Return `{ passed, iterations, issues[], costUsd }`

Claude review uses a minimal system prompt: "Review this diff for obvious bugs, security issues, or logic errors. Return JSON `{ issues: string[] }` or `{ issues: [] }` if clean."

**Verify:** `npm run build`

---

### Milestone 6: Sequential milestone execution in worker

**Intent:** Modify the worker to execute milestones sequentially with review-fix between each.

**Files:**
- `src/execution/worker.ts` (modify)
- `prompts/flow.md` (modify)

**Details:**

**worker.ts:**

New imports: `ArchitectBlueprint` from `../enrichers/architect.js`, `reviewFix` from `./milestone-review.js`, `execFile` from `child_process`, `promisify` from `util`.

New `commitMilestone(worktreePath, title, taskId)`: `git add -A && git commit`, silent on nothing-to-commit.

New `executeMilestones(task, worktreePath, blueprint, model, learningsStr)`:
```
for each milestone:
  1. Build milestone-scoped prompt:
     - blueprint.approach (overall strategy)
     - milestone title/description/filesToModify/acceptanceCriteria
     - accumulated prior milestone summaries
     - learnings string
     - working directory
  2. System prompt = flow.md + "You are executing milestone N of M. Focus only on this scope."
  3. callClaude() → implementation
  4. reviewFix() → verify + fix loop
  5. commitMilestone()
  6. Accumulate summary for next milestone
return { results[], totalCostUsd }
```

Modify `executeTask()` (around lines 97-131):
```typescript
const architectData = (task.enrichment as any)?.architect as ArchitectBlueprint | undefined;
const hasMilestones = architectData?.milestones && architectData.milestones.length > 0;

if (hasMilestones) {
  const { totalCostUsd } = await executeMilestones(...);
  implCostUsd = totalCostUsd;
} else {
  // existing single-call path unchanged
}
```

Everything after (review gate, rework, PR creation) unchanged. Rework = single `callClaude()` with retryInstructions.

**flow.md** — Append milestone mode section:
```markdown
## Milestone Mode
When you receive a milestone-scoped prompt (indicated by "Current Milestone"):
1. Focus exclusively on this milestone's scope
2. Only modify listed files unless absolutely necessary
3. Previous milestones already committed — build on their changes
4. Ensure changes satisfy the milestone's acceptance criteria
```

**Verify:** `npm run build`

---

### Milestone 7: Enricher tests

**Intent:** Unit tests for both new enrichers.

**Files:**
- `tests/enrichers/architect.test.ts` (create)
- `tests/enrichers/scorer.test.ts` (create)

**Details:**

Mock pattern: `callClaude`, `loadPrompt`, `getAutonomousConfig`, `logger` (same as existing enricher tests).

**architect.test.ts:**
- Name is `"architect"`
- Trivial skipped without Claude call
- Small → plan with keyFiles/checklist, no milestones
- Medium → milestones array
- Returns clarification questions when Claude says task is ambiguous
- Phase 2: produces blueprint when answers are present in priorResults
- Parse failure → raw text fallback
- Uses `config.model` when provided
- Defaults to "medium" when size is null

**scorer.test.ts:**
- Name is `"scorer"`
- Scores task with blueprint data
- Missing architect → heuristic fallback (no Claude call)
- Clamps scores to 1-10
- Cost estimate has breakdown
- Parse failure → mid-range defaults
- Valid recommendation enum

**Verify:** `npm test -- tests/enrichers/architect.test.ts tests/enrichers/scorer.test.ts`

---

### Milestone 8: Milestone execution + review-fix tests

**Intent:** Tests for the review-fix loop and milestone execution integration.

**Files:**
- `tests/execution/milestone-review.test.ts` (create)

**Details:**

Mock `child_process.execFile` and `callClaude`.

- `quickVerify` passes when all scripts succeed
- `quickVerify` returns failures with captured output
- `quickVerify` handles missing scripts (--if-present)
- `reviewFix` passes on first try when clean
- `reviewFix` calls Claude fix + re-verifies on failure
- `reviewFix` stops after maxIterations
- `reviewFix` includes Claude code review when shell passes

**Verify:** `npm test -- tests/execution/milestone-review.test.ts` then full `npm test`

---

## Risks & Unknowns

| Risk | Impact | Mitigation |
|------|--------|------------|
| Architect produces bad JSON | Garbage blueprint | `parseBlueprint()` fallback to raw text; worker checks `milestones?.length > 0` |
| Token budget blow-up | Exceeds $25/task | `recordCost()` tracks everything; follow-up: budget check in milestone loop |
| `npm run --if-present` unavailable | quickVerify breaks | Check npm version; fallback: read package.json scripts before running |
| AI auto-answers are low quality | Bad blueprints | AI answers use full enrichment context; human mode is the default |
| `ready → enriching` transition breaks existing flows | State machine confusion | Only triggered when `clarificationAnswers` are submitted; existing `ready → approved` path untouched |
