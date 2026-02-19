import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolResultBlockParam, ToolUseBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

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
  /** Execute a tool call; return the string result (or throw to signal error). */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
  /** Called after each API round-trip (useful for heartbeats). */
  onTurnComplete?: (turn: number) => void;
}

export interface AgenticResponse {
  text: string;
  cost: CostMeta;
  turns: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_AGENTIC_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS = 30;

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

  const message = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    messages: [{ role: "user", content: req.prompt }],
  });

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
    cost: {
      model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}

/**
 * Multi-turn agentic loop: sends a message with tools, executes tool calls,
 * feeds results back, and repeats until Claude stops using tools or max turns hit.
 */
export async function callClaudeWithTools(req: AgenticRequest): Promise<AgenticResponse> {
  const model = req.model ?? DEFAULT_MODEL;
  const maxTokens = req.maxTokens ?? DEFAULT_AGENTIC_MAX_TOKENS;
  const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;
  let collectedText = "";

  const messages: MessageParam[] = [{ role: "user", content: req.prompt }];

  for (turns = 1; turns <= maxTurns; turns++) {
    const message = await getClient().messages.create({
      model,
      max_tokens: maxTokens,
      ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
      tools: req.tools,
      messages,
    });

    totalInputTokens += message.usage.input_tokens;
    totalOutputTokens += message.usage.output_tokens;

    // Collect any text blocks from this turn
    for (const block of message.content) {
      if (block.type === "text") {
        collectedText += block.text;
      }
    }

    // Push the full assistant response into conversation history
    messages.push({ role: "assistant", content: message.content });

    req.onTurnComplete?.(turns);

    // If stop reason is not tool_use, we're done
    if (message.stop_reason !== "tool_use") {
      break;
    }

    // Execute each tool_use block and build tool_result messages
    const toolUseBlocks = message.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      try {
        const result = await req.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: collectedText,
    cost: { model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    turns,
  };
}
