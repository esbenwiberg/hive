import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath, createWorktreeToolExecutor } from "../../src/execution/worker-tools.js";

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "hive-tools-test-"));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

// ── safePath ────────────────────────────────────────────────────────────────

describe("safePath", () => {
  it("resolves a relative path within the worktree", () => {
    const result = safePath(worktree, "src/index.ts");
    expect(result).toBe(join(worktree, "src/index.ts"));
  });

  it("rejects traversal with ..", () => {
    expect(() => safePath(worktree, "../etc/passwd")).toThrow("escapes worktree");
  });

  it("rejects absolute paths outside worktree", () => {
    expect(() => safePath(worktree, "/etc/passwd")).toThrow("escapes worktree");
  });

  it("allows nested paths", () => {
    const result = safePath(worktree, "a/b/c/d.ts");
    expect(result).toBe(join(worktree, "a/b/c/d.ts"));
  });
});

// ── Tool executor ───────────────────────────────────────────────────────────

describe("createWorktreeToolExecutor", () => {
  it("read_file reads an existing file", async () => {
    await writeFile(join(worktree, "hello.txt"), "world");
    const exec = createWorktreeToolExecutor(worktree);
    const result = await exec("read_file", { path: "hello.txt" });
    expect(result).toBe("world");
  });

  it("read_file rejects path traversal", async () => {
    const exec = createWorktreeToolExecutor(worktree);
    await expect(exec("read_file", { path: "../../etc/passwd" })).rejects.toThrow("escapes worktree");
  });

  it("write_file creates a file with parent dirs", async () => {
    const exec = createWorktreeToolExecutor(worktree);
    await exec("write_file", { path: "sub/dir/file.ts", content: "export const x = 1;" });
    const result = await exec("read_file", { path: "sub/dir/file.ts" });
    expect(result).toBe("export const x = 1;");
  });

  it("list_directory lists entries with / suffix for dirs", async () => {
    await mkdir(join(worktree, "src"));
    await writeFile(join(worktree, "readme.md"), "hi");
    const exec = createWorktreeToolExecutor(worktree);
    const result = await exec("list_directory", { path: "." });
    expect(result).toContain("src/");
    expect(result).toContain("readme.md");
  });

  it("run_command executes a command in the worktree", async () => {
    const exec = createWorktreeToolExecutor(worktree);
    const result = await exec("run_command", { command: "echo", args: ["hello"] });
    expect(result).toBe("hello");
  });

  it("run_command returns (no output) for silent commands", async () => {
    const exec = createWorktreeToolExecutor(worktree);
    const result = await exec("run_command", { command: "true" });
    expect(result).toBe("(no output)");
  });

  it("throws on unknown tool", async () => {
    const exec = createWorktreeToolExecutor(worktree);
    await expect(exec("delete_file", { path: "foo" })).rejects.toThrow("Unknown tool");
  });
});
