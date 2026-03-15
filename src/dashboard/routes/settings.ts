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
import { setSecret } from "../../vault/keyvault.js";
import type { ProviderStatus } from "../views/settings.js";
import {
  settingsPage,
  globalSettingsPartial,
} from "../views/settings.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_GATE_MODES = new Set(["ai", "human", "auto"]);
const VALID_CLARIFICATION_MODES = new Set(["human", "ai", "auto"]);
const VALID_PROVIDERS = new Set<ApiProvider>(["anthropic", "azure"]);

function getProviderStatus(): ProviderStatus {
  return {
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
    azureKeySet: !!process.env.AZURE_AI_FOUNDRY_API_KEY,
  };
}

// ── GET /settings ─ Full settings page (global-only) ────────────────────────

router.get("/settings", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Backwards-compat: redirect old repos tab bookmarks
    if (req.query.tab === "repos") {
      res.redirect(302, "/repos");
      return;
    }

    const user = req.session.user!;
    const config = getAutonomousConfig();
    const overrides = await getConfigOverrides();
    const ps = getProviderStatus();

    res.send(settingsPage(config, user, overrides, ps));
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

export default router;
