import TurndownService from "turndown";
import { resolveGitCredentials } from "../execution/worktree.js";
import { createTaskWithDedup } from "./base.js";
import {
  queryWorkItems,
  getWorkItem,
  updateWorkItemTags,
  extractAttachments,
  downloadAttachment,
} from "../integrations/azure-devops.js";
import { updateEnrichment } from "../db/queries/tasks.js";
import logger from "../logger.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

interface AdoWorkItemsConfig {
  tag?: string;
  maxPerRun?: number;
  /** Custom field reference names to extract as acceptance criteria. */
  acceptanceCriteriaFields?: string[];
}

const MAX_BODY_CHARS = 10_000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5 MB per image

/** Well-known ADO fields that commonly hold acceptance criteria. */
const DEFAULT_AC_FIELDS = [
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Custom.AcceptanceCriteria",
  "Custom.DefinitionOfDone",
];

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"]);

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/**
 * Polls Azure DevOps Work Items with a configurable tag and creates Hive tasks.
 *
 * Extracts:
 * - Description (HTML → Markdown via turndown)
 * - Acceptance criteria from common custom fields
 * - Image attachments (downloaded as buffers for Claude vision input)
 *
 * Config (per-repo `producers["ado-work-items"].config`):
 *   - tag: ADO tag to filter by (default: "hive")
 *   - maxPerRun: max work items to ingest per tick (default: 10)
 *   - acceptanceCriteriaFields: custom field names for AC (default: common fields)
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
    const acFields = config.acceptanceCriteriaFields ?? DEFAULT_AC_FIELDS;
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

        // ── Description: HTML → Markdown ──────────────────────────────
        // Bug work items store the description in ReproSteps, not System.Description.
        const isBug = fields["System.WorkItemType"] === "Bug";
        const rawHtml =
          fields["System.Description"] ??
          (isBug ? (fields["Microsoft.VSTS.TCM.ReproSteps"] as string) : undefined) ??
          "";
        const description = rawHtml ? turndown.turndown(rawHtml).trim() : "";

        // ── Bug-specific: System Info ───────────────────────────────────
        const systemInfoHtml = isBug
          ? (fields["Microsoft.VSTS.TCM.SystemInfo"] as string | undefined)
          : undefined;
        const systemInfo = systemInfoHtml ? turndown.turndown(systemInfoHtml).trim() : "";

        // ── Acceptance Criteria from custom fields ────────────────────
        const acSections: string[] = [];
        for (const fieldName of acFields) {
          const rawAc = fields[fieldName];
          if (typeof rawAc === "string" && rawAc.trim()) {
            const acMd = turndown.turndown(rawAc).trim();
            if (acMd) {
              const label = fieldName.split(".").pop() ?? fieldName;
              acSections.push(`## ${label}\n\n${acMd}`);
            }
          }
        }

        // ── Build task body ───────────────────────────────────────────
        const bodyParts: string[] = [];
        if (description) bodyParts.push(description);
        if (systemInfo) bodyParts.push("## System Info\n\n" + systemInfo);
        if (acSections.length > 0) {
          bodyParts.push("---\n\n# Acceptance Criteria\n\n" + acSections.join("\n\n"));
        }
        bodyParts.push(
          "---",
          `_Source: Azure DevOps Work Item #${id} (${org}/${project})_`,
        );

        const body = bodyParts.join("\n\n").slice(0, MAX_BODY_CHARS);

        // ── Image attachments for vision input ────────────────────────
        const attachments = extractAttachments(wi);
        const imageAttachments = attachments.filter((a) => {
          const ext = "." + a.name.split(".").pop()?.toLowerCase();
          return IMAGE_EXTENSIONS.has(ext);
        });

        const images: Array<{ name: string; data: string; mediaType: string }> = [];
        for (const att of imageAttachments.slice(0, MAX_ATTACHMENTS)) {
          try {
            const { data, contentType } = await downloadAttachment(att.url, pat);
            if (data.length > MAX_ATTACHMENT_SIZE) {
              logger.warn({ workItemId: id, attachment: att.name, size: data.length }, "ado-work-items: skipping oversized attachment");
              continue;
            }
            images.push({
              name: att.name,
              data: data.toString("base64"),
              mediaType: contentType.startsWith("image/") ? contentType : "image/png",
            });
          } catch (dlErr) {
            logger.warn({ workItemId: id, attachment: att.name, err: dlErr }, "ado-work-items: failed to download attachment");
          }
        }

        const { skipped, task } = await createTaskWithDedup({
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

          // Store images in enrichment so the worker can pass them to Claude as vision input
          if (task && images.length > 0) {
            try {
              const existing = (task.enrichment as Record<string, unknown>) ?? {};
              await updateEnrichment(task.id, {
                ...existing,
                adoImages: images,
              });
              logger.info({ taskId: task.id, imageCount: images.length }, "ado-work-items: stored image attachments in enrichment");
            } catch (enrichErr) {
              logger.warn({ taskId: task.id, err: enrichErr }, "ado-work-items: failed to store image attachments");
            }
          }
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
