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

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { routeTask } = await import("../../src/agents/router.js");
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const { create: createTask, getById } = await import(
  "../../src/db/queries/tasks.js"
);
const { recordCost } = await import("../../src/db/queries/costs.js");
const { listActive } = await import(
  "../../src/db/queries/active-agents.js"
);

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedTask() {
  const user = await findOrCreateByEntraOid(
    "oid-router-test",
    "router@example.com",
    "Router User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return { user, repo, task };
}

function mockSuccessfulClassification() {
  mockCallClaude.mockResolvedValue({
    text: JSON.stringify({
      type: "bug",
      size: "small",
      workflow: "flow",
      model: "claude-sonnet-4-20250514",
      maxTurns: 10,
      maxBudgetUsd: 5.0,
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
      outputTokens: 50,
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("routeTask", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  // ── Successful classification ────────────────────────────────────────────

  it("classifies a pending task and transitions to queued", async () => {
    const { task } = await seedTask();
    mockSuccessfulClassification();

    const result = await routeTask(task.id);

    expect(result).toEqual({
      type: "bug",
      size: "small",
      workflow: "flow",
      model: "claude-opus-4-6",
      maxTurns: 10,
      maxBudgetUsd: 5.0,
    });

    // Verify task was updated
    const updated = await getById(task.id);
    expect(updated!.status).toBe("queued");
    expect(updated!.type).toBe("bug");
    expect(updated!.size).toBe("small");
    expect(updated!.workflow).toBe("flow");
    expect(updated!.model).toBe("claude-opus-4-6");
    expect(updated!.maxTurns).toBe(10);
    expect(parseFloat(updated!.maxBudgetUsd!)).toBeCloseTo(5.0, 2);
  });

  it("calls the SDK with the router prompt and task details", async () => {
    const { task } = await seedTask();
    mockSuccessfulClassification();

    await routeTask(task.id);

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const call = mockCallClaude.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-4-5-20251001");
    expect(call.prompt).toContain(task.title);
    expect(call.prompt).toContain(task.body);
    expect(call.systemPrompt).toContain("task router");
  });

  // ── Cost recording ───────────────────────────────────────────────────────

  it("records cost after classification", async () => {
    const { task, user } = await seedTask();
    mockSuccessfulClassification();

    await routeTask(task.id);

    // Verify a cost row was created — check via the DB
    const { db } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const rows = await db
      .select()
      .from(costs)
      .where(eq(costs.taskId, task.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("router");
    expect(rows[0].userId).toBe(user.id);
    expect(parseFloat(rows[0].costUsd)).toBeGreaterThan(0);
    expect(rows[0].turns).toBe(1);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Active agent lifecycle ───────────────────────────────────────────────

  it("unregisters active agent after success", async () => {
    const { task } = await seedTask();
    mockSuccessfulClassification();

    await routeTask(task.id);

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("unregisters active agent after failure", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockRejectedValue(new Error("API error"));

    await expect(routeTask(task.id)).rejects.toThrow("API error");

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it("throws when task not found", async () => {
    await expect(routeTask("HIVE-00000000-0000")).rejects.toThrow(
      "Task HIVE-00000000-0000 not found",
    );
  });

  it("throws when task is not pending", async () => {
    const { task } = await seedTask();
    // Manually transition to queued
    const { updateStatus } = await import("../../src/db/queries/tasks.js");
    await updateStatus(task.id, "queued");

    await expect(routeTask(task.id)).rejects.toThrow("not pending");
  });

  it("does not transition status on SDK failure", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockRejectedValue(new Error("API error"));

    await expect(routeTask(task.id)).rejects.toThrow("API error");

    // Task should still be pending
    const found = await getById(task.id);
    expect(found!.status).toBe("pending");
  });

  it("does not transition status on invalid JSON response", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockResolvedValue({
      text: "not valid json at all",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 10 },
    });

    await expect(routeTask(task.id)).rejects.toThrow();

    const found = await getById(task.id);
    expect(found!.status).toBe("pending");
  });

  // ── Classification parsing edge cases ────────────────────────────────────

  it("falls back to defaults for invalid classification values", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({
        type: "unknown-type",
        size: "huge",
        workflow: "invalid",
        model: "",
      }),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 10 },
    });

    const result = await routeTask(task.id);

    // Should fall back to config defaults
    expect(result.type).toBe("improvement"); // default from config
    expect(result.size).toBe("medium"); // default from config
    expect(result.workflow).toBe("flow"); // default fallback
    expect(result.model).toBe("claude-opus-4-6"); // worker component model from config
  });

  it("handles response wrapped in markdown code fences", async () => {
    const { task } = await seedTask();
    mockCallClaude.mockResolvedValue({
      text: '```json\n{"type":"feature","size":"medium","workflow":"flow","model":"claude-sonnet-4-20250514"}\n```',
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 10 },
    });

    const result = await routeTask(task.id);

    expect(result.type).toBe("feature");
    expect(result.size).toBe("medium");
  });
});
