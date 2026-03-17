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
  for (const key of Object.keys(ENV_BACKUP)) delete ENV_BACKUP[key];
}

/** Build a mock fetch for the /context/enrich endpoint */
function buildMockFetch(overrides: { status?: number; ok?: boolean; body?: unknown } = {}) {
  const response = {
    status: overrides.status ?? 200,
    ok: overrides.ok ?? true,
    json: async () =>
      overrides.body ?? {
        sections: [
          { heading: "Purpose", priority: 1, content: "Auth module overview", tokenCount: 120 },
          { heading: "Relevant Code", priority: 2, content: "handleLogin in src/auth/login.ts", tokenCount: 850 },
          { heading: "Blast Radius", priority: 3, content: "Affects 3 downstream files", tokenCount: 210 },
        ],
        totalTokens: 1180,
        truncated: false,
      },
    text: async () => JSON.stringify(overrides.body ?? { error: "mock error" }),
  };

  return vi.fn().mockResolvedValue(response);
}

// ── Mock setup ──────────────────────────────────────────────────────────────

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

    expect(result.data).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips when project not found (404)", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    vi.stubGlobal("fetch", buildMockFetch({ status: 404, ok: false }));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("skips when API returns non-OK", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    vi.stubGlobal("fetch", buildMockFetch({ status: 500, ok: false }));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("returns sections on happy path", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();

    const sections = prism.sections as unknown[];
    expect(sections).toHaveLength(3);
    expect(prism.totalTokens).toBe(1180);
    expect(prism.truncated).toBe(false);

    const stats = prism.stats as Record<string, unknown>;
    expect(stats.sectionCount).toBe(3);
    expect(stats.totalTokens).toBe(1180);

    // Single call to /context/enrich
    expect(mock).toHaveBeenCalledTimes(1);
    expect((mock.mock.calls[0][0] as string)).toContain("/context/enrich");
  });

  it("sends correct request body", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const body = JSON.parse((mock.mock.calls[0][1] as { body: string }).body);
    expect(body.query).toContain("Fix authentication bug");
    expect(body.query).toContain("login flow breaks");
    expect(body.maxTokens).toBe(16000);
  });

  it("uses prismSlug from repo settings when available", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({
      id: 5,
      fullName: "org/repo",
      settings: { prismSlug: "custom/slug" },
    });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect((mock.mock.calls[0][0] as string)).toContain("/api/projects/custom/slug/context/enrich");
  });

  it("skips when network error occurs", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect(result.data).toEqual({});
  });

  it("handles empty sections gracefully", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    vi.stubGlobal("fetch", buildMockFetch({
      body: { sections: [], totalTokens: 0, truncated: false },
    }));

    const enricher = await getEnricher();
    const result = await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    const prism = result.data.prism as Record<string, unknown>;
    expect(prism).toBeDefined();
    expect(prism.sections).toEqual([]);
    expect(prism.totalTokens).toBe(0);
  });

  it("sends Authorization header when API key is set", async () => {
    setEnv("PRISM_API_URL", "http://localhost:4000");
    setEnv("PRISM_API_KEY", "secret-key");
    mockGetById.mockResolvedValue({ id: 5, fullName: "org/repo" });

    const mock = buildMockFetch();
    vi.stubGlobal("fetch", mock);

    const enricher = await getEnricher();
    await enricher.run(DUMMY_TASK, "/tmp/repo", {}, DEFAULT_CONFIG);

    expect((mock.mock.calls[0][1] as { headers: Record<string, string> }).headers).toMatchObject({
      Authorization: "Bearer secret-key",
    });
  });
});
