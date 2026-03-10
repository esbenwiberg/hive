/**
 * Process-group-aware exec — spawns a child in a new process group so that
 * timeout kills reach ALL descendant processes, not just the top-level one.
 *
 * Node's built-in `execFile` timeout only sends the kill signal to the direct
 * child.  Tools like `dotnet restore` spawn NuGet sub-processes that survive
 * the kill, leaving the `await` hanging indefinitely.
 */
import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import { getAutonomousConfig } from "../domain/autonomous-config.js";

const HIVE_RESERVE_MB = 512;
const MIN_HEAP_MB = 1536;
const MAX_HEAP_MB = 4096;

/**
 * Computes --max-old-space-size for child Node processes (target-repo builds).
 *
 * Divides available memory (total minus Hive reserve) across maxConcurrent
 * workers with a 1536 MB floor. In practice, concurrent builds are rare —
 * most workers spend their time on Claude API calls, not builds — so the
 * floor ensures large Vite/webpack builds don't OOM on modest containers.
 */
export function getNodeHeapLimitMB(): number {
  const totalMB = Math.floor(totalmem() / (1024 * 1024));
  const maxConcurrent = getAutonomousConfig().concurrency.maxConcurrent;
  const perWorker = Math.floor((totalMB - HIVE_RESERVE_MB) / maxConcurrent);
  return Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, perWorker));
}

export interface ExecGroupOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export function execInGroup(
  bin: string,
  args: string[],
  options: ExecGroupOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { cwd, timeout = 120_000, maxBuffer = 2 * 1024 * 1024, env } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: typeof resolve | typeof reject, value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      (fn as (v: unknown) => void)(value);
    };

    const child = spawn(bin, args, {
      cwd,
      env,
      detached: true, // new process group
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        killGroup();
        finish(reject, Object.assign(new Error("maxBuffer exceeded"), { stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 4096), killed: true }));
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        killGroup();
        finish(reject, Object.assign(new Error("maxBuffer exceeded"), { stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 4096), killed: true }));
      }
    });

    function killGroup() {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL"); // negative PID = entire process group
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }
      }
    }

    const timer = timeout > 0
      ? setTimeout(() => {
          killGroup();
          finish(reject, Object.assign(
            new Error(`Timed out after ${timeout}ms`),
            { stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 4096), killed: true, signal: "SIGKILL" },
          ));
        }, timeout)
      : undefined;

    child.on("error", (err) => {
      finish(reject, err);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
      } else {
        finish(reject, Object.assign(
          new Error(`${bin} ${args.join(" ")} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`),
          { stdout, stderr, code, signal },
        ));
      }
    });
  });
}
