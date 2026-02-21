import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate, isRefusalTitle, gatherRepoSummary } from "./base.js";
import { getAutonomousConfig, getModelFor } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Uses AI to suggest potential features for the repository.
 * Sends the repo file tree and README to Claude for analysis.
 */
export class FeatureScoutProducer implements Producer {
  name = "feature-scout";
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
      result.errors.push(`Repo directory not available for ${ctx.repoFullName} (repoId=${ctx.repoId}), skipping`);
      return result;
    }

    try {
      const prompt = `# Repository: ${ctx.repoFullName}\n\n${repoSummary}\n\nSuggest up to 3 useful new features.`;

      const response = await callClaude({
        prompt,
        model: getModelFor("producer"),
        systemPrompt: loadPrompt("producers/feature-scout"),
        dryRun: ctx.dryRun,
      });

      const acfg = getAutonomousConfig();
      result.costUsd += (response.cost.inputTokens * acfg.models.inputCostPerM + response.cost.outputTokens * acfg.models.outputCostPerM) / 1_000_000;

      if (response.text.trim().toUpperCase() === "NONE") {
        return result;
      }

      const suggestions = response.text
        .split(/^## /m)
        .map((block) => block.trim())
        .filter((block) => block.length > 0)
        .map((block) => {
          const newlineIdx = block.indexOf("\n");
          if (newlineIdx === -1) return { title: block.slice(0, 200), description: "" };
          return {
            title: block.slice(0, newlineIdx).trim().slice(0, 200),
            description: block.slice(newlineIdx + 1).trim(),
          };
        })
        .filter(({ title }) => !isRefusalTitle(title))
        .slice(0, 3);

      const source = `producer:${this.name}`;

      for (const { title, description } of suggestions) {
        try {
          if (await isDuplicate(source, title)) {
            result.duplicatesSkipped++;
            continue;
          }

          if (!ctx.dryRun) {
            await create({
              title,
              body: description || `Feature idea suggested by feature-scout producer for ${ctx.repoFullName}.`,
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
