import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import {
  getAutonomousConfig,
  getConfigOverrides,
  saveConfigOverrides,
  type ConfigOverrides,
  type GateMode,
  type ApiProvider,
  type ClarificationConfig,
} from "../../domain/autonomous-config.js";
import { resetClient } from "../../agents/sdk.js";
import * as repoQueries from "../../db/queries/repos.js";
import { create } from "../../db/queries/tasks.js";
import { repoSecretName, setSecret, deleteSecret } from "../../vault/keyvault.js";
import { isDuplicate } from "../../producers/base.js";
import type { SettingsTab, ProviderStatus } from "../views/settings.js";
import {
  settingsPage,
  settingsPanel,
  globalSettingsPartial,
  repoSettingsPartial,
  repoSettingsCard,
} from "../views/settings.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_TABS = new Set<SettingsTab>(["global", "repos"]);
const VALID_GATE_MODES = new Set(["ai", "human", "auto"]);
const VALID_CLARIFICATION_MODES = new Set(["human", "ai", "auto"]);
const VALID_PROVIDERS = new Set<ApiProvider>(["anthropic", "azure"]);

function getProviderStatus(): ProviderStatus {
  return {
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
    azureKeySet: !!process.env.AZURE_AI_FOUNDRY_API_KEY,
  };
}

function isValidTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && VALID_TABS.has(value as SettingsTab);
}

// ── GET /settings ─ Full settings page ──────────────────────────────────────

router.get("/settings", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const config = getAutonomousConfig();
    const repos = await repoQueries.listAll();
    const tab: SettingsTab = isValidTab(req.query.tab) ? req.query.tab : "global";
    const overrides = tab === "global" ? await getConfigOverrides() : undefined;

    const ps = tab === "global" ? getProviderStatus() : undefined;
    res.send(settingsPage(config, repos, user, tab, overrides, ps));
  } catch (err) {
    next(err);
  }
});

// ── GET /settings/tab ─ HTMX partial for tab switching ─────────────────────

router.get("/settings/tab", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tab = req.query.tab;

    if (!isValidTab(tab)) {
      res.status(400).send("Invalid tab. Must be one of: global, repos");
      return;
    }

    let tabContent: string;
    if (tab === "global") {
      const config = getAutonomousConfig();
      const overrides = await getConfigOverrides();
      tabContent = globalSettingsPartial(config, overrides, getProviderStatus());
    } else {
      const repos = await repoQueries.listAll();
      tabContent = repoSettingsPartial(repos);
    }
    res.send(settingsPanel(tab, tabContent));
  } catch (err) {
    next(err);
  }
});

// ── POST /settings/global ─ Update global config overrides ─────────────────

const VALID_TYPES = new Set(["bug", "feature", "security", "refactor", "improvement"]);
const VALID_SIZES = new Set(["trivial", "small", "medium", "large"]);

router.post("/settings/global", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, string>;
    const previousProvider = getAutonomousConfig().provider.active;

    // Validate provider
    const activeProvider = body.activeProvider?.trim() as ApiProvider | undefined;
    if (activeProvider && !VALID_PROVIDERS.has(activeProvider)) {
      res.status(400).send("Invalid provider. Must be one of: anthropic, azure");
      return;
    }

    const anthropicApiKey = body.anthropicApiKey?.trim();
    const azureApiKey = body.azureApiKey?.trim();

    if (activeProvider === "azure") {
      // Azure key must either already exist or be provided in this request
      if (!process.env.AZURE_AI_FOUNDRY_API_KEY && !azureApiKey) {
        res.status(400).send("Cannot switch to Azure AI Foundry: provide an Azure API key first");
        return;
      }
      const azureEndpoint = body.azureEndpointUrl?.trim();
      if (!azureEndpoint || !azureEndpoint.startsWith("https://")) {
        res.status(400).send("Azure endpoint URL must start with https://");
        return;
      }
    }

    // Validate classification
    const defaultType = body.defaultType?.trim();
    if (defaultType && !VALID_TYPES.has(defaultType)) {
      res.status(400).send("Invalid default type");
      return;
    }

    const defaultSize = body.defaultSize?.trim();
    if (defaultSize && !VALID_SIZES.has(defaultSize)) {
      res.status(400).send("Invalid default size");
      return;
    }

    // Validate gate mode
    const gateMode = body.gateMode?.trim();
    if (gateMode && !VALID_GATE_MODES.has(gateMode)) {
      res.status(400).send("Invalid gate mode. Must be one of: ai, human, auto");
      return;
    }

    // Validate clarification mode
    const clarificationMode = body.clarificationMode?.trim();
    if (clarificationMode && !VALID_CLARIFICATION_MODES.has(clarificationMode)) {
      res.status(400).send("Invalid clarification mode. Must be one of: human, ai, auto");
      return;
    }

    // Validate budget
    const dailyDefault = body.dailyDefault?.trim();
    if (dailyDefault !== undefined && dailyDefault !== "") {
      const val = Number(dailyDefault);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Daily default must be a non-negative number");
        return;
      }
    }

    const perTaskMax = body.perTaskMax?.trim();
    if (perTaskMax !== undefined && perTaskMax !== "") {
      const val = Number(perTaskMax);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Per-task max must be a non-negative number");
        return;
      }
    }

    // Build overrides object
    const overrides: ConfigOverrides = {};

    // Provider
    if (activeProvider) {
      overrides.provider = { active: activeProvider };
      if (activeProvider === "azure") {
        const azureEndpoint = body.azureEndpointUrl?.trim();
        overrides.provider.azure = { endpointUrl: azureEndpoint || "" };
      }
    }

    if (defaultType || defaultSize) {
      overrides.classification = {};
      if (defaultType) overrides.classification.defaultType = defaultType;
      if (defaultSize) overrides.classification.defaultSize = defaultSize;
    }

    if (gateMode) {
      overrides.gate = { mode: gateMode as GateMode };
    }

    if ((dailyDefault !== undefined && dailyDefault !== "") ||
        (perTaskMax !== undefined && perTaskMax !== "")) {
      overrides.budget = {};
      if (dailyDefault !== undefined && dailyDefault !== "") {
        overrides.budget.dailyDefault = Number(dailyDefault);
      }
      if (perTaskMax !== undefined && perTaskMax !== "") {
        overrides.budget.perTaskMax = Number(perTaskMax);
      }
    }

    if (clarificationMode) {
      overrides.clarification = { mode: clarificationMode as ClarificationConfig["mode"] };
    }

    // Concurrency
    const maxConcurrentRaw = body.maxConcurrent?.trim();
    if (maxConcurrentRaw !== undefined && maxConcurrentRaw !== "") {
      const val = Number(maxConcurrentRaw);
      if (!Number.isInteger(val) || val < 1 || val > 20) {
        res.status(400).send("Max concurrent must be an integer between 1 and 20");
        return;
      }
    }

    const maxPerUserRaw = body.maxPerUser?.trim();
    if (maxPerUserRaw !== undefined && maxPerUserRaw !== "") {
      const val = Number(maxPerUserRaw);
      if (!Number.isInteger(val) || val < 1 || val > 20) {
        res.status(400).send("Max per user must be an integer between 1 and 20");
        return;
      }
    }

    // Models
    const defaultModel = body.defaultModel?.trim();
    const inputCostRaw = body.inputCostPerM?.trim();
    const outputCostRaw = body.outputCostPerM?.trim();

    if (inputCostRaw !== undefined && inputCostRaw !== "") {
      const val = Number(inputCostRaw);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Input cost must be a non-negative number");
        return;
      }
    }
    if (outputCostRaw !== undefined && outputCostRaw !== "") {
      const val = Number(outputCostRaw);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Output cost must be a non-negative number");
        return;
      }
    }

    const components: Record<string, string> = {};
    for (const key of Object.keys(body)) {
      if (key.startsWith("component_")) {
        const val = body[key].trim();
        if (val) components[key.slice("component_".length)] = val;
      }
    }

    if (defaultModel || (inputCostRaw && inputCostRaw !== "") || (outputCostRaw && outputCostRaw !== "") || Object.keys(components).length > 0) {
      overrides.models = {};
      if (defaultModel) overrides.models.default = defaultModel;
      if (inputCostRaw && inputCostRaw !== "") overrides.models.inputCostPerM = Number(inputCostRaw);
      if (outputCostRaw && outputCostRaw !== "") overrides.models.outputCostPerM = Number(outputCostRaw);
      if (Object.keys(components).length > 0) overrides.models.components = components;
    }

    // Concurrency overrides
    if ((maxConcurrentRaw !== undefined && maxConcurrentRaw !== "") ||
        (maxPerUserRaw !== undefined && maxPerUserRaw !== "")) {
      overrides.concurrency = {};
      if (maxConcurrentRaw !== undefined && maxConcurrentRaw !== "") {
        overrides.concurrency.maxConcurrent = Number(maxConcurrentRaw);
      }
      if (maxPerUserRaw !== undefined && maxPerUserRaw !== "") {
        overrides.concurrency.maxPerUser = Number(maxPerUserRaw);
      }
    }

    // Prism
    const prismApiUrl = body.prismApiUrl?.trim();
    const prismApiKey = body.prismApiKey?.trim();

    if (prismApiUrl || prismApiKey) {
      overrides.prism = {};
      if (prismApiUrl) overrides.prism.apiUrl = prismApiUrl;
      if (prismApiKey) overrides.prism.apiKey = prismApiKey;
    }

    // Preview
    const composeUpTimeout = body.composeUpTimeout?.trim();
    if (composeUpTimeout !== undefined && composeUpTimeout !== "") {
      const val = Number(composeUpTimeout);
      if (Number.isNaN(val) || val < 30) {
        res.status(400).send("Compose up timeout must be at least 30 seconds");
        return;
      }
      overrides.preview = { compose_up_timeout_seconds: val };
    }

    const updatedConfig = await saveConfigOverrides(overrides);

    // Save API keys to Key Vault and update process.env for immediate effect
    let clientNeedsReset = activeProvider !== undefined && activeProvider !== previousProvider;

    if (anthropicApiKey) {
      await setSecret("anthropic-api-key", anthropicApiKey);
      process.env.ANTHROPIC_API_KEY = anthropicApiKey;
      clientNeedsReset = true;
    }
    if (azureApiKey) {
      await setSecret("azure-ai-foundry-api-key", azureApiKey);
      process.env.AZURE_AI_FOUNDRY_API_KEY = azureApiKey;
      clientNeedsReset = true;
    }

    if (clientNeedsReset) {
      resetClient();
    }

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Global settings saved", type: "success" } }),
    );
    res.send(globalSettingsPartial(updatedConfig, overrides, getProviderStatus()));
  } catch (err) {
    next(err);
  }
});

// ── POST /settings/repos/:id ─ Update per-repo settings ────────────────────

router.post("/settings/repos/:id", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repoId = Number(req.params.id);
    if (Number.isNaN(repoId)) {
      res.status(400).send("Invalid repo id");
      return;
    }

    // Build settings object from form fields, stripping empty strings
    const settings: Record<string, unknown> = {};
    const body = req.body as Record<string, string>;

    // Gate mode override
    const gateModeKey = `gateMode_${repoId}`;
    if (body[gateModeKey] && body[gateModeKey] !== "") {
      if (!VALID_GATE_MODES.has(body[gateModeKey])) {
        res.status(400).send("Invalid gateMode. Must be one of: ai, human, auto");
        return;
      }
      settings.gateMode = body[gateModeKey];
    }

    // Per-task budget
    const perTaskMaxKey = `perTaskMax_${repoId}`;
    if (body[perTaskMaxKey] && body[perTaskMaxKey] !== "") {
      const val = Number(body[perTaskMaxKey]);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Invalid perTaskMax. Must be a non-negative number");
        return;
      }
      settings.perTaskMax = val;
    }

    // Prism slug
    const prismSlugKey = `prismSlug_${repoId}`;
    const prismSlugVal = body[prismSlugKey]?.trim();
    if (prismSlugVal) {
      settings.prismSlug = prismSlugVal;
    }

    // Daily budget
    const dailyBudgetKey = `dailyBudget_${repoId}`;
    if (body[dailyBudgetKey] && body[dailyBudgetKey] !== "") {
      const val = Number(body[dailyBudgetKey]);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Invalid dailyBudget. Must be a non-negative number");
        return;
      }
      settings.dailyBudget = val;
    }

    // Producer toggles & config
    const PRODUCER_NAMES = ["log-scanner", "bug-hunter", "security-scanner", "feature-scout", "maintenance", "self-monitor"];
    const MAX_CONFIG_SIZE = 10 * 1024; // 10 KB

    const producers: Record<string, { enabled: boolean; config?: Record<string, unknown> }> = {};
    for (const name of PRODUCER_NAMES) {
      const enabledKey = `producer_enabled_${name}_${repoId}`;
      const configKey = `producer_config_${name}_${repoId}`;

      const enabled = body[enabledKey] === "true";
      const configRaw = body[configKey]?.trim();

      let config: Record<string, unknown> | undefined;
      if (configRaw && configRaw !== "") {
        if (configRaw.length > MAX_CONFIG_SIZE) {
          res.status(400).send(`Producer config for "${name}" exceeds 10 KB limit`);
          return;
        }
        try {
          const parsed = JSON.parse(configRaw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            res.status(400).send(`Producer config for "${name}" must be a JSON object`);
            return;
          }
          config = parsed as Record<string, unknown>;
        } catch {
          res.status(400).send(`Invalid JSON in producer config for "${name}"`);
          return;
        }
      }

      producers[name] = { enabled, ...(config ? { config } : {}) };
    }
    settings.producers = producers;

    // Enricher toggles
    const ENRICHER_NAMES = ["codebase", "docs", "git-history", "dependencies", "prism", "architect", "scorer"];
    const enrichers: Record<string, { enabled: boolean }> = {};
    for (const name of ENRICHER_NAMES) {
      const enabledKey = `enricher_enabled_${name}_${repoId}`;
      enrichers[name] = { enabled: body[enabledKey] === "true" };
    }
    settings.enrichers = enrichers;

    // Documentation toggle
    const docsEnabledKey = `docs_enabled_${repoId}`;
    const docsEnabled = body[docsEnabledKey] === "true";
    settings.docs = { enabled: docsEnabled };

    // Build system override
    const VALID_BUILD_SYSTEMS = new Set(["npm", "dotnet", "dotnet+npm"]);
    const buildSystemKey = `buildSystem_${repoId}`;
    const buildNpmDirKey = `buildNpmDir_${repoId}`;
    const buildSystemVal = body[buildSystemKey]?.trim();
    const buildNpmDirVal = body[buildNpmDirKey]?.trim();

    if (buildSystemVal || buildNpmDirVal) {
      if (buildSystemVal && !VALID_BUILD_SYSTEMS.has(buildSystemVal)) {
        res.status(400).send("Invalid build system. Must be one of: npm, dotnet, dotnet+npm");
        return;
      }
      const build: Record<string, string> = {};
      if (buildSystemVal) build.system = buildSystemVal;
      if (buildNpmDirVal) build.npmDir = buildNpmDirVal;
      settings.build = build;
    }

    // Preview settings
    const preview: Record<string, unknown> = {};
    const previewEnabledKey = `previewEnabled_${repoId}`;
    const previewEnabledVal = body[previewEnabledKey]?.trim();
    if (previewEnabledVal === "true") {
      preview.enabled = true;
    } else if (previewEnabledVal === "false") {
      preview.enabled = false;
    }
    // If empty/omitted, don't set — falls through to global default

    const previewTimeoutKey = `previewTimeout_${repoId}`;
    const previewTimeoutVal = body[previewTimeoutKey]?.trim();
    if (previewTimeoutVal && previewTimeoutVal !== "") {
      const val = Number(previewTimeoutVal);
      if (Number.isNaN(val) || val < 1 || val > 1440) {
        res.status(400).send("Preview timeout must be between 1 and 1440 minutes");
        return;
      }
      preview.cleanup_timeout_minutes = val;
    }

    // Preview deploy config
    const VALID_PREVIEW_TYPES = new Set(["compose", "testcontainers", "process"]);
    const previewTypeVal = body[`previewType_${repoId}`]?.trim();

    if (previewTypeVal && previewTypeVal !== "") {
      if (!VALID_PREVIEW_TYPES.has(previewTypeVal)) {
        res.status(400).send("Invalid preview type. Must be one of: compose, testcontainers, process");
        return;
      }
      preview.type = previewTypeVal;

      // Port — required when type is set
      const portVal = body[`previewPort_${repoId}`]?.trim();
      if (!portVal || portVal === "") {
        res.status(400).send("Port is required when preview type is set");
        return;
      }
      const portNum = Number(portVal);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        res.status(400).send("Port must be an integer between 1 and 65535");
        return;
      }
      preview.port = portNum;

      // Health check path — optional
      const healthVal = body[`previewHealthCheck_${repoId}`]?.trim();
      if (healthVal && healthVal !== "") {
        preview.health_check = healthVal;
      }

      // Startup timeout — optional, 1-600 seconds
      const startupVal = body[`previewStartupTimeout_${repoId}`]?.trim();
      if (startupVal && startupVal !== "") {
        const startupNum = Number(startupVal);
        if (!Number.isInteger(startupNum) || startupNum < 1 || startupNum > 600) {
          res.status(400).send("Startup timeout must be between 1 and 600 seconds");
          return;
        }
        preview.startup_timeout = startupNum;
      }

      // Compose-specific fields
      if (previewTypeVal === "compose") {
        const composeFile = body[`previewComposeFile_${repoId}`]?.trim();
        const appService = body[`previewAppService_${repoId}`]?.trim();
        if (!composeFile || composeFile === "") {
          res.status(400).send("Compose file is required for Docker Compose preview type");
          return;
        }
        if (!appService || appService === "") {
          res.status(400).send("App service name is required for Docker Compose preview type");
          return;
        }
        preview.compose_file = composeFile;
        preview.app_service = appService;
      }

      // Command-specific fields (testcontainers / process)
      if (previewTypeVal === "testcontainers" || previewTypeVal === "process") {
        const startCommand = body[`previewStartCommand_${repoId}`]?.trim();
        if (!startCommand || startCommand === "") {
          res.status(400).send("Start command is required for this preview type");
          return;
        }
        preview.start_command = startCommand;
      }

      // Environment variables — KEY=VALUE per line
      const envRaw = body[`previewEnv_${repoId}`]?.trim();
      if (envRaw && envRaw !== "") {
        const env: Record<string, string> = {};
        for (const line of envRaw.split("\n")) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) {
            res.status(400).send(`Invalid env var line: "${trimmed}". Expected KEY=VALUE format`);
            return;
          }
          env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
        if (Object.keys(env).length > 0) {
          preview.env = env;
        }
      }
    }

    if (Object.keys(preview).length > 0) {
      settings.preview = preview;
    }

    // npm registry
    const npmUrlKey = `npmRegistryUrl_${repoId}`;
    const npmScopeKey = `npmScope_${repoId}`;
    const npmTokenKey = `npmToken_${repoId}`;
    const npmUrl = body[npmUrlKey]?.trim();
    const npmScope = body[npmScopeKey]?.trim();
    const npmToken = body[npmTokenKey]?.trim();

    if (npmUrl) {
      const npmSettings: Record<string, unknown> = { url: npmUrl };
      if (npmScope) npmSettings.scope = npmScope;

      if (npmToken) {
        const secretName = repoSecretName(repoId, "npm-token");
        await setSecret(secretName, npmToken);
        npmSettings.tokenVaultId = secretName;
      } else {
        // Preserve existing vault reference
        const currentRepo = await repoQueries.getById(repoId);
        const cur = (currentRepo?.settings ?? {}) as Record<string, unknown>;
        const curNpm = cur.npm as Record<string, unknown> | undefined;
        if (curNpm?.tokenVaultId) npmSettings.tokenVaultId = curNpm.tokenVaultId;
      }

      settings.npm = npmSettings;
    } else {
      // URL cleared — remove npm config and clean up vault secret
      const currentRepo = await repoQueries.getById(repoId);
      const cur = (currentRepo?.settings ?? {}) as Record<string, unknown>;
      const curNpm = cur.npm as Record<string, unknown> | undefined;
      if (curNpm?.tokenVaultId) {
        await deleteSecret(curNpm.tokenVaultId as string);
      }
      // Don't set settings.npm — it will be removed
    }

    // NuGet feed
    const nugetUrlKey = `nugetFeedUrl_${repoId}`;
    const nugetTokenKey = `nugetToken_${repoId}`;
    const nugetUrl = body[nugetUrlKey]?.trim();
    const nugetToken = body[nugetTokenKey]?.trim();

    if (nugetUrl) {
      const nugetSettings: Record<string, unknown> = { url: nugetUrl };

      if (nugetToken) {
        const secretName = repoSecretName(repoId, "nuget-token");
        await setSecret(secretName, nugetToken);
        nugetSettings.tokenVaultId = secretName;
      } else {
        const currentRepo = await repoQueries.getById(repoId);
        const cur = (currentRepo?.settings ?? {}) as Record<string, unknown>;
        const curNuget = cur.nuget as Record<string, unknown> | undefined;
        if (curNuget?.tokenVaultId) nugetSettings.tokenVaultId = curNuget.tokenVaultId;
      }

      settings.nuget = nugetSettings;
    } else {
      const currentRepo = await repoQueries.getById(repoId);
      const cur = (currentRepo?.settings ?? {}) as Record<string, unknown>;
      const curNuget = cur.nuget as Record<string, unknown> | undefined;
      if (curNuget?.tokenVaultId) {
        await deleteSecret(curNuget.tokenVaultId as string);
      }
    }

    // If docs just got enabled, create a bootstrap task
    if (docsEnabled) {
      const currentRepo = await repoQueries.getById(repoId);
      const currentSettings = (currentRepo?.settings ?? {}) as Record<string, unknown>;
      const wasEnabled = (currentSettings.docs as Record<string, unknown> | undefined)?.enabled === true;

      if (!wasEnabled) {
        const bootstrapTitle = `Bootstrap documentation for ${currentRepo!.fullName}`;
        const bootstrapSource = "docs-bootstrap";

        if (!(await isDuplicate(bootstrapSource, bootstrapTitle))) {
          await create({
            title: bootstrapTitle,
            body: [
              "Scan the codebase and generate initial documentation:",
              "",
              "1. Create `docs/internal/` with:",
              "   - `architecture.md` — high-level system overview, key components, data flow",
              "   - `modules.md` — per-module guide for major source directories",
              "   - `conventions.md` — coding patterns, naming, error handling, testing approach",
              "",
              "2. If the repo has API routes (Express, REST, etc.), create `docs/external/` with:",
              "   - `api.md` — endpoint reference with methods, paths, request/response shapes",
              "",
              "Base everything on the actual source code. Keep docs concise and maintainable.",
            ].join("\n"),
            source: bootstrapSource,
            type: "documentation",
            repoId,
            createdBy: req.session.user!.id,
          });
        }
      }
    }

    const updated = await repoQueries.updateSettings(repoId, settings);
    if (!updated) {
      res.status(404).send("Repo not found");
      return;
    }

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Repo settings saved", type: "success" } }),
    );
    res.send(repoSettingsCard(updated));
  } catch (err) {
    next(err);
  }
});

// ── DELETE /settings/repos/:id ─ Delete a repo and all dependent data ──────

router.delete("/settings/repos/:id", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repoId = Number(req.params.id);
    if (Number.isNaN(repoId)) {
      res.status(400).send("Invalid repo id");
      return;
    }

    const deleted = await repoQueries.deleteById(repoId);
    if (!deleted) {
      res.status(404).send("Repo not found");
      return;
    }

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Repo deleted", type: "success" } }),
    );
    res.send("");
  } catch (err) {
    next(err);
  }
});

// ── POST /settings/repos ─ Create a new repo ───────────────────────────────

router.post("/settings/repos", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, string>;
    const provider = body.provider?.trim();
    const fullName = body.fullName?.trim();
    const defaultBranch = body.defaultBranch?.trim() || undefined;

    if (!provider || !fullName) {
      res.status(400).send("Provider and full name are required");
      return;
    }

    const repo = await repoQueries.findOrCreate(provider, fullName, defaultBranch);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Repo added", type: "success" } }),
    );
    res.send(repoSettingsCard(repo));
  } catch (err) {
    next(err);
  }
});

export default router;
