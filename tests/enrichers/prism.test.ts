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

// We mock @prism/core at the module level so the dynamic import() inside
// the enricher picks up our stubs.
const mockSetActiveConnectionString = vi.fn();
const mockGetProjectByPath = vi.fn();
const mockGetProjectBySlug = vi.fn();
const mockCreateEmbedder = vi.fn();
const mockSimpleSimilaritySearch = vi.fn();
const mockGetSummariesByLevel = vi.fn();
const mockGetFindingsByProjectId = vi.fn();

vi.mock("@prism/core", () => ({
  setActiveConnectionString: mockSetActiveConnectionString,
  getProjectByPath: mockGetProjectByPath,
  getProjectBySlug: mockGetProjectBySlug,
  createEmbedder: mockCreateEmbedder,
  simpleSimilaritySearch: mockSimpleSimilaritySearch,
  getSummariesByLevel: mockGetSummariesByLevel,
  getFindingsByProjectId: mockGetFindingsByProjectId,
}));

const mockGetById = vi.fn();

vi.mock("../../src/db/queries/repos.js", () => ({
  getById: (...args: unknown[]) => mockGetById(...args),
}));

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => ({
    prism: {
      databaseUrl: "",
      embeddingProvider: "azure-openai",
      embeddingModel: "text-embedding-3-large",
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

  it("skips when PRISM_DATABASE_URL is not set", async () => {
    setEnv("PRISM_DATABASE_URL", undefined);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data).toEqual({});
    expect(mockSetActiveConnectionString).not.toHaveBeenCalled();
  });

  it("skips when no Prism project found for repo path", async () => {
    setEnv("PRISM_DATABASE_URL", "postgres://localhost/prism");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockGetProjectBySlug.mockResolvedValue(undefined);
    mockGetProjectByPath.mockResolvedValue(undefined);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
    expect(mockSetActiveConnectionString).toHaveBeenCalledWith("postgres://localhost/prism");
    expect(mockGetProjectBySlug).toHaveBeenCalledWith("org/repo");
    expect(mockGetProjectByPath).toHaveBeenCalledWith("/tmp/repo");
  });

  it("skips when project is not indexed", async () => {
    setEnv("PRISM_DATABASE_URL", "postgres://localhost/prism");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockGetProjectBySlug.mockResolvedValue({
      id: 1,
      indexStatus: "pending",
    });

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("returns full enrichment data on happy path", async () => {
    setEnv("PRISM_DATABASE_URL", "postgres://localhost/prism");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockGetProjectBySlug.mockResolvedValue({
      id: 42,
      indexStatus: "completed",
    });

    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
    mockCreateEmbedder.mockReturnValue(mockEmbedder);

    mockSimpleSimilaritySearch.mockResolvedValue([
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
    ]);

    mockGetSummariesByLevel.mockResolvedValue([
      {
        targetId: "src/auth",
        content: "Authentication module handling SSO and local login",
      },
    ]);

    mockGetFindingsByProjectId.mockResolvedValue([
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
    ]);

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

    // Only high/critical/medium findings pass the filter
    const findings = prism.findings as unknown[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "high",
      title: "High coupling in auth module",
    });

    const stats = prism.stats as Record<string, unknown>;
    expect(stats.searchResults).toBe(1);
    expect(stats.summariesReturned).toBe(1);
    expect(stats.findingsReturned).toBe(1);
    expect(stats.semanticSearchFailed).toBeUndefined();

    // Verify embedder was created with config defaults
    expect(mockCreateEmbedder).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingProvider: "azure-openai",
        embeddingModel: "text-embedding-3-large",
      }),
    );

    // Verify query text includes title and body
    expect(mockEmbedder.embed).toHaveBeenCalledWith([
      "Fix authentication bug The login flow breaks when using SSO tokens",
    ]);
  });

  it("continues with summaries/findings when semantic search fails", async () => {
    setEnv("PRISM_DATABASE_URL", "postgres://localhost/prism");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockGetProjectBySlug.mockResolvedValue({
      id: 42,
      indexStatus: "completed",
    });

    // Embedder throws (e.g. no API key)
    mockCreateEmbedder.mockImplementation(() => {
      throw new Error("VOYAGE_API_KEY not set");
    });

    mockGetSummariesByLevel.mockResolvedValue([
      { targetId: "src/core", content: "Core module" },
    ]);

    mockGetFindingsByProjectId.mockResolvedValue([
      {
        category: "circular-dep",
        severity: "critical",
        title: "Circular dependency detected",
        description: "A -> B -> A",
        suggestion: "Break the cycle",
      },
    ]);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();

    // Semantic search failed but other sections populated
    expect((prism.relevantCode as unknown[]).length).toBe(0);
    expect((prism.moduleSummaries as unknown[]).length).toBe(1);
    expect((prism.findings as unknown[]).length).toBe(1);

    const stats = prism.stats as Record<string, unknown>;
    expect(stats.semanticSearchFailed).toBe(true);
  });

  it("works with partial index status", async () => {
    setEnv("PRISM_DATABASE_URL", "postgres://localhost/prism");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockGetProjectBySlug.mockResolvedValue({
      id: 10,
      indexStatus: "partial",
    });

    mockCreateEmbedder.mockReturnValue({
      embed: vi.fn().mockResolvedValue([[0.1]]),
    });
    mockSimpleSimilaritySearch.mockResolvedValue([]);
    mockGetSummariesByLevel.mockResolvedValue([]);
    mockGetFindingsByProjectId.mockResolvedValue([]);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    // Should not skip — partial is acceptable
    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();
    expect(prism.stats).toBeDefined();
  });

  it("respects custom embedding provider env vars", async () => {
    setEnv("PRISM_DATABASE_URL", "postgres://localhost/prism");
    setEnv("PRISM_EMBEDDING_PROVIDER", "openai");
    setEnv("PRISM_EMBEDDING_MODEL", "text-embedding-3-small");

    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });
    mockGetProjectBySlug.mockResolvedValue({
      id: 1,
      indexStatus: "completed",
    });

    mockCreateEmbedder.mockReturnValue({
      embed: vi.fn().mockResolvedValue([[0.1]]),
    });
    mockSimpleSimilaritySearch.mockResolvedValue([]);
    mockGetSummariesByLevel.mockResolvedValue([]);
    mockGetFindingsByProjectId.mockResolvedValue([]);

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(mockCreateEmbedder).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
      }),
    );
  });
});
