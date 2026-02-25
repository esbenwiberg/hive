# Advisor Agent — Deployment & Verification Checklist

> **Deployment guide** for integrating the Advisor agent into The Hive pipeline.

## Pre-Deployment Checklist

- [ ] All files created and committed (see Files Created/Modified in ADVISOR_IMPLEMENTATION.md)
- [ ] Tests pass: `npm test -- src/agents/__tests__/advisor.test.ts`
- [ ] Tests pass: `npm test -- src/agents/__tests__/gate.test.ts`
- [ ] Tests pass: `npm test -- src/agents/__tests__/pipeline.test.ts`
- [ ] Type checks pass: `npm run typecheck`
- [ ] Code builds: `npm run build`
- [ ] No regressions in existing tests
- [ ] Prompts are valid Markdown (syntax check)
- [ ] Product-context.md is comprehensive (reviewed by architect/PM)

## Runtime Verification

After deployment, verify:

1. **File Loading**
   - [ ] `docs/internal/product-context.md` is readable by Hive service
   - [ ] `docs/internal/architecture.md` is readable by Hive service
   - [ ] `prompts/enrichers/advisor.md` is readable by Hive service
   - Check logs: `"Advisor: starting evaluation"` appears for each task

2. **Advisor Execution**
   - [ ] Advisor runs after enrichment, before gate
   - [ ] Advisor LLM calls complete within timeout (default ~60s)
   - [ ] Token usage is logged (`inputTokens`, `outputTokens`, `costUsd`)
   - [ ] Verdict is stored in task enrichment: `enrichment.advisor`

3. **Verdict Validation**
   - [ ] Advisor returns one of: `'approve'`, `'caution'`, `'rework'`
   - [ ] `confidenceScore` is a number in [0.0, 1.0]
   - [ ] `escalate` is a boolean
   - [ ] `dimensions` object has numeric values [0.0, 1.0]
   - [ ] `reasoning` is a string (max 5000 chars)
   - [ ] `recommendations` is an array of strings (each < 1000 chars)

4. **Escalation Behavior**
   - [ ] If `confidenceScore < 0.5`, advisor sets `escalate = true`
   - [ ] If LLM call fails, advisor returns FALLBACK_VERDICT with `escalate = true`
   - [ ] If JSON parsing fails, advisor returns FALLBACK_VERDICT with `escalate = true`
   - [ ] If product-context.md is missing, advisor logs warning and continues

5. **Gate Integration**
   - [ ] Gate receives advisor verdict via `enrichment.advisor`
   - [ ] If `advisorVerdict.escalate === true`, gate forces human review
   - [ ] Advisor escalation overrides gate mode (human/ai/auto)
   - [ ] Gate prompt includes "## Advisor Assessment" section
   - [ ] `gateVerdict` is recorded in task database

6. **Dashboard Display**
   - [ ] Task detail view shows advisor verdict badge (approve/caution/rework)
   - [ ] Advisor score (confidenceScore) is displayed
   - [ ] Advisor reasoning and recommendations are visible in collapsible section
   - [ ] Escalation warning is shown if `escalate === true`
   - [ ] Tasks without advisor verdict (pre-feature or failure) don't show error

7. **Cost Tracking**
   - [ ] Advisor costs are recorded in `costs` table
   - [ ] Dashboard shows advisor token usage and USD cost
   - [ ] Cost aggregation includes advisor: `sum(cost_usd) where agent='advisor'`
   - [ ] Cost per task breakdown includes advisor

8. **Logging**
   - [ ] `"Advisor: starting evaluation"` for each task
   - [ ] `"Advisor: evaluation complete"` with verdict and confidence
   - [ ] `"Advisor: LLM call failed — returning fallback escalation verdict"` on error
   - [ ] `"Gate: advisor flagged escalation — forcing human approval mode"` when escalating
   - [ ] Search logs for `advisor` — no errors or warnings (except graceful degradation)

## Verification Queries (Database)

```sql
-- Count advisor evaluations
SELECT COUNT(*) FROM task_events WHERE event_type = 'advisor' AND DATE(created_at) >= NOW() - INTERVAL 1 DAY;

-- Check escalation rate
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN (metadata->>'escalate')::boolean THEN 1 ELSE 0 END) as escalated
FROM task_events 
WHERE event_type = 'advisor' AND DATE(created_at) >= NOW() - INTERVAL 1 DAY;

-- Check verdict distribution
SELECT 
  metadata->>'verdict' as verdict,
  COUNT(*) as count
FROM task_events
WHERE event_type = 'advisor' AND DATE(created_at) >= NOW() - INTERVAL 1 DAY
GROUP BY metadata->>'verdict';

-- Check confidence score distribution
SELECT 
  (metadata->>'confidenceScore')::float,
  COUNT(*) 
FROM task_events
WHERE event_type = 'advisor' AND DATE(created_at) >= NOW() - INTERVAL 1 DAY
GROUP BY (metadata->>'confidenceScore')::float
ORDER BY (metadata->>'confidenceScore')::float;

-- Verify advisor cost tracking
SELECT 
  COUNT(*) as evaluations,
  SUM(cost_usd) as total_cost,
  AVG(cost_usd) as avg_cost
FROM costs
WHERE agent = 'advisor' AND DATE(created_at) >= NOW() - INTERVAL 1 DAY;

-- Check gate escalation due to advisor
SELECT 
  COUNT(*) as total_gates,
  SUM(CASE WHEN reason LIKE '%advisor%escalation%' THEN 1 ELSE 0 END) as advisor_escalations
FROM gate_decisions
WHERE DATE(created_at) >= NOW() - INTERVAL 1 DAY;
```

## Rollback Plan

If issues arise, rollback steps:

1. **Disable Advisor (Non-Breaking)**
   ```typescript
   // In pipeline.ts, comment out or skip advisor call:
   // const advisorVerdict = await runAdvisor(...);
   // enrichment.advisor = advisorVerdict;
   
   // Gate will gracefully handle undefined advisor
   if (advisorVerdict?.escalate === true) { ... }
   ```

2. **Revert to Previous Gate Logic**
   - Gate continues to function; advisor is optional
   - Existing tasks in "ready" status are unaffected

3. **Check Gate Decision Rate**
   - Monitor dashboard: Are tasks being approved/rejected at normal rate?
   - If gate gets stuck, check logs for advisor errors

4. **No Data Loss**
   - All task data, enrichment, gate decisions are preserved
   - Advisor verdicts in task_events can be archived or deleted per retention policy

## Post-Deployment Tuning

### Week 1: Initial Calibration
- Monitor advisor accuracy: Are 'approve' verdicts passing gate/review?
- Check escalation rate: Is it 20–30% (reasonable) or >50% (over-cautious)?
- Review 'caution' verdicts: Are they justified or too broad?
- Gather feedback from team: Any surprises in advisor assessments?

### Adjustments
If escalation rate is too high (>50%):
- Review product-context.md: Are anti-patterns too broad?
- Adjust advisor prompt: Tone down risk assessment thresholds
- Example: Change "Low (<0.5)" in risk assessment to require explicit safety violations, not assumptions

If 'approve' verdicts are being rejected by gate/review:
- Review dimension scoring: Are some dimensions weighted too high?
- Check enrichment data: Is advisor receiving complete context?
- Gather examples of mis-calibrated verdicts; use to refine prompt

If advisor is timing out:
- Check product-context.md size: Is it too large?
- Consider splitting into separate context files by topic
- Verify LLM model speed (Opus vs. Sonnet)

### Feedback Loop (Future)
Once launch stabilizes, implement:
- Correlation analysis: Which advisor verdicts → successful execution?
- Feedback scoring: Did gate/review agree with advisor?
- Model fine-tuning: Use data to improve prompt calibration

## Monitoring Dashboard

Add these panels to Hive dashboard:

1. **Advisor Verdict Distribution**
   - Pie chart: approve/caution/rework split
   - Trend over time: Are verdicts stabilizing?

2. **Confidence Score Distribution**
   - Histogram: [0.0–0.2], [0.2–0.4], [0.4–0.6], [0.6–0.8], [0.8–1.0]
   - Alert if >20% tasks < 0.5 confidence (over-cautious)

3. **Escalation Rate**
   - % of advisor verdicts with escalate=true
   - Trend over time

4. **Gate Alignment**
   - % of 'approve' verdicts that gate approved
   - % of 'caution' verdicts that gate approved
   - % of 'rework' verdicts that gate approved

5. **Cost per Task**
   - Advisor cost breakdown (input, output, cache)
   - Comparison: Advisor cost vs. execution cost (is advisor worth it?)

6. **Time to Evaluation**
   - Advisor latency (p50, p95, p99)
   - Gate latency (p50, p95, p99)
   - Alert if advisor > 60 seconds

## Known Limitations & Workarounds

1. **No Codebase Embeddings Yet**
   - Workaround: Advisor uses static product-context.md + architecture docs
   - Future: Replace with vector search over codebase

2. **Advisor Knowledge Decay**
   - Workaround: Update product-context.md when architecture changes
   - Schedule: Quarterly review + ad-hoc updates
   - Responsibility: Assigned architect

3. **LLM Prompt Optimization**
   - Monitor advisor verdicts vs. actual outcomes
   - Periodically refine `prompts/enrichers/advisor.md`
   - Test changes in staging before production

4. **Rate Limiting**
   - Advisor may hit Anthropic rate limits during peak load
   - Workaround: Use prompt caching (large static docs cached)
   - Monitor: Dashboard cost panel alerts on rate-limit errors

## Troubleshooting

### Advisor Times Out
- Check logs: `"Advisor: LLM call failed"`
- Possible causes: Large enrichment data, slow LLM, network issues
- Fix: Increase timeout (default 60s), reduce context size, retry

### Advisor Always Escalates
- Check: Is `confidenceScore < 0.5` consistently?
- Review product-context.md: Is it too strict?
- Check enrichment data: Are enrichers providing adequate context?
- Solution: Refine prompt or product-context

### Advisor Verdicts Don't Match Gate Decisions
- Example: Advisor says 'approve', gate says 'reject'
- Likely cause: Gate is applying additional constraints (size, type, mode)
- Review: Gate decision logic + advisor role expectations
- Note: This is expected; advisor is advisory, not dictatorial

### Gate Not Respecting Escalation
- Check logs: `"Gate: advisor flagged escalation"`
- Verify: Gate code has `if (advisorVerdict?.escalate === true) { mode = "human"; }`
- Test: Create task with low confidence, verify it goes to "ready" status

### Product-Context Not Loaded
- Check logs: `"Advisor: starting evaluation"` but no context mention
- Verify: File exists at `docs/internal/product-context.md`
- Verify: File is readable by service (check file permissions)
- Check logs: No warnings about missing file?

## Support & Escalation

For issues:
1. Check logs for advisor/gate errors
2. Review this troubleshooting guide
3. Verify file permissions and paths
4. Check database for verdict records
5. Escalate to architect if advisor calibration is off

---

## References

- ADVISOR_IMPLEMENTATION.md — Detailed technical guide
- docs/internal/product-context.md — Advisor knowledge base
- prompts/enrichers/advisor.md — Advisor system prompt
- src/agents/advisor.ts — Implementation source
- src/agents/gate.ts — Gate integration source
