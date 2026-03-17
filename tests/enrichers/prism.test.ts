import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskRow } from "../../src/db/schema.js";
import type { EnricherConfig } from "../../src/enrichers/base.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DUMMY_TASK = {
  id: 1,
  title: "Fix authentication bug",
  body: "The login flow breaks when using SSO tokens",
  repoId: 5,
} as unknown as TaskRow;

const DEFAULT_CONFIG: EnricherConfig = { enabled: true };

const ENV_BACKUP: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in ENV_BACKUP)) ENV_BACKUP[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear backup
  for (const key of Object.keys(ENV_BACKUP)) delete ENV_BACKUP[key];
}

/** Build a mock fetch that returns different responses per URL pattern */
function buildMockFetch(overrides: Record<string, unknown> = {}) {
  const searchResponse = overrides.search ?? {
    status: 200,
    ok: true,
    json: async () => ({
      relevantCode: [
        {
          embeddingId: 1,
          distance: 0.1,
          score: 0.9,
          summaryContent: "Handles user authentication flow",
          targetId: "src/auth/login.ts::handleLogin",
          level: "function",
          filePath: "src/auth/login.ts",
          symbolName: "handleLogin",
          symbolKind: "function",
        },
      ],
      moduleSummaries: [
        {
          targetId: "src/auth",
          content: "Authentication module handling SSO and local login",
        },
      ],
      findings: [
        {
          category: "coupling",
          severity: "high",
          title: "High coupling in auth module",
          description: "Auth module has too many dependencies",
          suggestion: "Consider extracting shared utilities",
        },
        {
          category: "dead-code",
          severity: "low",
          title: "Unused export",
          description: "legacyLogin is never imported",
          suggestion: null,
        },
      ],
    }),
  };

  const contextRelatedResponse = overrides.related ?? {
    status: 200,
    ok: true,
    json: async () => ({
      sections: [{ title: "auth/login.ts", content: "login code", tokens: 500 }],
      totalTokens: 500,
      truncated: false,
    }),
  };

  const contextArchResponse = overrides.arch ?? {
    status: 200,
    ok: true,
    json: async () => ({
      sections: [{ title: "Architecture", content: "modular auth", tokens: 300 }],
      totalTokens: 300,
      truncated: false,
    }),
  };

  const contextChangesResponse = overrides.changes ?? {
    status: 200,
    ok: true,
    json: async () => ({
      sections: [{ title: "Recent", content: "fixed SSO", tokens: 200 }],
      totalTokens: 200,
      truncated: false,
    }),
  };

  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/context/related")) return Promise.resolve(contextRelatedResponse);
    if (url.includes("/context/arch")) return Promise.resolve(contextArchResponse);
    if (url.includes("/context/changes")) return Promise.resolve(contextChangesResponse);
    if (url.includes("/search")) return Promise.resolve(searchResponse);
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

// ── Mock setup ──────────────────────────────────────────────────────────────

// Mock fetch so we never make real HTTP calls — each test re-stubs as needed
vi.stubGlobal("fetch", vi.fn());

const mockGetById = vi.fn();

vi.mock("../../src/db/queries/repos.js", () => ({
  getById: (...args: unknown[]) => mockGetById(...args),
}));

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => ({
    prism: {
      apiUrl: "",
      apiKey: "",
    },
  }),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("prismEnricher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv();
  });

  // We import fresh each time to pick up env changes
  async function getEnricher() {
    const mod = await import("../../src/enrichers/prism.js");
    return mod.prismEnricher;
  }

  it("has the correct name", async () => {
    const enricher = await getEnricher();
    expect(enricher.name).toBe("prism");
  });

  it("skips when PRISM_API_URL is not set", async () => {
    setEnv("PRISM_API_URL", undefined);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips when no Prism project found for repo path", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    // All endpoints return 404
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("skips when API call fails with non-404 error", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 500, ok: false }));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("returns full enrichment data on happy path with context", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    // Verify legacy structure
    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();

    const relevantCode = prism.relevantCode as unknown[];
    expect(relevantCode).toHaveLength(1);
    expect(relevantCode[0]).toMatchObject({
      targetId: "src/auth/login.ts::handleLogin",
      filePath: "src/auth/login.ts",
      score: 0.9,
    });

    const moduleSummaries = prism.moduleSummaries as unknown[];
    expect(moduleSummaries).toHaveLength(1);

    const findings = prism.findings as unknown[];
    expect(findings).toHaveLength(2);

    // Verify context structure
    const context = prism.context as Record<string, unknown>;
    expect(context).toBeDefined();
    expect(context.relatedFiles).toMatchObject({ totalTokens: 500, truncated: false });
    expect(context.architecture).toMatchObject({ totalTokens: 300, truncated: false });
    expect(context.recentChanges).toMatchObject({ totalTokens: 200, truncated: false });

    // Verify stats
    const stats = prism.stats as Record<string, number>;
    expect(stats.searchResults).toBe(1);
    expect(stats.summariesReturned).toBe(1);
    expect(stats.findingsReturned).toBe(2);
    expect(stats.contextEndpointsCalled).toBe(3);
    expect(stats.contextTotalTokens).toBe(1000);

    // Verify all 4 calls were made
    expect(mock).toHaveBeenCalledTimes(4);
    const urls = mock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls).toContain("http://localhost:4000/api/projects/org/repo/search");
    expect(urls).toContain("http://localhost:4000/api/projects/org/repo/context/related");
    expect(urls).toContain("http://localhost:4000/api/projects/org/repo/context/arch");
    expect(urls).toContain("http://localhost:4000/api/projects/org/repo/context/changes");
  });

  it("calls context endpoints with correct request bodies", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    // Find the context/related call and check its body
    const relatedCall = mock.mock.calls.find((c: unknown[]) => (c[0] as string).includes("/context/related"));
    expect(relatedCall).toBeDefined();
    const relatedBody = JSON.parse((relatedCall![1] as { body: string }).body);
    expect(relatedBody.intent).toContain("Fix authentication bug");
    expect(relatedBody.tokenBudget).toBe(8000);

    // Architecture uses title only
    const archCall = mock.mock.calls.find((c: unknown[]) => (c[0] as string).includes("/context/arch"));
    const archBody = JSON.parse((archCall![1] as { body: string }).body);
    expect(archBody.intent).toBe("Fix authentication bug");
    expect(archBody.tokenBudget).toBe(4000);

    // Changes uses title only
    const changesCall = mock.mock.calls.find((c: unknown[]) => (c[0] as string).includes("/context/changes"));
    const changesBody = JSON.parse((changesCall![1] as { body: string }).body);
    expect(changesBody.intent).toBe("Fix authentication bug");
    expect(changesBody.tokenBudget).toBe(4000);
  });

  it("handles partial context failure gracefully", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    // Architecture endpoint returns 500, others succeed
    const mock = buildMockFetch({
      arch: { status: 500, ok: false },
    });
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();

    const context = prism.context as Record<string, unknown>;
    expect(context.relatedFiles).not.toBeNull();
    expect(context.architecture).toBeNull(); // failed endpoint
    expect(context.recentChanges).not.toBeNull();

    // Stats still report 3 endpoints called
    const stats = prism.stats as Record<string, number>;
    expect(stats.contextEndpointsCalled).toBe(3);
    // Only successful tokens counted
    expect(stats.contextTotalTokens).toBe(700); // 500 + 0 + 200
  });

  it("skips context endpoints when slug has no slash", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({
      id: 5,
      fullName: "monorepo",
      settings: { prismSlug: "monorepo" },
    });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();

    // Only the search call should have been made
    expect(mock).toHaveBeenCalledTimes(1);
    expect((mock.mock.calls[0][0] as string)).toContain("/search");

    // Context should be all nulls
    const context = prism.context as Record<string, unknown>;
    expect(context.relatedFiles).toBeNull();
    expect(context.architecture).toBeNull();
    expect(context.recentChanges).toBeNull();

    const stats = prism.stats as Record<string, number>;
    expect(stats.contextEndpointsCalled).toBe(0);
    expect(stats.contextTotalTokens).toBe(0);
  });

  it("skips when API throws (network error)", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const networkError = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", networkError);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("returns enrichment data with empty results", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch({
      search: {
        status: 200,
        ok: true,
        json: async () => ({ relevantCode: [], moduleSummaries: [], findings: [] }),
      },
    });
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();
    expect(prism.stats).toBeDefined();
    expect(prism.context).toBeDefined();
  });

  it("sends PRISM_API_KEY as Authorization header when set", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    setEnv("PRISM_API_KEY", "secret-key");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    // All calls should have the auth header
    for (const call of mock.mock.calls) {
      expect((call[1] as { headers: Record<string, string> }).headers).toMatchObject({
        Authorization: "Bearer secret-key",
      });
    }
  });
});
