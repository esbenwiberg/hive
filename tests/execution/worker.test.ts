import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SDK so we never call the real Anthropic API
vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
  callClaudeWithTools: vi.fn(),
}));

// Mock worker-tools so we don't need real filesystem/exec
vi.mock("../../src/execution/worker-tools.js", () => ({
  WORKER_TOOLS: [],
  createWorktreeToolExecutor: vi.fn(() => vi.fn()),
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

// Mock the autonomous config
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
  preview: {
    enabled: true,
    max_concurrent: 3,
    cleanup_timeout_minutes: 30,
    docker_host: { ip: "", port: 2376, tls_cert_vault_secret: "", tls_key_vault_secret: "", tls_ca_vault_secret: "" },
    port_range: [4001, 4099] as [number, number],
  },
};

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => mockConfig,
  getModelFor: (c: string) => mockConfig.models.components[c] ?? mockConfig.models.default,
  loadConfig: () => mockConfig,
}));

// Mock node:fs for prompt loading
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "You are an implementation agent."),
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
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Mock node:util to make promisify(execFile) return our mock
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
const mockValidateBaseSha = vi.fn((_path: string, sha: string) => Promise.resolve(sha));
vi.mock("../../src/execution/review-gate.js", () => ({
  reviewChanges: mockReviewChanges,
  validateBaseSha: mockValidateBaseSha,
}));

// Mock refiner
const mockRefineTask = vi.fn();
vi.mock("../../src/agents/refiner.js", () => ({
  refineTask: mockRefineTask,
}));

// Mock hive-yaml parser
const mockParseHiveYaml = vi.fn();
vi.mock("../../src/hive-yaml.js", () => ({
  parseHiveYaml: mockParseHiveYaml,
}));

// Mock browser validator (dynamically imported by worker during preview)
vi.mock("../../src/agents/browser-validator.js", () => ({
  validateWithBrowser: vi.fn().mockResolvedValue({ verdict: "pass", findings: [], costUsd: 0 }),
}));

// Mock preview manager
const mockStartPreview = vi.fn();
const mockGetPreviewInfo = vi.fn();
const mockStopPreview = vi.fn();

vi.mock("../../src/execution/preview/manager.js", () => ({
  previewManager: {
    startPreview: mockStartPreview,
    getPreviewInfo: mockGetPreviewInfo,
    stopPreview: mockStopPreview,
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaudeWithTools } = await import("../../src/agents/sdk.js");
const { executeTask, executeEpic } = await import(
  "../../src/execution/worker.js"
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
const { listActive } = await import(
  "../../src/db/queries/active-agents.js"
);

import type { ReviewGateResult, WorktreeInfo } from "../../src/domain/types.js";

const mockCallClaudeWithTools = callClaudeWithTools as ReturnType<typeof vi.fn>;

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

const sampleWorktree: WorktreeInfo = {
  path: "/tmp/hive-worktrees/hive-test-123",
  branch: "hive/test-123",
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

const reworkReviewResult: ReviewGateResult = {
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
  costUsd: 0.001,
};

const failReviewResult: ReviewGateResult = {
  verdict: "fail",
  findings: [
    { severity: "critical", file: "src/db.ts", line: 10, message: "SQL injection", category: "correctness" },
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
  costUsd: 0.001,
};

async function seedApprovedTask() {
  const user = await findOrCreateByEntraOid(
    "oid-worker-test",
    "worker@example.com",
    "Worker User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });

  // Transition: pending -> queued -> enriching -> approved
  await updateStatus(task.id, "queued");
  await updateStatus(task.id, "enriching");
  await updateStatus(task.id, "approved");

  const updated = await getById(task.id);
  return { user, repo, task: updated! };
}

async function seedEpicTask() {
  const user = await findOrCreateByEntraOid(
    "oid-epic-test",
    "epic@example.com",
    "Epic User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Build user authentication system",
    body: "Complete auth system with login, registration, and password reset",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
    workflow: "epic",
  });

  // Transition: pending -> queued -> enriching -> approved
  await updateStatus(task.id, "queued");
  await updateStatus(task.id, "enriching");
  await updateStatus(task.id, "approved");

  const updated = await getById(task.id);
  return { user, repo, task: updated! };
}

function mockClaudeResponse() {
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

describe("executeTask", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();

    // Default mock setups — git diff returns changed files (non-empty changeset)
    mockExecFile.mockResolvedValue({ stdout: "src/auth.ts\n", stderr: "" });
    mockCreateWorktree.mockResolvedValue(sampleWorktree);
    mockCleanupWorktree.mockResolvedValue(undefined);
    mockResolveGitCredentials.mockResolvedValue({ provider: "github", token: "test-token" });
    mockGitProvider.commitAll.mockResolvedValue(undefined);
    mockGitProvider.push.mockResolvedValue(undefined);
    mockGitProvider.createPR.mockResolvedValue({ url: "https://github.com/acme/widget/pull/1", reused: false });
    mockRefineTask.mockResolvedValue("Refined instructions");
    mockParseHiveYaml.mockReturnValue(null);
    mockGetPreviewInfo.mockReturnValue(undefined);
  });

  // ── Happy path: approved → executing → reviewing → done with PR ──────────

  it("executes task end-to-end: approved → executing → reviewing → done with PR", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    const result = await executeTask(task.id);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/widget/pull/1");
    expect(result.branch).toBe(`hive/${task.id}`);
    expect(result.reviewResult?.verdict).toBe("pass");

    // Verify final state is done
    const final = await getById(task.id);
    expect(final!.status).toBe("done");
    expect(final!.prUrl).toBe("https://github.com/acme/widget/pull/1");
    expect(final!.executionAttempts).toBe(1);
  });

  // ── Rework cycle ─────────────────────────────────────────────────────────

  it("transitions to rework when review returns rework verdict", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(reworkReviewResult);

    const result = await executeTask(task.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sent for rework");
    expect(result.reviewResult?.verdict).toBe("rework");

    // Verify refineTask was called
    expect(mockRefineTask).toHaveBeenCalledWith(task.id, reworkReviewResult);

    // Verify final state is rework
    const final = await getById(task.id);
    expect(final!.status).toBe("rework");
  });

  // ── Budget exhausted ─────────────────────────────────────────────────────

  it("throws when budget is exhausted", async () => {
    const { task, user } = await seedApprovedTask();

    // Burn the budget by recording a large cost
    const { recordCost } = await import("../../src/db/queries/costs.js");
    await recordCost(task.id, user.id, "test", "test-model", 200, 1, 1000);

    await expect(executeTask(task.id)).rejects.toThrow("Budget exhausted");
  });

  // ── Max rework cycles exceeded ───────────────────────────────────────────

  it("force-passes when max rework cycles exceeded and creates PR with findings", async () => {
    const { task } = await seedApprovedTask();

    // Set reworkCount to 2 (the max)
    const { db: testDb } = await import("../setup.js");
    const { tasks: tasksTable } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await testDb
      .update(tasksTable)
      .set({ reworkCount: 2 })
      .where(eq(tasksTable.id, task.id));

    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(reworkReviewResult);

    const result = await executeTask(task.id);

    // At max cycles the worker force-passes and creates a PR
    expect(result.success).toBe(true);
    expect(result.branch).toBeDefined();

    const final = await getById(task.id);
    expect(final!.status).toBe("done");
  });

  // ── Review fails (verdict = fail) ────────────────────────────────────────

  it("sends for rework when review verdict is fail (normalized to rework)", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    // "fail" verdict is normalized to "rework" by review-gate
    mockReviewChanges.mockResolvedValueOnce({ ...failReviewResult, verdict: "rework" });

    const result = await executeTask(task.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sent for rework");

    const final = await getById(task.id);
    expect(final!.status).toBe("rework");
  });

  // ── Worktree cleanup ─────────────────────────────────────────────────────

  it("cleans up worktree on success", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    await executeTask(task.id);

    expect(mockCleanupWorktree).toHaveBeenCalledWith(sampleWorktree);
  });

  it("cleans up worktree on failure", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockRejectedValueOnce(new Error("Review crashed"));

    const result = await executeTask(task.id);

    expect(result.success).toBe(false);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(sampleWorktree);
  });

  // ── Active agent registration ────────────────────────────────────────────

  it("registers and unregisters active agent", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    await executeTask(task.id);

    // After completion, no active agents should remain
    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("unregisters active agent on error", async () => {
    const { task } = await seedApprovedTask();
    mockCallClaudeWithTools.mockRejectedValueOnce(new Error("API error"));

    const result = await executeTask(task.id);

    expect(result.success).toBe(false);

    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  // ── Unexpected error handling ────────────────────────────────────────────

  it("transitions to failed on unexpected error and records failure reason", async () => {
    const { task } = await seedApprovedTask();
    mockCallClaudeWithTools.mockRejectedValueOnce(new Error("Unexpected API failure"));

    const result = await executeTask(task.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unexpected API failure");

    const final = await getById(task.id);
    expect(final!.status).toBe("failed");
    expect(final!.failureReason).toBe("Unexpected API failure");
  });

  // ── Preview lifecycle ────────────────────────────────────────────────────

  it("starts preview when hive.yaml has preview config and preview is enabled", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    const samplePreviewConfig = { type: "process" as const, port: 3000, start_command: "npm start" };
    mockParseHiveYaml.mockReturnValue(samplePreviewConfig);
    mockStartPreview.mockResolvedValueOnce({
      taskId: task.id,
      type: "process",
      port: 4001,
      host: "localhost",
      worktreePath: sampleWorktree.path,
      startedAt: new Date(),
    });

    const result = await executeTask(task.id);

    expect(result.success).toBe(true);
    expect(result.previewUrl).toBe("http://localhost:4001");
    expect(mockStartPreview).toHaveBeenCalledWith(task.id, sampleWorktree.path, samplePreviewConfig);
  });

  it("does not start preview when parseHiveYaml returns null", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);
    mockParseHiveYaml.mockReturnValue(null);

    const result = await executeTask(task.id);

    expect(result.success).toBe(true);
    expect(result.previewUrl).toBeUndefined();
    expect(mockStartPreview).not.toHaveBeenCalled();
  });

  it("still creates PR when preview start fails", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    const samplePreviewConfig = { type: "process" as const, port: 3000, start_command: "npm start" };
    mockParseHiveYaml.mockReturnValue(samplePreviewConfig);
    mockStartPreview.mockRejectedValueOnce(new Error("Docker not available"));

    const result = await executeTask(task.id);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/widget/pull/1");
    expect(result.previewUrl).toBeUndefined();
  });

  it("does not clean up worktree when preview is active", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    const samplePreviewConfig = { type: "process" as const, port: 3000, start_command: "npm start" };
    mockParseHiveYaml.mockReturnValue(samplePreviewConfig);
    mockStartPreview.mockResolvedValueOnce({
      taskId: task.id,
      type: "process",
      port: 4001,
      host: "localhost",
      worktreePath: sampleWorktree.path,
      startedAt: new Date(),
    });

    // getPreviewInfo returns info during finally block — preview is active
    mockGetPreviewInfo.mockReturnValue({
      taskId: task.id,
      type: "process",
      port: 4001,
      host: "localhost",
      worktreePath: sampleWorktree.path,
      startedAt: new Date(),
    });

    await executeTask(task.id);

    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });

  it("cleans up worktree when no preview is active", async () => {
    const { task } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);
    mockParseHiveYaml.mockReturnValue(null);
    mockGetPreviewInfo.mockReturnValue(undefined);

    await executeTask(task.id);

    expect(mockCleanupWorktree).toHaveBeenCalledWith(sampleWorktree);
  });

  // ── Cost recording ───────────────────────────────────────────────────────

  it("records cost for implementation step", async () => {
    const { task, user } = await seedApprovedTask();
    mockClaudeResponse();
    mockReviewChanges.mockResolvedValueOnce(passReviewResult);

    await executeTask(task.id);

    const { db: testDb } = await import("../setup.js");
    const { costs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const rows = await testDb
      .select()
      .from(costs)
      .where(eq(costs.taskId, task.id));

    // At least the worker cost should be recorded
    const workerCost = rows.find(r => r.agent === "worker");
    expect(workerCost).toBeDefined();
    expect(workerCost!.userId).toBe(user.id);
    expect(parseFloat(workerCost!.costUsd)).toBeGreaterThan(0);
  });
});

describe("executeEpic", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates child tasks from decomposed milestones", async () => {
    const { task } = await seedEpicTask();

    // Mock the decomposer module (dynamic import)
    const milestones = [
      { title: "Milestone 1: Login", body: "Implement login flow", index: 0, total: 2 },
      { title: "Milestone 2: Registration", body: "Implement registration flow", index: 1, total: 2 },
    ];

    // We need to mock the dynamic import of decomposer
    vi.doMock("../../src/agents/decomposer.js", () => ({
      decomposeEpic: vi.fn().mockResolvedValue(milestones),
    }));

    // Re-import to pick up the new mock
    const { executeEpic: execEpic } = await import("../../src/execution/worker.js");
    const result = await execEpic(task.id);

    expect(result.success).toBe(true);

    // Verify parent task is done
    const parent = await getById(task.id);
    expect(parent!.status).toBe("done");
    expect(parent!.blueprint).toBeTruthy();

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
    expect(children[0].source).toBe(`epic:${task.id}`);

    // Verify active agent was cleaned up
    const active = await listActive();
    expect(active).toHaveLength(0);
  });

  it("throws when task is not an epic", async () => {
    // Create a non-epic task
    const user = await findOrCreateByEntraOid(
      "oid-epic-test-2",
      "epic2@example.com",
      "Epic User 2",
    );
    const repo = await findOrCreateRepo("github", "acme/widget");
    const task = await createTask({
      title: "Not an epic",
      body: "This is a regular task",
      source: "manual",
      repoId: repo.id,
      createdBy: user.id,
      workflow: "flow",
    });

    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");
    await updateStatus(task.id, "approved");

    await expect(executeEpic(task.id)).rejects.toThrow("is not an epic");
  });

  it("transitions to failed when decomposition fails", async () => {
    const { task } = await seedEpicTask();

    vi.doMock("../../src/agents/decomposer.js", () => ({
      decomposeEpic: vi.fn().mockRejectedValue(new Error("Decomposition failed")),
    }));

    const { executeEpic: execEpic } = await import("../../src/execution/worker.js");
    const result = await execEpic(task.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Decomposition failed");

    const final = await getById(task.id);
    expect(final!.status).toBe("failed");
    expect(final!.failureReason).toBe("Decomposition failed");
  });
});
