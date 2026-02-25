import { describe, it, expect } from "vitest";
import {
  ALL_ENRICHERS,
  EXTERNAL_BLUEPRINT_ENRICHERS,
  getEnrichersForTask,
  getEnrichersForTaskWithConfig,
} from "../../src/enrichers/index.js";
import type { AutonomousConfig } from "../../src/domain/autonomous-config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(blueprintSource: string): { blueprintSource: string } {
  return { blueprintSource };
}

const EMPTY_CONFIG: AutonomousConfig = { enrichers: [] } as unknown as AutonomousConfig;

// ── getEnrichersForTask ───────────────────────────────────────────────────────

describe("getEnrichersForTask", () => {
  // ── blueprintSource === 'external' ─────────────────────────────────────────

  describe("external blueprint source", () => {
    const task = makeTask("external");

    it("returns git-history enricher", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).toContain("git-history");
    });

    it("returns architect enricher (validate-only mode)", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).toContain("architect");
    });

    it("returns scorer enricher", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).toContain("scorer");
    });

    it("does NOT return codebase enricher", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).not.toContain("codebase");
    });

    it("does NOT return docs enricher", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).not.toContain("docs");
    });

    it("does NOT return dependencies enricher", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).not.toContain("dependencies");
    });

    it("does NOT return prism enricher", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name);
      expect(names).not.toContain("prism");
    });

    it("returns exactly the EXTERNAL_BLUEPRINT_ENRICHERS set", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name).sort();
      const expectedNames = EXTERNAL_BLUEPRINT_ENRICHERS.map((e) => e.name).sort();
      expect(names).toEqual(expectedNames);
    });

    it("returns a copy (mutations do not affect the canonical list)", () => {
      const a = getEnrichersForTask(task);
      a.push({} as never);
      const b = getEnrichersForTask(task);
      expect(b).toHaveLength(EXTERNAL_BLUEPRINT_ENRICHERS.length);
    });
  });

  // ── blueprintSource === 'architect' ────────────────────────────────────────

  describe("architect blueprint source", () => {
    const task = makeTask("architect");

    it("returns all enrichers", () => {
      const enrichers = getEnrichersForTask(task);
      const names = enrichers.map((e) => e.name).sort();
      const allNames = ALL_ENRICHERS.map((e) => e.name).sort();
      expect(names).toEqual(allNames);
    });

    it("includes codebase enricher", () => {
      const enrichers = getEnrichersForTask(task);
      expect(enrichers.map((e) => e.name)).toContain("codebase");
    });

    it("includes docs enricher", () => {
      const enrichers = getEnrichersForTask(task);
      expect(enrichers.map((e) => e.name)).toContain("docs");
    });

    it("includes architect enricher", () => {
      const enrichers = getEnrichersForTask(task);
      expect(enrichers.map((e) => e.name)).toContain("architect");
    });

    it("includes git-history enricher", () => {
      const enrichers = getEnrichersForTask(task);
      expect(enrichers.map((e) => e.name)).toContain("git-history");
    });

    it("includes scorer enricher", () => {
      const enrichers = getEnrichersForTask(task);
      expect(enrichers.map((e) => e.name)).toContain("scorer");
    });
  });

  // ── absent / unknown blueprintSource ──────────────────────────────────────

  describe("absent or unknown blueprintSource", () => {
    it("falls back to all enrichers when blueprintSource is an unknown value", () => {
      const enrichers = getEnrichersForTask(makeTask("unknown-value"));
      const names = enrichers.map((e) => e.name).sort();
      const allNames = ALL_ENRICHERS.map((e) => e.name).sort();
      expect(names).toEqual(allNames);
    });

    it("falls back to all enrichers when blueprintSource is empty string", () => {
      const enrichers = getEnrichersForTask(makeTask(""));
      const names = enrichers.map((e) => e.name).sort();
      const allNames = ALL_ENRICHERS.map((e) => e.name).sort();
      expect(names).toEqual(allNames);
    });
  });
});

// ── getEnrichersForTaskWithConfig ─────────────────────────────────────────────

describe("getEnrichersForTaskWithConfig", () => {
  describe("empty config (all enabled)", () => {
    it("external task: returns external blueprint enrichers unchanged", () => {
      const enrichers = getEnrichersForTaskWithConfig(makeTask("external"), EMPTY_CONFIG);
      const names = enrichers.map((e) => e.name).sort();
      const expectedNames = EXTERNAL_BLUEPRINT_ENRICHERS.map((e) => e.name).sort();
      expect(names).toEqual(expectedNames);
    });

    it("architect task: returns all enrichers unchanged", () => {
      const enrichers = getEnrichersForTaskWithConfig(makeTask("architect"), EMPTY_CONFIG);
      const names = enrichers.map((e) => e.name).sort();
      const allNames = ALL_ENRICHERS.map((e) => e.name).sort();
      expect(names).toEqual(allNames);
    });
  });

  describe("config restricts enrichers", () => {
    const configWithScorerOnly: AutonomousConfig = {
      enrichers: [
        { name: "scorer", enabled: true },
        { name: "git-history", enabled: false },
        { name: "architect", enabled: false },
      ],
    } as unknown as AutonomousConfig;

    it("external task: further filters by config — only scorer returned", () => {
      const enrichers = getEnrichersForTaskWithConfig(makeTask("external"), configWithScorerOnly);
      const names = enrichers.map((e) => e.name);
      expect(names).toEqual(["scorer"]);
    });

    it("architect task: further filters by config — only scorer returned", () => {
      const enrichers = getEnrichersForTaskWithConfig(makeTask("architect"), configWithScorerOnly);
      const names = enrichers.map((e) => e.name);
      expect(names).toEqual(["scorer"]);
    });
  });
});
