import { migrate } from "./db/migrate.js";
import app from "./dashboard/server.js";
import { pool } from "./db/connection.js";
import { Daemon } from "./daemon/daemon.js";
import logger from "./logger.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

function usage(): void {
  process.stderr.write("Usage: hive <command>\n\nCommands:\n  daemon    Run the Daemon alongside the Express server\n");
  process.exit(1);
}

const command = process.argv[2];

if (!command || command !== "daemon") {
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

runDaemon().catch((err) => {
  logger.error(err, "Failed to start daemon");
  process.exit(1);
});
