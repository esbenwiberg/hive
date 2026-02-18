import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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
