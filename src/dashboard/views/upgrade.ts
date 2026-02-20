import { layout, type SessionUser } from "./layout.js";
import { card, button, escapeHtml, badge } from "./components.js";

export function upgradePage(user: SessionUser): string {
  const sha = process.env.BUILD_SHA ?? "dev";

  const versionCard = card(`
    <div class="flex items-center gap-4">
      <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-400/10 text-amber-400">
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
        </svg>
      </div>
      <div>
        <p class="text-sm font-medium text-slate-400">Running version</p>
        <p class="mt-1 text-lg font-mono font-semibold text-slate-50">${escapeHtml(sha)}</p>
      </div>
    </div>
  `, { title: "Current Build" });

  const upgradeCard = card(`
    <p class="text-sm text-slate-400 mb-4">
      Trigger a new deployment from the <span class="font-mono text-slate-300">main</span> branch via GitHub Actions.
      The running instance will gracefully suspend active tasks and resume them after restart.
    </p>
    <div id="upgrade-result"></div>
    ${button("Deploy latest main", {
      variant: "primary",
      attrs: `hx-post="/upgrade/trigger" hx-target="#upgrade-result" hx-swap="innerHTML" hx-indicator="#upgrade-spinner"`,
    })}
    <span id="upgrade-spinner" class="htmx-indicator ml-3 text-sm text-slate-400">Triggering...</span>
  `, { title: "Upgrade" });

  const content = `
    <div class="max-w-xl space-y-6">
      ${versionCard}
      ${upgradeCard}
    </div>
  `;

  return layout("Upgrade", content, user);
}

export function upgradeSuccess(): string {
  return `<p class="text-sm text-emerald-400 mt-3">${badge("Triggered", "emerald")} Workflow dispatched — check GitHub Actions for progress.</p>`;
}

export function upgradeError(message: string): string {
  return `<p class="text-sm text-red-400 mt-3">${badge("Error", "red")} ${escapeHtml(message)}</p>`;
}
