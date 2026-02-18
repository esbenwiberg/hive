import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock logger
vi.mock("../../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock preview-logs
const mockAddPreviewLog = vi.fn().mockResolvedValue({});
vi.mock("../../../src/db/queries/preview-logs.js", () => ({
  addPreviewLog: (...args: unknown[]) => mockAddPreviewLog(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Import (after mocks) ─────────────────────────────────────────────────────

const { validatePreview } = await import(
  "../../../src/execution/preview/validator.js"
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("validatePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when health-check returns 200", async () => {
    mockFetch.mockResolvedValue({ status: 200, ok: true });

    const result = await validatePreview(
      "HIVE-001",
      "http://localhost:4001",
      "/health",
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2); // health + root
    expect(result.checks[0]).toEqual({
      endpoint: "http://localhost:4001/health",
      status: 200,
      passed: true,
      notes: "OK",
    });
    expect(result.checks[1]).toEqual({
      endpoint: "http://localhost:4001/",
      status: 200,
      passed: true,
      notes: "OK",
    });
  });

  it("fails when health-check returns non-200", async () => {
    mockFetch.mockResolvedValue({ status: 503, ok: false });

    const result = await validatePreview(
      "HIVE-002",
      "http://localhost:4002",
      "/health",
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].status).toBe(503);
    expect(result.checks[0].notes).toBe("Unexpected status 503");
  });

  it("fails when fetch throws (connection refused)", async () => {
    mockFetch.mockRejectedValue(new Error("fetch failed"));

    const result = await validatePreview(
      "HIVE-003",
      "http://localhost:4003",
      "/health",
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toEqual({
      endpoint: "http://localhost:4003/health",
      status: 0,
      passed: false,
      notes: "Request failed: fetch failed",
    });
  });

  it("skips root check when health-check path is '/'", async () => {
    mockFetch.mockResolvedValue({ status: 200, ok: true });

    const result = await validatePreview(
      "HIVE-004",
      "http://localhost:4004",
      "/",
    );

    expect(result.passed).toBe(true);
    // Only one check (root IS the health check)
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].endpoint).toBe("http://localhost:4004/");
  });

  it("logs validation passed to preview_logs", async () => {
    mockFetch.mockResolvedValue({ status: 200, ok: true });

    await validatePreview("HIVE-005", "http://localhost:4005", "/health");

    expect(mockAddPreviewLog).toHaveBeenCalledWith(
      "HIVE-005",
      "validator",
      expect.stringContaining("Validation passed"),
    );
  });

  it("logs validation failed to preview_logs", async () => {
    mockFetch.mockResolvedValue({ status: 500, ok: false });

    await validatePreview("HIVE-006", "http://localhost:4006", "/health");

    expect(mockAddPreviewLog).toHaveBeenCalledWith(
      "HIVE-006",
      "validator",
      expect.stringContaining("Validation failed"),
    );
  });

  it("handles mixed results (health OK, root fails)", async () => {
    // First call (health check) succeeds, second call (root) fails
    mockFetch
      .mockResolvedValueOnce({ status: 200, ok: true })
      .mockResolvedValueOnce({ status: 404, ok: false });

    const result = await validatePreview(
      "HIVE-007",
      "http://localhost:4007",
      "/health",
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].status).toBe(404);
  });
});
