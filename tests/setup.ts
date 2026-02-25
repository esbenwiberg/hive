import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { beforeAll, beforeEach, afterAll } from "vitest";

const { Pool } = pg;

const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://hive:hive@localhost:5432/hive_test";

// Safety: never run tests against a remote database
const parsed = new URL(connectionString);
if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
  throw new Error(
    `Refusing to run tests against remote database (${parsed.hostname}). ` +
      `Set TEST_DATABASE_URL to a local database.`,
  );
}

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

/**
 * Truncates all application tables.
 * Call this in beforeEach() blocks to get a clean slate between tests.
 */
export async function cleanupTables(): Promise<void> {
  await db.execute(
    sql`TRUNCATE users, sessions, tasks, repos, costs, gate_decisions, enrichment_runs, active_agents, code_reviews, user_credentials, producer_runs, learnings, learning_events, preview_logs CASCADE`,
  );
}

/**
 * Call this in DB test files to set up migrations and teardown the pool.
 * Gracefully skips all tests when no local database is reachable.
 */
export function useTestDb(): void {
  let dbReady = false;

  beforeAll(async () => {
    try {
      await drizzleMigrate(db, { migrationsFolder: "./drizzle" });
      dbReady = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[useTestDb] No database available, skipping DB tests: ${msg}`);
    }
  });

  beforeEach((ctx) => {
    if (!dbReady) ctx.skip();
  });

  afterAll(async () => {
    if (dbReady) await pool.end();
  });
}
