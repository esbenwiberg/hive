import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Uses AI to suggest potential features for the repository.
 * Sends a feature-suggestion prompt to Claude and creates tasks
 * for each idea (up to 3).
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

    try {
      const prompt = `Analyze the repository "${ctx.repoFullName}" and suggest useful new features. Return only a newline-delimited list of concise feature titles, up to 3 items. No numbering, no explanations, just one feature title per line.`;

      const response = await callClaude({
        prompt,
        dryRun: ctx.dryRun,
      });

      const acfg = getAutonomousConfig();
      result.costUsd += (response.cost.inputTokens * acfg.models.inputCostPerM + response.cost.outputTokens * acfg.models.outputCostPerM) / 1_000_000;

      const titles = response.text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
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
