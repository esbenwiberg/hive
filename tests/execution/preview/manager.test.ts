import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock logger
vi.mock("../../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock autonomous config
const mockSettings = {
  enabled: true,
  max_concurrent: 3,
  cleanup_timeout_minutes: 30,
  docker_host: {
    ip: "",
    port: 2376,
    tls_cert_vault_secret: "docker-tls-cert",
    tls_key_vault_secret: "docker-tls-key",
    tls_ca_vault_secret: "docker-tls-ca",
  },
  port_range: [4001, 4010] as [number, number],
};

vi.mock("../../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: () => ({
    preview: mockSettings,
  }),
}));

// Mock DB connection and Drizzle
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbWhere = vi.fn();

vi.mock("../../../src/db/connection.js", () => ({
  db: {
    update: (...args: unknown[]) => {
      mockDbUpdate(...args);
      return {
        set: (...setArgs: unknown[]) => {
          mockDbSet(...setArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              mockDbWhere(...whereArgs);
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

// Mock schema (just need tasks for the eq() calls)
vi.mock("../../../src/db/schema.js", () => ({
  tasks: { id: "id" },
}));

// Mock drizzle-orm eq
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// Mock preview-logs
const mockAddPreviewLog = vi.fn().mockResolvedValue({});
vi.mock("../../../src/db/queries/preview-logs.js", () => ({
  addPreviewLog: (...args: unknown[]) => mockAddPreviewLog(...args),
}));

// Mock child_process
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fetch so waitForHealthCheck resolves immediately
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", mockFetch);

// ── Import (after mocks) ─────────────────────────────────────────────────────

const { PreviewManager } = await import(
  "../../../src/execution/preview/manager.js"
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function createFakeChildProcess(): ChildProcess {
  return {
    pid: 12345,
    killed: false,
    kill: vi.fn(() => true),
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn(),
  } as unknown as ChildProcess;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PreviewManager", () => {
  let manager: InstanceType<typeof PreviewManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new PreviewManager();
  });

  // ── Port allocation ─────────────────────────────────────────────────────

  describe("allocatePort / freePort", () => {
    it("allocates ports sequentially from the range start", () => {
      const p1 = manager.allocatePort();
      const p2 = manager.allocatePort();
      const p3 = manager.allocatePort();

      expect(p1).toBe(4001);
      expect(p2).toBe(4002);
      expect(p3).toBe(4003);
    });

    it("reuses a freed port", () => {
      const p1 = manager.allocatePort();
      const p2 = manager.allocatePort();

      manager.freePort(p1);

      const p3 = manager.allocatePort();
      expect(p3).toBe(p1); // Should reuse the freed port
    });

    it("throws when all ports are exhausted", () => {
      // Allocate all 10 ports (4001–4010)
      for (let i = 0; i < 10; i++) {
        manager.allocatePort();
      }

      expect(() => manager.allocatePort()).toThrow(
        "No available ports in range 4001-4010",
      );
    });
  });

  // ── startPreview (process type) ─────────────────────────────────────────

  describe("startPreview — process type", () => {
    it("starts a process preview and updates DB", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      const info = await manager.startPreview("HIVE-001", "/tmp/worktree", config);

      expect(info.taskId).toBe("HIVE-001");
      expect(info.type).toBe("process");
      expect(info.port).toBe(4001); // First allocated port
      expect(info.host).toBe("localhost");
      expect(info.worktreePath).toBe("/tmp/worktree");
      expect(info.childProcess).toBe(fakeChild);
      expect(info.startedAt).toBeInstanceOf(Date);

      // Verify spawn was called correctly (uses sh -c for proper command parsing)
      expect(mockSpawn).toHaveBeenCalledWith(
        "sh",
        ["-c", "npm start"],
        expect.objectContaining({
          cwd: "/tmp/worktree",
          env: expect.objectContaining({
            PORT: "4001",
          }),
        }),
      );

      // Verify DB was updated (starting, then running)
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({ previewStatus: "starting" }),
      );
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({ previewStatus: "running" }),
      );

      // Verify preview log was added
      expect(mockAddPreviewLog).toHaveBeenCalledWith(
        "HIVE-001",
        "manager",
        expect.stringContaining("Starting process preview"),
      );
    });

    it("sets PORT env var and merges config env", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "node server.js",
        env: { NODE_ENV: "test", DB_URL: "postgres://localhost/test" },
      };

      await manager.startPreview("HIVE-002", "/tmp/worktree", config);

      expect(mockSpawn).toHaveBeenCalledWith(
        "sh",
        ["-c", "node server.js"],
        expect.objectContaining({
          env: expect.objectContaining({
            PORT: "4001",
            NODE_ENV: "test",
            DB_URL: "postgres://localhost/test",
          }),
        }),
      );
    });
  });

  // ── stopPreview ─────────────────────────────────────────────────────────

  describe("stopPreview", () => {
    it("kills child process and frees port", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-003", "/tmp/worktree", config);
      expect(manager.getPreviewInfo("HIVE-003")).toBeDefined();

      await manager.stopPreview("HIVE-003");

      // Child process should have been killed
      expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

      // Preview should be removed from in-memory map
      expect(manager.getPreviewInfo("HIVE-003")).toBeUndefined();

      // DB should be updated to stopped
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({ previewStatus: "stopped" }),
      );

      // Port should be freed — next allocation should reuse it
      const nextPort = manager.allocatePort();
      expect(nextPort).toBe(4001);
    });

    it("does nothing when no preview exists for the task", async () => {
      await manager.stopPreview("HIVE-nonexistent");
      // Should not throw, should not call DB updates
      expect(mockDbSet).not.toHaveBeenCalled();
    });
  });

  // ── max_concurrent limit ────────────────────────────────────────────────

  describe("max_concurrent limit", () => {
    it("rejects when at capacity", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      // Start 3 previews (max_concurrent is 3)
      await manager.startPreview("HIVE-A1", "/tmp/a1", config);
      await manager.startPreview("HIVE-A2", "/tmp/a2", config);
      await manager.startPreview("HIVE-A3", "/tmp/a3", config);

      // Fourth should fail
      await expect(
        manager.startPreview("HIVE-A4", "/tmp/a4", config),
      ).rejects.toThrow("Max concurrent previews (3) reached");
    });

    it("allows new preview after stopping one", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-B1", "/tmp/b1", config);
      await manager.startPreview("HIVE-B2", "/tmp/b2", config);
      await manager.startPreview("HIVE-B3", "/tmp/b3", config);

      // Stop one
      await manager.stopPreview("HIVE-B1");

      // Should now be able to start another
      const info = await manager.startPreview("HIVE-B4", "/tmp/b4", config);
      expect(info.taskId).toBe("HIVE-B4");
    });
  });

  // ── cleanupExpired ──────────────────────────────────────────────────────

  describe("cleanupExpired", () => {
    it("finds and stops previews past timeout", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-EXP1", "/tmp/exp1", config);
      await manager.startPreview("HIVE-EXP2", "/tmp/exp2", config);

      // Manually age the first preview's startedAt past the timeout
      const info1 = manager.getPreviewInfo("HIVE-EXP1")!;
      info1.startedAt = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago

      const expired = await manager.cleanupExpired();

      expect(expired).toEqual(["HIVE-EXP1"]);
      expect(manager.getPreviewInfo("HIVE-EXP1")).toBeUndefined();
      expect(manager.getPreviewInfo("HIVE-EXP2")).toBeDefined();
    });

    it("returns empty array when no previews are expired", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-FRESH1", "/tmp/fresh", config);

      const expired = await manager.cleanupExpired();
      expect(expired).toEqual([]);
    });

    it("uses custom timeout from resolver when provided", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-CUSTOM1", "/tmp/custom1", config);

      // Age the preview by 10 minutes
      const info = manager.getPreviewInfo("HIVE-CUSTOM1")!;
      info.startedAt = new Date(Date.now() - 10 * 60 * 1000);

      // Custom resolver returns 5 minutes (shorter than global 30 min)
      const resolver = vi.fn().mockResolvedValue(5 * 60 * 1000);

      const expired = await manager.cleanupExpired(resolver);
      expect(expired).toEqual(["HIVE-CUSTOM1"]);
      expect(resolver).toHaveBeenCalledWith("HIVE-CUSTOM1");
    });

    it("falls back to global timeout when resolver returns undefined", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-FALLBACK1", "/tmp/fb1", config);

      // Age by 10 minutes — less than global 30 min timeout
      const info = manager.getPreviewInfo("HIVE-FALLBACK1")!;
      info.startedAt = new Date(Date.now() - 10 * 60 * 1000);

      const resolver = vi.fn().mockResolvedValue(undefined);

      const expired = await manager.cleanupExpired(resolver);
      expect(expired).toEqual([]); // Should NOT be expired (10 min < 30 min global)
    });

    it("falls back to global timeout when resolver throws", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-ERR1", "/tmp/err1", config);

      // Age by 10 minutes — less than global 30 min timeout
      const info = manager.getPreviewInfo("HIVE-ERR1")!;
      info.startedAt = new Date(Date.now() - 10 * 60 * 1000);

      const resolver = vi.fn().mockRejectedValue(new Error("DB down"));

      const expired = await manager.cleanupExpired(resolver);
      expect(expired).toEqual([]); // Falls back to global 30 min, so not expired
    });
  });

  // ── extendPreview ───────────────────────────────────────────────────────

  describe("extendPreview", () => {
    it("resets startedAt timestamp to now", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-EXT1", "/tmp/ext1", config);

      // Age the preview
      const info = manager.getPreviewInfo("HIVE-EXT1")!;
      const oldTime = new Date(Date.now() - 20 * 60 * 1000);
      info.startedAt = oldTime;

      await manager.extendPreview("HIVE-EXT1");

      const updated = manager.getPreviewInfo("HIVE-EXT1")!;
      expect(updated.startedAt.getTime()).toBeGreaterThan(oldTime.getTime());

      // DB should have been updated with new previewStartedAt
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({ previewStartedAt: expect.any(Date) }),
      );

      // Preview log should note the extension
      expect(mockAddPreviewLog).toHaveBeenCalledWith(
        "HIVE-EXT1",
        "manager",
        "Preview lifetime extended",
      );
    });

    it("throws when no active preview exists", async () => {
      await expect(manager.extendPreview("HIVE-NONE")).rejects.toThrow(
        "No active preview for task HIVE-NONE",
      );
    });
  });

  // ── getRunningPreviews ──────────────────────────────────────────────────

  describe("getRunningPreviews", () => {
    it("returns all active previews", async () => {
      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const config = {
        type: "process" as const,
        port: 3000,
        start_command: "npm start",
      };

      await manager.startPreview("HIVE-R1", "/tmp/r1", config);
      await manager.startPreview("HIVE-R2", "/tmp/r2", config);

      const running = manager.getRunningPreviews();
      expect(running.size).toBe(2);
      expect(running.has("HIVE-R1")).toBe(true);
      expect(running.has("HIVE-R2")).toBe(true);
    });
  });
});
