import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockRunPipeline = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/agents/pipeline.js", () => ({
  runPipeline: mockRunPipeline,
}));

const mockExecuteTask = vi.fn().mockResolvedValue({ success: true });
vi.mock("../../src/execution/worker.js", () => ({
  executeTask: mockExecuteTask,
}));

const mockList = vi.fn().mockResolvedValue({ tasks: [], total: 0 });
const mockUpdateStatus = vi.fn().mockResolvedValue({});
vi.mock("../../src/db/queries/tasks.js", () => ({
  list: mockList,
  updateStatus: mockUpdateStatus,
}));

const mockCleanupStale = vi.fn().mockResolvedValue(0);
vi.mock("../../src/db/queries/active-agents.js", () => ({
  cleanupStale: mockCleanupStale,
}));

const mockCheckBudget = vi.fn().mockResolvedValue(50);
vi.mock("../../src/db/queries/costs.js", () => ({
  checkBudget: mockCheckBudget,
}));

const mockFindStaleTasks = vi.fn().mockResolvedValue([]);
vi.mock("../../src/daemon/stale-tasks.js", () => ({
  findStaleTasks: mockFindStaleTasks,
  STALE_THRESHOLD_MS: 1_800_000,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { Daemon } = await import("../../src/daemon/daemon.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: `HIVE-20260218-${Math.random().toString(16).slice(2, 6)}`,
    status: "pending",
    createdBy: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Daemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ tasks: [], total: 0 });
    mockCheckBudget.mockResolvedValue(50);
    mockFindStaleTasks.mockResolvedValue([]);
    mockRunPipeline.mockResolvedValue(undefined);
    mockExecuteTask.mockResolvedValue({ success: true });
  });

  it("calls cleanupStale on start", async () => {
    const daemon = new Daemon({ pollIntervalMs: 100_000 });
    await daemon.start();
    await daemon.stop();

    expect(mockCleanupStale).toHaveBeenCalledOnce();
    expect(mockCleanupStale).toHaveBeenCalledWith(1_800_000);
  });

  it("transitions stale tasks to failed on start", async () => {
    const staleTask = makeFakeTask({ id: "HIVE-STALE-0001", status: "executing" });
    mockFindStaleTasks.mockResolvedValue([staleTask]);

    const daemon = new Daemon({ pollIntervalMs: 100_000 });
    await daemon.start();
    await daemon.stop();

    expect(mockUpdateStatus).toHaveBeenCalledWith("HIVE-STALE-0001", "failed");
  });

  it("calls runPipeline for a pending task", async () => {
    const task = makeFakeTask({ id: "HIVE-PEND-0001", status: "pending" });

    // First call: return the task. Subsequent calls: empty (so daemon settles).
    mockList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === "pending" && mockRunPipeline.mock.calls.length === 0) {
        return { tasks: [task], total: 1 };
      }
      return { tasks: [], total: 0 };
    });

    const daemon = new Daemon({ pollIntervalMs: 50, maxConcurrent: 5 });
    await daemon.start();

    // Wait for at least one tick to fire and dispatch
    await new Promise((r) => setTimeout(r, 200));
    await daemon.stop();

    expect(mockRunPipeline).toHaveBeenCalledWith("HIVE-PEND-0001");
  });

  it("calls executeTask for a rework task", async () => {
    const task = makeFakeTask({ id: "HIVE-REWORK-01", status: "rework" });

    mockList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === "rework" && mockExecuteTask.mock.calls.length === 0) {
        return { tasks: [task], total: 1 };
      }
      return { tasks: [], total: 0 };
    });

    const daemon = new Daemon({ pollIntervalMs: 50, maxConcurrent: 5 });
    await daemon.start();

    await new Promise((r) => setTimeout(r, 200));
    await daemon.stop();

    expect(mockExecuteTask).toHaveBeenCalledWith("HIVE-REWORK-01");
  });

  it("skips task when budget is exhausted", async () => {
    const task = makeFakeTask({ id: "HIVE-BROKE-001", status: "pending" });

    mockList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === "pending") {
        return { tasks: [task], total: 1 };
      }
      return { tasks: [], total: 0 };
    });

    mockCheckBudget.mockResolvedValue(0); // No budget

    const daemon = new Daemon({ pollIntervalMs: 50 });
    await daemon.start();

    await new Promise((r) => setTimeout(r, 200));
    await daemon.stop();

    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it("enforces maxConcurrent limit", async () => {
    // Create tasks that take a while to execute
    const tasks = Array.from({ length: 6 }, (_, i) =>
      makeFakeTask({ id: `HIVE-CONC-000${i}`, status: "pending", createdBy: i + 1 }),
    );

    mockList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === "pending") {
        return { tasks, total: tasks.length };
      }
      return { tasks: [], total: 0 };
    });

    // Make runPipeline take 500ms so tasks stay in-flight
    mockRunPipeline.mockImplementation(
      () => new Promise((r) => setTimeout(r, 500)),
    );

    const daemon = new Daemon({ pollIntervalMs: 50, maxConcurrent: 3 });
    await daemon.start();

    // Wait for tasks to be dispatched
    await new Promise((r) => setTimeout(r, 200));

    // Should have dispatched at most 3 (maxConcurrent)
    expect(mockRunPipeline.mock.calls.length).toBeLessThanOrEqual(3);

    await daemon.stop();
  });

  it("enforces per-user concurrency limit", async () => {
    // 3 tasks from the same user
    const sameUser = 42;
    const tasks = Array.from({ length: 3 }, (_, i) =>
      makeFakeTask({
        id: `HIVE-USER-000${i}`,
        status: "pending",
        createdBy: sameUser,
      }),
    );

    mockList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === "pending") {
        return { tasks, total: tasks.length };
      }
      return { tasks: [], total: 0 };
    });

    // Make runPipeline slow so tasks stay in-flight
    mockRunPipeline.mockImplementation(
      () => new Promise((r) => setTimeout(r, 500)),
    );

    const daemon = new Daemon({
      pollIntervalMs: 50,
      maxConcurrent: 5,
      maxPerUser: 2,
    });
    await daemon.start();

    await new Promise((r) => setTimeout(r, 200));

    // Should have dispatched at most 2 for the same user
    expect(mockRunPipeline.mock.calls.length).toBeLessThanOrEqual(2);

    await daemon.stop();
  });

  it("stop resolves immediately when no tasks in flight", async () => {
    const daemon = new Daemon({ pollIntervalMs: 100_000 });
    await daemon.start();

    const before = Date.now();
    await daemon.stop();
    const elapsed = Date.now() - before;

    // Should resolve quickly (well under 1 second)
    expect(elapsed).toBeLessThan(1000);
  });

  it("handles dispatch errors without crashing", async () => {
    const task = makeFakeTask({ id: "HIVE-ERR-0001", status: "pending" });

    let called = false;
    mockList.mockImplementation(async (filters: { status?: string }) => {
      if (filters.status === "pending" && !called) {
        called = true;
        return { tasks: [task], total: 1 };
      }
      return { tasks: [], total: 0 };
    });

    mockRunPipeline.mockRejectedValueOnce(new Error("Agent crashed"));

    const daemon = new Daemon({ pollIntervalMs: 50 });
    await daemon.start();

    await new Promise((r) => setTimeout(r, 200));
    await daemon.stop();

    // Daemon should still be alive — stop should succeed
    expect(mockRunPipeline).toHaveBeenCalledWith("HIVE-ERR-0001");
  });
});
