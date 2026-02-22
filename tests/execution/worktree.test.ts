import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the logger so tests don't produce output
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock user-credentials query
const mockGetByUserAndProvider = vi.fn();
vi.mock("../../src/db/queries/user-credentials.js", () => ({
  getByUserAndProvider: mockGetByUserAndProvider,
}));

// Mock vault/keyvault
const mockGetSecret = vi.fn();
vi.mock("../../src/vault/keyvault.js", () => ({
  getSecret: mockGetSecret,
}));

// Mock git-provider
const mockClone = vi.fn();
const mockCreateBranch = vi.fn();
const mockFetchBranch = vi.fn();
vi.mock("../../src/execution/git-provider.js", () => ({
  getGitProvider: vi.fn(() => ({
    clone: mockClone,
    createBranch: mockCreateBranch,
    fetchBranch: mockFetchBranch,
    commitAll: vi.fn(),
    push: vi.fn(),
    createPR: vi.fn(),
  })),
}));

// Mock node:fs/promises
const mockMkdir = vi.fn();
const mockRm = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  rm: mockRm,
}));

// Mock node:child_process for git config calls in createWorktree
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { resolveGitCredentials, createWorktree, cleanupWorktree } = await import(
  "../../src/execution/worktree.js"
);

import type { WorktreeInfo } from "../../src/domain/types.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveGitCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns GitCredentials on happy path", async () => {
    mockGetByUserAndProvider.mockResolvedValue({
      id: 1,
      userId: 42,
      provider: "github",
      vaultSecretId: "hive-user-42-github-pat",
      label: null,
      createdAt: new Date(),
    });
    mockGetSecret.mockResolvedValue("ghp_abc123");

    const creds = await resolveGitCredentials(42, "github");

    expect(creds).toEqual({ provider: "github", token: "ghp_abc123" });
    expect(mockGetByUserAndProvider).toHaveBeenCalledWith(42, "github");
    expect(mockGetSecret).toHaveBeenCalledWith("hive-user-42-github-pat");
  });

  it("throws when no credentials found for user+provider", async () => {
    mockGetByUserAndProvider.mockResolvedValue(undefined);

    await expect(resolveGitCredentials(42, "github")).rejects.toThrow(
      "No github credentials found for user 42",
    );

    expect(mockGetSecret).not.toHaveBeenCalled();
  });

  it("throws when vault secret not found", async () => {
    mockGetByUserAndProvider.mockResolvedValue({
      id: 1,
      userId: 42,
      provider: "github",
      vaultSecretId: "hive-user-42-github-pat",
      label: null,
      createdAt: new Date(),
    });
    mockGetSecret.mockResolvedValue(null);

    await expect(resolveGitCredentials(42, "github")).rejects.toThrow(
      "Secret hive-user-42-github-pat not found in vault for user 42",
    );
  });
});

describe("createWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default happy-path mocks
    mockGetByUserAndProvider.mockResolvedValue({
      id: 1,
      userId: 10,
      provider: "github",
      vaultSecretId: "secret-id",
      label: null,
      createdAt: new Date(),
    });
    mockGetSecret.mockResolvedValue("ghp_token123");
    mockMkdir.mockResolvedValue(undefined);
    mockClone.mockResolvedValue(undefined);
    mockCreateBranch.mockResolvedValue(undefined);
    mockFetchBranch.mockResolvedValue(false);

    // Mock execFile for git config calls (promisified pattern)
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);
        cb(null, { stdout: "", stderr: "" });
      },
    );
  });

  it("calls clone and createBranch with correct args", async () => {
    const result = await createWorktree(
      "acme/widget",
      "github",
      "feature/login-fix",
      "main",
      10,
    );

    // mkdir should be called with the worktree path
    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(mockMkdir.mock.calls[0][1]).toEqual({ recursive: true });

    // clone should be called with repo, worktree path, default branch, and creds
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(mockClone.mock.calls[0][0]).toBe("acme/widget");
    // targetDir is the worktree path
    expect(mockClone.mock.calls[0][1]).toContain("feature-login-fix-");
    expect(mockClone.mock.calls[0][2]).toBe("main");
    expect(mockClone.mock.calls[0][3]).toEqual({
      provider: "github",
      token: "ghp_token123",
    });

    // createBranch should be called with the worktree path and the feature branch
    expect(mockCreateBranch).toHaveBeenCalledTimes(1);
    expect(mockCreateBranch.mock.calls[0][0]).toContain("feature-login-fix-");
    expect(mockCreateBranch.mock.calls[0][1]).toBe("feature/login-fix");

    // Result should be a valid WorktreeInfo
    expect(result.branch).toBe("feature/login-fix");
    expect(result.repoFullName).toBe("acme/widget");
    expect(result.provider).toBe("github");
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("returns valid WorktreeInfo with sanitized path", async () => {
    const result = await createWorktree(
      "acme/widget",
      "github",
      "feat/my-branch",
      "main",
      10,
    );

    // Path should have slashes replaced with dashes
    expect(result.path).toContain("feat-my-branch-");
    expect(result.path).toContain("/tmp/hive-worktrees/");
    expect(result.branch).toBe("feat/my-branch");
    expect(result.repoFullName).toBe("acme/widget");
    expect(result.provider).toBe("github");
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("uses merge-base for baseSha when recovering a remote branch", async () => {
    const mainHead = "aaa1111111111111111111111111111111111111";
    const forkPoint = "bbb2222222222222222222222222222222222222";

    // fetchBranch returns true → branch is recovered
    mockFetchBranch.mockResolvedValue(true);

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);

        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          cb(null, { stdout: `${mainHead}\n`, stderr: "" });
        } else if (args[0] === "merge-base") {
          cb(null, { stdout: `${forkPoint}\n`, stderr: "" });
        } else {
          // checkout, config, etc.
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    const result = await createWorktree("acme/widget", "github", "hive/TASK-1", "main", 10);

    expect(result.baseSha).toBe(forkPoint);
    expect(result.recovered).toBe(true);
    // createBranch should NOT be called — branch was recovered
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });

  it("falls back to default-branch HEAD when merge-base fails on recovery", async () => {
    const mainHead = "aaa1111111111111111111111111111111111111";

    mockFetchBranch.mockResolvedValue(true);

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);

        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          cb(null, { stdout: `${mainHead}\n`, stderr: "" });
        } else if (args[0] === "merge-base") {
          // Simulate merge-base failure (disjoint histories)
          cb(new Error("fatal: no merge base found"), { stdout: "", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    const result = await createWorktree("acme/widget", "github", "hive/TASK-2", "main", 10);

    // Should fall back to the default-branch HEAD
    expect(result.baseSha).toBe(mainHead);
    expect(result.recovered).toBe(true);
  });

  it("uses default-branch HEAD as baseSha when no branch recovery (new branch)", async () => {
    const mainHead = "ccc3333333333333333333333333333333333333";

    // fetchBranch returns false → new branch
    mockFetchBranch.mockResolvedValue(false);

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);

        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          cb(null, { stdout: `${mainHead}\n`, stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    const result = await createWorktree("acme/widget", "github", "hive/TASK-3", "main", 10);

    // New branch: baseSha = default branch HEAD, no merge-base needed
    expect(result.baseSha).toBe(mainHead);
    expect(result.recovered).toBeFalsy();
  });
});

describe("cleanupWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls rm with recursive and force flags", async () => {
    mockRm.mockResolvedValue(undefined);

    const worktree: WorktreeInfo = {
      path: "/tmp/hive-worktrees/feature-test-123",
      branch: "feature/test",
      repoFullName: "acme/widget",
      provider: "github",
      createdAt: new Date(),
    };

    await cleanupWorktree(worktree);

    expect(mockRm).toHaveBeenCalledTimes(1);
    expect(mockRm).toHaveBeenCalledWith("/tmp/hive-worktrees/feature-test-123", {
      recursive: true,
      force: true,
    });
  });

  it("does not throw when rm fails (logs error instead)", async () => {
    mockRm.mockRejectedValue(new Error("EACCES: permission denied"));

    const worktree: WorktreeInfo = {
      path: "/tmp/hive-worktrees/feature-test-456",
      branch: "feature/test",
      repoFullName: "acme/widget",
      provider: "github",
      createdAt: new Date(),
    };

    // Should not throw
    await expect(cleanupWorktree(worktree)).resolves.toBeUndefined();
  });
});
