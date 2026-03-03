import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectBuildSystem } from "../../src/execution/build-system.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hive-build-test-"));
}

async function touch(filePath: string): Promise<void> {
  await mkdir(join(filePath, "..").replace(/\/\.\.$/, ""), { recursive: true });
  await writeFile(filePath, "");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("detectBuildSystem", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("detects .csproj at depth 2 (src/MyApp/MyApp.csproj)", async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);

    await mkdir(join(dir, "src", "MyApp"), { recursive: true });
    await writeFile(join(dir, "src", "MyApp", "MyApp.csproj"), "<Project />");

    const result = await detectBuildSystem(dir);
    expect(result.type).toBe("dotnet");
    expect(result.dotnetDir).toBe(dir);
  });

  it("detects .csproj at depth 3", async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);

    await mkdir(join(dir, "src", "apps", "WebApi"), { recursive: true });
    await writeFile(join(dir, "src", "apps", "WebApi", "WebApi.csproj"), "<Project />");

    const result = await detectBuildSystem(dir);
    expect(result.type).toBe("dotnet");
  });

  it("skips node_modules, bin, obj directories", async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);

    // Put .csproj only inside skip dirs
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "fake.csproj"), "");
    await mkdir(join(dir, "bin", "Debug"), { recursive: true });
    await writeFile(join(dir, "bin", "Debug", "app.csproj"), "");
    await mkdir(join(dir, "obj"), { recursive: true });
    await writeFile(join(dir, "obj", "app.csproj"), "");

    // Add package.json so we get npm instead of dotnet
    await writeFile(join(dir, "package.json"), "{}");

    const result = await detectBuildSystem(dir);
    expect(result.type).toBe("npm");
  });

  it("detects dotnet+npm hybrid with nested csproj", async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);

    // .NET project
    await mkdir(join(dir, "src", "Api"), { recursive: true });
    await writeFile(join(dir, "src", "Api", "Api.csproj"), "<Project />");

    // npm project at root
    await writeFile(join(dir, "package.json"), "{}");

    const result = await detectBuildSystem(dir);
    expect(result.type).toBe("dotnet+npm");
    expect(result.dotnetDir).toBe(dir);
    expect(result.npmDir).toBe(dir);
  });

  it("respects override to force npm-only", async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);

    await mkdir(join(dir, "src", "Api"), { recursive: true });
    await writeFile(join(dir, "src", "Api", "Api.csproj"), "<Project />");
    await writeFile(join(dir, "package.json"), "{}");

    const result = await detectBuildSystem(dir, "npm");
    expect(result.type).toBe("npm");
    expect(result.dotnetDir).toBeNull();
    expect(result.npmDir).toBe(dir);
  });

  it("detects .sln at root as dotnet", async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);

    await writeFile(join(dir, "MyApp.sln"), "");

    const result = await detectBuildSystem(dir);
    expect(result.type).toBe("dotnet");
  });
});
