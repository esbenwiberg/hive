import { migrate } from "./db/migrate.js";
import app from "./dashboard/server.js";
import { pool } from "./db/connection.js";
import { Daemon } from "./daemon/daemon.js";
import logger from "./logger.js";
import { logScanner } from "./producers/log-scanner.js";
import { bugHunter } from "./producers/bug-hunter.js";
import { securityScanner } from "./producers/security-scanner.js";
import { featureScout } from "./producers/feature-scout.js";
import { selfMonitor } from "./producers/self-monitor.js";
import { recordRun } from "./db/queries/producer-runs.js";
import { getById } from "./db/queries/repos.js";
import type { Producer } from "./producers/base.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const PRODUCER_MAP: Record<string, Producer> = {
  "log-scanner": logScanner,
  "bug-hunter": bugHunter,
  "security-scanner": securityScanner,
  "feature-scout": featureScout,
  "self-monitor": selfMonitor,
};

function usage(): void {
  process.stderr.write(
    "Usage: hive <command>\n\nCommands:\n  daemon                  Run the Daemon alongside the Express server\n  run <producer-name>     Run a single producer once\n\nProducers:\n  log-scanner, bug-hunter, security-scanner, feature-scout, self-monitor\n\nOptions for 'run':\n  --repo <repoId>         Repository ID (or set HIVE_DEFAULT_REPO_ID)\n",
  );
  process.exit(1);
}

const command = process.argv[2];

if (!command || (command !== "daemon" && command !== "run")) {
  usage();
}

async function runDaemon(): Promise<void> {
  await migrate();

  const server = app.listen(PORT);

  const maxConcurrent = parseInt(process.env.HIVE_MAX_WORKERS ?? "5", 10);
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`Invalid HIVE_MAX_WORKERS: ${process.env.HIVE_MAX_WORKERS}`);
  }
  const pollIntervalMs = parseInt(process.env.HIVE_POLL_MS ?? "5000", 10);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error(`Invalid HIVE_POLL_MS: ${process.env.HIVE_POLL_MS}`);
  }

  const daemon = new Daemon({ maxConcurrent, pollIntervalMs });
  await daemon.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await daemon.stop();
    server.close(() => {
      pool.end()
        .then(() => {
          logger.info("Shutdown complete");
          process.exit(0);
        })
        .catch((err) => {
          logger.error(err, "Error closing pool");
          process.exit(1);
        });
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info({ port: PORT }, "CLI: server and daemon ready");
}

async function runProducer(): Promise<void> {
  const producerName = process.argv[3];
  if (!producerName || !PRODUCER_MAP[producerName]) {
    process.stderr.write(
      `Unknown producer: "${producerName ?? ""}"\nAvailable: ${Object.keys(PRODUCER_MAP).join(", ")}\n`,
    );
    process.exit(1);
  }

  // Parse --repo flag from argv
  let repoIdStr: string | undefined;
  const repoFlagIdx = process.argv.indexOf("--repo");
  if (repoFlagIdx !== -1 && process.argv[repoFlagIdx + 1]) {
    repoIdStr = process.argv[repoFlagIdx + 1];
  }
  repoIdStr = repoIdStr ?? process.env.HIVE_DEFAULT_REPO_ID;

  if (!repoIdStr) {
    process.stderr.write("Error: --repo <repoId> is required (or set HIVE_DEFAULT_REPO_ID)\n");
    process.exit(1);
  }

  const repoId = parseInt(repoIdStr, 10);
  if (!Number.isFinite(repoId) || repoId < 1) {
    process.stderr.write(`Invalid repo ID: "${repoIdStr}"\n`);
    process.exit(1);
  }

  await migrate();

  const repo = await getById(repoId);
  if (!repo) {
    process.stderr.write(`Repo with ID ${repoId} not found in database\n`);
    await pool.end();
    process.exit(1);
  }

  const producer = PRODUCER_MAP[producerName];
  const createdBy = parseInt(process.env.HIVE_DAEMON_USER_ID ?? "1", 10);
  if (!Number.isFinite(createdBy) || createdBy < 1) {
    process.stderr.write(`Invalid HIVE_DAEMON_USER_ID: "${process.env.HIVE_DAEMON_USER_ID}"\n`);
    await pool.end();
    process.exit(1);
  }

  const start = Date.now();
  const result = await producer.run({
    repoId: repo.id,
    repoFullName: repo.fullName,
    createdBy,
  });
  const durationMs = Date.now() - start;

  await recordRun({
    producer: producer.name,
    repo: repo.fullName,
    tasksCreated: result.tasksCreated,
    duplicatesSkipped: result.duplicatesSkipped,
    errors: result.errors,
    costUsd: result.costUsd,
    durationMs,
  });

  logger.info(
    {
      producer: producer.name,
      repo: repo.fullName,
      tasksCreated: result.tasksCreated,
      duplicatesSkipped: result.duplicatesSkipped,
      errors: result.errors,
      durationMs,
    },
    "Producer run complete",
  );

  process.stdout.write(
    `Producer: ${producer.name}\n` +
    `Repo: ${repo.fullName}\n` +
    `Tasks created: ${result.tasksCreated}\n` +
    `Duplicates skipped: ${result.duplicatesSkipped}\n` +
    `Errors: ${result.errors.length > 0 ? result.errors.join("; ") : "none"}\n` +
    `Duration: ${durationMs}ms\n`,
  );

  await pool.end();
  process.exit(0);
}

if (command === "daemon") {
  runDaemon().catch((err) => {
    logger.error(err, "Failed to start daemon");
    process.exit(1);
  });
} else if (command === "run") {
  runProducer().catch((err) => {
    logger.error(err, "Failed to run producer");
    process.exit(1);
  });
}
