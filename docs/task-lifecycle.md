# Hive — Complete Task Lifecycle

## Overview

14-state pipeline: route → enrich (8 enrichers) → gate → execute (Claude + tools) → review → PR, with self-learning feedback loop. All budgets, limits, and intervals are configurable.

---

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                        HIVE — COMPLETE TASK LIFECYCLE                               ║
╚══════════════════════════════════════════════════════════════════════════════════════╝


 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                         AUTO-DISCOVERY PRODUCERS                                │
 │  Daemon runs every 15min, auto-creates tasks from 7 signal sources:            │
 │                                                                                 │
 │  ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐ ┌───────────────┐       │
 │  │ log-scanner   │ │ bug-hunter   │ │ security-scanner│ │ feature-scout │       │
 │  │ Azure Monitor │ │ Code smells  │ │ SAST via Claude │ │ Roadmap gaps  │       │
 │  │ KQL queries   │ │ via Claude   │ │ + dep vulns     │ │ via Claude    │       │
 │  └──────┬───────┘ └──────┬───────┘ └────────┬────────┘ └──────┬────────┘       │
 │         │                │                   │                 │                 │
 │  ┌──────┴───────┐ ┌──────┴───────┐ ┌────────┴────────┐                         │
 │  │ doc-auditor   │ │ self-monitor │ │ maintenance     │                         │
 │  │ Missing docs  │ │ Hive's own   │ │ Dep updates,    │                         │
 │  │ & stale docs  │ │ failure logs │ │ security patches│                         │
 │  └──────┬───────┘ └──────┬───────┘ └────────┬────────┘                         │
 │         └────────────────┴──────────────────┘                                   │
 │                          │  (deduplicated)                                      │
 └──────────────────────────┼──────────────────────────────────────────────────────┘
                            │
                            ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                         HUMAN-CREATED TASKS                                     │
 │  Users can also create tasks manually via:                                      │
 │  • Dashboard UI (create task form)                                              │
 │  • CLI (npm run cli)                                                            │
 │  • API endpoint                                                                 │
 │  These enter the pipeline at PENDING, same as producer-discovered tasks.        │
 └──────────────────────────┬──────────────────────────────────────────────────────┘
                            │
                            ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃  ░  PHASE 1: INTAKE & ROUTING                                                 ░  ┃
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃                                                                                   ┃
┃  ┌──────────┐     Router Agent (Claude)      ┌──────────┐                         ┃
┃  │ PENDING  │ ──────────────────────────────▶ │ QUEUED   │                         ┃
┃  └──────────┘     Classifies task:            └──────────┘                         ┃
┃   (task created)   • type: bug/feature/        (classified)                        ┃
┃                      security/refactor/                                             ┃
┃                      improvement/maintenance                                        ┃
┃                    • size: trivial/small/                                            ┃
┃                      medium/large                                                   ┃
┃                    • workflow: flow/epic                                             ┃
┃                    • model + maxTurns + budget                                       ┃
┃                                                                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                            │
                            ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃  ░  PHASE 2: ENRICHMENT PIPELINE (8 enrichers, sequential)                    ░  ┃
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃                                                                                   ┃
┃  ┌──────────┐                                                                     ┃
┃  │ENRICHING │                                                                     ┃
┃  └────┬─────┘                                                                     ┃
┃       │                                                                            ┃
┃       ▼                                                                            ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │ 1. CODEBASE          Scans repo filesystem                            │        ┃
┃  │                      → file counts, types, keyword-matched files      │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 2. DOCS              Discovers documentation                          │        ┃
┃  │                      → internal/external docs, README, ARCHITECTURE   │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 3. GIT-HISTORY       Analyzes repo history                            │        ┃
┃  │                      → recent commits, contributors, file hotspots    │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 4. DEPENDENCIES      Detects build system & deps                      │        ┃
┃  │                      → npm/dotnet packages, lock files, scripts       │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 5. PRISM (optional)  Semantic codebase search                         │        ┃
┃  │                      → relevant code, module summaries, findings      │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 6. HIVEMIND          Retrieves relevant learnings from past tasks     │        ┃
┃  │                      → patterns, pitfalls, best-practices             │        ┃
┃  │                      → scoped: universal / repo-specific / user       │        ┃
┃  │                      → confidence-weighted, decayed over time         │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 7. ARCHITECT         Designs implementation strategy (Claude)         │        ┃
┃  │                      → approach, milestones or checklist, key files   │        ┃
┃  │                      → incorporates HIVEMIND learnings from step 6    │        ┃
┃  │                      → when uncertain, ASKS CLARIFICATION QUESTIONS:  │        ┃
┃  │                        • human mode: pauses task, waits for user      │        ┃
┃  │                        • ai mode: self-answers from context           │        ┃
┃  │                        • task stays in ENRICHING until answered       │        ┃
┃  ├─────────────────────────────────────────────────────────────────────────┤        ┃
┃  │ 8. SCORER            Evaluates complexity & cost (Claude)             │        ┃
┃  │                      → value/complexity/risk/feasibility (1-10)       │        ┃
┃  │                      → cost estimate, recommendation: approve/reject  │        ┃
┃  └─────────────────────────────────────────────────────────────────────────┘        ┃
┃       │                                                                            ┃
┃       ▼                                                                            ┃
┃  ┌─────────────────────────────────────────────────┐                               ┃
┃  │            GATE EVALUATION                      │                               ┃
┃  │  Mode: human │ ai │ auto                        │                               ┃
┃  │                                                 │                               ┃
┃  │  human → task waits at READY for manual review  │                               ┃
┃  │  ai    → Claude gate agent decides              │                               ┃
┃  │  auto  → uses scorer recommendation             │                               ┃
┃  └───────────┬──────────┬──────────┬───────────────┘                               ┃
┃              │          │          │                                                ┃
┃         ┌────▼───┐ ┌────▼────┐ ┌──▼───────┐                                       ┃
┃         │APPROVED│ │REJECTED │ │  READY   │                                        ┃
┃         │        │ │(terminal)│ │(awaiting │                                        ┃
┃         └───┬────┘ └─────────┘ │ human)   │                                        ┃
┃             │                  └────┬─────┘                                        ┃
┃             │                       │ (human approves)                              ┃
┃             │◄──────────────────────┘                                               ┃
┃             │                                                                       ┃
┗━━━━━━━━━━━━━┼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
              │
              ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃  ░  PHASE 3: EXECUTION                                                        ░  ┃
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃                                                                                   ┃
┃  ┌────────────┐                                                                   ┃
┃  │ EXECUTING  │                                                                   ┃
┃  └─────┬──────┘                                                                   ┃
┃        │                                                                           ┃
┃        ▼                                                                           ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  WORKTREE SETUP                                                        │        ┃
┃  │  • Clone into /tmp/hive-worktrees/{branch}-{ts}                        │        ┃
┃  │  • Set git user to "The Hive" <hive@thehive.ai>                        │        ┃
┃  │  • Record base SHA (fork point for diffs)                              │        ┃
┃  │  • Recover existing remote branch if resuming                          │        ┃
┃  └────────────────────────────────┬────────────────────────────────────────┘        ┃
┃                                   │                                                ┃
┃                                   ▼                                                ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  WORKER AGENT (Claude + Tools)                                         │        ┃
┃  │                                                                        │        ┃
┃  │  Tools: read/write files, shell commands, git ops, web preview         │        ┃
┃  │  Context: architect blueprint + enrichment data + hivemind learnings  │        ┃
┃  │  Budget: per-task max (configurable), tracked per turn                │        ┃
┃  │                                                                        │        ┃
┃  │  ┌──────────────────────────────────────────────────────────────┐      │        ┃
┃  │  │  MILESTONE MODE (medium/large tasks)                        │      │        ┃
┃  │  │                                                              │      │        ┃
┃  │  │  For each milestone:                                         │      │        ┃
┃  │  │    ┌─────────────────────┐                                   │      │        ┃
┃  │  │    │ Claude works on     │                                   │      │        ┃
┃  │  │    │ acceptance criteria │                                   │      │        ┃
┃  │  │    │ (max 20 tool turns) │                                   │      │        ┃
┃  │  │    └─────────┬───────────┘                                   │      │        ┃
┃  │  │              ▼                                               │      │        ┃
┃  │  │    ┌─────────────────────┐                                   │      │        ┃
┃  │  │    │ QUICK VERIFY        │                                   │      │        ┃
┃  │  │    │ • npm install       │                                   │      │        ┃
┃  │  │    │ • lint              │                                   │      │        ┃
┃  │  │    │ • build             │                                   │      │        ┃
┃  │  │    │ • test              │                                   │      │        ┃
┃  │  │    └─────────┬───────────┘                                   │      │        ┃
┃  │  │              ▼                                               │      │        ┃
┃  │  │    ┌─────────────────────────────────────────┐               │      │        ┃
┃  │  │    │ REVIEW-FIX LOOP (max 2 iterations)      │               │      │        ┃
┃  │  │    │                                          │               │      │        ┃
┃  │  │    │  Claude self-reviews its own changes ──┐ │               │      │        ┃
┃  │  │    │       │                                │ │               │      │        ┃
┃  │  │    │       ▼ issues found?                  │ │               │      │        ┃
┃  │  │    │  Yes: Claude fixes ──▶ re-verify ──────┘ │               │      │        ┃
┃  │  │    │  No:  continue                           │               │      │        ┃
┃  │  │    └─────────────────────────────────────────┘               │      │        ┃
┃  │  │              ▼                                               │      │        ┃
┃  │  │    ┌─────────────────────┐                                   │      │        ┃
┃  │  │    │ Commit & push       │                                   │      │        ┃
┃  │  │    │ milestone           │                                   │      │        ┃
┃  │  │    └─────────┬───────────┘                                   │      │        ┃
┃  │  │              │ next milestone...                              │      │        ┃
┃  │  └──────────────┴───────────────────────────────────────────────┘      │        ┃
┃  │                                                                        │        ┃
┃  │  ┌──────────────────────────────────────────────────────────────┐      │        ┃
┃  │  │  CHECKLIST MODE (small/trivial tasks)                       │      │        ┃
┃  │  │  Claude works through checklist items, no milestones        │      │        ┃
┃  │  └──────────────────────────────────────────────────────────────┘      │        ┃
┃  │                                                                        │        ┃
┃  └────────────────────────────────┬────────────────────────────────────────┘        ┃
┃                                   │                                                ┃
┃                                   ▼                                                ┃
┃  ╔═════════════════════════════════════════════════════════════════════════╗        ┃
┃  ║  DOCKER SELF-VALIDATION & BROWSER TESTING                              ║        ┃
┃  ║                                                                        ║        ┃
┃  ║  After code changes, the system validates itself in an isolated        ║        ┃
┃  ║  Docker environment — no human needed:                                 ║        ┃
┃  ║                                                                        ║        ┃
┃  ║  1. ENVIRONMENT SPIN-UP                                                ║        ┃
┃  ║     • Docker Compose / Testcontainers / Local process                  ║        ┃
┃  ║     • Syncs worktree to remote Docker host (if configured)             ║        ┃
┃  ║     • Runs docker-compose up with the changed code                     ║        ┃
┃  ║     • Waits for health check endpoint to respond OK                    ║        ┃
┃  ║                                                                        ║        ┃
┃  ║  2. BROWSER VALIDATION AGENT (Playwright)                              ║        ┃
┃  ║     • Launches headless browser against running preview                ║        ┃
┃  ║     • Navigates pages, clicks buttons, fills forms                     ║        ┃
┃  ║     • Validates UI renders correctly                                   ║        ┃
┃  ║     • Checks functional flows end-to-end                              ║        ┃
┃  ║     • Screenshots captured for evidence                               ║        ┃
┃  ║     • Reports pass/fail with details back to worker                    ║        ┃
┃  ║                                                                        ║        ┃
┃  ║  3. PREVIEW URL → PR                                                    ║        ┃
┃  ║     • Live preview URL is attached to the PR                           ║        ┃
┃  ║     • Humans can open it to manually validate if needed                ║        ┃
┃  ║     • Preview stays alive until cleanup timeout                        ║        ┃
┃  ║                                                                        ║        ┃
┃  ║  4. TEARDOWN                                                           ║        ┃
┃  ║     • Containers stopped & cleaned up after timeout                    ║        ┃
┃  ║     • Logs persisted to DB for debugging                               ║        ┃
┃  ║                                                                        ║        ┃
┃  ║  If validation fails → findings fed back to worker for fixing          ║        ┃
┃  ╚═════════════════════════════════════════════════════════════════════════╝        ┃
┃                                   │                                                ┃
┃                                   ▼                                                ┃
┃                          Commit & push final changes                               ┃
┃                                   │                                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃  ░  PHASE 4: REVIEW GATE                                                      ░  ┃
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃                                                                                   ┃
┃  ┌────────────┐                                                                   ┃
┃  │ REVIEWING  │                                                                   ┃
┃  └─────┬──────┘                                                                   ┃
┃        │                                                                           ┃
┃        ▼                                                                           ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  REVIEW-GATE AGENT (Claude)                                            │        ┃
┃  │                                                                        │        ┃
┃  │  Inputs:                                                               │        ┃
┃  │  • Full git diff (base SHA → HEAD)                                     │        ┃
┃  │  • Task context & architect blueprint                                  │        ┃
┃  │  • Verification results (build/test/lint)                              │        ┃
┃  │                                                                        │        ┃
┃  │  Evaluates:                                                            │        ┃
┃  │  • Code quality findings (critical/major/minor/info)                   │        ┃
┃  │  • Security findings (critical/high/medium/low)                        │        ┃
┃  │    - advisory=true  → design observations, don't block                 │        ┃
┃  │    - advisory=false → blocking issues                                  │        ┃
┃  │  • Verification (tests, lint, build status)                            │        ┃
┃  │                                                                        │        ┃
┃  │  Verdict:                                                              │        ┃
┃  │  ┌──────────┐         ┌──────────┐                                     │        ┃
┃  │  │  PASS    │         │  REWORK  │                                     │        ┃
┃  │  └────┬─────┘         └────┬─────┘                                     │        ┃
┃  └───────┼────────────────────┼───────────────────────────────────────────┘        ┃
┃          │                    │                                                     ┃
┃          │                    ▼                                                     ┃
┃          │     ┌──────────────────────────────────┐                                 ┃
┃          │     │  REWORK STATE                    │                                 ┃
┃          │     │                                  │                                 ┃
┃          │     │  Iteration count < max (configurable)?                             ┃
┃          │     │  ┌─────┐          ┌─────┐                                          ┃
┃          │     │  │ YES │          │ NO  │                                          ┃
┃          │     │  └──┬──┘          └──┬──┘                                          ┃
┃          │     │     │                │                                              ┃
┃          │     │     ▼                ▼                                              ┃
┃          │     │  Back to          User chooses in dashboard:                        ┃
┃          │     │  EXECUTING        ┌─────────────────────────────┐                   ┃
┃          │     │  (fix issues)     │ "Add More Cycles" → retry  │                   ┃
┃          │     │     │             │ "Force PR"        → DONE   │                   ┃
┃          │     │     │             └─────────────────────────────┘                   ┃
┃          │     └─────┼────────────────┼────────────────────────────┘                ┃
┃          │           │                │                                              ┃
┃          │    ┌──────┘                │                                              ┃
┃          │    │ ╔═══════════════════╗ │                                              ┃
┃          │    │ ║  REWORK LOOP     ║ │                                              ┃
┃          │    │ ║                   ║ │                                              ┃
┃          │    └▶║ EXECUTING ──────▶ ║─┘                                              ┃
┃          │      ║     │            ║                                                 ┃
┃          │      ║     ▼            ║                                                 ┃
┃          │      ║ REVIEWING ──────▶║──── pass? ───▶ (join below)                     ┃
┃          │      ║     │            ║                                                 ┃
┃          │      ║     ▼ rework?    ║                                                 ┃
┃          │      ║  (loop again)    ║                                                 ┃
┃          │      ╚══════════════════╝                                                 ┃
┃          │                                                                           ┃
┗━━━━━━━━━━┼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
           │
           ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃  ░  PHASE 5: PR & MERGE                                                       ░  ┃
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃                                                                                   ┃
┃  ┌──────────┐                                                                     ┃
┃  │   DONE   │                                                                     ┃
┃  └────┬─────┘                                                                     ┃
┃       │                                                                            ┃
┃       ▼                                                                            ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  PR CREATION (via GitHub / Azure DevOps)                               │        ┃
┃  │                                                                        │        ┃
┃  │  PR body from architect blueprint:                                     │        ┃
┃  │  • Approach summary                                                    │        ┃
┃  │  • Key files / Milestones / Checklist                                  │        ┃
┃  │  • Review findings & security issues                                   │        ┃
┃  │  • Verification status (build/test/lint)                               │        ┃
┃  │  • Cost tracking summary                                              │        ┃
┃  └────────────────────────────┬────────────────────────────────────────────┘        ┃
┃                               │                                                    ┃
┃                               ▼                                                    ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  PR MONITORING (daemon polls every 15min)                              │        ┃
┃  │                                                                        │        ┃
┃  │  • Polls PR review status & feedback                                   │        ┃
┃  │  • Feeds human PR comments back into task for potential rework          │        ┃
┃  │  • Monitors CI status checks                                          │        ┃
┃  │  • Auto-merges when all checks pass                                   │        ┃
┃  └────────────────────────────┬────────────────────────────────────────────┘        ┃
┃                               │                                                    ┃
┃                               ▼                                                    ┃
┃                        ┌──────────┐                                                ┃
┃                        │  MERGED  │                                                ┃
┃                        └──────────┘                                                ┃
┃                                                                                    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                │
                                ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃  ░  PHASE 6: SELF-LEARNING (HIVEMIND)                                          ░  ┃
┃  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ┃
┃                                                                                   ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  FEEDBACK-LOOP AGENT (after each task completes)                       │        ┃
┃  │  • Analyzes what worked / what didn't                                  │        ┃
┃  │  • Proposes new learnings → stored in learnings table                  │        ┃
┃  │  • Reinforces existing learnings that proved useful                    │        ┃
┃  │  • Contradicts learnings that led to failures                          │        ┃
┃  └─────────────────────────────────────────────────────────────────────────┘        ┃
┃                                                                                    ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  RETROSPECTIVE AGENT (weekly batch analysis)                           │        ┃
┃  │  • Reviews batch of completed tasks                                    │        ┃
┃  │  • Identifies cross-task patterns                                      │        ┃
┃  │  • Proposes systemic learnings                                         │        ┃
┃  └─────────────────────────────────────────────────────────────────────────┘        ┃
┃                                                                                    ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  KEEPER AGENT (weekly curation)                                        │        ┃
┃  │  • Reviews all learnings                                               │        ┃
┃  │  • Promotes high-confidence learnings                                  │        ┃
┃  │  • Archives low-confidence / contradicted ones                         │        ┃
┃  └─────────────────────────────────────────────────────────────────────────┘        ┃
┃                                                                                    ┃
┃  ┌─────────────────────────────────────────────────────────────────────────┐        ┃
┃  │  MONTHLY DECAY                                                         │        ┃
┃  │  • Reduces confidence of learnings not recently reinforced             │        ┃
┃  │  • Prevents stale knowledge from influencing decisions                 │        ┃
┃  └─────────────────────────────────────────────────────────────────────────┘        ┃
┃                                                                                    ┃
┃           Learnings feed back into ──▶ HIVEMIND + ARCHITECT ENRICHERS              ┃
┃           (closes the learning loop)    (Phase 2, enrichers #6 & #7)              ┃
┃                                                                                    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  TERMINAL & RECOVERY STATES                                                       ┃
┃                                                                                   ┃
┃  ┌──────────┐  Can occur at any phase. Recoverable:                               ┃
┃  │  FAILED  │  retry (back to QUEUED), redesign (back to ENRICHING),              ┃
┃  └──────────┘  or more-cycles (back to REWORK)                                    ┃
┃                                                                                    ┃
┃  ┌──────────┐  Manual cancel. Recoverable:                                        ┃
┃  │CANCELLED │  retry → QUEUED                                                     ┃
┃  └──────────┘                                                                      ┃
┃                                                                                    ┃
┃  ┌──────────┐  Graceful daemon shutdown. Recoverable:                             ┃
┃  │SUSPENDED │  auto-resumed on daemon restart                                     ┃
┃  └──────────┘                                                                      ┃
┃                                                                                    ┃
┃  ┌──────────┐  Gate rejected task. Terminal.                                      ┃
┃  │REJECTED  │  (can be manually re-opened)                                        ┃
┃  └──────────┘                                                                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  DAEMON BACKGROUND LOOPS                                                          ┃
┃                                                                                   ┃
┃  ┌──────────────────┬───────────┬────────────────────────────────────┐             ┃
┃  │ Loop             │ Interval  │ Purpose                            │             ┃
┃  ├──────────────────┼───────────┼────────────────────────────────────┤             ┃
┃  │ Main dispatcher  │ 5s        │ Poll tasks, dispatch to agents     │             ┃
┃  │ Producer scan    │ 15min     │ Run 7 auto-discovery producers     │             ┃
┃  │ PR feedback poll │ 15min     │ Collect PR reviews & comments      │             ┃
┃  │ PR close cleanup │ 60s       │ Auto-merge done PRs                │             ┃
┃  │ Preview cleanup  │ 60s       │ Stop expired Docker containers     │             ┃
┃  │ Retrospective    │ 7 days    │ Batch learning from completions    │             ┃
┃  │ Decay            │ 30 days   │ Reduce stale learning confidence   │             ┃
┃  └──────────────────┴───────────┴────────────────────────────────────┘             ┃
┃                                                                                   ┃
┃  COST TRACKING (per component)                                                    ┃
┃  • Every Claude call tracked: model, tokens, cost, turns, duration                ┃
┃  • Budget enforcement: configurable daily per-user and per-task limits            ┃
┃  • Components: router, architect, scorer, gate, worker, review-gate,              ┃
┃    retrospective, feedback-loop, keeper                                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Key Design Notes

- **The learning loop is circular** — learnings from Phase 6 feed back into the Hivemind enricher (step 6) and Architect enricher (step 7) in Phase 2, so the system improves over time.
- **Two levels of review-fix**: one *within* execution (per-milestone self-review, Phase 3) and one *after* execution (the formal Review Gate, Phase 4). The inner loop is self-correction; the outer loop is quality assurance.
- **At max rework cycles**, the system stops — the user must choose to either add more cycles or force-push the PR as-is via dashboard buttons.
- **Docker self-validation** spins up the full app in containers, then a browser agent (Playwright) interacts with it end-to-end — clicking, navigating, validating UI — before any human sees the code.
- **Architect asks questions** when it's uncertain about requirements, blocking the pipeline until answered (by human or AI, configurable).
- **Tasks come from two sources**: auto-discovery producers (7 scanners) and humans (dashboard, CLI, API). Both enter at PENDING.
- **All limits are configurable**: budgets, rework cycles, turn counts, intervals, concurrency — via config YAML or database overrides.
