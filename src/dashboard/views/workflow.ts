// Workflow page view — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { TaskRow } from "../../db/schema.js";
import {
  escapeHtml,
  emptyState,
  getStageIndex,
  stageState,
  buildStages,
  renderStage,
} from "./components.js";
import { layout } from "./layout.js";
import { advisorVerdictSection } from "./tasks.js";

// ── Pipeline partial (HTMX fragment) ────────────────────────────────────────

// ── Advisor summary pill (compact, for pipeline view) ────────────────────────

function advisorSummaryPill(task: TaskRow): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;
  const advisor = enrichment?.advisor as
    | { verdict: string; overallScore: number; confidenceScore: number; escalate: boolean }
    | undefined;
  if (!advisor || typeof advisor !== "object") return "";

  const verdictColors: Record<string, string> = {
    approve: "bg-emerald-400/10 text-emerald-400 ring-emerald-400/20",
    caution: "bg-amber-400/10 text-amber-400 ring-amber-400/20",
    reject:  "bg-red-400/10 text-red-400 ring-red-400/20",
  };
  const verdictLabels: Record<string, string> = {
    approve: "Proceed",
    caution: "Redesign",
    reject:  "Reject",
  };
  const cls = verdictColors[advisor.verdict] ?? "bg-slate-700 text-slate-300 ring-slate-600";
  const label = verdictLabels[advisor.verdict] ?? advisor.verdict;

  const escalateIcon = advisor.escalate
    ? `<svg class="h-3 w-3 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>`
    : "";

  return `<div class="mt-2 flex items-center gap-2 flex-wrap">
    <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">
      Advisor: ${escapeHtml(label)}
    </span>
    <span class="text-xs text-slate-500">Score&nbsp;<span class="text-slate-300">${(advisor.overallScore * 10).toFixed(1)}/10</span></span>
    <span class="text-xs text-slate-500">Conf&nbsp;<span class="text-slate-300">${(advisor.confidenceScore * 100).toFixed(0)}%</span></span>
    ${escalateIcon}
  </div>`;
}

/**
 * Builds a task info badge shown next to the active stage.
 */
function taskInfoBadge(taskId: string, taskTitle: string, taskStatus: string): string {
  return `<div class="mb-3 flex items-center gap-2 rounded-lg bg-amber-400/5 border border-amber-400/20 px-3 py-2">
      <span class="font-mono text-xs text-amber-400/70">${escapeHtml(taskId)}</span>
      <span class="text-xs text-slate-300 truncate">${escapeHtml(taskTitle)}</span>
      <span class="ml-auto inline-flex items-center rounded-full bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-400/20">${escapeHtml(taskStatus)}</span>
    </div>`;
}

/**
 * Returns an HTML fragment for the full pipeline diagram.
 * When taskStatus is set, highlights the active stage and enables HTMX polling.
 * When no task is selected, renders all stages in default/slate colors.
 */
export function pipelinePartial(
  taskStatus: string | null,
  taskId?: string,
  taskTitle?: string,
  task?: TaskRow,
): string {
  const activeIndex = taskStatus ? getStageIndex(taskStatus) : -1;
  const stages = buildStages();

  // Build task badge for the active stage
  const badge = taskId && taskStatus && taskTitle
    ? taskInfoBadge(taskId, taskTitle, taskStatus)
    : undefined;

  const stagesHtml = stages
    .map((stage, i) => {
      const state = stageState(i, activeIndex);
      return renderStage(stage, i, state, i === stages.length - 1, badge);
    })
    .join("\n");

  // Header with status info when a task is selected
  const statusIndicator = taskStatus
    ? `<div class="flex items-center gap-2 mb-4">
        <span class="text-sm text-slate-400">Tracking:</span>
        <span class="font-mono text-sm text-amber-400">${escapeHtml(taskId ?? "")}</span>
        <span class="inline-flex items-center rounded-full bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-400/20">${escapeHtml(taskStatus)}</span>
      </div>`
    : `<p class="text-sm text-slate-400 mb-4">Select a task above to highlight its position in the pipeline.</p>`;

  // HTMX polling attributes — only when a task is selected
  const htmxAttrs =
    taskId
      ? ` hx-get="/api/workflow/pipeline?taskId=${escapeHtml(taskId)}" hx-trigger="every 5s" hx-swap="outerHTML"`
      : "";

    const advisorPill = task ? advisorSummaryPill(task) : "";

  return `<div id="pipeline-container"${htmxAttrs}>
  <div class="rounded-xl border border-slate-700 bg-slate-800 p-6">
    <h3 class="text-lg font-semibold text-slate-50 mb-4">Pipeline</h3>
    ${statusIndicator}
    <div class="py-2 overflow-x-auto">
      ${stagesHtml}
    </div>
    ${advisorPill}
  </div>
</div>`;
}

// ── Supporting Diagram Helpers ────────────────────────────────────────────────

/** Chevron SVG icon for details/summary elements */
function chevronIcon(): string {
  return `<svg class="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
  </svg>`;
}

/** Wraps diagram content in a collapsible <details> element */
function detailsSection(title: string, content: string): string {
  return `<details class="group rounded-xl border border-slate-700 bg-slate-800">
  <summary class="flex cursor-pointer items-center justify-between p-4 text-sm font-semibold text-slate-50 hover:bg-slate-700/50 rounded-xl">
    ${title}
    ${chevronIcon()}
  </summary>
  <div class="border-t border-slate-700 p-6">
    ${content}
  </div>
</details>`;
}

// ── State Machine Diagram ───────────────────────────────────────────────────

function stateNode(
  label: string,
  color: "blue" | "amber" | "emerald" | "red" | "slate",
): string {
  const colors: Record<string, string> = {
    blue: "border-blue-400/50 bg-blue-400/10 text-blue-400",
    amber: "border-amber-400/50 bg-amber-400/10 text-amber-400",
    emerald: "border-emerald-400/50 bg-emerald-400/10 text-emerald-400",
    red: "border-red-400/50 bg-red-400/10 text-red-400",
    slate: "border-slate-600 bg-slate-700/50 text-slate-400",
  };
  return `<span class="inline-flex items-center rounded-lg border px-2.5 py-1.5 text-xs font-medium ${colors[color]}">${label}</span>`;
}

function arrow(): string {
  return `<span class="text-slate-500 text-xs flex-shrink-0">&rarr;</span>`;
}

function stateMachineDiagram(): string {
  // Main happy-path flow
  const mainFlow = `
<div class="space-y-4">
  <div>
    <p class="text-xs font-medium text-slate-300 mb-2">Happy Path</p>
    <div class="flex flex-wrap items-center gap-2">
      ${stateNode("PENDING", "slate")}
      ${arrow()}
      ${stateNode("QUEUED", "blue")}
      ${arrow()}
      ${stateNode("ENRICHING", "blue")}
      ${arrow()}
      ${stateNode("READY", "amber")}
      ${arrow()}
      ${stateNode("APPROVED", "amber")}
      ${arrow()}
      ${stateNode("EXECUTING", "amber")}
      ${arrow()}
      ${stateNode("REVIEWING", "amber")}
      ${arrow()}
      ${stateNode("DONE", "emerald")}
      ${arrow()}
      ${stateNode("MERGED", "emerald")}
    </div>
  </div>

  <div class="border-t border-slate-700 pt-4">
    <p class="text-xs font-medium text-slate-300 mb-2">Error &amp; Rework Branches</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs text-slate-400 mb-2">Rework loop (max 2 cycles):</p>
        <div class="flex items-center gap-2">
          ${stateNode("REVIEWING", "amber")}
          ${arrow()}
          ${stateNode("REWORK", "amber")}
          ${arrow()}
          ${stateNode("EXECUTING", "amber")}
        </div>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs text-slate-400 mb-2">Gate rejects:</p>
        <div class="flex items-center gap-2">
          ${stateNode("READY", "amber")}
          ${arrow()}
          ${stateNode("REJECTED", "red")}
        </div>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs text-slate-400 mb-2">FAILED recovery paths:</p>
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            ${stateNode("FAILED", "red")}
            ${arrow()}
            ${stateNode("PENDING", "slate")}
            <span class="text-xs text-slate-500 italic">retry</span>
          </div>
          <div class="flex items-center gap-2">
            ${stateNode("FAILED", "red")}
            ${arrow()}
            ${stateNode("APPROVED", "amber")}
            <span class="text-xs text-slate-500 italic">re-execute</span>
          </div>
          <div class="flex items-center gap-2">
            ${stateNode("FAILED", "red")}
            ${arrow()}
            ${stateNode("REVIEWING", "amber")}
            <span class="text-xs text-slate-500 italic">re-review</span>
          </div>
        </div>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs text-slate-400 mb-2">Suspend &amp; cancel:</p>
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-500 italic">active</span>
            ${arrow()}
            ${stateNode("SUSPENDED", "slate")}
            ${arrow()}
            ${stateNode("PENDING", "slate")}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-500 italic">any</span>
            ${arrow()}
            ${stateNode("CANCELLED", "slate")}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="border-t border-slate-700 pt-3">
    <div class="flex flex-wrap gap-4 text-xs text-slate-500">
      <span class="flex items-center gap-1.5"><span class="inline-block h-2 w-2 rounded-full bg-blue-400"></span> Active (queuing/enriching)</span>
      <span class="flex items-center gap-1.5"><span class="inline-block h-2 w-2 rounded-full bg-amber-400"></span> Active (gating/executing)</span>
      <span class="flex items-center gap-1.5"><span class="inline-block h-2 w-2 rounded-full bg-emerald-400"></span> Terminal success</span>
      <span class="flex items-center gap-1.5"><span class="inline-block h-2 w-2 rounded-full bg-red-400"></span> Terminal error</span>
      <span class="flex items-center gap-1.5"><span class="inline-block h-2 w-2 rounded-full bg-slate-500"></span> Neutral</span>
    </div>
  </div>
</div>`;

  return mainFlow;
}

// ── CI/CD Pipeline Diagram ──────────────────────────────────────────────────

function cicdDiagram(): string {
  return `<div class="flex flex-col lg:flex-row items-stretch gap-3">
  <!-- Step 1: Push -->
  <div class="flex-1 rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-6 w-6 items-center justify-center rounded-full bg-blue-400/10 text-xs font-bold text-blue-400">1</span>
      <p class="text-xs font-medium text-slate-300">Push to main</p>
    </div>
    <p class="text-xs text-slate-500">Merge PR or direct push triggers the workflow</p>
  </div>

  <div class="hidden lg:flex items-center"><span class="text-slate-500 text-lg">&rarr;</span></div>
  <div class="flex lg:hidden justify-center"><span class="text-slate-500 text-lg">&darr;</span></div>

  <!-- Step 2: Test -->
  <div class="flex-1 rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-6 w-6 items-center justify-center rounded-full bg-amber-400/10 text-xs font-bold text-amber-400">2</span>
      <p class="text-xs font-medium text-slate-300">Test Job</p>
    </div>
    <p class="text-xs text-slate-500">npm test, lint, build</p>
  </div>

  <div class="hidden lg:flex items-center"><span class="text-slate-500 text-lg">&rarr;</span></div>
  <div class="flex lg:hidden justify-center"><span class="text-slate-500 text-lg">&darr;</span></div>

  <!-- Step 3: Build & Deploy -->
  <div class="flex-1 rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400/10 text-xs font-bold text-emerald-400">3</span>
      <p class="text-xs font-medium text-slate-300">Build &amp; Deploy</p>
    </div>
    <ul class="space-y-1 text-xs text-slate-500">
      <li class="flex items-start gap-1.5"><span class="text-slate-600 mt-0.5">&bull;</span> Azure Login (federated identity)</li>
      <li class="flex items-start gap-1.5"><span class="text-slate-600 mt-0.5">&bull;</span> Docker build (2-stage: builder &rarr; runtime)</li>
      <li class="flex items-start gap-1.5"><span class="text-slate-600 mt-0.5">&bull;</span> Push to ACR (:sha + :latest)</li>
      <li class="flex items-start gap-1.5"><span class="text-slate-600 mt-0.5">&bull;</span> az containerapp update</li>
      <li class="flex items-start gap-1.5"><span class="text-slate-600 mt-0.5">&bull;</span> Health check (5 retries)</li>
    </ul>
  </div>
</div>`;
}

// ── Daemon Processes Diagram ────────────────────────────────────────────────

function daemonDiagram(): string {
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
  <!-- Box 1: Task Scheduler -->
  <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-5 w-5 items-center justify-center rounded bg-amber-400/10">
        <svg class="h-3 w-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
      </span>
      <p class="text-xs font-medium text-slate-300">Task Scheduler <span class="text-slate-500 font-normal">(5s poll)</span></p>
    </div>
    <ul class="space-y-1 text-xs text-slate-500">
      <li>Max concurrent: <span class="text-slate-400">5</span></li>
      <li>Max per user: <span class="text-slate-400">2</span></li>
      <li class="pt-1 text-slate-400">PENDING &rarr; runPipeline()</li>
      <li class="text-slate-400">APPROVED / REWORK &rarr; executeTask()</li>
    </ul>
  </div>

  <!-- Box 2: Producers -->
  <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-5 w-5 items-center justify-center rounded bg-blue-400/10">
        <svg class="h-3 w-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" /></svg>
      </span>
      <p class="text-xs font-medium text-slate-300">Producers <span class="text-slate-500 font-normal">(every 15 min, staggered)</span></p>
    </div>
    <div class="flex flex-wrap gap-1.5">
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">logScanner</span>
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">bugHunter</span>
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">securityScanner</span>
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">featureScout</span>
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">selfMonitor</span>
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">docAuditor</span>
    </div>
    <p class="mt-2 text-xs text-slate-500">Per-repo toggles &rarr; auto-create tasks</p>
  </div>

  <!-- Box 3: Retrospective -->
  <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-5 w-5 items-center justify-center rounded bg-emerald-400/10">
        <svg class="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.384 3.171 1.028-5.993L2.13 7.603l6.02-.875L11.42 1.5l3.27 5.228 6.02.875-4.934 4.745 1.028 5.993-5.384-3.17Z" /></svg>
      </span>
      <p class="text-xs font-medium text-slate-300">Retrospective <span class="text-slate-500 font-normal">(weekly)</span></p>
    </div>
    <ul class="space-y-1 text-xs text-slate-500">
      <li>Analyzes completed tasks</li>
      <li>Generates improvement proposals</li>
      <li>Identifies blind spots</li>
    </ul>
  </div>

  <!-- Box 4: Learning Lifecycle -->
  <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-5 w-5 items-center justify-center rounded bg-amber-400/10">
        <svg class="h-3 w-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5" /></svg>
      </span>
      <p class="text-xs font-medium text-slate-300">Keeper &amp; Decay</p>
    </div>
    <ul class="space-y-1 text-xs text-slate-500">
      <li>Monthly confidence decay: <span class="text-slate-400">&times;0.95</span></li>
      <li>Stale archival: confidence <span class="text-red-400">&lt;0.2</span></li>
      <li>Duplicate detection &amp; merge</li>
      <li>Scope promotion: repo &rarr; universal</li>
    </ul>
  </div>

  <!-- Box 5: Cleanup -->
  <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-5 w-5 items-center justify-center rounded bg-emerald-400/10">
        <svg class="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
      </span>
      <p class="text-xs font-medium text-slate-300">Cleanup <span class="text-slate-500 font-normal">(60s poll)</span></p>
    </div>
    <ul class="space-y-1 text-xs text-slate-500">
      <li>Expired previews: stop + remove worktree</li>
      <li>PR close/merge: stop preview + cleanup</li>
    </ul>
  </div>

  <!-- Box 6: Stale Recovery -->
  <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <div class="flex items-center gap-2 mb-2">
      <span class="flex h-5 w-5 items-center justify-center rounded bg-red-400/10">
        <svg class="h-3 w-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
      </span>
      <p class="text-xs font-medium text-slate-300">Stale Recovery</p>
    </div>
    <ul class="space-y-1 text-xs text-slate-500">
      <li>On startup: clean stale agents</li>
      <li>Stuck &gt;30min &rarr; <span class="text-red-400">FAILED</span></li>
      <li>Suspended tasks &rarr; resume on restart</li>
    </ul>
  </div>
</div>`;
}

// ── Tech Stack Diagram ──────────────────────────────────────────────────────

function techStackDiagram(): string {
  const categories: { label: string; items: string[]; color: string }[] = [
    { label: "Dashboard", items: ["Express.js", "HTMX", "TailwindCSS"], color: "amber" },
    { label: "Backend", items: ["TypeScript", "Node 20", "Zod"], color: "blue" },
    { label: "Database", items: ["PostgreSQL", "Drizzle ORM"], color: "emerald" },
    { label: "AI Engine", items: ["Claude API", "Sonnet / Opus"], color: "amber" },
    { label: "Infrastructure", items: ["Azure Container Apps", "ACR", "Key Vault", "Entra ID"], color: "blue" },
    { label: "Git Providers", items: ["GitHub (REST + GQL)", "Azure DevOps (REST v7.1)"], color: "emerald" },
    { label: "Preview Env", items: ["Docker TLS", "Port 4001+", "30min TTL"], color: "slate" },
  ];

  const boxes = categories
    .map((cat) => {
      const pillColors: Record<string, string> = {
        amber: "bg-amber-400/10 text-amber-400",
        blue: "bg-blue-400/10 text-blue-400",
        emerald: "bg-emerald-400/10 text-emerald-400",
        slate: "bg-slate-700 text-slate-300",
      };
      const pills = cat.items
        .map(
          (item) =>
            `<span class="inline-block rounded-full px-2 py-0.5 text-xs ${pillColors[cat.color]}">${item}</span>`,
        )
        .join("");

      return `<div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
    <p class="text-xs font-medium text-slate-300 mb-2">${cat.label}</p>
    <div class="flex flex-wrap gap-1.5">${pills}</div>
  </div>`;
    })
    .join("\n  ");

  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
  ${boxes}
</div>`;
}

// ── Preview Environments Diagram ─────────────────────────────────────────────

function previewDiagram(): string {
  return `<div class="space-y-4">
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <!-- Lifecycle -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Lifecycle</p>
      <div class="flex flex-wrap items-center gap-2">
        ${stateNode("Code Pushed", "blue")}
        ${arrow()}
        ${stateNode("Preview Starts", "amber")}
        ${arrow()}
        ${stateNode("Health Check", "amber")}
        ${arrow()}
        ${stateNode("Browser Validation", "amber")}
        ${arrow()}
        ${stateNode("Pass / Rework", "emerald")}
      </div>
    </div>

    <!-- Browser Validator -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Browser Validator</p>
      <p class="text-xs text-slate-400">Claude agent with headless Chromium — navigates preview URL, interactively verifies task requirements.</p>
      <ul class="mt-1.5 space-y-1 text-xs text-slate-500">
        <li>Max turns: <span class="text-slate-400">15</span></li>
        <li>Vision-capable model</li>
        <li>Fail &rarr; rework (up to max cycles)</li>
      </ul>
    </div>
  </div>

  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
    <!-- Preview Types -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Preview Types</p>
      <div class="flex flex-wrap gap-1.5">
        <span class="rounded-full bg-blue-400/10 px-2 py-0.5 text-xs text-blue-400">compose</span>
        <span class="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs text-amber-400">process</span>
        <span class="rounded-full bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-400">static</span>
      </div>
      <p class="mt-1.5 text-xs text-slate-500">Configured via <span class="text-slate-400">.hive.yaml</span> or repo settings</p>
    </div>

    <!-- Infrastructure -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Infrastructure</p>
      <ul class="space-y-1 text-xs text-slate-500">
        <li>Port range: <span class="text-slate-400">4001+</span></li>
        <li>TTL: <span class="text-slate-400">30 min</span></li>
        <li>Max concurrent: <span class="text-slate-400">3</span></li>
        <li>Docker TLS, health polls every <span class="text-slate-400">2s</span></li>
      </ul>
    </div>

    <!-- Cleanup -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Cleanup</p>
      <p class="text-xs text-slate-500">Auto every <span class="text-slate-400">60s</span> — expired previews stopped, worktree removed.</p>
      <p class="mt-1.5 text-xs text-slate-400"><a href="/instances" class="underline hover:text-slate-300">View instances &rarr;</a></p>
    </div>
  </div>
</div>`;
}

// ── PR Review Gate Diagram ──────────────────────────────────────────────────

function prReviewDiagram(): string {
  return `<div class="space-y-4">
  <!-- Top flow -->
  <div class="flex flex-wrap items-center gap-2">
    ${stateNode("Diff Collected", "blue")}
    ${arrow()}
    ${stateNode("Claude Reviews", "amber")}
    ${arrow()}
    ${stateNode("Pass → PR + Push", "emerald")}
    <span class="text-slate-500 text-xs">/</span>
    ${stateNode("Rework (max 2)", "red")}
    ${arrow()}
    ${stateNode("FAILED", "red")}
  </div>

  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <!-- Quality Analysis -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Quality Analysis</p>
      <p class="text-xs text-slate-500 mb-1.5">Severity:</p>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span class="rounded-full bg-red-400/10 px-2 py-0.5 text-xs text-red-400">major</span>
        <span class="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs text-amber-400">minor</span>
      </div>
      <p class="text-xs text-slate-500 mb-1.5">Categories:</p>
      <div class="flex flex-wrap gap-1.5">
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">correctness</span>
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">security</span>
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">performance</span>
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">maintainability</span>
      </div>
    </div>

    <!-- Verification -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Verification Checklist</p>
      <ul class="space-y-1.5 text-xs text-slate-400">
        <li class="flex items-center gap-2"><span class="text-emerald-400">&check;</span> Tests run</li>
        <li class="flex items-center gap-2"><span class="text-emerald-400">&check;</span> Tests passed</li>
        <li class="flex items-center gap-2"><span class="text-emerald-400">&check;</span> Lint clean</li>
        <li class="flex items-center gap-2"><span class="text-emerald-400">&check;</span> Build succeeded</li>
      </ul>
    </div>

    <!-- Feedback Loop -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Feedback Loop</p>
      <ul class="space-y-1 text-xs text-slate-500">
        <li>Reinforces or contradicts existing learnings</li>
        <li>Creates new learnings from findings</li>
      </ul>
    </div>

    <!-- Pattern Detection -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Pattern Detection</p>
      <p class="text-xs text-slate-500">Code-quality-analyst scans last <span class="text-slate-400">30 reviews</span>, auto-creates learnings for recurring patterns.</p>
    </div>
  </div>
</div>`;
}

// ── Docs Agent Diagram ──────────────────────────────────────────────────────

function docsAgentDiagram(): string {
  return `<div class="space-y-4">
  <!-- Docs Enricher -->
  <div>
    <p class="text-xs font-medium text-slate-300 mb-2">Docs Enricher</p>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs font-medium text-slate-400 mb-1.5">Root Files</p>
        <div class="flex flex-wrap gap-1.5">
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">README</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">CONTRIBUTING</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">CHANGELOG</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">CLAUDE.md</span>
        </div>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs font-medium text-slate-400 mb-1.5">Structured Dirs</p>
        <div class="flex flex-wrap gap-1.5">
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">docs/internal</span>
          <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">docs/external</span>
        </div>
      </div>
      <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
        <p class="text-xs font-medium text-slate-400 mb-1.5">Legacy Dirs</p>
        <p class="text-xs text-slate-500">Fallback scan for unstructured doc directories</p>
      </div>
    </div>
    <p class="mt-2 text-xs text-slate-500">Output &rarr; <span class="font-mono text-slate-400">task.enrichment.docs</span></p>
  </div>

  <div class="border-t border-slate-700 pt-4">
    <p class="text-xs font-medium text-slate-300 mb-2">Doc Auditor Producer</p>
    <p class="text-xs text-slate-500">Auto-discovers documentation issues — broken references, coverage gaps, freshness. Creates documentation tasks.</p>
  </div>
</div>`;
}

// ── Hivemind & Learnings Diagram ────────────────────────────────────────────

function hivemindDiagram(): string {
  return `<div class="space-y-4">
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <!-- Learning Structure -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Learning Structure</p>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span class="rounded-full bg-blue-400/10 px-2 py-0.5 text-xs text-blue-400">universal</span>
        <span class="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs text-amber-400">repo</span>
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">task</span>
      </div>
      <ul class="space-y-1 text-xs text-slate-500">
        <li>Confidence: <span class="text-slate-400">0 &ndash; 1</span></li>
        <li>Tracked reinforcements &amp; contradictions</li>
        <li>Categorized by domain</li>
      </ul>
    </div>

    <!-- Retrieval & Usage -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Retrieval &amp; Usage</p>
      <ul class="space-y-1 text-xs text-slate-500">
        <li>Scope matching + tag overlap</li>
        <li>Sorted by confidence, limit <span class="text-slate-400">10&ndash;15</span></li>
      </ul>
      <p class="mt-1.5 text-xs text-slate-500">Injected into:</p>
      <div class="flex flex-wrap gap-1.5 mt-1">
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">architect enricher</span>
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">execution agent</span>
        <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">gate prompts</span>
      </div>
    </div>

    <!-- Confidence Lifecycle -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Confidence Lifecycle</p>
      <ul class="space-y-1 text-xs text-slate-500">
        <li>Reinforce: <span class="text-emerald-400">+0.05</span></li>
        <li>Contradict: <span class="text-red-400">&minus;0.05 / &minus;0.10</span></li>
        <li>Monthly decay: <span class="text-slate-400">&times;0.95</span></li>
        <li>Archive at: <span class="text-red-400">&lt;0.2</span></li>
      </ul>
    </div>

    <!-- Feedback Loop -->
    <div class="rounded-lg border border-slate-600 bg-slate-900 p-3">
      <p class="text-xs font-medium text-slate-300 mb-2">Feedback Loop</p>
      <ul class="space-y-1 text-xs text-slate-500">
        <li>Pass &rarr; <span class="text-emerald-400">reinforce</span></li>
        <li>Rework &rarr; <span class="text-red-400">contradict</span></li>
        <li>Always create new learnings from findings</li>
      </ul>
    </div>
  </div>

  <p class="text-xs text-slate-500">Weekly retrospective analyzes completed tasks and updates learnings. <a href="/hivemind" class="text-slate-400 underline hover:text-slate-300">View hivemind &rarr;</a></p>
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

  <!-- Supporting diagrams -->
  <div class="space-y-3">
    ${detailsSection("State Machine", stateMachineDiagram())}
    ${detailsSection("CI/CD Pipeline", cicdDiagram())}
    ${detailsSection("Daemon Processes", daemonDiagram())}
    ${detailsSection("Tech Stack", techStackDiagram())}
    ${detailsSection("Preview Environments", previewDiagram())}
    ${detailsSection("PR Review Gate", prReviewDiagram())}
    ${detailsSection("Docs Agent", docsAgentDiagram())}
    ${detailsSection("Hivemind & Learnings", hivemindDiagram())}
  </div>
</div>

<script>
  // Scroll active stage into view after HTMX swaps the pipeline
  document.body.addEventListener("htmx:afterSwap", function(e) {
    if (e.detail.target && e.detail.target.id === "pipeline-container") {
      var el = document.getElementById("active-stage");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
</script>`;

  return layout("Workflow", content, user);
}
