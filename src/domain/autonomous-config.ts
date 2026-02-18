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

export interface AutonomousConfig {
  classification: ClassificationConfig;
  gate: GateConfig;
  budget: BudgetConfig;
  models: ModelConfig;
  enrichers: EnricherEntry[];
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
