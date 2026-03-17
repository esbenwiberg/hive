# Hivemind Trust & Quality Plan

> **Goal:** Reduce noise, increase signal, and build trust in the hivemind knowledge base.
>
> **Context:** As of 2026-03-17, the hivemind has 1,714 learnings — 71% of which have never been used. ~18 new learnings are created daily across 4 autonomous agents, but only 13% of active learnings get used within 30 days. The system is growing fast but trust is eroding because tasks get injected with low-quality, irrelevant, or untested learnings alongside genuinely useful ones.

---

## Diagnosis

| Metric | Current Value | Problem |
|--------|---------------|---------|
| Total Learnings | 1,714 | Growing ~18/day |
| Never Used | 1,213 (71%) | Massive noise — most learnings never match a task |
| Created (30d) | 533 | Too aggressive — 4 agents creating independently |
| Used (30d) | 231 | Only 13% of active learnings see any use |
| Contradicted (30d) | 183 | Signal that many learnings aren't helpful |
| Dismissed (30d) | 0 | No manual curation happening |
| Avg Confidence | 79% | Misleadingly high — inflated by cheap reinforcement |

### Root Causes

1. **No confidence floor on retrieval** — `retrieveRelevantLearnings()` returns all active learnings with tag overlap, regardless of confidence. A 0.15 learning competes with a 0.95 one.
2. **Tag matching is too coarse** — PostgreSQL `&&` array overlap is binary: match or don't. No specificity scoring, no semantic relevance.
3. **Too many creation sources, too few guardrails** — Feedback loop creates up to 3 learnings/task. Code quality and gate analysts add more. Retrospective adds batch proposals weekly.
4. **Initial confidence is too generous** — New learnings start at 0.50, immediately competing with battle-tested ones for injection slots.
5. **Reinforcement is too cheap** — +0.05/pass means 10 passes = max confidence. But "plausibly contributed" is a loose bar — free-rider learnings accumulate credit.
6. **Keeper runs too infrequently** — Monthly curation can't keep up with 500+ learnings/month creation rate.

---

## Implementation Plan

### Phase 1: Tighten the Gates (Quick Wins)

#### 1.1 Add confidence floor to retrieval
- **File:** `src/db/queries/learnings.ts` → `retrieveRelevantLearnings()`
- **Change:** Add `AND confidence >= 0.40` to the WHERE clause
- **Effect:** Immediately stops low-confidence noise from being injected into tasks
- **Effort:** Small

#### 1.2 Lower initial confidence for new learnings
- **Files:** `src/agents/feedback-loop.ts`, `src/agents/retrospective.ts`, `src/agents/code-quality-analyst.ts`, `src/agents/gate-analyst.ts`, `prompts/feedback-loop.md`, `prompts/retrospective.md`
- **Change:** Drop default initial confidence from 0.50 to 0.30
- **Effect:** Creates a "probation period" — new learnings need 2+ reinforcements before they cross the 0.40 retrieval threshold
- **Effort:** Small

#### 1.3 Cap feedback loop at 1 new learning per task
- **Files:** `prompts/feedback-loop.md`, `src/agents/feedback-loop.ts`
- **Change:** Reduce `newLearnings` max from 3 to 1. Tighten prompt: "Only create a learning if the insight is novel, specific, and not already covered by existing learnings."
- **Effect:** Cuts the biggest creation source by ~66%
- **Effort:** Small

#### 1.4 Bulk archive never-used learnings
- **File:** `src/db/queries/learnings.ts`
- **Change:** Add `archiveNeverUsed(minAgeDays: number)` function that archives learnings where `lastUsedAt IS NULL AND createdAt < now() - minAgeDays` (default 30 days)
- **Effect:** One-time cleanup of ~1,200 learnings + ongoing prevention
- **Effort:** Small

#### 1.5 Run keeper weekly instead of monthly
- **File:** `src/daemon/daemon.ts`
- **Change:** Reduce `DECAY_MIN_GAP_MS` from 30 days to 7 days
- **Effect:** Dedup and stale detection runs 4x more often
- **Consideration:** Decay multiplier should adjust (0.95^4 ≈ 0.81/month is more aggressive than 0.95/month). Either keep decay monthly but run curation weekly, or adjust the multiplier to `0.987` per week (≈0.95/month).
- **Effort:** Small

#### 1.6 Reduce injection limit
- **Files:** `src/execution/worker.ts`, `src/enrichers/architect.ts`
- **Change:** Reduce worker limit from 15 to 8, architect from 10 to 6
- **Effect:** Less context noise, only top-ranked learnings make the cut
- **Effort:** Small

---

### Phase 2: Smarter Ranking & Reinforcement

#### 2.1 Tighten reinforcement criteria in feedback loop prompt
- **Files:** `prompts/feedback-loop.md`
- **Change:** Replace "plausibly contributed" with "demonstrably applied — the agent's output shows clear evidence of following this learning." Add: "Do NOT reinforce learnings that were merely present but not visibly applied."
- **Effect:** Reduces free-rider reinforcement inflation
- **Effort:** Medium

#### 2.2 Add tag specificity scoring
- **File:** `src/db/queries/learnings.ts` → `retrieveRelevantLearnings()`
- **Change:** Instead of binary tag overlap, score by number of matching tags. Add a computed `relevance` column:
  ```sql
  array_length(tags & ARRAY[...retrieval_tags], 1) AS tag_matches
  ORDER BY tag_matches DESC, confidence DESC, reinforcements DESC
  ```
- **Effect:** Learnings matching 3/4 tags rank above those matching 1/4
- **Effort:** Medium

#### 2.3 Add effectiveness ratio to ranking
- **File:** `src/db/queries/learnings.ts`
- **Change:** Factor in `reinforcements / (reinforcements + contradictions)` as an effectiveness score. Learnings with high contradictions relative to reinforcements get deprioritized even if confidence is still decent.
- **Effect:** Battle-tested learnings with proven track records float to the top
- **Effort:** Medium

---

### Phase 3: Free-Rider Detection & Advanced Quality

#### 3.1 Track learning application (not just injection)
- **Schema change:** Add `applied` boolean to learning events (or a new `learning_applications` table)
- **Files:** `src/agents/feedback-loop.ts`, `src/db/queries/learning-events.ts`
- **Change:** Feedback loop explicitly reports which learnings were *applied* (evidence in output) vs merely *injected*. Only applied learnings get reinforced.
- **Effect:** Eliminates free-rider inflation entirely
- **Effort:** High

#### 3.2 Recency bias in ranking
- **File:** `src/db/queries/learnings.ts`
- **Change:** Add recency factor to ranking: learnings reinforced recently rank above those with only historical reinforcement. Something like `last_reinforced_at` as a tiebreaker.
- **Effect:** Knowledge base stays fresh — old learnings that haven't been validated recently don't dominate
- **Effort:** Medium

#### 3.3 Category-aware injection limits
- **File:** `src/execution/worker.ts`
- **Change:** Cap learnings per category (e.g., max 2 "style" learnings, max 3 "correctness"). Prevents one noisy category from hogging all injection slots.
- **Effect:** More diverse, balanced learning injection
- **Effort:** Medium

---

## Expected Outcomes

After Phase 1 (quick wins):
- **Active learnings drop** from ~1,351 to ~200-300 (bulk archive + confidence floor)
- **Creation rate drops** from ~18/day to ~5-6/day (1 learning/task cap)
- **Injection quality improves** — only learnings above 0.40 confidence with proven track records
- **Avg confidence becomes meaningful** — no longer inflated by cheap reinforcement on low-quality learnings

After Phase 2 (smarter ranking):
- **Tag specificity** ensures highly relevant learnings beat broadly-tagged ones
- **Effectiveness ratio** means well-tested learnings outrank barely-reinforced ones
- **Tighter reinforcement** stops passive learnings from accumulating unearned confidence

After Phase 3 (advanced quality):
- **Free-rider elimination** — only genuinely applied learnings gain confidence
- **Recency bias** keeps the knowledge base fresh
- **Category balance** ensures diverse, well-rounded guidance per task

---

## Files Touched

| File | Changes |
|------|---------|
| `src/db/queries/learnings.ts` | Confidence floor, tag specificity, effectiveness ratio, archive function |
| `src/execution/worker.ts` | Reduced injection limit (15→8), category caps |
| `src/enrichers/architect.ts` | Reduced injection limit (10→6) |
| `src/agents/feedback-loop.ts` | Lower initial confidence, cap creation |
| `src/agents/retrospective.ts` | Lower initial confidence |
| `src/agents/code-quality-analyst.ts` | Lower initial confidence |
| `src/agents/gate-analyst.ts` | Lower initial confidence |
| `src/daemon/daemon.ts` | Weekly curation schedule |
| `prompts/feedback-loop.md` | Tighter creation/reinforcement criteria |
| `prompts/retrospective.md` | Lower initial confidence range |
| `src/db/queries/learning-events.ts` | Application tracking (Phase 3) |
| `src/db/schema.ts` | Possible schema additions (Phase 3) |
