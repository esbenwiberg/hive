import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupTables, useTestDb } from "../setup.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { runEnrichers } = await import("../../src/enrichers/base.js");
const { listByTask } = await import(
  "../../src/db/queries/enrichment-runs.js"
);
const { findOrCreateByEntraOid } = await import(
  "../../src/db/queries/users.js"
);
const { findOrCreate: findOrCreateRepo } = await import(
  "../../src/db/queries/repos.js"
);
const { create: createTask, getById } = await import(
  "../../src/db/queries/tasks.js"
);

import type { Enricher, EnricherConfig, EnrichmentResult } from "../../src/enrichers/base.js";
import type { TaskRow } from "../../src/db/schema.js";

useTestDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedTask(): Promise<TaskRow> {
  const user = await findOrCreateByEntraOid(
    "oid-enricher-test",
    "enricher@example.com",
    "Enricher User",
  );
  const repo = await findOrCreateRepo("github", "acme/widget");
  const task = await createTask({
    title: "Fix login bug",
    body: "The login form crashes when the email field is empty",
    source: "manual",
    repoId: repo.id,
    createdBy: user.id,
  });
  return task as TaskRow;
}

function createMockEnricher(
  name: string,
  data: Record<string, unknown>,
  opts?: { costUsd?: number; durationMs?: number; shouldFail?: boolean },
): Enricher {
  return {
    name,
    run: vi.fn(async (
      _task: TaskRow,
      _repoDir: string,
      _priorResults: Record<string, unknown>,
      _config: EnricherConfig,
    ): Promise<EnrichmentResult> => {
      if (opts?.shouldFail) {
        throw new Error(`${name} enricher failed`);
      }
      return {
        data,
        costUsd: opts?.costUsd,
        durationMs: opts?.durationMs ?? 100,
      };
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runEnrichers", () => {
  beforeEach(async () => {
    await cleanupTables();
  });

  // ── Sequential execution ──────────────────────────────────────────────────

  it("runs enrichers sequentially and returns merged results", async () => {
    const task = await seedTask();

    const enricherA = createMockEnricher("alpha", { a: 1 });
    const enricherB = createMockEnricher("beta", { b: 2 });

    const config = {
      alpha: { enabled: true },
      beta: { enabled: true },
    };

    const result = await runEnrichers(task, "/tmp/repo", [enricherA, enricherB], config);

    expect(result).toEqual({ a: 1, b: 2 });

    // Both enrichers should have been called
    expect(enricherA.run).toHaveBeenCalledTimes(1);
    expect(enricherB.run).toHaveBeenCalledTimes(1);
  });

  // ── Prior results passing ─────────────────────────────────────────────────

  it("passes prior enrichers' merged output to subsequent enrichers", async () => {
    const task = await seedTask();

    const enricherA = createMockEnricher("alpha", { fromA: "hello" });
    const enricherB: Enricher = {
      name: "beta",
      run: vi.fn(async (
        _task: TaskRow,
        _repoDir: string,
        priorResults: Record<string, unknown>,
        _config: EnricherConfig,
      ): Promise<EnrichmentResult> => {
        // Should receive alpha's results
        return {
          data: { receivedPrior: priorResults },
          durationMs: 50,
        };
      }),
    };

    const config = {
      alpha: { enabled: true },
      beta: { enabled: true },
    };

    const result = await runEnrichers(task, "/tmp/repo", [enricherA, enricherB], config);

    // beta should have received alpha's results
    expect(enricherB.run).toHaveBeenCalledTimes(1);
    const betaCall = (enricherB.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(betaCall[2]).toEqual({ fromA: "hello" });

    // Final merged result
    expect(result).toEqual({ fromA: "hello", receivedPrior: { fromA: "hello" } });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("records error and continues to next enricher on failure", async () => {
    const task = await seedTask();

    const failingEnricher = createMockEnricher("failing", {}, { shouldFail: true });
    const successEnricher = createMockEnricher("success", { ok: true }, { durationMs: 42 });

    const config = {
      failing: { enabled: true },
      success: { enabled: true },
    };

    const result = await runEnrichers(
      task,
      "/tmp/repo",
      [failingEnricher, successEnricher],
      config,
    );

    // Only the success enricher's data should be in the result
    expect(result).toEqual({ ok: true });

    // Both enrichers were called
    expect(failingEnricher.run).toHaveBeenCalledTimes(1);
    expect(successEnricher.run).toHaveBeenCalledTimes(1);

    // Check enrichment_runs table: should have 2 rows
    const runs = await listByTask(task.id);
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((r) => r.enricher === "failing");
    expect(failedRun).toBeDefined();
    expect(failedRun!.status).toBe("failed");
    expect(failedRun!.error).toBe("failing enricher failed");

    const successRun = runs.find((r) => r.enricher === "success");
    expect(successRun).toBeDefined();
    expect(successRun!.status).toBe("completed");
    expect(successRun!.durationMs).toBe(42);
  });

  // ── Enrichment runs recording ─────────────────────────────────────────────

  it("writes each enricher run to the enrichment_runs table", async () => {
    const task = await seedTask();

    const enricherA = createMockEnricher("alpha", { x: 1 }, { costUsd: 0.01, durationMs: 200 });
    const enricherB = createMockEnricher("beta", { y: 2 }, { durationMs: 150 });

    const config = {
      alpha: { enabled: true },
      beta: { enabled: true },
    };

    await runEnrichers(task, "/tmp/repo", [enricherA, enricherB], config);

    const runs = await listByTask(task.id);
    expect(runs).toHaveLength(2);

    expect(runs[0].enricher).toBe("alpha");
    expect(runs[0].status).toBe("completed");
    expect(parseFloat(runs[0].costUsd!)).toBeCloseTo(0.01, 4);
    expect(runs[0].durationMs).toBe(200);
    expect(runs[0].result).toEqual({ x: 1 });

    expect(runs[1].enricher).toBe("beta");
    expect(runs[1].status).toBe("completed");
    expect(runs[1].result).toEqual({ y: 2 });
  });

  // ── Task enrichment update ────────────────────────────────────────────────

  it("updates the task enrichment column with merged results", async () => {
    const task = await seedTask();

    const enricherA = createMockEnricher("alpha", { analysis: "done" });

    const config = { alpha: { enabled: true } };

    await runEnrichers(task, "/tmp/repo", [enricherA], config);

    const updated = await getById(task.id);
    expect(updated!.enrichment).toEqual({ analysis: "done" });
  });

  // ── Disabled enricher ─────────────────────────────────────────────────────

  it("skips enrichers with enabled=false", async () => {
    const task = await seedTask();

    const enricherA = createMockEnricher("alpha", { a: 1 });
    const enricherB = createMockEnricher("beta", { b: 2 });

    const config = {
      alpha: { enabled: false },
      beta: { enabled: true },
    };

    const result = await runEnrichers(task, "/tmp/repo", [enricherA, enricherB], config);

    expect(result).toEqual({ b: 2 });
    expect(enricherA.run).not.toHaveBeenCalled();
    expect(enricherB.run).toHaveBeenCalledTimes(1);
  });

  // ── Empty enrichers list ──────────────────────────────────────────────────

  it("handles empty enrichers list", async () => {
    const task = await seedTask();

    const result = await runEnrichers(task, "/tmp/repo", [], {});

    expect(result).toEqual({});

    const updated = await getById(task.id);
    expect(updated!.enrichment).toEqual({});
  });

  // ── Merge behavior (later overrides earlier) ──────────────────────────────

  it("later enrichers override earlier ones for conflicting keys", async () => {
    const task = await seedTask();

    const enricherA = createMockEnricher("alpha", { shared: "from-alpha", onlyA: true });
    const enricherB = createMockEnricher("beta", { shared: "from-beta", onlyB: true });

    const config = {
      alpha: { enabled: true },
      beta: { enabled: true },
    };

    const result = await runEnrichers(task, "/tmp/repo", [enricherA, enricherB], config);

    expect(result).toEqual({
      shared: "from-beta",
      onlyA: true,
      onlyB: true,
    });
  });
});
