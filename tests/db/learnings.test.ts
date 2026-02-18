import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, cleanupTables, useTestDb } from "../setup.js";

// Mock src/db/connection.js so that query functions use our test db/pool
vi.mock("../../src/db/connection.js", async () => {
  const setup = await import("../setup.js");
  return { db: setup.db, pool: setup.pool };
});

// Import AFTER the mock is registered
const {
  createLearning,
  getLearningById,
  retrieveRelevantLearnings,
  reinforceLearning,
  contradictLearning,
  applyMonthlyDecay,
  archiveStale,
  listLearnings,
  getLearningStats,
} = await import("../../src/db/queries/learnings.js");

useTestDb();

describe("learnings queries", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── createLearning ──────────────────────────────────────────────────────────

  describe("createLearning", () => {
    it("creates with correct defaults (confidence 0.50)", async () => {
      const row = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Always write unit tests before integration tests",
      });

      expect(row).toBeDefined();
      expect(row.scope).toBe("universal");
      expect(row.category).toBe("testing");
      expect(row.content).toBe("Always write unit tests before integration tests");
      expect(row.confidence).toBe("0.50");
      expect(row.reinforcements).toBe(0);
      expect(row.contradictions).toBe(0);
      expect(row.tags).toBeNull();
      expect(row.sourceTaskIds).toBeNull();
      expect(row.createdAt).toBeTruthy();
      expect(row.updatedAt).toBeTruthy();
    });

    it("creates with custom confidence and tags", async () => {
      const row = await createLearning({
        scope: "repo:acme/widget",
        category: "security",
        content: "Always sanitize user input",
        confidence: 0.80,
        tags: ["security", "input-validation"],
      });

      expect(row.confidence).toBe("0.80");
      expect(row.tags).toEqual(["security", "input-validation"]);
      expect(row.scope).toBe("repo:acme/widget");
    });
  });

  // ── getLearningById ─────────────────────────────────────────────────────────

  describe("getLearningById", () => {
    it("returns the created learning", async () => {
      const created = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Test content",
      });

      const found = await getLearningById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.content).toBe("Test content");
    });

    it("returns undefined for nonexistent ID", async () => {
      const found = await getLearningById(999999);
      expect(found).toBeUndefined();
    });
  });

  // ── retrieveRelevantLearnings ───────────────────────────────────────────────

  describe("retrieveRelevantLearnings", () => {
    it("filters by scope", async () => {
      await createLearning({ scope: "universal", category: "a", content: "L1", tags: ["t1"] });
      await createLearning({ scope: "repo:acme/widget", category: "a", content: "L2", tags: ["t1"] });
      await createLearning({ scope: "repo:other/repo", category: "a", content: "L3", tags: ["t1"] });

      const rows = await retrieveRelevantLearnings({
        scopes: ["universal", "repo:acme/widget"],
        tags: ["t1"],
      });

      const contents = rows.map((r) => r.content);
      expect(contents).toContain("L1");
      expect(contents).toContain("L2");
      expect(contents).not.toContain("L3");
    });

    it("sorts by confidence DESC", async () => {
      await createLearning({ scope: "universal", category: "a", content: "Low", confidence: 0.30, tags: ["t1"] });
      await createLearning({ scope: "universal", category: "a", content: "High", confidence: 0.90, tags: ["t1"] });
      await createLearning({ scope: "universal", category: "a", content: "Mid", confidence: 0.60, tags: ["t1"] });

      const rows = await retrieveRelevantLearnings({
        scopes: ["universal"],
        tags: ["t1"],
      });

      expect(rows[0].content).toBe("High");
      expect(rows[1].content).toBe("Mid");
      expect(rows[2].content).toBe("Low");
    });
  });

  // ── reinforceLearning ───────────────────────────────────────────────────────

  describe("reinforceLearning", () => {
    it("increments reinforcements and increases confidence by 0.05", async () => {
      const created = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Reinforce me",
      });

      expect(created.confidence).toBe("0.50");
      expect(created.reinforcements).toBe(0);

      await reinforceLearning(created.id, "task-1");

      const updated = await getLearningById(created.id);
      expect(updated!.reinforcements).toBe(1);
      expect(updated!.confidence).toBe("0.55");
    });
  });

  // ── contradictLearning ──────────────────────────────────────────────────────

  describe("contradictLearning", () => {
    it("increments contradictions and decreases confidence", async () => {
      const created = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Contradict me",
      });

      await contradictLearning(created.id, "task-1");

      const updated = await getLearningById(created.id);
      expect(updated!.contradictions).toBe(1);
      expect(updated!.confidence).toBe("0.45");
    });

    it("with custom amount", async () => {
      const created = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Contradict me hard",
        confidence: 0.80,
      });

      await contradictLearning(created.id, "task-1", 0.30);

      const updated = await getLearningById(created.id);
      expect(updated!.contradictions).toBe(1);
      expect(updated!.confidence).toBe("0.50");
    });
  });

  // ── applyMonthlyDecay ──────────────────────────────────────────────────────

  describe("applyMonthlyDecay", () => {
    it("reduces confidence for stale learnings", async () => {
      const created = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Decay me",
        confidence: 1.00,
      });

      // Manually set lastUsedAt to 31+ days ago
      await db.execute(
        sql`UPDATE learnings SET last_used_at = now() - interval '35 days' WHERE id = ${created.id}`,
      );

      const affected = await applyMonthlyDecay();
      expect(affected).toBe(1);

      const updated = await getLearningById(created.id);
      // 1.00 * 0.95 = 0.95
      expect(updated!.confidence).toBe("0.95");
    });
  });

  // ── archiveStale ───────────────────────────────────────────────────────────

  describe("archiveStale", () => {
    it("archives low-confidence low-reinforcement learnings", async () => {
      // This one should be archived: low confidence, few reinforcements
      const stale = await createLearning({
        scope: "universal",
        category: "testing",
        content: "Archive me",
        confidence: 0.10,
      });

      // This one should survive: high confidence
      await createLearning({
        scope: "universal",
        category: "testing",
        content: "Keep me",
        confidence: 0.90,
      });

      const archived = await archiveStale();
      expect(archived).toBe(1);

      const staleRow = await getLearningById(stale.id);
      expect(staleRow!.supersededBy).toBe(-1);
    });
  });

  // ── listLearnings ──────────────────────────────────────────────────────────

  describe("listLearnings", () => {
    it("supports pagination and filters", async () => {
      // Create 5 learnings
      for (let i = 0; i < 5; i++) {
        await createLearning({
          scope: i < 3 ? "universal" : "repo:acme/widget",
          category: i < 2 ? "testing" : "security",
          content: `Learning ${i}`,
        });
      }

      // Test pagination
      const page1 = await listLearnings({ limit: 2, offset: 0 });
      expect(page1.learnings).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await listLearnings({ limit: 2, offset: 2 });
      expect(page2.learnings).toHaveLength(2);
      expect(page2.total).toBe(5);

      // Test scope filter
      const scopeFiltered = await listLearnings({ scope: "universal" });
      expect(scopeFiltered.total).toBe(3);

      // Test category filter
      const catFiltered = await listLearnings({ category: "testing" });
      expect(catFiltered.total).toBe(2);
    });
  });

  // ── getLearningStats ───────────────────────────────────────────────────────

  describe("getLearningStats", () => {
    it("returns correct aggregates", async () => {
      await createLearning({ scope: "universal", category: "testing", content: "L1", confidence: 0.80 });
      await createLearning({ scope: "universal", category: "testing", content: "L2", confidence: 0.60 });
      await createLearning({ scope: "universal", category: "security", content: "L3", confidence: 0.40 });

      // Archive one to test active vs archived counts
      const toArchive = await createLearning({ scope: "universal", category: "security", content: "L4", confidence: 0.10 });
      await archiveStale(); // Should archive L4 (confidence < 0.2, reinforcements < 3)

      const stats = await getLearningStats();
      expect(stats.total).toBe(4);
      expect(stats.active).toBe(3);
      expect(stats.archived).toBe(1);
      // Average of active: (0.80 + 0.60 + 0.40) / 3 = 0.6
      expect(stats.avgConfidence).toBeCloseTo(0.6, 1);
      expect(stats.topCategories.length).toBeGreaterThan(0);

      // topCategories should have testing and security
      const categories = stats.topCategories.map((c) => c.category);
      expect(categories).toContain("testing");
      expect(categories).toContain("security");
    });
  });
});
