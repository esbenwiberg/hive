// Workflow page view — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { TaskRow } from "../../db/schema.js";
import { escapeHtml, card, emptyState } from "./components.js";
import { layout } from "./layout.js";

// ── Workflow page ────────────────────────────────────────────────────────────

/**
 * Full workflow page with task dropdown and pipeline placeholder.
 */
export function workflowPage(tasks: TaskRow[], user: SessionUser): string {
  const taskOptions = tasks
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}">${escapeHtml(t.id)} — ${escapeHtml(t.title)}</option>`,
    )
    .join("");

  const hasActiveTasks = tasks.length > 0;

  const content = `<div class="space-y-8">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Workflow</h2>
    <p class="mt-1 text-sm text-slate-400">Track tasks through the pipeline and view live execution progress.</p>
  </div>

  <!-- Task selector -->
  <div class="max-w-md">
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
  </div>

  <!-- Pipeline container -->
  <div id="pipeline-container">
    ${hasActiveTasks ? card(`<p class="text-sm text-slate-400">Select a task above to view its position in the pipeline.</p>`, { title: "Pipeline Status" }) : emptyState("No active tasks in the pipeline")}
  </div>

  <!-- Supporting diagrams placeholder -->
  <div>
    ${card(`<p class="text-sm text-slate-400">Pipeline diagrams and enrichment details will appear here once a task is selected.</p>`, { title: "Diagrams" })}
  </div>
</div>`;

  return layout("Workflow", content, user);
}

// ── Pipeline partial (HTMX fragment) ────────────────────────────────────────

/**
 * Returns an HTML fragment for the pipeline status of a task.
 * Stub implementation — will be expanded in later milestones.
 */
export function pipelinePartial(taskStatus: string | null): string {
  if (!taskStatus) {
    return `<div id="pipeline-container">
  ${card(`<p class="text-sm text-slate-400">Select a task above to view its position in the pipeline.</p>`, { title: "Pipeline Status" })}
</div>`;
  }

  return `<div id="pipeline-container" hx-get="/api/workflow/pipeline" hx-trigger="every 5s" hx-swap="outerHTML">
  ${card(`<p class="text-sm text-slate-400">Task is currently in <span class="font-medium text-amber-400">${escapeHtml(taskStatus)}</span> status. Full pipeline visualization coming soon.</p>`, { title: "Pipeline Status" })}
</div>`;
}
