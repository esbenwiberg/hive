// Workflow page view — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { TaskRow } from "../../db/schema.js";
import { escapeHtml, emptyState } from "./components.js";
import { layout } from "./layout.js";

// ── Stage types and helpers ─────────────────────────────────────────────────

type StageState = "default" | "active" | "completed";

interface StageDefinition {
  name: string;
  content: string;
}

/**
 * Maps a task status string to the corresponding active stage index.
 * Returns -1 if the status is unknown or no task is selected.
 */
function getStageIndex(status: string): number {
  const map: Record<string, number> = {
    pending: 1,
    queued: 1,
    enriching: 2,
    ready: 3,
    approved: 3,
    executing: 4,
    rework: 4,
    reviewing: 5,
    done: 6,
    merged: 6,
  };
  return map[status] ?? -1;
}

/**
 * Determines the visual state of a stage given its index and the active index.
 */
function stageState(stageIndex: number, activeIndex: number): StageState {
  if (activeIndex < 0) return "default";
  if (stageIndex < activeIndex) return "completed";
  if (stageIndex === activeIndex) return "active";
  return "default";
}

// ── Stage content builders ──────────────────────────────────────────────────

function sourceBoxes(): string {
  const boxes = [
    "Dashboard (User)",
    "Producers (Automated)",
    "API / Webhook",
  ];
  return `<div class="flex flex-wrap gap-2 mt-2">${boxes
    .map(
      (b) =>
        `<span class="inline-block rounded border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs text-slate-300">${b}</span>`,
    )
    .join("")}</div>`;
}

function enricherPills(): string {
  const enrichers = [
    "Codebase",
    "Docs",
    "Git History",
    "Dependencies",
    "Architect",
    "Scorer",
  ];
  const pills = enrichers
    .map(
      (e) =>
        `<span class="inline-block rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">${e}</span>`,
    )
    .join("");

  return `<div class="flex flex-wrap gap-1.5 mt-2">${pills}</div>
<p class="mt-2 text-xs text-slate-500">Clarification check: human / ai / auto mode</p>`;
}

function executionPaths(): string {
  return `<div class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
  <div class="rounded border border-slate-600 bg-slate-900 p-2.5">
    <p class="text-xs font-medium text-slate-300">Path A: Milestones</p>
    <p class="mt-1 text-xs text-slate-500">For each: code &rarr; review-fix &rarr; commit</p>
  </div>
  <div class="rounded border border-slate-600 bg-slate-900 p-2.5">
    <p class="text-xs font-medium text-slate-300">Path B: Single Flow</p>
    <p class="mt-1 text-xs text-slate-500">Code &rarr; review-fix</p>
  </div>
</div>`;
}

/**
 * Returns all 7 stage definitions with their inner HTML content.
 */
function buildStages(): StageDefinition[] {
  return [
    {
      name: "Task Sources",
      content: sourceBoxes(),
    },
    {
      name: "Routing",
      content: `<p class="mt-2 text-xs text-slate-400">Claude classifies: type, size, workflow, model</p>`,
    },
    {
      name: "Enrichment",
      content: enricherPills(),
    },
    {
      name: "Gate",
      content: `<p class="mt-2 text-xs text-slate-400">Mode: human / auto / ai</p>
<p class="mt-1 text-xs text-slate-400">Verdict: approve / reject / rework</p>`,
    },
    {
      name: "Execution",
      content: executionPaths(),
    },
    {
      name: "Review Gate",
      content: `<p class="mt-2 text-xs text-slate-400">Code quality + security + test verification</p>
<p class="mt-1 text-xs text-slate-400">Pass &rarr; PR + push &nbsp;|&nbsp; Rework (&le;2) &nbsp;|&nbsp; Fail</p>`,
    },
    {
      name: "Done / Merged",
      content: `<p class="mt-2 text-xs text-slate-400">PR created in GitHub/Azure DevOps</p>
<p class="mt-1 text-xs text-slate-400">Preview environment (optional)</p>`,
    },
  ];
}

// ── Stage rendering ─────────────────────────────────────────────────────────

/** Color configuration per stage state */
function stageColors(state: StageState): {
  dot: string;
  border: string;
  line: string;
  text: string;
} {
  switch (state) {
    case "active":
      return {
        dot: "bg-amber-400 ring-4 ring-amber-400/20 animate-pulse",
        border: "border-amber-400/50",
        line: "bg-amber-400",
        text: "text-amber-400",
      };
    case "completed":
      return {
        dot: "bg-emerald-400",
        border: "border-emerald-400/30",
        line: "bg-emerald-400",
        text: "text-emerald-400",
      };
    default:
      return {
        dot: "bg-slate-600",
        border: "border-slate-700",
        line: "bg-slate-700",
        text: "text-slate-400",
      };
  }
}

/**
 * Renders a single stage block with vertical timeline connector.
 */
function renderStage(
  stage: StageDefinition,
  stageIndex: number,
  state: StageState,
  isLast: boolean,
): string {
  const colors = stageColors(state);

  // The vertical line should extend through this stage unless it is the last
  const lineHtml = !isLast
    ? `<div class="absolute left-3 top-0 bottom-0 w-0.5 ${colors.line}"></div>`
    : `<div class="absolute left-3 top-0 h-4 w-0.5 ${colors.line}"></div>`;

  return `<div class="relative pl-8">
  ${lineHtml}
  <div class="absolute left-1.5 top-4 h-3 w-3 rounded-full ${colors.dot}"></div>
  <div class="ml-4 rounded-lg border ${colors.border} bg-slate-800 p-4 ${isLast ? "" : "mb-4"}">
    <h4 class="text-sm font-semibold ${colors.text}">${stage.name}</h4>
    <div class="text-xs text-slate-400">${stage.content}</div>
  </div>
</div>`;
}

// ── Pipeline partial (HTMX fragment) ────────────────────────────────────────

/**
 * Returns an HTML fragment for the full pipeline diagram.
 * When taskStatus is set, highlights the active stage and enables HTMX polling.
 * When no task is selected, renders all stages in default/slate colors.
 */
export function pipelinePartial(
  taskStatus: string | null,
  taskId?: string,
): string {
  const activeIndex = taskStatus ? getStageIndex(taskStatus) : -1;
  const stages = buildStages();

  const stagesHtml = stages
    .map((stage, i) => {
      const state = stageState(i, activeIndex);
      return renderStage(stage, i, state, i === stages.length - 1);
    })
    .join("\n");

  // Header with status badge when a task is selected
  const statusIndicator = taskStatus
    ? `<div class="flex items-center gap-2 mb-4">
        <span class="text-sm text-slate-400">Current status:</span>
        <span class="inline-flex items-center rounded-full bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-400/20">${escapeHtml(taskStatus)}</span>
      </div>`
    : `<p class="text-sm text-slate-400 mb-4">Select a task above to highlight its position in the pipeline.</p>`;

  // HTMX polling attributes — only when a task is selected
  const htmxAttrs =
    taskId
      ? ` hx-get="/api/workflow/pipeline?taskId=${escapeHtml(taskId)}" hx-trigger="every 5s" hx-swap="outerHTML"`
      : "";

  return `<div id="pipeline-container"${htmxAttrs}>
  <div class="rounded-xl border border-slate-700 bg-slate-800 p-6">
    <h3 class="text-lg font-semibold text-slate-50 mb-4">Pipeline Status</h3>
    ${statusIndicator}
    <div class="py-2">
      ${stagesHtml}
    </div>
  </div>
</div>`;
}

// ── Workflow page ────────────────────────────────────────────────────────────

/**
 * Full workflow page with task dropdown and pipeline diagram.
 * The pipeline is always visible — in default colors as a showcase
 * when no task is selected, and with highlighting when one is.
 */
export function workflowPage(tasks: TaskRow[], user: SessionUser): string {
  const taskOptions = tasks
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}">${escapeHtml(t.id)} — ${escapeHtml(t.title)}</option>`,
    )
    .join("");

  const content = `<div class="space-y-8">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Workflow</h2>
    <p class="mt-1 text-sm text-slate-400">Track tasks through the pipeline and view live execution progress.</p>
  </div>

  <!-- Task selector -->
  ${tasks.length > 0
    ? `<div class="max-w-md">
    <div class="space-y-1.5">
      <label for="task-select" class="block text-sm font-medium text-slate-300">Active Task</label>
      <select id="task-select" name="taskId"
        hx-get="/api/workflow/pipeline"
        hx-target="#pipeline-container"
        hx-swap="outerHTML"
        hx-trigger="change"
        class="block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">
        <option value="">Select a task...</option>
        ${taskOptions}
      </select>
    </div>
  </div>`
    : `<div>${emptyState("No active tasks in the pipeline")}</div>`}

  <!-- Pipeline diagram — always visible -->
  ${pipelinePartial(null)}

  <!-- Supporting diagrams placeholder -->
  <div>
    <div class="rounded-xl border border-slate-700 bg-slate-800 p-6">
      <h3 class="text-lg font-semibold text-slate-50 mb-4">Diagrams</h3>
      <p class="text-sm text-slate-400">Pipeline diagrams and enrichment details will appear here once a task is selected.</p>
    </div>
  </div>
</div>`;

  return layout("Workflow", content, user);
}
