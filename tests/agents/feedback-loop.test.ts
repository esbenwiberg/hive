import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks (must be declared before any imports that use them) ─────────────────

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("../../src/db/connection.js", () => ({
  db: {},
  pool: {},
}));

vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockConfig = {
  classification: { defaultType: "improvement", defaultSize: "medium" },
  gate: { mode: "ai" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    default: "claude-sonnet-4-20250514",
    components: {} as Record<string, string>,
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [],
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  getModelFor: (c: string) =>
    mockConfig.models.components[c] ?? mockConfig.models.default,
  loadConfig: () => mockConfig,
}));

vi.mock("../../src/db/queries/tasks.js", () => ({
  getById: vi.fn(),
}));

vi.mock("../../src/db/queries/costs.js", () => ({
  recordCost: vi.fn(),
}));

vi.mock("../../src/db/queries/active-agents.js", () => ({
  register: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("../../src/db/queries/learnings.js", () => ({
  reinforceLearning: vi.fn(),
  contradictLearning: vi.fn(),
  createLearning: vi.fn(),
  buildDismissedContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../src/db/queries/learning-events.js", () => ({
  recordEvent: vi.fn(),
}));

vi.mock("../../src/prompt-cache.js", () => ({
  loadPrompt: vi.fn().mockReturnValue("system prompt"),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { getById } = await import("../../src/db/queries/tasks.js");
const { register, unregister } = await import("../../src/db/queries/active-agents.js");
const logger = (await import("../../src/logger.js")).default;
const { extractJson, analyzeFeedback, shouldAllowClarificationRound, MAX_CLARIFICATION_ROUNDS } =
  await import("../../src/agents/feedback-loop.js");

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;
const mockGetById = getById as ReturnType<typeof vi.fn>;
const mockRegister = register as ReturnType<typeof vi.fn>;
const mockUnregister = unregister as ReturnType<typeof vi.fn>;
const mockLogger = logger as {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

// ── Shared test data ──────────────────────────────────────────────────────────

const fakeTask = {
  id: "HIVE-20260221-686e",
  title: "Fix login bug",
  body: "The login form crashes when empty email is submitted",
  createdBy: 1,
};

function stubClaude(text: string) {
  mockCallClaude.mockResolvedValue({
    text,
    cost: { model: "claude-sonnet-4-20250514", inputTokens: 800, outputTokens: 100 },
  });
}

// ── Unit tests for extractJson ────────────────────────────────────────────────

describe("extractJson", () => {
  it("returns a plain JSON object unchanged", () => {
    const input = '{"reinforceIds":[1],"contradictIds":[],"newLearnings":[]}';
    expect(extractJson(input)).toBe(input);
  });

  it("extracts JSON from markdown code fence (```json)", () => {
    const json = '{"reinforceIds":[1],"contradictIds":[],"newLearnings":[]}';
    const input = `\`\`\`json\n${json}\n\`\`\``;
    expect(extractJson(input)).toBe(json);
  });

  it("extracts JSON from plain markdown code fence (```)", () => {
    const json = '{"reinforceIds":[],"contradictIds":[2],"newLearnings":[]}';
    const input = `\`\`\`\n${json}\n\`\`\``;
    expect(extractJson(input)).toBe(json);
  });

  it("strips trailing non-JSON text after the closing brace", () => {
    const json = '{"reinforceIds":[1,5],"contradictIds":[3],"newLearnings":[]}';
    const trailing =
      "Here is the analysis. Note that learning 1 was effective because it guided the implementation correctly.";
    const input = `${json}\n${trailing}`;
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toMatchObject({ reinforceIds: [1, 5] });
  });

  it("extracts JSON when it is preceded by explanatory text", () => {
    const json = '{"reinforceIds":[],"contradictIds":[],"newLearnings":[]}';
    const input = `Here is my analysis:\n\n${json}\n\nLet me know if you need more details.`;
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toMatchObject({ reinforceIds: [] });
  });

  it("handles JSON embedded in markdown fence with trailing commentary (simulates position 1452 error)", () => {
    // Build a response with a large JSON payload followed by trailing text — this
    // reproduces the exact scenario where JSON.parse choked at position 1452.
    const bigJson = JSON.stringify({
      reinforceIds: [1, 2, 3, 4, 5],
      contradictIds: [],
      newLearnings: [
        {
          scope: "universal",
          category: "correctness",
          // Pad content to ensure the total JSON string length exceeds 1452 characters
          content: "A".repeat(400),
          tags: ["tag1", "tag2", "tag3"],
          confidence: 0.65,
        },
      ],
    });
    const input =
      `\`\`\`json\n${bigJson}\n\`\`\`` +
      `\n\nThis analysis is based on the task outcome and the injected learnings. The feedback loop identified several areas for improvement.`;
    const result = extractJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.reinforceIds).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.newLearnings).toHaveLength(1);
  });

  it("returns the text when no JSON brackets are found", () => {
    const input = "No JSON here at all";
    const result = extractJson(input);
    // Returns as-is so a subsequent JSON.parse will throw naturally
    expect(result).toBe("No JSON here at all");
  });

  it("correctly handles nested objects within JSON", () => {
    const payload = {
      reinforceIds: [1, 5],
      contradictIds: [3],
      newLearnings: [
        {
          scope: "universal",
          category: "correctness",
          content: "Always validate input parameters before DB operations",
          tags: ["validation", "database"],
          confidence: 0.60,
        },
      ],
    };
    const json = JSON.stringify(payload);
    const result = extractJson(json);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toMatchObject(payload);
  });

  it("handles strings containing braces inside JSON string values", () => {
    const json =
      '{"reinforceIds":[],"contradictIds":[],"newLearnings":[{"scope":"universal","category":"correctness","content":"Use {braces} carefully","tags":[],"confidence":0.5}]}';
    const result = extractJson(json);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.newLearnings[0].content).toBe("Use {braces} carefully");
  });

  it("handles escaped quotes inside JSON string values", () => {
    const json =
      '{"reinforceIds":[],"contradictIds":[],"newLearnings":[{"scope":"universal","category":"correctness","content":"Say \\"hello\\"","tags":[],"confidence":0.5}]}';
    const result = extractJson(json);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).newLearnings[0].content).toBe('Say "hello"');
  });

  it("extracts a JSON array when the top-level structure is an array", () => {
    const json = "[1, 2, 3]";
    const input = `Here is the array:\n${json}\nEnd.`;
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual([1, 2, 3]);
  });

  it("prefers object over array when object appears first", () => {
    const input = '{"key": [1,2,3]}';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ key: [1, 2, 3] });
  });
});

// ── Unit tests for parseFeedbackResult (via analyzeFeedback, mocked deps) ────

describe("parseFeedbackResult / analyzeFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(fakeTask);
    mockRegister.mockResolvedValue(undefined);
    mockUnregister.mockResolvedValue(undefined);
  });

  it("parses a clean JSON response without warning", async () => {
    stubClaude(JSON.stringify({ reinforceIds: [1], contradictIds: [], newLearnings: [] }));

    await analyzeFeedback(fakeTask.id, "pass", [1]);

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reinforced: 1, contradicted: 0 }),
      "Feedback loop complete",
    );
  });

  it("parses JSON wrapped in markdown code fences without warning", async () => {
    const json = JSON.stringify({ reinforceIds: [], contradictIds: [2], newLearnings: [] });
    stubClaude(`\`\`\`json\n${json}\n\`\`\``);

    await analyzeFeedback(fakeTask.id, "rework", [2]);

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ contradicted: 1 }),
      "Feedback loop complete",
    );
  });

  it("parses JSON with trailing commentary text without warning", async () => {
    const json = JSON.stringify({ reinforceIds: [], contradictIds: [], newLearnings: [] });
    stubClaude(`${json}\n\nThe above JSON represents my analysis of the task outcome.`);

    await analyzeFeedback(fakeTask.id, "pass", []);

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reinforced: 0, contradicted: 0, newLearnings: 0 }),
      "Feedback loop complete",
    );
  });

  it("logs a warning and returns empty result for completely unparseable input", async () => {
    stubClaude("This is not JSON at all — the model returned plain text only.");

    // Does NOT throw — parseFeedbackResult catches the error and returns defaults
    await expect(analyzeFeedback(fakeTask.id, "pass", [])).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rawPreview: expect.any(String) }),
      "feedback-loop: failed to parse JSON response — skipping learning updates",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reinforced: 0, contradicted: 0, newLearnings: 0 }),
      "Feedback loop complete",
    );
  });

  it("logs a warning for structurally broken JSON (missing comma)", async () => {
    // Simulate a truncated/malformed LLM response that extractJson cannot repair
    stubClaude('{"reinforceIds": [1, 2] "contradictIds": []}');

    await expect(analyzeFeedback(fakeTask.id, "fail", [1, 2])).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rawPreview: expect.any(String) }),
      "feedback-loop: failed to parse JSON response — skipping learning updates",
    );
  });

  it("always unregisters the active agent even when JSON parse fails", async () => {
    stubClaude("totally not JSON");

    await analyzeFeedback(fakeTask.id, "pass", []);

    expect(mockUnregister).toHaveBeenCalledWith(fakeTask.id);
  });

  it("always unregisters the active agent when SDK throws", async () => {
    mockCallClaude.mockRejectedValue(new Error("SDK error"));

    await expect(analyzeFeedback(fakeTask.id, "pass", [])).rejects.toThrow("SDK error");

    expect(mockUnregister).toHaveBeenCalledWith(fakeTask.id);
  });

  // ── Multi-round clarification for large tasks ─────────────────────────────

  it("large task: second clarification round is permitted when clarificationRound=1", async () => {
    // Drive the real enricher: after the user supplied round-1 answers Claude is still
    // allowed to return a second batch of ≥5 questions (clarificationRound=1 in
    // priorResults means we are entering round 2, which is still within the 2-round cap).
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const priorResults = {
      architect: {
        clarificationAnswers: [
          "~10 k concurrent users",
          "REST API gateway integration",
          "p99 < 200 ms",
          "GDPR compliant",
          "Kubernetes on GKE",
        ],
        clarificationQuestions: ["Scale?", "Integrations?", "Latency?", "Compliance?", "Deploy?"],
        clarificationRound: 1,
      },
    };

    const secondRoundQuestions = {
      approach: "Need one more pass of clarification",
      clarificationQuestions: [
        "What is the expected peak RPS?",
        "Are multi-region deployments required?",
        "Which message broker should be used?",
        "What is the data retention policy?",
        "Are there third-party SLA dependencies?",
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(secondRoundQuestions),
      cost: { inputTokens: 100, outputTokens: 200, model: "claude-test" },
    });

    const largeTask = {
      id: "task-large-round1",
      title: "Large feature request",
      body: "Build a distributed event processing pipeline.",
      size: "large",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(largeTask as never, "/tmp", priorResults, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    // Second round of clarification is permitted — awaitingInput must still be true
    expect(arch.awaitingInput).toBe(true);
    const questions = arch.clarificationQuestions as string[];
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThanOrEqual(5);
  });

  it("large task: third attempt produces a blueprint — clarification capped at 2 rounds", async () => {
    // When clarificationRound >= 2, the enricher prompt instructs Claude to produce a
    // blueprint unconditionally.  We verify this by checking that parseBlueprint with
    // hasAnswers=true never returns awaitingInput=true.
    const { parseBlueprint } = await import("../../src/enrichers/architect.js");

    const claudeOutputWithQuestions = JSON.stringify({
      approach: "Still want more info",
      clarificationQuestions: ["One more question?"],
    });

    // hasAnswers=true mimics the state at round 2+ (answers were provided, so
    // the enricher passes hasAnswers=true forcing parseBlueprint to skip clarification)
    const result = parseBlueprint(claudeOutputWithQuestions, true);

    expect(result.awaitingInput).toBeUndefined();
    expect(result.clarificationQuestions).toBeUndefined();
    expect(result.approach).toBe("Still want more info");
  });

  it("large task: cap enforced end-to-end — enricher returns blueprint at clarificationRound=2", async () => {
    // Drive the real enricher at round 2 to confirm that even if Claude tries to ask
    // more questions, the enricher strips them and returns a proper blueprint.
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const priorResults = {
      architect: {
        clarificationAnswers: ["Final answer batch"],
        clarificationQuestions: ["Last question?"],
        clarificationRound: 2,
      },
    };

    // Claude still tries to ask more questions — the enricher must ignore them
    const stubbornClaude = JSON.stringify({
      approach: "Reluctant blueprint",
      clarificationQuestions: ["Yet another question?"],
    });

    mockCallClaude.mockResolvedValueOnce({
      text: stubbornClaude,
      cost: { inputTokens: 100, outputTokens: 200, model: "claude-test" },
    });

    const largeTask = {
      id: "task-large-round2-cap",
      title: "Large task hitting the cap",
      body: "Must produce a blueprint by now.",
      size: "large",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(largeTask as never, "/tmp", priorResults, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    // At round 2 the cap is enforced — no more clarification
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.clarificationQuestions).toBeUndefined();
    expect(arch.approach).toBe("Reluctant blueprint");
  });

  it("large task: second-round user prompt contains 'MUST now produce' when clarificationRound>=2", async () => {
    // Smoke-test that the buildUserPrompt logic emits the mandatory blueprint instruction
    // at round 2.  We drive this through the full enricher so we test the real code path.
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const priorResults = {
      architect: {
        clarificationAnswers: ["Some final answers"],
        clarificationQuestions: ["A question?"],
        clarificationRound: 2,
      },
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ approach: "Blueprint after two rounds", milestones: [] }),
      cost: { inputTokens: 100, outputTokens: 200, model: "claude-test" },
    });

    const largeTask = {
      id: "task-large-round2",
      title: "Large task reaching cap",
      body: "Detailed description.",
      size: "large",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    await architectEnricher.run(largeTask as never, "/tmp", priorResults, { model: "claude-test" });

    const callArgs = mockCallClaude.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.prompt).toContain("MUST now produce a full blueprint");
  });

  it("small task: skips clarification and produces a blueprint directly", async () => {
    // Small tasks must never block on awaitingInput — the enricher must produce a
    // blueprint regardless of task complexity signals in the prompt.
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const blueprint = {
      approach: "Simple direct implementation",
      keyFiles: ["src/utils.ts"],
      checklist: ["Implement helper function", "Add unit test"],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: { inputTokens: 50, outputTokens: 100, model: "claude-test" },
    });

    const smallTask = {
      id: "task-small",
      title: "Fix typo in README",
      body: "There is a typo on line 42.",
      size: "small",
      type: "chore",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(smallTask as never, "/tmp", {}, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    // Small task must never produce awaitingInput
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.approach).toBe("Simple direct implementation");
  });

  it("medium task: skips clarification when architect considers the task clear", async () => {
    // Medium tasks should not block on clarification unless the architect explicitly
    // deems them unclear.  When Claude returns a blueprint directly, it must be accepted.
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const blueprint = {
      approach: "Straightforward medium task implementation",
      keyFiles: ["src/feature.ts"],
      checklist: ["Add feature", "Write tests", "Update docs"],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(blueprint),
      cost: { inputTokens: 80, outputTokens: 150, model: "claude-test" },
    });

    const mediumTask = {
      id: "task-medium",
      title: "Add pagination to list endpoint",
      body: "The /users endpoint needs cursor-based pagination.",
      size: "medium",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(mediumTask as never, "/tmp", {}, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    // Medium task without questions must produce a blueprint immediately
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.approach).toBe("Straightforward medium task implementation");
  });

  it("throws when task is not found", async () => {
    mockGetById.mockResolvedValue(null);

    await expect(analyzeFeedback("HIVE-00000000-0000", "pass", [])).rejects.toThrow(
      "Task HIVE-00000000-0000 not found",
    );
  });

  // ── Milestone 3 acceptance criteria (feedback-loop perspective) ─────────────

  // AC-1 (feedback-loop view): when task size is 'large' and no prior answers exist,
  // the enricher output must carry awaitingInput=true with ≥5 questions.
  it("AC-1: large task — enricher returns awaitingInput=true with ≥5 questions on first call", async () => {
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const claudeResponse = {
      approach: "Need clarification before planning",
      clarificationQuestions: [
        "What is the expected scale?",
        "Which services must be integrated?",
        "What are the latency requirements?",
        "Are there compliance constraints?",
        "What is the deployment strategy?",
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(claudeResponse),
      cost: { inputTokens: 100, outputTokens: 200, model: "claude-test" },
    });

    const largeTask = {
      id: "task-ac1-fl",
      title: "Large feature",
      body: "Build a distributed pipeline.",
      size: "large",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(largeTask as never, "/tmp", {}, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBe(true);
    const questions = arch.clarificationQuestions as string[];
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThanOrEqual(5);
  });

  // AC-2 (feedback-loop view): the feedback loop permits a second clarification round.
  it("AC-2: feedback loop permits a second clarification round for large tasks", async () => {
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    // priorResults simulates state after the user answered round-1 questions
    const priorResults = {
      architect: {
        clarificationAnswers: ["Ans 1", "Ans 2", "Ans 3", "Ans 4", "Ans 5"],
        clarificationQuestions: ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"],
        clarificationRound: 1,
      },
    };

    const secondRound = {
      approach: "Still clarifying",
      clarificationQuestions: [
        "Peak load?",
        "Multi-region?",
        "Message broker?",
        "Data retention?",
        "SLA deps?",
      ],
    };

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify(secondRound),
      cost: { inputTokens: 100, outputTokens: 200, model: "claude-test" },
    });

    const largeTask = {
      id: "task-ac2-fl",
      title: "Large feature round 2",
      body: "Build a distributed pipeline.",
      size: "large",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(largeTask as never, "/tmp", priorResults, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    // Second round is permitted
    expect(arch.awaitingInput).toBe(true);
    expect((arch.clarificationQuestions as string[]).length).toBeGreaterThanOrEqual(5);
  });

  // AC-3 (feedback-loop view): the feedback loop caps clarification at 2 rounds;
  // a third attempt (clarificationRound=2) forces a blueprint.
  it("AC-3: feedback loop caps clarification at 2 rounds — third attempt produces a blueprint", async () => {
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    const priorResults = {
      architect: {
        clarificationAnswers: ["Final answers"],
        clarificationQuestions: ["Last round question?"],
        clarificationRound: 2,
      },
    };

    // Claude still tries to ask more questions
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        approach: "Forced blueprint at round cap",
        clarificationQuestions: ["Ignored question?"],
      }),
      cost: { inputTokens: 100, outputTokens: 200, model: "claude-test" },
    });

    const largeTask = {
      id: "task-ac3-fl",
      title: "Large task at cap",
      body: "Must produce blueprint now.",
      size: "large",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(largeTask as never, "/tmp", priorResults, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    // Cap enforced — no further clarification
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.clarificationQuestions).toBeUndefined();
    expect(arch.approach).toBe("Forced blueprint at round cap");
  });

  // AC-4a (feedback-loop view): small tasks skip clarification
  it("AC-4a: small task — skips clarification and produces a blueprint directly", async () => {
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        approach: "Quick fix for small task",
        keyFiles: ["src/small.ts"],
        checklist: ["Fix it", "Test it"],
      }),
      cost: { inputTokens: 50, outputTokens: 80, model: "claude-test" },
    });

    const smallTask = {
      id: "task-ac4a-fl",
      title: "Tiny fix",
      body: "Fix a one-line bug.",
      size: "small",
      type: "bug",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(smallTask as never, "/tmp", {}, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.clarificationQuestions).toBeUndefined();
    expect(arch.approach).toBe("Quick fix for small task");
  });

  // AC-4b (feedback-loop view): medium tasks skip clarification when task is clear
  it("AC-4b: medium task — skips clarification when architect deems the task clear", async () => {
    const { architectEnricher } = await import("../../src/enrichers/architect.js");

    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        approach: "Clear medium task plan",
        keyFiles: ["src/medium.ts"],
        checklist: ["Implement", "Test", "Document"],
      }),
      cost: { inputTokens: 70, outputTokens: 120, model: "claude-test" },
    });

    const mediumTask = {
      id: "task-ac4b-fl",
      title: "Medium feature",
      body: "Add a well-specified feature.",
      size: "medium",
      type: "feature",
      severity: null,
      repoId: 1,
      createdBy: "user-1",
    };

    const result = await architectEnricher.run(mediumTask as never, "/tmp", {}, { model: "claude-test" });

    const arch = result.data.architect as Record<string, unknown>;
    expect(arch.awaitingInput).toBeUndefined();
    expect(arch.clarificationQuestions).toBeUndefined();
    expect(arch.approach).toBe("Clear medium task plan");
  });
});

// ── shouldAllowClarificationRound ─────────────────────────────────────────────

describe("shouldAllowClarificationRound", () => {
  it("returns true for a large task after 0 completed rounds (round 1 allowed)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("large", 0)).toBe(true);
  });

  it("returns true for a large task after 1 completed round (round 2 allowed)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("large", 1)).toBe(true);
  });

  it("returns false for a large task after 2 completed rounds (cap reached)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("large", 2)).toBe(false);
  });

  it("returns true for a medium task after 0 completed rounds (round 1 allowed)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("medium", 0)).toBe(true);
  });

  it("returns false for a medium task after 1 completed round (cap reached, only 1 round)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("medium", 1)).toBe(false);
  });

  it("returns false for a small task after 1 completed round (cap reached, only 1 round)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("small", 1)).toBe(false);
  });

  it("returns true for a small task after 0 completed rounds (first round allowed)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("small", 0)).toBe(true);
  });

  it("defaults to 1 round for unknown task sizes", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound("unknown", 0)).toBe(true);
    expect(shouldAllowClarificationRound("unknown", 1)).toBe(false);
  });

  it("treats null/undefined task size as medium (1 round)", async () => {
    const { shouldAllowClarificationRound } = await import("../../src/agents/feedback-loop.js");
    expect(shouldAllowClarificationRound(null, 0)).toBe(true);
    expect(shouldAllowClarificationRound(null, 1)).toBe(false);
    expect(shouldAllowClarificationRound(undefined, 0)).toBe(true);
    expect(shouldAllowClarificationRound(undefined, 1)).toBe(false);
  });
});

// ── MAX_CLARIFICATION_ROUNDS ──────────────────────────────────────────────────

describe("MAX_CLARIFICATION_ROUNDS", () => {
  it("allows 2 rounds for large tasks", async () => {
    const { MAX_CLARIFICATION_ROUNDS } = await import("../../src/agents/feedback-loop.js");
    expect(MAX_CLARIFICATION_ROUNDS["large"]).toBe(2);
  });

  it("allows 1 round for medium tasks", async () => {
    const { MAX_CLARIFICATION_ROUNDS } = await import("../../src/agents/feedback-loop.js");
    expect(MAX_CLARIFICATION_ROUNDS["medium"]).toBe(1);
  });

  it("allows 1 round for small tasks", async () => {
    const { MAX_CLARIFICATION_ROUNDS } = await import("../../src/agents/feedback-loop.js");
    expect(MAX_CLARIFICATION_ROUNDS["small"]).toBe(1);
  });

  it("allows 1 round for trivial tasks", async () => {
    const { MAX_CLARIFICATION_ROUNDS } = await import("../../src/agents/feedback-loop.js");
    expect(MAX_CLARIFICATION_ROUNDS["trivial"]).toBe(1);
  });
});
