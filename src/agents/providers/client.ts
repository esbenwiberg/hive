/**
 * LLM client factory.
 *
 * `createLlmClient(provider)` returns a normalised `LlmClient` object whose
 * `sendMessage` method speaks the same interface regardless of the underlying
 * SDK/transport.  All three provider types are supported:
 *
 *  - `anthropic`       — Anthropic public API via `@anthropic-ai/sdk`
 *  - `azure-openai`    — Azure AI Foundry OpenAI-compatible endpoint (raw fetch)
 *  - `azure-anthropic` — Anthropic model hosted on Azure AI Foundry, via the
 *                        Anthropic SDK pointed at the Foundry base URL
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { ModelProvider } from "./types.js";

// ── Shared parameter / response types ───────────────────────────────────────

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmSendParams {
  messages: LlmMessage[];
  /** Override the provider's default model string (e.g. for per-call routing). */
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  /** Anthropic-style tools (forwarded as-is for Anthropic providers; ignored by
   *  azure-openai which uses its own function-calling format). */
  tools?: Tool[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface LlmResponse {
  /** The assistant's text reply. */
  text: string;
  /** The model identifier actually used (may differ from requested). */
  model: string;
  usage: LlmUsage;
  /** Raw response object from the underlying SDK, for provider-specific access. */
  raw: unknown;
}

export interface LlmClient {
  /** The resolved provider config this client wraps. */
  readonly provider: ModelProvider;
  sendMessage(params: LlmSendParams): Promise<LlmResponse>;
}

// ── Default token budget ─────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4096;

// ── Provider implementations ─────────────────────────────────────────────────

function buildAnthropicClient(
  provider: Extract<ModelProvider, { type: "anthropic" }>,
): LlmClient {
  const sdk = new Anthropic({
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
  });

  return {
    provider,
    async sendMessage(params) {
      const model = params.model ?? provider.model;
      const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

      const system = params.systemPrompt
        ? [
            {
              type: "text" as const,
              text: params.systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : undefined;

      const messages: MessageParam[] = params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await sdk.messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        ...(params.tools?.length ? { tools: params.tools } : {}),
        messages,
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const u = response.usage as unknown as Record<string, number>;
      return {
        text,
        model: response.model,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheCreationInputTokens: u.cache_creation_input_tokens || undefined,
          cacheReadInputTokens: u.cache_read_input_tokens || undefined,
        },
        raw: response,
      };
    },
  };
}

function buildAzureOpenAIClient(
  provider: Extract<ModelProvider, { type: "azure-openai" }>,
): LlmClient {
  return {
    provider,
    async sendMessage(params) {
      const model = params.model ?? provider.model;
      const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

      // Build the OpenAI-compatible messages array
      const messages: Array<{ role: string; content: string }> = [];
      if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
      }
      for (const m of params.messages) {
        messages.push({ role: m.role, content: m.content });
      }

      // Azure AI Foundry OpenAI-compatible endpoint:
      // POST {endpoint}/openai/deployments/{deploymentName}/chat/completions?api-version=...
      const url =
        `${provider.endpoint.replace(/\/$/, "")}/openai/deployments/` +
        `${provider.deploymentName}/chat/completions?api-version=2024-12-01-preview`;

      const body = JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
      });

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": provider.apiKey,
        },
        body,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `Azure OpenAI request failed [${res.status}]: ${errText}`,
        );
      }

      const json = (await res.json()) as {
        model: string;
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };

      const text = json.choices?.[0]?.message?.content ?? "";
      return {
        text,
        model: json.model ?? model,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
        raw: json,
      };
    },
  };
}

function buildAzureAnthropicClient(
  provider: Extract<ModelProvider, { type: "azure-anthropic" }>,
): LlmClient {
  // The Anthropic SDK supports Azure AI Foundry via a custom base URL + auth header.
  // See: https://docs.anthropic.com/en/api/azure
  const sdk = new Anthropic({
    apiKey: provider.apiKey,
    baseURL: `${provider.endpoint.replace(/\/$/, "")}/models/${provider.deploymentName}`,
    defaultHeaders: {
      "api-key": provider.apiKey,
    },
  });

  return {
    provider,
    async sendMessage(params) {
      const model = params.model ?? provider.model;
      const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

      const system = params.systemPrompt
        ? [
            {
              type: "text" as const,
              text: params.systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : undefined;

      const messages: MessageParam[] = params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await sdk.messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        ...(params.tools?.length ? { tools: params.tools } : {}),
        messages,
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const u = response.usage as unknown as Record<string, number>;
      return {
        text,
        model: response.model,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheCreationInputTokens: u.cache_creation_input_tokens || undefined,
          cacheReadInputTokens: u.cache_read_input_tokens || undefined,
        },
        raw: response,
      };
    },
  };
}

// ── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a normalised `LlmClient` for the given provider configuration.
 *
 * @example
 * ```ts
 * const client = createLlmClient({ type: 'anthropic', model: 'claude-sonnet-4-6' });
 * const { text, usage } = await client.sendMessage({ messages: [{ role: 'user', content: 'Hello' }] });
 * ```
 */
export function createLlmClient(provider: ModelProvider): LlmClient {
  switch (provider.type) {
    case "anthropic":
      return buildAnthropicClient(provider);
    case "azure-openai":
      return buildAzureOpenAIClient(provider);
    case "azure-anthropic":
      return buildAzureAnthropicClient(provider);
    default: {
      // Exhaustiveness check — TypeScript will catch missing cases at compile time
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider type: ${(_exhaustive as ModelProvider).type}`);
    }
  }
}
