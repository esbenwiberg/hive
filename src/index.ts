import { migrate } from "./db/migrate.js";
import { initConfig } from "./domain/autonomous-config.js";
import app from "./dashboard/server.js";
import { pool } from "./db/connection.js";
import logger from "./logger.js";
import type { Daemon } from "./daemon/daemon.js";

// ── Global error handlers ─ prevent unhandled errors from crashing the process ─
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection — process will continue");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — process will continue but may be unstable");
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function start(): Promise<void> {
  await migrate();
  await initConfig();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Hive listening");
  });

  let daemon: Daemon | undefined;

  if (process.env.HIVE_MODE === "daemon") {
    const { Daemon: DaemonClass } = await import("./daemon/daemon.js");
    const maxConcurrent = parseInt(process.env.HIVE_MAX_WORKERS ?? "5", 10);
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`Invalid HIVE_MAX_WORKERS: ${process.env.HIVE_MAX_WORKERS}`);
    }
    const pollIntervalMs = parseInt(process.env.HIVE_POLL_MS ?? "5000", 10);
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
      throw new Error(`Invalid HIVE_POLL_MS: ${process.env.HIVE_POLL_MS}`);
    }
    daemon = new DaemonClass({ maxConcurrent, pollIntervalMs });
    await daemon.start();
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    if (daemon) await daemon.stop();
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
}

start().catch((err) => {
  logger.error(err, "Failed to start Hive");
  process.exit(1);
});
