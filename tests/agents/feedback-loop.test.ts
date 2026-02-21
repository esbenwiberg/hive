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
const { extractJson, analyzeFeedback } = await import("../../src/agents/feedback-loop.js");

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

  it("throws when task is not found", async () => {
    mockGetById.mockResolvedValue(null);

    await expect(analyzeFeedback("HIVE-00000000-0000", "pass", [])).rejects.toThrow(
      "Task HIVE-00000000-0000 not found",
    );
  });
});
