/**
 * Prism enricher — semantic codebase search, module summaries, and
 * architectural findings powered by the Prism API.
 *
 * Requires PRISM_API_URL (or prism.apiUrl in config) to be set.
 * All embedding and indexing is handled by Prism; Hive only sends
 * the query text and receives structured results.
 */

import logger from "../logger.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import * as repoQueries from "../db/queries/repos.js";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Types returned by the enricher ──────────────────────────────────────────

interface PrismRelevantCode {
  targetId: string;
  filePath: string | null;
  symbolName: string | null;
  symbolKind: string | null;
  level: string;
  summary: string;
  score: number;
}

interface PrismModuleSummary {
  targetId: string;
  content: string;
}

interface PrismFinding {
  category: string;
  severity: string;
  title: string;
  description: string;
  suggestion: string | null;
}

interface PrismEnrichmentData {
  relevantCode: PrismRelevantCode[];
  moduleSummaries: PrismModuleSummary[];
  findings: PrismFinding[];
  stats: {
    searchResults: number;
    summariesReturned: number;
    findingsReturned: number;
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_SEARCH_RESULTS = 20;
const MAX_MODULE_SUMMARIES = 30;
const MAX_FINDINGS = 20;

// ── Enricher ────────────────────────────────────────────────────────────────

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

    const slug = encodeURIComponent(repo.fullName);
    const query = `${task.title} ${task.body ?? ""}`.trim();

    let result: { relevantCode: PrismRelevantCode[]; moduleSummaries: PrismModuleSummary[]; findings: PrismFinding[] };

    try {
      const response = await fetch(`${apiUrl}/api/projects/${slug}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          query,
          maxResults: MAX_SEARCH_RESULTS,
          maxSummaries: MAX_MODULE_SUMMARIES,
          maxFindings: MAX_FINDINGS,
        }),
      });

      if (response.status === 404) {
        logger.info({ taskId: task.id, slug: repo.fullName }, "Prism enricher: project not found, skipping");
        return { data: {}, durationMs: Date.now() - startTime };
      }

      if (!response.ok) {
        throw new Error(`Prism API returned ${response.status}`);
      }

      result = await response.json() as typeof result;
    } catch (err) {
      logger.warn({ taskId: task.id, err }, "Prism enricher: API call failed, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const durationMs = Date.now() - startTime;

    const data: Record<string, unknown> = {
      prism: {
        relevantCode: result.relevantCode,
        moduleSummaries: result.moduleSummaries,
        findings: result.findings,
        stats: {
          searchResults: result.relevantCode.length,
          summariesReturned: result.moduleSummaries.length,
          findingsReturned: result.findings.length,
        },
      } satisfies PrismEnrichmentData,
    };

    logger.info(
      {
        taskId: task.id,
        searchResults: result.relevantCode.length,
        summaries: result.moduleSummaries.length,
        findings: result.findings.length,
        durationMs,
      },
      "Prism enricher completed",
    );

    return { data, durationMs };
  },
};
