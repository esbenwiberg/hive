/**
 * ModelProvider — discriminated union describing every LLM backend the system
 * can route to.  Each variant carries exactly the credentials / routing
 * information needed by the corresponding SDK wrapper in client.ts.
 */

/** Use Anthropic's public API directly (reads ANTHROPIC_API_KEY from env when
 *  apiKey is omitted). */
export interface AnthropicProvider {
  type: "anthropic";
  model: string;
  /** Optional override; falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
}

/** Use an Azure AI Foundry deployment that exposes the OpenAI-compatible
 *  /chat/completions endpoint (e.g. GPT-4o, GPT-4.1, o-series). */
export interface AzureOpenAIProvider {
  type: "azure-openai";
  endpoint: string;
  deploymentName: string;
  apiKey: string;
  model: string;
}

/** Use an Anthropic model deployed through Azure AI Foundry.  The Anthropic SDK
 *  is pointed at the Foundry base URL so the same message format is used. */
export interface AzureAnthropicProvider {
  type: "azure-anthropic";
  endpoint: string;
  deploymentName: string;
  apiKey: string;
  model: string;
}

export type ModelProvider =
  | AnthropicProvider
  | AzureOpenAIProvider
  | AzureAnthropicProvider;
