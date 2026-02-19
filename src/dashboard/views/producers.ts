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
}

export interface ProducersPageData {
  producers: ProducerData[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const PRODUCER_NAMES = [
  "bug-hunter",
  "feature-scout",
  "log-scanner",
  "security-scanner",
  "self-monitor",
];

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

// ── Producer card partial ───────────────────────────────────────────────────

/**
 * Renders a single producer card with health status, schedule info,
 * last run stats, and recent run history table.
 */
export function producerCardPartial(producer: ProducerData): string {
  const health = getHealthStatus(producer.runs);
  const lastRun = producer.runs.length > 0 ? producer.runs[0] : null;

  // Repo badges row
  const repoBadgesHtml = producer.enabledRepos.length > 0
    ? `<div class="flex flex-wrap items-center gap-1.5 mb-4">
        ${producer.enabledRepos.map((r) => badge(r, "blue")).join("")}
      </div>`
    : `<div class="mb-4">${badge("No repos enabled", "slate")}</div>`;

  // Header with name and health badge
  const headerHtml = `
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-lg font-semibold text-slate-50">${escapeHtml(producer.name)}</h3>
      <div class="flex items-center gap-2">
        ${badge(health.label, health.color)}
        ${producer.schedule ? badge(producer.schedule, "emerald") : badge("No schedule", "slate")}
      </div>
    </div>
    ${repoBadgesHtml}`;

  // Last run stats
  let statsHtml: string;
  if (lastRun) {
    const statsGrid = `<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
      ${statCard("Tasks Created", lastRun.tasksCreated ?? 0, { color: "amber" })}
      ${statCard("Duplicates Skipped", lastRun.duplicatesSkipped ?? 0, { color: "slate" })}
      ${statCard("Cost", formatUsd(lastRun.costUsd ?? "0"), { color: "blue" })}
      ${statCard("Duration", lastRun.durationMs != null ? formatDuration(lastRun.durationMs) : "N/A", { color: "emerald" })}
    </div>`;

    const timestampHtml = lastRun.createdAt
      ? `<p class="text-xs text-slate-500 mb-4">Last run: ${escapeHtml(formatTimestamp(lastRun.createdAt))}</p>`
      : "";

    statsHtml = statsGrid + timestampHtml;
  } else {
    statsHtml = `<div class="mb-4">${emptyState("No runs recorded yet")}</div>`;
  }

  // Run history table (up to 5 recent runs)
  let historyHtml = "";
  if (producer.runs.length > 0) {
    const headers = ["Time", "Tasks", "Dupes", "Cost", "Duration", "Status"];
    const rows = producer.runs.slice(0, 5).map((run) => {
      const errors = Array.isArray(run.errors) ? run.errors : [];
      const statusBadge = errors.length > 0
        ? badge(`${errors.length} error${errors.length > 1 ? "s" : ""}`, "red")
        : badge("OK", "emerald");

      return [
        run.createdAt ? `<span class="font-mono text-xs">${escapeHtml(formatTimestamp(run.createdAt))}</span>` : "N/A",
        String(run.tasksCreated ?? 0),
        String(run.duplicatesSkipped ?? 0),
        `<span class="font-mono">${formatUsd(run.costUsd ?? "0")}</span>`,
        run.durationMs != null ? formatDuration(run.durationMs) : "N/A",
        statusBadge,
      ];
    });

    historyHtml = `<div class="mt-2">
      <h4 class="text-sm font-medium text-slate-400 mb-2">Recent Runs</h4>
      ${table(headers, rows)}
    </div>`;
  }

  const content = headerHtml + statsHtml + historyHtml;
  return `<div id="producer-card-${escapeHtml(producer.name)}" class="mb-6">${card(content)}</div>`;
}

// ── Full page ───────────────────────────────────────────────────────────────

/**
 * Full producers dashboard page listing all producers with their
 * health status, config, and run history.
 */
export function producersPage(data: ProducersPageData, user: SessionUser): string {
  const producerCards = data.producers.length > 0
    ? data.producers.map((p) => producerCardPartial(p)).join("")
    : emptyState("No producers configured");

  const content = `<div class="space-y-6">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Producers</h2>
    <p class="mt-1 text-sm text-slate-400">Monitor producer health, schedules, and run history.</p>
  </div>

  <!-- Producer cards -->
  <div>
    ${producerCards}
  </div>
</div>`;

  return layout("Producers", content, user);
}
