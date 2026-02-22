import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

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

const { GitHubProvider, AzureDevOpsProvider, getGitProvider, extractGitHubPRNumber, extractAdoPRNumber } = await import(
  "../../src/execution/git-provider.js"
);

import type { GitCredentials } from "../../src/domain/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupExecFileSuccess(stdout = "") {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, stdout, "");
    },
  );
}

function setupExecFileFailure(error: Error) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(error, "", "fatal error");
    },
  );
}

const githubCreds: GitCredentials = {
  provider: "github",
  token: "ghp_test-token-123",
};

const azureCreds: GitCredentials = {
  provider: "azure_devops",
  token: "ado-token-456",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GitHubProvider", () => {
  let provider: InstanceType<typeof GitHubProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GitHubProvider();
  });

  // ── clone ──────────────────────────────────────────────────────────────────

  describe("clone", () => {
    it("constructs correct URL with embedded token and strips it after clone", async () => {
      setupExecFileSuccess();

      await provider.clone("acme/widget", "/tmp/clone", "main", githubCreds);

      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // First call: clone with embedded token
      const [cmd, args, opts] = mockExecFile.mock.calls[0];
      expect(cmd).toBe("git");
      expect(args).toEqual([
        "clone",
        "--branch",
        "main",
        "--single-branch",
        "https://x-access-token:ghp_test-token-123@github.com/acme/widget.git",
        "/tmp/clone",
      ]);
      expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");

      // Second call: strip token from remote URL
      const [cmd2, args2] = mockExecFile.mock.calls[1];
      expect(cmd2).toBe("git");
      expect(args2).toEqual([
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/widget.git",
      ]);
    });

    it("rejects when git clone fails", async () => {
      setupExecFileFailure(new Error("clone failed"));

      await expect(
        provider.clone("acme/widget", "/tmp/clone", "main", githubCreds),
      ).rejects.toThrow("clone failed");
    });
  });

  // ── createBranch ───────────────────────────────────────────────────────────

  describe("createBranch", () => {
    it("calls git checkout -b with correct branch name", async () => {
      setupExecFileSuccess();

      await provider.createBranch("/tmp/repo", "feature/my-branch");

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockExecFile.mock.calls[0];
      expect(cmd).toBe("git");
      expect(args).toEqual(["checkout", "-b", "feature/my-branch"]);
      expect(opts.cwd).toBe("/tmp/repo");
    });
  });

  // ── commitAll ──────────────────────────────────────────────────────────────

  describe("commitAll", () => {
    it("calls git add -A then git commit -m", async () => {
      setupExecFileSuccess();

      await provider.commitAll("/tmp/repo", "fix: resolve login bug");

      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // First call: git add -A
      const [cmd1, args1, opts1] = mockExecFile.mock.calls[0];
      expect(cmd1).toBe("git");
      expect(args1).toEqual(["add", "-A"]);
      expect(opts1.cwd).toBe("/tmp/repo");

      // Second call: git commit -m
      const [cmd2, args2, opts2] = mockExecFile.mock.calls[1];
      expect(cmd2).toBe("git");
      expect(args2).toEqual(["commit", "-m", "fix: resolve login bug"]);
      expect(opts2.cwd).toBe("/tmp/repo");
    });
  });

  // ── push ───────────────────────────────────────────────────────────────────

  describe("push", () => {
    it("sets remote URL with token, fetches, and pushes", async () => {
      // First call: remote get-url -> returns existing URL
      // Second call: remote set-url -> succeeds
      // Third call: fetch (refresh tracking refs) -> succeeds
      // Fourth call: push -> succeeds
      let callCount = 0;
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: Record<string, unknown>,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callCount++;
          if (callCount === 1) {
            // remote get-url
            cb(null, "https://x-access-token:old-token@github.com/acme/widget.git", "");
          } else {
            cb(null, "", "");
          }
        },
      );

      await provider.push("/tmp/repo", "feature/my-branch", githubCreds);

      expect(mockExecFile).toHaveBeenCalledTimes(4);

      // First: get-url
      expect(mockExecFile.mock.calls[0][1]).toEqual(["remote", "get-url", "origin"]);

      // Second: set-url with new token
      expect(mockExecFile.mock.calls[1][1]).toEqual([
        "remote",
        "set-url",
        "origin",
        "https://x-access-token:ghp_test-token-123@github.com/acme/widget.git",
      ]);

      // Third: fetch to refresh tracking refs
      expect(mockExecFile.mock.calls[2][1]).toEqual(["fetch", "origin", "feature/my-branch"]);

      // Fourth: push
      expect(mockExecFile.mock.calls[3][1]).toEqual(["push", "--force-with-lease", "origin", "feature/my-branch"]);
    });
  });

  // ── createPR ───────────────────────────────────────────────────────────────

  describe("createPR", () => {
    it("calls GitHub API with correct payload and returns PR URL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ html_url: "https://github.com/acme/widget/pull/42" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const url = await provider.createPR(
        "acme/widget",
        "feature/my-branch",
        "main",
        "Fix login bug",
        "Resolves the login form crash",
        githubCreds,
      );

      expect(url).toBe("https://github.com/acme/widget/pull/42");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe("https://api.github.com/repos/acme/widget/pulls");
      expect(fetchOpts.method).toBe("POST");
      expect(fetchOpts.headers.Authorization).toBe("Bearer ghp_test-token-123");
      expect(JSON.parse(fetchOpts.body)).toEqual({
        title: "Fix login bug",
        body: "Resolves the login form crash",
        head: "feature/my-branch",
        base: "main",
      });

      vi.unstubAllGlobals();
    });

    it("throws on non-OK response from GitHub API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "Validation Failed",
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        provider.createPR(
          "acme/widget",
          "feature/my-branch",
          "main",
          "Title",
          "Body",
          githubCreds,
        ),
      ).rejects.toThrow("GitHub PR creation failed (422): Validation Failed");

      vi.unstubAllGlobals();
    });
  });
});

// ── AzureDevOpsProvider ─────────────────────────────────────────────────────

describe("AzureDevOpsProvider", () => {
  let provider: InstanceType<typeof AzureDevOpsProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AzureDevOpsProvider();
  });

  describe("clone", () => {
    it("constructs correct Azure DevOps URL with token and strips it after clone", async () => {
      setupExecFileSuccess();

      await provider.clone("myorg/myproject/myrepo", "/tmp/clone", "main", azureCreds);

      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // First call: clone with embedded token
      const [cmd, args] = mockExecFile.mock.calls[0];
      expect(cmd).toBe("git");
      expect(args).toEqual([
        "clone",
        "--branch",
        "main",
        "--single-branch",
        "https://ado-token-456@dev.azure.com/myorg/myproject/_git/myrepo",
        "/tmp/clone",
      ]);

      // Second call: strip token from remote URL
      const [cmd2, args2] = mockExecFile.mock.calls[1];
      expect(cmd2).toBe("git");
      expect(args2).toEqual([
        "remote",
        "set-url",
        "origin",
        "https://dev.azure.com/myorg/myproject/_git/myrepo",
      ]);
    });

    it("throws on invalid repoFullName format", async () => {
      setupExecFileSuccess();

      await expect(
        provider.clone("invalid-format", "/tmp/clone", "main", azureCreds),
      ).rejects.toThrow("Invalid Azure DevOps repo format");
    });
  });

  describe("createBranch", () => {
    it("calls git checkout -b (same as GitHub)", async () => {
      setupExecFileSuccess();

      await provider.createBranch("/tmp/repo", "feature/ado-branch");

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const [, args] = mockExecFile.mock.calls[0];
      expect(args).toEqual(["checkout", "-b", "feature/ado-branch"]);
    });
  });

  describe("commitAll", () => {
    it("calls git add -A then git commit -m (same as GitHub)", async () => {
      setupExecFileSuccess();

      await provider.commitAll("/tmp/repo", "chore: update config");

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0][1]).toEqual(["add", "-A"]);
      expect(mockExecFile.mock.calls[1][1]).toEqual(["commit", "-m", "chore: update config"]);
    });
  });

  describe("createPR", () => {
    it("calls Azure DevOps API and returns PR URL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pullRequestId: 77,
          repository: { webUrl: "https://dev.azure.com/myorg/myproject/_git/myrepo" },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const url = await provider.createPR(
        "myorg/myproject/myrepo",
        "feature/ado-branch",
        "main",
        "Fix login bug",
        "Resolves the login crash",
        azureCreds,
      );

      expect(url).toBe(
        "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/77",
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toContain("dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests");
      expect(fetchOpts.method).toBe("POST");

      const body = JSON.parse(fetchOpts.body);
      expect(body.sourceRefName).toBe("refs/heads/feature/ado-branch");
      expect(body.targetRefName).toBe("refs/heads/main");
      expect(body.title).toBe("Fix login bug");

      vi.unstubAllGlobals();
    });

    it("throws on invalid repo name format", async () => {
      await expect(
        provider.createPR(
          "invalid-format",
          "branch",
          "main",
          "Title",
          "Body",
          azureCreds,
        ),
      ).rejects.toThrow("Invalid Azure DevOps repo name");
    });

    it("throws on non-OK response from Azure DevOps API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => "Conflict: PR already exists",
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        provider.createPR(
          "myorg/myproject/myrepo",
          "feature/ado-branch",
          "main",
          "Title",
          "Body",
          azureCreds,
        ),
      ).rejects.toThrow("Azure DevOps PR creation failed (409): Conflict: PR already exists");

      vi.unstubAllGlobals();
    });
  });
});

// ── PR Number Extractors ────────────────────────────────────────────────────

describe("extractGitHubPRNumber", () => {
  it("extracts number from standard GitHub PR URL", () => {
    expect(extractGitHubPRNumber("https://github.com/acme/widget/pull/42")).toBe(42);
  });

  it("extracts number from PR URL with trailing segments", () => {
    expect(extractGitHubPRNumber("https://github.com/acme/widget/pull/123/files")).toBe(123);
  });

  it("throws on invalid URL without /pull/ segment", () => {
    expect(() => extractGitHubPRNumber("https://github.com/acme/widget")).toThrow(
      "Cannot extract PR number from GitHub URL",
    );
  });
});

describe("extractAdoPRNumber", () => {
  it("extracts number from standard ADO PR URL", () => {
    expect(extractAdoPRNumber("https://dev.azure.com/org/proj/_git/repo/pullrequest/77")).toBe(77);
  });

  it("throws on invalid URL without /pullrequest/ segment", () => {
    expect(() => extractAdoPRNumber("https://dev.azure.com/org/proj/_git/repo")).toThrow(
      "Cannot extract PR number from Azure DevOps URL",
    );
  });
});

// ── GitHubProvider — commentOnPR ────────────────────────────────────────────

describe("GitHubProvider — commentOnPR", () => {
  let provider: InstanceType<typeof GitHubProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GitHubProvider();
  });

  it("posts a comment to the correct GitHub Issues API endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", mockFetch);

    await provider.commentOnPR(
      "acme/widget",
      "https://github.com/acme/widget/pull/42",
      "Preview is ready!",
      githubCreds,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/widget/issues/42/comments");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ body: "Preview is ready!" });

    vi.unstubAllGlobals();
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      provider.commentOnPR("acme/widget", "https://github.com/acme/widget/pull/1", "test", githubCreds),
    ).rejects.toThrow("GitHub PR comment failed (403): Forbidden");

    vi.unstubAllGlobals();
  });
});

// ── GitHubProvider — getPRState ─────────────────────────────────────────────

describe("GitHubProvider — getPRState", () => {
  let provider: InstanceType<typeof GitHubProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GitHubProvider();
  });

  it("returns 'open' for an open PR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "open", merged: false }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const state = await provider.getPRState("acme/widget", "https://github.com/acme/widget/pull/10", githubCreds);
    expect(state).toBe("open");

    vi.unstubAllGlobals();
  });

  it("returns 'merged' when merged is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "closed", merged: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const state = await provider.getPRState("acme/widget", "https://github.com/acme/widget/pull/10", githubCreds);
    expect(state).toBe("merged");

    vi.unstubAllGlobals();
  });

  it("returns 'closed' for a closed but not merged PR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "closed", merged: false }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const state = await provider.getPRState("acme/widget", "https://github.com/acme/widget/pull/10", githubCreds);
    expect(state).toBe("closed");

    vi.unstubAllGlobals();
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      provider.getPRState("acme/widget", "https://github.com/acme/widget/pull/999", githubCreds),
    ).rejects.toThrow("GitHub get PR state failed (404): Not Found");

    vi.unstubAllGlobals();
  });
});

// ── AzureDevOpsProvider — commentOnPR ───────────────────────────────────────

describe("AzureDevOpsProvider — commentOnPR", () => {
  let provider: InstanceType<typeof AzureDevOpsProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AzureDevOpsProvider();
  });

  it("delegates to ADO createPRComment with correct params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", mockFetch);

    await provider.commentOnPR(
      "myorg/myproject/myrepo",
      "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/77",
      "Preview ready",
      azureCreds,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("pullrequests/77/threads");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.comments[0].content).toBe("Preview ready");

    vi.unstubAllGlobals();
  });
});

// ── AzureDevOpsProvider — getPRState ────────────────────────────────────────

describe("AzureDevOpsProvider — getPRState", () => {
  let provider: InstanceType<typeof AzureDevOpsProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AzureDevOpsProvider();
  });

  it("returns 'open' for active ADO PR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pullRequestId: 77, status: "active" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const state = await provider.getPRState(
      "myorg/myproject/myrepo",
      "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/77",
      azureCreds,
    );
    expect(state).toBe("open");

    vi.unstubAllGlobals();
  });

  it("returns 'merged' for completed ADO PR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pullRequestId: 77, status: "completed" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const state = await provider.getPRState(
      "myorg/myproject/myrepo",
      "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/77",
      azureCreds,
    );
    expect(state).toBe("merged");

    vi.unstubAllGlobals();
  });

  it("returns 'closed' for abandoned ADO PR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pullRequestId: 77, status: "abandoned" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const state = await provider.getPRState(
      "myorg/myproject/myrepo",
      "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/77",
      azureCreds,
    );
    expect(state).toBe("closed");

    vi.unstubAllGlobals();
  });
});

// ── getGitProvider factory ──────────────────────────────────────────────────

describe("getGitProvider", () => {
  it("returns GitHubProvider for 'github'", () => {
    const provider = getGitProvider("github");
    expect(provider).toBeInstanceOf(GitHubProvider);
  });

  it("returns AzureDevOpsProvider for 'azure_devops'", () => {
    const provider = getGitProvider("azure_devops");
    expect(provider).toBeInstanceOf(AzureDevOpsProvider);
  });

  it("throws for unknown provider", () => {
    expect(() => getGitProvider("gitlab")).toThrow("Unknown git provider: gitlab");
  });
});
