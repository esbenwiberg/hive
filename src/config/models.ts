/**
 * src/config/models.ts
 *
 * Per-component model configuration resolution.
 *
 * Resolves which LLM provider + model to use for each pipeline component,
 * honouring the following precedence:
 *
 *   1. `models.componentProviders.<name>` block in autonomous.config.yaml
 *      (full ModelProvider config — azure-openai, azure-anthropic, or anthropic)
 *   2. `models.components.<name>` string in autonomous.config.yaml
 *      (treated as Anthropic direct with that model name)
 *   3. `models.default` in autonomous.config.yaml
 *      (treated as Anthropic direct with that model name)
 *   4. Hard-coded default: Anthropic + "claude-sonnet-4-6"
 *
 * For azure-openai and azure-anthropic providers the function validates that
 * `endpoint`, `deploymentName`, and `apiKey` are all non-empty, throwing a
 * descriptive error on startup if they are not.
 */

import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { ComponentModelConfig, ComponentName } from "../domain/types.js";
import type { ModelProvider } from "../agents/providers/types.js";

// ── Re-exports ───────────────────────────────────────────────────────────────

export type { ComponentModelConfig, ComponentName };

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates a `ComponentModelConfig` that declares an Azure-based provider.
 * Throws a descriptive `Error` when a required field is missing or empty.
 */
function validateAzureConfig(
  component: string,
  cfg: ComponentModelConfig,
): void {
  const missing: string[] = [];

  if (!cfg.endpoint || cfg.endpoint.trim() === "") missing.push("endpoint");
  if (!cfg.deploymentName || cfg.deploymentName.trim() === "")
    missing.push("deploymentName");
  if (!cfg.apiKey || cfg.apiKey.trim() === "") missing.push("apiKey");

  if (missing.length > 0) {
    throw new Error(
      `[models config] Component "${component}" uses provider type "${cfg.type}" ` +
        `but is missing required field(s): ${missing.join(", ")}. ` +
        `Please add them under models.componentProviders.${component} in autonomous.config.yaml.`,
    );
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Returns a `ModelProvider` for the given pipeline component.
 *
 * Applies the precedence rules described in the module-level JSDoc and
 * validates Azure configurations at resolution time (typically at startup).
 */
export function resolveModelConfig(component: ComponentName): ModelProvider {
  const config = getAutonomousConfig();
  const { models } = config;

  // 1. Full provider override block
  const providerOverride = models.componentProviders?.[component];
  if (providerOverride) {
    const { type } = providerOverride;

    if (type === "azure-openai") {
      validateAzureConfig(component, providerOverride);
      return {
        type: "azure-openai",
        endpoint: providerOverride.endpoint!,
        deploymentName: providerOverride.deploymentName!,
        apiKey: providerOverride.apiKey!,
        model: providerOverride.model ?? "claude-sonnet-4-6",
      };
    }

    if (type === "azure-anthropic") {
      validateAzureConfig(component, providerOverride);
      return {
        type: "azure-anthropic",
        endpoint: providerOverride.endpoint!,
        deploymentName: providerOverride.deploymentName!,
        apiKey: providerOverride.apiKey!,
        model: providerOverride.model ?? "claude-sonnet-4-6",
      };
    }

    // type === "anthropic"
    return {
      type: "anthropic",
      model: providerOverride.model ?? "claude-sonnet-4-6",
      ...(providerOverride.apiKey ? { apiKey: providerOverride.apiKey } : {}),
    };
  }

  // 2. Simple per-component model string (implies Anthropic direct)
  const simpleModel = models.components?.[component];
  if (simpleModel) {
    return { type: "anthropic", model: simpleModel };
  }

  // 3. Global default model (implies Anthropic direct)
  if (models.default) {
    return { type: "anthropic", model: models.default };
  }

  // 4. Hard-coded fallback
  return { type: "anthropic", model: "claude-sonnet-4-6" };
}
