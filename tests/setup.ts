import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { beforeAll, afterAll } from "vitest";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://hive:hive@localhost:5432/hive_test";

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

/**
 * Truncates the users and sessions tables.
 * Call this in beforeEach() blocks to get a clean slate between tests.
 */
export async function cleanupTables(): Promise<void> {
  await db.execute(sql`TRUNCATE users, sessions CASCADE`);
}

/**
 * Call this in DB test files to set up migrations and teardown the pool.
 */
export function useTestDb(): void {
  beforeAll(async () => {
    await drizzleMigrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    await pool.end();
  });
}
