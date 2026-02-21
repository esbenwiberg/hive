import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SDK so we never call the real Anthropic API
vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

// Mock db/connection.js so queries use our test database
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Mock the logger so tests don't produce output
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the autonomous config
const mockConfig = {
  classification: { defaultType: "improvement", defaultSize: "medium" },
  gate: { mode: "auto" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    default: "claude-sonnet-4-20250514",
    components: {},
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [] as Array<{ name: string; enabled: boolean }>,
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  getModelFor: (c: string) => mockConfig.models.components[c] ?? mockConfig.models.default,
  loadConfig: () => mockConfig,
}));

// Mock node:fs for prompt loading
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "You are an epic decomposer. Return JSON array of milestones."),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { decomposeEpic } = await import("../../src/agents/decomposer.js");
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const { create: createTask } = await import("../../src/db/queries/tasks.js");
const { listActive } = await import(
  "../../src/db/queries/active-agents.js"
);

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedTask() {
  const user = await findOrCreateByEntraOid(
    "oid-decomposer-test",
    "decomposer@example.com",
    "Decomposer User",
  );
  const repo = await findOrCreateRepo("github", "acme/epic-repo");
  const task = await createTask({
    title: "Build user authentication system",
    body: "Complete auth system with login, registration, and password reset",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
    workflow: "epic",
  });
  return { user, repo, task };
}

const sampleMilestones = [
  { title: "Milestone 1: Login flow", body: "Implement login form and auth API" },
  { title: "Milestone 2: Registration", body: "Implement registration with email verification" },
  { title: "Milestone 3: Password reset", body: "Implement password reset flow" },
];

function mockDecomposeResponse(milestones: Array<{ title: string; body: string }> = sampleMilestones) {
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify(milestones),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1500,
      outputTokens: 300,
    },
  });
}

function mockDecomposeResponseCodeFenced(milestones: Array<{ title: string; body: string }> = sampleMilestones) {
  mockCallClaude.mockResolvedValueOnce({
    text: "```json\n" + JSON.stringify(milestones) + "\n```",
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1500,
      outputTokens: 300,
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("decomposeEpic", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("returns parsed milestones from Claude response", async () => {
    const { task } = await seedTask();
    mockDecomposeResponse();

    const result = await decomposeEpic(task.id);

    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("Milestone 1: Login flow");
    expect(result[0].body).toBe("Implement login form and auth API");
    expect(result[1].title).toBe("Milestone 2: Registration");
    expect(result[2].title).toBe("Milestone 3: Password reset");
  });

  it("sets correct index and total on each milestone", async () => {
    const { task } = await seedTask();
    mockDecomposeResponse();

    const result = await decomposeEpic(task.id);

    expect(result[0].index).toBe(0);
    expect(result[0].total).toBe(3);
    expect(result[1].index).toBe(1);
    expect(result[1].total).toBe(3);
    expect(result[2].index).toBe(2);
    expect(result[2].total).toBe(3);
  });

  it("handles code-fenced JSON responses", async () => {
    const { task } = await seedTask();
    mockDecomposeResponseCodeFenced();

    const result = await decomposeEpic(task.id);

    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("Milestone 1: Login flow");
  });

  it("records cost", async () => {
    const { task, user } = await seedTask();
    mockDecomposeResponse();

    await decomposeEpic(task.id);

    const { db } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const rows = await db
      .select()
      .from(costs)
      .where(eq(costs.taskId, task.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("decomposer");
    expect(rows[0].userId).toBe(user.id);
    expect(parseFloat(rows[0].costUsd)).toBeGreaterThan(0);
    expect(rows[0].turns).toBe(1);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("registers and unregisters active agent", async () => {
    const { task } = await seedTask();
    mockDecomposeResponse();

    await decomposeEpic(task.id);

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("unregisters active agent on error", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockRejectedValueOnce(new Error("API error"));

    await expect(decomposeEpic(task.id)).rejects.toThrow("API error");

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("throws when task not found", async () => {
    // register() will fail because the taskId FK doesn't exist
    await expect(decomposeEpic("HIVE-00000000-0000")).rejects.toThrow();
  });

  it("throws when response is not an array", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ milestones: "not an array" }),
      cost: {
        model: "claude-sonnet-4-20250514",
        inputTokens: 1500,
        outputTokens: 100,
      },
    });

    await expect(decomposeEpic(task.id)).rejects.toThrow("Decomposer response is not an array");
  });

  it("handles milestones with missing fields gracefully", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify([
        { title: "First milestone" },
        {},
      ]),
      cost: {
        model: "claude-sonnet-4-20250514",
        inputTokens: 1500,
        outputTokens: 100,
      },
    });

    const result = await decomposeEpic(task.id);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("First milestone");
    expect(result[0].body).toBe("");
    expect(result[1].title).toBe("Milestone 2");
    expect(result[1].body).toBe("");
  });

  it("calls callClaude with milestone prompt and epic info", async () => {
    const { task } = await seedTask();
    mockDecomposeResponse();

    await decomposeEpic(task.id);

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain("Build user authentication system");
    expect(call.prompt).toContain("Break this epic into ordered milestones");
    expect(call.model).toBe("claude-sonnet-4-20250514");
    expect(call.systemPrompt).toBeDefined();
  });
});
