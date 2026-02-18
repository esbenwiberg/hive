import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock logger
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock autonomous config
vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => ({
    preview: {
      enabled: true,
      max_concurrent: 3,
      cleanup_timeout_minutes: 30,
      port_range: [4001, 4099],
    },
  }),
}));

// Mock preview manager
const mockCleanupExpired = vi.fn().mockResolvedValue([]);
const mockGetPreviewInfo = vi.fn().mockReturnValue(undefined);
const mockGetRunningPreviews = vi.fn().mockReturnValue(new Map());

vi.mock("../../src/execution/preview/manager.js", () => ({
  previewManager: {
    cleanupExpired: (...args: unknown[]) => mockCleanupExpired(...args),
    getPreviewInfo: (...args: unknown[]) => mockGetPreviewInfo(...args),
    getRunningPreviews: () => mockGetRunningPreviews(),
  },
}));

// Mock worktree cleanup
const mockCleanupWorktree = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/execution/worktree.js", () => ({
  cleanupWorktree: (...args: unknown[]) => mockCleanupWorktree(...args),
}));

// Mock preview-logs
const mockAddPreviewLog = vi.fn().mockResolvedValue({});
vi.mock("../../src/db/queries/preview-logs.js", () => ({
  addPreviewLog: (...args: unknown[]) => mockAddPreviewLog(...args),
}));

// Mock DB connection and Drizzle
const mockDbSelect = vi.fn();
const mockDbFrom = vi.fn();
let selectWhereResult: unknown[] = [];
const mockDbWhere = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbUpdateWhere = vi.fn();

vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockDbSelect(...args);
      return {
        from: (...fromArgs: unknown[]) => {
          mockDbFrom(...fromArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              mockDbWhere(...whereArgs);
              return Promise.resolve(selectWhereResult);
            },
          };
        },
      };
    },
    update: (...args: unknown[]) => {
      mockDbUpdate(...args);
      return {
        set: (...setArgs: unknown[]) => {
          mockDbSet(...setArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              mockDbUpdateWhere(...whereArgs);
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

// Mock schema
vi.mock("../../src/db/schema.js", () => ({
  tasks: { id: "id", previewStatus: "preview_status", previewStartedAt: "preview_started_at" },
}));

// Mock drizzle-orm
vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ── Import (after mocks) ─────────────────────────────────────────────────────

const { cleanupExpiredPreviews } = await import(
  "../../src/daemon/preview-cleanup.js"
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cleanupExpiredPreviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanupExpired.mockResolvedValue([]);
    mockGetRunningPreviews.mockReturnValue(new Map());
    selectWhereResult = [];
  });

  it("calls previewManager.cleanupExpired", async () => {
    await cleanupExpiredPreviews();

    expect(mockCleanupExpired).toHaveBeenCalledOnce();
  });

  it("cleans up worktrees for expired previews", async () => {
    // Set up running previews before cleanup
    const runningPreviews = new Map([
      ["HIVE-EXP1", { worktreePath: "/tmp/worktree-1", taskId: "HIVE-EXP1" }],
      ["HIVE-EXP2", { worktreePath: "/tmp/worktree-2", taskId: "HIVE-EXP2" }],
    ]);
    mockGetRunningPreviews.mockReturnValue(runningPreviews);

    // cleanupExpired returns the IDs that were stopped
    mockCleanupExpired.mockResolvedValue(["HIVE-EXP1"]);

    // After cleanupExpired, the running map no longer has HIVE-EXP1
    // (simulate this by changing what getRunningPreviews returns after cleanup)
    mockCleanupExpired.mockImplementation(async () => {
      // Simulate the manager removing HIVE-EXP1 from its map
      mockGetRunningPreviews.mockReturnValue(
        new Map([["HIVE-EXP2", { worktreePath: "/tmp/worktree-2", taskId: "HIVE-EXP2" }]]),
      );
      return ["HIVE-EXP1"];
    });

    await cleanupExpiredPreviews();

    // Worktree cleanup should have been called for HIVE-EXP1
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/worktree-1" }),
    );

    // Log should be added
    expect(mockAddPreviewLog).toHaveBeenCalledWith(
      "HIVE-EXP1",
      "cleanup",
      expect.stringContaining("Worktree cleaned up"),
    );
  });

  it("handles previewManager.cleanupExpired errors gracefully", async () => {
    mockCleanupExpired.mockRejectedValue(new Error("cleanup boom"));

    // Should not throw
    await cleanupExpiredPreviews();

    // Should still run the DB check (select was called)
    expect(mockDbSelect).toHaveBeenCalled();
  });

  it("corrects stale DB preview status for tasks not in memory", async () => {
    // DB returns a task with running status past timeout
    selectWhereResult = [{ id: "HIVE-STALE1" }];

    // No running previews in memory
    mockGetRunningPreviews.mockReturnValue(new Map());

    await cleanupExpiredPreviews();

    // Should update the DB status to stopped
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({ previewStatus: "stopped" }),
    );

    // Should log the correction
    expect(mockAddPreviewLog).toHaveBeenCalledWith(
      "HIVE-STALE1",
      "cleanup",
      expect.stringContaining("Stale DB preview status corrected"),
    );
  });

  it("skips DB tasks that are still in memory", async () => {
    // DB returns a task, but it's still in the in-memory map
    selectWhereResult = [{ id: "HIVE-INMEM1" }];

    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-INMEM1", { worktreePath: "/tmp/inmem", taskId: "HIVE-INMEM1" }]]),
    );

    await cleanupExpiredPreviews();

    // Should NOT update DB for this task — it's still tracked in memory
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when there are no expired or stale previews", async () => {
    mockCleanupExpired.mockResolvedValue([]);
    mockDbWhere.mockResolvedValue([]);

    await cleanupExpiredPreviews();

    expect(mockCleanupWorktree).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});
