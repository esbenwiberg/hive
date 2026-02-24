import { eq, desc, sum, sql } from "drizzle-orm";
import { db } from "../connection.js";
import { codeReviews, llmUsage } from "../schema.js";
import type { LlmUsageRow } from "../schema.js";

// ── UsageRecord — normalised token/provider metadata ─────────────────────────

/**
 * Normalised usage record produced by any `LlmClient.sendMessage` call.
 *
 * Anthropic responses expose `input_tokens` / `output_tokens`.
 * Azure AI Foundry (OpenAI-compatible) responses expose `prompt_tokens` /
 * `completion_tokens`.  Both shapes are mapped to this common interface so the
 * rest of the application never has to branch on provider type.
 */
export interface UsageRecord {
  /** 'anthropic' | 'azure-openai' | 'azure-anthropic' */
  providerType: string;
  /** Azure AI Foundry endpoint URL; undefined for direct Anthropic. */
  endpoint?: string;
  /** Azure deployment name; undefined for direct Anthropic. */
  deploymentName?: string;
  model: string;
  agent: string;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Estimated cost in USD (0 when per-token pricing is not configured). */
  costUsd?: number;
}

/**
 * Normalise raw usage from an Anthropic API response into a `UsageRecord`.
 * Anthropic usage fields: `input_tokens`, `output_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`.
 */
export function normaliseAnthropicUsage(
  raw: Record<string, number>,
  meta: Omit<UsageRecord, "inputTokens" | "outputTokens">,
): UsageRecord {
  return {
    ...meta,
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheCreationInputTokens: raw.cache_creation_input_tokens || undefined,
    cacheReadInputTokens: raw.cache_read_input_tokens || undefined,
  };
}

/**
 * Normalise raw usage from an OpenAI-compatible API response (Azure AI Foundry)
 * into a `UsageRecord`.
 * OpenAI usage fields: `prompt_tokens`, `completion_tokens`.
 */
export function normaliseOpenAIUsage(
  raw: Record<string, number>,
  meta: Omit<UsageRecord, "inputTokens" | "outputTokens">,
): UsageRecord {
  return {
    ...meta,
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
  };
}

/**
 * Persist a normalised `UsageRecord` to the `llm_usage` table.
 * Returns the inserted row.
 */
export async function recordLlmUsage(usage: UsageRecord) {
  const [row] = await db
    .insert(llmUsage)
    .values({
      taskId: usage.taskId ?? null,
      agent: usage.agent,
      model: usage.model,
      providerType: usage.providerType,
      endpoint: usage.endpoint ?? null,
      deploymentName: usage.deploymentName ?? null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
      costUsd: (usage.costUsd ?? 0).toFixed(6),
    })
    .returning();
  return row;
}

/**
 * Records a code review result for a task.
 */
export async function recordReview(
  taskId: string,
  verdict: string,
  reworkCycle: number,
  findings?: unknown,
  securityFindings?: unknown,
  verification?: unknown,
  costUsd?: number,
) {
  const [row] = await db
    .insert(codeReviews)
    .values({
      taskId,
      verdict,
      reworkCycle,
      findings: findings ?? null,
      securityFindings: securityFindings ?? null,
      verification: verification ?? null,
      costUsd: costUsd?.toFixed(4) ?? null,
    })
    .returning();

  return row;
}

/**
 * Returns all code reviews for a task, most recent first.
 */
export async function listByTask(taskId: string) {
  return db
    .select()
    .from(codeReviews)
    .where(eq(codeReviews.taskId, taskId))
    .orderBy(desc(codeReviews.createdAt));
}

/**
 * Returns the most recent code review for a task, or undefined.
 */
export async function getLatestByTask(taskId: string) {
  const [row] = await db
    .select()
    .from(codeReviews)
    .where(eq(codeReviews.taskId, taskId))
    .orderBy(desc(codeReviews.createdAt))
    .limit(1);

  return row;
}

// ── LLM usage queries ──────────────────────────────────────────

/**
 * Returns all `llm_usage` rows for a given task, most recent first.
 * Useful for the dashboard's per-task cost breakdown.
 */
export async function listLlmUsageByTask(taskId: string): Promise<LlmUsageRow[]> {
  return db
    .select()
    .from(llmUsage)
    .where(eq(llmUsage.taskId, taskId))
    .orderBy(desc(llmUsage.createdAt));
}

/**
 * Returns total cost and token counts grouped by provider type for a task.
 * Azure providers (azure-openai, azure-anthropic) will have cost_usd = 0
 * unless per-token pricing has been configured.
 */
export async function aggregateLlmUsageByProvider(taskId: string) {
  return db
    .select({
      providerType: llmUsage.providerType,
      deploymentName: llmUsage.deploymentName,
      endpoint: llmUsage.endpoint,
      totalInputTokens: sql<number>`cast(${sum(llmUsage.inputTokens)} as integer)`,
      totalOutputTokens: sql<number>`cast(${sum(llmUsage.outputTokens)} as integer)`,
      totalCostUsd: sum(llmUsage.costUsd),
      callCount: sql<number>`cast(count(*) as integer)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.taskId, taskId))
    .groupBy(llmUsage.providerType, llmUsage.deploymentName, llmUsage.endpoint);
}
