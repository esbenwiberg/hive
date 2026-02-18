import { eq, desc } from "drizzle-orm";
import { db } from "../connection.js";
import { producerRuns } from "../schema.js";

/**
 * Records a single producer run and returns the inserted row.
 */
export async function recordRun(data: {
  producer: string;
  repo?: string;
  tasksCreated: number;
  duplicatesSkipped: number;
  errors: string[];
  costUsd: number;
  durationMs: number;
}) {
  const [row] = await db
    .insert(producerRuns)
    .values({
      producer: data.producer,
      repo: data.repo ?? null,
      tasksCreated: data.tasksCreated,
      duplicatesSkipped: data.duplicatesSkipped,
      errors: data.errors,
      costUsd: data.costUsd.toFixed(4),
      durationMs: data.durationMs,
    })
    .returning();

  return row;
}

/**
 * Returns recent runs for a producer ordered by createdAt descending.
 */
export async function listRecent(producer: string, limit?: number) {
  return db
    .select()
    .from(producerRuns)
    .where(eq(producerRuns.producer, producer))
    .orderBy(desc(producerRuns.createdAt))
    .limit(limit ?? 20);
}
