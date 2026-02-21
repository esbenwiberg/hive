import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock child_process so we never run real shell commands
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock the SDK so we never call the real Anthropic API
vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
  callClaudeWithTools: vi.fn(),
}));

// Mock cost-utils to return a deterministic cost
vi.mock("../../src/agents/cost-utils.js", () => ({
  estimateCostUsd: vi.fn().mockReturnValue(0.01),
}));

// Mock autonomous-config so reviewFix resolves its own models
vi.mock("../../src/domain/autonomous-config.js", () => ({
  getModelFor: vi.fn((component: string) => {
    if (component === "milestone-review") return "test-review-model";
    if (component === "milestone-fix") return "test-fix-model";
    return "test-default-model";
  }),
}));

// Mock the logger so tests don't produce output
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { callClaude, callClaudeWithTools } from "../../src/agents/sdk.js";
import { quickVerify, reviewFix } from "../../src/execution/milestone-review.js";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;
const mockCallClaudeWithTools = callClaudeWithTools as ReturnType<typeof vi.fn>;

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

/**
 * Makes the mockExecFile invoke its callback with success for all commands.
 * Handles the promisified pattern: execFile(cmd, args, opts, callback)
 */
function setupAllPass() {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback?: ExecFileCallback,
    ) => {
      const cb =
        callback ?? (_opts as ExecFileCallback);
      cb(null, { stdout: "", stderr: "" });
    },
  );
}

/**
 * Makes specific npm run commands fail while others succeed.
 * `failOn` is a set of labels to fail (e.g. "lint", "build", "test").
 */
function setupSelectiveFail(
  failOn: Set<string>,
  errorDetails?: Record<string, { stdout: string; stderr: string }>,
) {
  mockExecFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      callback?: ExecFileCallback,
    ) => {
      const cb =
        callback ?? (_opts as ExecFileCallback);

      // Determine which npm run step this is
      const step =
        cmd === "npm" && args[0] === "run" ? args[1] : undefined;

      if (step && failOn.has(step)) {
        const details = errorDetails?.[step];
        const err = new Error(`${step} failed`) as Error & {
          stdout?: string;
          stderr?: string;
        };
        err.stdout = details?.stdout ?? `${step} stdout`;
        err.stderr = details?.stderr ?? `${step} stderr`;
        cb(err);
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

/**
 * Sets up git commands to succeed (used during reviewFix's getDiff and getChangedFiles).
 */
function setupGitCommands(diff = "diff content", changedFiles = "src/foo.ts") {
  const existingImpl = mockExecFile.getMockImplementation();

  mockExecFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      opts: unknown,
      callback?: ExecFileCallback,
    ) => {
      const cb =
        callback ?? (opts as ExecFileCallback);

      if (cmd === "git") {
        if (args[0] === "diff" && args.includes("--name-only")) {
          cb(null, { stdout: changedFiles, stderr: "" });
        } else if (args[0] === "diff") {
          cb(null, { stdout: diff, stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return;
      }

      // Delegate to the existing implementation for npm commands
      if (existingImpl) {
        existingImpl(cmd, args, opts, callback);
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("quickVerify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when all scripts succeed", async () => {
    setupAllPass();

    const result = await quickVerify("/tmp/test-worktree");

    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);

    // Verify all three npm commands were invoked
    const npmCalls = mockExecFile.mock.calls.filter(
      (call: unknown[]) => call[0] === "npm",
    );
    expect(npmCalls).toHaveLength(3);

    // Verify correct args for each call
    expect(npmCalls[0][1]).toEqual(["run", "lint", "--if-present"]);
    expect(npmCalls[1][1]).toEqual(["run", "build", "--if-present"]);
    expect(npmCalls[2][1]).toEqual(["run", "test", "--if-present"]);

    // Verify cwd was passed
    for (const call of npmCalls) {
      expect(call[2]).toMatchObject({ cwd: "/tmp/test-worktree" });
    }
  });

  it("returns failures with captured output", async () => {
    setupSelectiveFail(new Set(["lint", "test"]), {
      lint: { stdout: "Lint error: no-unused-vars", stderr: "" },
      test: { stdout: "", stderr: "Error: test suite failed" },
    });

    const result = await quickVerify("/tmp/test-worktree");

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain("lint failed");
    expect(result.failures[0]).toContain("Lint error: no-unused-vars");
    expect(result.failures[1]).toContain("test failed");
    expect(result.failures[1]).toContain("Error: test suite failed");
  });

  it("handles missing scripts (--if-present) by collecting all failures", async () => {
    // All three fail
    setupSelectiveFail(new Set(["lint", "build", "test"]));

    const result = await quickVerify("/tmp/test-worktree");

    expect(result.passed).toBe(false);
    // All three are collected (doesn't stop at first failure)
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toContain("lint failed");
    expect(result.failures[1]).toContain("build failed");
    expect(result.failures[2]).toContain("test failed");
  });
});

describe("reviewFix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes on first try when clean (shell + Claude review find no issues)", async () => {
    // Shell commands all pass
    setupAllPass();

    // The reviewFix code will also call getDiff via git after shell passes
    // We need to handle both npm and git commands
    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        callback?: ExecFileCallback,
      ) => {
        const cb =
          callback ?? (opts as ExecFileCallback);

        if (cmd === "git") {
          if (args[0] === "diff") {
            cb(null, { stdout: "diff --git a/file.ts", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
        } else {
          // npm commands all succeed
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    // Claude review returns no issues
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ issues: [] }),
      cost: { model: "test-review-model", inputTokens: 100, outputTokens: 50 },
    });

    const result = await reviewFix("/tmp/test-worktree", "Add login feature", "test-model");

    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.costUsd).toBeGreaterThan(0);

    // callClaude should have been called once (for the code review) using the review model
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(mockCallClaude.mock.calls[0][0].model).toBe("test-review-model");
  });

  it("calls Claude fix + re-verifies on failure", async () => {
    // Track call count to vary behavior between iterations
    let npmCallCount = 0;

    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        callback?: ExecFileCallback,
      ) => {
        const cb =
          callback ?? (opts as ExecFileCallback);

        if (cmd === "git") {
          if (args[0] === "diff" && args.includes("--name-only")) {
            cb(null, { stdout: "src/foo.ts", stderr: "" });
          } else if (args[0] === "diff") {
            cb(null, { stdout: "diff content", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return;
        }

        // npm commands
        npmCallCount++;
        if (npmCallCount <= 3) {
          // First quickVerify: lint fails
          if (args[1] === "lint") {
            const err = new Error("lint failed") as Error & {
              stdout?: string;
              stderr?: string;
            };
            err.stdout = "lint error output";
            err.stderr = "";
            cb(err);
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
        } else {
          // Second quickVerify (after fix): all pass
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    // claudeFix uses callClaudeWithTools with fix model
    mockCallClaudeWithTools.mockResolvedValueOnce({
      text: "Fixed the lint error in src/foo.ts",
      cost: { model: "test-fix-model", inputTokens: 200, outputTokens: 100 },
    });

    // claudeReview after final verify passes uses callClaude with review model
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ issues: [] }),
      cost: { model: "test-review-model", inputTokens: 100, outputTokens: 50 },
    });

    const result = await reviewFix(
      "/tmp/test-worktree",
      "Add login feature",
      "test-model",
      2,
    );

    expect(result.passed).toBe(true);
    // callClaudeWithTools called once for fix, callClaude once for review
    expect(mockCallClaudeWithTools).toHaveBeenCalledTimes(1);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    // Verify models: fix uses fix model, review uses review model
    expect(mockCallClaudeWithTools.mock.calls[0][0].model).toBe("test-fix-model");
    expect(mockCallClaude.mock.calls[0][0].model).toBe("test-review-model");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("stops after maxIterations", async () => {
    // All npm lint calls fail every time
    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        callback?: ExecFileCallback,
      ) => {
        const cb =
          callback ?? (opts as ExecFileCallback);

        if (cmd === "git") {
          if (args[0] === "diff" && args.includes("--name-only")) {
            cb(null, { stdout: "src/foo.ts", stderr: "" });
          } else if (args[0] === "diff") {
            cb(null, { stdout: "diff content", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return;
        }

        // npm: lint always fails
        if (args[1] === "lint") {
          const err = new Error("lint failed") as Error & {
            stdout?: string;
            stderr?: string;
          };
          err.stdout = "persistent lint error";
          err.stderr = "";
          cb(err);
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    // claudeFix calls use callClaudeWithTools (one per iteration) with fix model
    mockCallClaudeWithTools.mockResolvedValue({
      text: "Attempted fix",
      cost: { model: "test-fix-model", inputTokens: 200, outputTokens: 100 },
    });

    const maxIterations = 2;
    const result = await reviewFix(
      "/tmp/test-worktree",
      "Add login feature",
      "test-model",
      maxIterations,
    );

    expect(result.passed).toBe(false);
    expect(result.iterations).toBe(maxIterations);
    expect(result.issues.length).toBeGreaterThan(0);

    // Each iteration: quickVerify fails -> claudeFix called
    // So claudeFix should be called maxIterations times
    expect(mockCallClaudeWithTools).toHaveBeenCalledTimes(maxIterations);
  });

  it("includes Claude code review when shell passes", async () => {
    // All shell commands pass
    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        callback?: ExecFileCallback,
      ) => {
        const cb =
          callback ?? (opts as ExecFileCallback);

        if (cmd === "git") {
          if (args[0] === "diff" && args.includes("--name-only")) {
            cb(null, { stdout: "src/bar.ts", stderr: "" });
          } else if (args[0] === "diff") {
            cb(null, { stdout: "diff --git a/src/bar.ts", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return;
        }

        // npm: all pass
        cb(null, { stdout: "", stderr: "" });
      },
    );

    // Claude review finds an issue (callClaude) using review model
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ issues: ["Missing null check on user input"] }),
      cost: { model: "test-review-model", inputTokens: 150, outputTokens: 60 },
    });

    // Claude fix (callClaudeWithTools) using fix model
    mockCallClaudeWithTools.mockResolvedValueOnce({
      text: "Added null check",
      cost: { model: "test-fix-model", inputTokens: 200, outputTokens: 100 },
    });

    // Final Claude review (callClaude) - clean this time, using review model
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ issues: [] }),
      cost: { model: "test-review-model", inputTokens: 100, outputTokens: 50 },
    });

    const result = await reviewFix(
      "/tmp/test-worktree",
      "Add bar feature",
      "test-model",
      2,
    );

    expect(result.passed).toBe(true);
    // The issue from the first Claude review should be in allIssues
    expect(result.issues).toContain("Missing null check on user input");
    // callClaude called 2 times (review + final review), callClaudeWithTools 1 time (fix)
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(mockCallClaudeWithTools).toHaveBeenCalledTimes(1);

    // Verify the first callClaude was the review (system prompt contains "Review")
    const firstCall = mockCallClaude.mock.calls[0][0];
    expect(firstCall.systemPrompt).toContain("Review");
  });

  it("uses incremental review with prior issues on iteration 2+", async () => {
    // Shell passes every time, but Claude review finds issues on first iteration
    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        callback?: ExecFileCallback,
      ) => {
        const cb =
          callback ?? (opts as ExecFileCallback);

        if (cmd === "git") {
          if (args[0] === "diff" && args.includes("--name-only")) {
            cb(null, { stdout: "src/baz.ts", stderr: "" });
          } else if (args[0] === "diff") {
            cb(null, { stdout: "diff --git a/src/baz.ts", stderr: "" });
          } else {
            cb(null, { stdout: "", stderr: "" });
          }
          return;
        }

        // npm: all pass
        cb(null, { stdout: "", stderr: "" });
      },
    );

    // First review: finds issues
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ issues: ["Unchecked return value"] }),
      cost: { model: "test-review-model", inputTokens: 150, outputTokens: 60 },
    });

    // Fix
    mockCallClaudeWithTools.mockResolvedValueOnce({
      text: "Fixed return value check",
      cost: { model: "test-fix-model", inputTokens: 200, outputTokens: 100 },
    });

    // Final review after fix: clean — this is the incremental review
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ issues: [] }),
      cost: { model: "test-review-model", inputTokens: 100, outputTokens: 50 },
    });

    const result = await reviewFix(
      "/tmp/test-worktree",
      "Add baz feature",
      "test-model",
      2,
    );

    expect(result.passed).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2);

    // The second callClaude (final review) should contain prior issues in the prompt
    const secondReviewPrompt = mockCallClaude.mock.calls[1][0].prompt as string;
    expect(secondReviewPrompt).toContain("Previously Identified Issues");
    expect(secondReviewPrompt).toContain("Unchecked return value");
  });
});
