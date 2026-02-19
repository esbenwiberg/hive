# Blueprint: Workflow Visualization Dashboard Page

**Goal:** Add a `/workflow` page to the Hive dashboard that (1) renders the complete pipeline as interactive HTML/CSS diagrams showcasing how Hive works, and (2) lets users select an active task from a dropdown to see its live position highlighted on the pipeline via HTMX polling.

**Milestones: 4**

## Non-goals

- No per-enricher live sub-progress tracking (no DB schema changes)
- No public/unauthenticated route — standard `requireAuth`
- No changes to the existing `pipelineSteps()` component in task detail panel
- No external JS libraries (D3, Mermaid, etc.) — pure HTML/CSS/Tailwind + HTMX
- No changes to the enricher or execution pipeline code

## Acceptance Criteria

- [ ] `/workflow` page accessible from sidebar navigation
- [ ] Main pipeline diagram shows all stages: Sources → Pending → Routing → Queued → Enrichment (with 6 enricher labels) → Gate → Execution (Path A milestones + Path B single flow, both with review-fix loop) → Review Gate → Done/PR → Merged
- [ ] Dropdown lists all non-terminal tasks (not done/merged/failed/rejected/cancelled); selecting one highlights the active stage on the pipeline with a pulsing indicator + task ID badge
- [ ] Pipeline highlight updates every 5s via HTMX polling without full page reload
- [ ] Supporting diagrams rendered as HTML/CSS sections below the pipeline: State Machine, CI/CD Pipeline, Daemon Processes, Tech Stack
- [ ] All diagrams match the existing dark theme (slate-900/800, amber-400, emerald-400 accents)
- [ ] Page renders correctly on viewport widths ≥1024px (dashboard is primarily desktop)
- [ ] `npm run build` passes with no TypeScript errors

## Architecture

### Components

```
src/dashboard/
  views/workflow.ts       ← New: all HTML-generating functions
  routes/workflow.ts      ← New: GET /workflow, GET /api/workflow/pipeline
```

### Data Flow

```
Browser                    Server
  │                          │
  │  GET /workflow            │
  │─────────────────────────►│  Query non-terminal tasks
  │  Full page (layout +     │  Render workflowPage()
  │  pipeline + diagrams)    │
  │◄─────────────────────────│
  │                          │
  │  GET /api/workflow/       │
  │  pipeline?taskId=X       │  (HTMX poll every 5s)
  │─────────────────────────►│  Query task by ID for current status
  │  Pipeline HTML partial   │  Render pipelineDiagram() with highlight
  │◄─────────────────────────│
  │                          │
  │  Dropdown change          │
  │  (hx-get triggers with   │
  │   new taskId param)      │
  │─────────────────────────►│  Same endpoint, different taskId
  │◄─────────────────────────│
```

### Pipeline Diagram Structure (HTML/CSS)

The main pipeline is a vertical flowchart built from reusable "stage" blocks connected by CSS lines/arrows. Each stage is a `<div>` with:
- Border color: `slate-700` (default), `amber-400` (active), `emerald-400` (completed)
- Inner content describing what happens at that stage
- A pulsing ring animation on the active stage when a task is selected

```
┌─────────────────────────────────────────────────┐
│  TASK SOURCES  (3 source boxes in a row)        │
└─────────────────────┬───────────────────────────┘
                      ▼  (CSS border-left or ::after pseudo-element)
┌─────────────────────────────────────────────────┐
│  STAGE 1: ROUTING   [task badge if active here] │
│  type / size / workflow / model                  │
└─────────────────────┬───────────────────────────┘
                      ▼
              ... and so on ...
```

The supporting diagrams (state machine, CI/CD, daemon, tech stack) are simpler grid/flex layouts — informational, not interactive.

### Highlighting Logic

```typescript
function stageState(stageKey: string, taskStatus: string | null): "default" | "active" | "completed" {
  // Map task status to pipeline stage index
  // Stages before active index → "completed" (emerald border)
  // Stage at active index → "active" (amber border + pulse)
  // Stages after → "default" (slate border)
}
```

Status-to-stage mapping (reuses logic from existing `pipelineSteps`):

| Task Status | Active Stage |
|-------------|-------------|
| pending | sources |
| queued | routing |
| enriching | enrichment |
| ready | gate |
| approved | gate |
| executing | execution |
| rework | execution |
| reviewing | review-gate |
| done | done |
| merged | merged |
| failed/rejected/cancelled | (not shown — terminal) |

## Key Files

| File | Action | Purpose |
|------|--------|---------|
| `src/dashboard/views/workflow.ts` | Create | All view functions: `workflowPage()`, `pipelineDiagram()`, `stateMachineDiagram()`, `cicdDiagram()`, `daemonDiagram()`, `techStackDiagram()` |
| `src/dashboard/routes/workflow.ts` | Create | `GET /workflow` (full page), `GET /api/workflow/pipeline` (HTMX partial) |
| `src/dashboard/server.ts` | Edit | Register workflow router |
| `src/dashboard/views/layout.ts` | Edit | Add "Workflow" nav link to sidebar |

## Milestones

### Milestone 1: Route + page skeleton with nav link

**Intent:** Get the `/workflow` page wired up and rendering an empty shell so we have the plumbing in place.

**Files:**
- Create `src/dashboard/routes/workflow.ts` — GET /workflow with requireAuth, queries non-terminal tasks, renders page
- Create `src/dashboard/views/workflow.ts` — `workflowPage()` with task dropdown + placeholder content, `pipelinePartial()` stub
- Edit `src/dashboard/server.ts` — import and register workflow router
- Edit `src/dashboard/views/layout.ts` — add "Workflow" nav link with icon

**Verification:**
```bash
npm run build
# Manual: visit /workflow in browser — see page with dropdown and placeholder
```

### Milestone 2: Main pipeline diagram with live task highlighting

**Intent:** Build the core pipeline visualization — the full vertical flowchart from task sources through to merged, with all the detail boxes (enricher names, execution paths, review-fix loops). When a task is selected from the dropdown, highlight its current stage and poll for updates.

**Files:**
- Edit `src/dashboard/views/workflow.ts` — implement `pipelineDiagram(taskStatus?)` with all stages as HTML/CSS boxes:
  - Task Sources (Dashboard / Producers / API)
  - Stage 1: Routing (classification details)
  - Stage 2: Enrichment (6 enricher labels in sequence)
  - Clarification check sub-box
  - Stage 3: Gate (human/auto/ai modes, verdict)
  - Stage 4: Execution setup → Path A (milestones + review-fix loop) / Path B (single flow + review-fix loop) → Final Review Gate → PR creation
  - Done (PR template preview) → Merged
  - Highlight logic: completed stages get emerald, active gets amber+pulse, future gets slate
- Edit `src/dashboard/routes/workflow.ts` — `GET /api/workflow/pipeline?taskId=X` returns pipelineDiagram partial with task status

**HTMX wiring:**
- Dropdown `hx-get="/api/workflow/pipeline?taskId=X"` `hx-target="#pipeline-container"` `hx-swap="innerHTML"`
- Pipeline container: `hx-get="/api/workflow/pipeline?taskId=X"` `hx-trigger="every 5s"` `hx-swap="innerHTML"` (only when a task is selected)

**Verification:**
```bash
npm run build
# Manual: select a task from dropdown, see its stage highlighted
# Change task status via task detail panel, see pipeline update within 5s
```

### Milestone 3: Supporting diagrams (state machine, CI/CD, daemon, tech stack)

**Intent:** Add the four informational diagrams below the main pipeline as collapsible sections. These are static (no live data), purely for showcasing how the system works.

**Files:**
- Edit `src/dashboard/views/workflow.ts` — implement:
  - `stateMachineDiagram()` — 13 states as nodes with transition arrows, color-coded by category (active/terminal/error)
  - `cicdDiagram()` — horizontal flow: push → test → build → deploy with Docker stage detail
  - `daemonDiagram()` — grid showing scheduler, producers, maintenance, stale recovery
  - `techStackDiagram()` — grid of tech boxes: Dashboard, Backend, Database, AI, Infrastructure, Git Providers, Preview
- Wire into `workflowPage()` as `<details>` sections below the pipeline

**Verification:**
```bash
npm run build
# Manual: expand each section on /workflow, verify all content renders
```

### Milestone 4: Polish — responsive layout, scroll behavior, task badge on pipeline

**Intent:** Final polish pass — ensure the pipeline diagram scrolls nicely on smaller viewports, add the task ID + title badge next to the highlighted stage, add a subtle entry animation when switching tasks, and verify everything looks right.

**Files:**
- Edit `src/dashboard/views/workflow.ts` — add task info badge (ID + title + status) positioned next to the active stage, add `scroll-margin-top` so the active stage scrolls into view, add transition classes for smooth highlight changes
- Minor CSS tweaks for overflow handling on the pipeline

**Verification:**
```bash
npm run build
# Manual: select different tasks, verify smooth transitions
# Verify on 1024px and 1440px viewport widths
# Verify page works with no tasks selected (showcase-only mode)
```

## Risks & Probes

| Risk | Impact | Quick Probe |
|------|--------|-------------|
| Pipeline diagram may be very tall and hard to scan | Medium | Start with compact stage boxes; use `<details>` for inner details of each stage if too long |
| CSS arrows/connectors between boxes may be tricky without SVG | Low | Use `border-left` + `::before` pseudo-elements for vertical connectors; proven pattern in many dashboards |
| HTMX polling with dynamic `taskId` in URL needs care | Low | Use `hx-vals` or JS to update the poll URL when dropdown changes; test in milestone 2 |
| State machine diagram with 13 nodes + many transitions is complex to layout in pure CSS | Medium | Use CSS grid with fixed positions; only show primary transitions, not every edge |
