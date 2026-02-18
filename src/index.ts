import { migrate } from "./db/migrate.js";
import app from "./dashboard/server.js";
import { pool } from "./db/connection.js";
import logger from "./logger.js";
import type { Daemon } from "./daemon/daemon.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function start(): Promise<void> {
  await migrate();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Hive listening");
  });

  let daemon: Daemon | undefined;

  if (process.env.HIVE_MODE === "daemon") {
    const { Daemon: DaemonClass } = await import("./daemon/daemon.js");
    const maxConcurrent = parseInt(process.env.HIVE_MAX_WORKERS ?? "5", 10);
    const pollIntervalMs = parseInt(process.env.HIVE_POLL_MS ?? "5000", 10);
    daemon = new DaemonClass({ maxConcurrent, pollIntervalMs });
    await daemon.start();
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    if (daemon) await daemon.stop();
    server.close(() => {
      pool.end().then(() => {
        logger.info("Shutdown complete");
        process.exit(0);
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
