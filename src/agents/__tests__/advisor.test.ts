import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAdvisor, type AdvisorInput } from "../advisor.js";
import * as fs from "node:fs";
import type { AdvisorVerdictResponse } from "../types.js";

// Mock fs module
vi.mock("node:fs");
vi.mock("../sdk.js");
vi.mock("../domain/autonomous-config.js");
vi.mock("../prompt-cache.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockInput(overrides?: Partial<AdvisorInput>): AdvisorInput {
  return {
    taskId: "task-123",
    title: "Add error handling to worker",
    description: "The worker module needs better error handling in the executor loop",
    ...overrides,
  };
}

function createMockVerdict(overrides?: Partial<AdvisorVerdictResponse>): AdvisorVerdictResponse {
  return {
    verdict: "approve",
    confidenceScore: 0.8,
    escalate: false,
    dimensions: {
      productAlignment: 0.9,
      architecturalFit: 0.8,
    },
    reasoning: "Task aligns well with system reliability goals.",
    recommendations: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Advisor Agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks
    const fsModule = vi.mocked(fs);
    fsModule.existsSync = vi.fn().mockReturnValue(false);
    fsModule.readFileSync = vi.fn().mockReturnValue("");

    const { getModelFor } = vi.mocked(await import("../domain/autonomous-config.js"));
    getModelFor.mockReturnValue("claude-opus");

    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict()),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const { loadPrompt } = vi.mocked(await import("../prompt-cache.js"));
    loadPrompt.mockReturnValue("You are an advisor.");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return a valid verdict on successful LLM call", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict({
        verdict: "approve",
        confidenceScore: 0.85,
        escalate: false,
      })),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBe(0.85);
    expect(result.escalate).toBe(false);
  });

  // Test 1: Mandatory escalation rule — confidenceScore < 0.5 forces escalate=true
  it("should ALWAYS escalate when confidenceScore < 0.5 (mandatory rule)", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict({
        confidenceScore: 0.3,
        escalate: false, // LLM says don't escalate
      })),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    // Mandatory override: escalate must be true
    expect(result.confidenceScore).toBe(0.3);
    expect(result.escalate).toBe(true);
  });

  // Test 2: Validation failure returns FALLBACK_VERDICT
  it("should return FALLBACK_VERDICT when LLM response is invalid", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: "not json at all",
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.escalate).toBe(true);
    expect(result.confidenceScore).toBe(0.0);
    expect(result.verdict).toBe("rework");
    expect(result.reasoning).toContain("Advisor unavailable");
  });

  // Test 3: Verdict enum validation — reject invalid verdict values
  it("should reject invalid verdict values and return FALLBACK_VERDICT", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify({
        verdict: "reject", // Invalid — not in ['approve', 'caution', 'rework']
        confidenceScore: 0.7,
        escalate: false,
        dimensions: {},
        reasoning: "some reason",
        recommendations: [],
      }),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.escalate).toBe(true);
    expect(result.verdict).toBe("rework");
    expect(result.confidenceScore).toBe(0.0);
  });

  // Test 4: Dimension score validation — reject out-of-range values
  it("should reject dimensions with values outside [0.0, 1.0]", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify({
        verdict: "approve",
        confidenceScore: 0.7,
        escalate: false,
        dimensions: {
          productAlignment: 1.5, // Out of range!
        },
        reasoning: "some reason",
        recommendations: [],
      }),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.escalate).toBe(true);
    expect(result.verdict).toBe("rework");
    expect(result.confidenceScore).toBe(0.0);
  });

  // Test 5: Input sanitization — advisor validates LLM output, not input
  it("should validate LLM output regardless of malicious input", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict({
        verdict: "approve",
        confidenceScore: 0.85,
      })),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput({
      title: '"); DROP TABLE tasks; //',
      description: '<img src=x onerror="alert(1)">',
    });

    const result = await runAdvisor(input);

    // Advisor should validate LLM output, not the input
    expect(result.verdict).toBe("approve");
    expect(result.escalate).toBe(false);
  });

  // Test 6: Missing product-context.md should not crash
  it("should handle missing product-context.md gracefully", async () => {
    const fsModule = vi.mocked(fs);
    fsModule.existsSync = vi.fn().mockReturnValue(false);
    fsModule.readFileSync = vi.fn().mockImplementation(() => {
      throw new Error("File not found");
    });

    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict()),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    // Should still return valid verdict (graceful degradation)
    expect(result.verdict).toBe("approve");
    expect(result.escalate).toBe(false);
  });

  // Test 7: Missing architecture.md should not crash
  it("should handle missing architecture.md gracefully", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict()),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.verdict).toBe("approve");
    expect(result.escalate).toBe(false);
  });

  // Test 8: LLM parse error (malformed JSON)
  it("should return FALLBACK_VERDICT on JSON parse error", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: "{ invalid json here",
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.escalate).toBe(true);
    expect(result.confidenceScore).toBe(0.0);
    expect(result.verdict).toBe("rework");
  });

  // Test 9: Happy path — valid response with all fields
  it("should return valid verdict unchanged for good LLM response", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    const verdict = createMockVerdict({
      verdict: "approve",
      confidenceScore: 0.92,
      escalate: false,
      dimensions: {
        productAlignment: 0.95,
        architecturalFit: 0.89,
      },
      reasoning: "Excellent task design.",
      recommendations: ["Consider adding tests"],
    });

    callClaude.mockResolvedValue({
      text: JSON.stringify(verdict),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBe(0.92);
    expect(result.escalate).toBe(false);
    expect(result.dimensions.productAlignment).toBe(0.95);
    expect(result.recommendations).toContain("Consider adding tests");
  });

  // Test 10: Enrichment data threading
  it("should pass enrichment data to LLM prompt", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    let capturedPrompt = "";

    callClaude.mockImplementation(async (args: any) => {
      capturedPrompt = args.prompt;
      return {
        text: JSON.stringify(createMockVerdict()),
        cost: {
          model: "claude-opus",
          inputTokens: 1000,
          outputTokens: 500,
        },
      };
    });

    const input = createMockInput({
      routerClassification: { type: "feature", size: "medium" },
      codebaseContext: { fileCount: 42 },
    });

    await runAdvisor(input);

    // Verify enrichment data appears in the prompt
    expect(capturedPrompt).toContain("Router Classification");
    expect(capturedPrompt).toContain("Codebase Context");
  });

  // Test 11: LLM call failure — callClaude throws
  it("should return FALLBACK_VERDICT when callClaude throws", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockRejectedValue(new Error("Network error"));

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.escalate).toBe(true);
    expect(result.verdict).toBe("rework");
    expect(result.confidenceScore).toBe(0.0);
  });

  // Test 12: Verdict 'caution' with moderate score
  it("should handle 'caution' verdict correctly", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict({
        verdict: "caution",
        confidenceScore: 0.6,
        escalate: false,
      })),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.verdict).toBe("caution");
    expect(result.confidenceScore).toBe(0.6);
    expect(result.escalate).toBe(false);
  });

  // Test 13: Verdict 'rework' with low score
  it("should handle 'rework' verdict correctly", async () => {
    const { callClaude } = vi.mocked(await import("../sdk.js"));
    callClaude.mockResolvedValue({
      text: JSON.stringify(createMockVerdict({
        verdict: "rework",
        confidenceScore: 0.4,
        escalate: true,
      })),
      cost: {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    const input = createMockInput();
    const result = await runAdvisor(input);

    expect(result.verdict).toBe("rework");
    expect(result.confidenceScore).toBe(0.4);
    expect(result.escalate).toBe(true);
  });
});
