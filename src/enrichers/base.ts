import logger from "../logger.js";
import { recordRun } from "../db/queries/enrichment-runs.js";
import { updateEnrichment } from "../db/queries/tasks.js";
import type { TaskRow } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EnricherConfig {
  enabled: boolean;
  model?: string;
  maxTurns?: number;
  budget?: number;
}

export interface EnrichmentResult {
  data: Record<string, unknown>;
  costUsd?: number;
  durationMs: number;
}

export interface Enricher {
  name: string;
  run(
    task: TaskRow,
    repoDir: string,
    priorResults: Record<string, unknown>,
    config: EnricherConfig,
  ): Promise<EnrichmentResult>;
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Runs enrichers sequentially, passing prior merged results to each subsequent
 * enricher. Records each run to the enrichment_runs table. On failure, records
 * the error and continues to the next enricher. After all enrichers complete,
 * merges successful results and updates the task's enrichment column.
 */
export async function runEnrichers(
  task: TaskRow,
  repoDir: string,
  enrichers: Enricher[],
  config: Record<string, EnricherConfig>,
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  let succeeded = 0;
  let failed = 0;
  const failedNames: string[] = [];

  for (const enricher of enrichers) {
    const enricherConfig = config[enricher.name] ?? { enabled: true };

    if (!enricherConfig.enabled) {
      logger.info({ enricher: enricher.name, taskId: task.id }, "Enricher disabled, skipping");
      continue;
    }

    try {
      const result = await enricher.run(task, repoDir, { ...merged }, enricherConfig);

      // Record successful run
      await recordRun(
        task.id,
        enricher.name,
        "completed",
        result.data,
        result.costUsd,
        result.durationMs,
      );

      // Merge results
      Object.assign(merged, result.data);
      succeeded++;

      logger.info(
        { enricher: enricher.name, taskId: task.id, durationMs: result.durationMs },
        "Enricher completed",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Record failed run
      await recordRun(
        task.id,
        enricher.name,
        "failed",
        undefined,
        undefined,
        undefined,
        message,
      );

      failed++;
      failedNames.push(enricher.name);

      logger.error(
        { enricher: enricher.name, taskId: task.id, err },
        "Enricher failed, continuing to next",
      );
    }
  }

  // Add enrichment metadata so downstream consumers know about partial failures
  merged._enrichmentMeta = {
    succeeded,
    failed,
    failedEnrichers: failedNames,
    partial: failed > 0 && succeeded > 0,
  };

  if (failed > 0) {
    logger.warn(
      { taskId: task.id, succeeded, failed, failedNames },
      "Enrichment completed with partial failures",
    );
  }

  // Update the task's enrichment column with merged results
  await updateEnrichment(task.id, merged);

  return merged;
}
