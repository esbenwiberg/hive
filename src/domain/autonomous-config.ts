import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { getConfig, setConfig } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClassificationConfig {
  defaultType: string;
  defaultSize: string;
}

export type GateMode = "ai" | "human" | "auto";

export interface GateConfig {
  mode: GateMode;
}

export interface BudgetConfig {
  dailyDefault: number;
  perTaskMax: number;
}

export interface ModelConfig {
  router: string;
  gate: string;
  /** Cost per million input tokens in USD */
  inputCostPerM: number;
  /** Cost per million output tokens in USD */
  outputCostPerM: number;
}

export interface ClarificationConfig {
  mode: "human" | "ai" | "auto";
}

export interface EnricherEntry {
  name: string;
  enabled: boolean;
}

export interface DockerHostConfig {
  ip: string;
  port: number;
  tls_cert_vault_secret: string;
  tls_key_vault_secret: string;
  tls_ca_vault_secret: string;
  ssh_key_vault_secret: string;
  ssh_user: string;
}

export interface PreviewSettings {
  enabled: boolean;
  max_concurrent: number;
  cleanup_timeout_minutes: number;
  docker_host: DockerHostConfig;
  port_range: [number, number];
}

export interface AutonomousConfig {
  classification: ClassificationConfig;
  gate: GateConfig;
  budget: BudgetConfig;
  models: ModelConfig;
  enrichers: EnricherEntry[];
  clarification: ClarificationConfig;
  preview: PreviewSettings;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS: AutonomousConfig = {
  classification: { defaultType: "improvement", defaultSize: "medium" },
  gate: { mode: "human" },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    router: "claude-sonnet-4-20250514",
    gate: "claude-sonnet-4-20250514",
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [],
  clarification: { mode: "human" },
  preview: {
    enabled: true,
    max_concurrent: 3,
    cleanup_timeout_minutes: 30,
    docker_host: {
      ip: "",
      port: 2376,
      tls_cert_vault_secret: "docker-tls-cert",
      tls_key_vault_secret: "docker-tls-key",
      tls_ca_vault_secret: "docker-tls-ca",
      ssh_key_vault_secret: "docker-ssh-key",
      ssh_user: "azureuser",
    },
    port_range: [4001, 4099],
  },
};

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads and parses `autonomous.config.yaml` from the project root.
 * Missing top-level keys are filled with defaults.
 */
export function loadConfig(
  filePath?: string,
): AutonomousConfig {
  const resolved = filePath ?? resolve("autonomous.config.yaml");

  let raw: Record<string, unknown>;
  try {
    const contents = readFileSync(resolved, "utf-8");
    raw = parse(contents) as Record<string, unknown>;
  } catch {
    // If the file is missing or unparseable, return defaults
    return { ...DEFAULTS };
  }

  const rawPreview = raw.preview as Partial<PreviewSettings> | undefined;

  const config: AutonomousConfig = {
    classification: {
      ...DEFAULTS.classification,
      ...(raw.classification as Partial<ClassificationConfig> | undefined),
    },
    gate: {
      ...DEFAULTS.gate,
      ...(raw.gate as Partial<GateConfig> | undefined),
    },
    budget: {
      ...DEFAULTS.budget,
      ...(raw.budget as Partial<BudgetConfig> | undefined),
    },
    models: {
      ...DEFAULTS.models,
      ...(raw.models as Partial<ModelConfig> | undefined),
    },
    enrichers: Array.isArray(raw.enrichers)
      ? (raw.enrichers as EnricherEntry[])
      : DEFAULTS.enrichers,
    clarification: {
      ...DEFAULTS.clarification,
      ...(raw.clarification as Partial<ClarificationConfig> | undefined),
    },
    preview: {
      ...DEFAULTS.preview,
      ...rawPreview,
      docker_host: {
        ...DEFAULTS.preview.docker_host,
        ...(rawPreview?.docker_host as Partial<DockerHostConfig> | undefined),
      },
      port_range: Array.isArray(rawPreview?.port_range)
        ? (rawPreview.port_range as [number, number])
        : DEFAULTS.preview.port_range,
    },
  };

  return config;
}

// ── DB Override Types ────────────────────────────────────────────────────────

/** Partial overrides that can be stored in the DB. */
export interface ConfigOverrides {
  classification?: Partial<ClassificationConfig>;
  gate?: Partial<GateConfig>;
  budget?: Partial<BudgetConfig>;
  clarification?: Partial<ClarificationConfig>;
}

const CONFIG_DB_KEY = "autonomous";

// ── Singleton ───────────────────────────────────────────────────────────────

/** Singleton instance — loaded once and reused. */
let _config: AutonomousConfig | undefined;

/**
 * Returns the cached autonomous config, loading it on first access.
 * After `initConfig()` is called, this includes DB overrides.
 */
export function getAutonomousConfig(): AutonomousConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Forces a reload of the autonomous config from disk.
 */
export function reloadConfig(): AutonomousConfig {
  _config = loadConfig();
  return _config;
}

// ── DB Override Functions ───────────────────────────────────────────────────

/**
 * Merges partial overrides onto a base config, returning a new config.
 */
function mergeOverrides(
  base: AutonomousConfig,
  overrides: ConfigOverrides,
): AutonomousConfig {
  return {
    ...base,
    classification: { ...base.classification, ...overrides.classification },
    gate: { ...base.gate, ...overrides.gate },
    budget: { ...base.budget, ...overrides.budget },
    clarification: { ...base.clarification, ...overrides.clarification },
  };
}

/**
 * Initializes the config cache by loading YAML defaults and merging
 * any DB overrides on top. Call once at startup after migrations.
 */
export async function initConfig(): Promise<AutonomousConfig> {
  const base = loadConfig();
  const raw = await getConfig(CONFIG_DB_KEY);
  if (raw && typeof raw === "object") {
    _config = mergeOverrides(base, raw as ConfigOverrides);
  } else {
    _config = base;
  }
  return _config;
}

/**
 * Reads the raw DB overrides (not merged with YAML defaults).
 * Returns an empty object if nothing has been saved yet.
 */
export async function getConfigOverrides(): Promise<ConfigOverrides> {
  const raw = await getConfig(CONFIG_DB_KEY);
  if (raw && typeof raw === "object") {
    return raw as ConfigOverrides;
  }
  return {};
}

/**
 * Saves partial overrides to the DB and refreshes the cached config.
 */
export async function saveConfigOverrides(
  overrides: ConfigOverrides,
): Promise<AutonomousConfig> {
  await setConfig(CONFIG_DB_KEY, overrides);
  const base = loadConfig();
  _config = mergeOverrides(base, overrides);
  return _config;
}
