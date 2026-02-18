import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitHistoryEnricher } from "../../src/enrichers/git-history.js";
import type { TaskRow } from "../../src/db/schema.js";
import type { EnricherConfig } from "../../src/enrichers/base.js";

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────────────

const DUMMY_TASK = {
  id: "task-git-test",
  title: "Test task",
  body: "Test body",
} as TaskRow;

const DEFAULT_CONFIG: EnricherConfig = { enabled: true };

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hive-git-test-"));
  tempDirs.push(dir);
  return dir;
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test User"]);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("gitHistoryEnricher", () => {
  it("has the correct name", () => {
    expect(gitHistoryEnricher.name).toBe("git-history");
  });

  it("extracts recent commits from a git repo", async () => {
    const dir = await makeTempDir();
    await initGitRepo(dir);

    // Create a few commits
    await execFileAsync("touch", ["file1.txt"], { cwd: dir });
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Initial commit"]);

    await execFileAsync("touch", ["file2.txt"], { cwd: dir });
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Add file2"]);

    const result = await gitHistoryEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const data = result.data.gitHistory as Record<string, unknown>;
    const recentCommits = data.recentCommits as string[];

    expect(recentCommits).toHaveLength(2);
    expect(recentCommits[0]).toContain("Add file2");
    expect(recentCommits[1]).toContain("Initial commit");
  });

  it("extracts contributors from a git repo", async () => {
    const dir = await makeTempDir();
    await initGitRepo(dir);

    await execFileAsync("touch", ["a.txt"], { cwd: dir });
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Commit by Test User"]);

    const result = await gitHistoryEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    const data = result.data.gitHistory as Record<string, unknown>;
    const contributors = data.contributors as string[];

    expect(contributors.length).toBeGreaterThanOrEqual(1);
    expect(contributors[0]).toContain("Test User");
  });

  it("extracts hotspots from a git repo", async () => {
    const dir = await makeTempDir();
    await initGitRepo(dir);

    // Modify the same file multiple times to create a hotspot
    await execFileAsync("touch", ["hot.txt"], { cwd: dir });
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Create hot.txt"]);

    await execFileAsync("bash", ["-c", "echo 'change1' >> hot.txt"], { cwd: dir });
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Update hot.txt"]);

    await execFileAsync("bash", ["-c", "echo 'change2' >> hot.txt"], { cwd: dir });
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Update hot.txt again"]);

    const result = await gitHistoryEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    const data = result.data.gitHistory as Record<string, unknown>;
    const hotspots = data.hotspots as string[];

    // hot.txt should appear as a hotspot
    expect(hotspots.some((h) => h.includes("hot.txt"))).toBe(true);
  });

  it("handles non-git directory gracefully", async () => {
    const dir = await makeTempDir();

    const result = await gitHistoryEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const data = result.data.gitHistory as Record<string, unknown>;
    expect(data.recentCommits).toEqual([]);
    expect(data.hotspots).toEqual([]);
    expect(data.contributors).toEqual([]);
    expect(data.warning).toBeDefined();
  });

  it("handles empty git repo (no commits) gracefully", async () => {
    const dir = await makeTempDir();
    await initGitRepo(dir);

    // No commits made — git log will fail
    const result = await gitHistoryEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    const data = result.data.gitHistory as Record<string, unknown>;
    // Should return empty arrays with a warning (since git log fails with no commits)
    expect(data.recentCommits).toEqual([]);
    expect(data.warning).toBeDefined();
  });
});
