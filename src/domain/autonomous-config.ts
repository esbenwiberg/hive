import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

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

/** Singleton instance — loaded once and reused. */
let _config: AutonomousConfig | undefined;

/**
 * Returns the cached autonomous config, loading it on first access.
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
