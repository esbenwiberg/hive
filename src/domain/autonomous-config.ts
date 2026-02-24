import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { ModelProvider } from "./types.js";

let cachedConfig: any = null;

/**
 * Load and cache the autonomous.config.yaml file.
 */
function loadConfig(): any {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const configPath = resolve(process.cwd(), "autonomous.config.yaml");
    const content = readFileSync(configPath, "utf-8");
    cachedConfig = parse(content) || {};
    return cachedConfig;
  } catch (error) {
    console.warn(`Failed to load autonomous.config.yaml:`, error);
    return {};
  }
}

/**
 * Safely resolves the LLM provider configuration for a component.
 *
 * Precedence (highest to lowest):
 * 1. componentProviders.<componentName>
 * 2. defaultProvider
 * 3. Built-in default (Anthropic Claude 3.5 Sonnet)
 *
 * @param componentName - Component identifier
 * @returns ModelProvider or null if config cannot be loaded
 */
export function getModelFor(componentName: string): ModelProvider | null {
  try {
    const config = loadConfig();

    if (!config) {
      console.warn(`Config is null or undefined. Using built-in default.`);
      return getBuiltInDefault();
    }

    // Precedence 1: componentProviders
    if (
      config.componentProviders &&
      typeof config.componentProviders === "object" &&
      config.componentProviders[componentName]
    ) {
      const resolved = resolveModelProvider(
        config.componentProviders[componentName]
      );
      if (resolved) return resolved;
    }

    // Precedence 2: defaultProvider
    if (config.defaultProvider) {
      const resolved = resolveModelProvider(config.defaultProvider);
      if (resolved) return resolved;
    }

    // Precedence 3: Built-in default
    return getBuiltInDefault();
  } catch (error) {
    console.error(
      `Error resolving model provider for '${componentName}':`,
      error
    );
    return getBuiltInDefault();
  }
}

/**
 * Resolves a provider config object with defensive checks.
 */
function resolveModelProvider(raw: any): ModelProvider | null {
  if (!raw || typeof raw !== "object") {
    console.warn(`Invalid provider config (not an object):`, raw);
    return null;
  }

  const type = raw.type;
  const modelId = raw.modelId;

  if (!type || !modelId) {
    console.warn(
      `Invalid provider config: missing type or modelId. ` +
        `Received: ${JSON.stringify(raw)}`
    );
    return null;
  }

  const apiKey = resolveSecret(raw.apiKey);
  const apiKeyEnv = raw.apiKeyEnv;

  // At least one auth method should be present
  if (!apiKey && !apiKeyEnv) {
    console.warn(
      `Provider '${type}' for model '${modelId}' has no apiKey or apiKeyEnv. ` +
        `Ensure the environment variable is set at runtime.`
    );
  }

  const result: ModelProvider = {
    type: type as "anthropic" | "azure-openai" | "azure-anthropic",
    modelId: modelId,
  };

  if (apiKey) result.apiKey = apiKey;
  if (apiKeyEnv) result.apiKeyEnv = apiKeyEnv;
  if (raw.endpoint && typeof raw.endpoint === "string")
    result.endpoint = raw.endpoint;
  if (raw.deploymentName && typeof raw.deploymentName === "string")
    result.deploymentName = raw.deploymentName;

  return result;
}

/**
 * Resolves a secret from config or environment.
 * - If starts with '$', resolve from process.env
 * - Otherwise, return literal value
 */
function resolveSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (typeof value !== "string") return undefined;
  if (value.startsWith("$")) {
    const envVar = value.slice(1);
    const envValue = process.env[envVar];
    if (!envValue) {
      console.warn(
        `Environment variable '${envVar}' referenced but not set. ` +
          `Please set it before starting the application.`
      );
      return undefined;
    }
    return envValue;
  }
  return value;
}

/**
 * Built-in fallback provider (always safe).
 */
function getBuiltInDefault(): ModelProvider {
  return {
    type: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  };
}
