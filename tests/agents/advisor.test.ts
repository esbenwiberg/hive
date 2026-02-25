import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules BEFORE importing the module under test
vi.mock("../../src/agents/sdk.js");
vi.mock("../../src/db/queries/tasks.js", () => ({
  insertAdvisorReport: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/db/queries/task-events.js", () => ({
  addAdvisorEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/db/queries/active-agents.js", () => ({
  register: vi.fn(() => Promise.resolve()),
  unregister: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/domain/autonomous-config.js", () => ({
  getModelFor: vi.fn(() => "claude-3-5-sonnet-20241022"),
  getAutonomousConfig: vi.fn(() => ({
    advisor: {
      enabled: true,
      confidenceThreshold: 50,
      usePrism: false,
    },
  })),
}));
vi.mock("../../src/agents/cost-utils.js", () => ({
  estimateCostUsd: vi.fn(() => 0.01),
}));
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Now import after all mocks are registered
import { runAdvisor } from "../../src/agents/advisor.js";
import * as sdk from "../../src/agents/sdk.js";

describe("Advisor Agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse valid JSON response correctly", async () => {
    const validResponse = {
      text: JSON.stringify({
        recommendation: "approve",
        score: 85,
        confidence: 90,
        reasoning: "Well-scoped task with clear value",
        flags: ["Good fit", "Low risk"],
        escalate: false,
      }),
      cost: {
        inputTokens: 1000,
        outputTokens: 200,
      },
    };

    vi.mocked(sdk.callClaude).mockResolvedValue(validResponse as any);

    const result = await runAdvisor({
      taskId: "123",
      userId: 1,
      title: "Test Task",
      taskBody: "Test task body",
      enrichment: {
        labels: [],
        complexity: "medium",
        affectedAreas: [],
        riskFlags: [],
        estimatedEffort: "4 hours",
      },
    });

    expect(result.recommendation).toBe("approve");
    expect(result.score).toBe(85);
    expect(result.confidence).toBe(90);
    expect(result.escalate).toBe(false);
  });

  it("should parse JSON wrapped in markdown code fences", async () => {
    const markdownResponse = {
      text: `\`\`\`json
{
  "recommendation": "redesign",
  "score": 45,
  "confidence": 75,
  "reasoning": "Needs design iteration",
  "flags": ["Scope too broad"],
  "escalate": false
}
\`\`\``,
      cost: {
        inputTokens: 1000,
        outputTokens: 150,
      },
    };

    vi.mocked(sdk.callClaude).mockResolvedValue(markdownResponse as any);

    const result = await runAdvisor({
      taskId: "124",
      userId: 1,
      title: "Test Task 2",
      taskBody: "Test task body 2",
      enrichment: {
        labels: [],
        complexity: "medium",
        affectedAreas: [],
        riskFlags: [],
        estimatedEffort: "4 hours",
      },
    });

    expect(result.recommendation).toBe("redesign");
    expect(result.score).toBe(45);
    expect(result.escalate).toBe(false);
  });

  it("should return safe fallback on malformed JSON", async () => {
    const malformedResponse = {
      text: `This is not JSON at all. Just some text that can't be parsed.`,
      cost: {
        inputTokens: 1000,
        outputTokens: 50,
      },
    };

    vi.mocked(sdk.callClaude).mockResolvedValue(malformedResponse as any);

    const result = await runAdvisor({
      taskId: "125",
      userId: 1,
      title: "Test Task 3",
      taskBody: "Test task body 3",
      enrichment: {
        labels: [],
        complexity: "medium",
        affectedAreas: [],
        riskFlags: [],
        estimatedEffort: "4 hours",
      },
    });

    expect(result.recommendation).toBe("reject");
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
    expect(result.reasoning).toContain("Failed to parse");
  });

  it("should validate required fields and return fallback if missing", async () => {
    const incompleteResponse = {
      text: JSON.stringify({
        recommendation: "approve",
        score: 85,
        // missing confidence, reasoning, flags, escalate
      }),
      cost: {
        inputTokens: 1000,
        outputTokens: 100,
      },
    };

    vi.mocked(sdk.callClaude).mockResolvedValue(incompleteResponse as any);

    const result = await runAdvisor({
      taskId: "126",
      userId: 1,
      title: "Test Task 4",
      taskBody: "Test task body 4",
      enrichment: {
        labels: [],
        complexity: "medium",
        affectedAreas: [],
        riskFlags: [],
        estimatedEffort: "4 hours",
      },
    });

    expect(result.escalate).toBe(true);
    expect(result.reasoning).toContain("Failed to parse");
  });

  it("should clamp scores to 0-100 range", async () => {
    const outOfRangeResponse = {
      text: JSON.stringify({
        recommendation: "approve",
        score: 150,
        confidence: -50,
        reasoning: "Test",
        flags: [],
        escalate: false,
      }),
      cost: {
        inputTokens: 1000,
        outputTokens: 150,
      },
    };

    vi.mocked(sdk.callClaude).mockResolvedValue(outOfRangeResponse as any);

    const result = await runAdvisor({
      taskId: "127",
      userId: 1,
      title: "Test Task 5",
      taskBody: "Test task body 5",
      enrichment: {
        labels: [],
        complexity: "medium",
        affectedAreas: [],
        riskFlags: [],
        estimatedEffort: "4 hours",
      },
    });

    expect(result.score).toBe(100);
    expect(result.confidence).toBe(0);
  });

  it("should handle no response from LLM gracefully", async () => {
    vi.mocked(sdk.callClaude).mockResolvedValue(null as any);

    const result = await runAdvisor({
      taskId: "128",
      userId: 1,
      title: "Test Task 6",
      taskBody: "Test task body 6",
      enrichment: {
        labels: [],
        complexity: "medium",
        affectedAreas: [],
        riskFlags: [],
        estimatedEffort: "4 hours",
      },
    });

    expect(result.escalate).toBe(true);
    expect(result.recommendation).toBe("reject");
  });
});
