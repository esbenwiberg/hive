// Producer dashboard views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import {
  escapeHtml,
  badge,
  card,
  statCard,
  table,
  emptyState,
} from "./components.js";
import { layout } from "./layout.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProducerRun {
  id: number;
  producer: string;
  repo: string | null;
  tasksCreated: number | null;
  duplicatesSkipped: number | null;
  errors: unknown;
  costUsd: string | null;
  durationMs: number | null;
  createdAt: Date | null;
}

export interface ProducerData {
  name: string;
  runs: ProducerRun[];
  schedule: string | null;
  enabledRepos: string[];
  /** Current effective interval in ms (used to pre-select the dropdown). */
  intervalMs: number;
}

export interface ProducersPageData {
  producers: ProducerData[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function formatUsd(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return `$${num.toFixed(4)}`;
}

function getHealthStatus(runs: ProducerRun[]): { label: string; color: "emerald" | "red" | "slate" } {
  if (runs.length === 0) {
    return { label: "No runs", color: "slate" };
  }

  const lastRun = runs[0]; // runs are ordered DESC by createdAt
  const errors = Array.isArray(lastRun.errors) ? lastRun.errors : [];

  if (errors.length > 0) {
    return { label: "Errors", color: "red" };
  }

  return { label: "Healthy", color: "emerald" };
}

function timeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Summary Card (grid item) ────────────────────────────────────────────────

/**
 * Compact summary card for the producer grid.
 * Clicking opens the detail panel via HTMX.
 */
export function producerSummaryCard(producer: ProducerData): string {
  const health = getHealthStatus(producer.runs);
  const lastRun = producer.runs.length > 0 ? producer.runs[0] : null;
  const safeName = escapeHtml(producer.name);

  const lastRunInfo = lastRun?.createdAt
    ? `<span class="text-slate-300">${timeAgo(lastRun.createdAt)}</span>`
    : `<span class="text-slate-500">Never</span>`;

  const totalTasks = producer.runs.reduce((sum, r) => sum + (r.tasksCreated ?? 0), 0);
  const totalCost = producer.runs.reduce((sum, r) => sum + parseFloat(r.costUsd ?? "0"), 0);

  return `<div id="producer-card-${safeName}">
  <div class="rounded-xl border border-slate-700 bg-slate-800 p-4 cursor-pointer hover:border-slate-600 hover:bg-slate-800/80 transition-colors"
       hx-get="/producers/${safeName}"
       hx-target="#detail-panel"
       hx-swap="innerHTML">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-slate-50 truncate">${safeName}</h3>
      ${badge(health.label, health.color)}
    </div>
    <div class="space-y-1.5 text-xs">
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Schedule</span>
        <span class="text-slate-300">${producer.schedule ? escapeHtml(producer.schedule) : "\u2014"}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Repos</span>
        <span class="text-slate-300">${producer.enabledRepos.length}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Last Run</span>
        ${lastRunInfo}
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Total Tasks</span>
        <span class="text-slate-300">${totalTasks}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Total Cost</span>
        <span class="text-slate-300 font-mono">${formatUsd(totalCost)}</span>
      </div>
    </div>
  </div>
</div>`;
}

// ── Card Grid ───────────────────────────────────────────────────────────────

export function producerCardGrid(producers: ProducerData[]): string {
  if (producers.length === 0) {
    return emptyState("No producers configured");
  }

  const cards = producers.map((p) => producerSummaryCard(p)).join("");

  return `<div id="producer-grid" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
  ${cards}
</div>`;
}

// ── Detail Panel ────────────────────────────────────────────────────────────

/**
 * Full detail panel for a single producer — shown in the slide-out panel.
 * Contains health info, interval selector, stat cards, repo badges, and run history.
 */
export function producerDetailPanel(producer: ProducerData): string {
  const health = getHealthStatus(producer.runs);
  const lastRun = producer.runs.length > 0 ? producer.runs[0] : null;
  const safeName = escapeHtml(producer.name);

  // Repo badges row
  const repoBadgesHtml = producer.enabledRepos.length > 0
    ? `<div class="flex flex-wrap items-center gap-1.5">
        ${producer.enabledRepos.map((r) => badge(r, "blue")).join("")}
      </div>`
    : `<div>${badge("No repos enabled", "slate")}</div>`;

  // Interval selector options
  const intervalOptions = [
    { value: "30000", label: "30 seconds" },
    { value: "60000", label: "1 minute" },
    { value: "300000", label: "5 minutes" },
    { value: "900000", label: "15 minutes" },
    { value: "1800000", label: "30 minutes" },
    { value: "3600000", label: "1 hour" },
    { value: "14400000", label: "4 hours" },
  ];
  const currentInterval = String(producer.intervalMs);
  const intervalOptionsHtml = intervalOptions
    .map((o) => `<option value="${o.value}"${o.value === currentInterval ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");

  const intervalSelector = `
    <form class="flex items-center gap-2"
      hx-post="/api/producers/${safeName}/interval"
      hx-swap="none">
      <label class="text-xs text-slate-400 whitespace-nowrap">Poll interval</label>
      <select name="intervalMs"
        class="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">
        ${intervalOptionsHtml}
      </select>
      <button type="submit"
        class="rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-medium text-slate-900 hover:bg-amber-400 transition-colors">Save</button>
    </form>`;

  // Last run stats
  let statsHtml: string;
  if (lastRun) {
    const statsGrid = `<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      ${statCard("Tasks Created", lastRun.tasksCreated ?? 0, { color: "amber" })}
      ${statCard("Duplicates Skipped", lastRun.duplicatesSkipped ?? 0, { color: "slate" })}
      ${statCard("Cost", formatUsd(lastRun.costUsd ?? "0"), { color: "blue" })}
      ${statCard("Duration", lastRun.durationMs != null ? formatDuration(lastRun.durationMs) : "N/A", { color: "emerald" })}
    </div>`;

    const timestampHtml = lastRun.createdAt
      ? `<p class="text-xs text-slate-500">Last run: ${escapeHtml(formatTimestamp(lastRun.createdAt))}</p>`
      : "";

    statsHtml = statsGrid + timestampHtml;
  } else {
    statsHtml = emptyState("No runs recorded yet");
  }

  // Run history table (up to 5 recent runs)
  let historyHtml = "";
  if (producer.runs.length > 0) {
    const headers = ["Time", "Tasks", "Dupes", "Cost", "Duration", "Status"];
    const rows = producer.runs.slice(0, 5).map((run) => {
      const errors = Array.isArray(run.errors) ? run.errors : [];
      let statusCell: string;
      if (errors.length > 0) {
        const errorList = errors
          .map((e: unknown) => `<li class="text-red-400 text-xs">${escapeHtml(String(e))}</li>`)
          .join("");
        statusCell = `${badge(`${errors.length} error${errors.length > 1 ? "s" : ""}`, "red")}<ul class="mt-1 list-disc list-inside">${errorList}</ul>`;
      } else {
        statusCell = badge("OK", "emerald");
      }

      return [
        run.createdAt ? `<span class="font-mono text-xs">${escapeHtml(formatTimestamp(run.createdAt))}</span>` : "N/A",
        String(run.tasksCreated ?? 0),
        String(run.duplicatesSkipped ?? 0),
        `<span class="font-mono">${formatUsd(run.costUsd ?? "0")}</span>`,
        run.durationMs != null ? formatDuration(run.durationMs) : "N/A",
        statusCell,
      ];
    });

    historyHtml = `<div>
      <h4 class="text-sm font-medium text-slate-400 mb-2">Recent Runs</h4>
      ${table(headers, rows)}
    </div>`;
  }

  return `<div class="fixed inset-y-0 right-0 z-50 w-[680px] max-w-full overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl"
     style="transform: translateX(100%)">
  <div class="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700 bg-slate-900 px-6 py-4">
    <div class="flex items-center gap-2">
      <h2 class="text-lg font-semibold text-slate-50">${safeName}</h2>
      ${badge(health.label, health.color)}
      ${producer.schedule ? badge(producer.schedule, "emerald") : badge("No schedule", "slate")}
    </div>
    <button onclick="closePanel()"
            class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <div class="p-6 space-y-6">
    <!-- Interval Selector -->
    <div class="space-y-3">
      <h4 class="text-sm font-medium text-slate-300">Configuration</h4>
      ${intervalSelector}
    </div>

    <!-- Enabled Repos -->
    <div class="space-y-3">
      <h4 class="text-sm font-medium text-slate-300">Enabled Repos</h4>
      ${repoBadgesHtml}
    </div>

    <!-- Last Run Stats -->
    <div class="space-y-3">
      <h4 class="text-sm font-medium text-slate-300">Last Run</h4>
      ${statsHtml}
    </div>

    <!-- Run History -->
    ${historyHtml}
  </div>
</div>`;
}

// ── Legacy partial (kept for backward compat with existing callers) ─────────

/** @deprecated Use producerSummaryCard + producerDetailPanel instead */
export function producerCardPartial(producer: ProducerData): string {
  return producerSummaryCard(producer);
}

// ── Full page ───────────────────────────────────────────────────────────────

/**
 * Full producers dashboard page listing all producers as
 * summary cards in a responsive grid.
 */
export function producersPage(data: ProducersPageData, user: SessionUser): string {
  const content = `<div class="space-y-6">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Producers</h2>
    <p class="mt-1 text-sm text-slate-400">Monitor producer health, schedules, and run history.</p>
  </div>

  <!-- Producer Card Grid -->
  ${producerCardGrid(data.producers)}
</div>`;

  return layout("Producers", content, user);
}
