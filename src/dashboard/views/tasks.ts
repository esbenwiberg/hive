// Task list views — pure functions returning HTML strings

import type { SessionUser, TaskFilters } from "../../domain/types.js";
import type { TaskRow, RepoRow } from "../../db/schema.js";
import { getAvailableActions } from "../../domain/state-machine.js";
import {
  escapeHtml,
  badge,
  button,
  statusBadge,
  card,
  input,
  textarea,
  select,
  table,
  pipelineSteps,
  emptyState,
} from "./components.js";
import { layout } from "./layout.js";

// ── Status filter tabs ──────────────────────────────────────────────────────

const STATUS_TABS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "queued", label: "Queued" },
  { key: "enriching", label: "Enriching" },
  { key: "executing", label: "Executing" },
  { key: "reviewing", label: "Reviewing" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
];

function filterTabs(
  activeStatus: string,
  counts: Record<string, number>,
): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const tabs = STATUS_TABS.map((tab) => {
    const count = tab.key === "" ? total : (counts[tab.key] ?? 0);
    const isActive = tab.key === activeStatus;
    const activeClasses = isActive
      ? "border-amber-400 text-amber-400"
      : "border-transparent text-slate-400 hover:border-slate-600 hover:text-slate-300";

    return `<button
      class="inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${activeClasses}"
      hx-get="/api/tasks${tab.key ? `?status=${tab.key}` : ""}"
      hx-target="#task-list"
      hx-swap="innerHTML">${escapeHtml(tab.label)}
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">${count}</span>
    </button>`;
  });

  return `<div class="flex gap-1 border-b border-slate-700 overflow-x-auto">${tabs.join("")}</div>`;
}

// ── Task table ──────────────────────────────────────────────────────────────

function taskTable(tasks: TaskRow[], repoNames: Map<number, string>): string {
  if (tasks.length === 0) {
    return emptyState(
      "No tasks found",
      button("Create Task", {
        attrs:
          'onclick="document.getElementById(\'create-panel\').classList.remove(\'translate-x-full\')"',
      }),
    );
  }

  const headers = ["ID", "Title", "Status", "Repo", "Created", "Actions"];

  const rows = tasks.map((t) => {
    const id = `<span class="font-mono text-xs text-slate-400 cursor-pointer"
      hx-get="/api/tasks/${escapeHtml(t.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML">${escapeHtml(t.id)}</span>`;

    const title = `<span class="text-slate-50 font-medium">${escapeHtml(t.title)}</span>`;
    const status = statusBadge(t.status);
    const repoLabel = repoNames.get(t.repoId) ?? `#${t.repoId}`;
    const repo = `<span class="text-xs text-slate-400">${escapeHtml(repoLabel)}</span>`;
    const created = t.createdAt
      ? `<span class="text-xs text-slate-400">${escapeHtml(new Date(t.createdAt).toLocaleDateString())}</span>`
      : "-";
    const viewBtn = `<button class="text-xs text-amber-400 hover:text-amber-300"
      hx-get="/api/tasks/${escapeHtml(t.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML">View</button>`;

    return [id, title, status, repo, created, viewBtn];
  });

  // Build table manually for row-level data attributes
  const ths = headers
    .map(
      (h) =>
        `<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">${escapeHtml(h)}</th>`,
    )
    .join("");

  const trs = tasks
    .map((t, i) => {
      const tds = rows[i]
        .map(
          (cell) =>
            `<td class="whitespace-nowrap px-4 py-3 text-sm text-slate-300">${cell}</td>`,
        )
        .join("");
      return `<tr class="hover:bg-slate-800/50 cursor-pointer" data-task-row data-task-id="${escapeHtml(t.id)}"
        hx-get="/api/tasks/${escapeHtml(t.id)}"
        hx-target="#detail-panel"
        hx-swap="innerHTML">${tds}</tr>`;
    })
    .join("");

  return `<div class="overflow-x-auto rounded-xl border border-slate-700">
  <table class="min-w-full divide-y divide-slate-700">
    <thead class="bg-slate-800/50">
      <tr>${ths}</tr>
    </thead>
    <tbody class="divide-y divide-slate-700">${trs}</tbody>
  </table>
</div>`;
}

// ── Enrichment display ──────────────────────────────────────────────────────

function enrichmentSection(task: TaskRow): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;

  if (!enrichment || typeof enrichment !== "object" || Object.keys(enrichment).length === 0) {
    return "";
  }

  const sections = Object.entries(enrichment)
    .map(([key, value]) => {
      const content = formatEnrichmentValue(value);
      return `<details class="group">
        <summary class="flex cursor-pointer items-center justify-between rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">
          ${escapeHtml(key)}
          <svg class="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </summary>
        <div class="mt-1 rounded-lg bg-slate-900 px-4 py-3 text-xs text-slate-300">
          ${content}
        </div>
      </details>`;
    })
    .join("");

  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Enrichment</h4>
    <div class="space-y-2">${sections}</div>
  </div>`;
}

function formatEnrichmentValue(value: unknown): string {
  if (value === null || value === undefined) {
    return `<span class="text-slate-500">-</span>`;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const rows = Object.entries(obj)
      .map(([k, v]) => {
        const display =
          Array.isArray(v)
            ? v.map((item) => escapeHtml(String(item))).join(", ")
            : typeof v === "object" && v !== null
              ? `<pre class="whitespace-pre-wrap text-xs text-slate-400">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`
              : escapeHtml(String(v));
        return `<div class="flex justify-between gap-4 py-1">
          <span class="text-slate-400 shrink-0">${escapeHtml(k)}</span>
          <span class="text-slate-200 text-right">${display}</span>
        </div>`;
      })
      .join("");
    return `<div class="divide-y divide-slate-800">${rows}</div>`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => escapeHtml(String(item))).join(", ");
  }

  return escapeHtml(String(value));
}

// ── Gate decision display ───────────────────────────────────────────────────

function gateDecisionSection(task: TaskRow): string {
  if (!task.gateVerdict && !task.gateReasoning) {
    return "";
  }

  const verdictColors: Record<string, "emerald" | "red" | "amber"> = {
    approved: "emerald",
    approve: "emerald",
    rejected: "red",
    reject: "red",
    rework: "amber",
  };

  const verdictBadge = task.gateVerdict
    ? badge(task.gateVerdict, verdictColors[task.gateVerdict] ?? "slate")
    : "";

  const reasoning = task.gateReasoning
    ? `<p class="mt-2 text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(task.gateReasoning)}</p>`
    : "";

  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Gate Decision</h4>
    <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
      <div class="flex items-center gap-2">
        ${verdictBadge}
      </div>
      ${reasoning}
    </div>
  </div>`;
}

// ── Preview section ─────────────────────────────────────────────────────

function previewStatusBadge(status: string): string {
  const colors: Record<string, "amber" | "emerald" | "red" | "slate"> = {
    starting: "amber",
    running: "emerald",
    failed: "red",
    stopped: "slate",
  };
  return badge(status, colors[status] ?? "slate");
}

export function previewSection(task: TaskRow): string {
  if (!task.previewStatus) {
    return "";
  }

  const badgeHtml = previewStatusBadge(task.previewStatus);

  let content = "";

  if (task.previewStatus === "running" && task.previewPort) {
    content = `<div class="flex items-center gap-2 mb-3">
        ${badgeHtml}
        <a href="/preview/${escapeHtml(task.id)}/" target="_blank" rel="noopener"
           class="text-amber-400 hover:text-amber-300 underline text-sm">Open Preview</a>
      </div>
      <div class="flex flex-wrap gap-2">
        ${button("Stop Preview", {
          variant: "danger",
          attrs: `hx-post="/api/tasks/${escapeHtml(task.id)}/preview/stop" hx-target="#preview-section" hx-swap="innerHTML"`,
        })}
        ${button("Extend", {
          variant: "secondary",
          attrs: `hx-post="/api/tasks/${escapeHtml(task.id)}/preview/extend" hx-target="#preview-section" hx-swap="innerHTML"`,
        })}
      </div>`;
  } else if (task.previewStatus === "starting") {
    content = `<div class="flex items-center gap-2">
        ${badgeHtml}
        <span class="text-sm text-slate-400">Starting...</span>
      </div>`;
  } else if (task.previewStatus === "failed") {
    content = `<div class="flex items-center gap-2">
        ${badgeHtml}
      </div>`;
  } else if (task.previewStatus === "stopped") {
    content = `<div class="flex items-center gap-2">
        ${badgeHtml}
      </div>`;
  }

  return `<h4 class="text-sm font-medium text-slate-400 mb-2">Preview</h4>
    <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
      ${content}
    </div>`;
}

// ── Exported views ──────────────────────────────────────────────────────────

/**
 * Task list partial — just the filter tabs + table (for HTMX responses).
 */
export function taskListPartial(
  tasks: TaskRow[],
  counts: Record<string, number>,
  activeStatus?: string,
  repoNames: Map<number, string> = new Map(),
): string {
  return `${filterTabs(activeStatus ?? "", counts)}
<div class="mt-4">${taskTable(tasks, repoNames)}</div>`;
}

/**
 * Full task list page with layout.
 */
export function taskListPage(
  tasks: TaskRow[],
  filters: TaskFilters,
  counts: Record<string, number>,
  user: SessionUser,
  repos: RepoRow[] = [],
): string {
  const activeStatus = filters?.status ?? "";

  const header = `<div class="mb-6 flex items-center justify-between">
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Tasks</h2>
    <p class="mt-1 text-sm text-slate-400">Manage and monitor all Hive tasks</p>
  </div>
  ${button("New Task", {
    attrs:
      'onclick="document.getElementById(\'create-panel\').classList.remove(\'translate-x-full\')"',
  })}
</div>`;

  const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));

  const content = `${header}
<div id="task-list">
  ${taskListPartial(tasks, counts, activeStatus, repoNames)}
</div>

<!-- Create panel (slide-over) -->
${taskCreateForm(repos)}`;

  return layout("Tasks", content, user);
}

/**
 * Task detail slide-over panel.
 */
export function taskDetailPanel(task: TaskRow, repoNames: Map<number, string> = new Map()): string {
  const actions = getAvailableActions(task.status);

  const actionButtons = actions
    .map((a) => {
      const variant =
        a.action === "cancel" || a.action === "reject" || a.action === "fail"
          ? "danger"
          : a.action === "approve" ||
              a.action === "complete" ||
              a.action === "merge"
            ? "primary"
            : "secondary";
      const hxVals = escapeHtml(JSON.stringify({ action: a.action, targetStatus: a.targetStatus }));
      return button(a.label, {
        variant: variant as "primary" | "secondary" | "danger",
        attrs: `data-action="${escapeHtml(a.action)}" hx-post="/api/tasks/${escapeHtml(task.id)}/transition" hx-vals='${hxVals}' hx-target="#task-list" hx-swap="innerHTML"`,
      });
    })
    .join("\n        ");

  const metaRows = [
    ["Status", statusBadge(task.status)],
    ["Type", task.type ? escapeHtml(task.type) : `<span class="text-slate-500">-</span>`],
    ["Size", task.size ? escapeHtml(task.size) : `<span class="text-slate-500">-</span>`],
    ["Workflow", task.workflow ? escapeHtml(task.workflow) : `<span class="text-slate-500">-</span>`],
    ["Repo", escapeHtml(repoNames.get(task.repoId) ?? `#${task.repoId}`)],
    [
      "Created",
      task.createdAt
        ? escapeHtml(new Date(task.createdAt).toLocaleString())
        : "-",
    ],
    [
      "Updated",
      task.updatedAt
        ? escapeHtml(new Date(task.updatedAt).toLocaleString())
        : "-",
    ],
  ];

  if (task.prUrl) {
    metaRows.push([
      "PR",
      `<a href="${escapeHtml(task.prUrl)}" target="_blank" rel="noopener" class="text-amber-400 hover:text-amber-300 underline">${escapeHtml(task.prUrl)}</a>`,
    ]);
  }

  const metaHtml = metaRows
    .map(
      ([label, value]) =>
        `<div class="flex justify-between py-2">
        <span class="text-sm text-slate-400">${label}</span>
        <span class="text-sm text-slate-200">${value}</span>
      </div>`,
    )
    .join("");

  const bodyHtml = task.body
    ? `<div class="mt-4 rounded-lg bg-slate-900 p-4 text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(task.body)}</div>`
    : "";

  return `<div class="fixed inset-y-0 right-0 z-40 w-[480px] border-l border-slate-700 bg-slate-800 shadow-xl overflow-y-auto">
  <!-- Header -->
  <div class="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700 bg-slate-800 px-6 py-4">
    <div class="min-w-0 flex-1">
      <p class="font-mono text-xs text-slate-400">${escapeHtml(task.id)}</p>
      <h3 class="mt-1 text-lg font-semibold text-slate-50 truncate">${escapeHtml(task.title)}</h3>
    </div>
    <button onclick="document.getElementById('detail-panel').innerHTML=''"
            class="ml-4 rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <div class="px-6 py-4 space-y-6">
    <!-- Pipeline visualization -->
    <div>
      <h4 class="text-sm font-medium text-slate-400 mb-3">Pipeline</h4>
      ${pipelineSteps(task.status)}
    </div>

    <!-- Metadata -->
    <div>
      <h4 class="text-sm font-medium text-slate-400 mb-2">Details</h4>
      <div class="divide-y divide-slate-700 rounded-lg border border-slate-700 bg-slate-900 px-4">
        ${metaHtml}
      </div>
    </div>

    <!-- Body -->
    ${bodyHtml ? `<div><h4 class="text-sm font-medium text-slate-400 mb-2">Description</h4>${bodyHtml}</div>` : ""}

    <!-- Enrichment -->
    ${enrichmentSection(task)}

    <!-- Gate Decision -->
    ${gateDecisionSection(task)}

    <!-- Preview -->
    ${task.previewStatus ? `<div id="preview-section">${previewSection(task)}</div>` : ""}

    <!-- Actions -->
    ${
      actions.length > 0
        ? `<div>
      <h4 class="text-sm font-medium text-slate-400 mb-3">Actions</h4>
      <div class="flex flex-wrap gap-2">
        ${actionButtons}
      </div>
    </div>`
        : ""
    }
  </div>
</div>`;
}

/**
 * Task create form in a slide-over panel.
 */
export function taskCreateForm(repos: RepoRow[]): string {
  const repoOptions = [
    { value: "", label: "Select a repository" },
    ...repos.map((r) => ({
      value: String(r.id),
      label: r.fullName,
    })),
  ];

  const typeOptions = [
    { value: "", label: "Select type" },
    { value: "bug", label: "Bug" },
    { value: "feature", label: "Feature" },
    { value: "security", label: "Security" },
    { value: "refactor", label: "Refactor" },
    { value: "improvement", label: "Improvement" },
  ];

  const sizeOptions = [
    { value: "", label: "Select size" },
    { value: "trivial", label: "Trivial" },
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large", label: "Large" },
  ];

  return `<div id="create-panel"
  class="fixed inset-y-0 right-0 z-40 w-[480px] border-l border-slate-700 bg-slate-800 shadow-xl overflow-y-auto transform translate-x-full transition-transform duration-200">
  <!-- Header -->
  <div class="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700 bg-slate-800 px-6 py-4">
    <h3 class="text-lg font-semibold text-slate-50">New Task</h3>
    <button onclick="document.getElementById('create-panel').classList.add('translate-x-full')"
            class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <form class="px-6 py-4 space-y-4"
        hx-post="/api/tasks"
        hx-target="#task-list"
        hx-swap="innerHTML"
        hx-on::after-request="if(event.detail.successful) document.getElementById('create-panel').classList.add('translate-x-full')">
    ${input("title", "Title", { required: true, placeholder: "Brief task title" })}
    ${textarea("body", "Description", { required: true, placeholder: "Describe the task in detail...", rows: 6 })}
    ${select("repoId", "Repository", repoOptions)}
    ${select("type", "Type", typeOptions)}
    ${select("size", "Size", sizeOptions)}

    <div class="flex justify-end gap-3 pt-4 border-t border-slate-700">
      ${button("Cancel", {
        variant: "secondary",
        attrs:
          'type="button" onclick="document.getElementById(\'create-panel\').classList.add(\'translate-x-full\')"',
      })}
      ${button("Create Task", { attrs: 'type="submit"' })}
    </div>
  </form>
</div>`;
}
