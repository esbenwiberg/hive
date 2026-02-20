import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { readFileSync, readdirSync } from "fs";
import { db, pool } from "./connection.js";
import logger from "../logger.js";

const DESTRUCTIVE_PATTERNS = [
  /DROP\s+TABLE/i,
  /DROP\s+COLUMN/i,
  /TRUNCATE/i,
  /DELETE\s+FROM/i,
  /DROP\s+SCHEMA/i,
];

async function getPendingMigrations(folder: string): Promise<string[]> {
  // Check which migrations have already run
  const applied = new Set<string>();
  try {
    const result = await pool.query(
      "SELECT hash FROM drizzle.__drizzle_migrations",
    );
    for (const row of result.rows) applied.add(row.hash);
  } catch {
    // Table doesn't exist — all migrations are pending
  }

  // Read journal to get ordered migration tags
  const journal = JSON.parse(
    readFileSync(`${folder}/meta/_journal.json`, "utf-8"),
  );

  const pending: string[] = [];
  for (const entry of journal.entries) {
    // Drizzle hashes the SQL content; we can't easily match hashes,
    // so compare by count — if fewer applied than total, the rest are pending
    if (applied.size <= pending.length + applied.size - applied.size) {
      // Simpler: just collect all sql files, we'll check them all
    }
    pending.push(`${folder}/${entry.tag}.sql`);
  }

  // If all migrations are applied, nothing is pending
  if (applied.size >= journal.entries.length) return [];

  // Return only the ones not yet applied (by index)
  return pending.slice(applied.size);
}

function scanForDestructiveSQL(sqlFiles: string[]): string[] {
  const warnings: string[] = [];
  for (const file of sqlFiles) {
    const sql = readFileSync(file, "utf-8");
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      const match = sql.match(pattern);
      if (match) {
        warnings.push(`${file}: contains "${match[0]}"`);
      }
    }
  }
  return warnings;
}

export async function migrate(): Promise<void> {
  logger.info("Running migrations...");

  const pending = await getPendingMigrations("./drizzle");

  if (pending.length > 0) {
    const warnings = scanForDestructiveSQL(pending);
    if (warnings.length > 0) {
      logger.warn(
        { warnings },
        "DESTRUCTIVE SQL DETECTED in pending migrations",
      );

      if (process.env.ALLOW_DESTRUCTIVE_MIGRATE !== "true") {
        throw new Error(
          `Blocked: ${warnings.length} destructive operation(s) found in pending migrations. ` +
            `Set ALLOW_DESTRUCTIVE_MIGRATE=true to proceed.\n` +
            warnings.map((w) => `  - ${w}`).join("\n"),
        );
      }

      logger.warn("ALLOW_DESTRUCTIVE_MIGRATE=true — proceeding anyway");
    }

    logger.info({ count: pending.length, files: pending }, "Pending migrations");
  }

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
