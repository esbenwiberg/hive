import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs so we can control what docs are returned
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((_path: string) => "# Mock doc content"),
  };
});

vi.mock("../../src/prompt-cache.js", () => ({
  loadPrompt: vi.fn(() => "You are the advisor. Return JSON."),
}));

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getModelFor: vi.fn(() => "claude-haiku-test"),
  getAutonomousConfig: vi.fn(() => ({
    models: { default: "claude-haiku-test", components: {} },
    costs: {},
  })),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { runAdvisor } = await import("../../src/agents/advisor.js");
import type { AdvisorInput, AdvisorVerdict } from "../../src/agents/advisor.js";

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

// ── Helpers ──────────────────────────────────────────────────────────────────

const baseInput: AdvisorInput = {
  taskId: "HIVE-test-001",
  title: "Add dark mode toggle",
  description: "Allow users to switch between light and dark themes.",
  routerClassification: { type: "feature", size: "small", workflow: "flow" },
  codebaseContext: { files: ["src/ui/theme.ts"] },
  architectBlueprint: { approach: "add CSS variable toggle" },
  scorerOutput: { complexity: 2, risk: 1 },
};

function makeVerdictJson(overrides: Partial<AdvisorVerdict> = {}): string {
  const base: AdvisorVerdict = {
    verdict: "approve",
    overallScore: 0.85,
    confidenceScore: 0.9,
    dimensions: {
      productFit: { score: 0.9, rationale: "Fits product well." },
      architecturalAlignment: { score: 0.85, rationale: "Consistent with existing patterns." },
      userImpact: { score: 0.8, rationale: "High user value." },
      implementationRisk: { score: 0.8, rationale: "Low risk." },
      scopeClarity: { score: 0.9, rationale: "Well-scoped." },
    },
    reasoning: "This task aligns strongly with product goals.",
    recommendations: ["Proceed with implementation.", "Add unit tests for theme toggle."],
    escalate: false,
  };
  return JSON.stringify({ ...base, ...overrides });
}

function mockSuccess(verdictOverrides: Partial<AdvisorVerdict> = {}) {
  mockCallClaude.mockResolvedValue({
    text: makeVerdictJson(verdictOverrides),
    cost: {
      model: "claude-haiku-test",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 100,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAdvisor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Return type and shape ─────────────────────────────────────────────────

  it("returns a well-formed AdvisorVerdict on success", async () => {
    mockSuccess();
    const result = await runAdvisor(baseInput);

    expect(result.verdict).toBe("approve");
    expect(result.overallScore).toBe(0.85);
    expect(result.confidenceScore).toBe(0.9);
    expect(result.escalate).toBe(false);
    expect(result.reasoning).toContain("aligns strongly");
    expect(result.recommendations).toHaveLength(2);

    // Dimension shape
    expect(result.dimensions.productFit.score).toBe(0.9);
    expect(result.dimensions.architecturalAlignment.score).toBe(0.85);
    expect(result.dimensions.userImpact.score).toBe(0.8);
    expect(result.dimensions.implementationRisk.score).toBe(0.8);
    expect(result.dimensions.scopeClarity.score).toBe(0.9);
  });

  it("passes taskId, title, and description in the prompt", async () => {
    mockSuccess();
    await runAdvisor(baseInput);

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain(baseInput.taskId);
    expect(call.prompt).toContain(baseInput.title);
    expect(call.prompt).toContain(baseInput.description);
  });

  it("injects all enrichment sections into the prompt", async () => {
    mockSuccess();
    await runAdvisor(baseInput);

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain("Router Classification");
    expect(call.prompt).toContain("Codebase Context");
    expect(call.prompt).toContain("Architect Blueprint");
    expect(call.prompt).toContain("Scorer Output");
  });

  it("uses the system prompt from loadPrompt", async () => {
    mockSuccess();
    await runAdvisor(baseInput);

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.systemPrompt).toContain("You are the advisor");
  });

  // ── Low confidence forces escalation ─────────────────────────────────────

  it("forces escalate=true when confidenceScore < 0.5", async () => {
    mockSuccess({ confidenceScore: 0.3, escalate: false });
    const result = await runAdvisor(baseInput);

    expect(result.confidenceScore).toBe(0.3);
    expect(result.escalate).toBe(true);
  });

  it("preserves escalate=true when confidenceScore >= 0.5 and LLM set it true", async () => {
    mockSuccess({ confidenceScore: 0.75, escalate: true });
    const result = await runAdvisor(baseInput);

    expect(result.escalate).toBe(true);
  });

  it("does not override escalate when confidenceScore >= 0.5 and LLM said false", async () => {
    mockSuccess({ confidenceScore: 0.8, escalate: false });
    const result = await runAdvisor(baseInput);

    expect(result.escalate).toBe(false);
  });

  // ── Verdict values ────────────────────────────────────────────────────────

  it("accepts verdict=caution", async () => {
    mockSuccess({ verdict: "caution", overallScore: 0.5 });
    const result = await runAdvisor(baseInput);
    expect(result.verdict).toBe("caution");
  });

  it("accepts verdict=reject", async () => {
    mockSuccess({ verdict: "reject", overallScore: 0.2 });
    const result = await runAdvisor(baseInput);
    expect(result.verdict).toBe("reject");
  });

  // ── Markdown fence stripping ──────────────────────────────────────────────

  it("parses response wrapped in markdown code fences", async () => {
    const json = makeVerdictJson();
    mockCallClaude.mockResolvedValue({
      text: `\`\`\`json\n${json}\n\`\`\``,
      cost: { model: "claude-haiku-test", inputTokens: 100, outputTokens: 50 },
    });

    const result = await runAdvisor(baseInput);
    expect(result.verdict).toBe("approve");
  });

  // ── Graceful error handling ───────────────────────────────────────────────

  it("returns default escalation verdict on JSON parse failure", async () => {
    mockCallClaude.mockResolvedValue({
      text: "This is not valid JSON at all!",
      cost: { model: "claude-haiku-test", inputTokens: 100, outputTokens: 20 },
    });

    const result = await runAdvisor(baseInput);

    expect(result.escalate).toBe(true);
    expect(result.confidenceScore).toBe(0);
    expect(result.overallScore).toBe(0);
    expect(result.reasoning).toContain("Advisor could not produce");
    expect(result.recommendations).toContain("Human review required — advisor response was unparseable.");
  });

  it("returns default escalation verdict on missing required fields", async () => {
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ verdict: "approve" }), // missing all other fields
      cost: { model: "claude-haiku-test", inputTokens: 100, outputTokens: 20 },
    });

    const result = await runAdvisor(baseInput);

    expect(result.escalate).toBe(true);
    expect(result.confidenceScore).toBe(0);
  });

  it("returns default escalation verdict on invalid verdict enum", async () => {
    const json = makeVerdictJson({ verdict: "maybe" as "approve" });
    mockCallClaude.mockResolvedValue({
      text: json,
      cost: { model: "claude-haiku-test", inputTokens: 100, outputTokens: 20 },
    });

    const result = await runAdvisor(baseInput);

    expect(result.escalate).toBe(true);
  });

  it("returns default escalation verdict when LLM call throws", async () => {
    mockCallClaude.mockRejectedValue(new Error("Network timeout"));

    const result = await runAdvisor(baseInput);

    expect(result.escalate).toBe(true);
    expect(result.confidenceScore).toBe(0);
    expect(result.reasoning).toContain("LLM call failed");
  });

  // ── Optional enrichment ───────────────────────────────────────────────────

  it("handles missing enrichment fields gracefully", async () => {
    mockSuccess();
    const minimalInput: AdvisorInput = {
      taskId: "HIVE-minimal-001",
      title: "Minimal task",
      description: "No enrichment data available.",
    };

    const result = await runAdvisor(minimalInput);

    expect(result.verdict).toBe("approve");

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain("(not available)");
  });

  it("includes extra enrichment section when provided", async () => {
    mockSuccess();
    const withExtra: AdvisorInput = {
      ...baseInput,
      extraEnrichment: { customData: "some extra context" },
    };

    await runAdvisor(withExtra);

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain("Additional Enrichment");
    expect(call.prompt).toContain("customData");
  });

  // ── Model selection ───────────────────────────────────────────────────────

  it("uses the model returned by getModelFor('advisor')", async () => {
    mockSuccess();
    await runAdvisor(baseInput);

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-test");
  });
});
