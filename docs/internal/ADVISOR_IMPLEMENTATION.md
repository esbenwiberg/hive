# Advisor Agent Implementation

> **Implementation Summary** — Detailed guide to the Advisor agent integration in The Hive pipeline.

## Files Created/Modified

### Core Implementation

1. **`src/agents/types.ts`** (NEW)
   - Unified type definitions for advisor
   - `AdvisorVerdict` type: `'approve' | 'caution' | 'rework'`
   - `AdvisorVerdictResponse` interface with all verdict fields

2. **`src/agents/advisor.ts`** (NEW — COMPLETE FILE)
   - Main advisor agent implementation
   - `runAdvisor(input: AdvisorInput)` async function
   - Input: enriched task data + task metadata
   - Output: `AdvisorVerdictResponse` with verdict, scores, confidence, recommendations
   - **MANDATORY ESCALATION RULE**: `confidenceScore < 0.5` forces `escalate = true`
   - **FALLBACK VERDICT**: On LLM error or validation failure, returns safe escalation verdict
   - **Graceful Degradation**: Missing product-context.md or architecture docs → logs warning, continues with empty context

3. **`src/agents/gate.ts`** (UPDATED — COMPLETE FILE)
   - Integrated advisor verdict evaluation
   - **CRITICAL OVERRIDE**: If `advisorVerdict?.escalate === true`, gate forces human review (FIRST check)
   - Advisor assessment section included in gate LLM prompt
   - Advisor verdicts influence gate decision reasoning

4. **`src/agents/gate-analyst.ts`** (UPDATED)
   - Added comprehensive JSDoc comment explaining role
   - Gate-analyst does NOT interact with advisor (independent agents)
   - Gate-analyst runs FIRE-AND-FORGET after gate decisions
   - Can consume advisor verdicts from rejected tasks for pattern analysis

5. **`src/agents/cost-utils.ts`** (EXISTING)
   - No changes — advisor uses existing cost-tracking infrastructure
   - `estimateCostUsd()` supports cache creation and cache read tokens

6. **`src/agents/pipeline.ts`** (EXISTING — ALREADY INTEGRATED)
   - Already calls `runAdvisor()` after enrichers, before gate
   - Stores advisor verdict in `enrichment.advisor`
   - Pipeline stage: "ADVISING" (between enrichment and gate)
   - Graceful error handling: advisor failure does not halt pipeline

### Prompts & Knowledge Base

7. **`prompts/enrichers/advisor.md`** (NEW — COMPLETE PROMPT)
   - System prompt for advisor LLM
   - Defines evaluation dimensions: product alignment, architectural fit, scope clarity, feasibility, risk
   - Verdict meanings and escalation rules
   - Output JSON schema with field validation rules
   - Red flag checklist (anti-patterns)
   - Example evaluations

8. **`docs/internal/product-context.md`** (NEW — COMPLETE CONTEXT DOCUMENT)
   - "Deep knowledge" substitute for advisor (no embeddings yet)
   - Describes The Hive's purpose, target users, key workflows
   - Core architectural principles (graceful degradation, agent patterns, enricher patterns, state machine, etc.)
   - Naming conventions, code patterns, file organization
   - Anti-patterns & red flags for advisor evaluation
   - Known constraints & workarounds

### Tests

9. **`src/agents/__tests__/advisor.test.ts`** (NEW — COMPLETE TEST SUITE)
   - 13+ test cases covering:
     - Mandatory escalation rule (confidenceScore < 0.5 → escalate = true)
     - Validation failure (returns FALLBACK_VERDICT)
     - Verdict enum validation (reject invalid verdicts)
     - Dimension score validation (reject out-of-range values)
     - Input sanitization
     - Missing product-context.md (graceful degradation)
     - Missing architecture.md
     - LLM parse error
     - Happy path (valid response)
     - Enrichment data threading
     - LLM call failure
     - Different verdict values (approve, caution, rework)
   - Mocks: fs, sdk, domain/autonomous-config, prompt-cache

10. **`src/agents/__tests__/gate.test.ts`** (NEW — COMPLETE TEST SUITE)
    - Test advisor escalation override
    - Test auto-approve logic with advisor escalation
    - Test missing advisor verdict (graceful handling)
    - Test AI gate logic with advisor verdict
    - Test 'caution' verdict handling
    - Test advisor score in gate reasoning
    - Mocks: logger, sdk, db, active-agents, costs, gate-decisions, domain-config, prompt-cache

11. **`src/agents/__tests__/pipeline.test.ts`** (EXISTING — ALREADY HAS ADVISOR TESTS)
    - Already tests advisor integration in pipeline
    - Tests advisor failure graceful degradation
    - Tests escalation flag propagation to gate

---

## Integration Flow

### Pipeline Sequence

```
Task received
    ↓
Router (enrichers/router)
    ↓
All enrichers in parallel (codebase, dependencies, architect, scorer, etc.)
    ↓
╔════════════════════════════════════════════╗
║ ADVISOR STAGE (NEW)                        ║
║ - Load product-context.md + architecture   ║
║ - Evaluate across 5 dimensions             ║
║ - Return verdict with confidence score     ║
║ - Store in enrichment.advisor              ║
║ - Graceful degradation on failure          ║
╚════════════════════════════════════════════╝
    ↓
╔════════════════════════════════════════════╗
║ GATE STAGE (UPDATED)                       ║
║ - Extract advisorVerdict from enrichment   ║
║ - IF escalate=true → human review (STOP)   ║
║ - ELSE apply gate logic (human/ai/auto)    ║
║ - Include advisor assessment in prompt     ║
║ - Record decision & transition status      ║
╚════════════════════════════════════════════╝
    ↓
Human review (if ready) or auto-approval
    ↓
Execution → Preview → Review → Merge
```

### Data Flow

```
enrichment object (from enrichers)
  ├── router: { type, size, ... }
  ├── codebase: { files, languages, ... }
  ├── architect: { patterns, abstractions, ... }
  ├── scorer: { risk, complexity, ... }
  └── advisor: {  ← NEW
        verdict: 'approve' | 'caution' | 'rework',
        confidenceScore: 0.0–1.0,
        escalate: boolean,
        dimensions: { ... },
        reasoning: string,
        recommendations: []
      }

Task record
  └── gateVerdict: 'approve' | 'reject' | 'rework'  ← recorded after gate
```

---

## Key Design Decisions

### 1. Mandatory Escalation Rule
```typescript
// If confidenceScore < 0.5, force escalate = true (NO EXCEPTIONS)
if (result.confidenceScore < 0.5) {
  result.escalate = true;
}
```

This is enforced in `validateAdvisorResponse()` AFTER LLM parsing. Even if LLM returns `escalate: false` with low confidence, the advisor overrides it. This prevents silent failures and ensures low-confidence assessments get human review.

### 2. Fail-Closed Validation
All LLM response validation is fail-closed: invalid input → FALLBACK_VERDICT with `escalate: true`. This ensures:
- Malformed JSON → escalate
- Invalid verdict value → escalate
- Out-of-range scores → escalate
- Missing required fields → escalate

Safe default: when in doubt, escalate to human.

### 3. Graceful Degradation
Advisor failure never halts the pipeline. If:
- Product-context.md missing → use empty string, continue
- Architecture docs missing → use empty string, continue
- LLM call fails → return FALLBACK_VERDICT, continue
- JSON parse error → return FALLBACK_VERDICT, continue

Gate receives either valid advisor verdict or safe escalation verdict. Pipeline always progresses.

### 4. Critical Override in Gate
Gate's FIRST check (before any approval logic) is:
```typescript
if (advisorVerdict?.escalate === true) {
  mode = "human";  // Force human review
}
```

This ensures:
- Advisor escalation overrides gate mode (human/ai/auto)
- No task with `escalate=true` bypasses human review
- Advisor's risk assessment cannot be overridden by gate config

### 5. Fire-and-Forget Pattern Analysis
Gate-analyst runs AFTER gate decision is recorded:
```typescript
void analyzeGatePatterns(...).catch((err) => {
  logger.error(..., "non-blocking");
});
```

This ensures:
- Pattern analysis never blocks gate decision
- Failures in analysis don't affect task progression
- Learning is decoupled from gating logic

---

## Prompt Engineering Details

### Product-Context Document
The advisor loads two static documents for "deep knowledge":

1. **`docs/internal/product-context.md`** (NEW)
   - What The Hive is, who uses it, why it exists
   - Key workflows and user journeys
   - Core architectural principles (graceful degradation, agent patterns, etc.)
   - Naming conventions, code organization
   - Anti-patterns & red flags
   - Constraints & workarounds

2. **`docs/internal/architecture.md` + module docs** (EXISTING)
   - System overview, module descriptions
   - Design patterns, abstractions
   - Naming conventions, code examples

These documents are loaded into the advisor LLM prompt as context. This is a pragmatic workaround for "no codebase embeddings yet" — we're encoding deep knowledge in static documents that the advisor can reference.

### Advisor Prompt Structure
The advisor prompt (`prompts/enrichers/advisor.md`) includes:

1. **Role Definition**: "Evaluate task alignment with product goals and architecture"
2. **Evaluation Dimensions**: 5 dimensions scored 0.0–1.0 each
3. **Verdict Meanings**: What 'approve', 'caution', 'rework' mean
4. **Confidence Score**: How to assess certainty
5. **Escalation Rule**: confidenceScore < 0.5 always escalates
6. **Output Schema**: Exact JSON structure, field validation rules
7. **Input Context**: Task description, enrichment data, repo knowledge
8. **Decision Logic**: Step-by-step evaluation process
9. **Red Flag Checklist**: Anti-patterns that warrant escalation
10. **Examples**: Real evaluations (good, caution, rework)

---

## Advisor Input

The advisor receives:

```typescript
interface AdvisorInput {
  taskId: string;
  title: string;
  description: string;
  routerClassification?: Record<string, unknown>;
  codebaseContext?: Record<string, unknown>;
  architectBlueprint?: Record<string, unknown>;
  scorerOutput?: Record<string, unknown>;
  extraEnrichment?: Record<string, unknown>;
}
```

This includes all enrichment data gathered so far plus task metadata. The advisor evaluates the task in context of the repo's architecture, dependencies, and recent changes.

---

## Advisor Output

The advisor returns:

```typescript
interface AdvisorVerdictResponse {
  verdict: 'approve' | 'caution' | 'rework';
  confidenceScore: number; // [0.0, 1.0]
  escalate: boolean;
  dimensions: Record<string, number>; // All [0.0, 1.0]
  reasoning: string; // Max 5000 chars
  recommendations: string[]; // Each < 1000 chars
}
```

Example verdict:
```json
{
  "verdict": "approve",
  "confidenceScore": 0.92,
  "escalate": false,
  "dimensions": {
    "productAlignment": 0.95,
    "architecturalFit": 0.89,
    "scopeClarity": 0.93,
    "implementationFeasibility": 0.94,
    "riskAssessment": 0.92
  },
  "reasoning": "Task adds error handling to executor retry loop — well-scoped, uses existing patterns, improves reliability.",
  "recommendations": ["Ensure exponential backoff respects concurrency limits", "Add cost tracking for retry tokens"]
}
```

---

## Gate Integration

Gate receives advisor verdict via enrichment:
```typescript
const advisorVerdict = enrichment.advisor as AdvisorVerdictResponse | undefined;
```

Then:
1. **First check**: If `escalate === true`, force human review (STOP)
2. **Else**: Apply gate logic (human/ai/auto mode)
3. **Include in prompt**: Advisor assessment section shows verdict, scores, reasoning
4. **Record decision**: Gate decision is recorded with advisor context

Example gate prompt section with advisor:
```
## Advisor Assessment
Verdict: approve
Overall Score: 0.92
Reasoning: Task adds error handling to executor retry loop...
Escalate: false
Recommendations: Ensure exponential backoff respects concurrency limits; Add cost tracking for retry tokens
```

---

## Cost Tracking

Advisor uses existing cost-utils infrastructure:
```typescript
const costUsd = estimateCostUsd(
  inputTokens,
  outputTokens,
  undefined,         // inputCostPerM (optional, uses config)
  undefined,         // outputCostPerM (optional, uses config)
  cacheCreationTokens,
  cacheReadTokens,
);

logger.info({
  taskId,
  model,
  inputTokens,
  outputTokens,
  cacheCreationTokens,
  cacheReadTokens,
  costUsd,
}, "Advisor: LLM call complete");
```

Token usage is logged for cost visibility. Cache hit/miss tracking helps optimize advisor costs over time.

---

## Escalation Behavior

Advisor escalates (sets `escalate: true`) when:

1. **Mandatory**: `confidenceScore < 0.5` (always, no exceptions)
2. **Red flags**: Task modifies auth, secrets, core reliability
3. **Vagueness**: Task description is unclear, lacks acceptance criteria
4. **Conflicts**: Task conflicts with recent PRs or architectural decisions
5. **Anti-patterns**: Task introduces hardcoded values, removes tests, etc.

Gate respects escalation by forcing human review:
```typescript
if (advisorVerdict?.escalate === true) {
  mode = "human"; // Force human review
  await updateStatus(taskId, "ready");
  return;
}
```

No task with `escalate=true` can bypass human review.

---

## Testing Strategy

### Unit Tests (advisor.test.ts)
- Mandatory escalation rule
- Validation failures
- Verdict enum validation
- Dimension score validation
- Input sanitization
- Missing docs (graceful degradation)
- LLM parse errors
- Happy path
- Enrichment data threading
- LLM call failures
- Different verdict values

### Unit Tests (gate.test.ts)
- Advisor escalation override
- Auto-approve with escalation
- Missing advisor verdict
- AI gate logic
- 'caution' verdict handling
- Advisor score in reasoning

### Integration Tests (pipeline.test.ts)
- Advisor runs after enrichers
- Advisor failure doesn't halt pipeline
- Escalation flag reaches gate
- Advisor verdict stored in enrichment
- Gate respects escalation

### Mocking Strategy
- Mock `fs` for product-context and architecture doc reads
- Mock `callClaude` for LLM responses
- Mock `getModelFor` for model selection
- Mock `loadPrompt` for prompt loading
- Mock database operations in gate tests

---

## Deployment Considerations

1. **File Permissions**: `docs/internal/product-context.md` and architecture docs should be read-only for this service (document in infrastructure setup)
2. **Prompt Caching**: Advisor uses prompt caching (product-context, architecture docs are large and static) — configure cache TTL in Anthropic API settings
3. **Rate Limiting**: Advisor's LLM calls count toward team's rate limits — monitor in dashboard cost view
4. **Monitoring**: Track advisor metrics:
   - Percentage of verdicts per type (approve/caution/rework)
   - Confidence score distribution
   - Escalation rate
   - Gate override rate (gate rejecting advisor's 'approve')
5. **Tuning**: After initial launch, monitor advisor calibration:
   - Are escalated tasks actually risky?
   - Are approved tasks passing review?
   - Are 'caution' verdicts justified?
   - Adjust prompt or product-context based on feedback

---

## Future Improvements

1. **Codebase Embeddings**: Once available, replace static product-context with semantic search over codebase
2. **Feedback Loop**: Track which advisor verdicts result in successful/failed executions; fine-tune prompt
3. **Learning**: Persist learnings from gate patterns into product-context or advisor knowledge base
4. **Custom Rules**: Allow teams to inject custom evaluation rules (e.g., "no changes to payment logic without architect review")
5. **Multi-Model**: Use different models for advisor (Opus for complex, Sonnet for routine)

---

## References

- `docs/internal/product-context.md` — Product knowledge for advisor
- `prompts/enrichers/advisor.md` — Advisor system prompt
- `src/agents/advisor.ts` — Implementation
- `src/agents/gate.ts` — Gate integration
- `src/agents/__tests__/advisor.test.ts` — Unit tests
- `docs/internal/architecture.md` — System overview
