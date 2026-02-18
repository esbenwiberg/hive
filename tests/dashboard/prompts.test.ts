import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import {
  listPromptFiles,
  readPrompt,
  writePrompt,
  validatePromptPath,
} from "../../src/prompts.js";
import { promptsPage, promptEditorPartial } from "../../src/dashboard/views/prompts.js";
import type { SessionUser } from "../../src/domain/types.js";
import type { PromptEntry } from "../../src/prompts.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const mockUser: SessionUser = {
  id: 1,
  entraOid: "oid-123",
  email: "alice@example.com",
  displayName: "Alice Admin",
  role: "admin",
};

// ── validatePromptPath ──────────────────────────────────────────────────────

describe("validatePromptPath", () => {
  it("accepts a valid .md path", () => {
    const result = validatePromptPath("flow.md");
    expect(result).toBe(path.resolve("prompts", "flow.md"));
  });

  it("accepts a nested .md path", () => {
    const result = validatePromptPath("enrichers/codebase.md");
    expect(result).toBe(path.resolve("prompts", "enrichers", "codebase.md"));
  });

  it("rejects path traversal with ../", () => {
    expect(() => validatePromptPath("../../etc/passwd")).toThrow("Path traversal detected");
  });

  it("rejects path traversal with absolute path component", () => {
    expect(() => validatePromptPath("../../../etc/shadow")).toThrow("Path traversal detected");
  });

  it("rejects path traversal that tries to escape via nested ../", () => {
    expect(() => validatePromptPath("enrichers/../../etc/passwd")).toThrow(
      "Path traversal detected",
    );
  });

  it("rejects non-.md files", () => {
    expect(() => validatePromptPath("script.sh")).toThrow("Only .md files are allowed");
  });

  it("rejects .txt files", () => {
    expect(() => validatePromptPath("notes.txt")).toThrow("Only .md files are allowed");
  });

  it("rejects files with no extension", () => {
    expect(() => validatePromptPath("README")).toThrow("Only .md files are allowed");
  });

  it("rejects path traversal even with .md extension", () => {
    expect(() => validatePromptPath("../../etc/passwd.md")).toThrow("Path traversal detected");
  });
});

// ── listPromptFiles ─────────────────────────────────────────────────────────

describe("listPromptFiles", () => {
  it("returns an array of entries", async () => {
    const files = await listPromptFiles();
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it("includes known prompt files", async () => {
    const files = await listPromptFiles();
    const paths = files.map((f) => f.path);
    expect(paths).toContain("flow.md");
    expect(paths).toContain("gate.md");
  });

  it("includes directories marked as isDir", async () => {
    const files = await listPromptFiles();
    const dirs = files.filter((f) => f.isDir);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.some((d) => d.name === "enrichers")).toBe(true);
  });

  it("includes nested files", async () => {
    const files = await listPromptFiles();
    const nested = files.filter((f) => f.path.includes("/") && !f.isDir);
    expect(nested.length).toBeGreaterThan(0);
  });

  it("only includes .md files (no other extensions)", async () => {
    const files = await listPromptFiles();
    const nonDirFiles = files.filter((f) => !f.isDir);
    for (const file of nonDirFiles) {
      expect(file.path).toMatch(/\.md$/);
    }
  });

  it("directories appear before their children", async () => {
    const files = await listPromptFiles();
    const enrichersIdx = files.findIndex((f) => f.path === "enrichers" && f.isDir);
    const firstChild = files.findIndex(
      (f) => f.path.startsWith("enrichers/") && !f.isDir,
    );
    if (enrichersIdx >= 0 && firstChild >= 0) {
      expect(enrichersIdx).toBeLessThan(firstChild);
    }
  });
});

// ── readPrompt ──────────────────────────────────────────────────────────────

describe("readPrompt", () => {
  it("reads content of an existing prompt file", async () => {
    const content = await readPrompt("flow.md");
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("rejects path traversal attempts", async () => {
    await expect(readPrompt("../../etc/passwd")).rejects.toThrow("Path traversal detected");
  });

  it("rejects non-.md files", async () => {
    await expect(readPrompt("script.sh")).rejects.toThrow("Only .md files are allowed");
  });
});

// ── writePrompt ─────────────────────────────────────────────────────────────

describe("writePrompt", () => {
  const testFile = "test-write-prompt.md";
  const testFilePath = path.resolve("prompts", testFile);

  afterAll(async () => {
    // Clean up test file
    try {
      await fs.unlink(testFilePath);
    } catch {
      // ignore if not created
    }
  });

  it("writes content to a .md file", async () => {
    await writePrompt(testFile, "# Test Prompt\n\nHello world.");
    const content = await fs.readFile(testFilePath, "utf-8");
    expect(content).toBe("# Test Prompt\n\nHello world.");
  });

  it("rejects path traversal attempts", async () => {
    await expect(writePrompt("../../etc/evil.md", "bad")).rejects.toThrow(
      "Path traversal detected",
    );
  });

  it("rejects non-.md files", async () => {
    await expect(writePrompt("config.yaml", "bad")).rejects.toThrow(
      "Only .md files are allowed",
    );
  });
});

// ── promptsPage ─────────────────────────────────────────────────────────────

describe("promptsPage", () => {
  const mockFiles: PromptEntry[] = [
    { path: "enrichers", name: "enrichers", isDir: true },
    { path: "enrichers/codebase.md", name: "codebase.md", isDir: false },
    { path: "flow.md", name: "flow.md", isDir: false },
    { path: "gate.md", name: "gate.md", isDir: false },
  ];

  it("returns valid HTML with doctype and closing tags", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("renders the page title", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain("Prompts");
  });

  it("renders user display name in the layout", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain("Alice Admin");
  });

  it("renders the file list with prompt file names", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain("flow.md");
    expect(html).toContain("gate.md");
    expect(html).toContain("codebase.md");
  });

  it("renders directory names", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain("enrichers");
  });

  it("renders the prompt-editor target div", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain('id="prompt-editor"');
  });

  it("renders htmx attributes for loading files", () => {
    const html = promptsPage(mockFiles, mockUser);
    expect(html).toContain('hx-get="/api/prompts/flow.md"');
    expect(html).toContain('hx-target="#prompt-editor"');
  });

  it("renders empty state when no files", () => {
    const html = promptsPage([], mockUser);
    expect(html).toContain("No prompt files found");
  });
});

// ── promptEditorPartial ─────────────────────────────────────────────────────

describe("promptEditorPartial", () => {
  it("renders the file path as heading", () => {
    const html = promptEditorPartial("flow.md", "# Flow\n\nContent here.");
    expect(html).toContain("flow.md");
  });

  it("renders a monospace textarea with the file content", () => {
    const html = promptEditorPartial("flow.md", "# Flow\n\nContent here.");
    expect(html).toContain("font-mono");
    expect(html).toContain("# Flow");
    expect(html).toContain("Content here.");
  });

  it("renders the save form with correct hx-post", () => {
    const html = promptEditorPartial("flow.md", "content");
    expect(html).toContain('hx-post="/api/prompts/flow.md"');
  });

  it("renders save button", () => {
    const html = promptEditorPartial("flow.md", "content");
    expect(html).toContain("Save");
  });

  it("escapes HTML entities in content", () => {
    const html = promptEditorPartial("test.md", "<script>alert('xss')</script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML entities in the path", () => {
    const html = promptEditorPartial("<img>.md", "content");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;.md");
  });

  it("renders nested paths correctly", () => {
    const html = promptEditorPartial("enrichers/codebase.md", "# Codebase");
    expect(html).toContain("enrichers/codebase.md");
    expect(html).toContain('hx-post="/api/prompts/enrichers/codebase.md"');
  });
});
