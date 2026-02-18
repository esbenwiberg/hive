// Cost report views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type {
  DailyBreakdownRow,
  BreakdownRow,
  MonthlySummaryRow,
} from "../../db/queries/costs.js";
import {
  escapeHtml,
  statCard,
  card,
  table,
  emptyState,
} from "./components.js";
import { layout } from "./layout.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type BreakdownDimension = "user" | "repo" | "agent" | "model";

export interface CostsPageData {
  todayTotal: number;
  monthTotal: number;
  allTimeTotal: number;
  breakdown: BreakdownRow[];
  breakdownDimension: BreakdownDimension;
  dailyBreakdown: DailyBreakdownRow[];
  monthlySummary: MonthlySummaryRow[];
}

// ── Icons ───────────────────────────────────────────────────────────────────

const ICONS = {
  today: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
  month: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 9v9.75" /></svg>`,
  allTime: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ── Stat cards row ──────────────────────────────────────────────────────────

function costStatsRow(
  todayTotal: number,
  monthTotal: number,
  allTimeTotal: number,
): string {
  const cards = [
    statCard("Today's Cost", formatUsd(todayTotal), {
      icon: ICONS.today,
      color: "amber",
    }),
    statCard("This Month", formatUsd(monthTotal), {
      icon: ICONS.month,
      color: "blue",
    }),
    statCard("All Time", formatUsd(allTimeTotal), {
      icon: ICONS.allTime,
      color: "emerald",
    }),
  ];

  return `<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">${cards.join("")}</div>`;
}

// ── Dimension switcher tabs ─────────────────────────────────────────────────

const DIMENSION_LABELS: Record<BreakdownDimension, string> = {
  user: "By User",
  repo: "By Repo",
  agent: "By Agent",
  model: "By Model",
};

function dimensionTabs(active: BreakdownDimension): string {
  const tabs = (Object.keys(DIMENSION_LABELS) as BreakdownDimension[])
    .map((dim) => {
      const isActive = dim === active;
      const activeClasses =
        "border-amber-400 text-amber-400";
      const inactiveClasses =
        "border-transparent text-slate-400 hover:border-slate-600 hover:text-slate-300";

      return `<button
        class="border-b-2 px-4 py-2 text-sm font-medium transition-colors ${isActive ? activeClasses : inactiveClasses}"
        hx-get="/costs/breakdown?dimension=${dim}"
        hx-target="#breakdown-table"
        hx-swap="innerHTML">${escapeHtml(DIMENSION_LABELS[dim])}</button>`;
    })
    .join("");

  return `<div class="flex gap-1 border-b border-slate-700">${tabs}</div>`;
}

// ── Breakdown table (partial) ───────────────────────────────────────────────

/**
 * Renders just the breakdown table body. Exported so the HTMX partial
 * endpoint can return this fragment when switching dimensions.
 */
export function costsBreakdownPartial(
  rows: BreakdownRow[],
  dimension: BreakdownDimension,
): string {
  if (rows.length === 0) {
    return emptyState("No cost data for this dimension");
  }

  const dimensionHeader = DIMENSION_LABELS[dimension].replace("By ", "");
  const headers = [dimensionHeader, "Total (USD)", "Entries"];

  const tableRows = rows.map((r) => [
    `<span class="text-slate-50">${escapeHtml(r.dimension)}</span>`,
    `<span class="font-mono text-amber-400">${formatUsd(r.totalUsd)}</span>`,
    `<span class="text-slate-400">${r.count}</span>`,
  ]);

  return table(headers, tableRows);
}

// ── Breakdown section (full card with tabs) ─────────────────────────────────

function breakdownSection(
  rows: BreakdownRow[],
  dimension: BreakdownDimension,
): string {
  const inner = `
    ${dimensionTabs(dimension)}
    <div id="breakdown-table" class="mt-4">
      ${costsBreakdownPartial(rows, dimension)}
    </div>`;

  return card(inner, { title: "Cost Breakdown", padding: "compact" });
}

// ── Daily trend section ─────────────────────────────────────────────────────

function dailyTrendSection(rows: DailyBreakdownRow[]): string {
  if (rows.length === 0) {
    return card(emptyState("No daily cost data yet"), {
      title: "Daily Trend (last 30 days)",
    });
  }

  // Build a simple bar chart using inline styles
  const maxUsd = Math.max(...rows.map((r) => r.totalUsd), 0.01);

  const bars = rows
    .map((r) => {
      const pct = Math.round((r.totalUsd / maxUsd) * 100);
      const dateLabel = r.date.slice(5); // MM-DD
      return `<div class="flex flex-col items-center gap-1 flex-1 min-w-0" title="${escapeHtml(r.date)}: ${formatUsd(r.totalUsd)}">
        <div class="w-full flex flex-col justify-end h-32">
          <div class="w-full rounded-t bg-amber-400/80" style="height: ${pct}%"></div>
        </div>
        <span class="text-[10px] text-slate-500 truncate w-full text-center">${escapeHtml(dateLabel)}</span>
      </div>`;
    })
    .join("");

  const chart = `<div class="flex items-end gap-0.5 overflow-x-auto">${bars}</div>`;

  // Also show a summary table below
  const headers = ["Date", "Total (USD)", "Entries"];
  const tableRows = rows
    .slice()
    .reverse()
    .slice(0, 10)
    .map((r) => [
      `<span class="text-slate-50 font-mono text-xs">${escapeHtml(r.date)}</span>`,
      `<span class="font-mono text-amber-400">${formatUsd(r.totalUsd)}</span>`,
      `<span class="text-slate-400">${r.count}</span>`,
    ]);

  const inner = `
    ${chart}
    <div class="mt-6">
      <h4 class="text-sm font-medium text-slate-400 mb-2">Recent days</h4>
      ${table(headers, tableRows)}
    </div>`;

  return card(inner, { title: "Daily Trend (last 30 days)", padding: "compact" });
}

// ── Monthly summary section ─────────────────────────────────────────────────

function monthlySummarySection(rows: MonthlySummaryRow[]): string {
  if (rows.length === 0) {
    return card(emptyState("No monthly cost data yet"), {
      title: "Monthly Summary",
    });
  }

  const headers = ["Month", "Total (USD)", "Entries"];
  const tableRows = rows
    .slice()
    .reverse()
    .map((r) => [
      `<span class="text-slate-50 font-mono text-xs">${escapeHtml(r.month)}</span>`,
      `<span class="font-mono text-amber-400">${formatUsd(r.totalUsd)}</span>`,
      `<span class="text-slate-400">${r.count}</span>`,
    ]);

  return card(table(headers, tableRows), {
    title: "Monthly Summary",
    padding: "compact",
  });
}

// ── Exported view ───────────────────────────────────────────────────────────

/**
 * Full costs report page with stat cards, breakdown table, daily trend,
 * and monthly summary.
 */
export function costsPage(data: CostsPageData, user: SessionUser): string {
  const content = `<div class="space-y-8">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Cost Reports</h2>
    <p class="mt-1 text-sm text-slate-400">Track API spend across users, repos, agents, and models.</p>
  </div>

  <!-- Stat cards -->
  ${costStatsRow(data.todayTotal, data.monthTotal, data.allTimeTotal)}

  <!-- Breakdown -->
  ${breakdownSection(data.breakdown, data.breakdownDimension)}

  <!-- Two-column layout: daily trend + monthly summary -->
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
    ${dailyTrendSection(data.dailyBreakdown)}
    ${monthlySummarySection(data.monthlySummary)}
  </div>
</div>`;

  return layout("Costs", content, user);
}
