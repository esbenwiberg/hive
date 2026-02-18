import type { ChildProcess } from "node:child_process";

export type { PreviewConfig } from "../../hive-yaml.js";

export type PreviewStatus = "starting" | "running" | "failed" | "stopped";

export interface PreviewInfo {
  taskId: string;
  type: "compose" | "testcontainers" | "process";
  port: number;
  host: string;
  worktreePath: string;
  startedAt: Date;
  childProcess?: ChildProcess;
  composeProject?: string;
}
