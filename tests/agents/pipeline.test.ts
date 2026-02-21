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

// Mock the autonomous config so we can control gate mode per test
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

// Mock the worker module so the pipeline's Step 6 (execution) doesn't run real worker logic
const mockExecuteTask = vi.fn().mockResolvedValue({ success: true });
const mockExecuteEpic = vi.fn().mockResolvedValue({ success: true });

vi.mock("../../src/execution/worker.js", () => ({
  executeTask: mockExecuteTask,
  executeEpic: mockExecuteEpic,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { runPipeline } = await import("../../src/agents/pipeline.js");
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

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedPendingTask() {
  const user = await findOrCreateByEntraOid(
    "oid-pipeline-test",
    "pipeline@example.com",
    "Pipeline User",
  );
  const repo = await findOrCreateRepo("github", "acme/pipeline-repo");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

function mockRouterResponse() {
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({
      type: "bug",
      size: "small",
      workflow: "flow",
      model: "claude-sonnet-4-20250514",
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
      outputTokens: 50,
    },
  });
}

function mockGateApproveResponse() {
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({
      verdict: "approve",
      reasoning: "Task is clear and low-risk",
      confidence: 0.95,
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 800,
      outputTokens: 60,
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runPipeline", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
    // Reset config to auto mode with no enrichers configured (all enabled by default)
    mockConfig.gate.mode = "auto";
    mockConfig.enrichers = [];
    // Reset worker mocks to default behavior
    mockExecuteTask.mockResolvedValue({ success: true });
    mockExecuteEpic.mockResolvedValue({ success: true });
  });

  // ── Full pipeline success ─────────────────────────────────────────────────

  it("runs full pipeline: pending -> queued -> enriching -> approved (auto-approve small)", async () => {
    const { task } = await seedPendingTask();
    mockRouterResponse(); // Router classifies as "small"

    // In auto mode, small tasks are auto-approved; no gate LLM call needed
    await runPipeline(task.id);

    const final = await getById(task.id);
    expect(final!.status).toBe("approved");
    expect(final!.type).toBe("bug");
    expect(final!.size).toBe("small");
    expect(final!.workflow).toBe("flow");
  });

  it("skips enrichment when repo directory does not exist", async () => {
    const { task } = await seedPendingTask();
    mockRouterResponse();

    await runPipeline(task.id);

    const final = await getById(task.id);
    // Enrichment should be null since repo dir doesn't exist
    expect(final!.enrichment).toBeNull();
  });

  it("records costs for the pipeline", async () => {
    const { task, user } = await seedPendingTask();
    mockRouterResponse();

    await runPipeline(task.id);

    // Verify cost rows were created (at least one from the router)
    const { db } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const rows = await db
      .select()
      .from(costs)
      .where(eq(costs.taskId, task.id));

    // At least the router cost should be recorded
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].agent).toBe("router");
    expect(rows[0].userId).toBe(user.id);
  });

  it("unregisters all active agents after pipeline completes", async () => {
    const { task } = await seedPendingTask();
    mockRouterResponse();

    await runPipeline(task.id);

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  // ── AI gate mode ──────────────────────────────────────────────────────────

  it("runs AI gate for medium/large tasks in auto mode", async () => {
    const { task } = await seedPendingTask();

    // Router returns medium size
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({
        type: "feature",
        size: "medium",
        workflow: "flow",
        model: "claude-sonnet-4-20250514",
      }),
      cost: {
        model: "claude-sonnet-4-20250514",
        inputTokens: 500,
        outputTokens: 50,
      },
    });

    // Gate AI evaluation
    mockGateApproveResponse();

    await runPipeline(task.id);

    const final = await getById(task.id);
    expect(final!.status).toBe("approved");
    // Both router + gate should have called the SDK
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it("transitions to ready in human gate mode", async () => {
    mockConfig.gate.mode = "human";
    const { task } = await seedPendingTask();
    mockRouterResponse();

    await runPipeline(task.id);

    const final = await getById(task.id);
    expect(final!.status).toBe("ready");
    // Only router should have called the SDK (gate doesn't call in human mode)
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("sets failure reason when router fails (pending can't transition to failed)", async () => {
    const { task } = await seedPendingTask();
    mockCallClaude.mockRejectedValueOnce(new Error("API error"));

    await runPipeline(task.id);

    const final = await getById(task.id);
    // pending -> failed is not an allowed state-machine transition,
    // so the task stays pending but failureReason is still recorded
    expect(final!.status).toBe("pending");
    expect(final!.failureReason).toBe("API error");
  });

  it("transitions task to failed when gate fails", async () => {
    mockConfig.gate.mode = "ai";
    const { task } = await seedPendingTask();
    mockRouterResponse();
    // Gate fails
    mockCallClaude.mockRejectedValueOnce(new Error("Gate API error"));

    await runPipeline(task.id);

    const final = await getById(task.id);
    expect(final!.status).toBe("failed");
    expect(final!.failureReason).toBe("Gate API error");
  });

  it("throws when task not found", async () => {
    await expect(runPipeline("HIVE-00000000-0000")).rejects.toThrow(
      "Pipeline: task HIVE-00000000-0000 not found",
    );
  });

  it("throws when task is not pending", async () => {
    const { task } = await seedPendingTask();
    await updateStatus(task.id, "queued");

    await expect(runPipeline(task.id)).rejects.toThrow("not pending");
  });
});
