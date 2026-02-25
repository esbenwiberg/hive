import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks must be set up before importing the module under test ───────────────

vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getModelFor: vi.fn(() => "claude-3-5-haiku-20241022"),
}));

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
  extractJson: vi.fn(),
}));

import { runAdvisor, type AdvisorContext } from "../../src/agents/advisor.js";
import { callClaude, extractJson } from "../../src/agents/sdk.js";

const mockedCallClaude = vi.mocked(callClaude);
const mockedExtractJson = vi.mocked(extractJson);

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseContext: AdvisorContext = {
  title: "Add dark mode toggle",
  body: "Users have requested a dark mode toggle in the settings page.",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAdvisor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Fallback / error paths ─────────────────────────────────────────────────

  it("returns escalate=true fallback when JSON parsing fails", async () => {
    mockedCallClaude.mockResolvedValueOnce({
      text: "This is not valid JSON at all.",
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 10, outputTokens: 10, totalCostUsd: 0.001 },
    } as any);

    // extractJson throws to simulate a parse failure
    mockedExtractJson.mockImplementationOnce(() => {
      throw new SyntaxError("Unexpected token T in JSON");
    });

    const report = await runAdvisor(baseContext);

    expect(report.escalate).toBe(true);
    expect(report.confidence).toBe(0);
    expect(report.score).toBe(0);
    expect(report.recommendation).toBe("reject");
    expect(report.reasoning).toMatch(/Failed to parse advisor output/i);
    expect(Array.isArray(report.flags)).toBe(true);
  });

  it("returns escalate=true fallback when extracted JSON has missing required fields", async () => {
    mockedCallClaude.mockResolvedValueOnce({
      text: '{"recommendation":"approve"}',
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 10, outputTokens: 10, totalCostUsd: 0.001 },
    } as any);

    // extractJson returns a partial object — missing score, confidence, reasoning
    mockedExtractJson.mockReturnValueOnce({ recommendation: "approve" });

    const report = await runAdvisor(baseContext);

    expect(report.escalate).toBe(true);
    expect(report.score).toBe(0);
    expect(report.confidence).toBe(0);
  });

  it("returns escalate=true fallback when callClaude throws", async () => {
    mockedCallClaude.mockRejectedValueOnce(new Error("Network error"));

    const report = await runAdvisor(baseContext);

    expect(report.escalate).toBe(true);
    expect(report.confidence).toBe(0);
    expect(report.reasoning).toMatch(/Advisor LLM call failed/i);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns a valid approve report on successful LLM response", async () => {
    const llmReport = {
      recommendation: "approve",
      score: 85,
      confidence: 90,
      reasoning: "This task fits well with the existing UI patterns.",
      flags: [],
      escalate: false,
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    const report = await runAdvisor(baseContext);

    expect(report.recommendation).toBe("approve");
    expect(report.score).toBe(85);
    expect(report.confidence).toBe(90);
    expect(report.escalate).toBe(false);
    expect(report.flags).toEqual([]);
  });

  it("forces escalate=true when confidence < 50, regardless of LLM escalate value", async () => {
    const llmReport = {
      recommendation: "approve",
      score: 70,
      confidence: 40, // below threshold
      reasoning: "Unsure due to limited context.",
      flags: ["Insufficient context"],
      escalate: false, // LLM said false but should be overridden
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    const report = await runAdvisor(baseContext);

    expect(report.escalate).toBe(true);
    expect(report.confidence).toBe(40);
  });

  it("forces escalate=true when recommendation is reject", async () => {
    const llmReport = {
      recommendation: "reject",
      score: 15,
      confidence: 85,
      reasoning: "This task contradicts existing architecture.",
      flags: ["Architectural conflict"],
      escalate: false, // LLM said false but reject always escalates
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    const report = await runAdvisor(baseContext);

    expect(report.escalate).toBe(true);
    expect(report.recommendation).toBe("reject");
  });

  it("forces escalate=true when score < 30", async () => {
    const llmReport = {
      recommendation: "redesign",
      score: 25, // below threshold
      confidence: 80,
      reasoning: "Too risky in current form.",
      flags: ["High risk"],
      escalate: false,
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    const report = await runAdvisor(baseContext);

    expect(report.escalate).toBe(true);
    expect(report.score).toBe(25);
  });

  // ── Dry-run ───────────────────────────────────────────────────────────────

  it("returns a passing stub in dry-run mode without calling LLM", async () => {
    const report = await runAdvisor({ ...baseContext, dryRun: true });

    expect(mockedCallClaude).not.toHaveBeenCalled();
    expect(report.recommendation).toBe("approve");
    expect(report.score).toBeGreaterThan(0);
    expect(report.confidence).toBeGreaterThan(0);
    expect(report.escalate).toBe(false);
  });

  // ── Prism integration (graceful degradation) ──────────────────────────────

  it("continues gracefully when Prism is not installed", async () => {
    // @prism/core is not installed in this repo — the dynamic import will fail
    // and the advisor should continue without it.
    const llmReport = {
      recommendation: "approve",
      score: 80,
      confidence: 75,
      reasoning: "Looks good.",
      flags: [],
      escalate: false,
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    // Providing a repoId triggers the Prism path, but since it's not installed
    // the agent should fall back silently.
    const report = await runAdvisor({ ...baseContext, repoId: "test-repo-123" });

    expect(report.recommendation).toBe("approve");
    expect(report.escalate).toBe(false);
  });

  // ── Score clamping ────────────────────────────────────────────────────────

  it("clamps score and confidence to [0, 100] range", async () => {
    const llmReport = {
      recommendation: "approve",
      score: 999,     // over max
      confidence: -5, // below min
      reasoning: "Out-of-range values from LLM.",
      flags: [],
      escalate: false,
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    const report = await runAdvisor(baseContext);

    expect(report.score).toBe(100);
    expect(report.confidence).toBe(0);
    // confidence=0 < 50, so escalate must be true
    expect(report.escalate).toBe(true);
  });

  // ── Enrichment data ───────────────────────────────────────────────────────

  it("includes enrichment data in the prompt when provided", async () => {
    const llmReport = {
      recommendation: "approve",
      score: 82,
      confidence: 88,
      reasoning: "Fits well.",
      flags: [],
      escalate: false,
    };

    mockedCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(llmReport),
      cost: { model: "claude-3-5-haiku-20241022", inputTokens: 100, outputTokens: 80, totalCostUsd: 0.002 },
    } as any);

    mockedExtractJson.mockReturnValueOnce(llmReport);

    const report = await runAdvisor({
      ...baseContext,
      enrichment: { labels: ["ui", "feature"], effort: "small", complexity: 2 },
    });

    // Verify the prompt passed to callClaude contained enrichment data
    const callArgs = mockedCallClaude.mock.calls[0][0];
    expect(callArgs.prompt).toContain("Enrichment Data");
    expect(callArgs.prompt).toContain('"labels"');
    expect(report.recommendation).toBe("approve");
  });
});
