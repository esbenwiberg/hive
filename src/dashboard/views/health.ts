import type { SessionUser } from "../../domain/types.js";
import { statCard, card, button, badge, escapeHtml } from "./components.js";
import { layout } from "./layout.js";
import type { DiskItem, CleanResult } from "../../execution/disk-cleaner.js";

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

    ${user.role === "admin" ? `<!-- Disk Cleaner (admin only) -->
    <div class="max-w-3xl">
      ${diskCleanerSection()}
    </div>` : ""}
  </div>`;

  return layout("Health", content, user);
}

export function upgradeSuccess(): string {
  return `<p class="text-sm text-emerald-400 mt-3">${badge("Triggered", "emerald")} Workflow dispatched — check GitHub Actions for progress.</p>`;
}

export function upgradeError(message: string): string {
  return `<p class="text-sm text-red-400 mt-3">${badge("Error", "red")} ${escapeHtml(message)}</p>`;
}

// ─── Disk Cleaner helpers ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatAge(createdAt: Date): string {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs} seconds ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

/** Disk cleaner card shown only to admin users on the health page. */
function diskCleanerSection(): string {
  return card(`
    <p class="text-sm text-slate-400 mb-4">
      Scan the filesystem for orphan worktrees, stale preview artefacts, and
      leftover temp directories. Select items to remove and free up disk space.
    </p>

    <div class="flex items-center gap-3 mb-4">
      ${button("Scan Disk", {
        variant: "secondary",
        attrs: `hx-post="/health/disk-scan"
          hx-target="#disk-scan-results"
          hx-swap="innerHTML"
          hx-indicator="#disk-scan-spinner"`,
      })}
      <span id="disk-scan-spinner" class="htmx-indicator text-sm text-slate-400">Scanning…</span>
    </div>

    <div id="disk-scan-results"></div>

    <div class="mt-4">
      ${button("Clean Selected", {
        variant: "primary",
        attrs: `id="disk-clean-btn"
          disabled
          hx-post="/health/disk-clean"
          hx-target="#disk-scan-results"
          hx-swap="innerHTML"
          hx-include=".disk-item-checkbox:checked"
          hx-indicator="#disk-scan-spinner"`,
      })}
    </div>

    <script>
      (function () {
        function updateCleanBtn() {
          var checked = document.querySelectorAll('.disk-item-checkbox:checked').length;
          var btn = document.getElementById('disk-clean-btn');
          if (!btn) return;
          if (checked > 0) {
            btn.removeAttribute('disabled');
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
          } else {
            btn.setAttribute('disabled', '');
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        }

        function attachListeners() {
          document.querySelectorAll('.disk-item-checkbox').forEach(function(cb) {
            cb.removeEventListener('change', updateCleanBtn);
            cb.addEventListener('change', updateCleanBtn);
          });
          var selectAll = document.getElementById('disk-select-all');
          if (selectAll) {
            selectAll.removeEventListener('change', onSelectAll);
            selectAll.addEventListener('change', onSelectAll);
          }
          updateCleanBtn();
        }

        function onSelectAll() {
          var checked = this.checked;
          document.querySelectorAll('.disk-item-checkbox').forEach(function(cb) {
            cb.checked = checked;
          });
          updateCleanBtn();
        }

        document.addEventListener('htmx:afterSwap', function(e) {
          if (e.detail && e.detail.target && e.detail.target.id === 'disk-scan-results') {
            attachListeners();
          }
        });
      })();
    </script>
  `, { title: "Disk Cleaner" });
}

/** Renders the scan results table (or empty-state message) as an HTMX partial. */
export function diskScanPartial(items: DiskItem[]): string {
  if (items.length === 0) {
    return `<p class="text-sm text-emerald-400 py-2">No orphan items found — disk is clean ✓</p>`;
  }

  const rows = items
    .map((item, i) => {
      const shortPath =
        item.path.length > 60 ? `…${item.path.slice(-57)}` : item.path;
      const typeBadgeColor =
        item.type === "worktree" ? "blue" : item.type === "preview" ? "amber" : "slate";
      return `<tr class="border-t border-slate-700 hover:bg-slate-800/50">
        <td class="py-2 px-3">
          <input
            type="checkbox"
            class="disk-item-checkbox accent-violet-500"
            name="paths"
            value="${escapeHtml(item.path)}"
            id="disk-item-${i}"
            aria-label="Select ${escapeHtml(item.path)}"
          />
        </td>
        <td class="py-2 px-3">${badge(item.type, typeBadgeColor)}</td>
        <td class="py-2 px-3 font-mono text-xs text-slate-300 max-w-xs truncate"
            title="${escapeHtml(item.path)}">${escapeHtml(shortPath)}</td>
        <td class="py-2 px-3 text-sm text-slate-300 whitespace-nowrap">${escapeHtml(formatBytes(item.sizeBytes))}</td>
        <td class="py-2 px-3 text-sm text-slate-400 whitespace-nowrap">${escapeHtml(formatAge(item.createdAt))}</td>
      </tr>`;
    })
    .join("");

  return `<div class="overflow-x-auto">
    <table class="w-full text-left text-sm">
      <thead>
        <tr class="text-slate-400 text-xs uppercase tracking-wide">
          <th class="py-2 px-3">
            <input
              type="checkbox"
              id="disk-select-all"
              class="accent-violet-500"
              aria-label="Select all"
            />
          </th>
          <th class="py-2 px-3">Type</th>
          <th class="py-2 px-3">Path</th>
          <th class="py-2 px-3">Size</th>
          <th class="py-2 px-3">Age</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** Renders the clean result summary as an HTMX partial. */
export function diskCleanPartial(result: CleanResult): string {
  const parts: string[] = [];

  parts.push(
    `<p class="text-sm text-emerald-400">${badge("Done", "emerald")} Removed ${result.removedCount} item${result.removedCount === 1 ? "" : "s"}, freed ${formatBytes(result.freedBytes)}.</p>`,
  );

  if (result.errors.length > 0) {
    const errorItems = result.errors
      .map((e) => `<li class="font-mono text-xs">${escapeHtml(e)}</li>`)
      .join("");
    parts.push(
      `<div class="mt-2 text-red-400">
        <p class="text-sm font-medium">Errors (${result.errors.length}):</p>
        <ul class="list-disc list-inside mt-1 space-y-1">${errorItems}</ul>
      </div>`,
    );
  }

  return parts.join("");
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
