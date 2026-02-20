// Settings views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { RepoRow } from "../../db/schema.js";
import type { AutonomousConfig } from "../../domain/autonomous-config.js";
import type { ConfigOverrides } from "../../domain/autonomous-config.js";
import {
  escapeHtml,
  card,
  button,
  input,
  select,
  checkbox,
  emptyState,
  badge,
} from "./components.js";
import { layout } from "./layout.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab = "global" | "repos";

// self-monitor is a global producer (hardcoded to Hive self-repo), not per-repo configurable
const ALL_PRODUCER_NAMES = [
  "log-scanner",
  "bug-hunter",
  "security-scanner",
  "feature-scout",
] as const;

const PRODUCER_CONFIG_PLACEHOLDERS: Record<string, string> = {
  "log-scanner": '{ "workspaceId": "...", "containerAppName": "..." }',
};

const ALL_ENRICHER_NAMES = [
  "codebase",
  "docs",
  "git-history",
  "dependencies",
  "architect",
  "scorer",
] as const;

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
 * Renders the editable Global Defaults panel.
 * Shows HTMX forms for classification, gate, budget, and enrichers.
 */
export function globalSettingsPartial(
  config: AutonomousConfig,
  _overrides?: ConfigOverrides,
): string {
  // Classification card
  const classificationFields = [
    select("defaultType", "Default Type", [
      { value: "bug", label: "Bug" },
      { value: "feature", label: "Feature" },
      { value: "security", label: "Security" },
      { value: "refactor", label: "Refactor" },
      { value: "improvement", label: "Improvement" },
    ], config.classification.defaultType),
    select("defaultSize", "Default Size", [
      { value: "trivial", label: "Trivial" },
      { value: "small", label: "Small" },
      { value: "medium", label: "Medium" },
      { value: "large", label: "Large" },
    ], config.classification.defaultSize),
  ].join("");

  const classificationCard = card(classificationFields, {
    title: "Classification",
    padding: "compact",
  });

  // Gate card
  const gateFields = select("gateMode", "Mode", [
    { value: "ai", label: "AI" },
    { value: "human", label: "Human" },
    { value: "auto", label: "Auto" },
  ], config.gate.mode);

  const gateCard = card(gateFields, {
    title: "Gate",
    padding: "compact",
  });

  // Budget card
  const budgetFields = [
    input("dailyDefault", "Daily Default (USD)", {
      type: "number",
      value: String(config.budget.dailyDefault),
      placeholder: "100",
    }),
    input("perTaskMax", "Per-Task Max (USD)", {
      type: "number",
      value: String(config.budget.perTaskMax),
      placeholder: "25",
    }),
  ].join("");

  const budgetCard = card(budgetFields, {
    title: "Budget",
    padding: "compact",
  });

  // Clarification card
  const clarificationFields = select("clarificationMode", "Mode", [
    { value: "human", label: "Human" },
    { value: "ai", label: "AI" },
    { value: "auto", label: "Auto" },
  ], config.clarification.mode);

  const clarificationCard = card(clarificationFields, {
    title: "Clarification",
    padding: "compact",
  });

  return `<form hx-post="/settings/global" hx-target="#settings-content" hx-swap="innerHTML">
  <div class="space-y-4">
    <p class="text-sm text-slate-400">Overrides saved to database. <code class="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">autonomous.config.yaml</code> provides defaults.</p>
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      ${classificationCard}
      ${gateCard}
      ${budgetCard}
      ${clarificationCard}
    </div>
    <div class="flex justify-end">
      ${button("Save Global Settings", { variant: "primary", attrs: `type="submit"` })}
    </div>
  </div>
</form>`;
}

// ── Repo Card ───────────────────────────────────────────────────────────────

export function repoSettingsCard(repo: RepoRow): string {
  const settings = (repo.settings ?? {}) as Record<string, unknown>;

  // Display repo info
  const infoRows = [
    kvRow("Full Name", repo.fullName),
    kvRow("Default Branch", repo.defaultBranch ?? "main"),
  ].join("");

  // Edit form for per-repo settings (HTMX POST)
  const safeId = escapeHtml(String(repo.id));

  // Helper: override marker shown next to label when a per-repo value is set
  const overrideMarker = `<span class="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" title="Overridden"></span>`;

  // Producer toggles
  const producersSettings = (settings.producers ?? {}) as Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  const producerToggles = ALL_PRODUCER_NAMES.map((name) => {
    const entry = producersSettings[name];
    const isEnabled = entry?.enabled === true;
    const configJson = entry?.config ? JSON.stringify(entry.config, null, 2) : "";
    const configId = `producer_config_${name}_${repo.id}`;
    const detailsId = `producer_details_${name}_${repo.id}`;

    const placeholder = PRODUCER_CONFIG_PLACEHOLDERS[name] ?? '{ }';

    return `<div class="space-y-1">
      ${checkbox(`producer_enabled_${name}_${repo.id}`, name, isEnabled)}
      <details id="${detailsId}" class="ml-7">
        <summary class="text-xs text-slate-500 cursor-pointer hover:text-slate-400">Config JSON</summary>
        <textarea id="${configId}" name="${configId}" rows="3"
          placeholder='${escapeHtml(placeholder)}'
          class="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-50 placeholder-slate-500 font-mono focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">${escapeHtml(configJson)}</textarea>
      </details>
    </div>`;
  }).join("");

  // Enricher toggles
  const enrichersSettings = (settings.enrichers ?? {}) as Record<string, { enabled?: boolean }>;
  const enricherToggles = ALL_ENRICHER_NAMES.map((name) => {
    const entry = enrichersSettings[name];
    // Default to disabled — enrichers must be explicitly enabled per repo
    const isEnabled = entry?.enabled === true;
    return checkbox(`enricher_enabled_${name}_${repo.id}`, name, isEnabled);
  }).join("");

  // Build labelled inputs with override markers
  const gateModeLabel = `Gate Mode${(settings.gateMode as string) ? overrideMarker : ""}`;
  const perTaskLabel = `Per-Task Budget (USD)${settings.perTaskMax != null ? overrideMarker : ""}`;
  const dailyLabel = `Daily Budget (USD)${settings.dailyBudget != null ? overrideMarker : ""}`;

  const form = `<form class="mt-4 space-y-3 border-t border-slate-700 pt-4"
    hx-post="/settings/repos/${safeId}"
    hx-target="#repo-card-${safeId}"
    hx-swap="outerHTML">
    ${select(`gateMode_${repo.id}`, gateModeLabel, [
      { value: "", label: "-- Use Global Default --" },
      { value: "ai", label: "AI" },
      { value: "human", label: "Human" },
      { value: "auto", label: "Auto" },
    ], (settings.gateMode as string) ?? "")}
    ${input(`perTaskMax_${repo.id}`, perTaskLabel, {
      type: "number",
      value: settings.perTaskMax != null ? String(settings.perTaskMax) : "",
      placeholder: "Use global default",
    })}
    ${input(`dailyBudget_${repo.id}`, dailyLabel, {
      type: "number",
      value: settings.dailyBudget != null ? String(settings.dailyBudget) : "",
      placeholder: "Use global default",
    })}
    <div class="grid grid-cols-2 gap-4 border-t border-slate-700 pt-3 mt-3">
      <div>
        <h4 class="text-sm font-medium text-slate-300 mb-2">Producers</h4>
        <div class="space-y-2">
          ${producerToggles}
        </div>
      </div>
      <div>
        <h4 class="text-sm font-medium text-slate-300 mb-2">Enrichers</h4>
        <div class="space-y-2">
          ${enricherToggles}
        </div>
      </div>
    </div>
    <div class="border-t border-slate-700 pt-3 mt-3">
      <h4 class="text-sm font-medium text-slate-300 mb-2">Documentation</h4>
      <p class="text-xs text-slate-500 mb-2">When enabled, agents update docs alongside code and the doc auditor scans for staleness.</p>
      ${checkbox(`docs_enabled_${repo.id}`, "Enable documentation", ((settings.docs as Record<string, unknown> | undefined)?.enabled === true))}
    </div>
    <div class="border-t border-slate-700 pt-3 mt-3">
      <h4 class="text-sm font-medium text-slate-300 mb-2">Preview</h4>
      ${select(`previewEnabled_${repo.id}`, "Preview Enabled", [
        { value: "", label: "-- Use Global Default --" },
        { value: "true", label: "Enabled" },
        { value: "false", label: "Disabled" },
      ], ((settings.preview as Record<string, unknown> | undefined)?.enabled != null
        ? String((settings.preview as Record<string, unknown>).enabled)
        : ""))}
      ${input(`previewTimeout_${repo.id}`, "Cleanup Timeout (minutes)", {
        type: "number",
        value: (settings.preview as Record<string, unknown> | undefined)?.cleanup_timeout_minutes != null
          ? String((settings.preview as Record<string, unknown>).cleanup_timeout_minutes)
          : "",
        placeholder: "Use global default",
      })}
      ${(() => {
        const pv = (settings.preview ?? {}) as Record<string, unknown>;
        const pvType = (pv.type as string) || "";
        const pvPort = pv.port != null ? String(pv.port) : "";
        const pvHealth = (pv.health_check as string) || "";
        const pvStartup = pv.startup_timeout != null ? String(pv.startup_timeout) : "";
        const pvComposeFile = (pv.compose_file as string) || "";
        const pvAppService = (pv.app_service as string) || "";
        const pvStartCommand = (pv.start_command as string) || "";
        const pvEnv = pv.env && typeof pv.env === "object"
          ? Object.entries(pv.env as Record<string, string>).map(([k, v]) => `${k}=${v}`).join("\n")
          : "";

        const showCompose = pvType === "compose" ? "block" : "none";
        const showCommand = pvType === "testcontainers" || pvType === "process" ? "block" : "none";
        const showConfig = pvType ? "block" : "none";

        const onchange = `onchange="(function(s){` +
          `var t=s.value;` +
          `document.getElementById('preview-config-${repo.id}').style.display=t?'block':'none';` +
          `document.getElementById('preview-compose-${repo.id}').style.display=t==='compose'?'block':'none';` +
          `document.getElementById('preview-command-${repo.id}').style.display=(t==='testcontainers'||t==='process')?'block':'none';` +
          `})(this)"`;

        return `
      ${select(`previewType_${repo.id}`, "Deploy Type", [
        { value: "", label: "Not Configured" },
        { value: "compose", label: "Docker Compose" },
        { value: "testcontainers", label: "Testcontainers" },
        { value: "process", label: "Process" },
      ], pvType, onchange)}
      <div id="preview-config-${repo.id}" style="display:${showConfig}" class="space-y-3 mt-3">
        ${input(`previewPort_${repo.id}`, "Port", {
          type: "number",
          value: pvPort,
          placeholder: "e.g. 3000",
        })}
        ${input(`previewHealthCheck_${repo.id}`, "Health Check Path", {
          value: pvHealth,
          placeholder: "/health (optional)",
        })}
        ${input(`previewStartupTimeout_${repo.id}`, "Startup Timeout (seconds)", {
          type: "number",
          value: pvStartup,
          placeholder: "60 (optional)",
        })}
        <div id="preview-compose-${repo.id}" style="display:${showCompose}" class="space-y-3">
          ${input(`previewComposeFile_${repo.id}`, "Compose File", {
            value: pvComposeFile,
            placeholder: "docker-compose.yml",
          })}
          ${input(`previewAppService_${repo.id}`, "App Service Name", {
            value: pvAppService,
            placeholder: "app",
          })}
        </div>
        <div id="preview-command-${repo.id}" style="display:${showCommand}" class="space-y-3">
          ${input(`previewStartCommand_${repo.id}`, "Start Command", {
            value: pvStartCommand,
            placeholder: "npm start",
          })}
        </div>
        <div class="space-y-1.5">
          <label for="previewEnv_${repo.id}" class="block text-sm font-medium text-slate-300">Environment Variables</label>
          <textarea id="previewEnv_${repo.id}" name="previewEnv_${repo.id}" rows="3"
            placeholder="KEY=VALUE (one per line)"
            class="block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-50 placeholder-slate-500 font-mono focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">${escapeHtml(pvEnv)}</textarea>
        </div>
      </div>`;
      })()}
    </div>
    <div class="flex justify-end gap-2">
      ${button("Delete", { variant: "danger", attrs: `type="button" hx-delete="/settings/repos/${safeId}" hx-target="#repo-card-${safeId}" hx-swap="outerHTML" hx-confirm="Delete this repo and all its tasks? This cannot be undone."` })}
      ${button("Save", { variant: "primary", attrs: `type="submit"` })}
    </div>
  </form>`;

  const inner = `
    ${infoRows}
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
      ${select("provider", "Provider", [
        { value: "github", label: "GitHub" },
        { value: "azure_devops", label: "Azure DevOps" },
      ], "github")}
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
  overrides?: ConfigOverrides,
): string {
  const tabContent =
    activeTab === "global"
      ? globalSettingsPartial(config, overrides)
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
