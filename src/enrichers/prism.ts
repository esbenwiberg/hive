/**
 * Prism enricher — semantic codebase search and context powered by
 * the Prism API.
 *
 * Calls (all in parallel):
 *   POST /search          — semantic code search + module summaries
 *   POST /context/related — related files via similarity + dep graph
 *   POST /context/arch    — architecture overview
 *   POST /context/changes — recent change history
 *
 * Each call is fault-tolerant — a single failure doesn't block the rest.
 *
 * Requires PRISM_API_URL (or prism.apiUrl in config) to be set.
 */

import logger from "../logger.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import * as repoQueries from "../db/queries/repos.js";
import type { Enricher, EnricherConfig, EnrichmentResult } from "./base.js";
import type { TaskRow } from "../db/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

interface PrismRelatedFile {
  path: string;
  score: number;
  relationship: string;
  summary: string;
}

interface PrismContextResponse {
  sections: Array<{ title: string; content: string; tokens: number }>;
  totalTokens: number;
  truncated: boolean;
}

interface PrismEnrichmentData {
  relevantCode: PrismRelevantCode[];
  moduleSummaries: PrismModuleSummary[];
  relatedFiles: PrismRelatedFile[];
  context: {
    architecture: PrismContextResponse | null;
    recentChanges: PrismContextResponse | null;
  };
  stats: {
    searchResults: number;
    summariesReturned: number;
    relatedFilesReturned: number;
    contextEndpointsCalled: number;
    contextTotalTokens: number;
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_SEARCH_RESULTS = 20;
const MAX_MODULE_SUMMARIES = 30;
const MAX_RELATED_FILES = 15;

const CONTEXT_TOKEN_BUDGETS = {
  arch: 5000,
  changes: 4000,
} as const;

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
    const base = `${apiUrl}/api/projects/${slug}`;

    // Use title + first ~200 chars of body for a focused query.
    const bodySnippet = (task.body ?? "").slice(0, 200).replace(/\n/g, " ").trim();
    const query = `${task.title} ${bodySnippet}`.trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    // ── Helper ─────────────────────────────────────────────────────────────

    async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
      try {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          logger.warn({ taskId: task.id, path, status: res.status }, "Prism endpoint returned non-OK");
          return null;
        }
        return (await res.json()) as T;
      } catch (err) {
        logger.warn({ taskId: task.id, path, err }, "Prism endpoint call failed");
        return null;
      }
    }

    // ── Fire all calls in parallel ───────────────────────────────────────

    const [searchResult, relatedResult, archResult, changesResult] =
      await Promise.all([
        // 1. Semantic search (code + module summaries)
        post<{ relevantCode?: PrismRelevantCode[]; moduleSummaries?: PrismModuleSummary[] }>(
          "/search",
          { query, maxResults: MAX_SEARCH_RESULTS, maxSummaries: MAX_MODULE_SUMMARIES },
        ),

        // 2. Related files via similarity + dependency graph
        post<{ results?: PrismRelatedFile[] }>(
          "/context/related",
          { query, maxResults: MAX_RELATED_FILES, includeTests: false },
        ),

        // 3. Architecture overview
        post<PrismContextResponse>(
          "/context/arch",
          { maxTokens: CONTEXT_TOKEN_BUDGETS.arch },
        ),

        // 4. Recent changes
        post<PrismContextResponse>(
          "/context/changes",
          { maxCommits: 20, maxTokens: CONTEXT_TOKEN_BUDGETS.changes },
        ),
      ]);

    // If everything failed, bail out
    if (!searchResult && !relatedResult && !archResult && !changesResult) {
      logger.warn({ taskId: task.id, slug }, "Prism enricher: all endpoints failed, returning empty");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const durationMs = Date.now() - startTime;

    const relevantCode = searchResult?.relevantCode ?? [];
    const moduleSummaries = searchResult?.moduleSummaries ?? [];
    const relatedFiles = relatedResult?.results ?? [];

    let contextEndpointsCalled = 0;
    let contextTotalTokens = 0;
    for (const ctx of [archResult, changesResult]) {
      if (ctx) {
        contextEndpointsCalled++;
        contextTotalTokens += ctx.totalTokens ?? 0;
      }
    }

    const data: Record<string, unknown> = {
      prism: {
        relevantCode,
        moduleSummaries,
        relatedFiles,
        context: {
          architecture: archResult,
          recentChanges: changesResult,
        },
        stats: {
          searchResults: relevantCode.length,
          summariesReturned: moduleSummaries.length,
          relatedFilesReturned: relatedFiles.length,
          contextEndpointsCalled,
          contextTotalTokens,
        },
      } satisfies PrismEnrichmentData,
    };

    logger.info(
      {
        taskId: task.id,
        searchResults: relevantCode.length,
        summaries: moduleSummaries.length,
        relatedFiles: relatedFiles.length,
        contextEndpointsCalled,
        contextTotalTokens,
        durationMs,
      },
      "Prism enricher completed",
    );

    return { data, durationMs };
  },
};
