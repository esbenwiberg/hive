# Hive Workflow - Complete Pipeline

```
╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                    THE HIVE - AUTONOMOUS TASK PIPELINE                             ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝

                                    ┌─────────────────────┐
                                    │    TASK SOURCES      │
                                    └─────────┬───────────┘
                           ┌──────────────────┼──────────────────┐
                           ▼                  ▼                  ▼
                   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
                   │  Dashboard   │  │   Producers   │  │   API / Webhook  │
                   │  (User)      │  │  (Automated)  │  │   (External)     │
                   │              │  │               │  │                  │
                   │ title, body  │  │ logScanner    │  │                  │
                   │ repo, type   │  │ bugHunter     │  │                  │
                   │ size (opt)   │  │ securityScan  │  │                  │
                   └──────┬───────┘  │ featureScout  │  └────────┬─────────┘
                          │          │ docAuditor    │           │
                          │          │ selfMonitor   │           │
                          │          └──────┬────────┘           │
                          └─────────────────┼────────────────────┘
                                            ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ○ PENDING                                                                            Task Created  │
│    Task ID: HIVE-20260219-0001                                                                      │
│    Source: user | producer                                                                           │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              STAGE 1: ROUTING  (Router Agent + Claude)                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Claude classifies the task:                                                                   │ │
│  │                                                                                                │ │
│  │  type ─────► bug | feature | security | refactor | improvement                                 │ │
│  │  size ─────► trivial | small | medium | large                                                  │ │
│  │  workflow ─► flow (single) | epic (milestones)                                                 │ │
│  │  model ────► override model for execution (optional)                                           │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ○ QUEUED                                                                       Classified & Queued │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          STAGE 2: ENRICHMENT PIPELINE  (Sequential Enrichers)                       │
│                                                                                                     │
│  ○ ENRICHING                                                                                        │
│                                                                                                     │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐  ┌──────────┐  │
│  │ 1.CODEBASE │──▶│  2. DOCS   │──▶│ 3.GIT HIST │──▶│  4. DEPS   │──▶│5.ARCHITECT │─▶│ 6.SCORER │  │
│  │            │   │            │   │            │   │            │   │            │  │          │  │
│  │ File tree  │   │ README &   │   │ Last 50    │   │ package    │   │ Claude     │  │ Claude   │  │
│  │ Relevant   │   │ docs       │   │ commits    │   │ deps &     │   │ blueprint  │  │ evaluates│  │
│  │ files by   │   │ extraction │   │ Hotspots   │   │ versions   │   │ generation │  │          │  │
│  │ keyword    │   │            │   │ Active     │   │            │   │            │  │ Scores:  │  │
│  │            │   │            │   │ authors    │   │            │   │ Milestones │  │ value    │  │
│  │            │   │            │   │            │   │            │   │ or checklist│  │ complex. │  │
│  │            │   │            │   │            │   │            │   │ + approach │  │ risk     │  │
│  │            │   │            │   │            │   │            │   │            │  │ feasib.  │  │
│  │            │   │            │   │            │   │            │   │            │  │          │  │
│  │            │   │            │   │            │   │            │   │            │  │ Cost est:│  │
│  │            │   │            │   │            │   │            │   │            │  │ enrichm. │  │
│  │            │   │            │   │            │   │            │   │            │  │ execut.  │  │
│  │            │   │            │   │            │   │            │   │            │  │ review   │  │
│  │            │   │            │   │            │   │            │   │            │  │ (tokens  │  │
│  │            │   │            │   │            │   │            │   │            │  │  → USD)  │  │
│  │            │   │            │   │            │   │            │   │            │  │          │  │
│  │            │   │            │   │            │   │            │   │            │  │ Verdict: │  │
│  │            │   │            │   │            │   │            │   │            │  │ approve/ │  │
│  │            │   │            │   │            │   │            │   │            │  │ reject/  │  │
│  │            │   │            │   │            │   │            │   │            │  │ rework   │  │
│  └────────────┘   └────────────┘   └────────────┘   └────────────┘   └─────┬──────┘  └──────────┘  │
│                                                                            │                        │
│                              ┌─────────────────────────────────────────────┘                        │
│                              ▼                                                                      │
│                 ┌─────────────────────────────────────────────┐                                     │
│                 │  CLARIFICATION CHECK (Architect Phase 2)    │                                     │
│                 │                                             │                                     │
│                 │  Does architect need more info?             │                                     │
│                 │                                             │                                     │
│                 │  ┌─human─────► ○ READY (wait for user)     │                                     │
│                 │  │                  │                       │                                     │
│                 │  │                  ▼ answers submitted     │                                     │
│                 │  │             Re-run architect Phase 2     │                                     │
│                 │  │                                         │                                     │
│                 │  ├─ai────────► Claude auto-answers         │                                     │
│                 │  │             Re-run architect Phase 2     │                                     │
│                 │  │                                         │                                     │
│                 │  └─auto──────► Skip (trivial/small)        │                                     │
│                 │               AI-answer (medium/large)     │                                     │
│                 └─────────────────────────────────────────────┘                                     │
│                                                                                                     │
│  All enrichment results ──► task.enrichment (JSONB)                                                 │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           STAGE 3: ADVISOR EVALUATION  (Advisor Agent)          [optional]          │
│                                                                                                     │
│  ○ ENRICHING (advisor runs before status changes to READY)                                          │
│                                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                                                │ │
│  │  Inputs:                                                                                      │ │
│  │    • Task title + body                                                                        │ │
│  │    • task.enrichment (metadata from enrichers)                                               │ │
│  │    • Prism semantic-search results (if advisor.usePrism: true and index exists)              │ │
│  │                                                                                                │ │
│  │  Evaluates:                                                                                   │ │
│  │    • Fit & Alignment  — does it match the architecture and purpose?                          │ │
│  │    • Design Quality   — well-scoped, unambiguous, idiomatic?                                 │ │
│  │    • Feasibility/Risk — technical risk, security, breaking changes?                          │ │
│  │    • User Impact      — value delivered vs. regression risk?                                 │ │
│  │                                                                                                │ │
│  │  Output — AdvisorReport (saved as task event, visible in dashboard):                         │ │
│  │    ┌──────────────────────────────────────────────────────────────────────────────┐          │ │
│  │    │  recommendation: "approve" | "redesign" | "reject"                          │          │ │
│  │    │  score:          0–100  (overall quality and fit)                            │          │ │
│  │    │  confidence:     0–100  (certainty in recommendation)                       │          │ │
│  │    │  reasoning:      string (concise explanation)                               │          │ │
│  │    │  flags:          string[] (specific positive/negative signals)              │          │ │
│  │    │  escalate:       boolean (true → always route to human review)             │          │ │
│  │    └──────────────────────────────────────────────────────────────────────────────┘          │ │
│  │                                                                                                │ │
│  │  Escalation triggers:                                                                         │ │
│  │    • confidence < advisor.confidenceThreshold (default 50) ──► escalate = true              │ │
│  │    • recommendation = "reject"                              ──► escalate = true              │ │
│  │    • score < 30                                             ──► escalate = true              │ │
│  │    • Security / data-loss risk flags                        ──► escalate = true              │ │
│  │                                                                                                │ │
│  │  When escalate = true → Gate ALWAYS routes to human review                                   │ │
│  │  When advisor.enabled = false → step skipped, pipeline continues unchanged                   │ │
│  │                                                                                                │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                     │
│  Report persisted → task_events (type: "advisor-report") + task.advisorReport (JSONB)               │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           STAGE 4: GATE EVALUATION  (Gate Agent)                                    │
│  [reads advisor.escalate to force human review when true]                                           │
│                                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                                                │ │
│  │  ┌─human────► ○ READY ────────────► Dashboard: User approves/rejects ─┐                       │ │
│  │  │                                                                     │                       │ │
│  │  ├─auto─────► trivial/small? ──yes──► Auto-approve ───────────────────┤                       │ │
│  │  │                       └──no──► fall through to AI                   │                       │ │
│  │  │                                                                     │                       │ │
│  │  └─ai───────► Claude evaluates enrichment ────────────────────────────┤                       │ │
│  │               Checks: value, risk, feasibility, cost estimate          │                       │ │
│  │               Returns: verdict + reasoning + confidence                │                       │ │
│  │                                                                        ▼                       │ │
│  │                                                              ┌─────────────────┐              │ │
│  │                                                              │    VERDICT       │              │ │
│  │                                                              ├─────────────────┤              │ │
│  │                                                              │ ✓ approve ──────┼──► APPROVED  │ │
│  │                                                              │ ✗ reject ───────┼──► REJECTED  │ │
│  │                                                              │ ↻ rework ───────┼──► REWORK    │ │
│  │                                                              └─────────────────┘              │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                     │
│  Gate decision recorded → gate_decisions table (reasoning, confidence, context)                      │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ○ APPROVED                                                                       Ready to Execute  │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                         STAGE 5: EXECUTION  (Worker Agent + Claude)                                 │
│                                                                                                     │
│  ○ EXECUTING                                                                                        │
│                                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  1. SETUP                                                                                    │   │
│  │     ├── Check user budget (daily limit + per-task max)                                       │   │
│  │     ├── Resolve git credentials (Azure Key Vault)                                            │   │
│  │     ├── Clone repo → create worktree                                                         │   │
│  │     ├── Create branch: hive/{taskId}                                                         │   │
│  │     └── Retrieve relevant learnings (universal + repo-scoped)                                │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                           │                                                         │
│                              ┌────────────┴────────────┐                                            │
│                              ▼                         ▼                                            │
│  ┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐                 │
│  │   PATH A: MILESTONES                 │  │   PATH B: SINGLE FLOW                │                 │
│  │   (medium/large with milestones)     │  │   (trivial/small or no milestones)   │                 │
│  │                                      │  │                                      │                 │
│  │  For each milestone:                 │  │  Single Claude call                  │                 │
│  │  ┌────────────────────────────────┐  │  │  to implement full task              │                 │
│  │  │                                │  │  │                                      │                 │
│  │  │  Claude codes milestone        │  │  └──────────────────┬───────────────────┘                 │
│  │  │          │                     │  │                     │                                     │
│  │  │          ▼                     │  │                     ▼                                     │
│  │  │  ┌─────────────────────────┐   │  │  ┌──────────────────────────────────────┐                 │
│  │  │  │  REVIEW-FIX LOOP       │   │  │  │  REVIEW-FIX LOOP                     │                 │
│  │  │  │                        │   │  │  │                                      │                 │
│  │  │  │  ┌──────────────────┐  │   │  │  │  ┌──────────────────┐                │                 │
│  │  │  │  │  Quick Verify    │  │   │  │  │  │  Quick Verify    │                │                 │
│  │  │  │  │  • npm run lint  │  │   │  │  │  │  • npm run lint  │                │                 │
│  │  │  │  │  • npm run build │  │   │  │  │  │  • npm run build │                │                 │
│  │  │  │  │  • npm run test  │  │   │  │  │  │  • npm run test  │                │                 │
│  │  │  │  └────────┬─────────┘  │   │  │  │  └────────┬─────────┘                │                 │
│  │  │  │           │            │   │  │  │           │                           │                 │
│  │  │  │     fail? │   pass?    │   │  │  │     fail? │   pass?                  │                 │
│  │  │  │       ▼   │     │      │   │  │  │       ▼   │     │                    │                 │
│  │  │  │    Claude  │     │     │   │  │  │    Claude  │     │                   │                 │
│  │  │  │    review  │     │     │   │  │  │    review  │     │                   │                 │
│  │  │  │    + fix   │     │     │   │  │  │    + fix   │     │                   │                 │
│  │  │  │       │    │     │     │   │  │  │       │    │     │                   │                 │
│  │  │  │       └────┘     │     │   │  │  │       └────┘     │                   │                 │
│  │  │  │                  ▼     │   │  │  │                  ▼                    │                 │
│  │  │  │            ✓ Pass      │   │  │  │            ✓ Pass                     │                 │
│  │  │  └─────────────────┬──────┘   │  │  └──────────────────┬───────────────────┘                 │
│  │  │                    ▼          │  │                     │                                     │
│  │  │           git commit          │  │                     │                                     │
│  │  │           milestone           │  │                     │                                     │
│  │  └────────────────────────────┘  │  │                     │                                     │
│  │           │                      │  │                     │                                     │
│  │    next milestone?               │  │                     │                                     │
│  │    └─yes─► loop back             │  │                     │                                     │
│  │    └─no──► done                  │  │                     │                                     │
│  └──────────────────┬───────────────┘  │                     │                                     │
│                     └──────────────────┬┘                     │                                     │
│                                        └─────────┬───────────┘                                     │
│                                                   ▼                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  2. FINAL REVIEW GATE                                                                        │   │
│  │     ○ REVIEWING                                                                              │   │
│  │                                                                                              │   │
│  │     ├── git diff (merge-base → HEAD)                                                         │   │
│  │     ├── Claude reviews full changeset:                                                       │   │
│  │     │     • Code quality & correctness                                                       │   │
│  │     │     • Security vulnerabilities                                                         │   │
│  │     │     • Test coverage verification                                                       │   │
│  │     │     • Acceptance criteria check                                                        │   │
│  │     │                                                                                        │   │
│  │     ├── ✓ PASS ─────────────────────────────────────────────────┐                            │   │
│  │     │                                                           ▼                            │   │
│  │     │                                        ┌────────────────────────────────┐               │   │
│  │     │                                        │  git commit & push             │               │   │
│  │     │                                        │  Create PR ───────────► GH/ADO│               │   │
│  │     │                                        │  Start preview (opt) ─► Docker│               │   │
│  │     │                                        └────────────────────────────────┘               │   │
│  │     │                                                                                        │   │
│  │     ├── ↻ REWORK (≤2 cycles) ──► REWORK state ──► re-execute with review feedback           │   │
│  │     │                                                                                        │   │
│  │     └── ✗ FAIL ──────────────────► FAILED state                                              │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ○ DONE                                                                         PR Created & Pushed │
│                                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                                              │   │
│  │  PR: hive/{taskId} → main                        Preview: http://host:4001-4099              │   │
│  │                                                                                              │   │
│  │  ┌─────────────────────────────────────────┐     ┌──────────────────────────────┐            │   │
│  │  │  ## HIVE-20260219-0001                  │     │  ┌────────────────────────┐  │            │   │
│  │  │  Add user authentication                │     │  │   Docker Container     │  │            │   │
│  │  │                                         │     │  │   Running preview      │  │            │   │
│  │  │  ### What & Why                         │     │  │   of branch changes    │  │            │   │
│  │  │  Original task description + context    │     │  │   Port: 4042           │  │            │   │
│  │  │                                         │     │  └────────────────────────┘  │            │   │
│  │  │  ### Approach                           │     │  Cleanup: 30min timeout     │            │   │
│  │  │  Architect's chosen implementation      │     └──────────────────────────────┘            │   │
│  │  │  strategy and key decisions             │                                                 │   │
│  │  │                                         │                                                 │   │
│  │  │  ### Changes                            │                                                 │   │
│  │  │  Per-file summary of what changed       │                                                 │   │
│  │  │  and why (reviewable without code)      │                                                 │   │
│  │  │                                         │                                                 │   │
│  │  │  ### Verification                       │                                                 │   │
│  │  │  • Lint: ✓  Build: ✓  Tests: ✓         │                                                 │   │
│  │  │  • Review-fix iterations: 1             │                                                 │   │
│  │  │  • AI review verdict: PASS              │                                                 │   │
│  │  │                                         │                                                 │   │
│  │  │  ### Scores & Cost                      │                                                 │   │
│  │  │  Value: 8  Complexity: 5  Risk: 3       │                                                 │   │
│  │  │  Est. tokens: ~45k in / ~12k out        │                                                 │   │
│  │  │  Actual cost: $0.23                     │                                                 │   │
│  │  │                                         │                                                 │   │
│  │  │  ### How to Review This PR              │                                                 │   │
│  │  │  1. Read "Approach" to understand the   │                                                 │   │
│  │  │     strategy — do you agree with it?    │                                                 │   │
│  │  │  2. Scan "Changes" for anything that    │                                                 │   │
│  │  │     sounds wrong or risky               │                                                 │   │
│  │  │  3. Check verification passed           │                                                 │   │
│  │  │  4. Only dive into code diffs for       │                                                 │   │
│  │  │     files flagged as risky or complex   │                                                 │   │
│  │  │  5. Test via preview URL if available   │                                                 │   │
│  │  │                                         │                                                 │   │
│  │  │  _Automated by Hive - Task HIVE-..._    │                                                 │   │
│  │  └─────────────────────────────────────────┘                                                 │   │
│  │                                                                                              │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ○ MERGED                                                                    PR Merged → Complete   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘


══════════════════════════════════════════════════════════════════════════════════════════════════════════
                                    CI/CD & DEPLOYMENT PIPELINE
══════════════════════════════════════════════════════════════════════════════════════════════════════════

  Push to main (merge or direct)
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │  GitHub Actions (.github/workflows/deploy.yml)                             │
  │                                                                            │
  │  ┌─────────┐     ┌──────────────────────────────────────────────────────┐  │
  │  │  TEST   │────►│  BUILD & DEPLOY                                     │  │
  │  │         │     │                                                      │  │
  │  │ npm test│     │  1. Azure Login (federated identity)                │  │
  │  │ lint    │     │  2. Login to ACR (Azure Container Registry)         │  │
  │  │ build   │     │  3. Docker build (2-stage: builder → runtime)       │  │
  │  │         │     │     ┌────────────────────────────────────────────┐   │  │
  │  │         │     │     │  Stage 1: npm ci && npm run build         │   │  │
  │  │         │     │     │  Stage 2: node:20-alpine + git + gh-cli   │   │  │
  │  │         │     │     │           EXPOSE 3000                     │   │  │
  │  │         │     │     │           Healthcheck: /api/health        │   │  │
  │  │         │     │     └────────────────────────────────────────────┘   │  │
  │  │         │     │  4. Push image to ACR (:sha + :latest)              │  │
  │  │         │     │  5. az containerapp update → Azure Container Apps   │  │
  │  │         │     │  6. Health check (5 retries, 15s delay)             │  │
  │  └─────────┘     └──────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────────┘


══════════════════════════════════════════════════════════════════════════════════════════════════════════
                                      COMPLETE STATE MACHINE
══════════════════════════════════════════════════════════════════════════════════════════════════════════

                                      ┌──────────┐
                                      │ CANCELLED│◄─── (from any active state)
                                      └──────────┘

  ┌─────────┐     ┌────────┐     ┌───────────┐     ┌─────────┐     ┌──────────┐
  │ PENDING │────►│ QUEUED │────►│ ENRICHING │────►│  READY  │────►│ APPROVED │
  └────┬────┘     └────┬───┘     └─────┬─────┘     └────┬────┘     └────┬─────┘
       │               │               │                │               │
       │               │               │                │               ▼
       │               │               │                │          ┌──────────┐
       │               │               │                │          │EXECUTING │
       │               │               │                │          └────┬─────┘
       │               │               │                │               │
       │               │               │                │               ▼
       │               │               │                │          ┌──────────┐
       │               │               │                │          │REVIEWING │
       │               │               │                │          └──┬──┬──┬─┘
       │               │               │                │             │  │  │
       │               │               │                │             │  │  │
       │               │               │                │             ▼  │  ▼
       │               │               │                │   ┌────────┐  │  ┌────────┐
       │               │               │                │   │ REWORK │  │  │ FAILED │
       │               │               │                │   └───┬────┘  │  └───┬────┘
       │               │               │                │       │       │      │
       │               │               │                │       │       │      │
       │               │               │                │       ▼       ▼      │
       │               │               │                │   EXECUTING  ┌────┐  │
       │               │               │                │   (retry)    │DONE│  │
       │               │               │                │              └──┬─┘  │
       │               │               │                │                 │    │
       │               │               │                │                 ▼    │
       │               │               ▼                ▼              ┌──────┐│
       │               │          ┌──────────┐     ┌──────────┐       │MERGED││
       │               │          │ REJECTED │     │ REJECTED │       └──────┘│
       │               │          └──────────┘     └──────────┘               │
       │               ▼                                                      │
       │          ┌──────────┐                                                │
       │          │  FAILED  │◄───────────────────────────────────────────────┘
       │          └────┬─────┘
       │               │ retry
       ▼               ▼
  ┌──────────┐    ┌─────────┐
  │ REJECTED │    │ PENDING │ (restart)
  └──────────┘    └─────────┘


══════════════════════════════════════════════════════════════════════════════════════════════════════════
                                    BACKGROUND: DAEMON PROCESSES
══════════════════════════════════════════════════════════════════════════════════════════════════════════

  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │  DAEMON (HIVE_MODE=daemon)                                                                │
  │                                                                                           │
  │  ┌───────────────────────┐  ┌───────────────────────────────────────────────────────────┐  │
  │  │  TASK SCHEDULER       │  │  PRODUCERS (every 15 min)                                │  │
  │  │  Poll: 5s             │  │                                                           │  │
  │  │  Max concurrent: 5    │  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐    │  │
  │  │  Max per user: 2      │  │  │ logScanner  │ │ bugHunter   │ │ securityScanner  │    │  │
  │  │                       │  │  └─────────────┘ └─────────────┘ └──────────────────┘    │  │
  │  │  For each QUEUED task:│  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐    │  │
  │  │  → runPipeline()      │  │  │featureScout │ │ docAuditor  │ │  selfMonitor     │    │  │
  │  │                       │  │  └─────────────┘ └─────────────┘ └──────────────────┘    │  │
  │  │                       │  │                                    → Auto-create tasks    │  │
  │  └───────────────────────┘  └───────────────────────────────────────────────────────────┘  │
  │                                                                                           │
  │  ┌───────────────────────┐  ┌───────────────────────────────────────────────────────────┐  │
  │  │  MAINTENANCE          │  │  STALE RECOVERY                                          │  │
  │  │                       │  │  On startup: clean stale agents                          │  │
  │  │  Retrospective: 24h   │  │  Tasks stuck >30min in transitional states → FAILED      │  │
  │  │  Learning decay: 24h  │  │                                                           │  │
  │  │  Preview cleanup: 60s │  │                                                           │  │
  │  └───────────────────────┘  └───────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────────────────────────────────┘


══════════════════════════════════════════════════════════════════════════════════════════════════════════
                                          TECH STACK
══════════════════════════════════════════════════════════════════════════════════════════════════════════

  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
  │  Dashboard   │  │  Backend      │  │  Database     │  │  AI Engine    │  │  Infrastructure  │
  │              │  │              │  │              │  │              │  │                  │
  │  Express.js  │  │  TypeScript  │  │  PostgreSQL  │  │  Claude API  │  │  Azure Container │
  │  HTMX        │  │  Node 20    │  │  Drizzle ORM │  │  Sonnet/Opus │  │  Apps             │
  │  TailwindCSS │  │  Zod valid. │  │              │  │              │  │  ACR (Docker)    │
  │              │  │              │  │              │  │              │  │  Key Vault       │
  │              │  │              │  │              │  │              │  │  Entra ID (Auth) │
  └─────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘
  │                                                                       │
  │  Git Providers                                                        │  Preview Env
  │  ┌──────────────┐  ┌──────────────┐                                   │  ┌──────────────┐
  │  │  GitHub       │  │  Azure DevOps│                                   │  │  Docker TLS  │
  │  │  REST + GQL   │  │  REST v7.1   │                                   │  │  Port 4001+  │
  │  └──────────────┘  └──────────────┘                                   │  │  30min TTL   │
  │                                                                       │  └──────────────┘
```
