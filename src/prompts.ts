import path from "node:path";
import fs from "node:fs/promises";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromptEntry {
  path: string;
  name: string;
  isDir: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Absolute path to the prompts/ directory at the project root. */
const PROMPTS_DIR = path.resolve("prompts");

/**
 * Validates that a resolved path is within the prompts/ directory
 * and ends with `.md`. Throws on violations.
 */
export function validatePromptPath(relativePath: string): string {
  const resolved = path.resolve(PROMPTS_DIR, relativePath);

  // Path traversal guard
  if (!resolved.startsWith(PROMPTS_DIR + path.sep) && resolved !== PROMPTS_DIR) {
    throw new Error("Path traversal detected");
  }

  // Only allow .md files
  if (path.extname(resolved) !== ".md") {
    throw new Error("Only .md files are allowed");
  }

  return resolved;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Recursively reads the prompts/ directory and returns a flat list
 * of `{ path, name, isDir }` entries sorted with directories first.
 */
export async function listPromptFiles(dir: string = PROMPTS_DIR, prefix: string = ""): Promise<PromptEntry[]> {
  const entries: PromptEntry[] = [];

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }

  // Sort: directories first, then alphabetically
  dirents.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const dirent of dirents) {
    const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      entries.push({ path: relativePath, name: dirent.name, isDir: true });
      const children = await listPromptFiles(path.join(dir, dirent.name), relativePath);
      entries.push(...children);
    } else if (path.extname(dirent.name) === ".md") {
      entries.push({ path: relativePath, name: dirent.name, isDir: false });
    }
  }

  return entries;
}

/**
 * Reads and returns the content of a prompt file.
 * Validates that the path is within prompts/ and is a .md file.
 */
export async function readPrompt(relativePath: string): Promise<string> {
  const resolved = validatePromptPath(relativePath);
  return fs.readFile(resolved, "utf-8");
}

/**
 * Writes content to a prompt file.
 * Validates that the path is within prompts/ and is a .md file.
 */
export async function writePrompt(relativePath: string, content: string): Promise<void> {
  const resolved = validatePromptPath(relativePath);
  await fs.writeFile(resolved, content, "utf-8");
}
