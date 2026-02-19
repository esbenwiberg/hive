import { callClaude } from "../agents/sdk.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate, isRefusalTitle, gatherRepoSummary } from "./base.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { loadPrompt } from "../prompt-cache.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Uses AI to identify potential security issues in the repository.
 * Sends the repo file tree and README to Claude for analysis.
 */
export class SecurityScannerProducer implements Producer {
  name = "security-scanner";
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
      const prompt = `# Repository: ${ctx.repoFullName}\n\n${repoSummary}\n\nList up to 5 potential security vulnerabilities worth investigating.`;

      const response = await callClaude({
        prompt,
        systemPrompt: loadPrompt("producers/security-scanner"),
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
              body: `Security finding identified by security-scanner producer for ${ctx.repoFullName}.`,
              source,
              type: "security",
              repoId: ctx.repoId,
              createdBy: ctx.createdBy,
            });
          }

          result.tasksCreated++;
        } catch (err) {
          result.errors.push(
            `Failed to create security task "${title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Security scanner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const securityScanner = new SecurityScannerProducer();
export default securityScanner;
