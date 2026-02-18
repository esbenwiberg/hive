// Settings views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { RepoRow } from "../../db/schema.js";
import type { AutonomousConfig } from "../../domain/autonomous-config.js";
import {
  escapeHtml,
  card,
  button,
  input,
  select,
  emptyState,
  badge,
} from "./components.js";
import { layout } from "./layout.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab = "global" | "repos";

// ── Helpers ─────────────────────────────────────────────────────────────────

function kvRow(label: string, value: string, highlight?: boolean): string {
  const valueClasses = highlight
    ? "text-amber-400 font-medium"
    : "text-slate-50";

  return `<div class="flex items-center justify-between py-2 border-b border-slate-700 last:border-b-0">
  <span class="text-sm text-slate-400">${escapeHtml(label)}</span>
  <span class="text-sm ${valueClasses}">${escapeHtml(value)}</span>
</div>`;
}

function tabButton(
  label: string,
  tab: SettingsTab,
  active: SettingsTab,
): string {
  const isActive = tab === active;
  const activeClasses = "border-amber-400 text-amber-400";
  const inactiveClasses =
    "border-transparent text-slate-400 hover:border-slate-600 hover:text-slate-300";

  return `<button
    class="border-b-2 px-4 py-2 text-sm font-medium transition-colors ${isActive ? activeClasses : inactiveClasses}"
    hx-get="/settings/tab?tab=${tab}"
    hx-target="#settings-content"
    hx-swap="innerHTML">${escapeHtml(label)}</button>`;
}

function settingsTabs(active: SettingsTab): string {
  return `<div class="flex gap-1 border-b border-slate-700">
  ${tabButton("Global Defaults", "global", active)}
  ${tabButton("Repos", "repos", active)}
</div>`;
}

// ── Global Settings Partial ─────────────────────────────────────────────────

/**
 * Renders the read-only Global Defaults panel showing the current
 * autonomous config values (classification, gate mode, enrichers, budget).
 */
export function globalSettingsPartial(config: AutonomousConfig): string {
  // Classification section
  const classificationRows = [
    kvRow("Default Type", config.classification.defaultType),
    kvRow("Default Size", config.classification.defaultSize),
  ].join("");

  const classificationCard = card(classificationRows, {
    title: "Classification",
    padding: "compact",
  });

  // Gate section
  const gateRows = kvRow("Mode", config.gate.mode);

  const gateCard = card(gateRows, {
    title: "Gate",
    padding: "compact",
  });

  // Budget section
  const budgetRows = [
    kvRow("Daily Default (USD)", `$${config.budget.dailyDefault.toFixed(2)}`),
    kvRow("Per-Task Max (USD)", `$${config.budget.perTaskMax.toFixed(2)}`),
  ].join("");

  const budgetCard = card(budgetRows, {
    title: "Budget",
    padding: "compact",
  });

  // Enrichers section
  const enricherItems =
    config.enrichers.length > 0
      ? config.enrichers
          .map((e) => {
            const color = e.enabled ? "emerald" : "slate";
            return `<div class="flex items-center justify-between py-2 border-b border-slate-700 last:border-b-0">
              <span class="text-sm text-slate-50">${escapeHtml(e.name)}</span>
              ${badge(e.enabled ? "enabled" : "disabled", color)}
            </div>`;
          })
          .join("")
      : `<p class="text-sm text-slate-500">No enrichers configured</p>`;

  const enricherCard = card(enricherItems, {
    title: "Enrichers",
    padding: "compact",
  });

  return `<div class="space-y-4">
  <p class="text-sm text-slate-400">These values are loaded from <code class="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">autonomous.config.yaml</code> and are read-only.</p>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    ${classificationCard}
    ${gateCard}
    ${budgetCard}
    ${enricherCard}
  </div>
</div>`;
}

// ── Repo Card ───────────────────────────────────────────────────────────────

export function repoSettingsCard(repo: RepoRow): string {
  const settings = (repo.settings ?? {}) as Record<string, unknown>;
  const hasOverrides = Object.keys(settings).length > 0;

  // Display repo info
  const infoRows = [
    kvRow("Full Name", repo.fullName),
    kvRow("Default Branch", repo.defaultBranch ?? "main"),
  ].join("");

  // Display current per-repo setting overrides
  let overridesHtml: string;
  if (hasOverrides) {
    overridesHtml = Object.entries(settings)
      .map(([key, value]) =>
        kvRow(key, String(value), true),
      )
      .join("");
  } else {
    overridesHtml = `<p class="text-sm text-slate-500 py-2">No per-repo overrides. Using global defaults.</p>`;
  }

  // Edit form for per-repo settings (HTMX POST)
  const safeId = escapeHtml(String(repo.id));
  const form = `<form class="mt-4 space-y-3 border-t border-slate-700 pt-4"
    hx-post="/settings/repos/${safeId}"
    hx-target="#repo-card-${safeId}"
    hx-swap="outerHTML">
    ${select(`gateMode_${repo.id}`, "Gate Mode Override", [
      { value: "", label: "-- Use Global Default --" },
      { value: "ai", label: "AI" },
      { value: "human", label: "Human" },
      { value: "auto", label: "Auto" },
    ], (settings.gateMode as string) ?? "")}
    ${input(`perTaskMax_${repo.id}`, "Per-Task Budget (USD)", {
      type: "number",
      value: settings.perTaskMax != null ? String(settings.perTaskMax) : "",
      placeholder: "Use global default",
    })}
    ${input(`dailyBudget_${repo.id}`, "Daily Budget (USD)", {
      type: "number",
      value: settings.dailyBudget != null ? String(settings.dailyBudget) : "",
      placeholder: "Use global default",
    })}
    <div class="flex justify-end">
      ${button("Save", { variant: "primary", attrs: `type="submit"` })}
    </div>
  </form>`;

  const inner = `
    ${infoRows}
    <div class="mt-3">
      <h4 class="text-sm font-medium text-slate-300 mb-1">Overrides</h4>
      ${overridesHtml}
    </div>
    ${form}`;

  return `<div id="repo-card-${safeId}">${card(inner, {
    title: repo.fullName,
    padding: "compact",
  })}</div>`;
}

// ── Repo Settings Partial ───────────────────────────────────────────────────

/**
 * Renders the Repos tab content: a list of repo cards with per-repo settings
 * and an Add Repo form.
 */
export function repoSettingsPartial(repos: RepoRow[]): string {
  const repoCards =
    repos.length > 0
      ? repos.map((r) => repoSettingsCard(r)).join("")
      : emptyState("No repos configured yet");

  // Add Repo form
  const addRepoForm = card(
    `<form class="space-y-3"
      hx-post="/settings/repos"
      hx-target="#repo-list"
      hx-swap="beforeend">
      ${input("provider", "Provider", {
        value: "github",
        required: true,
        placeholder: "github",
      })}
      ${input("fullName", "Full Name", {
        required: true,
        placeholder: "owner/repo",
      })}
      ${input("defaultBranch", "Default Branch", {
        placeholder: "main",
      })}
      <div class="flex justify-end">
        ${button("Add Repo", { variant: "primary", attrs: `type="submit"` })}
      </div>
    </form>`,
    { title: "Add Repo", padding: "compact" },
  );

  return `<div class="space-y-4">
  <div id="repo-list" class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    ${repoCards}
  </div>
  <div class="max-w-md">
    ${addRepoForm}
  </div>
</div>`;
}

// ── Exported Full Page ──────────────────────────────────────────────────────

/**
 * Full settings page with two-tab layout: Global Defaults and Repos.
 */
export function settingsPage(
  config: AutonomousConfig,
  repos: RepoRow[],
  user: SessionUser,
  activeTab: SettingsTab = "global",
): string {
  const tabContent =
    activeTab === "global"
      ? globalSettingsPartial(config)
      : repoSettingsPartial(repos);

  const content = `<div class="space-y-8">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Settings</h2>
    <p class="mt-1 text-sm text-slate-400">Manage global autonomous pipeline defaults and per-repo overrides.</p>
  </div>

  <!-- Tabs -->
  ${settingsTabs(activeTab)}

  <!-- Tab content -->
  <div id="settings-content">
    ${tabContent}
  </div>
</div>`;

  return layout("Settings", content, user);
}
