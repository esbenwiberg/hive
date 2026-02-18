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
  gate: { mode: "ai" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  enrichers: [],
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { evaluateGate } = await import("../../src/agents/gate.js");
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
  updateClassification,
} = await import("../../src/db/queries/tasks.js");
const { listByTask: listGateDecisions } = await import(
  "../../src/db/queries/gate-decisions.js"
);
const { listActive } = await import(
  "../../src/db/queries/active-agents.js"
);

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedEnrichingTask(opts?: { size?: string; type?: string }) {
  const user = await findOrCreateByEntraOid(
    "oid-gate-test",
    "gate@example.com",
    "Gate User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });

  // Route: pending -> queued -> enriching
  await updateStatus(task.id, "queued");
  await updateStatus(task.id, "enriching");

  // Set classification if provided
  if (opts?.size || opts?.type) {
    await updateClassification(task.id, {
      type: opts.type ?? "bug",
      size: opts.size ?? "medium",
      model: "claude-sonnet-4-20250514",
      workflow: "flow",
    });
  }

  const updated = await getById(task.id);
  return { user, repo, task: updated! };
}

function mockApproveResponse() {
  mockCallClaude.mockResolvedValue({
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

function mockRejectResponse() {
  mockCallClaude.mockResolvedValue({
    text: JSON.stringify({
      verdict: "reject",
      reasoning: "Task is too risky for autonomous execution",
      confidence: 0.85,
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 800,
      outputTokens: 60,
    },
  });
}

function mockReworkResponse() {
  mockCallClaude.mockResolvedValue({
    text: JSON.stringify({
      verdict: "rework",
      reasoning: "Task description needs more detail",
      confidence: 0.7,
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 800,
      outputTokens: 60,
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("evaluateGate", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
    // Reset to AI mode by default
    mockConfig.gate.mode = "ai";
  });

  // ── AI mode: approve ───────────────────────────────────────────────────────

  describe("AI mode", () => {
    it("approves a task and transitions to approved", async () => {
      const { task } = await seedEnrichingTask();
      mockApproveResponse();

      await evaluateGate(task.id);

      const updated = await getById(task.id);
      expect(updated!.status).toBe("approved");
    });

    it("rejects a task and transitions to rejected", async () => {
      const { task } = await seedEnrichingTask();
      mockRejectResponse();

      await evaluateGate(task.id);

      const updated = await getById(task.id);
      expect(updated!.status).toBe("rejected");
    });

    it("sends a task for rework", async () => {
      const { task } = await seedEnrichingTask();
      mockReworkResponse();

      await evaluateGate(task.id);

      const updated = await getById(task.id);
      expect(updated!.status).toBe("rework");
    });

    it("records a gate decision with AI source", async () => {
      const { task } = await seedEnrichingTask();
      mockApproveResponse();

      await evaluateGate(task.id);

      const decisions = await listGateDecisions(task.id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].verdict).toBe("approve");
      expect(decisions[0].source).toBe("ai");
      expect(decisions[0].reasoning).toBe("Task is clear and low-risk");
      expect(decisions[0].decidedBy).toBeNull();
      expect(decisions[0].taskContext).toBeTruthy();
    });

    it("calls the SDK with the gate prompt and task details", async () => {
      const { task } = await seedEnrichingTask();
      mockApproveResponse();

      await evaluateGate(task.id);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);
      const call = mockCallClaude.mock.calls[0][0];
      expect(call.model).toBe("claude-sonnet-4-20250514");
      expect(call.prompt).toContain(task.title);
      expect(call.prompt).toContain(task.body);
      expect(call.systemPrompt).toContain("gate-keeper");
    });

    it("records cost after AI evaluation", async () => {
      const { task, user } = await seedEnrichingTask();
      mockApproveResponse();

      await evaluateGate(task.id);

      // Verify a cost row was created
      const { db } = await import("../setup.js");
      const { costs } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(costs)
        .where(eq(costs.taskId, task.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].agent).toBe("gate");
      expect(rows[0].userId).toBe(user.id);
      expect(parseFloat(rows[0].costUsd)).toBeGreaterThan(0);
      expect(rows[0].turns).toBe(1);
      expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("unregisters active agent after success", async () => {
      const { task } = await seedEnrichingTask();
      mockApproveResponse();

      await evaluateGate(task.id);

      const active = await listActive();
      expect(active).toHaveLength(0);
    });

    it("unregisters active agent after failure", async () => {
      const { task } = await seedEnrichingTask();
      mockCallClaude.mockRejectedValue(new Error("API error"));

      await expect(evaluateGate(task.id)).rejects.toThrow("API error");

      const active = await listActive();
      expect(active).toHaveLength(0);
    });

    it("does not transition status on SDK failure", async () => {
      const { task } = await seedEnrichingTask();
      mockCallClaude.mockRejectedValue(new Error("API error"));

      await expect(evaluateGate(task.id)).rejects.toThrow("API error");

      const found = await getById(task.id);
      expect(found!.status).toBe("enriching");
    });

    it("does not transition status on invalid JSON response", async () => {
      const { task } = await seedEnrichingTask();
      mockCallClaude.mockResolvedValue({
        text: "not valid json",
        cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 10 },
      });

      await expect(evaluateGate(task.id)).rejects.toThrow();

      const found = await getById(task.id);
      expect(found!.status).toBe("enriching");
    });

    it("throws on invalid verdict value", async () => {
      const { task } = await seedEnrichingTask();
      mockCallClaude.mockResolvedValue({
        text: JSON.stringify({ verdict: "maybe", reasoning: "unsure", confidence: 0.5 }),
        cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 10 },
      });

      await expect(evaluateGate(task.id)).rejects.toThrow("Invalid verdict");

      const found = await getById(task.id);
      expect(found!.status).toBe("enriching");
    });
  });

  // ── Human mode ─────────────────────────────────────────────────────────────

  describe("human mode", () => {
    beforeEach(() => {
      mockConfig.gate.mode = "human";
    });

    it("transitions task to ready without calling LLM", async () => {
      const { task } = await seedEnrichingTask();

      await evaluateGate(task.id);

      const updated = await getById(task.id);
      expect(updated!.status).toBe("ready");
      expect(mockCallClaude).not.toHaveBeenCalled();
    });

    it("does not record a gate decision", async () => {
      const { task } = await seedEnrichingTask();

      await evaluateGate(task.id);

      const decisions = await listGateDecisions(task.id);
      expect(decisions).toHaveLength(0);
    });

    it("does not register as active agent", async () => {
      const { task } = await seedEnrichingTask();

      // We can't easily check mid-execution, but we can verify
      // no cost was recorded (which would only happen in AI path)
      await evaluateGate(task.id);

      const { db } = await import("../setup.js");
      const { costs } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(costs)
        .where(eq(costs.taskId, task.id));

      expect(rows).toHaveLength(0);
    });
  });

  // ── Auto mode ──────────────────────────────────────────────────────────────

  describe("auto mode", () => {
    beforeEach(() => {
      mockConfig.gate.mode = "auto";
    });

    it("auto-approves trivial tasks without LLM call", async () => {
      const { task } = await seedEnrichingTask({ size: "trivial" });

      await evaluateGate(task.id);

      const updated = await getById(task.id);
      expect(updated!.status).toBe("approved");
      expect(mockCallClaude).not.toHaveBeenCalled();
    });

    it("auto-approves small tasks without LLM call", async () => {
      const { task } = await seedEnrichingTask({ size: "small" });

      await evaluateGate(task.id);

      const updated = await getById(task.id);
      expect(updated!.status).toBe("approved");
      expect(mockCallClaude).not.toHaveBeenCalled();
    });

    it("records auto decision for small tasks", async () => {
      const { task } = await seedEnrichingTask({ size: "small" });

      await evaluateGate(task.id);

      const decisions = await listGateDecisions(task.id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].verdict).toBe("approve");
      expect(decisions[0].source).toBe("auto");
      expect(decisions[0].reasoning).toContain("small");
    });

    it("falls through to AI for medium tasks", async () => {
      const { task } = await seedEnrichingTask({ size: "medium" });
      mockApproveResponse();

      await evaluateGate(task.id);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);
      const updated = await getById(task.id);
      expect(updated!.status).toBe("approved");

      const decisions = await listGateDecisions(task.id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].source).toBe("ai");
    });

    it("falls through to AI for large tasks", async () => {
      const { task } = await seedEnrichingTask({ size: "large" });
      mockRejectResponse();

      await evaluateGate(task.id);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);
      const updated = await getById(task.id);
      expect(updated!.status).toBe("rejected");
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws when task not found", async () => {
      await expect(evaluateGate("HIVE-00000000-0000")).rejects.toThrow(
        "Task HIVE-00000000-0000 not found",
      );
    });

    it("throws when task is not in enriching status", async () => {
      const user = await findOrCreateByEntraOid(
        "oid-gate-test2",
        "gate2@example.com",
        "Gate User 2",
      );
      const repo = await findOrCreateRepo("github", "acme/widget");
      const task = await createTask({
        title: "Pending task",
        body: "body",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      await expect(evaluateGate(task.id)).rejects.toThrow("not in enriching status");
    });
  });
});
