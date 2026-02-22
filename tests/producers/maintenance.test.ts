import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";
import { tasks } from "../../src/db/schema.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/agents/sdk.js", () => ({
  callClaude: vi.fn(),
}));

vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

vi.mock("../../src/producers/base.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/producers/base.js")>();
  return {
    ...original,
    gatherRepoSummary: vi.fn(() => "## File tree\nindex.ts\npackage.json"),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { callClaude } = await import("../../src/agents/sdk.js");
const { MaintenanceProducer } = await import("../../src/producers/maintenance.js");
const { findOrCreateByEntraOid } = await import("../../src/db/queries/users.js");
const { findOrCreate: findOrCreateRepo } = await import("../../src/db/queries/repos.js");

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

const TEST_REPO_DIR = "/tmp/hive-test-repo";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-maintenance-test",
    "maintenance@example.com",
    "Maintenance Test User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  return { user, repo };
}

function ctxWithRepo(repoId: number, userId: number) {
  return {
    repoId,
    repoFullName: "acme/widget",
    repoDir: TEST_REPO_DIR,
    createdBy: userId,
  };
}

/**
 * Builds a well-formed LLM response block for a single maintenance finding.
 */
function makeBlock(
  title: string,
  description: string,
  value: number,
  complexity: number,
  risk: number,
  block: number,
): string {
  const priority = value * 2 + block * 2 - complexity - risk;
  return `## ${title}\n${description}\n\n**Scores:** value=${value}, complexity=${complexity}, risk=${risk}, block=${block}, priority=${priority}`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MaintenanceProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  // ── Instantiation ──────────────────────────────────────────────────────────

  it("can be instantiated without errors", () => {
    const producer = new MaintenanceProducer();
    expect(producer).toBeDefined();
    expect(producer.name).toBe("maintenance");
    expect(producer.needsRepo).toBe(true);
  });

  // ── Prompt loading ─────────────────────────────────────────────────────────

  it("loads a non-empty prompt from prompts/producers/maintenance.md", () => {
    const promptPath = join(process.cwd(), "prompts", "producers", "maintenance.md");
    expect(existsSync(promptPath)).toBe(true);
    const content = readFileSync(promptPath, "utf-8").trim();
    expect(content.length).toBeGreaterThan(0);
  });

  // ── Successful parsing ─────────────────────────────────────────────────────

  it("creates tasks for each parsed finding from Claude response", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const responseText = [
      makeBlock(
        "Migrate CommonJS requires to ESM imports in src/utils/",
        "The utils directory still uses require() calls throughout. This blocks tree-shaking and is inconsistent with the rest of the ESM project. Affected files: src/utils/parse.js, src/utils/format.js. Remediation: run codemod and update tsconfig.",
        8, 3, 2, 7,
      ),
      makeBlock(
        "Extract duplicated retry logic into a shared helper",
        "Nearly identical retry loops appear in three separate service files. This duplication causes inconsistent behaviour and makes updates error-prone. Affected: src/services/api.ts, src/services/db.ts, src/services/cache.ts. Remediation: create src/utils/retry.ts.",
        7, 2, 2, 5,
      ),
    ].join("\n\n");

    mockCallClaude.mockResolvedValue({
      text: responseText,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 200, outputTokens: 100 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(2);
    expect(result.errors).toHaveLength(0);

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created).toHaveLength(2);
    expect(created.map((t) => t.type)).toEqual(["chore", "chore"]);
  });

  // ── Score parsing ──────────────────────────────────────────────────────────

  it("parses value, complexity, risk, and block scores from the response", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: makeBlock(
        "Decompose 400-line God function in src/core/processor.ts",
        "The processAll() function has grown to 400 lines with 12 responsibilities. High cyclomatic complexity makes it impossible to unit test. Remediation: extract sub-functions per responsibility.",
        9, 5, 4, 6,
      ),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 60 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);

    // Verify the score metadata is embedded in the task body
    const [created] = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);

    expect(created?.body).toContain("value=9");
    expect(created?.body).toContain("complexity=5");
    expect(created?.body).toContain("risk=4");
    expect(created?.body).toContain("block=6");
    expect(created?.body).toContain("Maintenance scores:");
  });

  // ── Priority sorting ───────────────────────────────────────────────────────

  it("ranks high-value low-complexity finding above low-value high-complexity finding", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    // High value, low complexity/risk — priority = 9×2 + 8×2 − 2 − 1 = 31
    const highPriorityBlock = makeBlock(
      "High priority finding: unblock CI by removing deprecated API usage",
      "Deprecated API calls are causing CI warnings that will become failures in the next release. All 12 call sites are isolated and the replacement API is a drop-in substitute. Remediation: run automated codemod.",
      9, 2, 1, 8,
    );

    // Low value, high complexity/risk — priority = 3×2 + 2×2 − 8 − 7 = 1 (filtered out ≤5)
    // Use scores that give priority just above 5 for sorting purposes:
    // value=4, complexity=3, risk=2, block=4 → priority = 4×2 + 4×2 − 3 − 2 = 11
    const lowPriorityBlock = makeBlock(
      "Low priority finding: rename variables for consistency",
      "Variable naming is inconsistent across the codebase. While cosmetic, it causes confusion during code review. Affected: many files across multiple modules. Remediation: establish naming convention and rename variables.",
      4, 3, 2, 4,
    );

    // Return lower priority first to verify sorting inverts the order
    mockCallClaude.mockResolvedValue({
      text: `${lowPriorityBlock}\n\n${highPriorityBlock}`,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 80 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));
    expect(result.tasksCreated).toBe(2);

    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`)
      .orderBy(tasks.createdAt);

    // The high-priority item should have been inserted first (highest priority = inserted first)
    expect(created[0]?.title).toContain("High priority finding");
    expect(created[1]?.title).toContain("Low priority finding");
  });

  // ── Priority threshold ─────────────────────────────────────────────────────

  it("discards findings whose priority score is 5 or below", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    // value=3, complexity=8, risk=7, block=2 → priority = 3×2 + 2×2 − 8 − 7 = 3 (≤5, discarded)
    const lowBlock = makeBlock(
      "Rename a few internal variables for consistency",
      "Some internal variable names are not fully consistent with the team style guide. The impact is cosmetic only. Remediation: bulk rename with IDE tooling.",
      3, 8, 7, 2,
    );

    mockCallClaude.mockResolvedValue({
      text: lowBlock,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 80, outputTokens: 40 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));
    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Limit ──────────────────────────────────────────────────────────────────

  it("limits output to 5 tasks even when Claude returns more", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const blocks = Array.from({ length: 7 }, (_, i) =>
      makeBlock(
        `Maintenance finding number ${i + 1}`,
        `Description for finding ${i + 1}. This is detailed enough. Multiple sentences here. Affects several files. Remediation: apply standard fix.`,
        8, 2, 2, 6,
      ),
    ).join("\n\n");

    mockCallClaude.mockResolvedValue({
      text: blocks,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 300, outputTokens: 200 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));
    expect(result.tasksCreated).toBe(5);
  });

  // ── Duplicate detection ────────────────────────────────────────────────────

  it("skips duplicate task titles on a second run", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const responseText = makeBlock(
      "Migrate callback-style async to async/await in src/legacy/",
      "Callback-based async code in src/legacy/ is hard to reason about and error-prone. Modern async/await is now available across all targets. Remediation: refactor with async/await and add try/catch.",
      8, 3, 3, 6,
    );

    mockCallClaude.mockResolvedValue({
      text: responseText,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 60 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    const first = await producer.run(ctx);
    expect(first.tasksCreated).toBe(1);

    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
  });

  // ── Edge case: empty findings ──────────────────────────────────────────────

  it("returns zero candidates without throwing when the LLM returns NONE", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "NONE",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 50, outputTokens: 5 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns zero candidates without throwing when the LLM returns an empty string", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 50, outputTokens: 0 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Edge case: malformed/unparseable output ────────────────────────────────

  it("returns zero candidates without throwing when LLM output has no score lines", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    // Blocks present but no **Scores:** line → parseCandidates drops them
    mockCallClaude.mockResolvedValue({
      text: "## Some finding\nA description with no scores at all.\n\n## Another finding\nAlso no scores.",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 80, outputTokens: 30 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns zero candidates without throwing when LLM output is completely garbled", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockResolvedValue({
      text: "!!!@@@###$$$%%%^^^&&&***((()))___+++===",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 80, outputTokens: 10 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── Edge case: missing repoDir ─────────────────────────────────────────────

  it("returns early without calling Claude when repoDir is not provided", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
      // no repoDir
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not available");
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  // ── Edge case: SDK failure ─────────────────────────────────────────────────

  it("catches SDK errors and records them in the errors array", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    mockCallClaude.mockRejectedValue(new Error("API rate limit exceeded"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit exceeded");
  });

  // ── Refusal filter ─────────────────────────────────────────────────────────

  it("filters out refusal-style titles from parsed candidates", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new MaintenanceProducer();

    const refusalPriority = 7 * 2 + 6 * 2 - 2 - 2; // 22
    const refusalBlock =
      `## I cannot directly access GitHub repositories\nThis is a refusal.\n\n**Scores:** value=7, complexity=2, risk=2, block=6, priority=${refusalPriority}`;

    const goodBlock = makeBlock(
      "Replace deprecated crypto.createCipher with crypto.createCipheriv",
      "crypto.createCipher is deprecated and insecure because it derives the IV from the key. Affected: src/utils/encrypt.ts. Remediation: switch to createCipheriv with a random IV and store it alongside the ciphertext.",
      8, 2, 3, 7,
    );

    mockCallClaude.mockResolvedValue({
      text: `${refusalBlock}\n\n${goodBlock}`,
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 120, outputTokens: 70 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(1);

    const [created] = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:maintenance'`);
    expect(created?.title).toContain("crypto.createCipher");
  });
});
