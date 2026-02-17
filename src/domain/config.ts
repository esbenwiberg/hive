import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { globalConfig } from "../db/schema.js";

/**
 * Reads a single config value from the global_config table.
 * Returns `undefined` if the key does not exist.
 */
export async function getConfig(key: string): Promise<unknown> {
  const [row] = await db
    .select()
    .from(globalConfig)
    .where(eq(globalConfig.key, key))
    .limit(1);

  return row?.value;
}

/**
 * Writes a config value to the global_config table (upsert).
 */
export async function setConfig(key: string, value: unknown): Promise<void> {
  await db
    .insert(globalConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: globalConfig.key,
      set: { value, updatedAt: new Date() },
    });
}
