/**
 * Prism enricher — semantic codebase search, module summaries, and
 * architectural findings powered by the Prism API.
 *
 * Calls the legacy /search endpoint plus 3 new context endpoints
 * (related files, architecture, recent changes) in parallel.
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

interface PrismContextSection {
  title: string;
  content: string;
  tokens: number;
}

interface PrismContextResponse {
  sections: PrismContextSection[];
  totalTokens: number;
  truncated: boolean;
}

interface PrismEnrichmentData {
  relevantCode: PrismRelevantCode[];
  moduleSummaries: PrismModuleSummary[];
  findings: PrismFinding[];
  context: {
    relatedFiles: PrismContextResponse | null;
    architecture: PrismContextResponse | null;
    recentChanges: PrismContextResponse | null;
  };
  stats: {
    searchResults: number;
    summariesReturned: number;
    findingsReturned: number;
    contextEndpointsCalled: number;
    contextTotalTokens: number;
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_SEARCH_RESULTS = 20;
const MAX_MODULE_SUMMARIES = 30;
const MAX_FINDINGS = 20;

const CONTEXT_TOKEN_BUDGETS = {
  related: 8000,
  arch: 4000,
  changes: 4000,
} as const;

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

    const repoSettings = (repo.settings ?? {}) as Record<string, unknown>;
    const slug = (repoSettings.prismSlug as string) || repo.fullName;

    // Use title + first ~200 chars of body for a focused query.
    // The full body often contains UI copy, acceptance criteria, and other noise
    // that degrades search relevance.
    const bodySnippet = (task.body ?? "").slice(0, 200).replace(/\n/g, " ").trim();
    const query = `${task.title} ${bodySnippet}`.trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    // ── Helper: call a context endpoint ──────────────────────────────────
    async function callContext(
      endpoint: string,
      body: Record<string, unknown>,
    ): Promise<PrismContextResponse | null> {
      try {
        const response = await fetch(`${apiUrl}/api/projects/${slug}/${endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          logger.warn(
            { taskId: task.id, endpoint, status: response.status },
            "Prism context endpoint returned non-OK status",
          );
          return null;
        }

        return (await response.json()) as PrismContextResponse;
      } catch (err) {
        logger.warn(
          { taskId: task.id, endpoint, err },
          "Prism context endpoint call failed",
        );
        return null;
      }
    }

    // ── Fire all calls in parallel ───────────────────────────────────────

    // Determine if slug has owner/repo format for context endpoints
    const hasOwnerRepo = slug.includes("/");

    const searchPromise = (async () => {
      try {
        const response = await fetch(`${apiUrl}/api/projects/${slug}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query,
            maxResults: MAX_SEARCH_RESULTS,
            maxSummaries: MAX_MODULE_SUMMARIES,
            maxFindings: MAX_FINDINGS,
          }),
        });

        if (response.status === 404) {
          return null; // project not found
        }

        if (!response.ok) {
          throw new Error(`Prism API returned ${response.status}`);
        }

        return (await response.json()) as {
          relevantCode: PrismRelevantCode[];
          moduleSummaries: PrismModuleSummary[];
          findings: PrismFinding[];
        };
      } catch (err) {
        logger.warn({ taskId: task.id, err }, "Prism enricher: search call failed");
        return null;
      }
    })();

    const contextPromises = hasOwnerRepo
      ? {
          relatedFiles: callContext("context/related", {
            intent: query,
            tokenBudget: CONTEXT_TOKEN_BUDGETS.related,
          }),
          architecture: callContext("context/arch", {
            intent: task.title,
            tokenBudget: CONTEXT_TOKEN_BUDGETS.arch,
          }),
          recentChanges: callContext("context/changes", {
            intent: task.title,
            tokenBudget: CONTEXT_TOKEN_BUDGETS.changes,
          }),
        }
      : {
          relatedFiles: Promise.resolve(null) as Promise<PrismContextResponse | null>,
          architecture: Promise.resolve(null) as Promise<PrismContextResponse | null>,
          recentChanges: Promise.resolve(null) as Promise<PrismContextResponse | null>,
        };

    const [searchResult, relatedFiles, architecture, recentChanges] = await Promise.all([
      searchPromise,
      contextPromises.relatedFiles,
      contextPromises.architecture,
      contextPromises.recentChanges,
    ]);

    // If search returned null (404 or failure) and no context data, bail out
    if (!searchResult && !relatedFiles && !architecture && !recentChanges) {
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const durationMs = Date.now() - startTime;

    // Count how many context endpoints were actually called (not skipped)
    const contextEndpointsCalled = hasOwnerRepo ? 3 : 0;
    const contextTotalTokens =
      (relatedFiles?.totalTokens ?? 0) +
      (architecture?.totalTokens ?? 0) +
      (recentChanges?.totalTokens ?? 0);

    const data: Record<string, unknown> = {
      prism: {
        relevantCode: searchResult?.relevantCode ?? [],
        moduleSummaries: searchResult?.moduleSummaries ?? [],
        findings: searchResult?.findings ?? [],
        context: {
          relatedFiles,
          architecture,
          recentChanges,
        },
        stats: {
          searchResults: searchResult?.relevantCode.length ?? 0,
          summariesReturned: searchResult?.moduleSummaries.length ?? 0,
          findingsReturned: searchResult?.findings.length ?? 0,
          contextEndpointsCalled,
          contextTotalTokens,
        },
      } satisfies PrismEnrichmentData,
    };

    logger.info(
      {
        taskId: task.id,
        searchResults: searchResult?.relevantCode.length ?? 0,
        summaries: searchResult?.moduleSummaries.length ?? 0,
        findings: searchResult?.findings.length ?? 0,
        contextEndpointsCalled,
        contextTotalTokens,
        durationMs,
      },
      "Prism enricher completed",
    );

    return { data, durationMs };
  },
};
