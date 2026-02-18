import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { parseHiveYaml } = await import("../../src/hive-yaml.js");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parseHiveYaml", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── compose type ─────────────────────────────────────────────────────────

  describe("compose preview type", () => {
    it("parses a valid compose config", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: compose
  compose_file: docker-compose.yml
  app_service: web
  port: 3000
  health_check: /health
  startup_timeout: 60
  env:
    NODE_ENV: production
    DEBUG: "true"
`);

      const result = parseHiveYaml("/tmp/worktree");

      expect(result).toEqual({
        type: "compose",
        compose_file: "docker-compose.yml",
        app_service: "web",
        port: 3000,
        health_check: "/health",
        startup_timeout: 60,
        env: { NODE_ENV: "production", DEBUG: "true" },
      });
    });

    it("returns null when compose_file is missing", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: compose
  app_service: web
  port: 3000
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });

    it("returns null when app_service is missing", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: compose
  compose_file: docker-compose.yml
  port: 3000
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });
  });

  // ── testcontainers type ──────────────────────────────────────────────────

  describe("testcontainers preview type", () => {
    it("parses a valid testcontainers config", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: testcontainers
  start_command: npm run test:integration
  port: 8080
  health_check: /api/ping
  startup_timeout: 120
`);

      const result = parseHiveYaml("/tmp/worktree");

      expect(result).toEqual({
        type: "testcontainers",
        start_command: "npm run test:integration",
        port: 8080,
        health_check: "/api/ping",
        startup_timeout: 120,
      });
    });

    it("returns null when start_command is missing", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: testcontainers
  port: 8080
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });
  });

  // ── process type ─────────────────────────────────────────────────────────

  describe("process preview type", () => {
    it("parses a valid process config", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: process
  start_command: npm start
  port: 4000
`);

      const result = parseHiveYaml("/tmp/worktree");

      expect(result).toEqual({
        type: "process",
        start_command: "npm start",
        port: 4000,
      });
    });

    it("parses process config with all optional fields", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: process
  start_command: python app.py
  port: 5000
  health_check: /ready
  startup_timeout: 30
  env:
    FLASK_ENV: testing
`);

      const result = parseHiveYaml("/tmp/worktree");

      expect(result).toEqual({
        type: "process",
        start_command: "python app.py",
        port: 5000,
        health_check: "/ready",
        startup_timeout: 30,
        env: { FLASK_ENV: "testing" },
      });
    });

    it("returns null when start_command is missing for process", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: process
  port: 4000
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });
  });

  // ── missing file ─────────────────────────────────────────────────────────

  describe("missing or invalid file", () => {
    it("returns null when file does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const result = parseHiveYaml("/tmp/nonexistent");
      expect(result).toBeNull();
    });

    it("returns null when file is invalid YAML", () => {
      mockReadFileSync.mockReturnValue("{{invalid yaml::");

      const result = parseHiveYaml("/tmp/worktree");
      // yaml package may parse this or throw; either way, no valid preview
      // The result should be null if no valid preview section found
      expect(result).toBeNull();
    });
  });

  // ── missing preview section ──────────────────────────────────────────────

  describe("missing preview section", () => {
    it("returns null when YAML has no preview key", () => {
      mockReadFileSync.mockReturnValue(`
name: my-project
version: 1.0.0
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });

    it("returns null when preview section has unknown type", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: kubernetes
  port: 3000
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });

    it("returns null when preview section has no type", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  port: 3000
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });

    it("returns null when preview section has no port", () => {
      mockReadFileSync.mockReturnValue(`
preview:
  type: process
  start_command: npm start
`);

      const result = parseHiveYaml("/tmp/worktree");
      expect(result).toBeNull();
    });
  });
});
