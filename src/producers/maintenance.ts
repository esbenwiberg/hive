import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate, isRefusalTitle, gatherRepoSummary } from "./base.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface MaintenanceScores {
  value: number;
  complexity: number;
  risk: number;
  block: number;
}

interface MaintenanceFinding {
  title: string;
  body: string;
  category: string;
  scores: MaintenanceScores;
  priority: number;
}

// ── Category → task type mapping ─────────────────────────────────────────────

const CATEGORY_TO_TYPE: Record<string, string> = {
  "legacy": "chore",
  "outdated-deps": "chore",
  "complexity": "chore",
  "duplication": "chore",
  "dead-code": "chore",
  "stale-types": "chore",
};

// ── Size heuristic based on complexity score ──────────────────────────────────

function complexityToSize(complexity: number): string {
  if (complexity <= 1) return "small";
  if (complexity <= 3) return "medium";
  return "large";
}

// ── Response parser ──────────────────────────────────────────────────────────

/**
 * Attempts to parse the LLM response as a JSON array of MaintenanceFinding
 * objects. Returns an empty array if parsing fails or the result is not an array.
 */
function parseFindings(text: string): MaintenanceFinding[] {
  // Strip any accidental markdown fences the model may have included
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  if (!cleaned || cleaned.toUpperCase() === "NONE" || cleaned === "[]") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const findings: MaintenanceFinding[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;

    const obj = item as Record<string, unknown>;

    const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 120) : "";
    if (!title) continue;
    if (isRefusalTitle(title)) continue;

    const body = typeof obj.body === "string" ? obj.body.trim() : "";
    const category = typeof obj.category === "string" ? obj.category.trim() : "legacy";

    const rawScores = typeof obj.scores === "object" && obj.scores !== null
      ? (obj.scores as Record<string, unknown>)
      : {};

    const clamp = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return isNaN(n) ? fallback : Math.max(1, Math.min(5, Math.round(n)));
    };

    const scores: MaintenanceScores = {
      value:      clamp(rawScores.value,      3),
      complexity: clamp(rawScores.complexity, 3),
      risk:       clamp(rawScores.risk,       3),
      block:      clamp(rawScores.block,      1),
    };

    // Recompute priority server-side to guard against LLM arithmetic errors
    const priority = (scores.value * 2) + (scores.block * 2) - scores.complexity - scores.risk;

    findings.push({ title, body, category, scores, priority });
  }

  // Sort by priority descending (model should already do this, but enforce it)
  findings.sort((a, b) => b.priority - a.priority);

  return findings;
}

// ── Producer ─────────────────────────────────────────────────────────────────

/**
 * Scans the repository for technical debt signals — legacy patterns, outdated
 * dependencies, overgrown functions, duplicated code, dead code, and stale
 * type definitions — and creates prioritised maintenance tasks.
 */
export class MaintenanceProducer implements Producer {
  name = "maintenance";
  needsRepo = true;

  private readonly promptKey = "producers/maintenance";

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    const repoSummary = ctx.repoDir ? gatherRepoSummary(ctx.repoDir) : undefined;
    if (!repoSummary) {
      result.errors.push(
        `Repo directory not available for ${ctx.repoFullName} (repoId=${ctx.repoId}), skipping`,
      );
      return result;
    }

    try {
      const prompt =
        `# Repository: ${ctx.repoFullName}\n\n` +
        `${repoSummary}\n\n` +
        `Analyse the repository above for technical debt and maintenance opportunities. ` +
        `Return up to 8 findings as a JSON array following the schema in your instructions.`;

      const response = await callClaude({
        prompt,
        model: getModelFor("producer"),
        systemPrompt: loadPrompt(this.promptKey),
        dryRun: ctx.dryRun,
      });

      const acfg = getAutonomousConfig();
      result.costUsd +=
        (response.cost.inputTokens * acfg.models.inputCostPerM +
          response.cost.outputTokens * acfg.models.outputCostPerM) /
        1_000_000;

      const findings = parseFindings(response.text);
      const source = `producer:${this.name}`;

      for (const finding of findings) {
        try {
          if (await isDuplicate(source, finding.title)) {
            result.duplicatesSkipped++;
            continue;
          }

          const taskType = CATEGORY_TO_TYPE[finding.category] ?? "chore";
          const size = complexityToSize(finding.scores.complexity);

          // Build a rich body that includes the score breakdown so downstream
          // agents and reviewers can see exactly how the task was prioritised.
          const scoreBlock = [
            "---",
            "**Maintenance analysis scores**",
            "",
            `| Axis       | Score |`,
            `|------------|-------|`,
            `| Value      | ${finding.scores.value}/5 |`,
            `| Complexity | ${finding.scores.complexity}/5 |`,
            `| Risk       | ${finding.scores.risk}/5 |`,
            `| Block      | ${finding.scores.block}/5 |`,
            `| **Priority** | **${finding.priority}** |`,
            "",
            `_Category: ${finding.category}_`,
          ].join("\n");

          const fullBody = finding.body
            ? `${finding.body}\n\n${scoreBlock}`
            : scoreBlock;

          if (!ctx.dryRun) {
            await create({
              title: finding.title,
              body: fullBody,
              source,
              type: taskType,
              size,
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create maintenance task "${finding.title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Maintenance producer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const maintenanceProducer = new MaintenanceProducer();
export default maintenanceProducer;
