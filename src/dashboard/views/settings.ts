// Settings views — pure functions returning HTML strings

import type { SessionUser } from "../../domain/types.js";
import type { AutonomousConfig, ModelConfig, ApiProvider } from "../../domain/autonomous-config.js";
import type { ConfigOverrides } from "../../domain/autonomous-config.js";
import {
  escapeHtml,
  card,
  button,
  input,
  select,
  badge,
} from "./components.js";
import { layout } from "./layout.js";

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Provider Status ──────────────────────────────────────────────────────────

export interface ProviderStatus {
  anthropicKeySet: boolean;
  azureKeySet: boolean;
}

// ── Global Settings Partial ─────────────────────────────────────────────────

/**
 * Renders the editable Global Defaults panel.
 * Shows HTMX forms for classification, gate, budget, and enrichers.
 */
export function globalSettingsPartial(
  config: AutonomousConfig,
  _overrides?: ConfigOverrides,
  providerStatus?: ProviderStatus,
): string {
  // Provider card
  const ps = providerStatus ?? { anthropicKeySet: !!process.env.ANTHROPIC_API_KEY, azureKeySet: !!process.env.AZURE_AI_FOUNDRY_API_KEY };
  const isAzure = config.provider.active === "azure";
  const showAzure = isAzure ? "block" : "none";

  const anthropicBadge = ps.anthropicKeySet
    ? badge("Configured", "emerald")
    : badge("Not Set", "red");
  const azureBadge = ps.azureKeySet
    ? badge("Configured", "emerald")
    : badge("Not Set", "red");

  const providerFields = [
    select("activeProvider", "API Provider", [
      { value: "anthropic", label: "Anthropic (Direct)" },
      { value: "azure", label: "Azure AI Foundry" },
    ], config.provider.active,
    `onchange="(function(s){var az=s.value==='azure';document.getElementById('azure-provider-fields').style.display=az?'block':'none';})(this)"`),
    `<div class="flex items-center justify-between py-1">
      <span class="text-xs text-slate-500">Anthropic API Key</span>
      ${anthropicBadge}
    </div>`,
    input("anthropicApiKey", "Anthropic API Key", {
      type: "password",
      placeholder: ps.anthropicKeySet ? "Saved — leave blank to keep" : "sk-ant-...",
    }),
    `<div id="azure-provider-fields" style="display:${showAzure}">
      <div class="flex items-center justify-between py-1">
        <span class="text-xs text-slate-500">Azure AI Foundry API Key</span>
        ${azureBadge}
      </div>
      ${input("azureApiKey", "Azure API Key", {
        type: "password",
        placeholder: ps.azureKeySet ? "Saved — leave blank to keep" : "API key",
      })}
      ${input("azureEndpointUrl", "Azure Endpoint URL", {
        value: config.provider.azure.endpointUrl,
        placeholder: "https://your-resource.services.ai.azure.com/...",
      })}
      <p class="mt-1 text-xs text-slate-500">Azure may require dated model names — update the Models section below.</p>
    </div>`,
  ].join("");

  const providerCard = card(providerFields, {
    title: "Provider",
    padding: "compact",
  });

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
      ${providerCard}
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

// ── Exported Full Page ──────────────────────────────────────────────────────

/**
 * Global settings page — per-repo config has moved to /repos.
 */
export function settingsPage(
  config: AutonomousConfig,
  user: SessionUser,
  overrides?: ConfigOverrides,
  providerStatus?: ProviderStatus,
): string {
  const content = `<div class="space-y-8">
  <!-- Header -->
  <div>
    <h2 class="text-xl font-semibold text-slate-50">Settings</h2>
    <p class="mt-1 text-sm text-slate-400">Manage global autonomous pipeline defaults.</p>
  </div>

  <!-- Global settings form -->
  <div id="settings-content">
    ${globalSettingsPartial(config, overrides, providerStatus)}
  </div>
</div>`;

  return layout("Settings", content, user);
}
