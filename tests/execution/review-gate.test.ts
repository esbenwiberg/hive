import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SDK so we never call the real Anthropic API but keep extractJson
vi.mock("../../src/agents/sdk.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/agents/sdk.js")>();
  return { ...original, callClaude: vi.fn() };
});

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

// Mock the autonomous config
const mockConfig = {
  classification: { defaultType: "improvement", defaultSize: "medium" },
  gate: { mode: "ai" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    default: "claude-sonnet-4-20250514",
    components: {},
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [],
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  getModelFor: (c: string) => mockConfig.models.components[c] ?? mockConfig.models.default,
  loadConfig: () => mockConfig,
}));

// Mock node:child_process for git commands
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Mock node:fs for prompt loading
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "You are a code reviewer. Return JSON with verdict, findings, securityFindings, verification."),
}));

// Mock fire-and-forget side effects so they don't re-register active agents
vi.mock("../../src/agents/feedback-loop.js", () => ({
  fireAndForgetFeedback: vi.fn(),
}));
vi.mock("../../src/agents/code-quality-analyst.js", () => ({
  analyzeReviewPatterns: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { reviewChanges, parseReviewResult, validateBaseSha } = await import(
  "../../src/execution/review-gate.js"
);
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
const { listByTask: listCodeReviews } = await import(
  "../../src/db/queries/code-reviews.js"
);
const { listActive } = await import(
  "../../src/db/queries/active-agents.js"
);

import type { WorktreeInfo } from "../../src/domain/types.js";

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Makes the mockExecFile call the callback with the given stdout.
 * Handles the promisified pattern: execFile(cmd, args, opts, callback)
 */
function setupExecFileMock(diffStat: string, diffFull: string, changedFiles: string) {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      // promisify calls execFile with 3 args (cmd, args, opts) and expects
      // the last argument to be a callback
      const cb = callback ?? (opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);

      if (args.includes("--stat")) {
        cb(null, { stdout: diffStat, stderr: "" });
      } else if (args.includes("--name-only")) {
        cb(null, { stdout: changedFiles, stderr: "" });
      } else if (args[0] === "diff") {
        cb(null, { stdout: diffFull, stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

const sampleWorktree: WorktreeInfo = {
  path: "/tmp/hive-worktrees/feature-test-123",
  branch: "feature/test",
  repoFullName: "acme/widget",
  provider: "github",
  createdAt: new Date(),
};

async function seedReviewingTask() {
  const user = await findOrCreateByEntraOid(
    "oid-review-test",
    "review@example.com",
    "Review User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });

  // Transition: pending -> queued -> enriching -> approved -> executing -> reviewing
  await updateStatus(task.id, "queued");
  await updateStatus(task.id, "enriching");
  await updateStatus(task.id, "approved");
  await updateStatus(task.id, "executing");
  await updateStatus(task.id, "reviewing");

  const updated = await getById(task.id);
  return { user, repo, task: updated! };
}

function mockPassResponse() {
  mockCallClaude.mockResolvedValue({
    text: JSON.stringify({
      verdict: "pass",
      findings: [],
      securityFindings: [],
      verification: {
        testsRun: true,
        testsPassed: true,
        lintClean: true,
        buildSucceeded: true,
        notes: ["All 12 tests passed"],
      },
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1200,
      outputTokens: 100,
    },
  });
}

function mockReworkResponse() {
  mockCallClaude.mockResolvedValue({
    text: JSON.stringify({
      verdict: "rework",
      findings: [
        { severity: "major", file: "src/auth.ts", line: 42, message: "Missing null check", category: "correctness" },
      ],
      securityFindings: [],
      verification: {
        testsRun: true,
        testsPassed: false,
        lintClean: true,
        buildSucceeded: true,
        notes: ["2 tests failed"],
      },
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1200,
      outputTokens: 150,
    },
  });
}

function mockFailResponse() {
  mockCallClaude.mockResolvedValue({
    text: JSON.stringify({
      verdict: "fail",
      findings: [
        { severity: "critical", file: "src/db.ts", line: 10, message: "SQL injection vulnerability", category: "correctness" },
      ],
      securityFindings: [
        { severity: "critical", type: "injection", description: "Raw SQL query with user input", file: "src/db.ts" },
      ],
      verification: {
        testsRun: false,
        testsPassed: false,
        lintClean: false,
        buildSucceeded: false,
        notes: ["Build failed"],
      },
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1200,
      outputTokens: 200,
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("reviewChanges", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
    setupExecFileMock(
      " src/auth.ts | 10 +++++++---\n 1 file changed, 7 insertions(+), 3 deletions(-)",
      "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,7 @@\n+function login() {}",
      "src/auth.ts",
    );
  });

  it("returns pass verdict and records code review", async () => {
    const { task } = await seedReviewingTask();
    mockPassResponse();

    const result = await reviewChanges(task.id, sampleWorktree);

    expect(result.verdict).toBe("pass");
    expect(result.findings).toHaveLength(0);
    expect(result.securityFindings).toHaveLength(0);
    expect(result.verification.testsRun).toBe(true);
    expect(result.verification.testsPassed).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);

    // Verify code review was recorded
    const reviews = await listCodeReviews(task.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].verdict).toBe("pass");
  });

  it("returns rework verdict with findings", async () => {
    const { task } = await seedReviewingTask();
    mockReworkResponse();

    const result = await reviewChanges(task.id, sampleWorktree);

    expect(result.verdict).toBe("rework");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("major");
    expect(result.findings[0].file).toBe("src/auth.ts");

    const reviews = await listCodeReviews(task.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].verdict).toBe("rework");
  });

  it("normalizes fail verdict to rework with security findings preserved", async () => {
    const { task } = await seedReviewingTask();
    mockFailResponse();

    const result = await reviewChanges(task.id, sampleWorktree);

    // "fail" is normalized to "rework" — no terminal fail verdict
    expect(result.verdict).toBe("rework");
    expect(result.securityFindings).toHaveLength(1);
    expect(result.securityFindings[0].type).toBe("injection");

    const reviews = await listCodeReviews(task.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].verdict).toBe("rework");
  });

  it("registers and unregisters active agent", async () => {
    const { task } = await seedReviewingTask();
    mockPassResponse();

    await reviewChanges(task.id, sampleWorktree);

    // After completion, no active agents should remain
    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("unregisters active agent after failure", async () => {
    const { task } = await seedReviewingTask();
    mockCallClaude.mockRejectedValue(new Error("API error"));

    await expect(reviewChanges(task.id, sampleWorktree)).rejects.toThrow("API error");

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("records cost after review", async () => {
    const { task, user } = await seedReviewingTask();
    mockPassResponse();

    await reviewChanges(task.id, sampleWorktree);

    // Verify a cost row was created
    const { db } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const { and: andOp } = await import("drizzle-orm");

    const rows = await db
      .select()
      .from(costs)
      .where(andOp(eq(costs.taskId, task.id), eq(costs.agent, "review-gate")));

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("review-gate");
    expect(rows[0].userId).toBe(user.id);
    expect(parseFloat(rows[0].costUsd)).toBeGreaterThan(0);
    expect(rows[0].turns).toBe(1);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when task not found", async () => {
    mockPassResponse();

    // register() is called before getById(), so the FK constraint on
    // active_agents.task_id fires first for a non-existent task id.
    await expect(
      reviewChanges("HIVE-00000000-0000", sampleWorktree),
    ).rejects.toThrow();
  });

  it("includes rework context in prompt when reworkCount > 0", async () => {
    const { task } = await seedReviewingTask();
    mockPassResponse();

    // Set reworkCount and reworkHistory on the task
    const { db } = await import("../setup.js");
    const { tasks } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(tasks).set({
      reworkCount: 1,
      reworkHistory: [
        {
          cycle: 1,
          findings: [{ severity: "major", file: "src/auth.ts", line: 42, message: "Missing null check", category: "correctness" }],
          securityFindings: [],
        },
      ],
    }).where(eq(tasks.id, task.id));

    await reviewChanges(task.id, sampleWorktree);

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).toContain("## Rework Context");
    expect(call.prompt).toContain("rework cycle 1");
    expect(call.prompt).toContain("Missing null check");
  });

  it("does not include rework context on first review (reworkCount = 0)", async () => {
    const { task } = await seedReviewingTask();
    mockPassResponse();

    await reviewChanges(task.id, sampleWorktree);

    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt).not.toContain("## Rework Context");
  });

  it("truncates very large diffs", async () => {
    const { task } = await seedReviewingTask();

    // Create a diff that exceeds the 400k char review limit
    const largeDiff = "x".repeat(500_000);
    setupExecFileMock("1 file changed", largeDiff, "big-file.ts");

    mockPassResponse();

    await reviewChanges(task.id, sampleWorktree);

    // The prompt should have been passed to callClaude with a truncated diff
    const call = mockCallClaude.mock.calls[0][0];
    expect(call.prompt.length).toBeLessThan(largeDiff.length);
  });
});

describe("parseReviewResult", () => {
  it("parses valid JSON with pass verdict", () => {
    const input = JSON.stringify({
      verdict: "pass",
      findings: [],
      securityFindings: [],
      verification: { testsRun: true, testsPassed: true, lintClean: true, buildSucceeded: true, notes: [] },
    });

    const result = parseReviewResult(input);

    expect(result.verdict).toBe("pass");
    expect(result.findings).toHaveLength(0);
    expect(result.costUsd).toBe(0);
  });

  it("handles markdown code fences around JSON", () => {
    const input = "```json\n" + JSON.stringify({
      verdict: "rework",
      findings: [{ severity: "minor", file: "test.ts", message: "Style issue", category: "style" }],
      securityFindings: [],
      verification: { testsRun: true, testsPassed: true, lintClean: false, buildSucceeded: true, notes: [] },
    }) + "\n```";

    const result = parseReviewResult(input);

    expect(result.verdict).toBe("rework");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("minor");
  });

  it("handles code fences without json language tag", () => {
    const input = "```\n" + JSON.stringify({
      verdict: "pass",
      findings: [],
      securityFindings: [],
    }) + "\n```";

    const result = parseReviewResult(input);

    expect(result.verdict).toBe("pass");
  });

  it("defaults to rework on invalid JSON", () => {
    const result = parseReviewResult("this is not json at all");

    expect(result.verdict).toBe("rework");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("Could not parse review response");
    expect(result.verification.notes).toContain("Review response was not valid JSON");
  });

  it("normalizes invalid verdict to rework", () => {
    const input = JSON.stringify({
      verdict: "maybe",
      findings: [],
      securityFindings: [],
    });

    const result = parseReviewResult(input);

    // Any non-pass verdict is silently normalized to "rework"
    expect(result.verdict).toBe("rework");
    expect(result.findings).toHaveLength(0);
  });

  it("provides default verification when missing", () => {
    const input = JSON.stringify({
      verdict: "pass",
      findings: [],
      securityFindings: [],
    });

    const result = parseReviewResult(input);

    expect(result.verification).toEqual({
      testsRun: false,
      testsPassed: false,
      lintClean: false,
      buildSucceeded: false,
      notes: [],
    });
  });

  it("handles missing findings arrays gracefully", () => {
    const input = JSON.stringify({
      verdict: "pass",
    });

    const result = parseReviewResult(input);

    expect(result.verdict).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.securityFindings).toEqual([]);
  });

  it("preserves advisory field on security findings", () => {
    const input = JSON.stringify({
      verdict: "rework",
      findings: [],
      securityFindings: [
        { severity: "medium", type: "auth", description: "Consider rate limiting", file: "src/api.ts", advisory: true },
        { severity: "critical", type: "injection", description: "SQL injection", file: "src/db.ts", advisory: false },
        { severity: "low", type: "other", description: "Missing CSRF", file: "src/routes.ts" },
      ],
      verification: { testsRun: true, testsPassed: true, lintClean: true, buildSucceeded: true, notes: [] },
    });

    const result = parseReviewResult(input);

    expect(result.securityFindings).toHaveLength(3);
    expect(result.securityFindings[0].advisory).toBe(true);
    expect(result.securityFindings[1].advisory).toBeUndefined();
    expect(result.securityFindings[2].advisory).toBeUndefined();
  });
});

describe("validateBaseSha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns baseSha unchanged when it is a valid ancestor", async () => {
    // --is-ancestor exits 0 → baseSha is valid
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);
        cb(null, { stdout: "", stderr: "" });
      },
    );

    const result = await validateBaseSha("/tmp/worktree", "abc123");
    expect(result).toBe("abc123");
  });

  it("recomputes merge-base when baseSha is not an ancestor", async () => {
    const correctedSha = "fff999";

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);

        if (args.includes("--is-ancestor")) {
          // Not an ancestor → exit code 1
          cb(new Error("exit code 1"), { stdout: "", stderr: "" });
        } else if (args[0] === "merge-base") {
          // merge-base succeeds with corrected SHA
          cb(null, { stdout: `${correctedSha}\n`, stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    const result = await validateBaseSha("/tmp/worktree", "stale-sha");
    expect(result).toBe(correctedSha);
  });

  it("falls back to original baseSha when both ancestor check and merge-base fail", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        const cb = callback ?? (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void);
        // Both calls fail
        cb(new Error("git error"), { stdout: "", stderr: "" });
      },
    );

    const result = await validateBaseSha("/tmp/worktree", "original-sha");
    expect(result).toBe("original-sha");
  });
});
