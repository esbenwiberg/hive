# The Hive — Product Context

> **Internal document for Advisor agent**
> This document encodes deep product knowledge to guide the Advisor's evaluation of tasks.

## What is The Hive?

**The Hive** is an autonomous task orchestration platform for engineering teams. It accepts task descriptions from users or automated producers, routes and enriches them with codebase context, gates them through an AI-driven approval process, executes the implementation via Claude (with real git tooling), and opens pull requests on GitHub or Azure DevOps — end to end without human intervention.

## Target Users

- **Engineering teams** (5–50 engineers) running services on GitHub or Azure DevOps
- **Platform/DevOps teams** using The Hive to automate code generation, refactoring, and documentation
- **Researchers** and **architects** who need consistent, auditable task execution at scale
- **Autonomous producers** (external systems) that inject code-generation tasks into The Hive pipeline

## Why The Hive Exists

Traditional code review + approval workflows are:
- **Slow**: manual review cycles add days to merging simple changes
- **Inconsistent**: human reviewers apply subjective standards
- **Expensive**: senior engineers spend time on tasks that could be automated

The Hive solves this by:
1. **Enriching** tasks with deep repo context (architecture, dependencies, recent changes)
2. **Routing** tasks to appropriate workflows based on type and scope
3. **Gating** tasks through an AI approval process that respects architectural principles
4. **Executing** task implementation with Claude's agentic coding loop
5. **Previewing** changes in a Docker-based sandbox before merging
6. **Reviewing** code quality, test coverage, and architectural alignment
7. **Merging** to main with a clean, auditable PR

## Key Workflows

### Workflow: "flow" (Default)
User or producer submits a task. The Hive enriches, gates, executes, reviews, and merges.

### Workflow: "milestone"
Multi-step task scoped to a GitHub milestone. Each step is gated and executed independently.

## Core Architectural Principles

### 1. Graceful Degradation
**If any component fails, the system does not halt.** Enrichers that fail fall back to empty context. Advisor that fails returns a safe escalation verdict. Gate that fails transitions task to human review. Execution errors trigger review gates and rollback. The system is fail-safe by design.

### 2. Agent Patterns (LLM Components)
The Hive uses LLM-powered agents across the pipeline:
- **Router**: classifies task type (feature, refactor, documentation, test, etc.)
- **Enrichers**: gather repo context (codebase, dependencies, architecture, docs)
- **Advisor**: evaluates task alignment with product goals and architecture
- **Gate**: final approval decision (human or AI-driven)
- **Decomposer**: breaks large tasks into subtasks
- **Executor** (Worker): implements the task via Claude's coding loop
- **Code-Quality-Analyst**: validates generated code
- **Browser-Validator**: smoke-tests changes in a preview environment
- **Refiner**: improves code based on review feedback

All agents:
- Read system prompts from `prompts/enrichers/` or `prompts/` as Markdown files
- Receive structured input (enrichment data, repo context, task metadata)
- Return structured JSON output
- Include confidence scores and reasoning
- Gracefully degrade on LLM errors (parse failures, timeouts)
- Track token usage and cost per agent invocation

### 3. Enricher Pattern
Enrichers are stateless LLM agents that gather context about the task and repository. Each enricher:
- Runs in parallel or sequence as configured
- Outputs structured JSON stored in task enrichment metadata
- Fails gracefully (returns empty context rather than crashing pipeline)
- Includes cost tracking
- Is composable and reusable

Current enrichers:
- **Router**: task type, size, effort estimate
- **Codebase**: file tree, language breakdown, recent changes
- **Architect**: design patterns, key abstractions, naming conventions
- **Dependencies**: package.json analysis, security vulnerabilities
- **Git-History**: recent commits, common authors, branch patterns
- **Docs**: documentation completeness, quality gaps
- **Milestone**: milestone metadata (for milestone workflows)
- **Scorer**: risk assessment, complexity scoring, resource estimation

### 4. Task State Machine
All tasks flow through a linear pipeline of 14 states:

```
created → routing → enriching → ready → approved → executing →
previewing → reviewing → executing (if rework) → merging → merged
```

Key transitions:
- **routing**: Router classifies task
- **enriching**: All enrichers run (parallel), Advisor evaluates
- **ready**: Human review (or held for manual override)
- **approved**: Gate/human approved, ready for execution
- **executing**: Worker implements the task
- **previewing**: Docker preview environment validates
- **reviewing**: Code quality, browser, and architecture review gates run
- **merged**: PR is merged, task complete
- **rejected**: Task failed gate or human review
- **rework**: Reviewer requested changes; return to executing

### 5. Gate Behavior (Critical)
The **Gate** is the final approval checkpoint before execution. It:
- Consumes all enrichment data + Advisor verdict
- **CRITICAL RULE**: If Advisor.escalate=true, gate MUST escalate to human review (non-negotiable)
- Applies approval thresholds based on task size and gate mode (auto/ai/human)
- Records the decision for audit trail
- Transitions task to "approved" or "ready" (human review)

**Gate modes:**
- **human**: All tasks go to human review (most conservative)
- **ai**: Claude evaluates all tasks using gate LLM
- **auto**: Small/trivial tasks auto-approve; medium+ require AI evaluation

### 6. Execution Isolation
Tasks execute in isolated Git worktrees (not main branch clones). This prevents:
- Concurrent execution from interfering with each other
- Failed executions from polluting the main branch
- Repository state corruption

Each execution:
- Creates a worktree from the main branch
- Runs Claude's coding loop in the worktree
- Validates changes via review gates
- Opens a PR pointing to the worktree branch
- Cleans up the worktree when complete

### 7. Cost Visibility
Every LLM call (router, enrichers, advisor, gate, executor, reviewers) is tracked:
- Token counts (input, output, cache creation, cache read)
- Cost in USD
- Model used (Claude 3.5 Sonnet, Opus, etc.)
- Wall-clock duration
- Agent name

The dashboard surfaces:
- Cumulative cost per agent
- Cost trends over time
- Breakdown by model and task type
- Cost anomalies

### 8. Task Visibility & Control
The dashboard shows:
- Task queue (created, routing, enriching, ready, approved, executing, previewing)
- Task detail (title, description, enrichment, gate decision, PR link)
- Task history (events, state transitions, costs, decisions)
- Approval queue (tasks in "ready" status)
- System health (active agents, concurrency, costs)

Users can:
- View task details and enrichment
- Approve/reject tasks in "ready" status
- Cancel running tasks
- Search tasks by status, type, author

## Naming Conventions & Code Patterns

### File Organization
```
src/
  agents/       # LLM-powered pipeline agents
  enrichers/    # Enricher implementations
  execution/    # Code execution engine
  dashboard/    # Web UI
  daemon/       # Background scheduler/housekeeping
  db/           # Database schema and queries
  domain/       # Business logic and types
  logger.ts     # Logging

prompts/
  enrichers/    # Enricher system prompts
  gate.md       # Gate system prompt
  ...

docs/
  internal/     # Developer docs (this file)
  workflow-diagram.md  # ASCII pipeline diagram
```

### Task Types (Router Output)
Tasks are classified into types:
- `feature`: new feature or capability
- `refactor`: code reorganization, no logic change
- `documentation`: docs, comments, examples
- `test`: test addition or fix
- `fix`: bug fix
- `chore`: maintenance, dependency updates
- `performance`: optimization
- `security`: security hardening
- `unknown`: unclear classification

### Task Sizes (Router Output)
- `trivial`: < 10 minutes (comment fixes, typos, simple config)
- `small`: 10–30 minutes (1–5 file edits, < 100 lines changed)
- `medium`: 30 min–2 hours (new small feature, focused refactor)
- `large`: 2–8 hours (multi-file feature, complex refactor)
- `epic`: 8+ hours (major feature, architectural change)

### Verdict Values
Verdicts are used by multiple agents and must be consistent:

**Advisor verdicts:**
- `approve`: Task aligns with product goals, fits existing patterns, low risk
- `caution`: Task aligns but has risks or prerequisites
- `rework`: Task conflicts with patterns; recommend redesign

**Gate verdicts:**
- `approve`: Approved for execution
- `reject`: Rejected; task will not execute
- `rework`: Reviewer requested design changes (task returns to rework state)

### Confidence Scores
Confidence scores are [0.0, 1.0] where:
- 0.0 = complete uncertainty
- 0.5 = moderate uncertainty
- 1.0 = high confidence

**Critical escalation rule**: Advisor confidence < 0.5 MUST escalate to human review (no exceptions).

## Anti-Patterns & Red Flags

### Advisor Should Caution/Rework When:
1. **Task modifies core safety mechanisms** (authentication, authorization, secret management)
2. **Task removes or weakens audit/logging** without strong justification
3. **Task introduces external dependencies** without security review (new npm packages, APIs)
4. **Task changes database schema** without migration plan
5. **Task affects task execution isolation** (worktree handling, git operations, credential handling)
6. **Task modifies gate logic** without comprehensive test coverage
7. **Task removes tests** or reduces test coverage
8. **Task is vague or poorly scoped** (description < 2 sentences, no clear acceptance criteria)
9. **Task conflicts with recent PRs** or architectural decisions
10. **Task uses hardcoded values** instead of config (API keys, URLs, secrets)

### Executor Should Reject When:
1. **Generated code contains hardcoded secrets** (tokens, keys, passwords)
2. **Generated code has SQL injection vulnerabilities** (unsanitized SQL queries)
3. **Generated code has XSS vulnerabilities** (user input in HTML without escaping)
4. **Generated code modifies restricted files** (auth.ts, vault.ts, credentials handling)
5. **Generated code introduces new dependencies** without approval
6. **Generated code removes critical error handling**
7. **Generated code has syntax errors or type errors**
8. **Generated code doesn't follow project patterns** (inconsistent naming, no JSDoc, etc.)

## Known Constraints & Workarounds

### Constraint: No Codebase Embeddings
The Hive does not use vector embeddings for codebase search (as of now). Instead:
- Advisor reads `docs/internal/architecture.md` and module documentation
- Executor uses keyword search + file listing for initial exploration
- Enrichers provide static analysis (dependencies, recent changes, patterns)

This limits semantic understanding but keeps implementation simple and deterministic.

### Constraint: Rate Limiting (Anthropic)
Anthropic's API has rate limits. The daemon:
- Batches requests across tasks
- Uses exponential backoff on 429 (rate limit) errors
- Tracks active agents to prevent queue overload
- Surfaces concurrency limits in the dashboard

### Constraint: Git Credential Safety
Git operations MUST use credential helpers (not embedded tokens):
- Use `GIT_ASKPASS` environment variables
- Use `.git-credentials` temporary files (cleaned up after use)
- Use git credential helpers
- **Never** embed tokens in clone URLs passed as CLI arguments

All git errors are scrubbed of token strings before logging.

## Key Success Criteria

The Hive is successful when:
1. **Velocity**: Task execution time decreases 50%+ vs. manual PR + review
2. **Quality**: Generated code passes all tests and reviews without rework (>90% first-pass rate)
3. **Trust**: Teams confidently approve and merge Hive-generated PRs
4. **Cost**: Autonomous execution is cheaper than engineer labor (cost per task < labor cost)
5. **Reliability**: System uptime > 99%; task execution succeeds > 95% of the time
6. **Adoption**: > 50% of eligible tasks are routed through The Hive

## Future Roadmap (Context for Advisor)

### Near-term
- **Codebase embeddings**: Vector search over codebase for semantic code understanding
- **Feedback loops**: ML model learning from gate/review decisions
- **Knowledge base**: Persistent learnings that improve advisor & gate logic

### Medium-term
- **Multi-repo orchestration**: Coordinate tasks across multiple repositories
- **Custom workflows**: User-defined task pipelines
- **Producer ecosystem**: Third-party producers (linters, security scanners, etc.)

### Long-term
- **Autonomous DevOps**: Hive-driven infrastructure changes (deployment, scaling)
- **Cross-team collaboration**: Hive tasks that span multiple team repositories
- **Real-time learning**: Feedback-loop-driven model fine-tuning

## Further Reading

- `docs/internal/architecture.md` — System overview and module description
- `docs/internal/modules/agents.md` — Agent module guide (SDK, pipeline orchestration)
- `docs/internal/modules/execution.md` — Execution engine (worktrees, worker, review gates)
- `docs/workflow-diagram.md` — ASCII pipeline diagram
- `CLAUDE.md` — Notes for Claude (executor context)
