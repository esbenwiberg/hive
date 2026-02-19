import { describe, it, expect, beforeEach, vi } from "vitest";
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
const { FeatureScoutProducer } = await import(
  "../../src/producers/feature-scout.js"
);
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);

const mockCallClaude = callClaude as ReturnType<typeof vi.fn>;

useTestDb();

const TEST_REPO_DIR = "/tmp/hive-test-repo";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedUserAndRepo() {
  const user = await findOrCreateByEntraOid(
    "oid-feature-test",
    "feature@example.com",
    "Feature Scout Test User",
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("FeatureScoutProducer", () => {
  beforeEach(async () => {
    await cleanupTables();
    vi.clearAllMocks();
  });

  it("creates tasks with type 'feature' for each suggestion", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockResolvedValue({
      text: [
        "## Add dark mode support",
        "Allow users to toggle between light and dark themes. This improves readability in low-light environments and reduces eye strain. Should add a toggle in the settings page that persists the preference. Affects the CSS theme system and user preferences storage.",
        "",
        "## Implement real-time notifications",
        "Push live updates to users when tasks change status using WebSocket connections. Users should see a notification badge and a dropdown with recent activity. This keeps the team informed without manual refreshes. Affects the dashboard layout and requires a new WebSocket server endpoint.",
        "",
        "## Add CSV export for reports",
        "Let users download task and cost data as CSV files from the costs and tasks pages. Each table view should have an export button that generates a CSV matching the current filters. This is valuable for teams that need to import data into spreadsheets for reporting. Affects the dashboard routes and views.",
      ].join("\n"),
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 40 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify tasks have type 'feature' and detailed descriptions
    const created = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.source} = 'producer:feature-scout'`);

    expect(created).toHaveLength(3);
    for (const task of created) {
      expect(task.type).toBe("feature");
      expect(task.body).not.toContain("Feature idea suggested by");
      expect(task.body!.length).toBeGreaterThan(50);
    }
    const darkMode = created.find((t) => t.title === "Add dark mode support");
    expect(darkMode?.body).toContain("toggle between light and dark themes");
  });

  it("limits to 3 features even if Claude returns more", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockResolvedValue({
      text: "## Feature 1\nDescription one.\n\n## Feature 2\nDescription two.\n\n## Feature 3\nDescription three.\n\n## Feature 4\nDescription four.\n\n## Feature 5\nDescription five.",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 40 },
    });

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(3);
  });

  it("skips duplicates", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockResolvedValue({
      text: "## Add dark mode\nToggle between light and dark themes.\n\n## Real-time notifications\nPush updates when tasks change.",
      cost: { model: "claude-sonnet-4-20250514", inputTokens: 150, outputTokens: 30 },
    });

    const ctx = ctxWithRepo(repo.id, user.id);

    await producer.run(ctx);

    const second = await producer.run(ctx);
    expect(second.tasksCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
  });

  it("returns early when repoDir is not provided", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    const result = await producer.run({
      repoId: repo.id,
      repoFullName: "acme/widget",
      createdBy: user.id,
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not available");
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("catches SDK errors without throwing", async () => {
    const { user, repo } = await seedUserAndRepo();
    const producer = new FeatureScoutProducer();

    mockCallClaude.mockRejectedValue(new Error("Timeout"));

    const result = await producer.run(ctxWithRepo(repo.id, user.id));

    expect(result.tasksCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Timeout");
  });
});
