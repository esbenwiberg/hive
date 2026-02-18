import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTables, useTestDb } from "../../setup.js";

// ── Skip if no database ─────────────────────────────────────────────────────

describe.skipIf(!process.env.DATABASE_URL)(
  "Preview lifecycle integration (process type)",
  () => {
    // ── Mocks ──────────────────────────────────────────────────────────────

    // Mock logger so tests don't produce console output
    vi.mock("../../../src/logger.js", () => ({
      default: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    }));

    // Mock autonomous config with test-friendly settings
    vi.mock("../../../src/domain/autonomous-config.js", () => ({
      getAutonomousConfig: () => ({
        preview: {
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
          port_range: [4050, 4060] as [number, number],
        },
      }),
      loadConfig: vi.fn(),
    }));

    // Mock db/connection.js so queries use the test database
    vi.mock("../../../src/db/connection.js", async () => {
      const setup = await import("../../setup.js");
      return { db: setup.db, pool: setup.pool };
    });

    // ── Imports (after mocks) ────────────────────────────────────────────────

    // Use dynamic imports so mocks are applied before module initialization
    let PreviewManager: typeof import("../../../src/execution/preview/manager.js").PreviewManager;
    let validatePreview: typeof import("../../../src/execution/preview/validator.js").validatePreview;
    let parseHiveYaml: typeof import("../../../src/hive-yaml.js").parseHiveYaml;
    let addPreviewLog: typeof import("../../../src/db/queries/preview-logs.js").addPreviewLog;
    let getPreviewLogs: typeof import("../../../src/db/queries/preview-logs.js").getPreviewLogs;
    let findOrCreateByEntraOid: typeof import("../../../src/db/queries/users.js").findOrCreateByEntraOid;
    let findOrCreateRepo: typeof import("../../../src/db/queries/repos.js").findOrCreate;
    let createTask: typeof import("../../../src/db/queries/tasks.js").create;
    let getById: typeof import("../../../src/db/queries/tasks.js").getById;

    useTestDb();

    let tempDir: string;
    let previewManager: InstanceType<typeof PreviewManager>;

    beforeEach(async () => {
      await cleanupTables();

      // Dynamically import modules after mocks are established
      const managerModule = await import(
        "../../../src/execution/preview/manager.js"
      );
      PreviewManager = managerModule.PreviewManager;

      const validatorModule = await import(
        "../../../src/execution/preview/validator.js"
      );
      validatePreview = validatorModule.validatePreview;

      const yamlModule = await import("../../../src/hive-yaml.js");
      parseHiveYaml = yamlModule.parseHiveYaml;

      const previewLogsModule = await import(
        "../../../src/db/queries/preview-logs.js"
      );
      addPreviewLog = previewLogsModule.addPreviewLog;
      getPreviewLogs = previewLogsModule.getPreviewLogs;

      const usersModule = await import("../../../src/db/queries/users.js");
      findOrCreateByEntraOid = usersModule.findOrCreateByEntraOid;

      const reposModule = await import("../../../src/db/queries/repos.js");
      findOrCreateRepo = reposModule.findOrCreate;

      const tasksModule = await import("../../../src/db/queries/tasks.js");
      createTask = tasksModule.create;
      getById = tasksModule.getById;

      previewManager = new PreviewManager();

      // Create a temp directory simulating a worktree
      tempDir = mkdtempSync(join(tmpdir(), "hive-preview-test-"));
    });

    afterEach(async () => {
      // Stop any running previews to clean up child processes
      try {
        const running = previewManager.getRunningPreviews();
        for (const taskId of running.keys()) {
          await previewManager.stopPreview(taskId);
        }
      } catch {
        // Best effort cleanup
      }

      // Remove temp directory
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    });

    it("runs the full preview lifecycle: start, validate, stop", async () => {
      // ── (a) Create a simple inline HTTP server script ──────────────────

      const serverScript = `
const http = require("node:http");
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello from preview");
  }
});
server.listen(port, () => {
  console.log("Server listening on port " + port);
});
`;

      // ── (b) Write server script to temp directory ──────────────────────

      writeFileSync(join(tempDir, "server.js"), serverScript);

      // ── (c) Create a .hive.yaml with process preview config ────────────

      const hiveYaml = `
preview:
  type: process
  start_command: node server.js
  port: 3000
  health_check: /health
  startup_timeout: 15
`;

      writeFileSync(join(tempDir, ".hive.yaml"), hiveYaml);

      // ── (d) Parse the .hive.yaml ───────────────────────────────────────

      const config = parseHiveYaml(tempDir);

      expect(config).not.toBeNull();
      expect(config!.type).toBe("process");
      expect(config!.port).toBe(3000);

      // ── Seed a task in the DB ──────────────────────────────────────────

      const user = await findOrCreateByEntraOid(
        "oid-preview-test",
        "preview-test@example.com",
        "Preview Test User",
      );
      const repo = await findOrCreateRepo("github", "acme/preview-app");
      const task = await createTask({
        title: "Add health check endpoint",
        body: "Preview integration test task",
        source: "manual",
        repoId: repo.id,
        createdBy: user.id,
      });

      // ── (e) Start the preview ──────────────────────────────────────────

      const previewInfo = await previewManager.startPreview(
        task.id,
        tempDir,
        config!,
      );

      expect(previewInfo.taskId).toBe(task.id);
      expect(previewInfo.type).toBe("process");
      expect(previewInfo.port).toBeGreaterThanOrEqual(4050);
      expect(previewInfo.port).toBeLessThanOrEqual(4060);
      expect(previewInfo.host).toBe("localhost");

      // ── (f) Verify preview_status is 'running' in DB ───────────────────

      const afterStart = await getById(task.id);
      expect(afterStart!.previewStatus).toBe("running");
      expect(afterStart!.previewPort).toBe(previewInfo.port);

      // ── (g) Wait a moment for the server to be fully up, then validate ─

      // The manager's health check should have already passed by the time
      // startPreview resolves, but give a small buffer for any race condition
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const previewUrl = `http://localhost:${previewInfo.port}`;
      const validationResult = await validatePreview(
        task.id,
        previewUrl,
        "/health",
      );

      // ── (h) Verify validation passed ───────────────────────────────────

      expect(validationResult.passed).toBe(true);
      expect(validationResult.checks.length).toBeGreaterThanOrEqual(1);
      expect(validationResult.checks[0].passed).toBe(true);
      expect(validationResult.checks[0].status).toBe(200);

      // ── (i) Stop the preview ───────────────────────────────────────────

      await previewManager.stopPreview(task.id);

      // ── (j) Verify preview_status is 'stopped' in DB ──────────────────

      const afterStop = await getById(task.id);
      expect(afterStop!.previewStatus).toBe("stopped");

      // ── (k) Verify preview_logs has entries for each lifecycle stage ────

      const logs = await getPreviewLogs(task.id);

      // Should have logs from: starting, running, health check, validation, stopping, stopped
      expect(logs.length).toBeGreaterThanOrEqual(4);

      const messages = logs.map((l) => l.message);

      // Check key lifecycle log entries exist
      expect(messages.some((m) => m.includes("Starting process preview"))).toBe(
        true,
      );
      expect(messages.some((m) => m.includes("Preview running"))).toBe(true);
      expect(messages.some((m) => m.includes("Validation passed"))).toBe(true);
      expect(messages.some((m) => m.includes("Preview stopped"))).toBe(true);
    });
  },
);
