import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SDK so we never call the real Anthropic API
vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
  callClaudeWithTools: vi.fn(),
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
  gate: { mode: "auto" as string },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    default: "claude-sonnet-4-20250514",
    components: {},
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [] as Array<{ name: string; enabled: boolean }>,
  clarification: { mode: "auto" as string },
  preview: {
    enabled: false,
    max_concurrent: 3,
    cleanup_timeout_minutes: 30,
    docker_host: { ip: "", port: 2376, tls_cert_vault_secret: "", tls_key_vault_secret: "", tls_ca_vault_secret: "", ssh_key_vault_secret: "", ssh_user: "" },
    port_range: [4001, 4099],
  },
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  getModelFor: (c: string) => mockConfig.models.components[c] ?? mockConfig.models.default,
  loadConfig: () => mockConfig,
}));

// Mock node:fs for prompt loading and existsSync
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "You are an implementation agent."),
  existsSync: vi.fn(() => false), // No repo dir available (skips enrichment)
  rm: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock node:fs/promises for access() in worktree reuse check
vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  rm: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock node:child_process for git diff in empty-diff detection
const mockExecFile = vi.fn().mockResolvedValue({ stdout: "src/auth.ts\n", stderr: "" });
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

// Mock worktree functions
const mockCreateWorktree = vi.fn();
const mockCleanupWorktree = vi.fn();
const mockResolveGitCredentials = vi.fn();

vi.mock("../../src/execution/worktree.js", () => ({
  createWorktree: mockCreateWorktree,
  cleanupWorktree: mockCleanupWorktree,
  resolveGitCredentials: mockResolveGitCredentials,
}));

// Mock git provider
const mockGitProvider = {
  clone: vi.fn(),
  createBranch: vi.fn(),
  commitAll: vi.fn(),
  push: vi.fn(),
  createPR: vi.fn(),
  commentOnPR: vi.fn(),
};

vi.mock("../../src/execution/git-provider.js", () => ({
  getGitProvider: () => mockGitProvider,
}));

// Mock review gate
const mockReviewChanges = vi.fn();
vi.mock("../../src/execution/review-gate.js", () => ({
  reviewChanges: mockReviewChanges,
  validateBaseSha: vi.fn((_path: string, sha: string) => Promise.resolve(sha)),
}));

// Mock refiner
vi.mock("../../src/agents/refiner.js", () => ({
  refineTask: vi.fn(),
}));

// Mock decomposer
vi.mock("../../src/agents/decomposer.js", () => ({
  decomposeEpic: vi.fn(),
}));

// Mock worker-tools so we don't need real filesystem/exec
vi.mock("../../src/execution/worker-tools.js", () => ({
  WORKER_TOOLS: [],
  createWorktreeToolExecutor: vi.fn(() => vi.fn()),
}));

// Mock hive-yaml parser
vi.mock("../../src/hive-yaml.js", () => ({
  parseHiveYaml: vi.fn().mockReturnValue(null),
}));

// Mock preview manager
vi.mock("../../src/execution/preview/manager.js", () => ({
  previewManager: {
    startPreview: vi.fn(),
    getPreviewInfo: vi.fn().mockReturnValue(undefined),
    stopPreview: vi.fn(),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude, callClaudeWithTools } = await import("../../src/agents/sdk.js");
const { runPipeline } = await import("../../src/agents/pipeline.js");
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const {
  create: createTask,
  getById,
} = await import("../../src/db/queries/tasks.js");
const { decomposeEpic } = await import("../../src/agents/decomposer.js");

import type { ReviewGateResult, WorktreeInfo } from "../../src/domain/types.js";

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;
const mockCallClaudeWithTools = callClaudeWithTools as ReturnType<typeof vi.fn>;
const mockDecomposeEpic = decomposeEpic as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

const sampleWorktree: WorktreeInfo = {
  path: "/tmp/hive-worktrees/integration-test",
  branch: "hive/integration-test",
  repoFullName: "acme/widget",
  provider: "github",
  createdAt: new Date(),
  baseSha: "abc1234",
};

const passReviewResult: ReviewGateResult = {
  verdict: "pass",
  findings: [],
  securityFindings: [],
  verification: {
    testsRun: true,
    testsPassed: true,
    lintClean: true,
    buildSucceeded: true,
    notes: [],
  },
  costUsd: 0.001,
};

async function seedPendingTask(workflow: string = "flow") {
  const user = await findOrCreateByEntraOid(
    "oid-integration-test",
    "integration@example.com",
    "Integration User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
    workflow,
  });
  return { user, repo, task };
}

function mockRouterResponse(size: string = "small", workflow: string = "flow") {
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({
      type: "bug",
      size,
      workflow,
      model: "claude-sonnet-4-20250514",
    }),
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
      outputTokens: 50,
    },
  });
}

function mockGateApproveResponse() {
  mockCallClaude.mockResolvedValueOnce({
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

function mockWorkerResponse() {
  mockCallClaudeWithTools.mockResolvedValueOnce({
    text: "Implementation complete. Files changed: src/auth.ts",
    cost: {
      model: "claude-sonnet-4-20250514",
      inputTokens: 2000,
      outputTokens: 500,
    },
    turns: 3,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Pipeline integration: pending to done", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
    mockConfig.gate.mode = "auto";
    mockConfig.enrichers = [];

    // Default mock setups for worker
    mockCreateWorktree.mockResolvedValue(sampleWorktree);
    mockCleanupWorktree.mockResolvedValue(undefined);
    mockResolveGitCredentials.mockResolvedValue({ provider: "github", token: "test-token" });
    mockGitProvider.commitAll.mockResolvedValue(undefined);
    mockGitProvider.push.mockResolvedValue(undefined);
    mockGitProvider.createPR.mockResolvedValue({ url: "https://github.com/acme/widget/pull/42", reused: false });
  });

  it("runs full pipeline from pending to done for a small flow task (auto-approve)", async () => {
    const { task } = await seedPendingTask();

    // Router classifies as small (auto-approved, no gate LLM call)
    mockRouterResponse("small", "flow");

    // Worker implementation
    mockWorkerResponse();

    // Review gate passes
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    await runPipeline(task.id);

    // Verify final state
    const final = await getById(task.id);
    expect(final!.status).toBe("done");
    expect(final!.prUrl).toBe("https://github.com/acme/widget/pull/42");
    expect(final!.type).toBe("bug");
    expect(final!.size).toBe("small");
    expect(final!.workflow).toBe("flow");
    expect(final!.executionAttempts).toBe(1);

    // Verify costs were recorded (at least router + worker)
    const { db: testDb } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const costRows = await testDb
      .select()
      .from(costs)
      .where(eq(costs.taskId, task.id));

    const agents = costRows.map((r) => r.agent);
    expect(agents).toContain("router");
    expect(agents).toContain("worker");
  });

  it("runs full pipeline with AI gate for medium task", async () => {
    const { task } = await seedPendingTask();

    // Router classifies as medium (requires AI gate)
    mockRouterResponse("medium", "flow");

    // Gate approves
    mockGateApproveResponse();

    // Worker implementation
    mockWorkerResponse();

    // Review gate passes
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    await runPipeline(task.id);

    // Verify final state
    const final = await getById(task.id);
    expect(final!.status).toBe("done");
    expect(final!.prUrl).toBe("https://github.com/acme/widget/pull/42");

    // 2 callClaude calls (router + gate), 1 callClaudeWithTools (worker)
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(mockCallClaudeWithTools).toHaveBeenCalledTimes(1);

    // Verify gate decision was recorded
    const { gateDecisions } = await import("../../src/db/schema.js");
    const { db: testDb } = await import("../setup.js");
    const { eq: eq2 } = await import("drizzle-orm");

    const decisions = await testDb
      .select()
      .from(gateDecisions)
      .where(eq2(gateDecisions.taskId, task.id));

    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].verdict).toBe("approve");
  });

  it("does not execute when gate mode is human (stops at ready)", async () => {
    mockConfig.gate.mode = "human";
    const { task } = await seedPendingTask();

    mockRouterResponse("small", "flow");

    await runPipeline(task.id);

    // In human mode, task transitions to ready and stops
    const final = await getById(task.id);
    expect(final!.status).toBe("ready");

    // Worker should not have been called
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it("calls executeEpic when task workflow is epic", async () => {
    const { task } = await seedPendingTask("epic");

    // Router classifies as small epic (auto-approved)
    mockRouterResponse("small", "epic");

    // Mock the decomposer to return milestones
    mockDecomposeEpic.mockResolvedValueOnce([
      { title: "Milestone 1", body: "First step", index: 0, total: 2 },
      { title: "Milestone 2", body: "Second step", index: 1, total: 2 },
    ]);

    await runPipeline(task.id);

    // Epic goes: approved -> executing -> reviewing -> done
    const final = await getById(task.id);
    expect(final!.status).toBe("done");

    // Verify child tasks were created
    const { db: testDb } = await import("../setup.js");
    const { tasks: tasksTable } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const children = await testDb
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.epicId, task.id));

    expect(children).toHaveLength(2);
    expect(children[0].workflow).toBe("flow");
    expect(children[1].workflow).toBe("flow");
  });

  it("pipeline fails task when worker execution fails", async () => {
    const { task } = await seedPendingTask();

    // Router classifies as small (auto-approved)
    mockRouterResponse("small", "flow");

    // Worker implementation fails
    mockCreateWorktree.mockRejectedValueOnce(new Error("Failed to clone repository"));

    await runPipeline(task.id);

    // Task should be failed
    const final = await getById(task.id);
    expect(final!.status).toBe("failed");
    expect(final!.failureReason).toBe("Failed to clone repository");
  });
});
