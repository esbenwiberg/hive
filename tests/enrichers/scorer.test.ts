import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("../../src/prompt-cache.js", () => ({
  loadPrompt: vi.fn().mockReturnValue("mocked scorer system prompt"),
}));

vi.mock("../../src/domain/autonomous-config.js", () => {
  const cfg = {
    models: { default: "claude-sonnet-4-20250514", components: {} as Record<string, string>, inputCostPerM: 3, outputCostPerM: 15 },
    classification: { defaultSize: "medium" },
  };
  return {
    getAutonomousConfig: vi.fn().mockReturnValue(cfg),
    getModelFor: (c: string) => cfg.models.components[c] ?? cfg.models.default,
  };
});

vi.mock("../../src/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { callClaude } from "../../src/agents/sdk.js";
import { scorerEnricher, parseScorerResult } from "../../src/enrichers/scorer.js";
import { computeTotalScore } from "../../src/dashboard/views/tasks.js";
import type { TaskRow } from "../../src/db/schema.js";
import type { EnricherConfig } from "../../src/enrichers/base.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

const DUMMY_TASK = {
  id: "task-scorer-test",
  title: "Add user authentication",
  body: "Implement OAuth2 login flow",
  size: "medium",
} as TaskRow;

const DEFAULT_CONFIG: EnricherConfig = { enabled: true };

function makeCostMeta(model = "claude-sonnet-4-20250514") {
  return { model, inputTokens: 400, outputTokens: 250 };
}

function makeFullScorerResponse() {
  return {
    scores: {
      value:       { score: 8, reasoning: "High business value" },
      complexity:  { score: 6, reasoning: "Moderate complexity" },
      risk:        { score: 3, reasoning: "Low risk with good tests" },
      feasibility: { score: 7, reasoning: "Feasible with existing tooling" },
    },
    costEstimate: {
      totalUsd: 1.25,
      breakdown: { enrichment: 0.15, execution: 0.85, review: 0.25 },
      reasoning: "Medium task with two milestones",
    },
    recommendation: "approve",
    summary: "Well-scoped task with clear milestones and low risk",
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scorerEnricher", () => {
  it("has the correct name", () => {
    expect(scorerEnricher.name).toBe("scorer");
  });

  it("scores a task with blueprint data via Claude call", async () => {
    const priorResults = {
      architect: {
        approach: "Implement OAuth2 with milestones",
        milestones: [
          { title: "M1", description: "Setup", filesToModify: [], acceptanceCriteria: [] },
        ],
      },
    };

    const scorerResponse = makeFullScorerResponse();

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(scorerResponse),
      cost: makeCostMeta(),
    });

    const result = await scorerEnricher.run(DUMMY_TASK, "/tmp", priorResults, DEFAULT_CONFIG);

    expect(mockCallClaude).toHaveBeenCalledTimes(1);

    const scorer = result.data.scorer as Record<string, unknown>;
    const scores = scorer.scores as Record<string, Record<string, unknown>>;
    expect(scores.value.score).toBe(8);
    expect(scores.complexity.score).toBe(6);
    expect(scores.risk.score).toBe(3);
    expect(scores.feasibility.score).toBe(7);

    expect(scorer.recommendation).toBe("approve");
    expect(scorer.summary).toBe("Well-scoped task with clear milestones and low risk");
    expect(result.costUsd).toBeTypeOf("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses heuristic fallback when architect is missing (no Claude call)", async () => {
    const priorResults = {}; // no architect data

    const result = await scorerEnricher.run(DUMMY_TASK, "/tmp", priorResults, DEFAULT_CONFIG);

    expect(mockCallClaude).not.toHaveBeenCalled();

    const scorer = result.data.scorer as Record<string, unknown>;
    // Medium task without blueprint gets mid-range heuristic scores
    const scores = scorer.scores as Record<string, Record<string, unknown>>;
    expect(scores.value.score).toBe(5);
    expect(scores.complexity.score).toBe(5);
    expect(scores.risk.score).toBe(6);
    expect(scores.feasibility.score).toBe(4);
    expect(scorer.recommendation).toBe("rework");
    expect(result.costUsd).toBeUndefined();
  });

  it("uses heuristic fallback when architect was skipped (no Claude call)", async () => {
    const priorResults = {
      architect: { skipped: true, approach: "" },
    };

    const trivialTask = { ...DUMMY_TASK, size: "trivial" } as TaskRow;

    const result = await scorerEnricher.run(trivialTask, "/tmp", priorResults, DEFAULT_CONFIG);

    expect(mockCallClaude).not.toHaveBeenCalled();

    const scorer = result.data.scorer as Record<string, unknown>;
    const scores = scorer.scores as Record<string, Record<string, unknown>>;
    // Trivial task gets specific heuristic scores
    expect(scores.complexity.score).toBe(1);
    expect(scores.risk.score).toBe(1);
    expect(scores.feasibility.score).toBe(10);
    expect(scorer.recommendation).toBe("approve");
  });

  it("uses heuristic fallback when architect is awaiting input", async () => {
    const priorResults = {
      architect: {
        approach: "Needs clarification",
        clarificationQuestions: ["Q1?"],
        awaitingInput: true,
      },
    };

    const result = await scorerEnricher.run(DUMMY_TASK, "/tmp", priorResults, DEFAULT_CONFIG);

    expect(mockCallClaude).not.toHaveBeenCalled();
    const scorer = result.data.scorer as Record<string, unknown>;
    // Falls back to heuristic because architect is awaiting input
    expect(scorer.recommendation).toBeDefined();
  });

  it("provides heuristic scores appropriate for small tasks", async () => {
    const smallTask = { ...DUMMY_TASK, size: "small" } as TaskRow;
    const priorResults = {}; // no architect

    const result = await scorerEnricher.run(smallTask, "/tmp", priorResults, DEFAULT_CONFIG);

    const scorer = result.data.scorer as Record<string, unknown>;
    const scores = scorer.scores as Record<string, Record<string, unknown>>;
    expect(scores.value.score).toBe(4);
    expect(scores.complexity.score).toBe(3);
    expect(scores.risk.score).toBe(2);
    expect(scores.feasibility.score).toBe(8);
    expect(scorer.recommendation).toBe("approve");

    const costEstimate = scorer.costEstimate as Record<string, unknown>;
    expect(costEstimate.totalUsd).toBe(0.80);
  });

  it("clamps scores to 1-10 range", () => {
    const input = JSON.stringify({
      scores: {
        value:       { score: 15, reasoning: "way too high" },
        complexity:  { score: -3, reasoning: "way too low" },
        risk:        { score: 0, reasoning: "zero" },
        feasibility: { score: 100, reasoning: "absurd" },
      },
      costEstimate: {
        totalUsd: 1.0,
        breakdown: { enrichment: 0.1, execution: 0.5, review: 0.4 },
        reasoning: "test",
      },
      recommendation: "approve",
      summary: "Test clamping",
    });

    const result = parseScorerResult(input);

    expect(result.scores.value.score).toBe(10);       // clamped from 15
    expect(result.scores.complexity.score).toBe(1);    // clamped from -3
    expect(result.scores.risk.score).toBe(1);          // clamped from 0
    expect(result.scores.feasibility.score).toBe(10);  // clamped from 100
  });

  it("cost estimate has a breakdown object", async () => {
    const priorResults = {
      architect: {
        approach: "Test approach",
        milestones: [{ title: "M1", description: "", filesToModify: [], acceptanceCriteria: [] }],
      },
    };

    const scorerResponse = makeFullScorerResponse();

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(scorerResponse),
      cost: makeCostMeta(),
    });

    const result = await scorerEnricher.run(DUMMY_TASK, "/tmp", priorResults, DEFAULT_CONFIG);

    const scorer = result.data.scorer as Record<string, unknown>;
    const costEstimate = scorer.costEstimate as Record<string, unknown>;
    expect(costEstimate.totalUsd).toBe(1.25);

    const breakdown = costEstimate.breakdown as Record<string, number>;
    expect(breakdown).toHaveProperty("enrichment");
    expect(breakdown).toHaveProperty("execution");
    expect(breakdown).toHaveProperty("review");
    expect(breakdown.enrichment).toBe(0.15);
    expect(breakdown.execution).toBe(0.85);
    expect(breakdown.review).toBe(0.25);
  });

  it("returns mid-range defaults on JSON parse failure", () => {
    const result = parseScorerResult("this is not valid JSON at all");

    expect(result.scores.value.score).toBe(5);
    expect(result.scores.complexity.score).toBe(5);
    expect(result.scores.risk.score).toBe(5);
    expect(result.scores.feasibility.score).toBe(5);

    expect(result.scores.value.reasoning).toBe("parse_error");
    expect(result.scores.complexity.reasoning).toBe("parse_error");

    expect(result.costEstimate.totalUsd).toBe(0);
    expect(result.costEstimate.reasoning).toBe("parse_error");
    expect(result.recommendation).toBe("rework");
    expect(result.summary).toContain("mid-range");
  });

  it("validates recommendation to a valid enum value", () => {
    // Valid recommendations
    for (const rec of ["approve", "reject", "rework"]) {
      const input = JSON.stringify({
        scores: {
          value: { score: 5, reasoning: "" },
          complexity: { score: 5, reasoning: "" },
          risk: { score: 5, reasoning: "" },
          feasibility: { score: 5, reasoning: "" },
        },
        costEstimate: {
          totalUsd: 0.5,
          breakdown: { enrichment: 0.1, execution: 0.3, review: 0.1 },
          reasoning: "",
        },
        recommendation: rec,
        summary: "test",
      });

      const result = parseScorerResult(input);
      expect(result.recommendation).toBe(rec);
    }

    // Invalid recommendation defaults to "rework"
    const invalidInput = JSON.stringify({
      scores: {
        value: { score: 5, reasoning: "" },
        complexity: { score: 5, reasoning: "" },
        risk: { score: 5, reasoning: "" },
        feasibility: { score: 5, reasoning: "" },
      },
      costEstimate: {
        totalUsd: 0.5,
        breakdown: { enrichment: 0.1, execution: 0.3, review: 0.1 },
        reasoning: "",
      },
      recommendation: "maybe",
      summary: "test",
    });

    const invalidResult = parseScorerResult(invalidInput);
    expect(invalidResult.recommendation).toBe("rework");
  });

  it("uses config.model when provided", async () => {
    const customConfig: EnricherConfig = { enabled: true, model: "claude-opus-4-20250514" };
    const priorResults = {
      architect: {
        approach: "Test",
        milestones: [{ title: "M1", description: "", filesToModify: [], acceptanceCriteria: [] }],
      },
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(makeFullScorerResponse()),
      cost: makeCostMeta("claude-opus-4-20250514"),
    });

    await scorerEnricher.run(DUMMY_TASK, "/tmp", priorResults, customConfig);

    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.model).toBe("claude-opus-4-20250514");
  });
});

// ── parseScorerResult unit tests ──────────────────────────────────────────────

describe("parseScorerResult", () => {
  it("strips code fences before parsing", () => {
    const json = JSON.stringify(makeFullScorerResponse());
    const wrapped = "```json\n" + json + "\n```";

    const result = parseScorerResult(wrapped);
    expect(result.scores.value.score).toBe(8);
    expect(result.recommendation).toBe("approve");
  });

  it("handles missing score dimensions with defaults", () => {
    const input = JSON.stringify({
      scores: {
        value: { score: 7, reasoning: "good" },
        // complexity, risk, feasibility missing
      },
      costEstimate: {
        totalUsd: 1.0,
        breakdown: { enrichment: 0.1, execution: 0.5, review: 0.4 },
        reasoning: "test",
      },
      recommendation: "approve",
      summary: "test",
    });

    const result = parseScorerResult(input);
    expect(result.scores.value.score).toBe(7);
    // Missing dimensions get default score of 5
    expect(result.scores.complexity.score).toBe(5);
    expect(result.scores.risk.score).toBe(5);
    expect(result.scores.feasibility.score).toBe(5);
  });

  it("computes totalUsd from breakdown when totalUsd is 0", () => {
    const input = JSON.stringify({
      scores: {
        value: { score: 5, reasoning: "" },
        complexity: { score: 5, reasoning: "" },
        risk: { score: 5, reasoning: "" },
        feasibility: { score: 5, reasoning: "" },
      },
      costEstimate: {
        totalUsd: 0,
        breakdown: { enrichment: 0.10, execution: 0.50, review: 0.20 },
        reasoning: "from breakdown",
      },
      recommendation: "approve",
      summary: "test",
    });

    const result = parseScorerResult(input);
    // When totalUsd is 0, it should use sum of breakdown
    expect(result.costEstimate.totalUsd).toBeCloseTo(0.80, 2);
  });

  it("rounds scores to nearest integer", () => {
    const input = JSON.stringify({
      scores: {
        value:       { score: 7.6, reasoning: "" },
        complexity:  { score: 3.2, reasoning: "" },
        risk:        { score: 4.5, reasoning: "" },
        feasibility: { score: 8.9, reasoning: "" },
      },
      costEstimate: {
        totalUsd: 1.0,
        breakdown: { enrichment: 0.1, execution: 0.5, review: 0.4 },
        reasoning: "",
      },
      recommendation: "approve",
      summary: "test",
    });

    const result = parseScorerResult(input);
    expect(result.scores.value.score).toBe(8);
    expect(result.scores.complexity.score).toBe(3);
    expect(result.scores.risk.score).toBe(5);
    expect(result.scores.feasibility.score).toBe(9);
  });

  it("handles non-finite score values with default of 5", () => {
    const input = JSON.stringify({
      scores: {
        value:       { score: "not a number", reasoning: "" },
        complexity:  { score: null, reasoning: "" },
        risk:        { score: Infinity, reasoning: "" },
        feasibility: { score: 7, reasoning: "" },
      },
      costEstimate: {
        totalUsd: 1.0,
        breakdown: { enrichment: 0.1, execution: 0.5, review: 0.4 },
        reasoning: "",
      },
      recommendation: "approve",
      summary: "test",
    });

    const result = parseScorerResult(input);
    expect(result.scores.value.score).toBe(5);       // "not a number" → NaN → not finite → 5
    expect(result.scores.complexity.score).toBe(1);   // null → Number(null)=0 → finite → clamp(0)=1
    expect(result.scores.feasibility.score).toBe(7);
  });
});

// ── computeTotalScore polarity tests ─────────────────────────────────────────

describe("computeTotalScore", () => {
  /**
   * Helper to build a ScorerData-like scores object from raw dimension values.
   * value & feasibility: high = good (used as-is)
   * risk & complexity:   low  = good (inverted via 11 - score)
   */
  function makeScores(value: number, complexity: number, risk: number, feasibility: number) {
    return {
      value:       { score: value,       reasoning: "" },
      complexity:  { score: complexity,  reasoning: "" },
      risk:        { score: risk,        reasoning: "" },
      feasibility: { score: feasibility, reasoning: "" },
    };
  }

  it("yields the maximum total when value=10, feasibility=10, risk=1, complexity=1", () => {
    // Adjusted: value=10 (as-is), feasibility=10 (as-is), risk inverted: 11-1=10, complexity inverted: 11-1=10
    // Average = (10 + 10 + 10 + 10) / 4 = 10
    const total = computeTotalScore(makeScores(10, 1, 1, 10));
    expect(total).toBe(10);
  });

  it("yields the minimum total when value=1, feasibility=1, risk=10, complexity=10", () => {
    // value=1 (as-is), feasibility=1 (as-is), risk inverted: 11-10=1, complexity inverted: 11-10=1
    // Average = (1 + 1 + 1 + 1) / 4 = 1
    const total = computeTotalScore(makeScores(1, 10, 10, 1));
    expect(total).toBe(1);
  });

  it("inverts risk and complexity but keeps value and feasibility as-is", () => {
    // value=8 (as-is=8), complexity=6 → inverted=5, risk=3 → inverted=8, feasibility=7 (as-is=7)
    // Average = (8 + 5 + 8 + 7) / 4 = 28 / 4 = 7
    const total = computeTotalScore(makeScores(8, 6, 3, 7));
    expect(total).toBeCloseTo(7, 5);
  });

  it("treats mid-range scores symmetrically (all 5 or 6)", () => {
    // value=5 (as-is=5), complexity=6 → inverted=5, risk=6 → inverted=5, feasibility=5 (as-is=5)
    // Average = (5 + 5 + 5 + 5) / 4 = 5
    const total = computeTotalScore(makeScores(5, 6, 6, 5));
    expect(total).toBe(5);
  });

  it("handles a null scores object by returning null", () => {
    expect(computeTotalScore(null)).toBeNull();
    expect(computeTotalScore(undefined)).toBeNull();
  });

  it("handles partially missing dimensions by averaging only present ones", () => {
    // Only value=10 and risk=1 present; risk inverted = 10
    // Average = (10 + 10) / 2 = 10
    const total = computeTotalScore({
      value:       { score: 10, reasoning: "" },
      risk:        { score: 1,  reasoning: "" },
    } as Parameters<typeof computeTotalScore>[0]);
    expect(total).toBe(10);
  });

  it("high raw risk score lowers total (polarity check)", () => {
    const highRisk  = computeTotalScore(makeScores(5, 5, 10, 5));
    const lowRisk   = computeTotalScore(makeScores(5, 5, 1,  5));
    expect(lowRisk!).toBeGreaterThan(highRisk!);
  });

  it("high raw complexity score lowers total (polarity check)", () => {
    const highComplexity = computeTotalScore(makeScores(5, 10, 5, 5));
    const lowComplexity  = computeTotalScore(makeScores(5, 1,  5, 5));
    expect(lowComplexity!).toBeGreaterThan(highComplexity!);
  });

  it("high raw value score raises total (polarity check)", () => {
    const highValue = computeTotalScore(makeScores(10, 5, 5, 5));
    const lowValue  = computeTotalScore(makeScores(1,  5, 5, 5));
    expect(highValue!).toBeGreaterThan(lowValue!);
  });

  it("high raw feasibility score raises total (polarity check)", () => {
    const highFeas = computeTotalScore(makeScores(5, 5, 5, 10));
    const lowFeas  = computeTotalScore(makeScores(5, 5, 5, 1));
    expect(highFeas!).toBeGreaterThan(lowFeas!);
  });
});
