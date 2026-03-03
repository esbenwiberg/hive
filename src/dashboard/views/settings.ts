// Settings views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { RepoRow } from "../../db/schema.js";
import type { AutonomousConfig, ModelConfig } from "../../domain/autonomous-config.js";
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
  "maintenance",
] as const;

const PRODUCER_CONFIG_PLACEHOLDERS: Record<string, string> = {
  "log-scanner": '{ "workspaceId": "...", "containerAppName": "..." }',
};

const ALL_COMPONENT_NAMES = [
  "router", "gate", "worker", "decomposer", "refiner", "clarification",
  "keeper", "retrospective", "feedback-loop", "code-quality-analyst",
  "gate-analyst", "browser-validator", "review-gate", "architect",
  "scorer", "producer", "milestone-review", "milestone-fix", "rework",
] as const;

/** Latest recommended model for each component. Update this single const when new models release. */
const LATEST_MODELS: ModelConfig = {
  default: "claude-sonnet-4-6",
  inputCostPerM: 3,
  outputCostPerM: 15,
  components: {
    router: "claude-haiku-4-5-20251001",
    scorer: "claude-haiku-4-5-20251001",
    gate: "claude-sonnet-4-6",
    worker: "claude-opus-4-6",
    decomposer: "claude-sonnet-4-6",
    refiner: "claude-sonnet-4-6",
    clarification: "claude-haiku-4-5-20251001",
    keeper: "claude-haiku-4-5-20251001",
    retrospective: "claude-sonnet-4-6",
    "feedback-loop": "claude-haiku-4-5-20251001",
    "code-quality-analyst": "claude-sonnet-4-6",
    "gate-analyst": "claude-haiku-4-5-20251001",
    "browser-validator": "claude-sonnet-4-6",
    "review-gate": "claude-sonnet-4-6",
    architect: "claude-sonnet-4-6",
    producer: "claude-haiku-4-5-20251001",
    "milestone-review": "claude-sonnet-4-6",
    "milestone-fix": "claude-sonnet-4-6",
    rework: "claude-sonnet-4-6",
  },
};

/**
 * Cost tiers for quick model configuration.
 * Low  — Haiku everywhere except worker (Sonnet); cheapest option.
 * Medium — Sonnet for critical reasoning, Haiku for lightweight steps; no Opus.
 * High — Opus for worker, Sonnet for reasoning; best quality (= LATEST_MODELS).
 */
const MODEL_TIERS: Record<"low" | "medium" | "high", { label: string; title: string; config: ModelConfig }> = {
  low: {
    label: "Low",
    title: "Haiku everywhere · Sonnet for worker",
    config: {
      default: "claude-haiku-4-5-20251001",
      inputCostPerM: 0.8,
      outputCostPerM: 4,
      components: {
        router: "claude-haiku-4-5-20251001",
        scorer: "claude-haiku-4-5-20251001",
        gate: "claude-haiku-4-5-20251001",
        worker: "claude-sonnet-4-6",
        decomposer: "claude-sonnet-4-6",
        refiner: "claude-haiku-4-5-20251001",
        clarification: "claude-haiku-4-5-20251001",
        keeper: "claude-haiku-4-5-20251001",
        retrospective: "claude-haiku-4-5-20251001",
        "feedback-loop": "claude-haiku-4-5-20251001",
        "code-quality-analyst": "claude-haiku-4-5-20251001",
        "gate-analyst": "claude-haiku-4-5-20251001",
        "browser-validator": "claude-haiku-4-5-20251001",
        "review-gate": "claude-haiku-4-5-20251001",
        architect: "claude-sonnet-4-6",
        producer: "claude-haiku-4-5-20251001",
        "milestone-review": "claude-haiku-4-5-20251001",
        "milestone-fix": "claude-haiku-4-5-20251001",
        rework: "claude-haiku-4-5-20251001",
      },
    },
  },
  medium: {
    label: "Medium",
    title: "Sonnet for reasoning · Haiku for lightweight steps · no Opus",
    config: {
      default: "claude-sonnet-4-6",
      inputCostPerM: 3,
      outputCostPerM: 15,
      components: {
        router: "claude-haiku-4-5-20251001",
        scorer: "claude-haiku-4-5-20251001",
        gate: "claude-sonnet-4-6",
        worker: "claude-sonnet-4-6",
        decomposer: "claude-sonnet-4-6",
        refiner: "claude-sonnet-4-6",
        clarification: "claude-haiku-4-5-20251001",
        keeper: "claude-haiku-4-5-20251001",
        retrospective: "claude-haiku-4-5-20251001",
        "feedback-loop": "claude-haiku-4-5-20251001",
        "code-quality-analyst": "claude-sonnet-4-6",
        "gate-analyst": "claude-haiku-4-5-20251001",
        "browser-validator": "claude-haiku-4-5-20251001",
        "review-gate": "claude-sonnet-4-6",
        architect: "claude-sonnet-4-6",
        producer: "claude-haiku-4-5-20251001",
        "milestone-review": "claude-haiku-4-5-20251001",
        "milestone-fix": "claude-sonnet-4-6",
        rework: "claude-sonnet-4-6",
      },
    },
  },
  high: {
    label: "High",
    title: "Opus for worker · Sonnet for reasoning · best quality",
    config: LATEST_MODELS,
  },
};

function buildTierAssignments(cfg: ModelConfig): string {
  return [
    `document.getElementById('defaultModel').value=${JSON.stringify(cfg.default)};`,
    `document.getElementById('inputCostPerM').value=${JSON.stringify(String(cfg.inputCostPerM))};`,
    `document.getElementById('outputCostPerM').value=${JSON.stringify(String(cfg.outputCostPerM))};`,
    ...ALL_COMPONENT_NAMES.map((name) =>
      `document.getElementById('component_${name}').value=${JSON.stringify(cfg.components[name] ?? "")};`,
    ),
  ].join("");
}

const ALL_ENRICHER_NAMES = [
  "codebase",
  "docs",
  "git-history",
  "dependencies",
  "prism",
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
    hx-target="#settings-panel"
    hx-swap="innerHTML">${escapeHtml(label)}</button>`;
}

function settingsTabs(active: SettingsTab): string {
  return `<div class="flex gap-1 border-b border-slate-700">
  ${tabButton("Global Defaults", "global", active)}
  ${tabButton("Repos", "repos", active)}
</div>`;
}

export function settingsPanel(active: SettingsTab, tabContent: string): string {
  return `<div id="settings-panel">
  ${settingsTabs(active)}
  <div id="settings-content" class="mt-8">
    ${tabContent}
  </div>
</div>`;
}

// ── Preview Test Dialog ─────────────────────────────────────────────────────

function previewTestDialog(): string {
  return `<div id="preview-test-modal" class="fixed inset-0 z-50 hidden">
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm" onclick="window.__previewTest?.close()"></div>
  <div class="fixed inset-0 flex items-center justify-center p-4">
    <div class="relative w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-800 shadow-xl">
      <div class="flex items-center justify-between border-b border-slate-700 px-6 py-4">
        <h3 class="text-lg font-semibold text-slate-50">Test Preview Setup</h3>
        <button onclick="window.__previewTest?.close()"
                class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="px-6 py-4">
        <p class="text-sm text-slate-400 mb-4">Deploys a minimal nginx:alpine container to verify certs, SSH, and Docker Compose on the preview host.</p>
        <div id="pt-log" class="rounded-lg bg-slate-900 p-4 font-mono text-xs text-slate-300 max-h-96 overflow-y-auto whitespace-pre-wrap mb-4"></div>
        <div class="flex justify-end gap-2">
          <button id="pt-start" type="button" onclick="window.__previewTest?.start()"
            class="inline-flex items-center rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-amber-400 transition-colors">
            Start Test
          </button>
          <button id="pt-stop" type="button" onclick="window.__previewTest?.stop()" style="display:none"
            class="inline-flex items-center rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors">
            Stop Test
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
(function() {
  var es = null;
  var status = 'idle';

  function log(msg, cls) {
    var el = document.getElementById('pt-log');
    if (!el) return;
    var line = document.createElement('div');
    line.textContent = msg;
    if (cls) line.className = cls;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function updateButtons() {
    var startBtn = document.getElementById('pt-start');
    var stopBtn = document.getElementById('pt-stop');
    if (!startBtn || !stopBtn) return;
    if (status === 'idle' || status === 'failed') {
      startBtn.style.display = '';
      stopBtn.style.display = 'none';
    } else {
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
    }
  }

  function connect() {
    if (es) return;
    es = new EventSource('/settings/preview/test/stream');
    es.onmessage = function(e) {
      try { log(JSON.parse(e.data)); } catch(err) { log(e.data); }
    };
    es.addEventListener('step', function(e) {
      log(JSON.parse(e.data), 'text-slate-400');
    });
    es.addEventListener('pass', function(e) {
      log('\\u2713 ' + JSON.parse(e.data), 'text-emerald-400');
    });
    es.addEventListener('fail', function(e) {
      log('\\u2717 ' + JSON.parse(e.data), 'text-red-400');
    });
    es.addEventListener('logs', function(e) {
      var logEl = document.getElementById('pt-log');
      // Replace last docker log block if present
      var existing = logEl?.querySelector('[data-docker-logs]');
      var block = document.createElement('pre');
      block.setAttribute('data-docker-logs', '1');
      block.className = 'text-slate-500 mt-1 border-t border-slate-800 pt-1';
      block.textContent = JSON.parse(e.data);
      if (existing) existing.replaceWith(block);
      else logEl?.appendChild(block);
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
    es.addEventListener('status', function(e) {
      status = e.data;
      updateButtons();
    });
    es.addEventListener('done', function(e) {
      log(JSON.parse(e.data), 'text-slate-400');
    });
    es.onerror = function() {
      // Reconnect is automatic with EventSource
    };
  }

  function disconnect() {
    if (es) { es.close(); es = null; }
  }

  window.__previewTest = {
    connect: connect,
    start: function() {
      document.getElementById('pt-log').innerHTML = '';
      fetch('/settings/preview/test/start', { method: 'POST', headers: { 'Origin': location.origin } })
        .then(function() { status = 'running'; updateButtons(); })
        .catch(function(err) { log('Request failed: ' + err.message, 'text-red-400'); });
    },
    stop: function() {
      fetch('/settings/preview/test/stop', { method: 'POST', headers: { 'Origin': location.origin } })
        .then(function() { status = 'stopping'; updateButtons(); })
        .catch(function(err) { log('Stop failed: ' + err.message, 'text-red-400'); });
    },
    close: function() {
      if (status === 'running' || status === 'up') {
        window.__previewTest.stop();
      }
      disconnect();
      document.getElementById('preview-test-modal')?.classList.add('hidden');
    }
  };
})();
</script>`;
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

  // Concurrency card
  const concurrencyFields = [
    input("maxConcurrent", "Max Concurrent Tasks", {
      type: "number",
      value: String(config.concurrency.maxConcurrent),
      placeholder: "5",
    }),
    input("maxPerUser", "Default Per-User Max", {
      type: "number",
      value: String(config.concurrency.maxPerUser),
      placeholder: "2",
    }),
  ].join("");

  const concurrencyCard = card(concurrencyFields, {
    title: "Concurrency",
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

  // Models card
  const componentInputs = ALL_COMPONENT_NAMES.map((name) =>
    input(`component_${name}`, name, {
      value: config.models.components[name] ?? "",
      placeholder: "Inherit default",
    }),
  ).join("");

  const tierButtons = (["low", "medium", "high"] as const).map((tier) => {
    const { label, title, config } = MODEL_TIERS[tier];
    return button(label, {
      variant: "secondary",
      attrs: `type="button" title="${escapeHtml(title)}" onclick="${escapeHtml(buildTierAssignments(config))}"`,
    });
  }).join("");

  const modelsFields = [
    input("defaultModel", "Default Model", {
      value: config.models.default,
      placeholder: "claude-sonnet-4-6",
    }),
    input("inputCostPerM", "Input Cost $/M", {
      type: "number",
      value: String(config.models.inputCostPerM),
      placeholder: "3",
    }),
    input("outputCostPerM", "Output Cost $/M", {
      type: "number",
      value: String(config.models.outputCostPerM),
      placeholder: "15",
    }),
    `<div class="mt-2 flex flex-wrap gap-2">${tierButtons}</div>`,
    `<details class="mt-2">
      <summary class="text-xs text-slate-500 cursor-pointer hover:text-slate-400">Per-component overrides</summary>
      <div class="mt-2 space-y-2">${componentInputs}</div>
    </details>`,
  ].join("");

  const modelsCard = card(modelsFields, {
    title: "Models",
    padding: "compact",
  });

  // Preview card
  const previewFields = [
    input("composeUpTimeout", "Compose Up Timeout (seconds)", {
      type: "number",
      value: String(config.preview.compose_up_timeout_seconds),
      placeholder: "300",
    }),
    `<div class="mt-3 border-t border-slate-700 pt-3">
      ${button("Test Preview Setup", {
        variant: "secondary",
        attrs: `type="button" onclick="document.getElementById('preview-test-modal').classList.remove('hidden'); window.__previewTest?.connect()"`,
      })}
    </div>`,
  ].join("");

  const previewCard = card(previewFields, {
    title: "Preview",
    padding: "compact",
  });

  // Prism card
  const prismFields = [
    input("prismApiUrl", "API URL", {
      value: config.prism.apiUrl,
      placeholder: "https://prism.example.com",
    }),
    input("prismApiKey", "API Key", {
      type: "password",
      placeholder: config.prism.apiKey ? "Leave blank to keep saved key" : "sk-...",
    }),
  ].join("");

  const prismCard = card(prismFields, {
    title: "Prism",
    padding: "compact",
  });

  // Preview test dialog
  const previewTestModal = previewTestDialog();

  return `<form hx-post="/settings/global" hx-target="#settings-content" hx-swap="innerHTML">
  <div class="space-y-4">
    <p class="text-sm text-slate-400">Overrides saved to database. <code class="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">autonomous.config.yaml</code> provides defaults.</p>
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      ${classificationCard}
      ${gateCard}
      ${budgetCard}
      ${concurrencyCard}
      ${clarificationCard}
      ${modelsCard}
      ${previewCard}
      ${prismCard}
    </div>
    <div class="flex justify-end">
      ${button("Save Global Settings", { variant: "primary", attrs: `type="submit"` })}
    </div>
  </div>
</form>
${previewTestModal}`;
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

  <!-- Tabs + content -->
  ${settingsPanel(activeTab, tabContent)}
</div>`;

  return layout("Settings", content, user);
}
