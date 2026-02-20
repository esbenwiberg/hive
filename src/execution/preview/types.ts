import type { ChildProcess } from "node:child_process";

export type { PreviewConfig } from "../../hive-yaml.js";

export type { PreviewStatus } from "../../domain/types.js";

export interface PreviewInfo {
  taskId: string;
  type: "compose" | "testcontainers" | "process";
  port: number;
  host: string;
  worktreePath: string;
  startedAt: Date;
  childProcess?: ChildProcess;
  composeProject?: string;
  remoteWorktreePath?: string;
}
