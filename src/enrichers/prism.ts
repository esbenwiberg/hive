/**
 * Prism enricher — one-shot task context via the Prism API.
 *
 * Calls POST /context/enrich which returns architecture, relevant code,
 * file summaries, blast radius, findings, and recent changes — all
 * scoped to the task query. Prism allocates the token budget across
 * signals automatically using its priority system.
 *
 * Requires PRISM_API_URL (or prism.apiUrl in config) to be set.
 */

import logger from "../logger.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import * as repoQueries from "../db/queries/repos.js";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface PrismSection {
  heading: string;
  priority: number;
  content: string;
  tokenCount: number;
}

interface PrismEnrichResponse {
  sections: PrismSection[];
  totalTokens: number;
  truncated: boolean;
}

interface PrismEnrichmentData {
  sections: PrismSection[];
  totalTokens: number;
  truncated: boolean;
  stats: {
    sectionCount: number;
    totalTokens: number;
    truncated: boolean;
  };
}

// ── Enricher ─────────────────────────────────────────────────────────────────

export const prismEnricher: Enricher = {
  name: "prism",

  async run(
    task: TaskRow,
    _repoDir: string,
    _priorResults: Record<string, unknown>,
    _config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    const prismConfig = getAutonomousConfig().prism;
    const apiUrl = process.env.PRISM_API_URL || prismConfig.apiUrl;
    const apiKey = process.env.PRISM_API_KEY || prismConfig.apiKey;

    if (!apiUrl) {
      logger.info("Prism enricher: PRISM_API_URL not set, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    if (!task.repoId) {
      logger.info({ taskId: task.id }, "Prism enricher: task has no repoId, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const repo = await repoQueries.getById(task.repoId);
    if (!repo?.fullName) {
      logger.info({ taskId: task.id }, "Prism enricher: repo not found, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;
    const slug = (repoSettings.prismSlug as string) || repo.fullName;

    // Use title + first ~200 chars of body for a focused query.
    const bodySnippet = (task.body ?? "").slice(0, 200).replace(/\n/g, " ").trim();
    const query = `${task.title} ${bodySnippet}`.trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    // ── Single API call ──────────────────────────────────────────────────

    let result: PrismEnrichResponse;

    try {
      const url = `${apiUrl}/api/projects/${slug}/context/enrich`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, maxTokens: prismConfig.maxTokens }),
      });

      if (res.status === 404) {
        logger.warn({ taskId: task.id, slug }, "Prism enricher: project not found (404)");
        return { data: {}, durationMs: Date.now() - startTime };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.warn(
          { taskId: task.id, slug, status: res.status, body: body.slice(0, 200) },
          "Prism enricher: enrich endpoint returned non-OK",
        );
        return { data: {}, durationMs: Date.now() - startTime };
      }

      result = (await res.json()) as PrismEnrichResponse;
    } catch (err) {
      logger.warn({ taskId: task.id, slug, err }, "Prism enricher: enrich call failed");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const durationMs = Date.now() - startTime;
    const sections = result.sections ?? [];

    const data: Record<string, unknown> = {
      prism: {
        sections,
        totalTokens: result.totalTokens ?? 0,
        truncated: result.truncated ?? false,
        stats: {
          sectionCount: sections.length,
          totalTokens: result.totalTokens ?? 0,
          truncated: result.truncated ?? false,
        },
      } satisfies PrismEnrichmentData,
    };

    logger.info(
      {
        taskId: task.id,
        sections: sections.length,
        totalTokens: result.totalTokens,
        truncated: result.truncated,
        durationMs,
      },
      "Prism enricher completed",
    );

    return { data, durationMs };
  },
};
