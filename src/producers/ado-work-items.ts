import { resolveGitCredentials } from "../execution/worktree.js";
import { createTaskWithDedup } from "./base.js";
import { queryWorkItems, getWorkItem, updateWorkItemTags } from "../integrations/azure-devops.js";
import logger from "../logger.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

interface AdoWorkItemsConfig {
  tag?: string;
  maxPerRun?: number;
}

const MAX_BODY_CHARS = 10_000;

/**
 * Polls Azure DevOps Work Items with a configurable tag and creates Hive tasks.
 *
 * No LLM calls — pure API polling. Zero cost per run (aside from
 * semantic dedup in createTaskWithDedup on first encounter).
 *
 * Config (per-repo `producers["ado-work-items"].config`):
 *   - tag: ADO tag to filter by (default: "hive")
 *   - maxPerRun: max work items to ingest per tick (default: 10)
 *
 * ADO PAT scope requirement: Work Items Read+Write (in addition to existing Code scope).
 */
export class AdoWorkItemsProducer implements Producer {
  name = "ado-work-items";
  needsRepo = false;
  intervalMs = 60_000; // 1 minute

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    // Only works with Azure DevOps repos
    if (ctx.provider && ctx.provider !== "azure_devops") {
      logger.debug(
        { repo: ctx.repoFullName, provider: ctx.provider },
        "ado-work-items: skipping non-ADO repo",
      );
      return result;
    }

    const config = (ctx.config ?? {}) as AdoWorkItemsConfig;
    const tag = config.tag ?? "hive";
    const maxPerRun = Math.min(config.maxPerRun ?? 10, 100);
    const source = `producer:${this.name}`;

    // Parse org/project/repo
    const parts = ctx.repoFullName.split("/");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      result.errors.push(
        `Invalid Azure DevOps repo format: "${ctx.repoFullName}" (expected org/project/repo)`,
      );
      return result;
    }
    const [org, project] = parts;

    // Resolve ADO PAT
    let pat: string;
    try {
      const creds = await resolveGitCredentials(ctx.createdBy, "azure_devops");
      pat = creds.token;
    } catch (err) {
      result.errors.push(
        `Failed to resolve Azure DevOps credentials: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    // Query work items tagged with the configured tag
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS '${tag}' AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' ORDER BY [System.CreatedDate] ASC`;

    let workItemIds: Array<{ id: number }>;
    try {
      workItemIds = await queryWorkItems(org, project, wiql, pat, maxPerRun);
    } catch (err) {
      result.errors.push(
        `WIQL query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    for (const { id } of workItemIds) {
      try {
        const wi = await getWorkItem(org, project, id, pat);
        const fields = wi.fields;

        const title = `[${fields["System.WorkItemType"]} #${id}] ${fields["System.Title"]}`;
        const rawBody = fields["System.Description"] ?? "";
        // Strip HTML tags from ADO description (basic sanitization)
        const plainBody = rawBody.replace(/<[^>]*>/g, "").trim();
        const body = [
          plainBody.slice(0, MAX_BODY_CHARS),
          "",
          "---",
          `_Source: Azure DevOps Work Item #${id} (${org}/${project})_`,
        ].join("\n");

        const { skipped } = await createTaskWithDedup({
          title,
          body,
          source,
          repoId: ctx.repoId,
          createdBy: ctx.createdBy,
          dryRun: ctx.dryRun,
        });

        if (skipped) {
          result.duplicatesSkipped++;
        } else {
          result.tasksCreated++;
        }

        // Swap tag so the work item isn't re-fetched on future ticks.
        // Run for duplicates too — items ingested before the tag-swap code
        // was deployed still carry the trigger tag.
        if (!ctx.dryRun) {
          await updateWorkItemTags(org, project, id, [`${tag}:grabbed`], [tag], pat);
        }
      } catch (err) {
        result.errors.push(
          `Failed to process work item #${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}

export const adoWorkItemsProducer = new AdoWorkItemsProducer();
export default adoWorkItemsProducer;
