import type { SessionUser } from "../../domain/types.js";
import { layout } from "./layout.js";

export function logsPage(user: SessionUser): string {
  const content = `<div class="space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-semibold text-slate-50">Live Logs</h2>
      <p class="mt-1 text-sm text-slate-400">Real-time system log viewer with filtering.</p>
    </div>
    <div id="connection-status" class="flex items-center gap-2 text-sm">
      <span id="status-dot" class="h-2.5 w-2.5 rounded-full bg-slate-500"></span>
      <span id="status-text" class="text-slate-400">Connecting...</span>
    </div>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-700 bg-slate-800 p-4">
    <!-- Level checkboxes -->
    <fieldset class="space-y-1">
      <legend class="text-xs font-medium uppercase tracking-wider text-slate-400">Level</legend>
      <div class="flex gap-3">
        <label class="flex items-center gap-1.5 text-sm">
          <input type="checkbox" value="debug" class="log-level-filter h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-gray-400 focus:ring-0" checked />
          <span class="text-gray-400">debug</span>
        </label>
        <label class="flex items-center gap-1.5 text-sm">
          <input type="checkbox" value="info" class="log-level-filter h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-blue-400 focus:ring-0" checked />
          <span class="text-blue-400">info</span>
        </label>
        <label class="flex items-center gap-1.5 text-sm">
          <input type="checkbox" value="warn" class="log-level-filter h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-amber-400 focus:ring-0" checked />
          <span class="text-amber-400">warn</span>
        </label>
        <label class="flex items-center gap-1.5 text-sm">
          <input type="checkbox" value="error" class="log-level-filter h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-red-400 focus:ring-0" checked />
          <span class="text-red-400">error</span>
        </label>
        <label class="flex items-center gap-1.5 text-sm">
          <input type="checkbox" value="fatal" class="log-level-filter h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-red-600 focus:ring-0" checked />
          <span class="text-red-600">fatal</span>
        </label>
      </div>
    </fieldset>

    <!-- Component dropdown -->
    <div class="space-y-1">
      <label for="log-component" class="block text-xs font-medium uppercase tracking-wider text-slate-400">Component</label>
      <select id="log-component"
        class="rounded-lg border border-slate-600 bg-slate-700 px-2.5 py-1.5 text-sm text-slate-50 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">
        <option value="">All</option>
      </select>
    </div>

    <!-- Task ID -->
    <div class="space-y-1">
      <label for="log-task-id" class="block text-xs font-medium uppercase tracking-wider text-slate-400">Task ID</label>
      <input type="text" id="log-task-id" placeholder="e.g. 42"
        class="w-24 rounded-lg border border-slate-600 bg-slate-700 px-2.5 py-1.5 text-sm text-slate-50 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
    </div>

    <!-- Free-text search -->
    <div class="space-y-1">
      <label for="log-search" class="block text-xs font-medium uppercase tracking-wider text-slate-400">Search</label>
      <input type="text" id="log-search" placeholder="Filter messages..."
        class="w-48 rounded-lg border border-slate-600 bg-slate-700 px-2.5 py-1.5 text-sm text-slate-50 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
    </div>

    <!-- Spacer -->
    <div class="flex-1"></div>

    <!-- Controls -->
    <div class="flex items-center gap-2">
      <button id="log-detailed" class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-50" title="Toggle detailed view">
        Detailed
      </button>
      <button id="log-pause" class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-50" title="Pause/Resume">
        Pause
      </button>
      <button id="log-clear" class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-50" title="Clear">
        Clear
      </button>
      <span id="log-count" class="text-xs text-slate-500">0 entries</span>
    </div>
  </div>

  <!-- Log container -->
  <div class="relative">
    <div id="log-container" class="h-[600px] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs leading-relaxed">
    </div>
    <button id="log-scroll-bottom" class="absolute bottom-4 right-4 hidden rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 shadow-lg transition-colors hover:bg-slate-600 hover:text-slate-50">
      Scroll to bottom
    </button>
  </div>
</div>
<script src="/public/logs.js"></script>`;

  return layout("Logs", content, user);
}
