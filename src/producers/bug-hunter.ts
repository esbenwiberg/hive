import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Uses AI to identify potential bugs in the repository.
 * Sends a prompt to Claude asking for bug analysis and creates
 * tasks for each identified potential bug (up to 5).
 */
export class BugHunterProducer implements Producer {
  name = "bug-hunter";

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    try {
      const prompt = `Analyze the repository "${ctx.repoFullName}" and list potential bugs that should be investigated. Return only a newline-delimited list of concise bug titles, up to 5 items. No numbering, no explanations, just one bug title per line.`;

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
        .slice(0, 5);

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
              body: `Potential bug identified by bug-hunter producer for ${ctx.repoFullName}.`,
              source,
              type: "bug",
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create bug task "${title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Bug hunter failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const bugHunter = new BugHunterProducer();
export default bugHunter;
