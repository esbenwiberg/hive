/**
 * Admin routes for per-component model configuration.
 *
 * GET  /admin/models              — renders the model config page
 * POST /admin/models/:component   — updates a component's provider config
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireRole } from "../../auth/middleware.js";
import {
  getAutonomousConfig,
  reloadConfig,
} from "../../domain/autonomous-config.js";
import { getConfig, setConfig } from "../../domain/config.js";
import type { ComponentModelConfig } from "../../domain/types.js";
import type { ModelProvider } from "../../agents/providers/types.js";
import {
  modelConfigPage,
  modelConfigRow,
  PIPELINE_COMPONENTS,
  type ComponentProviderDisplay,
} from "../views/components.js";

export const modelsRouter = Router();

// ── Auth guard: admin only ────────────────────────────────────────────────

modelsRouter.use(requireRole("admin") as unknown as (req: Request, res: Response, next: NextFunction) => void);

// ── Config DB key (same as autonomous-config uses) ────────────────────────

const CONFIG_DB_KEY = "autonomous";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Reads component provider overrides from the live config store (same store
 * that autonomous-config writes to), keyed by component name.
 */
async function getComponentProviders(): Promise<Record<string, ComponentModelConfig>> {
  const raw = await getConfig(CONFIG_DB_KEY) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return {};
  const models = raw.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object") return {};
  const cp = models.componentProviders as Record<string, ComponentModelConfig> | undefined;
  return cp && typeof cp === "object" ? cp : {};
}

/**
 * Saves updated component provider overrides back to the live config store
 * AND updates the in-process singleton so the change is immediate.
 */
async function saveComponentProvider(
  component: string,
  provider: ComponentModelConfig,
): Promise<void> {
  // Load existing DB overrides
  const raw = ((await getConfig(CONFIG_DB_KEY)) as Record<string, unknown>) ?? {};

  // Merge in the new provider entry
  const models = (raw.models as Record<string, unknown>) ?? {};
  const componentProviders = (models.componentProviders as Record<string, ComponentModelConfig>) ?? {};
  componentProviders[component] = provider;

  const updated = {
    ...raw,
    models: {
      ...models,
      componentProviders,
    },
  };

  await setConfig(CONFIG_DB_KEY, updated);

  // Reload the file-based singleton so it picks up the latest YAML
  reloadConfig();

  // Then patch the in-memory singleton directly for instant hot-reload effect
  const liveConfig = getAutonomousConfig();
  if (!liveConfig.models.componentProviders) {
    liveConfig.models.componentProviders = {};
  }
  liveConfig.models.componentProviders[component] = provider;
}

/**
 * Builds a ComponentProviderDisplay for every known pipeline component,
 * merging YAML defaults with any DB overrides.
 */
async function buildDisplayList(): Promise<ComponentProviderDisplay[]> {
  const liveConfig = getAutonomousConfig();
  const dbProviders = await getComponentProviders();

  return PIPELINE_COMPONENTS.map((name) => {
    // DB overrides take precedence over YAML
    const providerCfg: ComponentModelConfig | undefined =
      dbProviders[name] ?? liveConfig.models.componentProviders?.[name];

    if (providerCfg && "type" in providerCfg) {
      const p = providerCfg as ModelProvider;
      return {
        component: name,
        type: p.type,
        model: p.model ?? "",
        endpoint: ("endpoint" in p ? (p as { endpoint: string }).endpoint : "") ?? "",
        deploymentName: ("deploymentName" in p ? (p as { deploymentName: string }).deploymentName : "") ?? "",
        hasProviderOverride: true,
      };
    }

    // Fall back to simple model string override or global default
    const simpleModel =
      liveConfig.models.components?.[name] ?? liveConfig.models.default ?? "";

    return {
      component: name,
      type: "anthropic",
      model: simpleModel,
      endpoint: "",
      deploymentName: "",
      hasProviderOverride: false,
    };
  });
}

// ── GET /admin/models ─────────────────────────────────────────────────────

modelsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const components = await buildDisplayList();
    const user = (req as Request & { user?: { name?: string; displayName?: string; role?: string } }).user;
    const html = modelConfigPage(components, {
      name: user?.name ?? user?.displayName ?? "Admin",
      role: user?.role ?? "admin",
    });
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("[models] GET /admin/models error:", err);
    res.status(500).send("Internal server error");
  }
});

// ── POST /admin/models/:component ─────────────────────────────────────────

modelsRouter.post("/:component", async (req: Request, res: Response) => {
  const component = String(req.params["component"] ?? "");

  // Validate component name
  if (!(PIPELINE_COMPONENTS as readonly string[]).includes(component)) {
    res.status(400).send(`Unknown component: ${component}`);
    return;
  }

  const body = req.body as {
    type?: string;
    model?: string;
    endpoint?: string;
    deploymentName?: string;
    apiKey?: string;
  };
  const { type, model, endpoint, deploymentName, apiKey } = body;

  // Validate provider type
  const validTypes = ["anthropic", "azure-openai", "azure-anthropic"];
  if (!type || !validTypes.includes(type)) {
    res.status(400).send(`Invalid provider type. Must be one of: ${validTypes.join(", ")}`);
    return;
  }

  // Validate model is present
  if (!model || !model.trim()) {
    res.status(400).send("Model name is required.");
    return;
  }

  // Azure providers require endpoint and deploymentName
  if (type === "azure-openai" || type === "azure-anthropic") {
    if (!endpoint || !endpoint.trim()) {
      res.status(400).send("Endpoint URL is required for Azure providers.");
      return;
    }
    if (!deploymentName || !deploymentName.trim()) {
      res.status(400).send("Deployment name is required for Azure providers.");
      return;
    }
  }

  try {
    // Build the provider config
    let providerConfig: ComponentModelConfig;

    if (type === "anthropic") {
      providerConfig = {
        type: "anthropic",
        model: model.trim(),
        ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
      } as ComponentModelConfig;
    } else {
      // For Azure providers we need to preserve an existing API key if none supplied
      const existingProviders = await getComponentProviders();
      const existing = existingProviders[component] as (ModelProvider & { apiKey?: string }) | undefined;
      const resolvedApiKey =
        apiKey?.trim() ||
        (existing && "apiKey" in existing ? existing.apiKey : "") ||
        "";

      providerConfig = {
        type: type as "azure-openai" | "azure-anthropic",
        model: model.trim(),
        endpoint: endpoint!.trim(),
        deploymentName: deploymentName!.trim(),
        apiKey: resolvedApiKey,
      } as ComponentModelConfig;
    }

    await saveComponentProvider(component, providerConfig);

    // Build updated display row for HTMX swap
    const allComponents = await buildDisplayList();
    const updated = allComponents.find((c) => c.component === component)!;
    const rowHtml = modelConfigRow(updated);

    // Signal success via HX-Trigger header (toast)
    res.setHeader(
      "HX-Trigger",
      JSON.stringify({
        showToast: { type: "success", message: `${component} updated successfully` },
      }),
    );
    res.setHeader("Content-Type", "text/html");
    res.send(rowHtml);
  } catch (err) {
    console.error(`[models] POST /admin/models/${component} error:`, err);
    res.status(500).send("Failed to save configuration. Please try again.");
  }
});
