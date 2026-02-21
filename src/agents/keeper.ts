import logger from "../logger.js";
import { callClaude } from "./sdk.js";
import { getModelFor } from "../domain/autonomous-config.js";
import { estimateCostUsd } from "./cost-utils.js";
import { listLearnings, supersedeLearning, archiveStale, buildDismissedContext } from "../db/queries/learnings.js";
import { recordEvent } from "../db/queries/learning-events.js";
import { db } from "../db/connection.js";
import { learnings } from "../db/schema.js";
import { eq } from "drizzle-orm";

const KEEPER_SYSTEM_PROMPT = `You are a learning system curator. You maintain the quality of a knowledge base of learnings from past tasks.

Given a list of active learnings, identify:
1. **Duplicates** — learnings with very similar content that should be merged. Pick the one with higher confidence as the survivor.
2. **Stale** — learnings with very low confidence (<0.2), few reinforcements (<3), and no recent use. These should be archived.
3. **Scope promotions** — learnings scoped to a specific repo that have been reinforced enough (>=5 reinforcements, confidence >= 0.8) to be promoted to "universal" scope.

Respond with JSON:
\`\`\`json
{
  "duplicates": [{ "keepId": <number>, "removeIds": [<number>, ...] }],
  "archiveIds": [<number>, ...],
  "promotions": [{ "id": <number>, "newScope": "universal" }]
}
\`\`\`

Be conservative. Only flag clear duplicates, clearly stale entries, and well-reinforced candidates for promotion.
If nothing needs to change, return empty arrays for all fields.
Never propose un-archiving or promoting learnings that appear in the dismissed learnings list.`;

interface KeeperResult {
  duplicates: { keepId: number; removeIds: number[] }[];
  archiveIds: number[];
  promotions: { id: number; newScope: string }[];
}

function parseKeeperResult(text: string): KeeperResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned);

  return {
    duplicates: Array.isArray(parsed.duplicates) ? parsed.duplicates : [],
    archiveIds: Array.isArray(parsed.archiveIds) ? parsed.archiveIds : [],
    promotions: Array.isArray(parsed.promotions) ? parsed.promotions : [],
  };
}

/**
 * Curates the learning system: deduplicates, archives stale, promotes scope.
 * Called periodically by the daemon.
 */
export async function curateLearnings(): Promise<void> {
  const startTime = Date.now();
  const model = getModelFor("keeper");

  try {
    // Load learnings and filter out already-archived ones
    const { learnings: allLearnings } = await listLearnings({ limit: 200 });
    const activeLearnings = allLearnings.filter(l => l.supersededBy == null);

    if (activeLearnings.length === 0) {
      logger.info("Keeper: no active learnings to curate");
      return;
    }

    // Build a summary for Claude
    const learningsSummary = activeLearnings
      .map(
        (l) =>
          `[id:${l.id}] scope=${l.scope} category=${l.category} confidence=${l.confidence} reinforcements=${l.reinforcements} contradictions=${l.contradictions} lastUsed=${l.lastUsedAt?.toISOString() ?? "never"}\n  ${l.content}`,
      )
      .join("\n\n");

    const dismissedContext = await buildDismissedContext();

    const userPrompt = [
      `## Active Learnings (${activeLearnings.length} total)`,
      ``,
      learningsSummary,
      dismissedContext,
    ].join("\n");

    const response = await callClaude({
      prompt: userPrompt,
      model,
      systemPrompt: KEEPER_SYSTEM_PROMPT,
    });

    const costUsd = estimateCostUsd(response.cost.inputTokens, response.cost.outputTokens);
    const durationMs = Date.now() - startTime;

    const result = parseKeeperResult(response.text);

    // Apply duplicate supersessions
    for (const dup of result.duplicates) {
      for (const removeId of dup.removeIds) {
        await supersedeLearning(removeId, dup.keepId);
        await recordEvent({
          learningId: removeId,
          eventType: "superseded",
          evidence: `Superseded by learning ${dup.keepId} (duplicate detected by keeper)`,
        });
      }
    }

    // Archive stale learnings
    for (const id of result.archiveIds) {
      await supersedeLearning(id, -1); // -1 sentinel for self-archived
      await recordEvent({
        learningId: id,
        eventType: "archived",
        evidence: "Archived by keeper (stale)",
      });
    }

    // Also run the automated stale archival
    const autoArchived = await archiveStale();

    // Apply scope promotions
    for (const promo of result.promotions) {
      await db
        .update(learnings)
        .set({ scope: promo.newScope, updatedAt: new Date() })
        .where(eq(learnings.id, promo.id));
      await recordEvent({
        learningId: promo.id,
        eventType: "scope_promoted",
        evidence: `Scope promoted to ${promo.newScope} by keeper`,
      });
    }

    logger.info(
      {
        duplicatesMerged: result.duplicates.length,
        archived: result.archiveIds.length,
        autoArchived,
        promotions: result.promotions.length,
        costUsd,
        durationMs,
      },
      "Keeper curation complete",
    );
  } catch (err) {
    logger.error({ err }, "Keeper: curation failed");
  }
}
