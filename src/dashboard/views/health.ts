import type { SessionUser } from "../../domain/types.js";
import { statCard, card, button, badge, escapeHtml } from "./components.js";
import { layout } from "./layout.js";

export interface SystemStats {
  cpuPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  diskUsedGB: number;
  diskTotalGB: number;
  uptimeSeconds: number;
  loadAvg: number[];
}

function progressBar(percent: number, color: string): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const barColor =
    clamped > 90 ? "bg-red-400" : clamped > 70 ? "bg-amber-400" : `bg-${color}-400`;

  return `<div class="w-full rounded-full bg-slate-700 h-3">
  <div class="${barColor} h-3 rounded-full transition-all" style="width: ${clamped}%"></div>
</div>`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function healthPage(stats: SystemStats, user: SessionUser): string {
  const memPercent = Math.round((stats.memUsedMB / stats.memTotalMB) * 100);
  const diskPercent = Math.round((stats.diskUsedGB / stats.diskTotalGB) * 100);

  const content = `<div class="space-y-8">
    <div>
      <h2 class="text-xl font-semibold text-slate-50">System Health</h2>
      <p class="mt-1 text-sm text-slate-400">CPU, memory, and storage metrics. Auto-refreshes every 10s.</p>
    </div>

    <!-- Stat cards -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
         hx-get="/health/stats" hx-trigger="every 10s" hx-swap="innerHTML">
      ${statsPartial(stats)}
    </div>

    <!-- Detail panels -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      ${card(`
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-slate-300">Memory</span>
            <span class="text-sm text-slate-400">${stats.memUsedMB.toFixed(0)} / ${stats.memTotalMB.toFixed(0)} MB</span>
          </div>
          ${progressBar(memPercent, "blue")}

          <div class="flex items-center justify-between mt-6">
            <span class="text-sm font-medium text-slate-300">Disk</span>
            <span class="text-sm text-slate-400">${stats.diskUsedGB.toFixed(1)} / ${stats.diskTotalGB.toFixed(1)} GB</span>
          </div>
          ${progressBar(diskPercent, "emerald")}
        </div>
      `, { title: "Resource Usage" })}

      ${card(`
        <dl class="space-y-3">
          <div class="flex justify-between">
            <dt class="text-sm text-slate-400">Uptime</dt>
            <dd class="text-sm font-medium text-slate-50">${formatUptime(stats.uptimeSeconds)}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-sm text-slate-400">Load Average (1/5/15m)</dt>
            <dd class="text-sm font-medium text-slate-50">${stats.loadAvg.map((l) => l.toFixed(2)).join(" / ")}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-sm text-slate-400">Node.js</dt>
            <dd class="text-sm font-medium text-slate-50">${process.version}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-sm text-slate-400">Platform</dt>
            <dd class="text-sm font-medium text-slate-50">${process.platform} ${process.arch}</dd>
          </div>
        </dl>
      `, { title: "System Info" })}
    </div>

    <!-- Upgrade -->
    <div class="max-w-xl">
      ${card(`
        <div class="flex items-center justify-between mb-4">
          <p class="text-sm text-slate-400">Running build</p>
          <span class="font-mono text-sm font-semibold text-slate-50">${escapeHtml(process.env.BUILD_SHA ?? "dev")}</span>
        </div>
        <p class="text-sm text-slate-400 mb-4">
          Deploy latest <span class="font-mono text-slate-300">main</span> via GitHub Actions.
          Active tasks will suspend and resume after restart.
        </p>
        <div id="upgrade-result"></div>
        ${button("Deploy latest main", {
          variant: "primary",
          attrs: 'hx-post="/upgrade/trigger" hx-target="#upgrade-result" hx-swap="innerHTML" hx-indicator="#upgrade-spinner"',
        })}
        <span id="upgrade-spinner" class="htmx-indicator ml-3 text-sm text-slate-400">Triggering...</span>
      `, { title: "Upgrade" })}
    </div>
  </div>`;

  return layout("Health", content, user);
}

export function upgradeSuccess(): string {
  return `<p class="text-sm text-emerald-400 mt-3">${badge("Triggered", "emerald")} Workflow dispatched — check GitHub Actions for progress.</p>`;
}

export function upgradeError(message: string): string {
  return `<p class="text-sm text-red-400 mt-3">${badge("Error", "red")} ${escapeHtml(message)}</p>`;
}

export function statsPartial(stats: SystemStats): string {
  const memPercent = Math.round((stats.memUsedMB / stats.memTotalMB) * 100);
  const diskPercent = Math.round((stats.diskUsedGB / stats.diskTotalGB) * 100);

  return [
    statCard("CPU", `${stats.cpuPercent}%`, { color: "amber" }),
    statCard("Memory", `${memPercent}%`, { color: "blue" }),
    statCard("Disk", `${diskPercent}%`, { color: "emerald" }),
    statCard("Uptime", formatUptime(stats.uptimeSeconds), { color: "slate" }),
  ].join("");
}
