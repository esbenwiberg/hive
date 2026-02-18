// Dashboard home view — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { TaskRow, ActiveAgentRow } from "../../db/schema.js";
import {
  escapeHtml,
  statCard,
  statusBadge,
  card,
  table,
  emptyState,
} from "./components.js";
import { layout } from "./layout.js";

// ── Icons for stat cards (inline SVG) ───────────────────────────────────────

const ICONS = {
  total: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" /></svg>`,
  pending: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
  executing: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" /></svg>`,
  done: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
  failed: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>`,
  cost: `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
};

// ── Stat cards row ──────────────────────────────────────────────────────────

function statsRow(stats: Record<string, number>, todayCost: number): string {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const costDisplay = `$${todayCost.toFixed(2)}`;

  const cards = [
    statCard("Total Tasks", total, { icon: ICONS.total, color: "slate" }),
    statCard("Pending", stats.pending ?? 0, {
      icon: ICONS.pending,
      color: "slate",
    }),
    statCard("Executing", stats.executing ?? 0, {
      icon: ICONS.executing,
      color: "amber",
    }),
    statCard("Done", stats.done ?? 0, { icon: ICONS.done, color: "emerald" }),
    statCard("Failed", stats.failed ?? 0, {
      icon: ICONS.failed,
      color: "red",
    }),
    statCard("Today's Cost", costDisplay, {
      icon: ICONS.cost,
      color: "amber",
    }),
  ];

  return `<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">${cards.join("")}</div>`;
}

// ── Recent tasks table ──────────────────────────────────────────────────────

function recentTasksSection(tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return card(emptyState("No tasks yet", ""), { title: "Recent Tasks" });
  }

  const headers = ["ID", "Title", "Status", "Created"];
  const rows = tasks.map((t) => [
    `<span class="font-mono text-xs text-slate-400 cursor-pointer"
      hx-get="/api/tasks/${escapeHtml(t.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML">${escapeHtml(t.id)}</span>`,
    `<span class="text-slate-50">${escapeHtml(t.title)}</span>`,
    statusBadge(t.status),
    t.createdAt
      ? `<span class="text-xs text-slate-400">${escapeHtml(new Date(t.createdAt).toLocaleDateString())}</span>`
      : "-",
  ]);

  return card(table(headers, rows), { title: "Recent Tasks", padding: "compact" });
}

// ── Active agents section ───────────────────────────────────────────────────

function activeAgentsSection(agents: ActiveAgentRow[]): string {
  if (agents.length === 0) {
    return card(
      emptyState("No active agents"),
      { title: "Active Agents" },
    );
  }

  const headers = ["Task", "Agent", "Model", "Phase", "Started"];
  const rows = agents.map((a) => [
    `<span class="font-mono text-xs text-slate-400">${escapeHtml(a.taskId)}</span>`,
    `<span class="text-slate-50">${escapeHtml(a.agent)}</span>`,
    `<span class="text-xs text-slate-400">${escapeHtml(a.model)}</span>`,
    a.phase ? statusBadge(a.phase) : `<span class="text-slate-500">-</span>`,
    a.startedAt
      ? `<span class="text-xs text-slate-400">${escapeHtml(new Date(a.startedAt).toLocaleString())}</span>`
      : "-",
  ]);

  return card(table(headers, rows), {
    title: "Active Agents",
    padding: "compact",
  });
}

// ── Exported view ───────────────────────────────────────────────────────────

/**
 * Dashboard overview page with stat cards, recent tasks, and active agents.
 */
export function dashboardPage(
  stats: Record<string, number>,
  recentTasks: TaskRow[],
  activeAgents: ActiveAgentRow[],
  user: SessionUser,
  todayCost: number = 0,
): string {
  const content = `<div class="space-y-8">
  <!-- Welcome -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Welcome back, ${escapeHtml(user.displayName)}</h2>
    <p class="mt-1 text-sm text-slate-400">Here's what's happening across your Hive tasks.</p>
  </div>

  <!-- Stat cards -->
  ${statsRow(stats, todayCost)}

  <!-- Two-column layout -->
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
    ${recentTasksSection(recentTasks)}
    ${activeAgentsSection(activeAgents)}
  </div>
</div>`;

  return layout("Dashboard", content, user);
}
