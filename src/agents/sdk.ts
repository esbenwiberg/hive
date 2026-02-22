import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolResultBlockParam, ToolUseBlock, MessageParam, TextBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import logger from "../logger.js";

/** Rich tool result content — text blocks and/or image blocks (e.g. screenshots). */
export type ToolResultContent = Array<TextBlockParam | ImageBlockParam>;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SdkRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  dryRun?: boolean;
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
}

export interface AgenticResponse {
  text: string;
  cost: CostMeta;
  turns: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_AGENTIC_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS = 30;
const MIN_OUTPUT_TOKENS = 4096;

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

// ── Client (lazy singleton) ──────────────────────────────────────────────────

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return client;
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

  const system = req.systemPrompt
    ? [{ type: "text" as const, text: req.systemPrompt, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  const createParams = {
    model,
    ...(system ? { system } : {}),
    messages: [{ role: "user" as const, content: req.prompt }],
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

  const system = req.systemPrompt
    ? [{ type: "text" as const, text: req.systemPrompt, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  // Mark the last tool with cache_control so the entire system+tools prefix is cached
  const tools = req.tools.map((t, i) =>
    i === req.tools.length - 1
      ? { ...t, cache_control: { type: "ephemeral" as const } }
      : t,
  );

  const messages: MessageParam[] = [{ role: "user", content: req.prompt }];

  for (turns = 1; turns <= maxTurns; turns++) {
    const createParams = {
      model,
      ...(system ? { system } : {}),
      tools,
      messages,
      cache_control: { type: "ephemeral" as const },
    };

    let message;
    try {
      message = await getClient().messages.create({ ...createParams, max_tokens: effectiveMaxTokens });
    } catch (err) {
      const parsed = parseContextLimitError(err);
      if (!parsed) throw err;

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
        logger.warn({ turn: turns, requested: effectiveMaxTokens, reduced }, "Reducing max_tokens to fit context window");
        effectiveMaxTokens = reduced;
        message = await getClient().messages.create({ ...createParams, max_tokens: effectiveMaxTokens });
      } else if (turns > 1 && compactMessages(messages)) {
        logger.warn({ turn: turns, inputLength: parsed.inputLength, contextLimit: parsed.contextLimit }, "Compacting conversation to fit context window");
        effectiveMaxTokens = MIN_OUTPUT_TOKENS;
        message = await getClient().messages.create({ ...createParams, max_tokens: effectiveMaxTokens });
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

    // If stop reason is not tool_use, check for nudge or finish
    if (message.stop_reason !== "tool_use") {
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
      toolsCalled.push(toolUse.name);
      const input = toolUse.input as Record<string, unknown>;
      const inputSummary = input.path ?? input.command ?? input.file_path ?? toolUse.name;
      try {
        const result = await req.executeTool(toolUse.name, input);
        const resultLen = typeof result === "string" ? result.length : JSON.stringify(result).length;
        toolResultChars += resultLen;
        logger.debug({ turn: turns, tool: toolUse.name, input: inputSummary, resultLen }, "Tool call succeeded");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.debug({ turn: turns, tool: toolUse.name, input: inputSummary, error: errorMsg }, "Tool call failed");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: errorMsg,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    // Proactive compaction: after 4+ turns, compact older tool results
    if (turns >= 4 && compactMessages(messages)) {
      logger.debug({ turn: turns }, "Proactively compacted old tool results");
    }

    // Proactively shrink max_tokens for next turn as context fills up.
    // Estimate: this turn's input + output + tool result chars (÷4 for tokens).
    const toolResultTokens = Math.ceil(toolResultChars / 4);
    const estimatedNextInput = turnUsage.input_tokens + turnUsage.output_tokens + toolResultTokens;
    const contextLimit = 200_000;
    if (estimatedNextInput + effectiveMaxTokens > contextLimit) {
      effectiveMaxTokens = Math.max(MIN_OUTPUT_TOKENS, contextLimit - estimatedNextInput - 1000);
    }

    // Emergency compaction: if even MIN_OUTPUT_TOKENS won't fit, compact aggressively
    if (estimatedNextInput + MIN_OUTPUT_TOKENS > contextLimit) {
      if (compactMessages(messages, 1, 100)) {
        logger.warn({ turn: turns, estimatedNextInput, contextLimit }, "Emergency compaction — conversation near context limit");
        effectiveMaxTokens = MIN_OUTPUT_TOKENS;
      }
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
  };
}
