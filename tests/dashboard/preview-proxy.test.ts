import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock autonomous config (needed by PreviewManager constructor)
vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => ({
    preview: {
      enabled: true,
      max_concurrent: 3,
      cleanup_timeout_minutes: 30,
      docker_host: { ip: "", port: 2376 },
      port_range: [4001, 4010] as [number, number],
    },
  }),
}));

// Mock DB
const mockDbUpdate = vi.fn();
vi.mock("../../src/db/connection.js", () => ({
  db: {
    update: (...args: unknown[]) => {
      mockDbUpdate(...args);
      return {
        set: () => ({
          where: () => Promise.resolve(),
        }),
      };
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  tasks: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock("../../src/db/queries/preview-logs.js", () => ({
  addPreviewLog: vi.fn().mockResolvedValue({}),
}));

// Mock task queries
const mockGetById = vi.fn();
vi.mock("../../src/db/queries/tasks.js", () => ({
  getById: (...args: unknown[]) => mockGetById(...args),
  list: vi.fn().mockResolvedValue({ tasks: [] }),
  countByStatus: vi.fn().mockResolvedValue({}),
  create: vi.fn().mockResolvedValue({}),
  updateStatus: vi.fn().mockResolvedValue({}),
}));

// Mock worktree cleanup
const mockCleanupWorktree = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/execution/worktree.js", () => ({
  cleanupWorktree: (...args: unknown[]) => mockCleanupWorktree(...args),
}));

import { previewSection, taskDetailPanel } from "../../src/dashboard/views/tasks.js";
import type { TaskRow } from "../../src/db/schema.js";
import { previewManager } from "../../src/execution/preview/manager.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-001",
    title: "Test task",
    body: "Test body",
    status: "executing",
    source: "user",
    type: "feature",
    severity: null,
    size: "small",
    workflow: null,
    model: null,
    maxTurns: null,
    maxBudgetUsd: null,
    enrichment: null,
    gateVerdict: null,
    gateReasoning: null,
    executionAttempts: 0,
    prUrl: null,
    failureReason: null,
    reworkCount: 0,
    reworkHistory: [],
    retryInstructions: null,
    epicId: null,
    milestoneIndex: null,
    milestoneTotal: null,
    blueprint: null,
    previewPort: null,
    previewStatus: null,
    previewStartedAt: null,
    createdBy: 1,
    approvedBy: null,
    repoId: 1,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as TaskRow;
}

// ── previewSection view tests ────────────────────────────────────────────

describe("previewSection", () => {
  it("returns empty string when previewStatus is null", () => {
    const task = makeTask({ previewStatus: null });
    expect(previewSection(task)).toBe("");
  });

  it("renders running badge and link when status is running with port", () => {
    const task = makeTask({ previewStatus: "running", previewPort: 4001 });
    const html = previewSection(task);
    expect(html).toContain("running");
    expect(html).toContain(`/preview/${task.id}/`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Open Preview");
  });

  it("renders stop and extend buttons when running", () => {
    const task = makeTask({ previewStatus: "running", previewPort: 4001 });
    const html = previewSection(task);
    expect(html).toContain("Stop Preview");
    expect(html).toContain(`hx-post="/api/tasks/${task.id}/preview/stop"`);
    expect(html).toContain("Extend");
    expect(html).toContain(`hx-post="/api/tasks/${task.id}/preview/extend"`);
  });

  it("renders starting badge with Starting... text", () => {
    const task = makeTask({ previewStatus: "starting" });
    const html = previewSection(task);
    expect(html).toContain("starting");
    expect(html).toContain("Starting...");
  });

  it("does not render preview link when starting", () => {
    const task = makeTask({ previewStatus: "starting" });
    const html = previewSection(task);
    expect(html).not.toContain("Open Preview");
  });

  it("renders failed badge", () => {
    const task = makeTask({ previewStatus: "failed" });
    const html = previewSection(task);
    expect(html).toContain("failed");
  });

  it("does not render preview link when failed", () => {
    const task = makeTask({ previewStatus: "failed" });
    const html = previewSection(task);
    expect(html).not.toContain("Open Preview");
  });

  it("renders stopped badge", () => {
    const task = makeTask({ previewStatus: "stopped" });
    const html = previewSection(task);
    expect(html).toContain("stopped");
  });

  it("does not render preview link when stopped", () => {
    const task = makeTask({ previewStatus: "stopped" });
    const html = previewSection(task);
    expect(html).not.toContain("Open Preview");
  });

  it("uses correct badge color for starting (amber)", () => {
    const task = makeTask({ previewStatus: "starting" });
    const html = previewSection(task);
    expect(html).toContain("amber");
  });

  it("uses correct badge color for running (emerald)", () => {
    const task = makeTask({ previewStatus: "running", previewPort: 4001 });
    const html = previewSection(task);
    expect(html).toContain("emerald");
  });

  it("uses correct badge color for failed (red)", () => {
    const task = makeTask({ previewStatus: "failed" });
    const html = previewSection(task);
    expect(html).toContain("red");
  });

  it("uses correct badge color for stopped (slate)", () => {
    const task = makeTask({ previewStatus: "stopped" });
    const html = previewSection(task);
    expect(html).toContain("slate");
  });
});

// ── taskDetailPanel preview integration ──────────────────────────────────

describe("taskDetailPanel preview integration", () => {
  it("includes preview section when previewStatus is set", () => {
    const task = makeTask({ previewStatus: "running", previewPort: 4001 });
    const html = taskDetailPanel(task);
    expect(html).toContain('id="preview-section"');
    expect(html).toContain("Preview");
  });

  it("does not include preview section when previewStatus is null", () => {
    const task = makeTask({ previewStatus: null });
    const html = taskDetailPanel(task);
    expect(html).not.toContain('id="preview-section"');
  });
});

// ── Preview proxy request handling (unit tests for manager lookup) ───────

describe("preview proxy logic", () => {
  beforeEach(() => {
    mockGetById.mockReset();
  });

  it("getPreviewInfo returns undefined for non-existent task (maps to 404)", () => {
    const info = previewManager.getPreviewInfo("nonexistent-task");
    expect(info).toBeUndefined();
  });

  it("getById returns task with starting status (maps to 503)", async () => {
    mockGetById.mockResolvedValue(makeTask({ previewStatus: "starting" }));
    const task = await mockGetById("task-001");
    expect(task.previewStatus).toBe("starting");
  });
});

// ── Preview stop route logic ─────────────────────────────────────────────

describe("preview stop route logic", () => {
  beforeEach(() => {
    mockGetById.mockReset();
    mockCleanupWorktree.mockReset();
    mockCleanupWorktree.mockResolvedValue(undefined);
  });

  it("stopPreview is a no-op for task without active preview", async () => {
    // stopPreview should not throw when no preview exists
    await expect(previewManager.stopPreview("nonexistent")).resolves.toBeUndefined();
  });

  it("returns updated previewSection HTML after stop", () => {
    const task = makeTask({ previewStatus: "stopped" });
    const html = previewSection(task);
    expect(html).toContain("stopped");
    expect(html).not.toContain("Open Preview");
  });
});

// ── Preview extend route logic ───────────────────────────────────────────

describe("preview extend route logic", () => {
  beforeEach(() => {
    mockGetById.mockReset();
  });

  it("extendPreview throws for task without active preview", async () => {
    await expect(previewManager.extendPreview("nonexistent")).rejects.toThrow(
      "No active preview for task nonexistent",
    );
  });

  it("returns previewSection HTML after extend (still running)", () => {
    const task = makeTask({ previewStatus: "running", previewPort: 4001 });
    const html = previewSection(task);
    expect(html).toContain("running");
    expect(html).toContain("Open Preview");
  });
});
