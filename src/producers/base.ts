import { eq, and, notInArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProducerContext {
  repoId: number;
  repoFullName: string;
  createdBy: number;
  dryRun?: boolean;
}

export interface ProducerResult {
  tasksCreated: number;
  duplicatesSkipped: number;
  errors: string[];
  costUsd: number;
}

export interface Producer {
  name: string;
  run(ctx: ProducerContext): Promise<ProducerResult>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks whether a task with the given source and title already exists
 * in a non-terminal status. Returns true if a duplicate is found.
 */
export async function isDuplicate(
  source: string,
  title: string,
): Promise<boolean> {
  const terminalStatuses = ["failed", "cancelled", "merged", "done"];

  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.source, source),
        eq(tasks.title, title),
        notInArray(tasks.status, terminalStatuses),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
