import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parse, stringify } from "yaml";
import logger from "../../logger.js";
import { getAutonomousConfig } from "../../domain/autonomous-config.js";
import type { PreviewSettings } from "../../domain/autonomous-config.js";
import { db } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";
import { addPreviewLog } from "../../db/queries/preview-logs.js";
import type { PreviewInfo, PreviewConfig } from "./types.js";
import type { ComposePreviewConfig } from "../../hive-yaml.js";
import {
  ensureCerts,
  syncWorktree,
  remoteComposeUp,
  remoteComposeDown,
  cleanupRemoteWorktree,
} from "./remote-docker.js";

/**
 * Manages preview environment lifecycles: starting, stopping, health-checking,
 * and cleaning up preview containers/processes for tasks.
 */
export class PreviewManager {
  private previews: Map<string, PreviewInfo> = new Map();
  private usedPorts: Set<number> = new Set();
  private settings: PreviewSettings;

  constructor() {
    this.settings = getAutonomousConfig().preview;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Starts a preview environment for a task. Dispatches to the appropriate
   * handler based on the config type (compose, testcontainers, process).
   */
  async startPreview(
    taskId: string,
    worktreePath: string,
    config: PreviewConfig,
  ): Promise<PreviewInfo> {
    // Enforce max_concurrent limit
    if (this.previews.size >= this.settings.max_concurrent) {
      const msg = `Max concurrent previews (${this.settings.max_concurrent}) reached`;
      await addPreviewLog(taskId, "manager", msg);
      throw new Error(msg);
    }

    const port = this.allocatePort();
    const dockerIp = this.settings.docker_host.ip;
    const host = dockerIp ? dockerIp : "localhost";

    await addPreviewLog(taskId, "manager", `Starting ${config.type} preview on port ${port}`);

    // Update DB status to starting
    await db
      .update(tasks)
      .set({
        previewPort: port,
        previewStatus: "starting",
        previewStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    let info: PreviewInfo;

    try {
      switch (config.type) {
        case "compose":
          info = await this.startCompose(taskId, worktreePath, config, port, host);
          break;
        case "testcontainers":
          info = await this.startTestContainers(taskId, worktreePath, config, port, host);
          break;
        case "process":
          info = await this.startProcess(taskId, worktreePath, config, port, host);
          break;
      }
    } catch (err) {
      this.freePort(port);

      const reason = err instanceof Error ? err.message : String(err);
      await addPreviewLog(taskId, "manager", `Preview start failed: ${reason}`);

      await db
        .update(tasks)
        .set({ previewStatus: "failed", updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      throw err;
    }

    this.previews.set(taskId, info);

    // Wait for the preview to become reachable. When an explicit health_check
    // path is configured we require HTTP 200; otherwise we accept any response
    // on "/" to confirm the container is at least listening.
    const healthPath = config.health_check;
    const timeoutMs = (config.startup_timeout ?? 60) * 1000;

    const checkPath = healthPath ?? "/";
    const strict = !!healthPath;
    const reachable = await this.waitForHealthCheck(host, port, checkPath, timeoutMs, strict);

    if (!reachable) {
      const kind = strict ? "Health check" : "Reachability check";
      const msg = `${kind} failed after ${timeoutMs}ms on port ${port}`;
      await addPreviewLog(taskId, "health", msg);
      await this.stopPreview(taskId);
      await db
        .update(tasks)
        .set({ previewStatus: "failed", updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      throw new Error(msg);
    }
    await addPreviewLog(taskId, "health", `${strict ? "Health check" : "Reachability check"} passed`);

    // Mark as running
    await db
      .update(tasks)
      .set({ previewStatus: "running", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await addPreviewLog(taskId, "manager", `Preview running on port ${port}`);

    return info;
  }

  /**
   * Stops and cleans up the preview environment for a task.
   */
  async stopPreview(taskId: string): Promise<void> {
    const info = this.previews.get(taskId);
    if (!info) {
      return;
    }

    await addPreviewLog(taskId, "manager", "Stopping preview");

    try {
      if (info.type === "compose" && info.composeProject) {
        await this.stopCompose(info.composeProject, info.worktreePath, info.remoteWorktreePath, info.taskId);
      } else if (info.childProcess) {
        this.killProcess(info.childProcess);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ taskId, err: reason }, "Error stopping preview");
      await addPreviewLog(taskId, "manager", `Error stopping preview: ${reason}`);
    }

    // Clean up generated preview compose file so it doesn't get committed
    // by `git add -A` on subsequent rework cycles.
    if (info.worktreePath) {
      try {
        unlinkSync(join(info.worktreePath, "docker-compose.hive-preview.yml"));
      } catch { /* already gone or never created — fine */ }
    }

    this.freePort(info.port);
    this.previews.delete(taskId);

    await db
      .update(tasks)
      .set({ previewStatus: "stopped", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await addPreviewLog(taskId, "manager", "Preview stopped");
  }

  /**
   * Returns preview info for a task from the in-memory map.
   */
  getPreviewInfo(taskId: string): PreviewInfo | undefined {
    return this.previews.get(taskId);
  }

  /**
   * Returns all running previews.
   */
  getRunningPreviews(): ReadonlyMap<string, PreviewInfo> {
    return new Map(this.previews);
  }

  /**
   * Resets preview_started_at to now for the given task, extending its lifetime.
   */
  async extendPreview(taskId: string): Promise<void> {
    const info = this.previews.get(taskId);
    if (!info) {
      throw new Error(`No active preview for task ${taskId}`);
    }

    info.startedAt = new Date();

    await db
      .update(tasks)
      .set({ previewStartedAt: info.startedAt, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await addPreviewLog(taskId, "manager", "Preview lifetime extended");
  }

  /**
   * Finds and stops previews that have exceeded the cleanup timeout.
   * Accepts an optional resolver that returns a per-task timeout in ms.
   * Falls back to the global cleanup_timeout_minutes when the resolver
   * returns undefined or throws.
   * Returns the list of task IDs that were cleaned up.
   */
  async cleanupExpired(
    getTimeoutMs?: (taskId: string) => Promise<number | undefined>,
  ): Promise<string[]> {
    const globalTimeoutMs = this.settings.cleanup_timeout_minutes * 60 * 1000;
    const now = Date.now();
    const expired: string[] = [];

    for (const [taskId, info] of this.previews) {
      let timeoutMs = globalTimeoutMs;

      if (getTimeoutMs) {
        try {
          const custom = await getTimeoutMs(taskId);
          if (custom != null) {
            timeoutMs = custom;
          }
        } catch {
          // Fall back to global timeout
        }
      }

      if (now - info.startedAt.getTime() > timeoutMs) {
        expired.push(taskId);
      }
    }

    for (const taskId of expired) {
      await addPreviewLog(taskId, "manager", "Preview expired — cleaning up");
      await this.stopPreview(taskId);
    }

    return expired;
  }

  // ── Private: start handlers ─────────────────────────────────────────────────

  /**
   * Starts a Docker Compose preview. Generates a patched compose file that
   * remaps the app_service port to the allocated preview port, then runs
   * `docker compose up -d` either locally or on the remote Docker host.
   */
  private async startCompose(
    taskId: string,
    worktreePath: string,
    config: PreviewConfig & { type: "compose" },
    port: number,
    host: string,
  ): Promise<PreviewInfo> {
    const project = `hive-${taskId}`.toLowerCase();
    const isRemote = !!this.settings.docker_host.ip;

    // Generate a patched compose file that maps the allocated port → internal port
    const composeConfig = config as ComposePreviewConfig;
    const previewComposeFile = this.generatePreviewComposeFile(
      worktreePath,
      composeConfig.compose_file,
      composeConfig.app_service,
      port,
      composeConfig.port,
    );

    await addPreviewLog(taskId, "compose", `Running docker compose up for project ${project} (port ${port}→${composeConfig.port})${isRemote ? " (remote)" : ""}`);

    if (isRemote) {
      const certs = await ensureCerts(this.settings.docker_host);
      const remotePath = await syncWorktree(
        this.settings.docker_host,
        worktreePath,
        taskId,
        certs.sshKey,
      );
      await remoteComposeUp(
        this.settings.docker_host,
        certs.sshKey,
        remotePath,
        project,
        previewComposeFile,
        config.env,
        this.settings.compose_up_timeout_seconds * 1000,
      );

      return {
        taskId,
        type: "compose",
        port,
        host,
        worktreePath,
        startedAt: new Date(),
        composeProject: project,
        remoteWorktreePath: remotePath,
      };
    }

    // Local Docker
    await new Promise<void>((resolve, reject) => {
      execFile(
        "docker",
        ["compose", "-p", project, "-f", previewComposeFile, "up", "-d"],
        { cwd: worktreePath },
        (error, stdout, stderr) => {
          if (error) {
            logger.error({ taskId, stderr }, "docker compose up failed");
            reject(new Error(`docker compose up failed: ${stderr || error.message}`));
            return;
          }
          logger.info({ taskId, stdout: stdout.trim() }, "docker compose up succeeded");
          resolve();
        },
      );
    });

    return {
      taskId,
      type: "compose",
      port,
      host,
      worktreePath,
      startedAt: new Date(),
      composeProject: project,
    };
  }

  /**
   * Reads the original compose file, replaces the port mapping for the
   * app_service so the allocated preview port maps to the internal port,
   * and writes the result as `docker-compose.hive-preview.yml`.
   */
  private generatePreviewComposeFile(
    worktreePath: string,
    composeFile: string,
    appService: string,
    externalPort: number,
    internalPort: number,
  ): string {
    const content = readFileSync(join(worktreePath, composeFile), "utf-8");
    const doc = parse(content) as Record<string, unknown>;

    const services = doc.services as Record<string, Record<string, unknown>> | undefined;
    if (services?.[appService]?.ports) {
      services[appService].ports = [`${externalPort}:${internalPort}`];
    }

    const previewFile = "docker-compose.hive-preview.yml";
    writeFileSync(join(worktreePath, previewFile), stringify(doc));
    return previewFile;
  }

  /**
   * Starts a TestContainers-based preview by spawning the start_command.
   * TestContainers manages its own Docker containers internally.
   */
  private startTestContainers(
    taskId: string,
    worktreePath: string,
    config: PreviewConfig & { type: "testcontainers" },
    port: number,
    host: string,
  ): Promise<PreviewInfo> {
    return this.spawnCommand(taskId, worktreePath, config.start_command, config.env, port, host, "testcontainers");
  }

  /**
   * Starts a plain process preview by spawning the start_command directly.
   */
  private startProcess(
    taskId: string,
    worktreePath: string,
    config: PreviewConfig & { type: "process" },
    port: number,
    host: string,
  ): Promise<PreviewInfo> {
    return this.spawnCommand(taskId, worktreePath, config.start_command, config.env, port, host, "process");
  }

  /**
   * Shared helper: spawns a command in the worktree directory and returns PreviewInfo.
   */
  private spawnCommand(
    taskId: string,
    worktreePath: string,
    command: string,
    env: Record<string, string> | undefined,
    port: number,
    host: string,
    type: "testcontainers" | "process",
  ): Promise<PreviewInfo> {
    const childProcess = spawn("sh", ["-c", command], {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...env,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    childProcess.stdout?.on("data", (data: Buffer) => {
      logger.debug({ taskId, type }, data.toString().trim());
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      logger.debug({ taskId, type }, data.toString().trim());
    });

    childProcess.on("error", (err) => {
      logger.error({ taskId, type, err: err.message }, "Preview process error");
    });

    return Promise.resolve({
      taskId,
      type,
      port,
      host,
      worktreePath,
      startedAt: new Date(),
      childProcess,
    });
  }

  // ── Private: stop helpers ───────────────────────────────────────────────────

  /**
   * Stops a Docker Compose project, locally or on the remote host.
   */
  private async stopCompose(
    project: string,
    worktreePath: string,
    remoteWorktreePath?: string,
    taskId?: string,
  ): Promise<void> {
    const isRemote = !!this.settings.docker_host.ip;

    if (isRemote) {
      const certs = await ensureCerts(this.settings.docker_host);
      await remoteComposeDown(this.settings.docker_host, certs.sshKey, project);
      if (taskId) {
        await cleanupRemoteWorktree(this.settings.docker_host, taskId, certs.sshKey);
      }
      return;
    }

    return new Promise<void>((resolve, reject) => {
      execFile(
        "docker",
        ["compose", "-p", project, "down", "--remove-orphans"],
        { cwd: worktreePath },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`docker compose down failed: ${stderr || error.message}`));
            return;
          }
          resolve();
        },
      );
    });
  }

  /**
   * Kills a child process tree.
   */
  private killProcess(child: ChildProcess): void {
    if (child.pid && !child.killed) {
      // Try SIGTERM first; callers can wait and send SIGKILL if needed
      child.kill("SIGTERM");
    }
  }

  // ── Private: health check ──────────────────────────────────────────────────

  /**
   * Polls GET http://{host}:{port}{path} every 2 seconds until a response
   * or the timeout is reached. When `strict` is true (default), requires
   * HTTP 2xx. When false, any HTTP response counts as reachable.
   */
  async waitForHealthCheck(
    host: string,
    port: number,
    path: string,
    timeoutMs: number,
    strict = true,
  ): Promise<boolean> {
    const url = `http://${host}:${port}${path}`;
    const pollIntervalMs = 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(pollIntervalMs),
        });
        if (!strict || response.ok) {
          return true;
        }
      } catch {
        // Connection refused or timeout — keep polling
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
  }

  // ── Private: port management ───────────────────────────────────────────────

  /**
   * Finds the next available port from the configured port_range.
   * Throws if no ports are available.
   */
  allocatePort(): number {
    const [start, end] = this.settings.port_range;

    for (let port = start; port <= end; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }

    throw new Error(`No available ports in range ${start}-${end}`);
  }

  /**
   * Returns a port to the available pool.
   */
  freePort(port: number): void {
    this.usedPorts.delete(port);
  }
}

/** Singleton instance for application-wide preview management. */
export const previewManager = new PreviewManager();
