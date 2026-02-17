import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./connection.js";
import logger from "../logger.js";

export async function migrate(): Promise<void> {
  logger.info("Running migrations...");
  await drizzleMigrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete.");
}

// Allow direct execution via `npm run db:migrate`
const isDirectRun =
  process.argv[1]?.endsWith("/migrate.js") ||
  process.argv[1]?.endsWith("/migrate.ts");

if (isDirectRun) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err, "Migration failed");
      process.exit(1);
    });
}
