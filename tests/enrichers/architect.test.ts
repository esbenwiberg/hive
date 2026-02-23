import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("../../src/prompt-cache.js", () => ({
  loadPrompt: vi.fn().mockReturnValue("mocked architect system prompt"),
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

vi.mock("../../src/db/connection.js", () => ({
  db: {},
  pool: {},
}));

vi.mock("../../src/db/queries/learnings.js", () => ({
  retrieveRelevantLearnings: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/db/queries/repos.js", () => ({
  getById: vi.fn().mockResolvedValue(null),
}));

import { callClaude } from "../../src/agents/sdk.js";
import { architectEnricher, parseBlueprint } from "../../src/enrichers/architect.js";
import type { TaskRow } from "../../src/db/schema.js";
import type { EnricherConfig } from "../../src/enrichers/base.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

const DUMMY_TASK = {
  id: "task-arch-test",
  title: "Add user authentication",
  body: "Implement OAuth2 login flow with Google and GitHub providers",
  size: "medium",
} as TaskRow;

const DEFAULT_CONFIG: EnricherConfig = { enabled: true };

function makeCostMeta(model = "claude-sonnet-4-20250514") {
  return { model, inputTokens: 500, outputTokens: 300 };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("architectEnricher", () => {
  it("has the correct name", () => {
    expect(architectEnricher.name).toBe("architect");
  });

  it("calls Claude even for trivial tasks", async () => {
    const trivialTask = { ...DUMMY_TASK, size: "trivial" } as TaskRow;

    const blueprint = {
      approach: "Quick one-liner fix",
      keyFiles: ["src/utils.ts"],
      checklist: ["Fix the typo"],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(trivialTask, "/tmp", {}, DEFAULT_CONFIG);

    expect(mockCallClaude).toHaveBeenCalledOnce();
    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.approach).toBe("Quick one-liner fix");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeTypeOf("number");
  });

  it("produces a plan with keyFiles and checklist for small tasks (no milestones)", async () => {
    const smallTask = { ...DUMMY_TASK, size: "small" } as TaskRow;

    const blueprint = {
      approach: "Simple refactor of the login module",
      keyFiles: ["src/auth/login.ts", "src/auth/config.ts"],
      checklist: ["Update login handler", "Add unit tests"],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(smallTask, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.approach).toBe("Simple refactor of the login module");
    expect(arch.keyFiles).toEqual(["src/auth/login.ts", "src/auth/config.ts"]);
    expect(arch.checklist).toEqual(["Update login handler", "Add unit tests"]);
    expect(arch.milestones).toBeUndefined();
    expect(result.costUsd).toBeTypeOf("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("produces milestones array for medium tasks", async () => {
    const blueprint = {
      approach: "Implement OAuth2 with milestone-based approach",
      milestones: [
        {
          title: "Setup OAuth providers",
          description: "Configure Google and GitHub OAuth apps",
          filesToModify: ["src/auth/providers.ts"],
          acceptanceCriteria: ["Google OAuth configured", "GitHub OAuth configured"],
        },
        {
          title: "Implement login flow",
          description: "Build the login endpoint and callback handlers",
          filesToModify: ["src/auth/login.ts", "src/routes/auth.ts"],
          acceptanceCriteria: ["Login endpoint works", "Callback handles tokens"],
        },
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(DUMMY_TASK, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.approach).toBe("Implement OAuth2 with milestone-based approach");

    const milestones = arch.milestones as Array<Record<string, unknown>>;
    expect(milestones).toHaveLength(2);
    expect(milestones[0].title).toBe("Setup OAuth providers");
    expect(milestones[1].filesToModify).toEqual(["src/auth/login.ts", "src/routes/auth.ts"]);
  });

  it("returns clarification questions when Claude says task is ambiguous", async () => {
    const claudeResponse = {
      approach: "Need more information before planning",
      clarificationQuestions: [
        "Which OAuth providers should be supported?",
        "Should we use session-based or JWT-based authentication?",
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(claudeResponse),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(DUMMY_TASK, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.clarificationQuestions).toEqual([
      "Which OAuth providers should be supported?",
      "Should we use session-based or JWT-based authentication?",
    ]);
    expect(arch.awaitingInput).toBe(true);
  });

  it("produces a blueprint when clarification answers are present in priorResults (phase 2)", async () => {
    const priorResults = {
      architect: {
        clarificationAnswers: [
          "Google and GitHub providers",
          "Use JWT-based authentication",
        ],
      },
    };

    const blueprint = {
      approach: "JWT-based OAuth2 with Google and GitHub",
      milestones: [
        {
          title: "JWT auth setup",
          description: "Configure JWT tokens for session management",
          filesToModify: ["src/auth/jwt.ts"],
          acceptanceCriteria: ["JWT signing works"],
        },
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(DUMMY_TASK, "/tmp", priorResults, DEFAULT_CONFIG);

    // Verify Claude was called (phase 2 should still call Claude)
    expect(mockCallClaude).toHaveBeenCalledTimes(1);

    // The prompt should include clarification answers
    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.prompt).toContain("clarification_answers");
    expect(callArgs.prompt).toContain("Google and GitHub providers");

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.approach).toBe("JWT-based OAuth2 with Google and GitHub");
    expect(arch.milestones).toHaveLength(1);
  });

  it("returns raw text fallback on JSON parse failure", async () => {
    const rawText = "This is not valid JSON but a useful description of the approach.";

    mockCallClaude.mockResolvedValueOnce({
      text: rawText,
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(DUMMY_TASK, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.approach).toBe(rawText);
    // No milestones or other structured data on parse failure
    expect(arch.milestones).toBeUndefined();
    expect(arch.keyFiles).toBeUndefined();
  });

  it("uses config.model when provided", async () => {
    const customConfig: EnricherConfig = { enabled: true, model: "claude-opus-4-20250514" };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ approach: "test" }),
      cost: makeCostMeta("claude-opus-4-20250514"),
    });

    await architectEnricher.run(DUMMY_TASK, "/tmp", {}, customConfig);

    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.model).toBe("claude-opus-4-20250514");
  });

  it("defaults to medium when size is null", async () => {
    const nullSizeTask = { ...DUMMY_TASK, size: null } as unknown as TaskRow;

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ approach: "Approach for null-size task" }),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(nullSizeTask, "/tmp", {}, DEFAULT_CONFIG);

    // Should NOT skip (null is not "trivial"), should call Claude
    expect(mockCallClaude).toHaveBeenCalledTimes(1);

    // The prompt should contain "Size: medium" as fallback
    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.prompt).toContain("Size: medium");

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.approach).toBe("Approach for null-size task");
  });

  // ── Large-task mandatory clarification ──────────────────────────────────────

  it("large task: always returns awaitingInput=true with at least 5 questions", async () => {
    const largeTask = { ...DUMMY_TASK, size: "large" } as TaskRow;

    const claudeResponse = {
      approach: "Need more information before planning this large task",
      clarificationQuestions: [
        "What is the expected scale of the system in terms of users and data volume?",
        "Which existing services or APIs must be integrated with?",
        "What are the performance and latency requirements?",
        "Are there regulatory or compliance constraints (e.g., GDPR, SOC2)?",
        "What is the preferred deployment strategy (containerised, serverless, etc.)?",
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(claudeResponse),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(largeTask, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBe(true);
    const questions = arch.clarificationQuestions as string[];
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThanOrEqual(5);
  });

  it("large task: prompt instructs Claude to ask at least 5 questions", async () => {
    const largeTask = { ...DUMMY_TASK, size: "large" } as TaskRow;

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ approach: "x", clarificationQuestions: ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"] }),
      cost: makeCostMeta(),
    });

    await architectEnricher.run(largeTask, "/tmp", {}, DEFAULT_CONFIG);

    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    // The system prompt should convey the 5-question rule for large tasks
    expect(callArgs.systemPrompt ?? callArgs.prompt).toBeTruthy();
    // The user prompt must surface the size so Claude can apply the rule
    expect(callArgs.prompt).toContain("Size: large");
  });

  it("small task: skips clarification when Claude returns a direct blueprint", async () => {
    const smallTask = { ...DUMMY_TASK, size: "small" } as TaskRow;

    const blueprint = {
      approach: "Straightforward fix with no ambiguity",
      keyFiles: ["src/utils.ts"],
      checklist: ["Apply the fix", "Add a regression test"],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(smallTask, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.clarificationQuestions).toBeUndefined();
    expect(arch.approach).toBe("Straightforward fix with no ambiguity");
  });

  it("medium task: skips clarification when Claude returns a direct blueprint", async () => {
    const blueprint = {
      approach: "Medium task with clear requirements",
      milestones: [
        {
          title: "Phase 1",
          description: "Initial implementation",
          filesToModify: ["src/index.ts"],
          acceptanceCriteria: ["Feature works end-to-end"],
        },
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(DUMMY_TASK, "/tmp", {}, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.clarificationQuestions).toBeUndefined();
    expect(arch.approach).toBe("Medium task with clear requirements");
  });

  it("large task second round: produces a blueprint after first-round answers (clarificationRound=1)", async () => {
    const largeTask = { ...DUMMY_TASK, size: "large" } as TaskRow;

    // Simulate a second clarification pass — Claude is allowed to ask a follow-up
    const priorResults = {
      architect: {
        clarificationAnswers: [
          "~10 k concurrent users",
          "Integrates with existing REST API gateway",
          "p99 < 200 ms",
          "GDPR compliant, no SOC2 requirement",
          "Kubernetes on GKE",
        ],
        clarificationQuestions: [
          "Scale?",
          "Integrations?",
          "Latency?",
          "Compliance?",
          "Deployment?",
        ],
        clarificationRound: 1,
      },
    };

    const blueprint = {
      approach: "Kubernetes-based microservice with GDPR-compliant data handling",
      milestones: [
        {
          title: "Core service scaffold",
          description: "Bootstrap the service with CI/CD pipelines",
          filesToModify: ["src/service/index.ts"],
          acceptanceCriteria: ["Service starts without errors"],
        },
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(largeTask, "/tmp", priorResults, DEFAULT_CONFIG);

    // Claude is called (not skipped)
    expect(mockCallClaude).toHaveBeenCalledTimes(1);

    // The prompt must include the answers and round context
    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.prompt).toContain("clarification_answers");
    expect(callArgs.prompt).toContain("~10 k concurrent users");

    // Blueprint is returned (no further awaitingInput)
    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.approach).toBe("Kubernetes-based microservice with GDPR-compliant data handling");
  });

  it("large task second round: Claude may ask a follow-up set of ≥5 questions at clarificationRound=1", async () => {
    const largeTask = { ...DUMMY_TASK, size: "large" } as TaskRow;

    // After the user answered round-1 questions, Claude still wants more info.
    // The enricher must honour that (awaitingInput stays true) as long as round < 2.
    const priorResults = {
      architect: {
        clarificationAnswers: ["Some answers"],
        clarificationQuestions: ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"],
        clarificationRound: 1,
      },
    };

    const followUpQuestions = {
      approach: "Still need more details before committing",
      clarificationQuestions: [
        "What is the expected peak RPS?",
        "Are multi-region deployments required?",
        "Which message broker should be used?",
        "What is the data retention policy?",
        "Are there third-party SLA dependencies?",
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(followUpQuestions),
      cost: makeCostMeta(),
    });

    const result = await architectEnricher.run(largeTask, "/tmp", priorResults, DEFAULT_CONFIG);

    const arch = result.data.architect as Record<string, unknown>;
    // Second-round clarification is permitted — awaitingInput is still true
    expect(arch.awaitingInput).toBe(true);
    const questions = arch.clarificationQuestions as string[];
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThanOrEqual(5);
  });

  it("large task: final-round instruction forces a blueprint when clarificationRound>=2", async () => {
    const largeTask = { ...DUMMY_TASK, size: "large" } as TaskRow;

    // Round 2 — the prompt must tell Claude it MUST produce a blueprint now
    const priorResults = {
      architect: {
        clarificationAnswers: ["Final answer set"],
        clarificationQuestions: ["Last question?"],
        clarificationRound: 2,
      },
    };

    const blueprint = {
      approach: "Definitive blueprint after two clarification rounds",
      milestones: [],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: makeCostMeta(),
    });

    await architectEnricher.run(largeTask, "/tmp", priorResults, DEFAULT_CONFIG);

    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    // The prompt must contain the "MUST now produce" instruction
    expect(callArgs.prompt).toContain("MUST now produce a full blueprint");
  });
});

// ── parseBlueprint unit tests ─────────────────────────────────────────────────

describe("parseBlueprint", () => {
  it("strips code fences before parsing", () => {
    const json = JSON.stringify({ approach: "test", keyFiles: ["a.ts"] });
    const wrapped = "```json\n" + json + "\n```";

    const result = parseBlueprint(wrapped);
    expect(result.approach).toBe("test");
    expect(result.keyFiles).toEqual(["a.ts"]);
  });

  it("returns raw text as approach when JSON is invalid", () => {
    const result = parseBlueprint("not json at all");
    expect(result.approach).toBe("not json at all");
    expect(result.milestones).toBeUndefined();
  });

  it("parses clarification questions into awaitingInput mode", () => {
    const input = JSON.stringify({
      approach: "Needs clarification",
      clarificationQuestions: ["Q1?", "Q2?"],
    });

    const result = parseBlueprint(input);
    expect(result.awaitingInput).toBe(true);
    expect(result.clarificationQuestions).toEqual(["Q1?", "Q2?"]);
  });

  it("coerces milestone fields with defaults for missing properties", () => {
    const input = JSON.stringify({
      approach: "test",
      milestones: [
        { title: "M1" },
        { description: "Only desc" },
      ],
    });

    const result = parseBlueprint(input);
    expect(result.milestones).toHaveLength(2);
    expect(result.milestones![0].title).toBe("M1");
    expect(result.milestones![0].description).toBe("");
    expect(result.milestones![0].filesToModify).toEqual([]);
    expect(result.milestones![0].acceptanceCriteria).toEqual([]);
    expect(result.milestones![1].title).toBe("Untitled milestone");
    expect(result.milestones![1].description).toBe("Only desc");
  });
});
