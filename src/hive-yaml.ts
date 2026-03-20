import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// ── Build system type ────────────────────────────────────────────────────────

export type BuildSystemType = "npm" | "dotnet" | "dotnet+npm";

// ── Build config ─────────────────────────────────────────────────────────────

export interface HiveBuildConfig {
  system?: BuildSystemType;
  /** Relative path from repo root to the dir containing package.json */
  npmDir?: string;
}

/**
 * Reads `.hive.yaml` from the given path and returns the parsed `build`
 * section, or null if the file is missing or has no build section.
 */
export function parseHiveBuildConfig(worktreePath: string): HiveBuildConfig | null {
  const filePath = join(worktreePath, ".hive.yaml");

  let contents: string;
  try {
    contents = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!doc || typeof doc !== "object" || !doc.build) {
    return null;
  }

  const raw = doc.build as Record<string, unknown>;
  const result: HiveBuildConfig = {};

  const system = raw.system as string | undefined;
  if (system && ["npm", "dotnet", "dotnet+npm"].includes(system)) {
    result.system = system as BuildSystemType;
  }

  const npmDir = raw.npm_dir as string | undefined;
  if (typeof npmDir === "string") {
    result.npmDir = npmDir;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Timeout config ──────────────────────────────────────────────────────────

/** Per-repo shell command timeout overrides (milliseconds). */
export interface HiveTimeoutConfig {
  /** npm/dotnet install timeout. Default: 120000 */
  install?: number;
  /** Build command timeout. Default: 120000 */
  build?: number;
  /** Test command timeout. Default: 120000 */
  test?: number;
  /** Lint command timeout. Default: 120000 */
  lint?: number;
}

/**
 * Reads `.hive.yaml` from the given path and returns the parsed `timeouts`
 * section, or null if the file is missing or has no timeouts section.
 */
export function parseHiveTimeoutConfig(worktreePath: string): HiveTimeoutConfig | null {
  const filePath = join(worktreePath, ".hive.yaml");

  let contents: string;
  try {
    contents = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!doc || typeof doc !== "object" || !doc.timeouts) {
    return null;
  }

  const raw = doc.timeouts as Record<string, unknown>;
  const result: HiveTimeoutConfig = {};

  for (const key of ["install", "build", "test", "lint"] as const) {
    if (typeof raw[key] === "number" && raw[key] > 0) {
      result[key] = raw[key] as number;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Execution config ────────────────────────────────────────────────────────

/** Per-repo execution overrides. */
export interface HiveExecutionConfig {
  /** Max review→rework cycles before failing. Default: 3 */
  maxReworkCycles?: number;
  /** Per-size turn cap overrides. Keys: trivial, small, medium, large. */
  maxTurns?: Record<string, number>;
  /** Context window limit in tokens. Default: 500_000. */
  contextWindow?: number;
  /** Turn at which proactive compaction starts. Default: 8. */
  compactionStartTurn?: number;
  /** Max chars preserved per tool result during compaction. Default: 800. */
  compactionMaxChars?: number;
  /** Max chars for project instruction files. Default: 24_000. */
  maxInstructionsChars?: number;
}

/**
 * Reads `.hive.yaml` and returns the `execution` section.
 */
export function parseHiveExecutionConfig(worktreePath: string): HiveExecutionConfig | null {
  const filePath = join(worktreePath, ".hive.yaml");

  let contents: string;
  try {
    contents = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!doc || typeof doc !== "object" || !doc.execution) {
    return null;
  }

  const raw = doc.execution as Record<string, unknown>;
  const result: HiveExecutionConfig = {};

  if (typeof raw.max_rework_cycles === "number" && raw.max_rework_cycles > 0) {
    result.maxReworkCycles = raw.max_rework_cycles;
  }
  if (raw.max_turns && typeof raw.max_turns === "object") {
    const caps: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.max_turns as Record<string, unknown>)) {
      if (typeof v === "number" && v > 0) caps[k] = v;
    }
    if (Object.keys(caps).length > 0) result.maxTurns = caps;
  }
  if (typeof raw.context_window === "number" && raw.context_window > 0) {
    result.contextWindow = raw.context_window;
  }
  if (typeof raw.compaction_start_turn === "number" && raw.compaction_start_turn > 0) {
    result.compactionStartTurn = raw.compaction_start_turn;
  }
  if (typeof raw.compaction_max_chars === "number" && raw.compaction_max_chars > 0) {
    result.compactionMaxChars = raw.compaction_max_chars;
  }
  if (typeof raw.max_instructions_chars === "number" && raw.max_instructions_chars > 0) {
    result.maxInstructionsChars = raw.max_instructions_chars;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Preview type interfaces ─────────────────────────────────────────────────

export interface BasePreviewConfig {
  type: "compose" | "testcontainers" | "process";
  port: number;
  health_check?: string;
  startup_timeout?: number;
  env?: Record<string, string>;
}

export interface ComposePreviewConfig extends BasePreviewConfig {
  type: "compose";
  compose_file: string;
  app_service: string;
}

export interface TestcontainersPreviewConfig extends BasePreviewConfig {
  type: "testcontainers";
  start_command: string;
}

export interface ProcessPreviewConfig extends BasePreviewConfig {
  type: "process";
  start_command: string;
}

export type PreviewConfig =
  | ComposePreviewConfig
  | TestcontainersPreviewConfig
  | ProcessPreviewConfig;

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Reads `.hive.yaml` from the given worktree path and returns the
 * parsed `preview` section, or null if the file is missing or has no
 * preview section.
 */
export function parseHiveYaml(worktreePath: string): PreviewConfig | null {
  const filePath = join(worktreePath, ".hive.yaml");

  let contents: string;
  try {
    contents = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!doc || typeof doc !== "object" || !doc.preview) {
    return null;
  }

  const raw = doc.preview as Record<string, unknown>;

  // Validate required fields
  const type = raw.type as string | undefined;
  if (!type || !["compose", "testcontainers", "process"].includes(type)) {
    return null;
  }

  const port = raw.port as number | undefined;
  if (typeof port !== "number") {
    return null;
  }

  // Common optional fields
  const base: BasePreviewConfig = {
    type: type as BasePreviewConfig["type"],
    port,
    health_check: typeof raw.health_check === "string" ? raw.health_check : undefined,
    startup_timeout: typeof raw.startup_timeout === "number" ? raw.startup_timeout : undefined,
    env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined,
  };

  if (type === "compose") {
    const compose_file = raw.compose_file as string | undefined;
    const app_service = raw.app_service as string | undefined;
    if (!compose_file || !app_service) {
      return null;
    }
    return { ...base, type: "compose", compose_file, app_service };
  }

  if (type === "testcontainers" || type === "process") {
    const start_command = raw.start_command as string | undefined;
    if (!start_command) {
      return null;
    }
    return { ...base, type, start_command } as
      | TestcontainersPreviewConfig
      | ProcessPreviewConfig;
  }

  return null;
}
