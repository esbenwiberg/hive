import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolResultBlockParam, ToolUseBlock, MessageParam, TextBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import logger from "../logger.js";
import { getAutonomousConfig } from "../domain/autonomous-config.js";
import { getSecret } from "../vault/keyvault.js";

/** Rich tool result content — text blocks and/or image blocks (e.g. screenshots). */
export type ToolResultContent = Array<TextBlockParam | ImageBlockParam>;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SdkRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  dryRun?: boolean;
  /** Optional vision images to include alongside the prompt. */
  images?: ImageBlockParam[];
}

export interface CostMeta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface SdkResponse {
  text: string;
  cost: CostMeta;
}

/** Request for the multi-turn agentic loop. */
export interface AgenticRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  /** Optional vision images to include alongside the initial prompt. */
  images?: ImageBlockParam[];
  tools: Tool[];
  /** Execute a tool call; return the string result or rich content (or throw to signal error). */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string | ToolResultContent>;
  maxTurns?: number;
  /** Called after each API round-trip (useful for heartbeats). */
  onTurnComplete?: (turn: number) => void;
  /**
   * Called when Claude stops without tool_use. If it returns a non-null string,
   * that string is injected as a user message and the loop continues.
   * Useful for nudging Claude to actually call write_file when it only analyzed.
   */
  postCompletionNudge?: (context: { toolsCalled: string[]; turns: number }) => string | null;
  /** Max number of nudges before accepting Claude's stop (default: 1). */
  maxNudges?: number;
  /**
   * Called after tool results are processed each turn. If it returns a non-null
   * string, that text is appended to the tool-results user message as guidance.
   * Fires mid-loop (while Claude is still working), unlike postCompletionNudge
   * which only fires after Claude stops.
   */
  midLoopNudge?: (context: { toolsCalled: string[]; turns: number }) => string | null;
  /**
   * Called each turn BEFORE making the API call. If it returns a non-null string,
   * the loop breaks immediately and the string is set as terminationReason.
   * Use this as a hard kill switch (e.g. no writes by turn N).
   */
  shouldTerminate?: (context: { toolsCalled: string[]; turns: number }) => string | null | Promise<string | null>;
  /** Override context window limit (tokens). Falls back to global config if not set. */
  contextWindow?: number;
}

export interface AgenticResponse {
  text: string;
  cost: CostMeta;
  turns: number;
  terminationReason?: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_AGENTIC_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS = 30;
const MIN_OUTPUT_TOKENS = 4096;

/**
 * Extracts a JSON object or array from a raw LLM response that may contain
 * leading/trailing prose or markdown code fences.
 *
 * Strategy:
 *  1. Strip markdown code fences (```json ... ```).
 *  2. Walk the string to collect all top-level `{...}` blocks.
 *  3. Try each block last-to-first (Claude's final answer is usually last).
 *  4. If none of those parse, fall back to slicing from the first `{` / `[`
 *     to the last `}` / `]`.
 *  5. If still unparseable, throws a descriptive error with a snippet of the
 *     raw text for debuggability.
 */
export function extractJson(raw: string): unknown {
  // Strip markdown fences
  const cleaned = raw.replace(/```(?:json)?\s*\n?/g, "").trim();

  // Collect top-level {...} blocks
  const jsonBlocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        jsonBlocks.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // Try each block last-to-first
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(jsonBlocks[i]);
    } catch { /* try next */ }
  }

  // Fallback: slice from first { or [ to last } or ]
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  const firstStart =
    firstBrace === -1 ? firstBracket :
    firstBracket === -1 ? firstBrace :
    Math.min(firstBrace, firstBracket);

  if (firstStart !== -1) {
    const lastBrace = cleaned.lastIndexOf("}");
    const lastBracket = cleaned.lastIndexOf("]");
    const lastEnd = Math.max(lastBrace, lastBracket);
    if (lastEnd > firstStart) {
      try {
        return JSON.parse(cleaned.slice(firstStart, lastEnd + 1));
      } catch { /* fall through to error */ }
    }
  }

  const snippet = raw.slice(0, 120).replace(/\n/g, " ");
  throw new SyntaxError(`extractJson: no valid JSON found in LLM response. Raw snippet: "${snippet}"`);
}

/**
 * Parses the Anthropic context-limit 400 error.
 * Returns input token count and context limit, or null if unrelated error.
 *
 * Handles two known formats:
 *  - "input length ... exceed context limit: 12345 + 6789 > 200000"
 *  - "prompt is too long: 215128 tokens > 200000 maximum"
 */
function parseContextLimitError(
  err: unknown,
): { inputLength: number; contextLimit: number } | null {
  if (!(err instanceof Anthropic.BadRequestError)) return null;

  const match1 = /input length.*exceed context limit: (\d+) \+ \d+ > (\d+)/.exec(err.message);
  if (match1) {
    return { inputLength: parseInt(match1[1]), contextLimit: parseInt(match1[2]) };
  }

  const match2 = /prompt is too long: (\d+) tokens > (\d+) maximum/.exec(err.message);
  if (match2) {
    return { inputLength: parseInt(match2[1]), contextLimit: parseInt(match2[2]) };
  }

  return null;
}

/**
 * Truncates large tool_result blocks in older conversation messages to reclaim context.
 * Preserves the most recent `recentTurnCount * 2` messages (assistant+user pairs).
 * Returns true if any compaction was performed.
 */
function compactMessages(
  messages: MessageParam[],
  recentTurnCount: number = 3,
  maxChars: number = 200,
): boolean {
  const SUFFIX = "\n...[truncated]";
  let compacted = false;

  // Preserve the last N turn pairs (each turn = assistant + user message)
  const preserveCount = recentTurnCount * 2;
  const compactEnd = Math.max(0, messages.length - preserveCount);

  for (let i = 0; i < compactEnd; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const tb = block as ToolResultBlockParam;
      if (tb.type !== "tool_result") continue;
      if (typeof tb.content === "string" && tb.content.length > maxChars) {
        tb.content = tb.content.slice(0, maxChars) + SUFFIX;
        compacted = true;
      } else if (Array.isArray(tb.content)) {
        for (const sub of tb.content) {
          if (sub.type === "text" && sub.text.length > maxChars) {
            sub.text = sub.text.slice(0, maxChars) + SUFFIX;
            compacted = true;
          }
        }
      }
    }
  }
  return compacted;
}

/**
 * Drops the oldest assistant+user turn pairs from the conversation to shed tokens.
 * Always preserves message[0] (the initial user prompt) and the most recent turns.
 * Returns the number of messages removed.
 */
function dropOldTurns(messages: MessageParam[], turnsToDrop: number): number {
  // messages[0] = initial prompt. Turn pairs start at index 1: [assistant, user, assistant, user, ...]
  // Each turn pair is 2 messages. We must keep at least the initial prompt + the last turn pair.
  const maxDroppable = Math.floor((messages.length - 3) / 2); // -1 for initial, -2 for last pair
  const actualDrop = Math.min(turnsToDrop, Math.max(0, maxDroppable));
  if (actualDrop <= 0) return 0;

  const removeCount = actualDrop * 2;
  // Remove from index 1 (right after the initial user prompt)
  messages.splice(1, removeCount);
  return removeCount;
}

// ── Client (lazy singleton) ──────────────────────────────────────────────────

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    const { provider } = getAutonomousConfig();
    if (provider.active === "azure") {
      const apiKey = process.env.AZURE_AI_FOUNDRY_API_KEY;
      if (!apiKey) {
        throw new Error("AZURE_AI_FOUNDRY_API_KEY env var is required when Azure AI Foundry provider is active");
      }
      client = new Anthropic({ baseURL: provider.azure.endpointUrl, apiKey });
    } else {
      client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    }
  }
  return client;
}

/** Resets the cached SDK client so the next call to getClient() re-creates it. */
export function resetClient(): void {
  client = undefined;
}

/** Returns true if prompt caching is supported by the active provider. */
export function isCachingSupported(): boolean {
  const { provider } = getAutonomousConfig();
  return provider.active !== "azure";
}

/**
 * Loads API keys from Key Vault into process.env at startup.
 * Keys saved via the settings UI are persisted in Key Vault; this ensures
 * they're available after a container restart even if Bicep doesn't map them.
 * Existing env vars (from Bicep/deployment) take precedence.
 */
export async function hydrateApiKeysFromVault(): Promise<void> {
  const pairs: [string, string][] = [
    ["ANTHROPIC_API_KEY", "anthropic-api-key"],
    ["AZURE_AI_FOUNDRY_API_KEY", "azure-ai-foundry-api-key"],
  ];

  for (const [envVar, secretName] of pairs) {
    if (process.env[envVar]) continue; // already set via deployment
    try {
      const value = await getSecret(secretName);
      if (value) {
        process.env[envVar] = value;
        logger.info({ secretName }, "Hydrated API key from Key Vault");
      }
    } catch (err) {
      logger.warn({ secretName, err }, "Failed to hydrate API key from Key Vault — skipping");
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Thin wrapper around the Anthropic messages API.
 * Sends a single user message and returns the assistant text plus cost metadata.
 *
 * When `dryRun` is true the API is not called; a stub response is returned
 * instead, which is useful for testing pipeline wiring without spending tokens.
 */
export async function callClaude(req: SdkRequest): Promise<SdkResponse> {
  const model = req.model ?? DEFAULT_MODEL;
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (req.dryRun) {
    return {
      text: `[dry-run] prompt length=${req.prompt.length}`,
      cost: { model, inputTokens: 0, outputTokens: 0 },
    };
  }

  const caching = isCachingSupported();
  const system = req.systemPrompt
    ? [{ type: "text" as const, text: req.systemPrompt, ...(caching ? { cache_control: { type: "ephemeral" as const } } : {}) }]
    : undefined;

  const userContent = req.images?.length
    ? [{ type: "text" as const, text: req.prompt }, ...req.images]
    : req.prompt;

  const createParams = {
    model,
    ...(system ? { system } : {}),
    messages: [{ role: "user" as const, content: userContent }],
  };

  let message;
  try {
    message = await getClient().messages.create({ ...createParams, max_tokens: maxTokens });
  } catch (err) {
    const parsed = parseContextLimitError(err);
    if (!parsed) throw err;
    const reduced = parsed.contextLimit - parsed.inputLength - 100;
    if (reduced < MIN_OUTPUT_TOKENS) throw err;
    logger.warn({ requested: maxTokens, reduced, inputLength: parsed.inputLength }, "Reducing max_tokens to fit context window");
    message = await getClient().messages.create({ ...createParams, max_tokens: reduced });
  }

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const usage = message.usage as unknown as Record<string, number>;
  return {
    text,
    cost: {
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || undefined,
      cacheReadInputTokens: usage.cache_read_input_tokens || undefined,
    },
  };
}

/**
 * Multi-turn agentic loop: sends a message with tools, executes tool calls,
 * feeds results back, and repeats until Claude stops using tools or max turns hit.
 */
export async function callClaudeWithTools(req: AgenticRequest): Promise<AgenticResponse> {
  const model = req.model ?? DEFAULT_MODEL;
  let effectiveMaxTokens = req.maxTokens ?? DEFAULT_AGENTIC_MAX_TOKENS;
  const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let turns = 0;
  let collectedText = "";
  const toolsCalled: string[] = [];
  let nudgesUsed = 0;
  const maxNudges = req.maxNudges ?? 1;
  // Discovered context limit — updated if the API tells us the real cap (e.g. Foundry 200k)
  let discoveredContextLimit: number | undefined;

  const caching = isCachingSupported();
  const system = req.systemPrompt
    ? [{ type: "text" as const, text: req.systemPrompt, ...(caching ? { cache_control: { type: "ephemeral" as const } } : {}) }]
    : undefined;

  // Mark the last tool with cache_control so the entire system+tools prefix is cached
  const tools = caching
    ? req.tools.map((t, i) =>
        i === req.tools.length - 1
          ? { ...t, cache_control: { type: "ephemeral" as const } }
          : t,
      )
    : req.tools;

  const initialContent = req.images?.length
    ? [{ type: "text" as const, text: req.prompt }, ...req.images]
    : req.prompt;
  const messages: MessageParam[] = [{ role: "user", content: initialContent }];

  let terminationReason: string | undefined;

  for (turns = 1; turns <= maxTurns; turns++) {
    // Hard kill switch: check before spending tokens on the next API call
    if (req.shouldTerminate) {
      const reason = await req.shouldTerminate({ toolsCalled, turns });
      if (reason) {
        terminationReason = reason;
        logger.warn({ turn: turns, reason }, "Loop terminated by shouldTerminate callback");
        break;
      }
    }

    // Safety net: ensure no message has empty content before API call.
    // Catches edge cases (empty tool results, compaction artifacts, etc.)
    for (const msg of messages) {
      if (typeof msg.content === "string" && msg.content === "") {
        logger.warn({ turn: turns, role: msg.role }, "Patching empty string content in %s message", msg.role);
        (msg as { content: string }).content = "(empty)";
      } else if (Array.isArray(msg.content) && msg.content.length === 0) {
        logger.warn({ turn: turns, role: msg.role }, "Patching empty array content in %s message", msg.role);
        (msg as { content: unknown[] }).content = [{ type: "text", text: "(empty)" }];
      }
    }

    const createParams = {
      model,
      ...(system ? { system } : {}),
      tools,
      messages,
    };

    let message;
    try {
      message = await getClient().messages.create({ ...createParams, max_tokens: effectiveMaxTokens });
    } catch (err) {
      const parsed = parseContextLimitError(err);
      if (!parsed) throw err;

      // Learn the actual context limit from the API (e.g. Foundry may cap at 200k)
      discoveredContextLimit = parsed.contextLimit;

      const msgCount = messages.length;
      const toolResultCount = messages
        .filter((m) => m.role === "user" && Array.isArray(m.content))
        .reduce((sum, m) => sum + (m.content as unknown[]).length, 0);
      logger.error(
        { turn: turns, inputLength: parsed.inputLength, contextLimit: parsed.contextLimit, maxTokens: effectiveMaxTokens, msgCount, toolResultCount },
        "Context limit exceeded",
      );

      const reduced = parsed.contextLimit - parsed.inputLength - 100;
      if (reduced >= MIN_OUTPUT_TOKENS) {
        // Case 1: input fits but max_tokens was too generous — just shrink output
        logger.warn({ turn: turns, requested: effectiveMaxTokens, reduced }, "Reducing max_tokens to fit context window");
        effectiveMaxTokens = reduced;
        message = await getClient().messages.create({ ...createParams, max_tokens: effectiveMaxTokens });
      } else if (turns > 1) {
        // Case 2: input itself exceeds limit — need to shed tokens from conversation
        // First try truncating tool results
        const didCompact = compactMessages(messages, 1, 100);
        // Then progressively drop oldest turns until we fit
        const excess = parsed.inputLength - parsed.contextLimit + MIN_OUTPUT_TOKENS + 1000;
        // Rough estimate: each dropped turn pair ~= excess / (turns * 0.5) tokens
        // Start by dropping 1/3 of turns, retry, and escalate if needed
        const initialDrop = Math.max(1, Math.ceil(turns / 3));
        const dropped = dropOldTurns(messages, initialDrop);
        if (didCompact || dropped > 0) {
          logger.warn(
            { turn: turns, inputLength: parsed.inputLength, contextLimit: parsed.contextLimit, droppedMessages: dropped, didCompact, excess },
            "Emergency recovery: compacted + dropped old turns to fit context window",
          );
          // Also update our in-memory context limit so proactive compaction uses the real value
          effectiveMaxTokens = MIN_OUTPUT_TOKENS;
          message = await getClient().messages.create({ ...createParams, max_tokens: effectiveMaxTokens });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const turnUsage = message.usage as unknown as Record<string, number>;
    totalInputTokens += turnUsage.input_tokens;
    totalOutputTokens += turnUsage.output_tokens;
    totalCacheCreationTokens += turnUsage.cache_creation_input_tokens || 0;
    totalCacheReadTokens += turnUsage.cache_read_input_tokens || 0;

    // Collect any text blocks from this turn
    for (const block of message.content) {
      if (block.type === "text") {
        collectedText += block.text;
      }
    }

    // Push the full assistant response into conversation history
    messages.push({ role: "assistant", content: message.content });

    req.onTurnComplete?.(turns);

    // If stop reason is not tool_use, check for nudge or finish.
    // Guard: if the response contains tool_use blocks despite non-tool_use stop reason
    // (e.g. max_tokens truncation), strip them to avoid orphaned tool_use without tool_result.
    if (message.stop_reason !== "tool_use") {
      const hasToolUse = message.content.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        logger.warn({ turn: turns, stopReason: message.stop_reason }, "Stripping orphaned tool_use blocks (stop_reason was not tool_use)");
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
          lastMsg.content = lastMsg.content.filter((b) => b.type !== "tool_use");
          // If stripping left the assistant message empty, inject a placeholder so the
          // API never sees content: [] (which triggers "must have non-empty content").
          if (lastMsg.content.length === 0) {
            lastMsg.content = [{ type: "text", text: "(response truncated)" }];
          }
        }
      }
      if (req.postCompletionNudge && nudgesUsed < maxNudges) {
        const nudge = req.postCompletionNudge({ toolsCalled, turns });
        if (nudge) {
          nudgesUsed++;
          logger.info({ turn: turns, nudgesUsed }, "Nudging Claude to continue (no required tool call detected)");
          messages.push({ role: "user", content: nudge });
          continue;
        }
      }
      break;
    }

    // Execute each tool_use block and build tool_result messages
    const toolUseBlocks = message.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: ToolResultBlockParam[] = [];
    let toolResultChars = 0;
    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, unknown>;
      const inputSummary = input.path ?? input.command ?? input.file_path ?? toolUse.name;
      try {
        const result = await req.executeTool(toolUse.name, input);
        toolsCalled.push(toolUse.name); // Only track successful calls — failed edits shouldn't disable write nudges
        const resultLen = typeof result === "string" ? result.length : JSON.stringify(result).length;
        toolResultChars += resultLen;
        logger.debug({ turn: turns, tool: toolUse.name, input: inputSummary, resultLen }, "Tool call succeeded");
        // Guard empty results: empty strings are falsy, but empty arrays [] are truthy
        const safeContent = typeof result === "string"
          ? (result || "(empty)")
          : (Array.isArray(result) && result.length === 0 ? "(empty)" : result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: safeContent,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.debug({ turn: turns, tool: toolUse.name, input: inputSummary, error: errorMsg }, "Tool call failed");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: errorMsg || "(error)",
          is_error: true,
        });
      }
    }

    // Guard: never push an empty user message — API rejects content: []
    // This can happen if stop_reason is "tool_use" but content has no tool_use blocks
    if (toolResults.length === 0) {
      logger.warn({ turn: turns, stopReason: message.stop_reason }, "No tool results despite tool_use stop reason — breaking loop");
      break;
    }
    messages.push({ role: "user", content: toolResults });

    // Mid-loop nudge: append guidance to the tool-results message while Claude
    // is still in its tool-calling phase (before it decides to stop).
    if (req.midLoopNudge) {
      const nudge = req.midLoopNudge({ toolsCalled, turns });
      if (nudge) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
          (lastMsg.content as unknown[]).push({ type: "text" as const, text: nudge });
        }
        logger.info({ turn: turns }, "Mid-loop nudge injected");
      }
    }

    // Proactive compaction: after N turns, compact older tool results
    const execConfig = getAutonomousConfig().execution;
    if (turns >= execConfig.compactionStartTurn && compactMessages(messages, 3, execConfig.compactionMaxChars)) {
      logger.debug({ turn: turns }, "Proactively compacted old tool results");
    }

    // Proactively shrink max_tokens for next turn as context fills up.
    // Estimate: this turn's input + output + tool result chars (÷4 for tokens).
    // Use discovered limit (from API error) if lower than config — handles Foundry/proxy caps.
    const toolResultTokens = Math.ceil(toolResultChars / 4);
    const estimatedNextInput = turnUsage.input_tokens + turnUsage.output_tokens + toolResultTokens;
    const configContextLimit = req.contextWindow ?? getAutonomousConfig().execution.contextWindow;
    const contextLimit = discoveredContextLimit
      ? Math.min(discoveredContextLimit, configContextLimit)
      : configContextLimit;
    if (estimatedNextInput + effectiveMaxTokens > contextLimit) {
      effectiveMaxTokens = Math.max(MIN_OUTPUT_TOKENS, contextLimit - estimatedNextInput - 1000);
    }

    // Emergency compaction: if even MIN_OUTPUT_TOKENS won't fit, compact + drop old turns
    if (estimatedNextInput + MIN_OUTPUT_TOKENS > contextLimit) {
      compactMessages(messages, 1, 100);
      const dropped = dropOldTurns(messages, Math.max(1, Math.ceil(turns / 4)));
      if (dropped > 0) {
        logger.warn({ turn: turns, estimatedNextInput, contextLimit, droppedMessages: dropped }, "Emergency compaction — dropped old turns to fit context window");
      } else {
        logger.warn({ turn: turns, estimatedNextInput, contextLimit }, "Emergency compaction — conversation near context limit");
      }
      effectiveMaxTokens = MIN_OUTPUT_TOKENS;
    }
  }

  return {
    text: collectedText,
    cost: {
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreationTokens || undefined,
      cacheReadInputTokens: totalCacheReadTokens || undefined,
    },
    turns,
    terminationReason,
  };
}
