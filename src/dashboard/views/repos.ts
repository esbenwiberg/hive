// Repos views — summary cards, detail panel, and page shell

import type { SessionUser } from "../../domain/types.js";
import type { RepoRow } from "../../db/schema.js";
import {
  escapeHtml,
  card,
  button,
  input,
  select,
  checkbox,
  badge,
  modal,
  emptyState,
} from "./components.js";
import { layout } from "./layout.js";

// ── Shared constants (used by settings.ts for global config too) ────────────

export const ALL_PRODUCER_NAMES = [
  "ado-work-items",
  "bug-hunter",
  "doc-auditor",
  "feature-scout",
  "github-issues",
  "log-scanner",
  "maintenance",
  "security-scanner",
  "self-monitor",
] as const;

export const PRODUCER_CONFIG_PLACEHOLDERS: Record<string, string> = {
  "log-scanner": '{ "workspaceId": "...", "containerAppName": "..." }',
  "github-issues": '{ "label": "hive", "maxPerRun": 10 }',
};

export const ALL_ENRICHER_NAMES = [
  "codebase",
  "docs",
  "git-history",
  "dependencies",
  "prism",
  "architect",
  "scorer",
] as const;

// ── Icons ───────────────────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<string, string> = {
  github: `<svg class="w-5 h-5 text-slate-300" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>`,
  azure_devops: `<svg class="w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="currentColor"><path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v15.12l-5.624 4.453-10.18-3.706.118 4.48L2.5 19.85l.652-13.612 4.27-1.143v-1.04z"/></svg>`,
};

function providerIcon(provider: string): string {
  return PROVIDER_ICONS[provider] ?? PROVIDER_ICONS.github;
}

// ── Helper ──────────────────────────────────────────────────────────────────

const overrideMarker = `<span class="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" title="Overridden"></span>`;

// ── Summary Card ────────────────────────────────────────────────────────────

export function repoSummaryCard(repo: RepoRow): string {
  const safeId = escapeHtml(String(repo.id));
  const settings = (repo.settings ?? {}) as Record<string, unknown>;

  // Counts
  const producersSettings = (settings.producers ?? {}) as Record<string, { enabled?: boolean }>;
  const enrichersSettings = (settings.enrichers ?? {}) as Record<string, { enabled?: boolean }>;
  const producerCount = Object.values(producersSettings).filter((p) => p.enabled).length;
  const enricherCount = Object.values(enrichersSettings).filter((e) => e.enabled).length;

  // Gate mode
  const gateMode = settings.gateMode as string | undefined;
  const gateBadgeText = gateMode ? gateMode.toUpperCase() : "\u2014";
  const gateOverride = gateMode ? overrideMarker : "";

  // Preview
  const previewSettings = settings.preview as Record<string, unknown> | undefined;
  const previewEnabled = previewSettings?.enabled === true;
  const previewIcon = previewEnabled
    ? `<span class="text-emerald-400">\u2713 Enabled</span>`
    : `<span class="text-slate-500">\u2717 Disabled</span>`;

  // Budget
  const perTask = settings.perTaskMax != null ? `$${settings.perTaskMax}` : "\u2014";
  const daily = settings.dailyBudget != null ? `$${settings.dailyBudget}` : "\u2014";
  const budgetOverride = (settings.perTaskMax != null || settings.dailyBudget != null) ? overrideMarker : "";

  return `<div id="repo-card-${safeId}">
  <div class="rounded-xl border border-slate-700 bg-slate-800 p-4 cursor-pointer hover:border-slate-600 hover:bg-slate-800/80 transition-colors"
       hx-get="/repos/${safeId}"
       hx-target="#detail-panel"
       hx-swap="innerHTML">
    <div class="flex items-center gap-2 mb-3">
      ${providerIcon(repo.provider)}
      <h3 class="text-sm font-semibold text-slate-50 truncate">${escapeHtml(repo.fullName)}</h3>
    </div>
    <div class="space-y-1.5 text-xs">
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Branch</span>
        <span class="text-slate-300">${escapeHtml(repo.defaultBranch ?? "main")}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Gate</span>
        <span class="text-slate-300">${gateBadgeText}${gateOverride}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Producers / Enrichers</span>
        <span class="text-slate-300">${producerCount} / ${enricherCount}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Preview</span>
        ${previewIcon}
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-400">Budget${budgetOverride}</span>
        <span class="text-slate-300">${perTask} / ${daily}</span>
      </div>
    </div>
  </div>
</div>`;
}

// ── Card Grid ───────────────────────────────────────────────────────────────

export function repoCardGrid(repos: RepoRow[]): string {
  if (repos.length === 0) {
    return emptyState(
      "No repos configured yet",
      button("Add Repo", {
        variant: "primary",
        attrs: `type="button" onclick="document.getElementById('add-repo-modal').classList.remove('hidden')"`,
      }),
    );
  }

  const cards = repos.map((r) => repoSummaryCard(r)).join("");

  return `<div id="repo-grid" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
  ${cards}
</div>`;
}

// ── Detail Panel ────────────────────────────────────────────────────────────

export function repoDetailPanel(repo: RepoRow): string {
  const safeId = escapeHtml(String(repo.id));
  const settings = (repo.settings ?? {}) as Record<string, unknown>;

  // Gate mode
  const gateModeLabel = `Gate Mode${(settings.gateMode as string) ? overrideMarker : ""}`;
  const perTaskLabel = `Per-Task Budget (USD)${settings.perTaskMax != null ? overrideMarker : ""}`;
  const dailyLabel = `Daily Budget (USD)${settings.dailyBudget != null ? overrideMarker : ""}`;

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
  const prismEnabled = enrichersSettings.prism?.enabled === true;
  const supersededByPrism = new Set(["codebase", "docs", "git-history"]);
  const prismCheckboxId = `enricher_enabled_prism_${repo.id}`;

  const enricherToggles = ALL_ENRICHER_NAMES.map((name) => {
    const entry = enrichersSettings[name];
    const isEnabled = entry?.enabled === true;
    const cb = checkbox(`enricher_enabled_${name}_${repo.id}`, name, isEnabled);

    if (name === "prism") {
      // Toggle hint visibility on the superseded enrichers
      return `<div>${cb.replace(
        "<input ",
        `<input onchange="document.querySelectorAll('.prism-hint-${repo.id}').forEach(el => el.style.display = this.checked ? 'block' : 'none')" `,
      )}</div>`;
    }

    if (supersededByPrism.has(name)) {
      const display = prismEnabled ? "block" : "none";
      return `<div>${cb}<div class="prism-hint-${repo.id} ml-7 text-xs text-amber-400" style="display:${display}">\u26A1 Superseded by Prism context enrichment</div></div>`;
    }

    return cb;
  }).join("");

  // Preview fields
  const previewFields = (() => {
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
      ${select(`previewEnabled_${repo.id}`, "Preview Enabled", [
        { value: "", label: "-- Use Global Default --" },
        { value: "true", label: "Enabled" },
        { value: "false", label: "Disabled" },
      ], ((pv.enabled != null) ? String(pv.enabled) : ""))}
      ${input(`previewTimeout_${repo.id}`, "Cleanup Timeout (minutes)", {
        type: "number",
        value: pv.cleanup_timeout_minutes != null ? String(pv.cleanup_timeout_minutes) : "",
        placeholder: "Use global default",
      })}
      ${select(`previewType_${repo.id}`, "Deploy Type", [
        { value: "", label: "Not Configured" },
        { value: "compose", label: "Docker Compose" },
        { value: "testcontainers", label: "Testcontainers" },
        { value: "process", label: "Process" },
      ], pvType, onchange)}
      <div id="preview-config-${repo.id}" style="display:${showConfig}" class="space-y-3 mt-3">
        ${input(`previewPort_${repo.id}`, "Port", { type: "number", value: pvPort, placeholder: "e.g. 3000" })}
        ${input(`previewHealthCheck_${repo.id}`, "Health Check Path", { value: pvHealth, placeholder: "/health (optional)" })}
        ${input(`previewStartupTimeout_${repo.id}`, "Startup Timeout (seconds)", { type: "number", value: pvStartup, placeholder: "60 (optional)" })}
        <div id="preview-compose-${repo.id}" style="display:${showCompose}" class="space-y-3">
          ${input(`previewComposeFile_${repo.id}`, "Compose File", { value: pvComposeFile, placeholder: "docker-compose.yml" })}
          ${input(`previewAppService_${repo.id}`, "App Service Name", { value: pvAppService, placeholder: "app" })}
        </div>
        <div id="preview-command-${repo.id}" style="display:${showCommand}" class="space-y-3">
          ${input(`previewStartCommand_${repo.id}`, "Start Command", { value: pvStartCommand, placeholder: "npm start" })}
        </div>
        <div class="space-y-1.5">
          <label for="previewEnv_${repo.id}" class="block text-sm font-medium text-slate-300">Environment Variables</label>
          <textarea id="previewEnv_${repo.id}" name="previewEnv_${repo.id}" rows="3"
            placeholder="KEY=VALUE (one per line)"
            class="block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-50 placeholder-slate-500 font-mono focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">${escapeHtml(pvEnv)}</textarea>
        </div>
      </div>`;
  })();

  return `<div class="fixed inset-y-0 right-0 z-50 w-[680px] max-w-full overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl"
     style="transform: translateX(100%)">
  <div class="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700 bg-slate-900 px-6 py-4">
    <div class="flex items-center gap-2">
      ${providerIcon(repo.provider)}
      <h2 class="text-lg font-semibold text-slate-50">${escapeHtml(repo.fullName)}</h2>
    </div>
    <button onclick="closePanel()"
            class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <form class="p-6 space-y-6"
        hx-post="/repos/${safeId}"
        hx-target="#repo-card-${safeId}"
        hx-swap="outerHTML">

    <!-- Info -->
    <div class="space-y-3">
      <div class="flex items-center justify-between py-1 border-b border-slate-700">
        <span class="text-sm text-slate-400">Full Name</span>
        <span class="text-sm text-slate-50">${escapeHtml(repo.fullName)}</span>
      </div>
      <div class="flex items-center justify-between py-1 border-b border-slate-700">
        <span class="text-sm text-slate-400">Branch</span>
        <span class="text-sm text-slate-50">${escapeHtml(repo.defaultBranch ?? "main")}</span>
      </div>
    </div>

    <!-- Gate & Budget -->
    <details open>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Gate & Budget</summary>
      <div class="mt-3 space-y-3">
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
      </div>
    </details>

    <!-- Producers -->
    <details open>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Producers</summary>
      <div class="mt-3 space-y-2">
        ${producerToggles}
      </div>
    </details>

    <!-- Enrichers -->
    <details open>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Enrichers</summary>
      <div class="mt-3 space-y-2">
        ${enricherToggles}
      </div>
    </details>

    <!-- Documentation & Prism -->
    <details>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Docs & Prism</summary>
      <div class="mt-3 space-y-3">
        ${checkbox(`docs_enabled_${repo.id}`, "Enable documentation", ((settings.docs as Record<string, unknown> | undefined)?.enabled === true))}
        ${input(`prismSlug_${repo.id}`, "Prism Slug", {
          value: (settings.prismSlug as string) ?? "",
          placeholder: "org/project (optional)",
        })}
      </div>
    </details>

    <!-- Package Registries -->
    <details>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Package Registries</summary>
      <div class="mt-3 space-y-4">
        <div>
          <p class="text-xs text-slate-500 mb-2">Private npm / NuGet feeds. Tokens are stored in Key Vault.</p>
          <details class="space-y-3">
            <summary class="text-xs text-slate-500 cursor-pointer hover:text-slate-400">npm</summary>
            <div class="mt-2 space-y-2">
              ${input(`npmRegistryUrl_${repo.id}`, "Registry URL", {
                value: ((settings.npm as Record<string, unknown> | undefined)?.url as string) ?? "",
                placeholder: "https://npm.pkg.github.com",
              })}
              ${input(`npmScope_${repo.id}`, "Scope", {
                value: ((settings.npm as Record<string, unknown> | undefined)?.scope as string) ?? "",
                placeholder: "@myorg (optional)",
              })}
              ${input(`npmToken_${repo.id}`, "Auth Token", {
                type: "password",
                placeholder: (settings.npm as Record<string, unknown> | undefined)?.tokenVaultId ? "Saved — leave blank to keep" : "npm_...",
              })}
            </div>
          </details>
          <details class="space-y-3 mt-2">
            <summary class="text-xs text-slate-500 cursor-pointer hover:text-slate-400">NuGet</summary>
            <div class="mt-2 space-y-2">
              ${input(`nugetFeedUrl_${repo.id}`, "Feed URL", {
                value: ((settings.nuget as Record<string, unknown> | undefined)?.url as string) ?? "",
                placeholder: "https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json",
              })}
              ${input(`nugetToken_${repo.id}`, "Auth Token", {
                type: "password",
                placeholder: (settings.nuget as Record<string, unknown> | undefined)?.tokenVaultId ? "Saved — leave blank to keep" : "PAT or API key",
              })}
            </div>
          </details>
        </div>
      </div>
    </details>

    <!-- Build System -->
    <details>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Build System</summary>
      <div class="mt-3 space-y-3">
        <p class="text-xs text-slate-500">Override auto-detection for repos where build tools aren't at root.</p>
        ${select(`buildSystem_${repo.id}`, "Build System", [
          { value: "", label: "Auto-detect" },
          { value: "npm", label: "npm" },
          { value: "dotnet", label: "dotnet" },
          { value: "dotnet+npm", label: "dotnet+npm" },
        ], ((settings.build as Record<string, unknown> | undefined)?.system as string) ?? "")}
        ${input(`buildNpmDir_${repo.id}`, "npm Directory", {
          value: ((settings.build as Record<string, unknown> | undefined)?.npmDir as string) ?? "",
          placeholder: "./Client (relative path, optional)",
        })}
      </div>
    </details>

    <!-- Execution -->
    ${(() => {
      const timeouts = (settings.timeouts ?? {}) as Record<string, unknown>;
      const execution = (settings.execution ?? {}) as Record<string, unknown>;
      const toSec = (v: unknown) => typeof v === "number" ? String(Math.round(v / 1000)) : "";
      const hasOverride = Object.keys(timeouts).length > 0 || Object.keys(execution).length > 0;
      const marker = hasOverride ? overrideMarker : "";

      return `<details>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Execution${marker}</summary>
      <div class="mt-3 space-y-3">
        <p class="text-xs text-slate-500">Command timeouts and rework limits. These are dashboard defaults — <code>.hive.yaml</code> in the repo takes precedence when present.</p>
        <div class="space-y-3">
          <p class="text-xs font-medium text-slate-400">Command Timeouts (seconds)</p>
          ${input(`timeoutInstall_${repo.id}`, "Install", { type: "number", value: toSec(timeouts.install), placeholder: "120 (default)" })}
          ${input(`timeoutBuild_${repo.id}`, "Build", { type: "number", value: toSec(timeouts.build), placeholder: "120 (default)" })}
          ${input(`timeoutTest_${repo.id}`, "Test", { type: "number", value: toSec(timeouts.test), placeholder: "120 (default)" })}
          ${input(`timeoutLint_${repo.id}`, "Lint", { type: "number", value: toSec(timeouts.lint), placeholder: "120 (default)" })}
        </div>
        <div class="space-y-3 pt-2 border-t border-slate-700/50">
          <p class="text-xs font-medium text-slate-400">Rework Limits</p>
          ${input(`maxReworkCycles_${repo.id}`, "Max Rework Cycles", { type: "number", value: execution.maxReworkCycles != null ? String(execution.maxReworkCycles) : "", placeholder: "3 (default)" })}
        </div>
      </div>
    </details>`;
    })()}

    <!-- Preview Config -->
    <details>
      <summary class="text-sm font-medium text-slate-300 cursor-pointer hover:text-slate-50">Preview Config</summary>
      <div class="mt-3 space-y-3">
        ${previewFields}
      </div>
    </details>

    <!-- Actions -->
    <div class="flex justify-between border-t border-slate-700 pt-4">
      ${button("Delete", { variant: "danger", attrs: `type="button" hx-delete="/repos/${safeId}" hx-target="#repo-card-${safeId}" hx-swap="outerHTML" hx-confirm="Delete this repo and all its tasks? This cannot be undone."` })}
      ${button("Save", { variant: "primary", attrs: `type="submit"` })}
    </div>
  </form>
</div>`;
}

// ── Add Repo Modal ──────────────────────────────────────────────────────────

export function addRepoModal(): string {
  const body = `<form class="space-y-3"
    hx-post="/repos"
    hx-target="#repo-grid"
    hx-swap="beforeend"
    hx-on::after-request="if(event.detail.successful) document.getElementById('add-repo-modal').classList.add('hidden')">
    ${select("provider", "Provider", [
      { value: "github", label: "GitHub" },
      { value: "azure_devops", label: "Azure DevOps" },
    ], "github", `onchange="document.getElementById('fullName').placeholder=this.value==='azure_devops'?'org/project/repo':'owner/repo'"`)
    }
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
  </form>`;

  return modal("add-repo-modal", "Add Repo", body);
}

// ── Full Page ───────────────────────────────────────────────────────────────

export function reposPage(repos: RepoRow[], user: SessionUser): string {
  const content = `<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-semibold text-slate-50">Repos</h2>
      <p class="mt-1 text-sm text-slate-400">Per-repo configuration for producers, enrichers, gate, budget, and more.</p>
    </div>
    ${button("Add Repo", {
      variant: "primary",
      attrs: `type="button" onclick="document.getElementById('add-repo-modal').classList.remove('hidden')"`,
    })}
  </div>

  <!-- Card Grid -->
  ${repoCardGrid(repos)}

  <!-- Add Repo Modal -->
  ${addRepoModal()}
</div>`;

  return layout("Repos", content, user);
}
