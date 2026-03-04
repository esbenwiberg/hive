import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectBuildSystem } from "../../src/execution/build-system.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hive-bs-test-"));
}

async function touch(dir: string, ...parts: string[]): Promise<void> {
  const filePath = join(dir, ...parts);
  const parent = join(dir, ...parts.slice(0, -1));
  await mkdir(parent, { recursive: true });
  await writeFile(filePath, "");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("detectBuildSystem", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("detects .csproj at depth 2 (src/MyApp/MyApp.csproj)", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "src", "MyApp", "MyApp.csproj");

    const result = await detectBuildSystem(root);
    expect(result.type).toBe("dotnet");
    expect(result.dotnetDir).toBe(root);
  });

  it("detects .csproj at depth 3", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "src", "Backend", "Api", "Api.csproj");

    const result = await detectBuildSystem(root);
    expect(result.type).toBe("dotnet");
    expect(result.dotnetDir).toBe(root);
  });

  it("detects .sln at root as dotnet", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "MyApp.sln");

    const result = await detectBuildSystem(root);
    expect(result.type).toBe("dotnet");
    expect(result.dotnetDir).toBe(root);
  });

  it("does not scan into skip dirs (node_modules, bin, obj)", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    // Only .csproj inside node_modules — should not be detected
    await touch(root, "node_modules", "SomeLib", "SomeLib.csproj");
    await touch(root, "bin", "Debug", "App.csproj");
    await touch(root, "package.json");

    const result = await detectBuildSystem(root);
    expect(result.type).toBe("npm");
    expect(result.dotnetDir).toBeNull();
  });

  it("detects dotnet+npm hybrid", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "src", "Api", "Api.csproj");
    await touch(root, "client", "package.json");

    const result = await detectBuildSystem(root);
    expect(result.type).toBe("dotnet+npm");
    expect(result.dotnetDir).toBe(root);
    expect(result.npmDir).toBe(join(root, "client"));
  });

  it("respects override to force npm-only", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "src", "Api", "Api.csproj");
    await touch(root, "package.json");

    const result = await detectBuildSystem(root, "npm");
    expect(result.type).toBe("npm");
    expect(result.dotnetDir).toBeNull();
    expect(result.npmDir).toBe(root);
  });

  it("respects override to force dotnet-only", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "src", "Api", "Api.csproj");
    await touch(root, "package.json");

    const result = await detectBuildSystem(root, "dotnet");
    expect(result.type).toBe("dotnet");
    expect(result.npmDir).toBeNull();
    expect(result.dotnetDir).toBe(root);
  });

  it("defaults to npm when no .csproj or .sln found", async () => {
    const root = await makeTempRepo();
    dirs.push(root);
    await touch(root, "package.json");

    const result = await detectBuildSystem(root);
    expect(result.type).toBe("npm");
    expect(result.npmDir).toBe(root);
    expect(result.dotnetDir).toBeNull();
  });
});
