/**
 * Unit tests for the Advisor agent (src/agents/advisor.ts).
 *
 * All external I/O is mocked:
 *   - callClaude   → mocked so no real Anthropic API calls are made
 *   - node:fs      → mocked so no real file reads occur (prompts, docs)
 *   - logger       → silenced
 *   - cost-utils   → tracked via mockTrackCost spy
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks (must be before any dynamic imports) ────────────────────────────────

vi.mock("../sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("# Mocked doc content"),
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("../../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../cost-utils.js", () => ({
  estimateCostUsd: vi.fn().mockReturnValue(0.0042),
}));

vi.mock("../../domain/autonomous-config.js", () => ({
  getModelFor: vi.fn().mockReturnValue("claude-sonnet-4-20250514"),
  getAutonomousConfig: vi.fn().mockReturnValue({
    models: {
      default: "claude-sonnet-4-20250514",
      components: {},
      inputCostPerM: 3,
      outputCostPerM: 15,
    },
  }),
}));

vi.mock("../../prompt-cache.js", () => ({
  loadPrompt: vi.fn().mockReturnValue("You are the Hive Advisor. Evaluate the task."),
}));

// ── Dynamic imports (after mocks) ─────────────────────────────────────────────

const { callClaude } = await import("../sdk.js");
const { runAdvisor } = await import("../advisor.js");

const mockCallClaude = vi.mocked(callClaude);

// ── Test data ─────────────────────────────────────────────────────────────────

/** A complete, valid AdvisorVerdict JSON string that the LLM would return. */
const VALID_VERDICT_OBJ = {
  verdict: "approve",
  overallScore: 0.82,
  confidenceScore: 0.75,
  dimensions: {
    productFit: {
      score: 0.9,
      rationale: "Directly addresses user-requested dark mode feature.",
    },
    architecturalAlignment: {
      score: 0.85,
      rationale: "CSS variable approach fits existing design token system.",
    },
    userImpact: {
      score: 0.88,
      rationale: "High demand feature; reduces eye strain for low-light users.",
    },
    implementationRisk: {
      score: 0.7,
      rationale: "CSS changes have low blast radius; toggle state needs persistence.",
    },
    scopeClarity: {
      score: 0.8,
      rationale: "Scope is well-defined with clear acceptance criteria.",
    },
  },
  reasoning:
    "This task aligns well with the product roadmap and user expectations. The implementation approach is sound and low-risk.",
  recommendations: [
    "Persist theme preference in localStorage or user profile.",
    "Add integration tests for the toggle interaction.",
  ],
  escalate: false,
};

function makeAdvisorInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "HIVE-test-001",
    title: "Add dark mode support",
    description: "Users want a dark mode toggle for the dashboard to reduce eye strain.",
    routerClassification: { type: "feature", size: "medium", workflow: "flow" },
    codebaseContext: { relevantFiles: ["src/dashboard/views/layout.html"] },
    architectBlueprint: { milestones: ["Design tokens", "CSS vars", "Toggle UI"] },
    scorerOutput: { value: 0.8, complexity: 0.5, risk: 0.3 },
    ...overrides,
  };
}

function mockLlmSuccess(verdict = VALID_VERDICT_OBJ) {
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify(verdict),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1_200,
      outputTokens: 350,
    },
  });
}

function mockLlmMalformed() {
  mockCallClaude.mockResolvedValueOnce({
    text: "I think this is a great idea! Let me walk you through my thoughts...",
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1_200,
      outputTokens: 80,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAdvisor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Successful verdict parsing ────────────────────────────────────────────

  describe("valid LLM JSON", () => {
    it("returns a parsed verdict with the correct top-level fields", async () => {
      mockLlmSuccess();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.verdict).toBe("approve");
      expect(verdict.overallScore).toBe(0.82);
      expect(verdict.confidenceScore).toBe(0.75);
      expect(verdict.escalate).toBe(false);
      expect(verdict.reasoning).toContain("aligns well with the product roadmap");
      expect(verdict.recommendations).toHaveLength(2);
      expect(verdict.recommendations[0]).toContain("localStorage");
    });

    it("returns all five dimension sub-scores from the LLM response", async () => {
      mockLlmSuccess();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.dimensions.productFit.score).toBe(0.9);
      expect(verdict.dimensions.architecturalAlignment.score).toBe(0.85);
      expect(verdict.dimensions.userImpact.score).toBe(0.88);
      expect(verdict.dimensions.implementationRisk.score).toBe(0.7);
      expect(verdict.dimensions.scopeClarity.score).toBe(0.8);
    });

    it("includes rationale strings for each dimension", async () => {
      mockLlmSuccess();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.dimensions.productFit.rationale).toBeTruthy();
      expect(verdict.dimensions.architecturalAlignment.rationale).toBeTruthy();
      expect(verdict.dimensions.userImpact.rationale).toBeTruthy();
      expect(verdict.dimensions.implementationRisk.rationale).toBeTruthy();
      expect(verdict.dimensions.scopeClarity.rationale).toBeTruthy();
    });

    it("calls the SDK LLM exactly once per runAdvisor invocation", async () => {
      mockLlmSuccess();

      await runAdvisor(makeAdvisorInput());

      expect(mockCallClaude).toHaveBeenCalledTimes(1);
    });

    it("embeds the task title and description in the LLM user prompt", async () => {
      mockLlmSuccess();

      await runAdvisor(makeAdvisorInput());

      const callArg = mockCallClaude.mock.calls[0][0];
      expect(callArg.prompt).toContain("Add dark mode support");
      expect(callArg.prompt).toContain("Users want a dark mode toggle");
    });

    it("embeds the taskId in the LLM user prompt", async () => {
      mockLlmSuccess();

      await runAdvisor(makeAdvisorInput());

      const callArg = mockCallClaude.mock.calls[0][0];
      expect(callArg.prompt).toContain("HIVE-test-001");
    });

    it("passes a systemPrompt to the SDK call", async () => {
      mockLlmSuccess();

      await runAdvisor(makeAdvisorInput());

      const callArg = mockCallClaude.mock.calls[0][0];
      expect(callArg.systemPrompt).toBeTruthy();
      expect(typeof callArg.systemPrompt).toBe("string");
    });

    it("strips markdown code fences from LLM response before parsing", async () => {
      mockCallClaude.mockResolvedValueOnce({
        text: `\`\`\`json\n${JSON.stringify(VALID_VERDICT_OBJ)}\n\`\`\``,
        cost: { model: "claude-sonnet-4-20250514", inputTokens: 1_200, outputTokens: 350 },
      });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.verdict).toBe("approve");
      expect(verdict.overallScore).toBe(0.82);
    });
  });

  // ── Escalation rules ──────────────────────────────────────────────────────

  describe("escalation behaviour", () => {
    it("forces escalate=true when LLM returns confidenceScore < 0.5", async () => {
      // LLM sets escalate:false, but confidence is 0.3 → advisor must override
      const lowConfidenceVerdict = {
        ...VALID_VERDICT_OBJ,
        confidenceScore: 0.3,
        escalate: false,
      };
      mockLlmSuccess(lowConfidenceVerdict);

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.confidenceScore).toBe(0.3);
      expect(verdict.escalate).toBe(true); // forced by advisor logic
    });

    it("forces escalate=true when confidenceScore is exactly 0.49", async () => {
      mockLlmSuccess({ ...VALID_VERDICT_OBJ, confidenceScore: 0.49, escalate: false });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(true);
    });

    it("does NOT force escalate when confidenceScore is exactly 0.5", async () => {
      mockLlmSuccess({ ...VALID_VERDICT_OBJ, confidenceScore: 0.5, escalate: false });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(false);
    });

    it("preserves escalate=true from the LLM even when confidenceScore >= 0.5", async () => {
      mockLlmSuccess({ ...VALID_VERDICT_OBJ, confidenceScore: 0.65, escalate: true });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(true);
    });

    it("does not escalate when confidenceScore >= 0.5 and LLM says escalate:false", async () => {
      mockLlmSuccess(); // VALID_VERDICT_OBJ: confidence=0.75, escalate=false

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(false);
    });
  });

  // ── Graceful fallback on malformed / unparseable LLM output ──────────────

  describe("graceful fallback on malformed LLM output", () => {
    it("returns a verdict object (not throwing) when LLM output is not JSON", async () => {
      mockLlmMalformed();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict).toBeDefined();
      expect(typeof verdict.verdict).toBe("string");
      expect(typeof verdict.overallScore).toBe("number");
      expect(typeof verdict.confidenceScore).toBe("number");
      expect(typeof verdict.escalate).toBe("boolean");
    });

    it("returns escalate=true on fallback verdict", async () => {
      mockLlmMalformed();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(true);
    });

    it("returns confidenceScore < 0.5 on fallback verdict", async () => {
      mockLlmMalformed();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.confidenceScore).toBeLessThan(0.5);
    });

    it("returns verdict='caution' on fallback verdict", async () => {
      mockLlmMalformed();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.verdict).toBe("caution");
    });

    it("includes a human-readable explanation in fallback reasoning", async () => {
      mockLlmMalformed();

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.reasoning.length).toBeGreaterThan(10);
    });

    it("returns a fallback verdict when LLM throws an error", async () => {
      mockCallClaude.mockRejectedValueOnce(new Error("API timeout"));

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict).toBeDefined();
      expect(verdict.escalate).toBe(true);
      expect(verdict.confidenceScore).toBeLessThan(0.5);
    });

    it("returns a fallback verdict when LLM returns empty string", async () => {
      mockCallClaude.mockResolvedValueOnce({
        text: "",
        cost: { model: "claude-sonnet-4-20250514", inputTokens: 500, outputTokens: 0 },
      });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict).toBeDefined();
      expect(verdict.escalate).toBe(true);
    });

    it("returns a fallback verdict when JSON is valid but missing required fields", async () => {
      mockCallClaude.mockResolvedValueOnce({
        text: JSON.stringify({ verdict: "approve", overallScore: 0.8 }), // missing fields
        cost: { model: "claude-sonnet-4-20250514", inputTokens: 400, outputTokens: 50 },
      });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(true);
      expect(verdict.confidenceScore).toBe(0);
    });

    it("returns a fallback verdict when verdict value is not a valid enum", async () => {
      mockCallClaude.mockResolvedValueOnce({
        text: JSON.stringify({ ...VALID_VERDICT_OBJ, verdict: "UNKNOWN_VALUE" }),
        cost: { model: "claude-sonnet-4-20250514", inputTokens: 500, outputTokens: 100 },
      });

      const verdict = await runAdvisor(makeAdvisorInput());

      expect(verdict.escalate).toBe(true);
    });
  });

  // ── Minimal / partial enrichment data ────────────────────────────────────

  describe("partial enrichment input", () => {
    it("works when all optional enrichment fields are omitted", async () => {
      mockLlmSuccess();

      const verdict = await runAdvisor({
        taskId: "HIVE-minimal-001",
        title: "Fix typo in README",
        description: "Minor documentation update",
      });

      expect(verdict.verdict).toBe("approve");
    });

    it("serialises undefined enrichment fields as '(not available)' in the prompt", async () => {
      mockLlmSuccess();

      await runAdvisor({
        taskId: "HIVE-minimal-002",
        title: "Minimal task",
        description: "No enrichment data",
      });

      const callArg = mockCallClaude.mock.calls[0][0];
      expect(callArg.prompt).toContain("(not available)");
    });
  });

  // ── Cost-utils integration ────────────────────────────────────────────────

  describe("cost tracking", () => {
    it("receives token counts from the SDK response cost object", async () => {
      mockLlmSuccess();

      await runAdvisor(makeAdvisorInput());

      // Verify callClaude was invoked and its return value had cost data
      expect(mockCallClaude).toHaveBeenCalledTimes(1);
      const result = await mockCallClaude.mock.results[0].value;
      expect(result.cost.inputTokens).toBe(1_200);
      expect(result.cost.outputTokens).toBe(350);
    });

    it("invokes estimateCostUsd with the token counts from the LLM response", async () => {
      const { estimateCostUsd } = await import("../cost-utils.js");
      const mockEstimate = vi.mocked(estimateCostUsd);
      mockLlmSuccess();

      await runAdvisor(makeAdvisorInput());

      expect(mockEstimate).toHaveBeenCalledWith(
        1_200,  // inputTokens
        350,    // outputTokens
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
