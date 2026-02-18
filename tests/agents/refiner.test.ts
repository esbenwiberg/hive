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
  gate: { mode: "ai" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    router: "claude-sonnet-4-20250514",
    gate: "claude-sonnet-4-20250514",
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [],
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { refineTask } = await import("../../src/agents/refiner.js");
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const {
  create: createTask,
  getById,
  updateStatus,
} = await import("../../src/db/queries/tasks.js");
const { listActive } = await import(
  "../../src/db/queries/active-agents.js"
);

import type { ReviewGateResult } from "../../src/domain/types.js";

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedTask() {
  const user = await findOrCreateByEntraOid(
    "oid-refiner-test",
    "refiner@example.com",
    "Refiner User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });

  const updated = await getById(task.id);
  return { user, repo, task: updated! };
}

const sampleReviewResult: ReviewGateResult = {
  verdict: "rework",
  findings: [
    { severity: "major", file: "src/auth.ts", line: 42, message: "Missing null check", category: "correctness" },
    { severity: "minor", file: "src/utils.ts", message: "Unused import", category: "style" },
  ],
  securityFindings: [
    { severity: "medium", type: "auth", description: "Token not validated", file: "src/auth.ts" },
  ],
  verification: {
    testsRun: true,
    testsPassed: false,
    lintClean: true,
    buildSucceeded: true,
    notes: ["2 tests failed"],
  },
  costUsd: 0.005,
};

function mockRefinerResponse(text = "1. Add null check to auth.ts:42\n2. Remove unused import in utils.ts\n3. Add token validation") {
  mockCallClaude.mockResolvedValue({
    text,
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 900,
      outputTokens: 120,
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("refineTask", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("returns refined instructions from Claude", async () => {
    const { task } = await seedTask();
    mockRefinerResponse();

    const instructions = await refineTask(task.id, sampleReviewResult);

    expect(instructions).toContain("Add null check");
    expect(instructions).toContain("Remove unused import");
    expect(instructions).toContain("Add token validation");
  });

  it("increments reworkCount", async () => {
    const { task } = await seedTask();
    mockRefinerResponse();

    await refineTask(task.id, sampleReviewResult);

    const updated = await getById(task.id);
    expect(updated!.reworkCount).toBe(1);
  });

  it("increments reworkCount on subsequent calls", async () => {
    const { task } = await seedTask();
    mockRefinerResponse("First refinement");

    await refineTask(task.id, sampleReviewResult);

    let updated = await getById(task.id);
    expect(updated!.reworkCount).toBe(1);

    // Second rework cycle
    mockRefinerResponse("Second refinement");
    await refineTask(task.id, sampleReviewResult);

    updated = await getById(task.id);
    expect(updated!.reworkCount).toBe(2);
  });

  it("appends to reworkHistory", async () => {
    const { task } = await seedTask();
    mockRefinerResponse("Fix the null check");

    await refineTask(task.id, sampleReviewResult);

    const updated = await getById(task.id);
    const history = updated!.reworkHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0].cycle).toBe(1);
    expect(history[0].refinedInstructions).toBe("Fix the null check");
    expect(history[0].findings).toEqual(sampleReviewResult.findings);
    expect(history[0].securityFindings).toEqual(sampleReviewResult.securityFindings);
    expect(history[0].timestamp).toBeDefined();
  });

  it("updates retryInstructions on the task", async () => {
    const { task } = await seedTask();
    mockRefinerResponse("New retry instructions here");

    await refineTask(task.id, sampleReviewResult);

    const updated = await getById(task.id);
    expect(updated!.retryInstructions).toBe("New retry instructions here");
  });

  it("records cost", async () => {
    const { task, user } = await seedTask();
    mockRefinerResponse();

    await refineTask(task.id, sampleReviewResult);

    // Verify a cost row was created
    const { db } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const rows = await db
      .select()
      .from(costs)
      .where(eq(costs.taskId, task.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("refiner");
    expect(rows[0].userId).toBe(user.id);
    expect(parseFloat(rows[0].costUsd)).toBeGreaterThan(0);
    expect(rows[0].turns).toBe(1);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("registers and unregisters active agent", async () => {
    const { task } = await seedTask();
    mockRefinerResponse();

    await refineTask(task.id, sampleReviewResult);

    // After completion, no active agents should remain
    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("unregisters active agent after failure", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockRejectedValue(new Error("API error"));

    await expect(refineTask(task.id, sampleReviewResult)).rejects.toThrow("API error");

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("throws when task not found", async () => {
    mockRefinerResponse();

    // register() is called before getById(), so the FK constraint on
    // active_agents.task_id fires first for a non-existent task id.
    await expect(
      refineTask("HIVE-00000000-0000", sampleReviewResult),
    ).rejects.toThrow();
  });

  it("calls callClaude with review findings in the prompt", async () => {
    const { task } = await seedTask();
    mockRefinerResponse();

    await refineTask(task.id, sampleReviewResult);

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain("Missing null check");
    expect(call.prompt).toContain("Unused import");
    expect(call.prompt).toContain("Token not validated");
    expect(call.prompt).toContain(task.title);
  });

  it("includes previous retry instructions in the prompt", async () => {
    const { task } = await seedTask();
    mockRefinerResponse("First refinement");
    await refineTask(task.id, sampleReviewResult);

    // Second call should include previous retry instructions
    mockRefinerResponse("Second refinement");
    await refineTask(task.id, sampleReviewResult);

    const secondCall = mockCallClaude.mock.calls[1][0];
    expect(secondCall.prompt).toContain("First refinement");
  });
});
