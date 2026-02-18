import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dependenciesEnricher } from "../../src/enrichers/dependencies.js";
import type { TaskRow } from "../../src/db/schema.js";
import type { EnricherConfig } from "../../src/enrichers/base.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DUMMY_TASK = {
  id: "task-deps-test",
  title: "Test task",
  body: "Test body",
} as TaskRow;

const DEFAULT_CONFIG: EnricherConfig = { enabled: true };

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hive-deps-test-"));
  tempDirs.push(dir);
  return dir;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dependenciesEnricher", () => {
  it("has the correct name", () => {
    expect(dependenciesEnricher.name).toBe("dependencies");
  });

  it("extracts dependencies from package.json", async () => {
    const dir = await makeTempDir();

    const pkg = {
      name: "test-project",
      dependencies: { express: "^4.18.0", lodash: "^4.17.21" },
      devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
      scripts: { build: "tsc", test: "vitest", lint: "eslint ." },
      engines: { node: ">=18" },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data.dependencies).toEqual({
      express: "^4.18.0",
      lodash: "^4.17.21",
    });
    expect(result.data.devDependencies).toEqual({
      vitest: "^1.0.0",
      typescript: "^5.0.0",
    });
    expect(result.data.scripts).toEqual(["build", "test", "lint"]);
    expect(result.data.engines).toEqual({ node: ">=18" });
    expect(result.data.lockFile).toBeNull();
  });

  it("detects package-lock.json", async () => {
    const dir = await makeTempDir();

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    await writeFile(join(dir, "package-lock.json"), "{}");

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.data.lockFile).toBe("package-lock.json");
  });

  it("detects yarn.lock", async () => {
    const dir = await makeTempDir();

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    await writeFile(join(dir, "yarn.lock"), "");

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.data.lockFile).toBe("yarn.lock");
  });

  it("detects pnpm-lock.yaml", async () => {
    const dir = await makeTempDir();

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "");

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.data.lockFile).toBe("pnpm-lock.yaml");
  });

  it("prefers package-lock.json over yarn.lock", async () => {
    const dir = await makeTempDir();

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    await writeFile(join(dir, "package-lock.json"), "{}");
    await writeFile(join(dir, "yarn.lock"), "");

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.data.lockFile).toBe("package-lock.json");
  });

  it("handles missing package.json gracefully", async () => {
    const dir = await makeTempDir();

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data.dependencies).toEqual({});
    expect(result.data.devDependencies).toEqual({});
    expect(result.data.lockFile).toBeNull();
    expect(result.data.scripts).toEqual([]);
  });

  it("handles package.json without optional fields", async () => {
    const dir = await makeTempDir();

    const pkg = { name: "bare-project", version: "1.0.0" };
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.data.dependencies).toEqual({});
    expect(result.data.devDependencies).toEqual({});
    expect(result.data.scripts).toEqual([]);
    expect(result.data.engines).toBeUndefined();
    expect(result.data.lockFile).toBeNull();
  });

  it("handles invalid JSON in package.json gracefully", async () => {
    const dir = await makeTempDir();

    await writeFile(join(dir, "package.json"), "not valid json {{{");

    const result = await dependenciesEnricher.run(DUMMY_TASK, dir, {}, DEFAULT_CONFIG);

    expect(result.data.dependencies).toEqual({});
    expect(result.data.devDependencies).toEqual({});
    expect(result.data.lockFile).toBeNull();
    expect(result.data.scripts).toEqual([]);
  });
});
