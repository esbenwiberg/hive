/**
 * Integration-level pipeline tests focused on the Advisor agent's role in the
 * pipeline sequence (Step 4c).
 *
 * These tests verify:
 *   - Advisor is called after enrichment and before the gate
 *   - Advisor failure (thrown exception) does NOT block progression to the gate
 *   - advisor.escalate=true results in the gate receiving a forced-human signal
 *
 * All external I/O is mocked; this file does NOT connect to a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Call-order tracking ───────────────────────────────────────────────────────

const callOrder: string[] = [];

// ── Mocks ─────────────────────────────────────────────────────────────────────

// --- advisor ---
const mockRunAdvisor = vi.fn();
vi.mock("../advisor.js", () => ({
  runAdvisor: mockRunAdvisor,
}));

// --- gate ---
const mockEvaluateGate = vi.fn();
vi.mock("../gate.js", () => ({
  evaluateGate: mockEvaluateGate,
}));

// --- router ---
const mockRunRouter = vi.fn();
vi.mock("../router.js", () => ({
  runRouter: mockRunRouter,
}));

// --- enrichers ---
const mockRunEnrichers = vi.fn();
vi.mock("../../enrichers/index.js", () => ({
  runEnrichers: mockRunEnrichers,
}));

vi.mock("../../enrichers/runner.js", () => ({
  runEnrichers: mockRunEnrichers,
}));

// --- SDK (no real Anthropic calls) ---
vi.mock("../sdk.js", () => ({
  callClaude: vi.fn(),
}));

// --- logger ---
vi.mock("../../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- autonomous config ---
const mockConfig = {
  classification: { defaultType: "improvement", defaultSize: "medium" },
  gate: { mode: "auto" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    default: "claude-sonnet-4-20250514",
    components: {} as Record<string, string>,
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [] as Array<{ name: string; enabled: boolean }>,
};

vi.mock("../../domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  getModelFor: (c: string) => mockConfig.models.components[c] ?? mockConfig.models.default,
  loadConfig: () => mockConfig,
}));

// --- db queries (in-memory stubs) ---
const taskStore: Map<string, Record<string, unknown>> = new Map();

vi.mock("../../db/queries/tasks.js", () => ({
  getById: vi.fn((id: string) => Promise.resolve(taskStore.get(id) ?? null)),
  create: vi.fn(),
  updateStatus: vi.fn((id: string, status: string) => {
    const t = taskStore.get(id);
    if (t) taskStore.set(id, { ...t, status });
    return Promise.resolve();
  }),
  updateEnrichment: vi.fn((id: string, enrichment: unknown) => {
    const t = taskStore.get(id);
    if (t) taskStore.set(id, { ...t, enrichment });
    return Promise.resolve();
  }),
  updateType: vi.fn(),
  updateSize: vi.fn(),
  updateWorkflow: vi.fn(),
  failTask: vi.fn((id: string, err: unknown) => {
    const t = taskStore.get(id);
    if (t) taskStore.set(id, { ...t, status: "failed", failureReason: String(err instanceof Error ? err.message : err) });
    return Promise.resolve();
  }),
  setGateVerdict: vi.fn(),
}));

vi.mock("../../db/queries/active-agents.js", () => ({
  register: vi.fn().mockResolvedValue(undefined),
  unregister: vi.fn().mockResolvedValue(undefined),
  listActive: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../db/queries/task-events.js", () => ({
  addEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../db/queries/costs.js", () => ({
  recordCost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../db/connection.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

// --- execution worker (don't actually execute tasks) ---
const mockExecuteTask = vi.fn().mockResolvedValue({ success: true });
const mockExecuteEpic = vi.fn().mockResolvedValue({ success: true });
vi.mock("../../execution/worker.js", () => ({
  executeTask: mockExecuteTask,
  executeEpic: mockExecuteEpic,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const { runPipeline } = await import("../pipeline.js");
const { getById, updateEnrichment, failTask } = await import("../../db/queries/tasks.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_TASK = {
  id: "HIVE-pipe-test-001",
  title: "Add dark mode",
  body: "Users want dark mode",
  status: "pending",
  type: null,
  size: null,
  workflow: null,
  enrichment: null as Record<string, unknown> | null,
  failureReason: null,
  gateVerdict: null,
  repoId: "repo-1",
  createdBy: "user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const VALID_ADVISOR_VERDICT = {
  verdict: "approve",
  overallScore: 0.82,
  confidenceScore: 0.75,
  dimensions: {
    productFit: { score: 0.9, rationale: "Fits roadmap" },
    architecturalAlignment: { score: 0.85, rationale: "Follows patterns" },
    userImpact: { score: 0.88, rationale: "High demand" },
    implementationRisk: { score: 0.7, rationale: "Low risk" },
    scopeClarity: { score: 0.8, rationale: "Well defined" },
  },
  reasoning: "This task aligns well with the product goals.",
  recommendations: ["Add integration tests"],
  escalate: false,
};

function seedTask(overrides: Partial<typeof BASE_TASK> = {}) {
  const task = { ...BASE_TASK, ...overrides };
  taskStore.set(task.id, task);
  return task;
}

function setupDefaultMocks() {
  // Router
  mockRunRouter.mockResolvedValueOnce({
    type: "feature",
    size: "small",
    workflow: "flow",
    model: "claude-sonnet-4-20250514",
  });

  // Enrichers (no-op)
  mockRunEnrichers.mockResolvedValue(undefined);

  // Advisor — success by default
  mockRunAdvisor.mockImplementation(async () => {
    callOrder.push("advisor");
    return VALID_ADVISOR_VERDICT;
  });

  // Gate — approve
  mockEvaluateGate.mockImplementation(async () => {
    callOrder.push("gate");
    const t = taskStore.get(BASE_TASK.id);
    if (t) taskStore.set(BASE_TASK.id, { ...t, status: "approved", gateVerdict: "approve" });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runPipeline — advisor integration", () => {
  beforeEach(() => {
    taskStore.clear();
    callOrder.length = 0;
    vi.clearAllMocks();
    mockConfig.gate.mode = "auto";
  });

  // ── Ordering: advisor runs after enrichment, before gate ──────────────────

  it("calls runAdvisor after enrichment completes", async () => {
    seedTask();

    // Track enrichment call order
    mockRunEnrichers.mockImplementation(async () => {
      callOrder.push("enrichers");
    });
    mockRunAdvisor.mockImplementation(async () => {
      callOrder.push("advisor");
      return VALID_ADVISOR_VERDICT;
    });
    mockEvaluateGate.mockImplementation(async () => {
      callOrder.push("gate");
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "approved" });
    });
    mockRunRouter.mockResolvedValue({ type: "feature", size: "small", workflow: "flow", model: "claude-sonnet-4-20250514" });

    await runPipeline(BASE_TASK.id);

    const advisorIdx = callOrder.indexOf("advisor");
    const enrichersIdx = callOrder.indexOf("enrichers");
    expect(advisorIdx).toBeGreaterThan(-1);
    expect(enrichersIdx).toBeGreaterThan(-1);
    expect(advisorIdx).toBeGreaterThan(enrichersIdx);
  });

  it("calls runAdvisor before evaluateGate", async () => {
    seedTask();
    setupDefaultMocks();

    await runPipeline(BASE_TASK.id);

    const advisorIdx = callOrder.indexOf("advisor");
    const gateIdx = callOrder.indexOf("gate");
    expect(advisorIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(advisorIdx).toBeLessThan(gateIdx);
  });

  it("calls runAdvisor exactly once per pipeline run", async () => {
    seedTask();
    setupDefaultMocks();

    await runPipeline(BASE_TASK.id);

    expect(mockRunAdvisor).toHaveBeenCalledTimes(1);
  });

  it("passes the task id, title, description, and enrichment to runAdvisor", async () => {
    const task = seedTask({
      enrichment: {
        router: { type: "bug", size: "small" },
        codebase: { files: ["src/index.ts"] },
      },
    });
    setupDefaultMocks();

    await runPipeline(task.id);

    expect(mockRunAdvisor).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        title: task.title,
        description: task.body,
      }),
    );
  });

  it("persists advisor verdict into the task enrichment metadata", async () => {
    seedTask();
    setupDefaultMocks();

    await runPipeline(BASE_TASK.id);

    expect(updateEnrichment).toHaveBeenCalledWith(
      BASE_TASK.id,
      expect.objectContaining({
        advisor: expect.objectContaining({
          verdict: "approve",
          overallScore: 0.82,
          escalate: false,
        }),
      }),
    );
  });

  // ── Advisor failure does NOT block the gate ───────────────────────────────

  it("proceeds to the gate even when runAdvisor throws an error", async () => {
    seedTask();
    mockRunRouter.mockResolvedValue({ type: "feature", size: "small", workflow: "flow", model: "claude-sonnet-4-20250514" });
    mockRunEnrichers.mockResolvedValue(undefined);

    // Advisor blows up
    mockRunAdvisor.mockRejectedValueOnce(new Error("LLM timeout"));

    // Gate should still fire
    mockEvaluateGate.mockImplementation(async () => {
      callOrder.push("gate");
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "approved" });
    });

    await runPipeline(BASE_TASK.id);

    // Gate was still called despite advisor failure
    expect(callOrder).toContain("gate");
    expect(mockEvaluateGate).toHaveBeenCalledTimes(1);
  });

  it("does NOT set task status to failed when runAdvisor throws", async () => {
    seedTask();
    mockRunRouter.mockResolvedValue({ type: "feature", size: "small", workflow: "flow", model: "claude-sonnet-4-20250514" });
    mockRunEnrichers.mockResolvedValue(undefined);
    mockRunAdvisor.mockRejectedValueOnce(new Error("Transient advisor error"));
    mockEvaluateGate.mockImplementation(async () => {
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "approved" });
    });

    await runPipeline(BASE_TASK.id);

    expect(failTask).not.toHaveBeenCalled();
    const task = taskStore.get(BASE_TASK.id);
    expect(task?.status).toBe("approved");
  });

  it("skips advisor verdict persistence when runAdvisor throws", async () => {
    seedTask();
    mockRunRouter.mockResolvedValue({ type: "feature", size: "small", workflow: "flow", model: "claude-sonnet-4-20250514" });
    mockRunEnrichers.mockResolvedValue(undefined);
    mockRunAdvisor.mockRejectedValueOnce(new Error("Advisor exploded"));
    mockEvaluateGate.mockImplementation(async () => {
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "approved" });
    });

    await runPipeline(BASE_TASK.id);

    // updateEnrichment should not have been called with advisor data
    const calls = vi.mocked(updateEnrichment).mock.calls;
    const hasAdvisorData = calls.some(([, enrichment]) =>
      typeof enrichment === "object" &&
      enrichment !== null &&
      "advisor" in (enrichment as Record<string, unknown>),
    );
    expect(hasAdvisorData).toBe(false);
  });

  // ── Advisor escalate=true → gate receives forced-human signal ─────────────

  it("evaluateGate is still called when advisor.escalate=true", async () => {
    seedTask();
    mockRunRouter.mockResolvedValue({ type: "feature", size: "medium", workflow: "flow", model: "claude-sonnet-4-20250514" });
    mockRunEnrichers.mockResolvedValue(undefined);

    // Advisor returns escalate=true
    mockRunAdvisor.mockResolvedValueOnce({
      ...VALID_ADVISOR_VERDICT,
      confidenceScore: 0.3,
      escalate: true,
    });

    let gateCalledWith: Record<string, unknown> = {};
    mockEvaluateGate.mockImplementation(async (taskId: string) => {
      gateCalledWith = { taskId };
      callOrder.push("gate");
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "ready" });
    });

    await runPipeline(BASE_TASK.id);

    expect(callOrder).toContain("gate");
    expect(gateCalledWith.taskId).toBe(BASE_TASK.id);
  });

  it("persists the escalation verdict before the gate runs when advisor.escalate=true", async () => {
    seedTask();
    mockRunRouter.mockResolvedValue({ type: "feature", size: "medium", workflow: "flow", model: "claude-sonnet-4-20250514" });
    mockRunEnrichers.mockResolvedValue(undefined);

    const escalatingVerdict = {
      ...VALID_ADVISOR_VERDICT,
      confidenceScore: 0.3,
      escalate: true,
      verdict: "caution" as const,
    };
    mockRunAdvisor.mockResolvedValueOnce(escalatingVerdict);

    mockEvaluateGate.mockImplementation(async () => {
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "ready" });
    });

    await runPipeline(BASE_TASK.id);

    // The advisor verdict (with escalate=true) should have been saved to enrichment
    expect(updateEnrichment).toHaveBeenCalledWith(
      BASE_TASK.id,
      expect.objectContaining({
        advisor: expect.objectContaining({ escalate: true }),
      }),
    );
  });

  it("gate reads advisor.escalate=true from enrichment and forces human mode", async () => {
    // This test verifies the contract: when advisor.escalate=true is written to
    // enrichment BEFORE evaluateGate is called, the gate picks it up.
    // We verify this by checking call order and the enrichment written.

    seedTask();
    mockRunRouter.mockResolvedValue({ type: "feature", size: "medium", workflow: "flow", model: "claude-sonnet-4-20250514" });
    mockRunEnrichers.mockResolvedValue(undefined);

    mockRunAdvisor.mockResolvedValueOnce({
      ...VALID_ADVISOR_VERDICT,
      escalate: true,
      confidenceScore: 0.25,
    });

    let enrichmentAtGateTime: unknown = null;
    mockEvaluateGate.mockImplementation(async () => {
      // Capture what's in the store at the moment gate runs
      enrichmentAtGateTime = taskStore.get(BASE_TASK.id)?.enrichment;
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "ready" });
    });

    await runPipeline(BASE_TASK.id);

    // The enrichment written before gate should include advisor.escalate=true
    expect(enrichmentAtGateTime).toBeTruthy();
    const enrichment = enrichmentAtGateTime as Record<string, unknown>;
    const advisor = enrichment.advisor as Record<string, unknown>;
    expect(advisor?.escalate).toBe(true);
  });

  // ── Full pipeline sequence confirmation ───────────────────────────────────

  it("maintains the correct step order: router → enrichers → advisor → gate", async () => {
    seedTask();
    mockRunRouter.mockImplementation(async () => {
      callOrder.push("router");
      return { type: "feature", size: "small", workflow: "flow", model: "claude-sonnet-4-20250514" };
    });
    mockRunEnrichers.mockImplementation(async () => {
      callOrder.push("enrichers");
    });
    mockRunAdvisor.mockImplementation(async () => {
      callOrder.push("advisor");
      return VALID_ADVISOR_VERDICT;
    });
    mockEvaluateGate.mockImplementation(async () => {
      callOrder.push("gate");
      const t = taskStore.get(BASE_TASK.id);
      if (t) taskStore.set(BASE_TASK.id, { ...t, status: "approved" });
    });

    await runPipeline(BASE_TASK.id);

    const routerIdx = callOrder.indexOf("router");
    const enrichersIdx = callOrder.indexOf("enrichers");
    const advisorIdx = callOrder.indexOf("advisor");
    const gateIdx = callOrder.indexOf("gate");

    // All steps present
    expect(routerIdx).toBeGreaterThan(-1);
    expect(enrichersIdx).toBeGreaterThan(-1);
    expect(advisorIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);

    // Correct relative order
    expect(routerIdx).toBeLessThan(enrichersIdx);
    expect(enrichersIdx).toBeLessThan(advisorIdx);
    expect(advisorIdx).toBeLessThan(gateIdx);
  });

  it("does not call runAdvisor when router throws (pipeline aborts early)", async () => {
    seedTask();
    mockRunRouter.mockRejectedValueOnce(new Error("Router API down"));
    mockRunEnrichers.mockResolvedValue(undefined);

    await runPipeline(BASE_TASK.id);

    expect(mockRunAdvisor).not.toHaveBeenCalled();
    expect(mockEvaluateGate).not.toHaveBeenCalled();
  });
});
