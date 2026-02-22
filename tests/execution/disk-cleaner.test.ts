import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { readdir, stat, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ── Module mocks ───────────────────────────────────────────────────────────────
// Must be hoisted before any import of the module under test.

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: vi.fn((fn) => fn),   // return the fn itself – see note below
}));

vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  tasks: { id: "id", status: "status" },
}));

vi.mock("drizzle-orm", () => ({
  inArray: vi.fn((_col, _vals) => "inArray-condition"),
}));

// ── Import module after mocks ──────────────────────────────────────────────────

import {
  scan,
  clean,
  validatePaths,
  parseGitWorktreeList,
  dirSizeBytes,
  WORKTREE_BASE,
} from "../../src/execution/disk-cleaner.js";
import { db } from "../../src/db/connection.js";

// ── Typed mock helpers ─────────────────────────────────────────────────────────

const mockReaddir = readdir as unknown as MockedFunction<typeof readdir>;
const mockStat = stat as unknown as MockedFunction<typeof stat>;
const mockRm = rm as unknown as MockedFunction<typeof rm>;
const mockExecFile = execFile as unknown as MockedFunction<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>;
const mockDb = db as unknown as {
  select: MockedFunction<() => typeof mockDb>;
  from: MockedFunction<() => typeof mockDb>;
  where: MockedFunction<() => Promise<{ id: string }[]>>;
};

/** Creates a minimal stat-like object */
function makeStat(opts: { isDirectory?: boolean; size?: number; mtime?: Date; birthtime?: Date } = {}) {
  return {
    isDirectory: () => opts.isDirectory ?? true,
    size: opts.size ?? 0,
    mtime: opts.mtime ?? new Date("2024-01-01T00:00:00Z"),
    birthtime: opts.birthtime ?? new Date("2024-01-01T00:00:00Z"),
  };
}

// ── parseGitWorktreeList ───────────────────────────────────────────────────────

describe("parseGitWorktreeList", () => {
  it("extracts worktree paths from porcelain output", () => {
    const output = [
      "worktree /tmp/hive-worktrees/main",
      "HEAD abc123",
      "bare",
      "",
      "worktree /tmp/hive-worktrees/feature-x",
      "HEAD def456",
      "branch refs/heads/feature-x",
    ].join("\n");

    expect(parseGitWorktreeList(output)).toEqual([
      "/tmp/hive-worktrees/main",
      "/tmp/hive-worktrees/feature-x",
    ]);
  });

  it("returns empty array for empty output", () => {
    expect(parseGitWorktreeList("")).toEqual([]);
  });
});

// ── dirSizeBytes ───────────────────────────────────────────────────────────────

describe("dirSizeBytes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sums file sizes in a directory", async () => {
    mockReaddir.mockResolvedValueOnce([
      Object.assign("file1.txt", { isDirectory: () => false, name: "file1.txt" }),
      Object.assign("file2.txt", { isDirectory: () => false, name: "file2.txt" }),
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockStat
      .mockResolvedValueOnce(makeStat({ isDirectory: false, size: 1000 }) as unknown as Awaited<ReturnType<typeof stat>>)
      .mockResolvedValueOnce(makeStat({ isDirectory: false, size: 500 }) as unknown as Awaited<ReturnType<typeof stat>>);

    const size = await dirSizeBytes("/some/dir");
    expect(size).toBe(1500);
  });

  it("returns 0 when directory is unreadable", async () => {
    mockReaddir.mockRejectedValueOnce(new Error("EACCES"));
    const size = await dirSizeBytes("/unreadable");
    expect(size).toBe(0);
  });
});

// ── validatePaths ─────────────────────────────────────────────────────────────

describe("validatePaths", () => {
  it("accepts a valid absolute path inside WORKTREE_BASE", () => {
    expect(() =>
      validatePaths([`${WORKTREE_BASE}/hive-HIVE-20260101-12345678`]),
    ).not.toThrow();
  });

  it("rejects a relative path", () => {
    expect(() => validatePaths(["relative/path"])).toThrow(
      /non-absolute path/,
    );
  });

  it("rejects path-traversal with ../ that escapes WORKTREE_BASE", () => {
    expect(() =>
      validatePaths([`${WORKTREE_BASE}/../../../etc/passwd`]),
    ).toThrow(/path-traversal/);
  });

  it("rejects targeting WORKTREE_BASE itself", () => {
    expect(() => validatePaths([WORKTREE_BASE])).toThrow(
      /worktree base directory/,
    );
  });

  it("rejects a path outside WORKTREE_BASE entirely", () => {
    expect(() => validatePaths(["/etc/shadow"])).toThrow(
      /path-traversal/,
    );
  });

  it("accepts multiple valid paths", () => {
    expect(() =>
      validatePaths([
        `${WORKTREE_BASE}/task-a`,
        `${WORKTREE_BASE}/task-b`,
      ]),
    ).not.toThrow();
  });

  it("rejects as soon as one path is invalid", () => {
    expect(() =>
      validatePaths([
        `${WORKTREE_BASE}/task-a`,
        "/tmp/evil",
      ]),
    ).toThrow(/path-traversal/);
  });
});

// ── scan() ────────────────────────────────────────────────────────────────────

describe("scan()", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: DB returns empty active task list
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockResolvedValue([]);

    // Default: git worktree list fails (not a git repo) – that's fine
    mockExecFile.mockRejectedValue(new Error("not a git repository"));
  });

  it("returns empty array when WORKTREE_BASE does not exist", async () => {
    mockReaddir.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await scan();
    expect(result).toEqual([]);
  });

  it("detects orphan worktree directories for inactive tasks", async () => {
    const dirName = "hive-HIVE-20260101-99999999-1234567890";
    const fullPath = `${WORKTREE_BASE}/${dirName}`;

    // readdir returns the worktree dir
    mockReaddir.mockResolvedValueOnce([dirName] as unknown as Awaited<ReturnType<typeof readdir>>);

    // stat for the entry – it's a directory
    const statObj = makeStat({
      isDirectory: true,
      birthtime: new Date("2024-06-01T00:00:00Z"),
    });
    mockStat.mockResolvedValue(statObj as unknown as Awaited<ReturnType<typeof stat>>);

    // dirSizeBytes inner readdir – empty directory
    mockReaddir.mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof readdir>>);

    // Active tasks: empty (the task is NOT active → orphan)
    mockDb.where.mockResolvedValueOnce([]);

    const result = await scan();

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(fullPath);
    expect(result[0].type).toBe("worktree");
    expect(result[0].reason).toMatch(/HIVE-20260101-99999999/);
  });

  it("does NOT flag worktrees whose task is still active", async () => {
    const taskId = "HIVE-20260101-11111111";
    const dirName = `hive-${taskId}-1234567890`;

    mockReaddir.mockResolvedValueOnce([dirName] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockStat.mockResolvedValue(
      makeStat({ isDirectory: true }) as unknown as Awaited<ReturnType<typeof stat>>,
    );

    // Task is still active
    mockDb.where.mockResolvedValueOnce([{ id: taskId }]);

    const result = await scan();
    expect(result).toHaveLength(0);
  });

  it("detects orphan preview artefact directories", async () => {
    const dirName = "hive-preview-HIVE-20260101-22222222";
    const fullPath = `${WORKTREE_BASE}/${dirName}`;

    mockReaddir.mockResolvedValueOnce([dirName] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockStat.mockResolvedValue(
      makeStat({ isDirectory: true }) as unknown as Awaited<ReturnType<typeof stat>>,
    );
    // dirSizeBytes inner readdir
    mockReaddir.mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof readdir>>);

    // Task not active
    mockDb.where.mockResolvedValueOnce([]);

    const result = await scan();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(fullPath);
    expect(result[0].type).toBe("preview");
  });

  it("detects stale temp directories older than 24 h", async () => {
    const dirName = "hive-tmp-build-artifacts";
    const fullPath = `${WORKTREE_BASE}/${dirName}`;
    const oldDate = new Date(Date.now() - 25 * 3600 * 1000); // 25 h ago

    mockReaddir.mockResolvedValueOnce([dirName] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockStat.mockResolvedValue(
      makeStat({ isDirectory: true, birthtime: oldDate }) as unknown as Awaited<ReturnType<typeof stat>>,
    );
    mockReaddir.mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockDb.where.mockResolvedValueOnce([]);

    const result = await scan();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(fullPath);
    expect(result[0].type).toBe("temp");
  });

  it("does NOT flag a temp directory newer than 24 h", async () => {
    const dirName = "hive-tmp-fresh";
    const recentDate = new Date(Date.now() - 1 * 3600 * 1000); // 1 h ago

    mockReaddir.mockResolvedValueOnce([dirName] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockStat.mockResolvedValue(
      makeStat({ isDirectory: true, birthtime: recentDate }) as unknown as Awaited<ReturnType<typeof stat>>,
    );

    mockDb.where.mockResolvedValueOnce([]);

    const result = await scan();
    expect(result).toHaveLength(0);
  });

  it("skips non-directory entries", async () => {
    mockReaddir.mockResolvedValueOnce(["somefile.lock"] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockStat.mockResolvedValue(
      makeStat({ isDirectory: false }) as unknown as Awaited<ReturnType<typeof stat>>,
    );
    mockDb.where.mockResolvedValueOnce([]);

    const result = await scan();
    expect(result).toHaveLength(0);
  });

  it("uses git worktree list to enrich orphan reason when tracked", async () => {
    const taskId = "HIVE-20260101-33333333";
    const dirName = `hive-${taskId}-9999`;
    const fullPath = `${WORKTREE_BASE}/${dirName}`;

    mockReaddir.mockResolvedValueOnce([dirName] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockStat.mockResolvedValue(
      makeStat({ isDirectory: true }) as unknown as Awaited<ReturnType<typeof stat>>,
    );
    mockReaddir.mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof readdir>>);

    // Task not active
    mockDb.where.mockResolvedValueOnce([]);

    // git worktree list includes this path
    mockExecFile.mockResolvedValueOnce({
      stdout: `worktree ${fullPath}\nHEAD abc\nbranch refs/heads/feature\n`,
      stderr: "",
    } as unknown as { stdout: string; stderr: string });

    const result = await scan();
    expect(result).toHaveLength(1);
    expect(result[0].reason).toMatch(/still listed in git worktree list/);
  });
});

// ── clean() ───────────────────────────────────────────────────────────────────

describe("clean()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes specified paths and returns freed bytes and count", async () => {
    const p1 = `${WORKTREE_BASE}/hive-HIVE-20260101-44444444-111`;
    const p2 = `${WORKTREE_BASE}/hive-HIVE-20260101-55555555-222`;

    // dirSizeBytes calls (readdir returns one file each)
    mockReaddir
      .mockResolvedValueOnce([
        Object.assign("a.txt", { isDirectory: () => false, name: "a.txt" }),
      ] as unknown as Awaited<ReturnType<typeof readdir>>)
      .mockResolvedValueOnce([
        Object.assign("b.txt", { isDirectory: () => false, name: "b.txt" }),
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockStat
      .mockResolvedValueOnce(makeStat({ isDirectory: false, size: 2000 }) as unknown as Awaited<ReturnType<typeof stat>>)
      .mockResolvedValueOnce(makeStat({ isDirectory: false, size: 3000 }) as unknown as Awaited<ReturnType<typeof stat>>);

    mockRm.mockResolvedValue(undefined);

    const result = await clean([p1, p2]);

    expect(result.removedCount).toBe(2);
    expect(result.freedBytes).toBe(5000);
    expect(result.errors).toHaveLength(0);
    expect(mockRm).toHaveBeenCalledTimes(2);
  });

  it("records errors for failed deletions but continues", async () => {
    const p1 = `${WORKTREE_BASE}/hive-HIVE-20260101-66666666-333`;

    // dirSizeBytes – empty dir
    mockReaddir.mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockRm.mockRejectedValueOnce(new Error("Permission denied"));

    const result = await clean([p1]);

    expect(result.removedCount).toBe(0);
    expect(result.freedBytes).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Permission denied/);
  });

  it("throws before deleting anything when a path fails validation", async () => {
    const malicious = "/etc/passwd";

    await expect(clean([malicious])).rejects.toThrow(/path-traversal/);
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("throws on relative path before any deletion", async () => {
    await expect(clean(["../../../etc/shadow"])).rejects.toThrow(
      /non-absolute path/,
    );
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("handles empty path list gracefully", async () => {
    const result = await clean([]);
    expect(result).toEqual({ freedBytes: 0, removedCount: 0, errors: [] });
    expect(mockRm).not.toHaveBeenCalled();
  });
});
