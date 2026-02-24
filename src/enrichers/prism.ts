/**
 * Prism enricher — semantic codebase search, module summaries, and
 * architectural findings powered by the Prism index.
 *
 * Lazy-imports `@prism/core` so the enricher gracefully skips if the
 * package is not installed or `PRISM_DATABASE_URL` is not set.
 */

import logger from "../logger.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
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
    semanticSearchFailed?: boolean;
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_SEARCH_RESULTS = 20;
const MAX_MODULE_SUMMARIES = 30;
const MAX_FINDINGS = 20;
const ALLOWED_FINDING_SEVERITIES = new Set(["critical", "high", "medium"]);

// ── Enricher ────────────────────────────────────────────────────────────────

export const prismEnricher: Enricher = {
  name: "prism",

  async run(
    task: TaskRow,
    repoDir: string,
    _priorResults: Record<string, unknown>,
    _config: EnricherConfig,
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();

    // ── Guard: lazy-import @prism/core ──────────────────────────────────
    let prism: typeof import("@prism/core");
    try {
      prism = await import("@prism/core");
    } catch {
      logger.info("Prism enricher: @prism/core not available, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    const prismConfig = getAutonomousConfig().prism;
    const prismDbUrl = process.env.PRISM_DATABASE_URL || prismConfig.databaseUrl;
    if (!prismDbUrl) {
      logger.info("Prism enricher: PRISM_DATABASE_URL not set, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    // Point Prism queries at its own database
    prism.setActiveConnectionString(prismDbUrl);

    // ── Look up project ────────────────────────────────────────────────
    const project = await prism.getProjectByPath(repoDir);
    if (!project) {
      logger.info({ repoDir }, "Prism enricher: no project found for repo path, skipping");
      return { data: {}, durationMs: Date.now() - startTime };
    }

    if (project.indexStatus !== "completed" && project.indexStatus !== "partial") {
      logger.info(
        { repoDir, indexStatus: project.indexStatus },
        "Prism enricher: project not indexed, skipping",
      );
      return { data: {}, durationMs: Date.now() - startTime };
    }

    // ── Semantic search ────────────────────────────────────────────────
    const relevantCode: PrismRelevantCode[] = [];
    let semanticSearchFailed = false;

    try {
      const queryText = `${task.title} ${task.body ?? ""}`.trim();

      const embeddingProvider = process.env.PRISM_EMBEDDING_PROVIDER || prismConfig.embeddingProvider;
      const embeddingModel = process.env.PRISM_EMBEDDING_MODEL || prismConfig.embeddingModel;

      const embedder = prism.createEmbedder({
        enabled: true,
        model: embeddingModel,
        embeddingProvider,
        embeddingModel,
        embeddingDimensions: 1024,
        budgetUsd: 0.01,
      });

      const [queryVector] = await embedder.embed([queryText]);
      const results = await prism.simpleSimilaritySearch(
        project.id,
        queryVector,
        MAX_SEARCH_RESULTS,
      );

      for (const r of results) {
        relevantCode.push({
          targetId: r.targetId,
          filePath: r.filePath,
          symbolName: r.symbolName,
          symbolKind: r.symbolKind,
          level: r.level,
          summary: r.summaryContent,
          score: r.score,
        });
      }
    } catch (err) {
      semanticSearchFailed = true;
      logger.warn(
        { taskId: task.id, err },
        "Prism enricher: semantic search failed (continuing with summaries/findings)",
      );
    }

    // ── Module summaries ───────────────────────────────────────────────
    const moduleSummaries: PrismModuleSummary[] = [];

    try {
      const summaries = await prism.getSummariesByLevel(project.id, "module");
      for (const s of summaries.slice(0, MAX_MODULE_SUMMARIES)) {
        moduleSummaries.push({
          targetId: s.targetId,
          content: s.content,
        });
      }
    } catch (err) {
      logger.warn(
        { taskId: task.id, err },
        "Prism enricher: failed to fetch module summaries",
      );
    }

    // ── Findings ───────────────────────────────────────────────────────
    const findings: PrismFinding[] = [];

    try {
      const allFindings = await prism.getFindingsByProjectId(project.id);
      for (const f of allFindings) {
        if (!ALLOWED_FINDING_SEVERITIES.has(f.severity)) continue;
        if (findings.length >= MAX_FINDINGS) break;

        findings.push({
          category: f.category,
          severity: f.severity,
          title: f.title,
          description: f.description,
          suggestion: f.suggestion,
        });
      }
    } catch (err) {
      logger.warn(
        { taskId: task.id, err },
        "Prism enricher: failed to fetch findings",
      );
    }

    // ── Return ─────────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime;

    const data: Record<string, unknown> = {
      prism: {
        relevantCode,
        moduleSummaries,
        findings,
        stats: {
          searchResults: relevantCode.length,
          summariesReturned: moduleSummaries.length,
          findingsReturned: findings.length,
          ...(semanticSearchFailed ? { semanticSearchFailed: true } : {}),
        },
      } satisfies PrismEnrichmentData,
    };

    logger.info(
      {
        taskId: task.id,
        searchResults: relevantCode.length,
        summaries: moduleSummaries.length,
        findings: findings.length,
        durationMs,
      },
      "Prism enricher completed",
    );

    return { data, durationMs };
  },
};
