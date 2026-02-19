import { runKqlQuery } from "../integrations/azure-monitor.js";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import logger from "../logger.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

/**
 * Per-repo config expected in repo.settings.producers["log-scanner"].config:
 *
 *   workspaceId:      Azure Monitor workspace ID
 *   containerAppName: (optional) filter to a specific Container App
 */
interface LogScannerConfig {
  workspaceId?: string;
  containerAppName?: string;
}

function buildErrorPatternsKql(containerAppName?: string): string {
  const filter = containerAppName
    ? `| where ContainerAppName_s == "${containerAppName}"\n`
    : "";
  return `
ContainerAppConsoleLogs
| where TimeGenerated > ago(1h)
${filter}| extend parsed = parse_json(Log_s)
| where toint(parsed.level) >= 50
| extend msg = tostring(parsed.msg), err = tostring(parsed.err), taskId = tostring(parsed.taskId)
| summarize
    hitCount = count(),
    firstSeen = min(TimeGenerated),
    lastSeen = max(TimeGenerated),
    sampleErr = take_any(err),
    sampleTaskId = take_any(taskId)
  by msg
| where hitCount >= 2
| order by hitCount desc
| take 10
`;
}

function buildSystemIssuesKql(containerAppName?: string): string {
  const filter = containerAppName
    ? `| where ContainerAppName_s == "${containerAppName}"\n`
    : "";
  return `
ContainerAppSystemLogs
| where TimeGenerated > ago(1h)
${filter}| where Reason_s in ("OOMKilled", "CrashLoopBackOff", "BackOff", "ContainerRestart")
| summarize hitCount = count(), lastSeen = max(TimeGenerated) by Reason_s, ContainerName_s
| order by hitCount desc
`;
}

/**
 * Reads Azure Monitor logs (via KQL) to detect recurring errors, crashes,
 * and system-level issues for a specific repo's deployed application.
 *
 * Per-repo producer — requires `workspaceId` in the repo's log-scanner config.
 */
export class LogScannerProducer implements Producer {
  name = "log-scanner";

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0,
    };

    const cfg = (ctx.config ?? {}) as LogScannerConfig;
    const workspaceId = cfg.workspaceId ?? process.env.AZURE_MONITOR_WORKSPACE_ID;
    if (!workspaceId) {
      logger.debug(
        { repo: ctx.repoFullName },
        "Log-scanner: no workspaceId configured and AZURE_MONITOR_WORKSPACE_ID not set, skipping",
      );
      return result;
    }

    const config = { workspaceId };
    const source = `producer:${this.name}`;

    // ── Error patterns ──────────────────────────────────────────────────
    try {
      const rows = await runKqlQuery(
        config,
        buildErrorPatternsKql(cfg.containerAppName),
      );

      for (const row of rows) {
        const msg = String(row.msg ?? "").slice(0, 120);
        if (!msg) continue;

        const title = `Recurring error: ${msg}`;

        if (await isDuplicate(source, title)) {
          result.duplicatesSkipped++;
          continue;
        }

        const hitCount = Number(row.hitCount) || 0;
        const firstSeen = row.firstSeen ? String(row.firstSeen) : "unknown";
        const lastSeen = row.lastSeen ? String(row.lastSeen) : "unknown";
        const sampleErr = row.sampleErr ? String(row.sampleErr).slice(0, 1000) : null;
        const sampleTaskId = row.sampleTaskId ? String(row.sampleTaskId) : null;

        const body = [
          `Recurring error detected ${hitCount} times in the last hour in ${ctx.repoFullName}.`,
          `First seen: ${firstSeen}. Last seen: ${lastSeen}.`,
          sampleTaskId ? `Affected task: ${sampleTaskId}.` : null,
          ``,
          `## Error message`,
          `\`${msg}\``,
          sampleErr ? `\n## Stack / detail\n\`\`\`\n${sampleErr}\n\`\`\`` : null,
          ``,
          `## Investigation`,
          `Search the codebase for the error message to find the throw site. ` +
            `Check recent deployments for regressions. ` +
            `Review application logs around the timestamps above for surrounding context.`,
        ]
          .filter(Boolean)
          .join("\n");

        if (!ctx.dryRun) {
          await create({
            title,
            body,
            source,
            type: "bug",
            repoId: ctx.repoId,
            createdBy: ctx.createdBy,
          });
        }
        result.tasksCreated++;
      }
    } catch (err) {
      result.errors.push(
        `Error patterns query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── System issues (restarts, OOM) ───────────────────────────────────
    try {
      const rows = await runKqlQuery(
        config,
        buildSystemIssuesKql(cfg.containerAppName),
      );

      for (const row of rows) {
        const reason = String(row.Reason_s ?? "unknown");
        const container = String(row.ContainerName_s ?? "unknown");
        const title = `Container issue: ${reason} on ${container}`;

        if (await isDuplicate(source, title)) {
          result.duplicatesSkipped++;
          continue;
        }

        const hitCount = Number(row.hitCount) || 0;
        const lastSeen = row.lastSeen ? String(row.lastSeen) : "unknown";

        const body = [
          `Container "${container}" experienced ${reason} ${hitCount} time(s) in the last hour (${ctx.repoFullName}).`,
          `Last occurrence: ${lastSeen}.`,
          ``,
          `## Investigation`,
          reason === "OOMKilled"
            ? `The container ran out of memory. Check for memory leaks, large responses held in memory, ` +
              `or unbounded buffers. Consider increasing the container memory limit.`
            : `The container is crash-looping. Check application startup errors in ContainerAppConsoleLogs ` +
              `and verify environment variables and secrets are correctly configured.`,
        ].join("\n");

        if (!ctx.dryRun) {
          await create({
            title,
            body,
            source,
            type: "bug",
            repoId: ctx.repoId,
            createdBy: ctx.createdBy,
          });
        }
        result.tasksCreated++;
      }
    } catch (err) {
      result.errors.push(
        `System issues query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }
}

export const logScanner = new LogScannerProducer();
export default logScanner;
