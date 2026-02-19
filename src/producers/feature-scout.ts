import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate, isRefusalTitle, gatherRepoSummary } from "./base.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

const SYSTEM_PROMPT = `You are a senior product engineer reviewing a codebase for feature opportunities. You will be given the repository's file tree and README. Based on that context, suggest useful new features. Return ONLY a newline-delimited list of concise feature titles (max 120 chars each). No numbering, no explanations, just one feature title per line. If you cannot suggest any features, return the single word NONE.`;

/**
 * Uses AI to suggest potential features for the repository.
 * Sends the repo file tree and README to Claude for analysis.
 */
export class FeatureScoutProducer implements Producer {
  name = "feature-scout";

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    const repoSummary = ctx.repoDir ? gatherRepoSummary(ctx.repoDir) : undefined;
    if (!repoSummary) {
      result.errors.push(`Repo directory not available for ${ctx.repoFullName} (repoId=${ctx.repoId}), skipping`);
      return result;
    }

    try {
      const prompt = `# Repository: ${ctx.repoFullName}\n\n${repoSummary}\n\nSuggest up to 3 useful new features.`;

      const response = await callClaude({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        dryRun: ctx.dryRun,
      });

      const acfg = getAutonomousConfig();
      result.costUsd += (response.cost.inputTokens * acfg.models.inputCostPerM + response.cost.outputTokens * acfg.models.outputCostPerM) / 1_000_000;

      if (response.text.trim().toUpperCase() === "NONE") {
        return result;
      }

      const titles = response.text
        .split("\n")
        .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter((line) => line.length > 0 && line.length <= 200)
        .filter((line) => !isRefusalTitle(line))
        .slice(0, 3);

      const source = `producer:${this.name}`;

      for (const title of titles) {
        try {
          if (await isDuplicate(source, title)) {
            result.duplicatesSkipped++;
            continue;
          }

          if (!ctx.dryRun) {
            await create({
              title,
              body: `Feature idea suggested by feature-scout producer for ${ctx.repoFullName}.`,
              source,
              type: "feature",
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create feature task "${title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Feature scout failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const featureScout = new FeatureScoutProducer();
export default featureScout;
