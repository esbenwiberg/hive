import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the logger so tests don't produce output
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock @azure/identity so we don't need real credentials
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({ token: "mock-bearer-token" }),
  })),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { runKqlQuery } = await import(
  "../../src/integrations/azure-monitor.js"
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runKqlQuery", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("AZURE_MONITOR_WORKSPACE_ID", "test-workspace-id");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a well-formed response into an array of objects", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tables: [
          {
            columns: [
              { name: "TimeGenerated", type: "datetime" },
              { name: "Level", type: "string" },
              { name: "Message", type: "string" },
            ],
            rows: [
              ["2024-01-01T00:00:00Z", "Error", "Something failed"],
              ["2024-01-01T00:01:00Z", "Warning", "Something warned"],
            ],
          },
        ],
      }),
    });

    const result = await runKqlQuery(
      { workspaceId: "ws-123" },
      "AppEvents | take 10",
      "PT1H",
    );

    expect(result).toEqual([
      {
        TimeGenerated: "2024-01-01T00:00:00Z",
        Level: "Error",
        Message: "Something failed",
      },
      {
        TimeGenerated: "2024-01-01T00:01:00Z",
        Level: "Warning",
        Message: "Something warned",
      },
    ]);

    // Verify the fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://api.loganalytics.io/v1/workspaces/ws-123/query",
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers.Authorization).toBe("Bearer mock-bearer-token");

    const body = JSON.parse(opts.body);
    expect(body).toEqual({ query: "AppEvents | take 10", timespan: "PT1H" });
  });

  it("returns [] on HTTP error without throwing", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request: malformed KQL",
    });

    const result = await runKqlQuery(
      { workspaceId: "ws-123" },
      "INVALID QUERY",
    );

    expect(result).toEqual([]);
  });

  it("returns [] when AZURE_MONITOR_WORKSPACE_ID is not set", async () => {
    vi.stubEnv("AZURE_MONITOR_WORKSPACE_ID", "");

    const result = await runKqlQuery(
      { workspaceId: "ws-123" },
      "AppEvents | take 10",
    );

    expect(result).toEqual([]);
    // fetch should not have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns [] when response has empty tables", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tables: [] }),
    });

    const result = await runKqlQuery(
      { workspaceId: "ws-123" },
      "AppEvents | take 0",
    );

    expect(result).toEqual([]);
  });

  it("omits timespan from body when not provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tables: [
          {
            columns: [{ name: "Count", type: "long" }],
            rows: [[42]],
          },
        ],
      }),
    });

    await runKqlQuery({ workspaceId: "ws-123" }, "AppEvents | count");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ query: "AppEvents | count" });
    expect(body.timespan).toBeUndefined();
  });

  it("returns [] on network error without throwing", async () => {
    mockFetch.mockRejectedValue(new Error("Network unreachable"));

    const result = await runKqlQuery(
      { workspaceId: "ws-123" },
      "AppEvents | take 10",
    );

    expect(result).toEqual([]);
  });
});
