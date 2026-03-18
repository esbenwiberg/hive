// Hivemind knowledge explorer views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { LearningRow, LearningEventRow } from "../../db/schema.js";
import type { RetrospectiveReport } from "../../agents/retrospective.js";
import {
  escapeHtml,
  statCard,
  card,
  badge,
  button,
  emptyState,
} from "./components.js";
import { layout } from "./layout.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LearningUsageStats {
  usedLast7d: number;
  usedLast30d: number;
  neverUsed: number;
  stale: number;
  totalReinforcements: number;
  totalContradictions: number;
  mostReinforced: { id: number; content: string; reinforcements: number; confidence: string | null }[];
  recentlyUsed: { id: number; content: string; lastUsedAt: Date | null }[];
  eventsLast7d: { eventType: string; count: number }[];
  eventsLast30d: { eventType: string; count: number }[];
  dailyVolume: { date: string; count: number }[];
}

export interface HivemindPageData {
  stats: {
    total: number;
    active: number;
    archived: number;
    dismissed: number;
    avgConfidence: number;
    topCategories: { category: string; count: number }[];
    topScopes: { scope: string; count: number }[];
  };
  usageStats: LearningUsageStats;
  learnings: LearningRow[];
  total: number;
  currentPage: number;
  latestReport: RetrospectiveReport | null;
}

// ── Icons ───────────────────────────────────────────────────────────────────

const ICONS = {
  brain: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>`,
  active: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" /></svg>`,
  confidence: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6a7.5 7.5 0 1 0 7.5 7.5h-7.5V6Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 10.5H21A7.5 7.5 0 0 0 13.5 3v7.5Z" /></svg>`,
  archived: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function confidenceColor(confidence: number): "emerald" | "amber" | "red" {
  if (confidence > 0.7) return "emerald";
  if (confidence >= 0.4) return "amber";
  return "red";
}

function confidenceBarClasses(confidence: number): string {
  const color = confidenceColor(confidence);
  const colorMap: Record<string, string> = {
    emerald: "bg-emerald-400",
    amber: "bg-amber-400",
    red: "bg-red-400",
  };
  return colorMap[color];
}

function confidenceBar(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const barClass = confidenceBarClasses(confidence);
  return `<div class="flex items-center gap-2">
    <div class="h-2 flex-1 rounded-full bg-slate-700">
      <div class="${barClass} h-2 rounded-full transition-all" style="width: ${pct}%"></div>
    </div>
    <span class="text-xs font-mono text-slate-400 w-10 text-right">${pct}%</span>
  </div>`;
}

function relativeTime(date: Date | null): string {
  if (!date) return "Never";
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function scopeBadgeColor(scope: string): "blue" | "amber" | "emerald" | "slate" {
  if (scope === "universal") return "amber";
  if (scope.startsWith("repo:")) return "blue";
  if (scope.startsWith("task:")) return "emerald";
  return "slate";
}

const PAGE_SIZE = 20;

// ── Stat cards row ──────────────────────────────────────────────────────────

function statsRow(stats: HivemindPageData["stats"]): string {
  const avgPct = Math.round(stats.avgConfidence * 100);
  const cards = [
    statCard("Total Learnings", String(stats.total), {
      icon: ICONS.brain,
      color: "amber",
    }),
    statCard("Active", String(stats.active), {
      icon: ICONS.active,
      color: "emerald",
    }),
    statCard("Avg Confidence", `${avgPct}%`, {
      icon: ICONS.confidence,
      color: "blue",
    }),
    statCard("Archived", String(stats.archived), {
      icon: ICONS.archived,
      color: "slate",
    }),
  ];

  return `<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">${cards.join("")}</div>`;
}

// ── Usage stats section ─────────────────────────────────────────────────────

function eventCountForType(events: { eventType: string; count: number }[], type: string): number {
  return events.find((e) => e.eventType === type)?.count ?? 0;
}

function miniBar(value: number, max: number, color: string): string {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="h-1.5 w-full rounded-full bg-slate-700">
    <div class="${color} h-1.5 rounded-full" style="width: ${pct}%"></div>
  </div>`;
}

function activityBreakdown(
  label: string,
  events: { eventType: string; count: number }[],
): string {
  const total = events.reduce((sum, e) => sum + e.count, 0);
  const created = eventCountForType(events, "created");
  const reinforced = eventCountForType(events, "reinforced");
  const contradicted = eventCountForType(events, "contradicted");
  const superseded = eventCountForType(events, "superseded");
  const dismissed = eventCountForType(events, "dismissed");

  const row = (name: string, count: number, color: string, barColor: string) => `
    <div class="flex items-center gap-3">
      <span class="w-24 text-xs ${color} truncate">${name}</span>
      <div class="flex-1">${miniBar(count, total, barColor)}</div>
      <span class="w-8 text-right text-xs font-mono text-slate-400">${count}</span>
    </div>`;

  return `<div class="space-y-2">
    <div class="flex items-center justify-between">
      <h4 class="text-sm font-medium text-slate-300">${label}</h4>
      <span class="text-xs text-slate-500">${total} events</span>
    </div>
    <div class="space-y-1.5">
      ${row("Created", created, "text-blue-400", "bg-blue-400")}
      ${row("Reinforced", reinforced, "text-emerald-400", "bg-emerald-400")}
      ${row("Contradicted", contradicted, "text-red-400", "bg-red-400")}
      ${row("Superseded", superseded, "text-slate-400", "bg-slate-400")}
      ${row("Dismissed", dismissed, "text-amber-400", "bg-amber-400")}
    </div>
  </div>`;
}

function sparkline(dailyVolume: { date: string; count: number }[]): string {
  if (dailyVolume.length === 0) {
    return `<p class="text-xs text-slate-500">No activity data yet.</p>`;
  }

  const max = Math.max(...dailyVolume.map((d) => d.count), 1);
  const bars = dailyVolume.map((d) => {
    const heightPct = Math.max(Math.round((d.count / max) * 100), 4);
    const shortDate = d.date.slice(5); // MM-DD
    return `<div class="group relative flex flex-col items-center" style="flex: 1; min-width: 0">
      <div class="w-full flex items-end justify-center" style="height: 48px">
        <div class="w-full max-w-[12px] rounded-t bg-amber-400/70 hover:bg-amber-400 transition-colors" style="height: ${heightPct}%"></div>
      </div>
      <div class="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-200 whitespace-nowrap z-10">${shortDate}: ${d.count}</div>
    </div>`;
  });

  return `<div class="space-y-1">
    <div class="flex items-end gap-px">${bars.join("")}</div>
    <div class="flex justify-between text-[10px] text-slate-600">
      <span>${dailyVolume[0].date.slice(5)}</span>
      <span>${dailyVolume[dailyVolume.length - 1].date.slice(5)}</span>
    </div>
  </div>`;
}

function topLearningsTable(
  title: string,
  items: { id: number; label: string; value: string }[],
): string {
  if (items.length === 0) {
    return `<div class="space-y-2">
      <h4 class="text-sm font-medium text-slate-300">${title}</h4>
      <p class="text-xs text-slate-500">No data yet.</p>
    </div>`;
  }

  const rows = items
    .map(
      (item) => `<div class="flex items-center gap-3 rounded-lg bg-slate-900 px-3 py-2 cursor-pointer hover:bg-slate-800 transition-colors"
        hx-get="/hivemind/learnings/${item.id}"
        hx-target="#detail-panel"
        hx-swap="innerHTML">
      <span class="shrink-0 text-xs font-mono text-slate-500">#${item.id}</span>
      <span class="flex-1 text-xs text-slate-300 truncate">${escapeHtml(item.label)}</span>
      <span class="shrink-0 text-xs font-mono text-slate-400">${item.value}</span>
    </div>`,
    )
    .join("");

  return `<div class="space-y-2">
    <h4 class="text-sm font-medium text-slate-300">${title}</h4>
    <div class="space-y-1">${rows}</div>
  </div>`;
}

function usageStatsSection(usage: LearningUsageStats): string {
  // Retrieval stat mini-cards
  const retrievalCards = `<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Used (7d)</p>
      <p class="text-lg font-semibold text-emerald-400">${usage.usedLast7d}</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Used (30d)</p>
      <p class="text-lg font-semibold text-blue-400">${usage.usedLast30d}</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Never Used</p>
      <p class="text-lg font-semibold text-slate-400">${usage.neverUsed}</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Going Stale</p>
      <p class="text-lg font-semibold text-amber-400">${usage.stale}</p>
    </div>
  </div>`;

  // Totals row
  const totalsRow = `<div class="flex items-center gap-6">
    <div class="flex items-center gap-2">
      <svg class="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" /></svg>
      <span class="text-sm text-slate-300"><span class="font-semibold text-emerald-400">${usage.totalReinforcements}</span> total reinforcements</span>
    </div>
    <div class="flex items-center gap-2">
      <svg class="h-4 w-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
      <span class="text-sm text-slate-300"><span class="font-semibold text-red-400">${usage.totalContradictions}</span> total contradictions</span>
    </div>
  </div>`;

  // Most reinforced learnings
  const mostReinforcedTable = topLearningsTable(
    "Most Reinforced",
    usage.mostReinforced.map((l) => ({
      id: l.id,
      label: l.content,
      value: `${l.reinforcements}x`,
    })),
  );

  // Recently used learnings
  const recentlyUsedTable = topLearningsTable(
    "Recently Used",
    usage.recentlyUsed.map((l) => ({
      id: l.id,
      label: l.content,
      value: relativeTime(l.lastUsedAt),
    })),
  );

  const inner = `<div class="space-y-6">
    ${retrievalCards}
    ${totalsRow}

    <!-- Activity & Trend row -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div>${activityBreakdown("Last 7 Days", usage.eventsLast7d)}</div>
      <div>${activityBreakdown("Last 30 Days", usage.eventsLast30d)}</div>
      <div class="space-y-2">
        <h4 class="text-sm font-medium text-slate-300">Event Trend (30d)</h4>
        ${sparkline(usage.dailyVolume)}
      </div>
    </div>

    <!-- Top learnings row -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      ${mostReinforcedTable}
      ${recentlyUsedTable}
    </div>
  </div>`;

  return card(inner, { title: "Learning Usage", padding: "compact" });
}

// ── Filter controls ─────────────────────────────────────────────────────────

function filterControls(
  topCategories: { category: string; count: number }[],
  topScopes: { scope: string; count: number }[],
): string {
  const categoryOptions = topCategories
    .map(
      (c) =>
        `<option value="${escapeHtml(c.category)}">${escapeHtml(c.category)} (${c.count})</option>`,
    )
    .join("");

  const scopeOptions = topScopes
    .map(
      (s) =>
        `<option value="${escapeHtml(s.scope)}">${escapeHtml(s.scope)} (${s.count})</option>`,
    )
    .join("");

  return `<div class="flex flex-wrap items-end gap-4">
    <div class="space-y-1.5">
      <label for="scope-filter" class="block text-sm font-medium text-slate-300">Scope</label>
      <select id="scope-filter" name="scope"
        class="block w-40 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
        hx-get="/hivemind/learnings"
        hx-target="#learnings-list"
        hx-swap="innerHTML"
        hx-include="[name='category'],[name='minConfidence']">
        <option value="">All scopes</option>
        ${scopeOptions}
      </select>
    </div>

    <div class="space-y-1.5">
      <label for="category-filter" class="block text-sm font-medium text-slate-300">Category</label>
      <select id="category-filter" name="category"
        class="block w-44 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
        hx-get="/hivemind/learnings"
        hx-target="#learnings-list"
        hx-swap="innerHTML"
        hx-include="[name='scope'],[name='minConfidence']">
        <option value="">All categories</option>
        ${categoryOptions}
      </select>
    </div>

    <div class="space-y-1.5">
      <label for="confidence-filter" class="block text-sm font-medium text-slate-300">Min Confidence</label>
      <select id="confidence-filter" name="minConfidence"
        class="block w-36 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
        hx-get="/hivemind/learnings"
        hx-target="#learnings-list"
        hx-swap="innerHTML"
        hx-include="[name='scope'],[name='category']">
        <option value="">Any</option>
        <option value="0.3">30%+</option>
        <option value="0.5">50%+</option>
        <option value="0.7">70%+</option>
        <option value="0.9">90%+</option>
      </select>
    </div>
  </div>`;
}

// ── Learnings list partial ──────────────────────────────────────────────────

/**
 * Renders the paginated learnings list. Exported so the HTMX partial
 * endpoint can return this fragment when filtering/paging.
 */
export function learningsListPartial(
  learnings: LearningRow[],
  total: number,
  currentPage: number,
): string {
  if (learnings.length === 0) {
    return emptyState("No learnings found matching your filters");
  }

  const cards = learnings
    .map((l) => {
      const conf = parseFloat(String(l.confidence ?? "0.5"));
      const tags = (l.tags ?? [])
        .map((t) => `<span class="inline-flex items-center rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">${escapeHtml(t)}</span>`)
        .join("");

      return `<div class="rounded-xl border border-slate-700 bg-slate-800 p-4 hover:border-slate-600 transition-colors cursor-pointer"
          hx-get="/hivemind/learnings/${l.id}"
          hx-target="#detail-panel"
          hx-swap="innerHTML">
        <div class="space-y-3">
          <!-- Header: scope + category badges -->
          <div class="flex items-center gap-2 flex-wrap">
            ${badge(l.scope, scopeBadgeColor(l.scope))}
            ${badge(l.category, "slate")}
            ${l.dismissedAt != null ? badge("dismissed", "red") : l.supersededBy != null ? badge("archived", "red") : ""}
          </div>

          <!-- Confidence bar -->
          ${confidenceBar(conf)}

          <!-- Content -->
          <p class="text-sm text-slate-300 leading-relaxed">${escapeHtml(l.content)}</p>

          <!-- Meta row -->
          <div class="flex items-center gap-4 text-xs text-slate-500">
            <span title="Reinforcements" class="flex items-center gap-1">
              <svg class="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" /></svg>
              ${l.reinforcements ?? 0}
            </span>
            <span title="Contradictions" class="flex items-center gap-1">
              <svg class="h-3.5 w-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
              ${l.contradictions ?? 0}
            </span>
            <span title="Last used">Last used: ${relativeTime(l.lastUsedAt)}</span>
          </div>

          <!-- Tags -->
          ${tags ? `<div class="flex flex-wrap gap-1">${tags}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");

  // Pagination
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let pagination = "";
  if (totalPages > 1) {
    const pages: string[] = [];
    for (let p = 1; p <= totalPages; p++) {
      const isActive = p === currentPage;
      const activeClasses = isActive
        ? "bg-amber-400 text-slate-900 font-semibold"
        : "text-slate-400 hover:bg-slate-700 hover:text-slate-50";
      pages.push(
        `<button class="rounded-lg px-3 py-1.5 text-sm ${activeClasses}"
          hx-get="/hivemind/learnings?page=${p}"
          hx-target="#learnings-list"
          hx-swap="innerHTML"
          hx-include="[name='scope'],[name='category'],[name='minConfidence']">${p}</button>`,
      );
    }
    pagination = `<div class="flex items-center justify-between pt-4 border-t border-slate-700 mt-4">
      <span class="text-sm text-slate-400">${total} learning${total !== 1 ? "s" : ""} total</span>
      <div class="flex items-center gap-1">${pages.join("")}</div>
    </div>`;
  }

  return `<div class="space-y-3">${cards}</div>${pagination}`;
}

// ── Learning detail partial ─────────────────────────────────────────────────

/**
 * Renders a slide-over detail panel for a single learning.
 */
export function learningDetailPartial(
  learning: LearningRow,
  events: LearningEventRow[],
): string {
  const conf = parseFloat(String(learning.confidence ?? "0.5"));
  const confColor = confidenceColor(conf);
  const confColorClasses: Record<string, string> = {
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
  };

  const tags = (learning.tags ?? [])
    .map((t) => badge(t, "slate"))
    .join(" ");

  const sourceTaskIds = (learning.sourceTaskIds ?? [])
    .map((id) => `<a href="/tasks/${escapeHtml(id)}" class="text-amber-400 hover:underline text-sm font-mono">${escapeHtml(id)}</a>`)
    .join(", ");

  const eventTimeline = events.length > 0
    ? events
        .map((e) => {
          const typeColors: Record<string, string> = {
            created: "text-emerald-400",
            reinforced: "text-emerald-400",
            contradicted: "text-red-400",
            superseded: "text-slate-400",
            dismissed: "text-red-400",
          };
          const dotColors: Record<string, string> = {
            created: "bg-emerald-400",
            reinforced: "bg-emerald-400",
            contradicted: "bg-red-400",
            superseded: "bg-slate-400",
            dismissed: "bg-red-400",
          };
          const typeClass = typeColors[e.eventType] ?? "text-slate-400";
          const dotClass = dotColors[e.eventType] ?? "bg-slate-400";
          return `<div class="flex gap-3">
            <div class="flex flex-col items-center">
              <div class="${dotClass} h-2.5 w-2.5 rounded-full mt-1.5 shrink-0"></div>
              <div class="w-px flex-1 bg-slate-700"></div>
            </div>
            <div class="pb-4">
              <p class="text-sm font-medium ${typeClass}">${escapeHtml(e.eventType)}</p>
              ${e.taskId ? `<p class="text-xs text-slate-500 mt-0.5">Task: <a href="/tasks/${escapeHtml(e.taskId)}" class="text-amber-400 hover:underline">${escapeHtml(e.taskId)}</a></p>` : ""}
              ${e.evidence ? `<p class="text-xs text-slate-400 mt-0.5">${escapeHtml(e.evidence)}</p>` : ""}
              <p class="text-xs text-slate-500 mt-0.5">${e.createdAt ? relativeTime(e.createdAt) : ""}</p>
            </div>
          </div>`;
        })
        .join("")
    : `<p class="text-sm text-slate-500">No events recorded yet.</p>`;

  const panelContent = `
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-slate-700 px-6 py-4">
      <h3 class="text-lg font-semibold text-slate-50">Learning #${learning.id}</h3>
      <button onclick="document.getElementById('detail-panel').innerHTML='';document.getElementById('panel-backdrop').classList.add('hidden')"
              class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- Body -->
    <div class="overflow-y-auto px-6 py-4 space-y-6" style="max-height: calc(100vh - 64px)">
      <!-- Badges -->
      <div class="flex items-center gap-2 flex-wrap">
        ${badge(learning.scope, scopeBadgeColor(learning.scope))}
        ${badge(learning.category, "slate")}
        ${learning.dismissedAt != null ? badge("dismissed", "red") : learning.supersededBy != null ? badge("archived", "red") : badge("active", "emerald")}
      </div>

      <!-- Confidence -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-slate-300">Confidence</span>
          <span class="text-sm font-mono ${confColorClasses[confColor]}">${(conf * 100).toFixed(1)}%</span>
        </div>
        ${confidenceBar(conf)}
      </div>

      <!-- Content -->
      <div class="space-y-1">
        <h4 class="text-sm font-medium text-slate-400">Content</h4>
        <p class="text-sm text-slate-200 leading-relaxed rounded-lg bg-slate-900 p-3">${escapeHtml(learning.content)}</p>
      </div>

      <!-- Metadata grid -->
      <div class="grid grid-cols-2 gap-4">
        <div>
          <h4 class="text-xs font-medium text-slate-400 uppercase tracking-wider">Reinforcements</h4>
          <p class="mt-1 text-lg font-semibold text-emerald-400">${learning.reinforcements ?? 0}</p>
        </div>
        <div>
          <h4 class="text-xs font-medium text-slate-400 uppercase tracking-wider">Contradictions</h4>
          <p class="mt-1 text-lg font-semibold text-red-400">${learning.contradictions ?? 0}</p>
        </div>
        <div>
          <h4 class="text-xs font-medium text-slate-400 uppercase tracking-wider">Last Used</h4>
          <p class="mt-1 text-sm text-slate-300">${relativeTime(learning.lastUsedAt)}</p>
        </div>
        <div>
          <h4 class="text-xs font-medium text-slate-400 uppercase tracking-wider">Superseded By</h4>
          <p class="mt-1 text-sm text-slate-300">${learning.supersededBy != null ? `#${learning.supersededBy}` : "None"}</p>
        </div>
      </div>

      <!-- Tags -->
      ${tags ? `<div class="space-y-1">
        <h4 class="text-sm font-medium text-slate-400">Tags</h4>
        <div class="flex flex-wrap gap-1.5">${tags}</div>
      </div>` : ""}

      <!-- Source tasks -->
      ${sourceTaskIds ? `<div class="space-y-1">
        <h4 class="text-sm font-medium text-slate-400">Source Tasks</h4>
        <p>${sourceTaskIds}</p>
      </div>` : ""}

      <!-- Dates -->
      <div class="grid grid-cols-2 gap-4 border-t border-slate-700 pt-4">
        <div>
          <h4 class="text-xs font-medium text-slate-400 uppercase tracking-wider">Created</h4>
          <p class="mt-1 text-sm text-slate-300">${learning.createdAt ? new Date(learning.createdAt).toLocaleDateString() : "Unknown"}</p>
        </div>
        <div>
          <h4 class="text-xs font-medium text-slate-400 uppercase tracking-wider">Updated</h4>
          <p class="mt-1 text-sm text-slate-300">${learning.updatedAt ? new Date(learning.updatedAt).toLocaleDateString() : "Unknown"}</p>
        </div>
      </div>

      <!-- Dismiss action -->
      ${learning.dismissedAt == null && learning.supersededBy == null ? `
      <div class="border-t border-slate-700 pt-4">
        ${button("Dismiss Learning", {
          variant: "danger",
          attrs: `hx-post="/hivemind/learnings/${learning.id}/dismiss" hx-target="#detail-panel" hx-swap="innerHTML" hx-confirm="Dismiss this learning? It will be excluded from all agents and cannot be re-learned."`,
        })}
      </div>` : ""}

      <!-- Event history -->
      <div class="border-t border-slate-700 pt-4">
        <h4 class="text-sm font-medium text-slate-400 mb-3">Event History</h4>
        <div>${eventTimeline}</div>
      </div>
    </div>`;

  // Slide-over panel wrapper
  return `<div class="fixed inset-y-0 right-0 z-50 w-full max-w-md border-l border-slate-700 bg-slate-900 shadow-2xl">
  ${panelContent}
</div>
<script>
  document.getElementById('panel-backdrop').classList.remove('hidden');
  document.getElementById('panel-backdrop').classList.remove('opacity-0');
  document.getElementById('panel-backdrop').onclick = function() {
    document.getElementById('detail-panel').innerHTML = '';
    this.classList.add('hidden');
    this.classList.add('opacity-0');
  };
</script>`;
}

// ── Weekly report section ───────────────────────────────────────────────────

function weeklyReportSection(report: RetrospectiveReport): string {
  const m = report.metrics;
  const firstPassPct = Math.round(m.firstPassRate * 100);
  const reworkPct = Math.round(m.reworkRate * 100);
  const failurePct = Math.round(m.failureRate * 100);

  const metricsRow = `<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Tasks</p>
      <p class="text-lg font-semibold text-slate-50">${m.totalTasks}</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">First Pass</p>
      <p class="text-lg font-semibold text-emerald-400">${firstPassPct}%</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Rework</p>
      <p class="text-lg font-semibold text-amber-400">${reworkPct}%</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Failure</p>
      <p class="text-lg font-semibold text-red-400">${failurePct}%</p>
    </div>
    <div class="rounded-lg bg-slate-900 p-3 text-center">
      <p class="text-xs text-slate-400">Cost</p>
      <p class="text-lg font-semibold text-amber-400">$${m.totalCostUsd.toFixed(2)}</p>
    </div>
  </div>`;

  const blindSpots = report.blindSpots.length > 0
    ? `<div class="space-y-1">
        <h4 class="text-sm font-medium text-slate-400">Blind Spots</h4>
        <ul class="space-y-1">${report.blindSpots.map((b) => `<li class="flex items-start gap-2 text-sm text-slate-300"><span class="text-amber-400 mt-0.5 shrink-0">-</span> ${escapeHtml(b)}</li>`).join("")}</ul>
      </div>`
    : "";

  const costInsights = report.costInsights
    ? `<div class="space-y-1">
        <h4 class="text-sm font-medium text-slate-400">Cost Insights</h4>
        <p class="text-sm text-slate-300">${escapeHtml(report.costInsights)}</p>
      </div>`
    : "";

  const inner = `
    <div class="space-y-4">
      <p class="text-sm text-slate-300 leading-relaxed">${escapeHtml(report.summary)}</p>
      ${metricsRow}
      ${blindSpots}
      ${costInsights}
    </div>`;

  return card(inner, { title: "Weekly Retrospective", padding: "compact" });
}

// ── Exported view ───────────────────────────────────────────────────────────

/**
 * Full hivemind knowledge explorer page with stat cards, filters,
 * learnings list, and weekly report.
 */
export function hivemindPage(data: HivemindPageData, user: SessionUser): string {
  const content = `<div class="space-y-8">
  <!-- Header -->
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="text-xl font-semibold text-slate-50">Hivemind Knowledge Explorer</h2>
      <p class="mt-1 text-sm text-slate-400">Browse, filter, and inspect the structured learnings that guide autonomous agents.</p>
    </div>
    <button class="inline-flex items-center gap-2 shrink-0 rounded-lg border border-amber-800/50 bg-amber-950/30 px-4 py-2 text-sm font-medium text-amber-400 transition-colors hover:bg-amber-900/40"
            hx-post="/hivemind/curate"
            hx-target="#learnings-list"
            hx-swap="innerHTML"
            hx-confirm="Run a full cleanup cycle? This applies confidence decay, archives stale learnings, and runs the keeper agent for dedup."
            hx-indicator="#curate-spinner">
      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.182" /></svg>
      <span>Force Cleanup</span>
      <svg id="curate-spinner" class="htmx-indicator h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
    </button>
  </div>

  <!-- Stat cards -->
  ${statsRow(data.stats)}

  <!-- Learning usage stats -->
  ${usageStatsSection(data.usageStats)}

  <!-- Filters + learnings list -->
  ${card(`
    ${filterControls(data.stats.topCategories, data.stats.topScopes)}
    <div id="learnings-list" class="mt-4">
      ${learningsListPartial(data.learnings, data.total, data.currentPage)}
    </div>
  `, { title: "Learnings", padding: "compact" })}

  <!-- Weekly report -->
  ${data.latestReport ? weeklyReportSection(data.latestReport) : ""}
</div>`;

  return layout("Hivemind", content, user);
}
