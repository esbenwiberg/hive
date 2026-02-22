import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireRole } from "../../auth/middleware.js";
import { getAutonomousConfig } from "../../domain/autonomous-config.js";
import {
  ensureCerts,
  remoteComposeUp,
  remoteComposeDown,
  getComposeLogs,
} from "../../execution/preview/remote-docker.js";
import { execFile } from "node:child_process";
import logger from "../../logger.js";

const router = Router();

const TEST_PROJECT = "hive-test-preview";
const TEST_PORT = 4099;

// Minimal compose file — nginx:alpine on a throwaway port
const TEST_COMPOSE = `services:
  web:
    image: nginx:alpine
    ports:
      - "${TEST_PORT}:80"
`;

// ── State ────────────────────────────────────────────────────────────────────

type TestStatus = "idle" | "running" | "up" | "stopping" | "failed";

interface TestState {
  status: TestStatus;
  logs: string[];
  listeners: Set<(event: string, data: string) => void>;
  logInterval?: ReturnType<typeof setInterval>;
}

const state: TestState = {
  status: "idle",
  logs: [],
  listeners: new Set(),
};

function emit(event: string, data: string) {
  state.logs.push(`[${event}] ${data}`);
  for (const fn of state.listeners) fn(event, data);
}

function exec(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// ── Test flow ────────────────────────────────────────────────────────────────

async function runTest() {
  const config = getAutonomousConfig();
  const docker = config.preview.docker_host;

  state.status = "running";
  state.logs = [];

  try {
    // Step 1: Fetch certs
    emit("step", "Fetching TLS certs + SSH key from Key Vault...");
    const certs = await ensureCerts(docker);
    emit("pass", "Certs ready");

    // Step 2: SSH test
    emit("step", "Testing SSH connectivity...");
    const sshBase = [
      "-i", certs.sshKey,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
    ];
    const target = `${docker.ssh_user}@${docker.ip}`;
    const dockerInfo = await exec("ssh", [...sshBase, target, "docker info --format '{{.ServerVersion}}'"]);
    emit("pass", `Docker ${dockerInfo.trim()}`);

    // Step 3: Write compose file to remote host
    emit("step", "Writing test compose file to remote host...");
    const remoteBase = `/home/${docker.ssh_user}/hive-previews`;
    const remotePath = `${remoteBase}/__test__`;
    await exec("ssh", [...sshBase, target, `mkdir -p ${remotePath}`]);
    // Write compose file via stdin
    const composeEscaped = TEST_COMPOSE.replace(/'/g, "'\\''");
    await exec("ssh", [...sshBase, target, `cat > ${remotePath}/docker-compose.yml << 'HIVEEOF'\n${TEST_COMPOSE}HIVEEOF`]);
    emit("pass", "Compose file written");

    // Step 4: Compose up
    emit("step", "Running docker compose up...");
    const timeoutMs = (config.preview.compose_up_timeout_seconds ?? 300) * 1000;
    await remoteComposeUp(docker, certs.sshKey, remotePath, TEST_PROJECT, "docker-compose.yml", undefined, timeoutMs);
    emit("pass", "Container is up");

    state.status = "up";
    emit("step", "Streaming container logs (every 3s)...");

    // Step 5: Poll logs
    state.logInterval = setInterval(async () => {
      try {
        const logs = await getComposeLogs(docker, certs.sshKey, TEST_PROJECT, 30);
        if (logs.trim()) {
          emit("logs", logs.trim());
        }
      } catch (err) {
        emit("logs", `(log fetch error: ${(err as Error).message})`);
      }
    }, 3000);

    // Fetch initial logs immediately
    try {
      const logs = await getComposeLogs(docker, certs.sshKey, TEST_PROJECT, 30);
      if (logs.trim()) emit("logs", logs.trim());
    } catch { /* ignore first-fetch timing issues */ }
  } catch (err) {
    const msg = (err as Error).message;
    emit("fail", msg);
    state.status = "failed";
    logger.warn({ err: msg }, "Preview test failed");
  }
}

async function stopTest() {
  if (state.logInterval) {
    clearInterval(state.logInterval);
    state.logInterval = undefined;
  }

  if (state.status === "idle") return;

  state.status = "stopping";
  emit("step", "Stopping test container...");

  try {
    const config = getAutonomousConfig();
    const docker = config.preview.docker_host;
    const certs = await ensureCerts(docker);

    await remoteComposeDown(docker, certs.sshKey, TEST_PROJECT);
    emit("pass", "Container stopped");

    // Clean up remote directory
    const target = `${docker.ssh_user}@${docker.ip}`;
    const remoteBase = `/home/${docker.ssh_user}/hive-previews`;
    await exec("ssh", [
      "-i", certs.sshKey,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      target,
      `rm -rf ${remoteBase}/__test__`,
    ]);
    emit("pass", "Cleanup done");
  } catch (err) {
    emit("fail", `Cleanup error: ${(err as Error).message}`);
  }

  state.status = "idle";
  emit("done", "Test complete");
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.post("/settings/preview/test/start", requireRole("admin"), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (state.status === "running" || state.status === "up") {
      res.status(409).send("Test already running");
      return;
    }

    // Fire and forget — progress comes via SSE
    runTest().catch((err) => logger.error(err, "Preview test crashed"));
    res.status(202).send("started");
  } catch (err) {
    next(err);
  }
});

router.get("/settings/preview/test/stream", requireRole("admin"), (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state replay
  for (const line of state.logs) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  // Send current status
  res.write(`event: status\ndata: ${state.status}\n\n`);

  const listener = (event: string, data: string) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (event === "done") {
        res.write(`event: status\ndata: idle\n\n`);
      } else if (event === "fail") {
        res.write(`event: status\ndata: failed\n\n`);
      } else if (event === "pass" && data === "Container is up") {
        res.write(`event: status\ndata: up\n\n`);
      }
    } catch { /* client disconnected */ }
  };

  state.listeners.add(listener);
  req.on("close", () => state.listeners.delete(listener));
});

router.post("/settings/preview/test/stop", requireRole("admin"), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await stopTest();
    res.status(200).send("stopped");
  } catch (err) {
    next(err);
  }
});

export default router;
