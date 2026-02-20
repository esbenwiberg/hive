import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { getConfig, setConfig } from "../domain/config.js";
import {
  listLearnings,
  reinforceLearning,
  contradictLearning,
  createLearning,
  buildDismissedContext,
} from "../db/queries/learnings.js";
import { recordEvent, getRecentEvents } from "../db/queries/learning-events.js";
import { db } from "../db/connection.js";
import { tasks, costs } from "../db/schema.js";
import { sql, and, gte, inArray } from "drizzle-orm";
import { loadPrompt } from "../prompt-cache.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetrospectiveReport {
  summary: string;
  metrics: {
    totalTasks: number;
    firstPassRate: number;
    reworkRate: number;
    failureRate: number;
    totalCostUsd: number;
  };
  topLearnings: { id: number; content: string; reinforcements: number }[];
  decayingLearnings: { id: number; content: string; confidence: number }[];
  blindSpots: string[];
  proposals: {
    action: "create" | "promote" | "deprecate";
    scope: string | null;
    category: string | null;
    content: string | null;
    tags: string[] | null;
    targetId: number | null;
  }[];
  costInsights: string;
}

// ── Prompt loader ────────────────────────────────────────────────────────────

function getRetrospectivePrompt(): string {
  return loadPrompt("retrospective");
}


// ── Response parsing ─────────────────────────────────────────────────────────

function parseRetrospectiveResult(text: string): RetrospectiveReport {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned);

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    metrics: {
      totalTasks: typeof parsed.metrics?.totalTasks === "number" ? parsed.metrics.totalTasks : 0,
      firstPassRate: typeof parsed.metrics?.firstPassRate === "number" ? parsed.metrics.firstPassRate : 0,
      reworkRate: typeof parsed.metrics?.reworkRate === "number" ? parsed.metrics.reworkRate : 0,
      failureRate: typeof parsed.metrics?.failureRate === "number" ? parsed.metrics.failureRate : 0,
      totalCostUsd: typeof parsed.metrics?.totalCostUsd === "number" ? parsed.metrics.totalCostUsd : 0,
    },
    topLearnings: Array.isArray(parsed.topLearnings) ? parsed.topLearnings : [],
    decayingLearnings: Array.isArray(parsed.decayingLearnings) ? parsed.decayingLearnings : [],
    blindSpots: Array.isArray(parsed.blindSpots) ? parsed.blindSpots : [],
    proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    costInsights: typeof parsed.costInsights === "string" ? parsed.costInsights : "",
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Runs a weekly retrospective analysis over completed tasks since the last run.
 * Gathers task outcomes, costs, and learning data; sends to Claude for analysis;
 * applies proposed changes (create/reinforce/contradict learnings); and updates
 * the lastRetrospectiveRun config timestamp.
 */
export async function runRetrospective(): Promise<RetrospectiveReport> {
  const startTime = Date.now();
  const config = getAutonomousConfig();
  const model = config.models.gate;

  try {
    // Determine time range: since last retrospective run (or 7 days ago)
    const lastRunRaw = await getConfig("lastRetrospectiveRun");
    const sinceDate = lastRunRaw
      ? new Date(lastRunRaw as string)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Gather task outcomes since the last run
    const completedTasks = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        title: tasks.title,
        reworkCount: tasks.reworkCount,
        failureReason: tasks.failureReason,
        type: tasks.type,
      })
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ["done", "failed"]),
          gte(tasks.updatedAt, sinceDate),
        ),
      );

    // Gather cost data since the last run
    const costRows = await db
      .select({
        agent: costs.agent,
        totalUsd: sql<string>`coalesce(sum(${costs.costUsd}), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(costs)
      .where(gte(costs.createdAt, sinceDate))
      .groupBy(costs.agent);

    const totalCostUsd = costRows.reduce((sum, r) => sum + parseFloat(r.totalUsd), 0);

    // Gather learning data
    const { learnings: activeLearnings } = await listLearnings({ limit: 200 });
    const recentEvents = await getRecentEvents(100);

    // Calculate metrics for the prompt
    const doneTasks = completedTasks.filter((t) => t.status === "done");
    const failedTasks = completedTasks.filter((t) => t.status === "failed");
    const reworkedTasks = doneTasks.filter((t) => (t.reworkCount ?? 0) > 0);
    const firstPassTasks = doneTasks.filter((t) => (t.reworkCount ?? 0) === 0);

    const totalTasks = completedTasks.length;
    const firstPassRate = totalTasks > 0 ? firstPassTasks.length / totalTasks : 0;
    const reworkRate = totalTasks > 0 ? reworkedTasks.length / totalTasks : 0;
    const failureRate = totalTasks > 0 ? failedTasks.length / totalTasks : 0;

    // Build task outcomes summary
    const tasksSummary = completedTasks
      .map(
        (t) =>
          `[${t.status}] ${t.id}: ${t.title} (type=${t.type ?? "unknown"}, reworkCount=${t.reworkCount ?? 0}${t.failureReason ? `, failureReason=${t.failureReason}` : ""})`,
      )
      .join("\n");

    // Build cost summary
    const costsSummary = costRows
      .map((r) => `  ${r.agent}: $${parseFloat(r.totalUsd).toFixed(4)} (${r.count} calls)`)
      .join("\n");

    // Build learnings summary
    const learningsSummary = activeLearnings
      .map(
        (l) =>
          `[id:${l.id}] scope=${l.scope} category=${l.category} confidence=${l.confidence} reinforcements=${l.reinforcements} contradictions=${l.contradictions} lastUsed=${l.lastUsedAt?.toISOString() ?? "never"}\n  ${l.content}`,
      )
      .join("\n\n");

    // Build recent events summary
    const eventsSummary = recentEvents
      .map(
        (e) =>
          `[${e.eventType}] learning=${e.learningId} task=${e.taskId ?? "none"} ${e.evidence ?? ""}`,
      )
      .join("\n");

    // Failure reasons summary
    const failureReasons = failedTasks
      .filter((t) => t.failureReason)
      .map((t) => `  ${t.id}: ${t.failureReason}`)
      .join("\n");

    const dismissedContext = await buildDismissedContext();

    const userPrompt = [
      `## Period`,
      `From: ${sinceDate.toISOString()}`,
      `To: ${new Date().toISOString()}`,
      ``,
      `## Pre-computed Metrics`,
      `Total tasks: ${totalTasks}`,
      `Done: ${doneTasks.length}, Failed: ${failedTasks.length}, Reworked: ${reworkedTasks.length}, First-pass: ${firstPassTasks.length}`,
      `First-pass rate: ${(firstPassRate * 100).toFixed(1)}%`,
      `Rework rate: ${(reworkRate * 100).toFixed(1)}%`,
      `Failure rate: ${(failureRate * 100).toFixed(1)}%`,
      `Total cost: $${totalCostUsd.toFixed(4)}`,
      ``,
      `## Task Outcomes (${completedTasks.length} tasks)`,
      tasksSummary || "(no completed tasks in period)",
      ``,
      `## Failure Reasons`,
      failureReasons || "(none)",
      ``,
      `## Cost Breakdown by Agent`,
      costsSummary || "(no costs in period)",
      ``,
      `## Active Learnings (${activeLearnings.length} total)`,
      learningsSummary || "(no active learnings)",
      ``,
      `## Recent Learning Events (last 100)`,
      eventsSummary || "(no recent events)",
      dismissedContext,
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: getRetrospectivePrompt(),
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    const report = parseRetrospectiveResult(response.text);

    // Apply proposed changes
    for (const proposal of report.proposals) {
      try {
        if (proposal.action === "create" && proposal.content && proposal.scope && proposal.category) {
          const learning = await createLearning({
            scope: proposal.scope,
            category: proposal.category,
            content: proposal.content,
            confidence: 0.50,
            tags: proposal.tags ?? [],
          });
          await recordEvent({
            learningId: learning.id,
            eventType: "created",
            evidence: "Retrospective: blind spot or new pattern identified",
          });
        } else if (proposal.action === "promote" && proposal.targetId != null) {
          await reinforceLearning(proposal.targetId, "retrospective");
          await recordEvent({
            learningId: proposal.targetId,
            eventType: "reinforced",
            evidence: "Retrospective: consistently useful learning promoted",
          });
        } else if (proposal.action === "deprecate" && proposal.targetId != null) {
          await contradictLearning(proposal.targetId, "retrospective", 0.15);
          await recordEvent({
            learningId: proposal.targetId,
            eventType: "contradicted",
            evidence: "Retrospective: ineffective learning deprecated",
          });
        }
      } catch (err) {
        logger.warn({ proposal, err }, "Retrospective: failed to apply proposal");
      }
    }

    // Persist the report so the dashboard can display it
    await setConfig("lastRetrospectiveReport", report);

    // Update last run timestamp
    await setConfig("lastRetrospectiveRun", new Date().toISOString());

    logger.info(
      {
        totalTasks,
        firstPassRate: report.metrics.firstPassRate,
        proposalsApplied: report.proposals.length,
        blindSpots: report.blindSpots.length,
        costUsd,
        durationMs,
      },
      "Retrospective complete",
    );

    return report;
  } catch (err) {
    logger.error({ err }, "Retrospective: analysis failed");
    throw err;
  }
}
