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

// ── Mock setup ──────────────────────────────────────────────────────────────

// Mock fetch so we never make real HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips when no Prism project found for repo path", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockFetch.mockResolvedValue({ status: 404, ok: false });

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/org%2Frepo/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("skips when API call fails with non-404 error", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockFetch.mockResolvedValue({ status: 500, ok: false });

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("returns full enrichment data on happy path", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockFetch.mockResolvedValue({
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
    });

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    // Verify structure
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
    expect(moduleSummaries[0]).toMatchObject({
      targetId: "src/auth",
      content: "Authentication module handling SSO and local login",
    });

    // All findings returned (no severity filter — handled server-side)
    const findings = prism.findings as unknown[];
    expect(findings).toHaveLength(2);

    const stats = prism.stats as Record<string, unknown>;
    expect(stats.searchResults).toBe(1);
    expect(stats.summariesReturned).toBe(1);
    expect(stats.findingsReturned).toBe(2);

    // Verify query text includes title and body
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/org%2Frepo/search",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Fix authentication bug"),
      }),
    );
  });

  it("skips when API throws (network error)", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockFetch.mockRejectedValue(new Error("Network error"));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("returns enrichment data with empty results", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ relevantCode: [], moduleSummaries: [], findings: [] }),
    });

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();
    expect(prism.stats).toBeDefined();
  });

  it("sends PRISM_API_KEY as Authorization header when set", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    setEnv("PRISM_API_KEY", "secret-key");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ relevantCode: [], moduleSummaries: [], findings: [] }),
    });

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-key",
        }),
      }),
    );
  });
});
