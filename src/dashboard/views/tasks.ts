// Task list views — pure functions returning HTML strings

import type { SessionUser, TaskFilters } from "../../domain/types.js";
import type { TaskRow, RepoRow, TaskEventRow, CodeReviewRow, ActiveAgentRow, EnrichmentRunRow } from "../../db/schema.js";
import { BLUEPRINT_MARKDOWN_TEMPLATE } from "../../enrichers/external-blueprint.js";
import type { TaskCostBreakdownRow } from "../../db/queries/costs.js";
import { getAvailableActions, getAllowedTargets } from "../../domain/state-machine.js";
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
  pipelineDialog,
  emptyState,
  noAccessBanner,
  budgetExhaustedBanner,
} from "./components.js";
import { layout } from "./layout.js";

// ── Type extension for tasks with total cost ────────────────────────────────

type TaskWithCost = TaskRow & { totalCost?: number };

// ── Status filter tabs ──────────────────────────────────────────────────────

const ATTENTION_STATUSES = ["ready", "reviewing", "done", "failed"];

const STATUS_TABS = [
  { key: "attention", label: "Needs Attention" },
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "queued", label: "Queued" },
  { key: "enriching", label: "Enriching" },
  { key: "executing", label: "Executing" },
  { key: "reviewing", label: "Reviewing" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
  { key: "cancelled", label: "Archived" },
];

function filterTabs(
  activeStatus: string,
  counts: Record<string, number>,
): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const attentionCount = ATTENTION_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);

  const tabs = STATUS_TABS.map((tab) => {
    const cnt = tab.key === "" ? total : tab.key === "attention" ? attentionCount : (counts[tab.key] ?? 0);
    const isActive = tab.key === activeStatus;
    const activeClasses = isActive
      ? "border-amber-400 text-amber-400"
      : "border-transparent text-slate-400 hover:border-slate-600 hover:text-slate-300";

    const url = tab.key === "attention"
      ? `/api/tasks?status=attention`
      : tab.key ? `/api/tasks?status=${tab.key}` : "/api/tasks";

    return `<button
      class="inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${activeClasses}"
      hx-get="${url}"
      hx-target="#task-list"
      hx-swap="innerHTML">${escapeHtml(tab.label)}
      <span class="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">${cnt}</span>
    </button>`;
  });

  return `<div class="flex gap-1 border-b border-slate-700 overflow-x-auto">${tabs.join("")}</div>`;
}

// ── Creator label helper ─────────────────────────────────────────────────────

function creatorLabel(
  task: TaskRow,
  userNames: Map<number, string>,
): string {
  if (task.source.startsWith("producer:")) {
    const slug = task.source.slice("producer:".length);
    return slug
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return userNames.get(task.createdBy) ?? `User #${task.createdBy}`;
}

// ── Cost display helper ──────────────────────────────────────────────────────

function formatCost(cost?: number): string {
  if (cost === undefined || cost === 0) {
    return `<span class="text-slate-600">-</span>`;
  }
  return `<span class="text-slate-300">$${cost.toFixed(3)}</span>`;
}

function estimatedCost(task: TaskRow): number | undefined {
  const enrichment = task.enrichment as Record<string, unknown> | null;
  if (!enrichment?.scorer) return undefined;
  const scorer = enrichment.scorer as ScorerData;
  return scorer.costEstimate?.totalUsd;
}

// ── Task table ──────────────────────────────────────────────────────────────

function taskTable(tasks: TaskWithCost[], repoNames: Map<number, string>, userNames: Map<number, string> = new Map(), isAdmin = false): string {
  if (tasks.length === 0) {
    return emptyState(
      "No tasks found",
      button("Create Task", {
        attrs:
          'onclick="document.getElementById(\'create-panel\').classList.remove(\'translate-x-full\')"',
      }),
    );
  }

  const headers = [
    ...(isAdmin ? [""] : []),
    "ID", "Title", "Status", "Score", "Est. Cost", "Actual", "Repo", "Creator", "Updated", "Actions",
  ];

  const rows = tasks.map((t) => {
    const checkbox = isAdmin
      ? [`<input type="checkbox" class="bulk-select h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-400 focus:ring-amber-400" value="${escapeHtml(t.id)}" onclick="event.stopPropagation(); updateBulkCount()">`]
      : [];

    const id = `<span class="font-mono text-xs text-slate-400 cursor-pointer"
      hx-get="/api/tasks/${escapeHtml(t.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML">${escapeHtml(t.id)}</span>`;

    const title = `<span class="text-slate-50 font-medium">${escapeHtml(t.title)}</span>`;
    const status = statusBadge(t.status);
    const score = scorerInlineBadges(t) || `<span class="text-slate-600">-</span>`;
    const estCost = formatCost(estimatedCost(t));
    const actualCost = formatCost(t.totalCost);
    const repoLabel = repoNames.get(t.repoId) ?? `#${t.repoId}`;
    const repo = `<span class="text-xs text-slate-400">${escapeHtml(repoLabel)}</span>`;
    const creator = `<span class="text-xs text-slate-400">${escapeHtml(creatorLabel(t, userNames))}</span>`;
    const ts = t.updatedAt ?? t.createdAt;
    const updated = ts
      ? `<span class="text-xs text-slate-400">${escapeHtml(relativeTime(new Date(ts)))}</span>`
      : "-";
    const viewBtn = `<button class="text-xs text-amber-400 hover:text-amber-300"
      hx-get="/api/tasks/${escapeHtml(t.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML">View</button>`;

    return [...checkbox, id, title, status, score, estCost, actualCost, repo, creator, updated, viewBtn];
  });

  // Build table manually for row-level data attributes
  const selectAllTh = isAdmin
    ? `<th class="px-4 py-3"><input type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-400 focus:ring-amber-400" onclick="toggleSelectAll(this)"></th>`
    : "";
  const ths = headers
    .map((h, idx) =>
      isAdmin && idx === 0
        ? selectAllTh
        : `<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">${escapeHtml(h)}</th>`,
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

/** Checks if a value looks like a doc-file entry ({ path: string, summary: string }). */
function isDocEntry(item: unknown): item is { path: string; summary: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    "path" in item &&
    typeof (item as Record<string, unknown>).path === "string"
  );
}

/**
 * Renders an array of doc-file entries (objects with `path` and `summary`)
 * as a readable list of file paths with optional summary tooltips.
 */
function docFileList(files: unknown[]): string {
  if (files.length === 0) return `<span class="text-slate-500 italic">none</span>`;
  const items = files.map((f) => {
    if (isDocEntry(f)) {
      const tooltip = f.summary ? ` title="${escapeHtml(f.summary.slice(0, 200))}"` : "";
      return `<li class="py-0.5">
        <code class="text-xs text-slate-300 break-all"${tooltip}>${escapeHtml(f.path)}</code>
      </li>`;
    }
    // Fallback: render as plain string (shouldn't happen with well-formed data)
    return `<li class="py-0.5"><code class="text-xs text-slate-300">${escapeHtml(String(f))}</code></li>`;
  }).join("");
  return `<ul class="list-none space-y-0.5">${items}</ul>`;
}

/**
 * Dedicated renderer for the `docs` enricher result, which contains categorised
 * arrays of `{ path, summary }` objects.
 */
function docsEnrichmentContent(docs: Record<string, unknown>): string {
  const categories: Array<{ key: string; label: string }> = [
    { key: "internal", label: "Internal" },
    { key: "external", label: "External" },
    { key: "other", label: "Other" },
  ];

  const count = typeof docs.count === "number" ? docs.count : null;
  const countBadge = count !== null
    ? `<span class="ml-2 rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">${count}</span>`
    : "";

  const catSections = categories.map(({ key, label }) => {
    const arr = Array.isArray(docs[key]) ? (docs[key] as unknown[]) : [];
    if (arr.length === 0) return "";
    return `<div class="mb-3">
      <p class="text-xs font-medium text-slate-400 mb-1">${escapeHtml(label)}</p>
      ${docFileList(arr)}
    </div>`;
  }).filter(Boolean).join("");

  // Fall back to `files` if no categorised content rendered
  const hasCategories = categories.some(({ key }) => {
    const arr = docs[key];
    return Array.isArray(arr) && arr.length > 0;
  });

  if (!hasCategories) {
    const files = Array.isArray(docs.files) ? (docs.files as unknown[]) : [];
    return `<div>${countBadge ? `<p class="text-xs text-slate-400 mb-1">Files${countBadge}</p>` : ""}${docFileList(files)}</div>`;
  }

  return `<div>${countBadge ? `<p class="text-xs text-slate-400 mb-2">Total${countBadge}</p>` : ""}${catSections}</div>`;
}

function enrichmentSection(task: TaskRow): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;

  if (!enrichment || typeof enrichment !== "object" || Object.keys(enrichment).length === 0) {
    return "";
  }

  const sections = Object.entries(enrichment)
    .filter(([key]) => key !== "scorer" && key !== "architect")
    .map(([key, value]) => {
      // Use a dedicated renderer for the docs enricher to display file paths properly
      const isDocs = key === "docs" && typeof value === "object" && value !== null && !Array.isArray(value);
      const content = isDocs
        ? docsEnrichmentContent(value as Record<string, unknown>)
        : formatEnrichmentValue(value);
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
        let display: string;
        if (Array.isArray(v)) {
          // Render arrays of doc-like objects by extracting their `path` field
          if (v.length > 0 && isDocEntry(v[0])) {
            display = v.map((item) => isDocEntry(item) ? escapeHtml(item.path) : escapeHtml(String(item))).join(", ");
          } else {
            display = v.map((item) => escapeHtml(String(item))).join(", ");
          }
        } else if (typeof v === "object" && v !== null) {
          display = `<pre class="whitespace-pre-wrap text-xs text-slate-400">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
        } else {
          display = escapeHtml(String(v));
        }
        return `<div class="flex justify-between gap-4 py-1">
          <span class="text-slate-400 shrink-0">${escapeHtml(k)}</span>
          <span class="text-slate-200 text-right">${display}</span>
        </div>`;
      })
      .join("");
    return `<div class="divide-y divide-slate-800">${rows}</div>`;
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && isDocEntry(value[0])) {
      return docFileList(value);
    }
    return value.map((item) => escapeHtml(String(item))).join(", ");
  }

  return escapeHtml(String(value));
}

// ── Blueprint display ────────────────────────────────────────────────────────

interface BlueprintData {
  approach?: string;
  keyFiles?: string[];
  checklist?: string[];
  milestones?: {
    title: string;
    description: string;
    filesToModify: string[];
    acceptanceCriteria: string[];
  }[];
  clarificationQuestions?: string[];
  awaitingInput?: boolean;
  skipped?: boolean;
  skipPreview?: boolean;
}

function fileChips(files: string[]): string {
  if (files.length === 0) return "";
  const chips = files
    .map(
      (f) =>
        `<code class="inline-block rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">${escapeHtml(f)}</code>`,
    )
    .join(" ");
  return `<div class="flex flex-wrap gap-1.5 mt-2">${chips}</div>`;
}

function checklistHtml(items: string[]): string {
  if (items.length === 0) return "";
  const lis = items
    .map(
      (item) =>
        `<li class="flex items-start gap-2 py-0.5">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500"></span>
          <span>${escapeHtml(item)}</span>
        </li>`,
    )
    .join("");
  return `<ul class="mt-2 space-y-0.5 text-sm text-slate-300">${lis}</ul>`;
}

function milestonesHtml(milestones: BlueprintData["milestones"], completedCount = 0): string {
  if (!milestones || milestones.length === 0) return "";
  const items = milestones
    .map((m, i) => {
      const isCompleted = i < completedCount;
      const acItems = (m.acceptanceCriteria ?? [])
        .map(
          (ac) =>
            `<li class="flex items-start gap-2 py-0.5">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"></span>
              <span>${escapeHtml(ac)}</span>
            </li>`,
        )
        .join("");
      const acHtml = acItems
        ? `<ul class="mt-2 space-y-0.5 text-sm text-slate-300">${acItems}</ul>`
        : "";

      const numberBadge = isCompleted
        ? `<span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs text-emerald-400">&#10003;</span>`
        : `<span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-600 text-xs text-slate-400">${i + 1}</span>`;

      return `<details class="group">
        <summary class="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-800/50 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">
          ${numberBadge}
          <span class="flex-1">${escapeHtml(m.title)}</span>
          <svg class="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </summary>
        <div class="mt-1 px-3 py-2 text-sm text-slate-300">
          ${m.description ? `<p>${escapeHtml(m.description)}</p>` : ""}
          ${fileChips(m.filesToModify ?? [])}
          ${acHtml}
        </div>
      </details>`;
    })
    .join("");

  return `<div class="mt-3 space-y-2">${items}</div>`;
}

function blueprintSection(task: TaskRow): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;
  if (!enrichment?.architect) return "";

  const bp = enrichment.architect as BlueprintData;
  if (bp.skipped) return "";

  // ── Awaiting input (only show form when task is actually in ready status) ─
  if (bp.awaitingInput && bp.clarificationQuestions?.length && task.status === "ready") {
    const questionFields = bp.clarificationQuestions
      .map(
        (q, i) =>
          `<li class="space-y-1.5 py-1">
            <label class="flex items-start gap-2">
              <span class="shrink-0 text-amber-400 font-medium">${i + 1}.</span>
              <span class="text-sm text-slate-300">${escapeHtml(q)}</span>
            </label>
            <textarea name="answers" rows="2" placeholder="Your answer…"
              class="w-full rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:border-amber-500 focus:outline-none"></textarea>
          </li>`,
      )
      .join("");

    return `<div>
      <h4 class="text-sm font-medium text-slate-400 mb-2">Blueprint</h4>
      <div class="rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3">
        <div class="flex items-center gap-2 mb-2">
          ${badge("Awaiting Input", "amber")}
        </div>
        <form id="clarify-form-${escapeHtml(task.id)}" onsubmit="return false">
          <ul class="space-y-2">${questionFields}</ul>
          <div class="mt-3">
            ${button("Submit Answers", { variant: "primary", attrs: `type="button" onclick="submitClarification('${escapeHtml(task.id)}', this)"` })}
          </div>
        </form>
      </div>
    </div>`;
  }

  // ── No approach text → nothing to render ───────────────────────────────
  if (!bp.approach) return "";

  const skipPreviewNote = bp.skipPreview
    ? `<p class="mt-2 text-xs text-amber-400/80">Architect recommended skipping preview (no user-facing output)</p>`
    : "";

  // ── Small task (no milestones) ─────────────────────────────────────────
  if (!bp.milestones || bp.milestones.length === 0) {
    return `<div>
      <h4 class="text-sm font-medium text-slate-400 mb-2">Blueprint</h4>
      <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
        <p class="text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(bp.approach)}</p>
        ${fileChips(bp.keyFiles ?? [])}
        ${checklistHtml(bp.checklist ?? [])}
        ${skipPreviewNote}
      </div>
    </div>`;
  }

  // ── Medium/large task (milestones) ─────────────────────────────────────
  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Blueprint</h4>
    <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
      <p class="text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(bp.approach)}</p>
      ${milestonesHtml(bp.milestones, task.completedMilestones ?? 0)}
      ${skipPreviewNote}
    </div>
  </div>`;
}

// ── Scorer display ──────────────────────────────────────────────────────────

interface ScorerDimension {
  score: number;
  reasoning: string;
}

interface ScorerData {
  scores?: {
    value?: ScorerDimension;
    complexity?: ScorerDimension;
    risk?: ScorerDimension;
    feasibility?: ScorerDimension;
  };
  costEstimate?: {
    totalUsd?: number;
    breakdown?: { enrichment?: number; execution?: number; review?: number };
    reasoning?: string;
  };
  recommendation?: string;
  summary?: string;
  skipped?: boolean;
}

function scoreColor(score: number, invert = false): "emerald" | "amber" | "red" {
  if (invert) score = 11 - score;
  if (score >= 7) return "emerald";
  if (score >= 4) return "amber";
  return "red";
}

const invertedDimensions = new Set(["Complexity", "Risk"]);

function scoreBadge(label: string, dim: ScorerDimension): string {
  const color = scoreColor(dim.score, invertedDimensions.has(label));
  return `<div class="flex items-center justify-between py-1.5" title="${escapeHtml(dim.reasoning)}">
    <span class="text-xs text-slate-400">${escapeHtml(label)}</span>
    ${badge(`${dim.score}/10`, color)}
  </div>`;
}

function recommendationBadge(rec: string): string {
  const colors: Record<string, "emerald" | "red" | "amber"> = {
    approve: "emerald",
    reject: "red",
    rework: "amber",
  };
  return badge(rec, colors[rec] ?? "slate");
}

/**
 * Computes the total score from the four dimensions, accounting for polarity:
 * - value and feasibility: high raw score = good (used as-is)
 * - risk and complexity: low raw score = good (inverted via 11 - score)
 *
 * Returns the average of the four polarity-adjusted values on a 1–10 scale.
 */
export function computeTotalScore(scores: ScorerData["scores"]): number | null {
  if (!scores) return null;
  const { value, complexity, risk, feasibility } = scores;
  const dims = [
    value != null ? value.score : null,
    complexity != null ? (11 - complexity.score) : null,
    risk != null ? (11 - risk.score) : null,
    feasibility != null ? feasibility.score : null,
  ].filter((v): v is number => v !== null);
  if (dims.length === 0) return null;
  return dims.reduce((sum, v) => sum + v, 0) / dims.length;
}

/** Compact inline badges for the task list table row. */
function scorerInlineBadges(task: TaskRow): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;
  if (!enrichment?.scorer) return "";

  const scorer = enrichment.scorer as ScorerData;
  if (scorer.skipped) return "";

  const parts: string[] = [];
  if (scorer.recommendation) {
    parts.push(recommendationBadge(scorer.recommendation));
  }
  if (scorer.scores) {
    const total = computeTotalScore(scorer.scores);
    if (total !== null) {
      parts.push(badge(`${total.toFixed(1)}`, scoreColor(Math.round(total))));
    }
  }
  return parts.join(" ");
}

function scorerSection(task: TaskWithCost): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;
  if (!enrichment?.scorer) return "";

  const scorer = enrichment.scorer as ScorerData;
  if (scorer.skipped) return "";

  // Recommendation + summary
  const recHtml = scorer.recommendation
    ? `<div class="flex items-center gap-2 mb-3">
        ${recommendationBadge(scorer.recommendation)}
        ${scorer.summary ? `<span class="text-sm text-slate-300">${escapeHtml(scorer.summary)}</span>` : ""}
      </div>`
    : "";

  // Score badges
  const scoreRows: string[] = [];
  if (scorer.scores?.value) scoreRows.push(scoreBadge("Value", scorer.scores.value));
  if (scorer.scores?.complexity) scoreRows.push(scoreBadge("Complexity", scorer.scores.complexity));
  if (scorer.scores?.risk) scoreRows.push(scoreBadge("Risk", scorer.scores.risk));
  if (scorer.scores?.feasibility) scoreRows.push(scoreBadge("Feasibility", scorer.scores.feasibility));

  const scoresHtml = scoreRows.length > 0
    ? `<div class="divide-y divide-slate-700">${scoreRows.join("")}</div>`
    : "";

  // Cost estimate vs actual cost comparison
  let costHtml = "";
  if (scorer.costEstimate?.totalUsd != null || task.totalCost != null) {
    const estimated = scorer.costEstimate?.totalUsd ?? 0;
    const actual = task.totalCost ?? 0;
    const est = scorer.costEstimate;
    
    const breakdownParts: string[] = [];
    if (est?.breakdown?.enrichment != null) breakdownParts.push(`Enrich $${est.breakdown.enrichment.toFixed(2)}`);
    if (est?.breakdown?.execution != null) breakdownParts.push(`Exec $${est.breakdown.execution.toFixed(2)}`);
    if (est?.breakdown?.review != null) breakdownParts.push(`Review $${est.breakdown.review.toFixed(2)}`);

    const variance = actual > 0 && estimated > 0 ? ((actual - estimated) / estimated * 100) : 0;
    const varianceColor = variance > 10 ? "text-red-400" : variance < -10 ? "text-emerald-400" : "text-slate-400";
    const varianceText = variance !== 0 ? `<span class="${varianceColor}">(${variance > 0 ? '+' : ''}${variance.toFixed(0)}%)</span>` : "";

    costHtml = `<div class="mt-3 pt-3 border-t border-slate-700">
      <div class="space-y-1">
        ${estimated > 0 ? `<div class="flex items-center justify-between">
          <span class="text-xs text-slate-400">Est. Cost</span>
          <span class="text-sm text-slate-200">$${estimated.toFixed(2)}</span>
        </div>` : ""}
        ${actual > 0 ? `<div class="flex items-center justify-between">
          <span class="text-xs text-slate-400">Actual Cost</span>
          <span class="text-sm font-medium text-slate-200">$${actual.toFixed(3)} ${varianceText}</span>
        </div>` : ""}
      </div>
      ${breakdownParts.length > 0
        ? `<div class="flex gap-3 mt-2">${breakdownParts.map((p) => `<span class="text-xs text-slate-500">${escapeHtml(p)}</span>`).join("")}</div>`
        : ""}
    </div>`;
  }

  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Scorer</h4>
    <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
      ${recHtml}
      ${scoresHtml}
      ${costHtml}
    </div>
  </div>`;
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

// ── Review findings display ──────────────────────────────────────────────

interface ReworkHistoryEntry {
  cycle: number;
  findings?: { severity: string; file: string; line?: number; message: string; category?: string }[];
  securityFindings?: { severity: string; type: string; description: string; file?: string; advisory?: boolean }[];
  refinedInstructions?: string;
  timestamp?: string;
}

function severityColor(severity: string): "red" | "amber" | "slate" {
  if (severity === "critical" || severity === "high" || severity === "major") return "red";
  if (severity === "medium" || severity === "minor") return "amber";
  return "slate";
}

function findingsList(findings: ReworkHistoryEntry["findings"]): string {
  if (!findings || findings.length === 0) return "";
  const items = findings.map((f) =>
    `<div class="flex items-start gap-2 py-1.5">
      ${badge(f.severity, severityColor(f.severity))}
      <div class="min-w-0">
        <code class="text-xs text-slate-400">${escapeHtml(f.file)}${f.line ? `:${f.line}` : ""}</code>
        <p class="text-sm text-slate-300">${escapeHtml(f.message)}</p>
      </div>
    </div>`,
  ).join("");
  return `<div class="divide-y divide-slate-800">${items}</div>`;
}

function securityFindingsList(findings: ReworkHistoryEntry["securityFindings"]): string {
  if (!findings || findings.length === 0) return "";
  const items = findings.map((f) =>
    `<div class="flex items-start gap-2 py-1.5">
      ${badge(f.severity, severityColor(f.severity))}
      ${f.advisory ? badge("advisory", "slate") : ""}
      <div class="min-w-0">
        <span class="text-xs font-medium text-slate-400">${escapeHtml(f.type)}</span>
        ${f.file ? `<code class="ml-2 text-xs text-slate-500">${escapeHtml(f.file)}</code>` : ""}
        <p class="text-sm text-slate-300">${escapeHtml(f.description)}</p>
      </div>
    </div>`,
  ).join("");
  return `<div class="divide-y divide-slate-800">${items}</div>`;
}

function reviewFindingsSection(task: TaskRow): string {
  const history = task.reworkHistory as ReworkHistoryEntry[] | null;
  if (!history || !Array.isArray(history) || history.length === 0) return "";

  const cycles = history.map((entry) => {
    const hasFindings = entry.findings && entry.findings.length > 0;
    const hasSecFindings = entry.securityFindings && entry.securityFindings.length > 0;
    if (!hasFindings && !hasSecFindings) return "";

    return `<details class="group">
      <summary class="flex cursor-pointer items-center justify-between rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">
        Cycle ${entry.cycle}
        <span class="flex items-center gap-2">
          ${hasFindings ? `<span class="text-xs text-slate-400">${entry.findings!.length} finding${entry.findings!.length !== 1 ? "s" : ""}</span>` : ""}
          ${hasSecFindings ? `<span class="text-xs text-red-400">${entry.securityFindings!.length} security</span>` : ""}
          <svg class="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </span>
      </summary>
      <div class="mt-1 rounded-lg bg-slate-900 px-4 py-3 text-xs text-slate-300">
        ${findingsList(entry.findings)}
        ${hasSecFindings ? `<div class="mt-2 pt-2 border-t border-slate-800"><p class="text-xs font-medium text-red-400 mb-1">Security</p>${securityFindingsList(entry.securityFindings)}</div>` : ""}
      </div>
    </details>`;
  }).filter(Boolean).join("");

  if (!cycles) return "";

  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Rework History</h4>
    <div class="space-y-2">${cycles}</div>
  </div>`;
}

function latestReviewSection(review: CodeReviewRow): string {
  const findings = review.findings as ReworkHistoryEntry["findings"] | null;
  const secFindings = review.securityFindings as ReworkHistoryEntry["securityFindings"] | null;
  const hasFindings = findings && findings.length > 0;
  const hasSecFindings = secFindings && secFindings.length > 0;

  if (!hasFindings && !hasSecFindings) return "";

  const verdictColors: Record<string, "emerald" | "red" | "amber"> = {
    pass: "emerald",
    rework: "amber",
    fail: "red",
  };

  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Latest Review</h4>
    <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
      <div class="flex items-center gap-2 mb-3">
        ${badge(review.verdict, verdictColors[review.verdict] ?? "slate")}
        <span class="text-xs text-slate-400">Cycle ${review.reworkCycle ?? 0}</span>
      </div>
      ${hasFindings ? findingsList(findings) : ""}
      ${hasSecFindings ? `<div class="mt-2 pt-2 border-t border-slate-800"><p class="text-xs font-medium text-red-400 mb-1">Security</p>${securityFindingsList(secFindings)}</div>` : ""}
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

const PRE_EXECUTION_STATES: Set<string> = new Set(["pending", "queued", "enriching", "ready"]);

/** Returns the Preview meta row for the task detail panel (swappable via HTMX). */
export function previewMetaRow(task: TaskRow): string {
  const enrichment = task.enrichment as Record<string, unknown> | null;
  const architectRec = (enrichment?.architect as Record<string, unknown> | undefined)?.skipPreview === true;
  const canToggle = PRE_EXECUTION_STATES.has(task.status);

  const currentBadge = task.skipPreview ? badge("skip", "amber") : badge("enabled", "slate");
  const toggleBtn = canToggle
    ? ` <button class="ml-1 text-xs text-slate-400 hover:text-amber-400 underline"
        hx-post="/api/tasks/${escapeHtml(task.id)}/preview/toggle"
        hx-target="#preview-meta-row" hx-swap="outerHTML">${task.skipPreview ? "enable" : "skip"}</button>`
    : "";
  const architectNote = architectRec && !task.skipPreview
    ? ` <span class="text-xs text-slate-500">(architect recommended skip)</span>`
    : "";

  return `<div id="preview-meta-row" class="flex justify-between py-2">
    <span class="text-sm text-slate-400">Preview</span>
    <span class="text-sm text-slate-200">${currentBadge}${toggleBtn}${architectNote}</span>
  </div>`;
}

export function previewSection(task: TaskRow): string {
  if (!task.previewStatus && !task.previewUrl) {
    return "";
  }

  // Show persisted URL even without active preview status
  if (!task.previewStatus && task.previewUrl) {
    return `<h4 class="text-sm font-medium text-slate-400 mb-2">Preview</h4>
    <div class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
      <div class="flex items-center gap-2">
        <a href="${escapeHtml(task.previewUrl)}" target="_blank" rel="noopener"
           class="text-amber-400 hover:text-amber-300 underline text-sm">${escapeHtml(task.previewUrl)}</a>
      </div>
    </div>`;
  }

  const badgeHtml = previewStatusBadge(task.previewStatus!);

  let content = "";

  if (task.previewStatus === "running" && (task.previewPort || task.previewUrl)) {
    const previewLink = task.previewUrl
      ? `<a href="${escapeHtml(task.previewUrl)}" target="_blank" rel="noopener"
           class="text-amber-400 hover:text-amber-300 underline text-sm">${escapeHtml(task.previewUrl)}</a>`
      : `<a href="/preview/${escapeHtml(task.id)}/" target="_blank" rel="noopener"
           class="text-amber-400 hover:text-amber-300 underline text-sm">Open Preview</a>`;
    content = `<div class="flex items-center gap-2 mb-3">
        ${badgeHtml}
        ${previewLink}
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

// ── Activity log display ─────────────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  pipeline: "bg-blue-500/20 text-blue-300",
  router: "bg-purple-500/20 text-purple-300",
  gate: "bg-amber-500/20 text-amber-300",
  worker: "bg-emerald-500/20 text-emerald-300",
  scorer: "bg-cyan-500/20 text-cyan-300",
  architect: "bg-pink-500/20 text-pink-300",
};

function agentBadge(agent: string): string {
  const color = AGENT_COLORS[agent] ?? "bg-slate-500/20 text-slate-300";
  return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${color}">${escapeHtml(agent)}</span>`;
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

/**
 * Renders the activity event list HTML (used both inline and as an HTMX partial).
 */
export function activityEventList(events: TaskEventRow[]): string {
  if (events.length === 0) {
    return `<p class="text-sm text-slate-500 italic">No activity recorded yet</p>`;
  }

  const rows = events
    .map((e) => {
      const time = e.createdAt ? relativeTime(new Date(e.createdAt)) : "-";
      return `<div class="flex items-start gap-3 py-2">
        <span class="shrink-0 w-16 text-right text-xs text-slate-500 pt-0.5">${escapeHtml(time)}</span>
        <span class="shrink-0">${agentBadge(e.agent)}</span>
        <span class="text-sm text-slate-300">${escapeHtml(e.message).replace(/\n/g, "<br>")}</span>
      </div>`;
    })
    .join("");

  return `<div class="divide-y divide-slate-800">${rows}</div>`;
}

function activitySection(task: TaskRow, events: TaskEventRow[]): string {
  const isActive = ["enriching", "executing", "reviewing"].includes(task.status);
  const autoRefresh = isActive
    ? ` hx-get="/api/tasks/${escapeHtml(task.id)}/events" hx-trigger="every 5s" hx-swap="innerHTML"`
    : "";

  return `<div>
    <h4 class="text-sm font-medium text-slate-400 mb-2">Activity</h4>
    <div id="activity-log" class="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 max-h-80 overflow-y-auto"${autoRefresh}>
      ${activityEventList(events)}
    </div>
  </div>`;
}

// ── Debug panel ─────────────────────────────────────────────────────────────

const TRANSITIONAL_STATUSES = ["enriching", "executing", "reviewing"];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function stuckDiagnosis(task: TaskRow, agent: ActiveAgentRow | null): string {
  if (!TRANSITIONAL_STATUSES.includes(task.status)) {
    return `<div class="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2">
      <span class="h-2 w-2 rounded-full bg-slate-500"></span>
      <span class="text-sm text-slate-400">Idle — task is not in a transitional state</span>
    </div>`;
  }

  if (!agent) {
    return `<div class="flex items-center gap-2 rounded-lg bg-red-950/30 border border-red-500/20 px-4 py-2">
      <span class="h-2 w-2 rounded-full bg-red-500"></span>
      <span class="text-sm text-red-300">No active agent — likely stuck</span>
    </div>`;
  }

  const hbAge = agent.lastHeartbeatAt ? Date.now() - new Date(agent.lastHeartbeatAt).getTime() : Infinity;
  const TWO_MIN = 2 * 60 * 1000;
  const TEN_MIN = 10 * 60 * 1000;

  if (hbAge < TWO_MIN) {
    return `<div class="flex items-center gap-2 rounded-lg bg-emerald-950/30 border border-emerald-500/20 px-4 py-2">
      <span class="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
      <span class="text-sm text-emerald-300">Alive — heartbeat ${formatDuration(hbAge)} ago</span>
    </div>`;
  }

  if (hbAge < TEN_MIN) {
    return `<div class="flex items-center gap-2 rounded-lg bg-amber-950/30 border border-amber-500/20 px-4 py-2">
      <span class="h-2 w-2 rounded-full bg-amber-500"></span>
      <span class="text-sm text-amber-300">Slow — heartbeat ${formatDuration(hbAge)} ago</span>
    </div>`;
  }

  return `<div class="flex items-center gap-2 rounded-lg bg-red-950/30 border border-red-500/20 px-4 py-2">
    <span class="h-2 w-2 rounded-full bg-red-500"></span>
    <span class="text-sm text-red-300">Likely stuck — heartbeat ${formatDuration(hbAge)} ago</span>
  </div>`;
}

function debugAgentDetails(task: TaskRow, agent: ActiveAgentRow | null): string {
  if (!agent) return "";

  const hbAge = agent.lastHeartbeatAt ? formatDuration(Date.now() - new Date(agent.lastHeartbeatAt).getTime()) : "-";
  const started = agent.startedAt ? new Date(agent.startedAt).toLocaleString() : "-";
  const timeInStatus = task.updatedAt ? formatDuration(Date.now() - new Date(task.updatedAt).getTime()) : "-";

  const rows = [
    ["Agent", escapeHtml(agent.agent)],
    ["Model", escapeHtml(agent.model)],
    ["Phase", agent.phase ? escapeHtml(agent.phase) : `<span class="text-slate-500">-</span>`],
    ["Started", escapeHtml(started)],
    ["Heartbeat Age", hbAge],
    ["Time in Status", timeInStatus],
  ];

  const html = rows.map(([label, value]) =>
    `<div class="flex justify-between py-1.5">
      <span class="text-xs text-slate-400">${label}</span>
      <span class="text-xs text-slate-200">${value}</span>
    </div>`
  ).join("");

  return `<div>
    <h5 class="text-xs font-medium text-slate-400 mb-1">Agent</h5>
    <div class="divide-y divide-slate-800 rounded-lg bg-slate-900 px-3">${html}</div>
  </div>`;
}

function debugEnrichmentTable(runs: EnrichmentRunRow[]): string {
  if (runs.length === 0) return "";

  const rows = runs.map((r) => {
    const statusColors: Record<string, "emerald" | "amber" | "red" | "slate"> = {
      completed: "emerald",
      running: "amber",
      failed: "red",
      skipped: "slate",
    };
    const dur = r.durationMs != null ? formatDuration(r.durationMs) : "-";
    const cost = r.costUsd != null ? `$${parseFloat(r.costUsd).toFixed(4)}` : "-";
    const errHtml = r.error
      ? `<span class="text-red-400 truncate max-w-[200px] inline-block align-bottom" title="${escapeHtml(r.error)}">${escapeHtml(r.error.slice(0, 80))}${r.error.length > 80 ? "..." : ""}</span>`
      : "";

    return `<tr class="text-xs">
      <td class="py-1.5 pr-3 text-slate-300">${escapeHtml(r.enricher)}</td>
      <td class="py-1.5 pr-3">${badge(r.status, statusColors[r.status] ?? "slate")}</td>
      <td class="py-1.5 pr-3 text-slate-400">${dur}</td>
      <td class="py-1.5 pr-3 text-slate-400">${cost}</td>
      <td class="py-1.5 text-slate-400">${errHtml}</td>
    </tr>`;
  }).join("");

  return `<div>
    <h5 class="text-xs font-medium text-slate-400 mb-1">Enrichment Runs</h5>
    <div class="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2">
      <table class="w-full">
        <thead><tr class="text-xs text-slate-500">
          <th class="text-left py-1 pr-3">Enricher</th>
          <th class="text-left py-1 pr-3">Status</th>
          <th class="text-left py-1 pr-3">Duration</th>
          <th class="text-left py-1 pr-3">Cost</th>
          <th class="text-left py-1">Error</th>
        </tr></thead>
        <tbody class="divide-y divide-slate-800">${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function debugEventTimeline(events: TaskEventRow[]): string {
  if (events.length === 0) return "";

  const FIVE_MIN = 5 * 60 * 1000;

  const rows = events.map((e, i) => {
    const ts = e.createdAt ? new Date(e.createdAt) : null;
    const timeStr = ts ? ts.toLocaleTimeString() : "-";

    let gapHtml = "";
    if (i < events.length - 1) {
      const prev = events[i + 1].createdAt ? new Date(events[i + 1].createdAt!) : null;
      if (ts && prev) {
        const gapMs = ts.getTime() - prev.getTime();
        if (gapMs > 0) {
          const gapColor = gapMs > FIVE_MIN ? "text-red-400" : "text-slate-500";
          gapHtml = `<span class="${gapColor} text-xs ml-1">(+${formatDuration(gapMs)})</span>`;
        }
      }
    }

    return `<div class="flex items-start gap-2 py-1.5 text-xs">
      <span class="shrink-0 w-20 text-right text-slate-500">${escapeHtml(timeStr)}${gapHtml}</span>
      <span class="shrink-0">${agentBadge(e.agent)}</span>
      <span class="text-slate-300 truncate">${escapeHtml(e.message)}</span>
    </div>`;
  }).join("");

  return `<div>
    <h5 class="text-xs font-medium text-slate-400 mb-1">Event Timeline <span class="text-slate-500">(last ${events.length})</span></h5>
    <div class="rounded-lg bg-slate-900 px-3 py-2 max-h-60 overflow-y-auto divide-y divide-slate-800">${rows}</div>
  </div>`;
}

function debugCostTable(breakdown: TaskCostBreakdownRow[]): string {
  if (breakdown.length === 0) return "";

  const total = breakdown.reduce((sum, r) => sum + r.totalUsd, 0);

  const rows = breakdown.map((r) =>
    `<tr class="text-xs">
      <td class="py-1.5 pr-3 text-slate-300">${escapeHtml(r.agent)}</td>
      <td class="py-1.5 pr-3 text-slate-400">${escapeHtml(r.model)}</td>
      <td class="py-1.5 pr-3 text-slate-300">$${r.totalUsd.toFixed(4)}</td>
      <td class="py-1.5 pr-3 text-slate-400">${r.turns}</td>
      <td class="py-1.5 text-slate-400">${r.durationMs > 0 ? formatDuration(r.durationMs) : "-"}</td>
    </tr>`
  ).join("");

  return `<div>
    <h5 class="text-xs font-medium text-slate-400 mb-1">Cost Breakdown <span class="text-slate-300">$${total.toFixed(4)}</span></h5>
    <div class="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2">
      <table class="w-full">
        <thead><tr class="text-xs text-slate-500">
          <th class="text-left py-1 pr-3">Agent</th>
          <th class="text-left py-1 pr-3">Model</th>
          <th class="text-left py-1 pr-3">Cost</th>
          <th class="text-left py-1 pr-3">Turns</th>
          <th class="text-left py-1">Duration</th>
        </tr></thead>
        <tbody class="divide-y divide-slate-800">${rows}</tbody>
      </table>
    </div>
  </div>`;
}

export function taskDebugPanel(
  task: TaskRow,
  agent: ActiveAgentRow | null,
  enrichRuns: EnrichmentRunRow[],
  events: TaskEventRow[],
  costBreakdown: TaskCostBreakdownRow[],
): string {
  const isActive = TRANSITIONAL_STATUSES.includes(task.status);
  const autoRefresh = isActive
    ? ` hx-get="/api/tasks/${escapeHtml(task.id)}/debug" hx-trigger="every 5s" hx-swap="innerHTML"`
    : "";

  return `<div id="debug-content"${autoRefresh} class="space-y-4">
    ${stuckDiagnosis(task, agent)}
    ${debugAgentDetails(task, agent)}
    ${debugEnrichmentTable(enrichRuns)}
    ${debugEventTimeline(events)}
    ${debugCostTable(costBreakdown)}
  </div>`;
}

// ── Exported views ──────────────────────────────────────────────────────────

/**
 * Task list partial — just the filter tabs + table (for HTMX responses).
 */
export function taskListPartial(
  tasks: TaskWithCost[],
  counts: Record<string, number>,
  activeStatus?: string,
  repoNames: Map<number, string> = new Map(),
  userNames: Map<number, string> = new Map(),
  isAdmin = false,
): string {
  const bulkToolbar = isAdmin
    ? `<div id="bulk-toolbar" class="hidden mt-3 flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2">
        <span id="bulk-count" class="text-sm text-slate-300">0 selected</span>
        <button onclick="bulkDelete()" class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500">Delete Selected</button>
      </div>
      <script>
        function toggleSelectAll(el) {
          var boxes = document.querySelectorAll('.bulk-select');
          boxes.forEach(function(b) { b.checked = el.checked; });
          updateBulkCount();
        }
        function updateBulkCount() {
          var checked = document.querySelectorAll('.bulk-select:checked');
          var toolbar = document.getElementById('bulk-toolbar');
          var label = document.getElementById('bulk-count');
          if (checked.length > 0) {
            toolbar.classList.remove('hidden');
            label.textContent = checked.length + ' selected';
          } else {
            toolbar.classList.add('hidden');
          }
        }
        function bulkDelete() {
          var checked = document.querySelectorAll('.bulk-select:checked');
          var ids = Array.from(checked).map(function(b) { return b.value; });
          if (ids.length === 0) return;
          if (!confirm('Delete ' + ids.length + ' task(s)? This cannot be undone.')) return;
          htmx.ajax('POST', '/api/tasks/bulk-delete', {
            target: '#task-list', swap: 'innerHTML',
            values: { ids: JSON.stringify(ids) }
          });
        }
      </script>`
    : "";

  return `${filterTabs(activeStatus ?? "", counts)}
${bulkToolbar}
<div class="mt-4">${taskTable(tasks, repoNames, userNames, isAdmin)}</div>`;
}

/**
 * Full task list page with layout.
 */
export function taskListPage(
  tasks: TaskWithCost[],
  filters: TaskFilters,
  counts: Record<string, number>,
  user: SessionUser,
  repos: RepoRow[] = [],
  userNames: Map<number, string> = new Map(),
  selfRepoFullName?: string,
  accessibleRepoIds?: number[],
  budgetRemaining?: number,
): string {
  const activeStatus = filters?.statuses?.length ? "attention" : (filters?.status ?? "");
  const hasNoAccess = accessibleRepoIds !== undefined && accessibleRepoIds.length === 0;
  const budgetExhausted = budgetRemaining !== undefined && budgetRemaining <= 0;

  const header = `<div class="mb-6 flex items-center justify-between">
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Tasks</h2>
    <p class="mt-1 text-sm text-slate-400">Manage and monitor all Hive tasks</p>
  </div>
  ${hasNoAccess ? "" : button("New Task", {
    attrs:
      'onclick="document.getElementById(\'create-panel\').classList.remove(\'translate-x-full\')"',
  })}
</div>`;

  const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));

  const banners = [
    hasNoAccess ? noAccessBanner() : "",
    budgetExhausted ? budgetExhaustedBanner() : "",
  ].filter(Boolean).join("\n");

  const content = `${banners ? banners + "\n" : ""}${header}
<div id="task-list">
  ${taskListPartial(tasks, counts, activeStatus, repoNames, userNames, user.role === "admin")}
</div>

<!-- Create panel (slide-over) -->
${taskCreateForm(repos, user, selfRepoFullName)}`;

  return layout("Tasks", content, user);
}

/**
 * Task detail slide-over panel.
 */
export function taskDetailPanel(task: TaskWithCost, repoNames: Map<number, string> = new Map(), events: TaskEventRow[] = [], latestReview?: CodeReviewRow, userNames: Map<number, string> = new Map(), user?: SessionUser): string {
  const allActions = getAvailableActions(task.status);
  const isMaxCyclesFailed = task.failureReason?.includes("Max rework cycles")
    || task.failureReason?.includes("Browser validation failed after max");
  // Only show "Continue" when there are completed milestones to resume from
  // Only show "More Cycles" when the failure was specifically due to max rework cycles
  const isBrowserValidationFailed = task.failureReason?.includes("Browser validation failed") ?? false;
  const actions = allActions.filter((a) => {
    if (a.action === "continue") return (task.completedMilestones ?? 0) > 0;
    if (a.action === "more_cycles") return isMaxCyclesFailed;
    if (a.action === "accept_browser_validation") return isBrowserValidationFailed;
    return true;
  });

  const actionButtons = actions
    .map((a) => {
      const variant =
        a.action === "cancel" || a.action === "reject" || a.action === "fail"
          ? "danger"
          : a.action === "approve" ||
              a.action === "complete" ||
              a.action === "merge" ||
              a.action === "continue" ||
              a.action === "more_cycles" ||
              a.action === "accept_browser_validation"
            ? "primary"
            : "secondary";
      const hxVals = escapeHtml(JSON.stringify({ action: a.action, targetStatus: a.targetStatus }));
      return button(a.label, {
        variant: variant as "primary" | "secondary" | "danger",
        attrs: `data-action="${escapeHtml(a.action)}" hx-post="/api/tasks/${escapeHtml(task.id)}/transition" hx-vals='${hxVals}' hx-target="#task-list" hx-swap="innerHTML"`,
      });
    })
    .join("\n        ");

  // Milestone progress info
  const architectEnr = (task.enrichment as Record<string, unknown> | null)?.architect as BlueprintData | undefined;
  const totalMilestones = architectEnr?.milestones?.length ?? 0;
  const completedMs = task.completedMilestones ?? 0;

  const metaRows = [
    ["Status", statusBadge(task.status)],
    ["Type", task.type ? escapeHtml(task.type) : `<span class="text-slate-500">-</span>`],
    ["Size", task.size ? escapeHtml(task.size) : `<span class="text-slate-500">-</span>`],
    ["Workflow", task.workflow ? escapeHtml(task.workflow) : `<span class="text-slate-500">-</span>`],
    ...(totalMilestones > 0 ? [["Milestones", `<div class="flex items-center gap-2">
      <span class="text-sm text-slate-200">${completedMs}/${totalMilestones}</span>
      <div class="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div class="h-full ${completedMs === totalMilestones ? "bg-emerald-400" : "bg-amber-400"} rounded-full" style="width: ${Math.round((completedMs / totalMilestones) * 100)}%"></div>
      </div>
    </div>`]] : []),
    ["Repo", escapeHtml(repoNames.get(task.repoId) ?? `#${task.repoId}`)],
    ["Created By", escapeHtml(creatorLabel(task, userNames))],
    ["Total Cost", formatCost(task.totalCost)],
    ["Visibility", task.visibility === "private" ? badge("private", "amber") : badge("public", "slate")],
    ["Preview", null],
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

  if (events.length > 0 && events[0].createdAt) {
    metaRows.push(["Last Activity", escapeHtml(relativeTime(new Date(events[0].createdAt)))]);
  }

  const metaHtml = metaRows
    .map(
      ([label, value]) =>
        value === null
          ? previewMetaRow(task)
          : `<div class="flex justify-between py-2">
        <span class="text-sm text-slate-400">${label}</span>
        <span class="text-sm text-slate-200">${value}</span>
      </div>`,
    )
    .join("");

  const bodyHtml = task.body
    ? `<div class="mt-4 rounded-lg bg-slate-900 p-4 text-sm text-slate-300 whitespace-pre-wrap">${escapeHtml(task.body)}</div>`
    : "";

  return `<div class="fixed inset-y-0 right-0 z-40 w-[600px] border-l border-slate-700 bg-slate-800 shadow-xl overflow-y-auto">
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
      <div class="cursor-pointer group" onclick="var d=document.getElementById('pipeline-dialog');document.body.appendChild(d);d.classList.remove('hidden')" title="Click to view full pipeline">
        ${pipelineSteps(task.status)}
        <p class="mt-1 text-center text-xs text-slate-600 group-hover:text-slate-400 transition-colors">Click to view full pipeline</p>
      </div>
      ${pipelineDialog(task.status)}
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

    <!-- Scorer -->
    ${scorerSection(task)}

    <!-- Blueprint -->
    ${blueprintSection(task)}

    <!-- Enrichment -->
    ${enrichmentSection(task)}

    <!-- Gate Decision -->
    ${gateDecisionSection(task)}

    <!-- Review Findings -->
    ${latestReview ? latestReviewSection(latestReview) : ""}
    ${reviewFindingsSection(task)}

    <!-- Preview -->
    ${task.previewStatus || task.previewUrl ? `<div id="preview-section">${previewSection(task)}</div>` : ""}

    <!-- Activity -->
    ${activitySection(task, events)}

    <!-- Debug -->
    <div>
      <h4 class="text-sm font-medium text-slate-400 mb-2">Debug</h4>
      <div id="debug-panel">
        ${button("Load Debug Info", {
          variant: "secondary",
          attrs: `hx-get="/api/tasks/${escapeHtml(task.id)}/debug" hx-target="#debug-panel" hx-swap="innerHTML"`,
        })}
      </div>
    </div>

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
    ${(() => {
      const extraTargets = getAllowedTargets(task.status);
      if (extraTargets.length === 0) return "";
      const opts = extraTargets
        .map((t) => `<option value="${escapeHtml(t.status)}">${escapeHtml(t.label)}</option>`)
        .join("");
      return `<div>
        <select
          class="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-400 focus:border-amber-400 focus:outline-none"
          onchange="if(this.value){htmx.ajax('POST','/api/tasks/${escapeHtml(task.id)}/transition',{values:{targetStatus:this.value},target:'#task-list',swap:'innerHTML'});this.selectedIndex=0}">
          <option value="">Move to...</option>
          ${opts}
        </select>
      </div>`;
    })()}
    ${user?.role === "admin" ? `<div class="pt-3 border-t border-slate-700">
      ${button("Reset Task", {
        variant: "danger",
        attrs: `onclick="if(confirm('Reset this task to pending? All enrichment, gate, and execution state will be cleared.')){htmx.ajax('POST','/api/tasks/${escapeHtml(task.id)}/reset',{target:'#task-list',swap:'innerHTML'});document.getElementById('detail-panel').innerHTML=''}"`,
      })}
    </div>` : ""}
  </div>
</div>`;
}

/**
 * Task create form in a slide-over panel.
 *
 * @param repos            Available repositories.
 * @param user             Authenticated session user.
 * @param selfRepoFullName Full name of the self-managed Hive repo, if any.
 * @param blueprintErrors  Validation errors to show inline (triggers blueprint section open).
 * @param prefillBlueprint Pre-fill the blueprint textarea with this value on re-render.
 */
export function taskCreateForm(
  repos: RepoRow[],
  user?: SessionUser,
  selfRepoFullName?: string,
  blueprintErrors?: string[],
  prefillBlueprint?: string,
): string {
  const isAdmin = user?.role === "admin";
  const repoOptions = [
    { value: "", label: "Select a repository" },
    ...repos.map((r) => ({
      value: String(r.id),
      label: r.fullName + (selfRepoFullName && r.fullName === selfRepoFullName && !isAdmin ? " (admin only)" : ""),
    })),
  ];

  const previewRepoIds = repos
    .filter((r) => {
      const settings = (r.settings ?? {}) as Record<string, unknown>;
      const preview = (settings.preview ?? {}) as Record<string, unknown>;
      return preview.enabled === true;
    })
    .map((r) => String(r.id));

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
    ${select("repoId", "Repository", repoOptions, undefined, `onchange="toggleSkipPreview(this.value)"`)}
    ${select("type", "Type", typeOptions)}
    ${select("size", "Size", sizeOptions)}

    <label class="flex items-center gap-3 cursor-pointer">
      <input type="checkbox" name="visibility" value="private"
        class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-400 focus:ring-amber-400 focus:ring-offset-slate-900" />
      <span class="text-sm text-slate-300">Private</span>
      <span class="text-xs text-slate-500">(only visible to you and admins)</span>
    </label>

    <div id="skip-preview-wrap" class="hidden">
      <label class="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" name="skipPreview" value="true"
          class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-400 focus:ring-amber-400 focus:ring-offset-slate-900" />
        <span class="text-sm text-slate-300">Skip Preview</span>
        <span class="text-xs text-slate-500">(don't spin up a preview environment)</span>
      </label>
    </div>

    <!-- Blueprint toggle -->
    <div class="border-t border-slate-700 pt-4">
      <label class="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" id="blueprint-toggle"
          class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-400 focus:ring-amber-400 focus:ring-offset-slate-900"
          onchange="toggleBlueprintSection(this.checked)"
          ${blueprintErrors && blueprintErrors.length > 0 ? 'checked' : ''} />
        <span class="text-sm text-slate-300">I have a blueprint</span>
        <span class="text-xs text-slate-500">(paste a Markdown blueprint to skip architect generation)</span>
      </label>
    </div>

    <!-- Blueprint section (hidden by default, shown when errors present) -->
    <div id="blueprint-section" class="${blueprintErrors && blueprintErrors.length > 0 ? '' : 'hidden'} space-y-3">
      <div class="flex items-center justify-between">
        <label class="block text-sm font-medium text-slate-300" for="externalBlueprint">Blueprint (Markdown)</label>
        <button type="button"
          onclick="toggleBlueprintTemplate()"
          class="text-xs text-amber-400 hover:text-amber-300 underline underline-offset-2">
          Show template
        </button>
      </div>

      <!-- Inline validation errors (server-side) -->
      ${blueprintErrors && blueprintErrors.length > 0 ? `
      <div id="blueprint-error" class="rounded-md border border-red-600 bg-red-950/40 px-3 py-2 text-sm text-red-400">
        <p class="font-semibold mb-1">Blueprint validation failed:</p>
        <ul class="list-disc list-inside space-y-0.5">
          ${blueprintErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('\n          ')}
        </ul>
      </div>` : `
      <!-- Inline validation error (client-side) -->
      <div id="blueprint-error" class="hidden rounded-md border border-red-600 bg-red-950/40 px-3 py-2 text-sm text-red-400"></div>`}

      <!-- Template block (hidden by default) -->
      <div id="blueprint-template" class="hidden">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-slate-400 font-medium">Blueprint template</span>
          <button type="button"
            onclick="copyBlueprintTemplate()"
            class="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
            <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.688a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
            </svg>
            Copy
          </button>
        </div>
        <pre id="blueprint-template-content"
          class="max-h-64 overflow-y-auto rounded-md border border-slate-600 bg-slate-900 p-3 text-xs text-slate-300 whitespace-pre-wrap font-mono">${escapeHtml(BLUEPRINT_MARKDOWN_TEMPLATE)}</pre>
      </div>

      <textarea
        id="externalBlueprint"
        name="externalBlueprint"
        rows="10"
        placeholder="Paste your Markdown blueprint here…"
        class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-50 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 font-mono"
        oninput="clearBlueprintError()"
        ${blueprintErrors && blueprintErrors.length > 0 ? '' : 'disabled'}>${prefillBlueprint ? escapeHtml(prefillBlueprint) : ''}</textarea>
    </div>

    <script>
      var _previewRepoIds = ${JSON.stringify(previewRepoIds)};
      function toggleSkipPreview(repoId) {
        var wrap = document.getElementById('skip-preview-wrap');
        if (_previewRepoIds.includes(repoId)) { wrap.classList.remove('hidden'); }
        else { wrap.classList.add('hidden'); wrap.querySelector('input').checked = false; }
      }
      function toggleBlueprintSection(checked) {
        var section = document.getElementById('blueprint-section');
        var ta = document.getElementById('externalBlueprint');
        var tmpl = document.getElementById('blueprint-template');
        var err = document.getElementById('blueprint-error');
        if (checked) {
          section.classList.remove('hidden');
          ta.disabled = false;
        } else {
          section.classList.add('hidden');
          ta.disabled = true;
          ta.value = '';
          tmpl.classList.add('hidden');
          err.classList.add('hidden');
          err.textContent = '';
        }
      }
      function toggleBlueprintTemplate() {
        var tmpl = document.getElementById('blueprint-template');
        tmpl.classList.toggle('hidden');
      }
      function copyBlueprintTemplate() {
        var content = document.getElementById('blueprint-template-content').textContent;
        navigator.clipboard.writeText(content).catch(function() {
          var ta = document.createElement('textarea');
          ta.value = content;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
      }
      function clearBlueprintError() {
        var err = document.getElementById('blueprint-error');
        err.classList.add('hidden');
        err.textContent = '';
      }
      // Client-side validation before HTMX submit
      document.addEventListener('htmx:configRequest', function(evt) {
        var toggle = document.getElementById('blueprint-toggle');
        if (!toggle || !toggle.checked) return;
        var ta = document.getElementById('externalBlueprint');
        if (!ta || ta.value.trim() !== '') return;
        evt.preventDefault();
        var err = document.getElementById('blueprint-error');
        err.textContent = 'Please paste a blueprint or uncheck the "I have a blueprint" option.';
        err.classList.remove('hidden');
      });
    </script>

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