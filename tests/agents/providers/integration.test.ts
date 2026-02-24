/**
 * Integration tests — `createLlmClient` with a real mock HTTP server.
 *
 * These tests spin up a lightweight Node `http` server that mimics the Azure
 * AI Foundry OpenAI-compatible REST API.  They verify that `createLlmClient`
 * with an `azure-openai` provider:
 *
 *  1. Sends the request to the **correct URL path** (including the deployment
 *     name and `api-version` query parameter).
 *  2. Sets the **correct `api-key` header** with the configured key.
 *  3. **Parses the response** text and token-usage fields correctly.
 *  4. **Propagates errors** (non-2xx HTTP status) with a descriptive message.
 *
 * No network traffic leaves the machine — all I/O goes to 127.0.0.1 on a
 * random ephemeral port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect the full request body as a UTF-8 string. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Captured data from the last request the mock server received. */
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Start an HTTP server on an OS-assigned port.  Returns the server and its
 *  base URL.  The `handler` callback is invoked for each incoming request. */
function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      handler(req, res, body);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not determine server port"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });

    server.on("error", reject);
  });
}

/** Stop the server and wait for it to fully close. */
function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Azure OpenAI mock response ────────────────────────────────────────────────

function azureOpenAISuccessBody(text: string, model = "gpt-4o"): string {
  return JSON.stringify({
    model,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  });
}

// ── Import the real (non-mocked) createLlmClient ─────────────────────────────
//
// Vitest isolates module caches per test file.  Because this file does NOT
// call `vi.mock("@anthropic-ai/sdk", …)`, the real `createLlmClient` is
// loaded — but the `azure-openai` path never touches the SDK, it uses native
// `fetch`.  We only exercise the azure-openai path here.

const { createLlmClient } = await import(
  "../../../src/agents/providers/client.js"
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createLlmClient — azure-openai (integration: mock HTTP server)", () => {
  let server: Server;
  let baseUrl: string;

  // The last request captured by the mock server so each `it` can assert on it.
  let lastRequest: CapturedRequest | null = null;

  // The response the mock server will send for the current test.
  let mockStatus = 200;
  let mockResponseBody = "";

  beforeAll(async () => {
    const result = await startMockServer((req, res, body) => {
      lastRequest = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      };
      res.writeHead(mockStatus, { "Content-Type": "application/json" });
      res.end(mockResponseBody);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  // ── 1. Correct URL path ───────────────────────────────────────────────────

  it("sends the request to the correct Azure OpenAI deployment URL", async () => {
    mockStatus = 200;
    mockResponseBody = azureOpenAISuccessBody("hello integration");

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "test-api-key-url",
      model: "gpt-4o",
    });

    await client.sendMessage({
      messages: [{ role: "user", content: "ping" }],
    });

    expect(lastRequest).not.toBeNull();
    // Path must contain the deployment name
    expect(lastRequest!.url).toContain(
      "/openai/deployments/gpt-4o-deployment/chat/completions",
    );
    // Query string must carry an api-version parameter
    expect(lastRequest!.url).toMatch(/api-version=/);
  });

  // ── 2. Correct Authorization header ──────────────────────────────────────

  it("sends the api-key header with the configured key value", async () => {
    mockStatus = 200;
    mockResponseBody = azureOpenAISuccessBody("auth check");

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "super-secret-azure-key",
      model: "gpt-4o",
    });

    await client.sendMessage({
      messages: [{ role: "user", content: "auth test" }],
    });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.headers["api-key"]).toBe("super-secret-azure-key");
    // Must NOT send a Bearer token — Azure OpenAI uses api-key, not Bearer
    const authHeader = lastRequest!.headers["authorization"];
    expect(authHeader).toBeUndefined();
  });

  // ── 3. Request body is correct JSON ───────────────────────────────────────

  it("sends a well-formed JSON body with messages and max_tokens", async () => {
    mockStatus = 200;
    mockResponseBody = azureOpenAISuccessBody("body check");

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "key",
      model: "gpt-4o",
    });

    await client.sendMessage({
      messages: [{ role: "user", content: "body test" }],
      systemPrompt: "You are a helpful assistant.",
      maxTokens: 256,
    });

    expect(lastRequest).not.toBeNull();
    const body = JSON.parse(lastRequest!.body) as {
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };

    // System prompt is prepended as a system message
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    // User message follows
    expect(body.messages[1]).toEqual({ role: "user", content: "body test" });
    // Custom maxTokens respected
    expect(body.max_tokens).toBe(256);
    // Content-Type header must be application/json
    expect(lastRequest!.headers["content-type"]).toMatch(/application\/json/);
  });

  // ── 4. Response is parsed correctly ──────────────────────────────────────

  it("parses the response text and usage fields from the server reply", async () => {
    mockStatus = 200;
    mockResponseBody = azureOpenAISuccessBody("integration reply", "gpt-4o");

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "key",
      model: "gpt-4o",
    });

    const result = await client.sendMessage({
      messages: [{ role: "user", content: "parse test" }],
    });

    expect(result.text).toBe("integration reply");
    expect(result.model).toBe("gpt-4o");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usage.providerType).toBe("azure-openai");
    expect(result.usage.deploymentName).toBe("gpt-4o-deployment");
    expect(result.usage.endpoint).toBe(baseUrl);
  });

  // ── 5. Error propagation on non-2xx ──────────────────────────────────────

  it("throws a descriptive error when the server returns a non-2xx status", async () => {
    mockStatus = 401;
    mockResponseBody = JSON.stringify({ error: { message: "Unauthorised" } });

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "wrong-key",
      model: "gpt-4o",
    });

    await expect(
      client.sendMessage({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("Azure OpenAI request failed [401]");
  });

  // ── 6. Per-call model override ────────────────────────────────────────────

  it("uses the per-call model override in the request body", async () => {
    mockStatus = 200;
    mockResponseBody = azureOpenAISuccessBody("override check", "gpt-4.1");

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "key",
      model: "gpt-4o",                 // provider default
    });

    await client.sendMessage({
      messages: [{ role: "user", content: "override" }],
      model: "gpt-4.1",               // per-call override
    });

    const body = JSON.parse(lastRequest!.body) as { model: string };
    expect(body.model).toBe("gpt-4.1");
  });

  // ── 7. HTTP method is POST ────────────────────────────────────────────────

  it("uses HTTP POST for all requests", async () => {
    mockStatus = 200;
    mockResponseBody = azureOpenAISuccessBody("method check");

    const client = createLlmClient({
      type: "azure-openai",
      endpoint: baseUrl,
      deploymentName: "gpt-4o-deployment",
      apiKey: "key",
      model: "gpt-4o",
    });

    await client.sendMessage({
      messages: [{ role: "user", content: "method test" }],
    });

    expect(lastRequest!.method).toBe("POST");
  });
});
