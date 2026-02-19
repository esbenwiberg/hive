import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate, isRefusalTitle, gatherRepoSummary } from "./base.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

const SYSTEM_PROMPT = `You are a senior software engineer performing a bug audit on a codebase. You will be given the repository's file tree and README. Based on that context, identify potential bugs worth investigating. Return ONLY a newline-delimited list of concise bug titles (max 120 chars each). No numbering, no explanations, just one bug title per line. If you cannot identify any bugs, return the single word NONE.`;

/**
 * Uses AI to identify potential bugs in the repository.
 * Sends the repo file tree and README to Claude for analysis.
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

    const repoSummary = ctx.repoDir ? gatherRepoSummary(ctx.repoDir) : undefined;
    if (!repoSummary) {
      result.errors.push(`Repo directory not available for ${ctx.repoFullName} (repoId=${ctx.repoId}), skipping`);
      return result;
    }

    try {
      const prompt = `# Repository: ${ctx.repoFullName}\n\n${repoSummary}\n\nList up to 5 potential bugs worth investigating.`;

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
