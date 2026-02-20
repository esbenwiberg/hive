import type { SessionUser } from "../../domain/types.js";
import type { PreviewInstanceRow } from "../../db/queries/preview-instances.js";
import type { PreviewInfo } from "../../execution/preview/types.js";
import { layout } from "./layout.js";
import { statCard, badge, table, card, emptyState, escapeHtml, button } from "./components.js";

// ── Badge colors for preview status ──────────────────────────────────────────

function previewBadge(status: string, isLive: boolean): string {
  if (status === "running" && !isLive) {
    return badge("running", "amber") +
      ` <span title="DB says running but not in memory" class="text-amber-400">&#9888;</span>`;
  }

  const colors: Record<string, "emerald" | "amber" | "red" | "slate"> = {
    running: "emerald",
    starting: "amber",
    failed: "red",
    stopped: "slate",
  };
  return badge(status, colors[status] ?? "slate");
}

// ── Duration helper ──────────────────────────────────────────────────────────

function formatDuration(startedAt: Date | null): string {
  if (!startedAt) return "\u2014";
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

// ── Table partial (for HTMX refresh) ────────────────────────────────────────

export function instancesTablePartial(
  instances: PreviewInstanceRow[],
  liveMap: ReadonlyMap<string, PreviewInfo>,
): string {
  if (instances.length === 0) {
    return emptyState("No preview instances found");
  }

  const rows = instances.map((i) => {
    const live = liveMap.get(i.taskId);
    const taskLink = `<a href="/tasks/${escapeHtml(i.taskId)}" class="text-amber-400 hover:underline">${escapeHtml(i.taskId.slice(0, 8))}</a>`;
    const repo = i.repoFullName ? escapeHtml(i.repoFullName) : "\u2014";
    const type = live ? escapeHtml(live.type) : "\u2014";
    const port = i.previewPort != null ? String(i.previewPort) : "\u2014";
    const statusHtml = previewBadge(i.previewStatus, !!live);
    const started = i.previewStartedAt
      ? new Date(i.previewStartedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })
      : "\u2014";
    const duration = formatDuration(i.previewStartedAt);

    const actions = i.previewStatus === "running"
      ? button("Stop", {
          variant: "danger",
          attrs: `hx-post="/instances/${escapeHtml(i.taskId)}/stop" hx-target="#instances-table" hx-swap="innerHTML"`,
        })
      : "";

    return [taskLink, escapeHtml(i.title.slice(0, 50)), repo, type, port, statusHtml, started, duration, actions];
  });

  return table(
    ["Task", "Title", "Repo", "Type", "Port", "Status", "Started", "Duration", "Actions"],
    rows,
  );
}

// ── Full page ───────────────────────────────────────────────────────────────

export function instancesPage(
  instances: PreviewInstanceRow[],
  liveMap: ReadonlyMap<string, PreviewInfo>,
  maxConcurrent: number,
  portRange: [number, number],
  user: SessionUser,
): string {
  const running = instances.filter((i) => i.previewStatus === "running").length;
  const portsInUse = instances.filter((i) => i.previewPort != null && i.previewStatus === "running").length;

  const content = `<div class="space-y-8">
    <div>
      <h2 class="text-xl font-semibold text-slate-50">Preview Instances</h2>
      <p class="mt-1 text-sm text-slate-400">Active preview environments and their status. Auto-refreshes every 10s.</p>
    </div>

    <!-- Stat cards -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      ${statCard("Running", running, { color: "emerald" })}
      ${statCard("Ports in Use", `${portsInUse} / ${portRange[1] - portRange[0] + 1}`, { color: "blue" })}
      ${statCard("Max Concurrent", maxConcurrent, { color: "amber" })}
    </div>

    <!-- Table -->
    ${card(`
      <div id="instances-table" hx-get="/instances/partial" hx-trigger="every 10s" hx-swap="innerHTML">
        ${instancesTablePartial(instances, liveMap)}
      </div>
    `, { title: "Instances" })}
  </div>`;

  return layout("Instances", content, user);
}
