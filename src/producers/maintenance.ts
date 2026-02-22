import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate, isRefusalTitle, gatherRepoSummary } from "./base.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface MaintenanceCandidate {
  title: string;
  description: string;
  value: number;
  complexity: number;
  risk: number;
  block: number;
  priority: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads package.json from the repo and returns a formatted summary of
 * dependency names and their pinned versions (both dependencies and
 * devDependencies), capped to avoid bloating the prompt.
 */
function gatherDependencies(repoDir: string): string | undefined {
  const pkgPath = join(repoDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    const deps = pkg["dependencies"] as Record<string, string> | undefined;
    const devDeps = pkg["devDependencies"] as Record<string, string> | undefined;

    const lines: string[] = [];

    if (deps) {
      lines.push("### dependencies");
      for (const [name, version] of Object.entries(deps).slice(0, 60)) {
        lines.push(`  ${name}: ${version}`);
      }
    }

    if (devDeps) {
      lines.push("### devDependencies");
      for (const [name, version] of Object.entries(devDeps).slice(0, 60)) {
        lines.push(`  ${name}: ${version}`);
      }
    }

    return lines.length ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses the `value=V, complexity=C, risk=R, block=B, priority=P` scores line
 * from a candidate block. Returns null if the line is missing or malformed.
 */
function parseScores(
  text: string,
): { value: number; complexity: number; risk: number; block: number; priority: number } | null {
  const match = text.match(
    /\*\*Scores:\*\*\s+value=(\d+),\s*complexity=(\d+),\s*risk=(\d+),\s*block=(\d+),\s*priority=(\d+)/i,
  );
  if (!match) return null;

  return {
    value: parseInt(match[1]!, 10),
    complexity: parseInt(match[2]!, 10),
    risk: parseInt(match[3]!, 10),
    block: parseInt(match[4]!, 10),
    priority: parseInt(match[5]!, 10),
  };
}

/**
 * Computes the canonical priority score from raw dimension scores.
 * Matches the formula in the prompt: priority = (value×2 + block×2) − (complexity + risk)
 */
function computePriority(value: number, complexity: number, risk: number, block: number): number {
  return value * 2 + block * 2 - complexity - risk;
}

/**
 * Parses the LLM response into scored MaintenanceCandidate objects.
 * Blocks are separated by "## " headings as specified in the prompt format.
 * Any block without parseable scores or with priority ≤ 5 is discarded.
 */
function parseCandidates(responseText: string): MaintenanceCandidate[] {
  const blocks = responseText
    .split(/^## /m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const candidates: MaintenanceCandidate[] = [];

  for (const block of blocks) {
    const newlineIdx = block.indexOf("\n");
    if (newlineIdx === -1) continue;

    const title = block.slice(0, newlineIdx).trim().slice(0, 200);
    const rest = block.slice(newlineIdx + 1).trim();

    if (!title || isRefusalTitle(title)) continue;

    const scores = parseScores(rest);
    if (!scores) continue;

    // Strip the scores line from the description
    const description = rest
      .replace(/\*\*Scores:\*\*.*$/im, "")
      .trim();

    // Recompute priority defensively (LLM may round incorrectly)
    const recomputed = computePriority(scores.value, scores.complexity, scores.risk, scores.block);

    candidates.push({
      title,
      description,
      value: scores.value,
      complexity: scores.complexity,
      risk: scores.risk,
      block: scores.block,
      priority: recomputed,
    });
  }

  // Sort highest priority first, then discard entries ≤ 5
  return candidates
    .filter((c) => c.priority > 5)
    .sort((a, b) => b.priority - a.priority);
}

// ── Producer ─────────────────────────────────────────────────────────────────

/**
 * Scans the repository for technical debt: legacy patterns, outdated
 * packages, overly complex functions, duplicated logic, and general
 * maintenance concerns.  Each finding is scored on a value / complexity /
 * risk / block matrix and ranked by priority before being emitted as tasks.
 */
export class MaintenanceProducer implements Producer {
  name = "maintenance";
  needsRepo = true;

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

    // Augment with dependency versions so the LLM can spot outdated packages
    const depSummary = ctx.repoDir ? gatherDependencies(ctx.repoDir) : undefined;

    const contextParts = [`# Repository: ${ctx.repoFullName}`, "", repoSummary];
    if (depSummary) {
      contextParts.push("", "## Package versions", depSummary);
    }
    contextParts.push("", "Identify up to 5 maintenance tasks, scored and sorted by priority.");

    const prompt = contextParts.join("\n");

    try {
      const response = await callClaude({
        prompt,
        model: getModelFor("producer"),
        systemPrompt: loadPrompt("producers/maintenance"),
        dryRun: ctx.dryRun,
      });

      const acfg = getAutonomousConfig();
      result.costUsd +=
        (response.cost.inputTokens * acfg.models.inputCostPerM +
          response.cost.outputTokens * acfg.models.outputCostPerM) /
        1_000_000;

      if (response.text.trim().toUpperCase() === "NONE") {
        return result;
      }

      const candidates = parseCandidates(response.text).slice(0, 5);

      const source = `producer:${this.name}`;

      for (const candidate of candidates) {
        const { title, description, value, complexity, risk, block, priority } = candidate;

        try {
          if (await isDuplicate(source, title)) {
            result.duplicatesSkipped++;
            continue;
          }

          const body =
            description ||
            `Maintenance task identified by maintenance producer for ${ctx.repoFullName}.`;

          // Append score metadata to the task body so it's visible in the UI
          const fullBody = [
            body,
            "",
            `**Maintenance scores:** value=${value}, complexity=${complexity}, risk=${risk}, block=${block}, priority=${priority}`,
          ].join("\n");

          if (!ctx.dryRun) {
            await create({
              title,
              body: fullBody,
              source,
              type: "chore",
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create maintenance task "${title}": ${err instanceof Error ? err.message : String(err)}`,
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
