import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, cleanupTables, useTestDb } from "../setup.js";

// ── Mocks (must be declared before any import that uses them) ────────────────

// Redirect DB calls to the test database
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Mock the LLM SDK so tests never hit real Claude
vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
  extractJson: vi.fn(),
}));

// ── Lazy imports (resolved after mocks are registered) ───────────────────────

const { isDuplicate, isRefusalTitle, checkForDuplicate, createTaskWithDedup } =
  await import("../../src/producers/base.js");

const { callClaude, extractJson } = await import("../../src/agents/sdk.js");

const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const {
  create: createTask,
  updateStatus,
  getById,
  list,
} = await import("../../src/db/queries/tasks.js");

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-base-dedup",
    "dedup@example.com",
    "Dedup Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/dedup-test");
  return { user, repo };
}

// ── isRefusalTitle ───────────────────────────────────────────────────────────

describe("isRefusalTitle", () => {
  it("detects common LLM refusal patterns", () => {
    expect(
      isRefusalTitle(
        "I don't have the ability to directly analyze external repositories",
      ),
    ).toBe(true);
    expect(
      isRefusalTitle("I cannot directly access GitHub repositories"),
    ).toBe(true);
    expect(
      isRefusalTitle("I can't analyze the repository without access"),
    ).toBe(true);
    expect(
      isRefusalTitle("I would need you to share the code first"),
    ).toBe(true);
    expect(
      isRefusalTitle("Please share the relevant code files so I can help"),
    ).toBe(true);
  });

  it("rejects titles longer than 200 characters", () => {
    expect(isRefusalTitle("A".repeat(201))).toBe(true);
  });

  it("allows legitimate task titles", () => {
    expect(isRefusalTitle("Race condition in auth middleware")).toBe(false);
    expect(isRefusalTitle("XSS vulnerability in comment rendering")).toBe(
      false,
    );
    expect(isRefusalTitle("Add dark mode support")).toBe(false);
    expect(isRefusalTitle("Missing CSRF token validation")).toBe(false);
  });

  it("accepts titles exactly 200 characters long", () => {
    expect(isRefusalTitle("A".repeat(200))).toBe(false);
  });
});

// ── isDuplicate ──────────────────────────────────────────────────────────────

describe("isDuplicate", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  it("returns true when a task with the same source and title exists in a non-terminal status", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Fix login bug",
      body: "The login form throws a 500 on bad credentials.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(await isDuplicate("bug-hunter", "Fix login bug")).toBe(true);
  });

  it("returns false when source differs", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Fix login bug",
      body: "body",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(await isDuplicate("feature-scout", "Fix login bug")).toBe(false);
  });

  it("returns false when title differs", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Fix login bug",
      body: "body",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(await isDuplicate("bug-hunter", "Fix signup bug")).toBe(false);
  });

  it("returns false when the matching task is in a terminal status (failed)", async () => {
    const { user, repo } = await seedUserAndRepo();

    const task = await createTask({
      title: "Fix login bug",
      body: "body",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    // Walk the task to a terminal state
    await updateStatus(task.id, "queued");
    await updateStatus(task.id, "enriching");
    await updateStatus(task.id, "ready");
    await updateStatus(task.id, "approved");
    await updateStatus(task.id, "executing");
    await updateStatus(task.id, "failed");

    expect(await isDuplicate("bug-hunter", "Fix login bug")).toBe(false);
  });

  it("returns false when the matching task is cancelled", async () => {
    const { user, repo } = await seedUserAndRepo();

    const task = await createTask({
      title: "Fix login bug",
      body: "body",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });
    await updateStatus(task.id, "cancelled");

    expect(await isDuplicate("bug-hunter", "Fix login bug")).toBe(false);
  });

  it("returns false when no tasks exist at all", async () => {
    expect(await isDuplicate("bug-hunter", "Nonexistent task")).toBe(false);
  });
});

// ── checkForDuplicate ────────────────────────────────────────────────────────

describe("checkForDuplicate", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns false without calling LLM when no open tasks exist", async () => {
    // Empty DB → no candidates → must short-circuit
    const result = await checkForDuplicate(
      "Add pagination to user list",
      "We need pagination on the /users endpoint.",
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.matchedTaskId).toBeUndefined();
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("returns false without calling LLM in dryRun mode even when candidates exist", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Security audit of login flow",
      body: "Review the login flow for vulnerabilities.",
      source: "security-scanner",
      repoId: repo.id,
      createdBy: user.id,
    });

    const result = await checkForDuplicate(
      "Audit authentication flow for security issues",
      "The authentication flow needs a thorough security review.",
      { producerType: "security-scanner", dryRun: true },
    );

    expect(result.isDuplicate).toBe(false);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("returns false when open tasks exist but LLM says no match", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Fix broken image uploads",
      body: "Images over 5 MB fail silently during upload.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    vi.mocked(callClaude).mockResolvedValueOnce({
      text: '{"isDuplicate":false,"matchedId":null}',
    } as any);
    vi.mocked(extractJson).mockReturnValueOnce({
      isDuplicate: false,
      matchedId: null,
    });

    const result = await checkForDuplicate(
      "Add dark mode toggle to settings",
      "Users want a dark mode option in their account settings.",
      { producerType: "bug-hunter" },
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.matchedTaskId).toBeUndefined();
    expect(callClaude).toHaveBeenCalledOnce();
  });

  it("returns true with matchedTaskId when LLM identifies a near-duplicate", async () => {
    const { user, repo } = await seedUserAndRepo();

    const existing = await createTask({
      title: "Fix broken image upload when file exceeds size limit",
      body: "When users upload files larger than 5 MB the request fails silently.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    vi.mocked(callClaude).mockResolvedValueOnce({
      text: `{"isDuplicate":true,"matchedId":"${existing.id}"}`,
    } as any);
    vi.mocked(extractJson).mockReturnValueOnce({
      isDuplicate: true,
      matchedId: existing.id,
    });

    const result = await checkForDuplicate(
      "Image uploads silently fail for files over 5 megabytes",
      "Users report that large image uploads don't work — no error message shown.",
      { producerType: "bug-hunter" },
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.matchedTaskId).toBe(existing.id);
    expect(callClaude).toHaveBeenCalledOnce();
  });

  it("returns false (fail-open) and does NOT throw when LLM call throws", async () => {
    const { user, repo } = await seedUserAndRepo();

    // Seed a candidate so the LLM path is reached
    await createTask({
      title: "Investigate memory leak in worker pool",
      body: "Workers are not releasing memory after task completion.",
      source: "maintenance",
      repoId: repo.id,
      createdBy: user.id,
    });

    vi.mocked(callClaude).mockRejectedValueOnce(
      new Error("LLM service unavailable"),
    );

    const result = await checkForDuplicate(
      "Worker pool leaking memory after job completion",
      "Memory usage grows unbounded in the worker pool.",
      { producerType: "maintenance" },
    );

    // Must fail-open: always allow task creation when LLM is unavailable
    expect(result.isDuplicate).toBe(false);
    expect(result.matchedTaskId).toBeUndefined();
    expect(callClaude).toHaveBeenCalledOnce();
  });

  it("includes candidate task titles in the LLM prompt", async () => {
    const { user, repo } = await seedUserAndRepo();

    await createTask({
      title: "Retry logic missing from payment processor",
      body: "Payment processing has no retry on transient failures.",
      source: "feature-scout",
      repoId: repo.id,
      createdBy: user.id,
    });

    vi.mocked(callClaude).mockResolvedValueOnce({
      text: '{"isDuplicate":false,"matchedId":null}',
    } as any);
    vi.mocked(extractJson).mockReturnValueOnce({
      isDuplicate: false,
      matchedId: null,
    });

    await checkForDuplicate(
      "Add exponential backoff to payment retries",
      "The payment processor needs exponential backoff for retry attempts.",
      { producerType: "feature-scout" },
    );

    expect(callClaude).toHaveBeenCalledOnce();
    const promptArg = vi.mocked(callClaude).mock.calls[0][0].prompt as string;
    // The candidate's title must appear in the prompt
    expect(promptArg).toContain("Retry logic missing from payment processor");
    // The proposed task's title must also be in the prompt
    expect(promptArg).toContain("Add exponential backoff to payment retries");
  });
});

// ── createTaskWithDedup ──────────────────────────────────────────────────────

describe("createTaskWithDedup", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a task when no duplicate exists (empty DB)", async () => {
    const { user, repo } = await seedUserAndRepo();

    // Empty DB → no candidates → no LLM call
    const result = await createTaskWithDedup({
      title: "Add two-factor authentication",
      body: "Implement TOTP-based 2FA for user accounts.",
      source: "security-scanner",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(result.skipped).toBe(false);
    expect(result.task).toBeDefined();
    expect(result.task!.title).toBe("Add two-factor authentication");

    // Confirm the row is in the DB
    const found = await getById(result.task!.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Add two-factor authentication");

    // LLM must not have been called (no candidates)
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("skips insertion when exact-title duplicate exists, without calling LLM", async () => {
    const { user, repo } = await seedUserAndRepo();

    // Pre-seed an exact-match task
    await createTask({
      title: "Fix null pointer in request handler",
      body: "Handler crashes when request body is null.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    const result = await createTaskWithDedup({
      title: "Fix null pointer in request handler",
      body: "The request handler throws NPE when body is absent.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(result.skipped).toBe(true);
    // Exact-title match short-circuits before the LLM is ever consulted
    expect(callClaude).not.toHaveBeenCalled();

    // Only the original task exists in the DB
    const all = await list();
    expect(all.total).toBe(1);
  });

  it("skips insertion when LLM identifies a near-duplicate and does NOT insert into DB", async () => {
    const { user, repo } = await seedUserAndRepo();

    const existing = await createTask({
      title: "Heap memory grows without bound in worker threads",
      body: "Workers leak memory over time, causing OOM errors.",
      source: "maintenance",
      repoId: repo.id,
      createdBy: user.id,
    });

    // LLM identifies a duplicate
    vi.mocked(callClaude).mockResolvedValueOnce({
      text: `{"isDuplicate":true,"matchedId":"${existing.id}"}`,
    } as any);
    vi.mocked(extractJson).mockReturnValueOnce({
      isDuplicate: true,
      matchedId: existing.id,
    });

    const result = await createTaskWithDedup({
      title: "Worker threads keep growing memory usage causing crashes",
      body: "Memory consumption in worker threads increases unbounded leading to OOM.",
      source: "maintenance",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(result.skipped).toBe(true);
    expect(result.matchedTaskId).toBe(existing.id);

    // Only the pre-existing task should be in the DB — no second task inserted
    const all = await list();
    expect(all.total).toBe(1);
    expect(all.tasks[0].id).toBe(existing.id);
  });

  it("creates task normally when open tasks exist but LLM says no match", async () => {
    const { user, repo } = await seedUserAndRepo();

    // An unrelated open task
    await createTask({
      title: "Fix broken CSV export",
      body: "CSV export endpoint returns 500 for large datasets.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    // LLM says: not a duplicate
    vi.mocked(callClaude).mockResolvedValueOnce({
      text: '{"isDuplicate":false,"matchedId":null}',
    } as any);
    vi.mocked(extractJson).mockReturnValueOnce({
      isDuplicate: false,
      matchedId: null,
    });

    const result = await createTaskWithDedup({
      title: "Add rate limiting to public API endpoints",
      body: "Public API endpoints have no rate limiting, allowing abuse.",
      source: "security-scanner",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(result.skipped).toBe(false);
    expect(result.task).toBeDefined();

    // Both tasks should now be in the DB
    const all = await list();
    expect(all.total).toBe(2);
  });

  it("creates task (fail-open) when LLM throws an error", async () => {
    const { user, repo } = await seedUserAndRepo();

    // Seed a candidate so the LLM path is reached
    await createTask({
      title: "Investigate slow database queries",
      body: "Several queries are taking over 2 seconds.",
      source: "maintenance",
      repoId: repo.id,
      createdBy: user.id,
    });

    vi.mocked(callClaude).mockRejectedValueOnce(new Error("Timeout"));

    const result = await createTaskWithDedup({
      title: "Database query performance regression",
      body: "Query latency has increased significantly in the last deployment.",
      source: "maintenance",
      repoId: repo.id,
      createdBy: user.id,
    });

    // Fail-open: task must be created even though the LLM failed
    expect(result.skipped).toBe(false);
    expect(result.task).toBeDefined();

    const all = await list();
    expect(all.total).toBe(2);
  });

  it("does not insert into DB in dryRun mode and does not call LLM", async () => {
    const { user, repo } = await seedUserAndRepo();

    const result = await createTaskWithDedup({
      title: "Refactor authentication module",
      body: "The auth module needs to be split into smaller components.",
      source: "maintenance",
      repoId: repo.id,
      createdBy: user.id,
      dryRun: true,
    });

    // dryRun: no skipping (no duplicate), but also no insertion
    expect(result.skipped).toBe(false);
    expect(result.task).toBeUndefined();
    expect(callClaude).not.toHaveBeenCalled();

    const all = await list();
    expect(all.total).toBe(0);
  });

  it("returns skipped=true for a refusal title without calling LLM or inserting", async () => {
    const { user, repo } = await seedUserAndRepo();

    const result = await createTaskWithDedup({
      title: "I cannot directly access GitHub repositories",
      body: "Some body text.",
      source: "bug-hunter",
      repoId: repo.id,
      createdBy: user.id,
    });

    expect(result.skipped).toBe(true);
    expect(callClaude).not.toHaveBeenCalled();

    const all = await list();
    expect(all.total).toBe(0);
  });
});
