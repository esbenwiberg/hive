import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normaliseAnthropicUsage,
  normaliseOpenAIUsage,
} from "../../../src/db/queries/code-reviews.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// We capture the mock constructor so tests can assert on how it was called.
const mockMessagesCreate = vi.fn();
const MockAnthropic = vi.fn().mockImplementation(() => ({
  messages: { create: mockMessagesCreate },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: MockAnthropic,
}));

// Capture the global fetch so we can mock Azure OpenAI HTTP calls.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { createLlmClient } = await import(
  "../../../src/agents/providers/client.js"
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Anthropic SDK response shape. */
function fakeAnthropicResponse(text = "hello", model = "claude-haiku-4-5") {
  return {
    content: [{ type: "text", text }],
    model,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/** Build a minimal Azure OpenAI (fetch) response shape. */
function fakeAzureOpenAIResponse(text = "hi", model = "gpt-4o") {
  return {
    model,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createLlmClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── anthropic provider ─────────────────────────────────────────────────

  describe("anthropic provider", () => {
    it("constructs an Anthropic SDK instance without an explicit apiKey", () => {
      createLlmClient({ type: "anthropic", model: "claude-haiku-4-5" });
      expect(MockAnthropic).toHaveBeenCalledTimes(1);
      // The constructor should NOT receive an apiKey property when none is given
      const ctorArg = MockAnthropic.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg).not.toHaveProperty("apiKey");
    });

    it("passes an explicit apiKey to the Anthropic SDK constructor", () => {
      createLlmClient({
        type: "anthropic",
        model: "claude-haiku-4-5",
        apiKey: "sk-test-123",
      });
      const ctorArg = MockAnthropic.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg.apiKey).toBe("sk-test-123");
    });

    it("sendMessage calls sdk.messages.create with correct params", async () => {
      mockMessagesCreate.mockResolvedValue(fakeAnthropicResponse("pong"));
      const client = createLlmClient({
        type: "anthropic",
        model: "claude-haiku-4-5",
      });

      const result = await client.sendMessage({
        messages: [{ role: "user", content: "ping" }],
        systemPrompt: "You are helpful",
        maxTokens: 512,
      });

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const call = mockMessagesCreate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe("claude-haiku-4-5");
      expect(call.max_tokens).toBe(512);
      expect((call.messages as Array<{ role: string }>)[0].role).toBe("user");
      // system prompt should be set
      expect(call.system).toBeDefined();

      expect(result.text).toBe("pong");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });

    it("sendMessage allows per-call model override", async () => {
      mockMessagesCreate.mockResolvedValue(
        fakeAnthropicResponse("ok", "claude-opus-4-6"),
      );
      const client = createLlmClient({
        type: "anthropic",
        model: "claude-haiku-4-5",
      });

      await client.sendMessage({
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-6",
      });

      const call = mockMessagesCreate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(call.model).toBe("claude-opus-4-6");
    });

    it("exposes the provider config on the returned client", () => {
      const provider = { type: "anthropic" as const, model: "claude-haiku-4-5" };
      const client = createLlmClient(provider);
      expect(client.provider).toBe(provider);
    });
  });

  // ── azure-openai provider ──────────────────────────────────────────────

  describe("azure-openai provider", () => {
    const azureOpenAIProvider = {
      type: "azure-openai" as const,
      endpoint: "https://my-hub.openai.azure.com",
      deploymentName: "gpt-4o-deploy",
      apiKey: "az-key-abc",
      model: "gpt-4o",
    };

    it("does NOT instantiate the Anthropic SDK", () => {
      createLlmClient(azureOpenAIProvider);
      expect(MockAnthropic).not.toHaveBeenCalled();
    });

    it("sendMessage calls fetch with the correct Azure endpoint URL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => fakeAzureOpenAIResponse("world", "gpt-4o"),
      });

      const client = createLlmClient(azureOpenAIProvider);
      await client.sendMessage({
        messages: [{ role: "user", content: "hello" }],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];

      expect(url).toContain(
        "/openai/deployments/gpt-4o-deploy/chat/completions",
      );
      expect(url).toContain("api-version=");
      expect(options.method).toBe("POST");
      expect(options.headers["api-key"]).toBe("az-key-abc");
    });

    it("sendMessage injects a system message when systemPrompt is provided", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => fakeAzureOpenAIResponse("ok"),
      });

      const client = createLlmClient(azureOpenAIProvider);
      await client.sendMessage({
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "Be concise",
      });

      const body = JSON.parse(
        mockFetch.mock.calls[0][1].body as string,
      ) as { messages: Array<{ role: string; content: string }> };

      expect(body.messages[0]).toEqual({ role: "system", content: "Be concise" });
    });

    it("sendMessage returns parsed text and usage", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => fakeAzureOpenAIResponse("azure reply", "gpt-4o"),
      });

      const client = createLlmClient(azureOpenAIProvider);
      const result = await client.sendMessage({
        messages: [{ role: "user", content: "ping" }],
      });

      expect(result.text).toBe("azure reply");
      expect(result.model).toBe("gpt-4o");
      expect(result.usage.inputTokens).toBe(8);
      expect(result.usage.outputTokens).toBe(4);
    });

    it("throws a descriptive error when the fetch response is not ok", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorised",
      });

      const client = createLlmClient(azureOpenAIProvider);
      await expect(
        client.sendMessage({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow("Azure OpenAI request failed [401]");
    });

    it("exposes the provider config on the returned client", () => {
      const client = createLlmClient(azureOpenAIProvider);
      expect(client.provider).toBe(azureOpenAIProvider);
    });
  });

  // ── azure-anthropic provider ───────────────────────────────────────────

  describe("azure-anthropic provider", () => {
    const azureAnthropicProvider = {
      type: "azure-anthropic" as const,
      endpoint: "https://my-hub.services.ai.azure.com",
      deploymentName: "claude-haiku-4-5",
      apiKey: "az-ant-key",
      model: "claude-haiku-4-5",
    };

    it("constructs an Anthropic SDK instance with the Foundry base URL", () => {
      createLlmClient(azureAnthropicProvider);
      expect(MockAnthropic).toHaveBeenCalledTimes(1);
      const ctorArg = MockAnthropic.mock.calls[0][0] as Record<string, unknown>;
      expect(ctorArg.apiKey).toBe("az-ant-key");
      expect(ctorArg.baseURL).toContain(azureAnthropicProvider.endpoint);
      expect(ctorArg.baseURL).toContain(azureAnthropicProvider.deploymentName);
    });

    it("sendMessage calls sdk.messages.create (not fetch)", async () => {
      mockMessagesCreate.mockResolvedValue(
        fakeAnthropicResponse("azure-ant reply"),
      );

      const client = createLlmClient(azureAnthropicProvider);
      const result = await client.sendMessage({
        messages: [{ role: "user", content: "ping" }],
      });

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.text).toBe("azure-ant reply");
    });

    it("passes tools through to sdk.messages.create", async () => {
      mockMessagesCreate.mockResolvedValue(fakeAnthropicResponse("done"));

      const client = createLlmClient(azureAnthropicProvider);
      const tool = {
        name: "my_tool",
        description: "A test tool",
        input_schema: { type: "object" as const, properties: {} },
      };
      await client.sendMessage({
        messages: [{ role: "user", content: "use the tool" }],
        tools: [tool],
      });

      const call = mockMessagesCreate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect((call.tools as unknown[]).length).toBe(1);
    });

    it("exposes the provider config on the returned client", () => {
      const client = createLlmClient(azureAnthropicProvider);
      expect(client.provider).toBe(azureAnthropicProvider);
    });
  });

  // ── type exhaustiveness ────────────────────────────────────────────────

  it("throws for an unknown provider type at runtime", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createLlmClient({ type: "unknown-future-type" } as any),
    ).toThrow("Unknown provider type");
  });

  // ── usage normalisation (providerType metadata) ────────────────────────

  describe("anthropic sendMessage usage contains providerType", () => {
    it("returns providerType=anthropic in usage", async () => {
      mockMessagesCreate.mockResolvedValue(fakeAnthropicResponse("pong"));
      const client = createLlmClient({ type: "anthropic", model: "claude-haiku-4-5" });
      const result = await client.sendMessage({
        messages: [{ role: "user", content: "ping" }],
      });
      expect(result.usage.providerType).toBe("anthropic");
      expect(result.usage.endpoint).toBeUndefined();
      expect(result.usage.deploymentName).toBeUndefined();
    });
  });

  describe("azure-openai sendMessage usage contains providerType and deployment", () => {
    it("returns providerType=azure-openai with endpoint and deploymentName", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => fakeAzureOpenAIResponse("hi", "gpt-4o"),
      });
      const provider = {
        type: "azure-openai" as const,
        endpoint: "https://my-hub.openai.azure.com",
        deploymentName: "gpt-4o-deploy",
        apiKey: "az-key",
        model: "gpt-4o",
      };
      const client = createLlmClient(provider);
      const result = await client.sendMessage({
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.usage.providerType).toBe("azure-openai");
      expect(result.usage.endpoint).toBe("https://my-hub.openai.azure.com");
      expect(result.usage.deploymentName).toBe("gpt-4o-deploy");
      // OpenAI tokens mapped correctly
      expect(result.usage.inputTokens).toBe(8);
      expect(result.usage.outputTokens).toBe(4);
    });
  });

  describe("azure-anthropic sendMessage usage contains providerType and deployment", () => {
    it("returns providerType=azure-anthropic with endpoint and deploymentName", async () => {
      mockMessagesCreate.mockResolvedValue(fakeAnthropicResponse("ok"));
      const provider = {
        type: "azure-anthropic" as const,
        endpoint: "https://my-hub.services.ai.azure.com",
        deploymentName: "claude-haiku-4-5",
        apiKey: "az-ant-key",
        model: "claude-haiku-4-5",
      };
      const client = createLlmClient(provider);
      const result = await client.sendMessage({
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.usage.providerType).toBe("azure-anthropic");
      expect(result.usage.endpoint).toBe("https://my-hub.services.ai.azure.com");
      expect(result.usage.deploymentName).toBe("claude-haiku-4-5");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });
  });
});

// ── normaliseAnthropicUsage / normaliseOpenAIUsage ───────────────────────────

describe("normaliseAnthropicUsage", () => {
  const baseMeta = {
    providerType: "anthropic",
    model: "claude-haiku-4-5",
    agent: "worker",
  };

  it("maps input_tokens and output_tokens to the standard fields", () => {
    const record = normaliseAnthropicUsage(
      { input_tokens: 100, output_tokens: 50 },
      baseMeta,
    );
    expect(record.inputTokens).toBe(100);
    expect(record.outputTokens).toBe(50);
  });

  it("maps cache tokens when present", () => {
    const record = normaliseAnthropicUsage(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 10,
      },
      baseMeta,
    );
    expect(record.cacheCreationInputTokens).toBe(20);
    expect(record.cacheReadInputTokens).toBe(10);
  });

  it("leaves cache tokens undefined when zero", () => {
    const record = normaliseAnthropicUsage(
      { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      baseMeta,
    );
    expect(record.cacheCreationInputTokens).toBeUndefined();
    expect(record.cacheReadInputTokens).toBeUndefined();
  });

  it("defaults to 0 when tokens are missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = normaliseAnthropicUsage({} as any, baseMeta);
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(0);
  });

  it("preserves provider metadata on the record", () => {
    const record = normaliseAnthropicUsage(
      { input_tokens: 1, output_tokens: 1 },
      { ...baseMeta, endpoint: undefined, deploymentName: undefined },
    );
    expect(record.providerType).toBe("anthropic");
    expect(record.model).toBe("claude-haiku-4-5");
    expect(record.agent).toBe("worker");
  });
});

describe("normaliseOpenAIUsage", () => {
  const baseMeta = {
    providerType: "azure-openai",
    endpoint: "https://my-hub.openai.azure.com",
    deploymentName: "gpt-4o-deploy",
    model: "gpt-4o",
    agent: "worker",
  };

  it("maps prompt_tokens → inputTokens and completion_tokens → outputTokens", () => {
    const record = normaliseOpenAIUsage(
      { prompt_tokens: 200, completion_tokens: 80 },
      baseMeta,
    );
    expect(record.inputTokens).toBe(200);
    expect(record.outputTokens).toBe(80);
  });

  it("defaults to 0 when tokens are missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = normaliseOpenAIUsage({} as any, baseMeta);
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(0);
  });

  it("preserves provider metadata on the record", () => {
    const record = normaliseOpenAIUsage(
      { prompt_tokens: 10, completion_tokens: 5 },
      baseMeta,
    );
    expect(record.providerType).toBe("azure-openai");
    expect(record.endpoint).toBe("https://my-hub.openai.azure.com");
    expect(record.deploymentName).toBe("gpt-4o-deploy");
  });

  it("does not include cache token fields (OpenAI has no cache tokens)", () => {
    const record = normaliseOpenAIUsage(
      { prompt_tokens: 10, completion_tokens: 5 },
      baseMeta,
    );
    expect(record.cacheCreationInputTokens).toBeUndefined();
    expect(record.cacheReadInputTokens).toBeUndefined();
  });
});
