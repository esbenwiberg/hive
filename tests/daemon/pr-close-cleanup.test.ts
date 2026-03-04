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

// Mock preview manager
const mockGetRunningPreviews = vi.fn().mockReturnValue(new Map());
const mockStopPreview = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/execution/preview/manager.js", () => ({
  previewManager: {
    getRunningPreviews: () => mockGetRunningPreviews(),
    stopPreview: (...args: unknown[]) => mockStopPreview(...args),
  },
}));

// Mock git provider
const mockGetPRState = vi.fn().mockResolvedValue("open");
const mockGitProvider = {
  getPRState: (...args: unknown[]) => mockGetPRState(...args),
};

vi.mock("../../src/execution/git-provider.js", () => ({
  getGitProvider: () => mockGitProvider,
}));

// Mock worktree
const mockResolveGitCredentials = vi.fn().mockResolvedValue({ provider: "github", token: "tok" });
const mockCleanupWorktree = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/execution/worktree.js", () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
  cleanupWorktree: (...args: unknown[]) => mockCleanupWorktree(...args),
}));

// Mock DB queries
const mockGetTask = vi.fn();
const mockGetRepo = vi.fn();

vi.mock("../../src/db/queries/tasks.js", () => ({
  getById: (...args: unknown[]) => mockGetTask(...args),
}));

vi.mock("../../src/db/queries/repos.js", () => ({
  getById: (...args: unknown[]) => mockGetRepo(...args),
}));

// Mock preview-logs
const mockAddPreviewLog = vi.fn().mockResolvedValue({});
vi.mock("../../src/db/queries/preview-logs.js", () => ({
  addPreviewLog: (...args: unknown[]) => mockAddPreviewLog(...args),
}));

// Mock domain/config to prevent transitive import of db/connection
vi.mock("../../src/domain/config.js", () => ({
  getConfig: vi.fn().mockResolvedValue(undefined),
  setConfig: vi.fn().mockResolvedValue(undefined),
}));

// ── Import (after mocks) ─────────────────────────────────────────────────────

const { cleanupClosedPRPreviews } = await import(
  "../../src/daemon/pr-close-cleanup.js"
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cleanupClosedPRPreviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRunningPreviews.mockReturnValue(new Map());
    mockGetPRState.mockResolvedValue("open");
    mockResolveGitCredentials.mockResolvedValue({ provider: "github", token: "tok" });
    mockStopPreview.mockResolvedValue(undefined);
    mockCleanupWorktree.mockResolvedValue(undefined);
    mockAddPreviewLog.mockResolvedValue({});
    mockGetTask.mockResolvedValue(null);
    mockGetRepo.mockResolvedValue(null);
  });

  it("does nothing when no previews are running", async () => {
    await cleanupClosedPRPreviews();

    expect(mockGetTask).not.toHaveBeenCalled();
    expect(mockStopPreview).not.toHaveBeenCalled();
  });

  it("skips tasks without a prUrl", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-001", { worktreePath: "/tmp/wt1", taskId: "HIVE-001" }]]),
    );
    mockGetTask.mockResolvedValue({ id: "HIVE-001", repoId: 1, createdBy: 1, prUrl: null });

    await cleanupClosedPRPreviews();

    expect(mockGetPRState).not.toHaveBeenCalled();
    expect(mockStopPreview).not.toHaveBeenCalled();
  });

  it("skips tasks where task is not found", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-GONE", { worktreePath: "/tmp/wt1", taskId: "HIVE-GONE" }]]),
    );
    mockGetTask.mockResolvedValue(null);

    await cleanupClosedPRPreviews();

    expect(mockStopPreview).not.toHaveBeenCalled();
  });

  it("does not stop preview when PR is still open", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-OPEN", { worktreePath: "/tmp/wt1", taskId: "HIVE-OPEN" }]]),
    );
    mockGetTask.mockResolvedValue({
      id: "HIVE-OPEN", repoId: 1, createdBy: 1, prUrl: "https://github.com/acme/repo/pull/1",
    });
    mockGetRepo.mockResolvedValue({ id: 1, provider: "github", fullName: "acme/repo" });
    mockGetPRState.mockResolvedValue("open");

    await cleanupClosedPRPreviews();

    expect(mockStopPreview).not.toHaveBeenCalled();
  });

  it("stops preview when PR is closed", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-CLOSED", { worktreePath: "/tmp/wt1", taskId: "HIVE-CLOSED" }]]),
    );
    mockGetTask.mockResolvedValue({
      id: "HIVE-CLOSED", repoId: 1, createdBy: 1, prUrl: "https://github.com/acme/repo/pull/5",
    });
    mockGetRepo.mockResolvedValue({ id: 1, provider: "github", fullName: "acme/repo" });
    mockGetPRState.mockResolvedValue("closed");

    await cleanupClosedPRPreviews();

    expect(mockStopPreview).toHaveBeenCalledWith("HIVE-CLOSED");
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/wt1" }),
    );
    expect(mockAddPreviewLog).toHaveBeenCalledWith("HIVE-CLOSED", "pr-close", expect.stringContaining("closed"));
  });

  it("stops preview when PR is merged", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-MERGED", { worktreePath: "/tmp/wt2", taskId: "HIVE-MERGED" }]]),
    );
    mockGetTask.mockResolvedValue({
      id: "HIVE-MERGED", repoId: 1, createdBy: 1, prUrl: "https://github.com/acme/repo/pull/10",
    });
    mockGetRepo.mockResolvedValue({ id: 1, provider: "github", fullName: "acme/repo" });
    mockGetPRState.mockResolvedValue("merged");

    await cleanupClosedPRPreviews();

    expect(mockStopPreview).toHaveBeenCalledWith("HIVE-MERGED");
    expect(mockAddPreviewLog).toHaveBeenCalledWith("HIVE-MERGED", "pr-close", expect.stringContaining("merged"));
  });

  it("handles credential resolution errors gracefully", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([["HIVE-NOCRED", { worktreePath: "/tmp/wt3", taskId: "HIVE-NOCRED" }]]),
    );
    mockGetTask.mockResolvedValue({
      id: "HIVE-NOCRED", repoId: 1, createdBy: 1, prUrl: "https://github.com/acme/repo/pull/3",
    });
    mockGetRepo.mockResolvedValue({ id: 1, provider: "github", fullName: "acme/repo" });
    mockResolveGitCredentials.mockRejectedValue(new Error("No credentials"));

    // Should not throw
    await cleanupClosedPRPreviews();

    expect(mockStopPreview).not.toHaveBeenCalled();
  });

  it("continues processing other tasks when one fails", async () => {
    mockGetRunningPreviews.mockReturnValue(
      new Map([
        ["HIVE-FAIL", { worktreePath: "/tmp/wt-fail", taskId: "HIVE-FAIL" }],
        ["HIVE-OK", { worktreePath: "/tmp/wt-ok", taskId: "HIVE-OK" }],
      ]),
    );

    // First task throws, second is closed
    let callCount = 0;
    mockGetTask.mockImplementation(async (id: string) => {
      callCount++;
      if (id === "HIVE-FAIL") throw new Error("DB error");
      return { id: "HIVE-OK", repoId: 1, createdBy: 1, prUrl: "https://github.com/acme/repo/pull/2" };
    });
    mockGetRepo.mockResolvedValue({ id: 1, provider: "github", fullName: "acme/repo" });
    mockGetPRState.mockResolvedValue("closed");

    await cleanupClosedPRPreviews();

    // Second task should still be processed
    expect(mockStopPreview).toHaveBeenCalledWith("HIVE-OK");
  });
});
