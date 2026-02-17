import { migrate } from "./db/migrate.js";
import app from "./dashboard/server.js";
import { pool } from "./db/connection.js";
import logger from "./logger.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function start(): Promise<void> {
  await migrate();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Hive listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close(() => {
      pool.end().then(() => {
        logger.info("Shutdown complete");
        process.exit(0);
      });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error(err, "Failed to start Hive");
  process.exit(1);
});
