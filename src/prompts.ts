import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromptEntry {
  path: string;
  name: string;
  isDir: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Absolute path to the prompts/ directory at the project root. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "..", "prompts");

const MAX_RECURSION_DEPTH = 10;

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
export async function listPromptFiles(dir: string = PROMPTS_DIR, prefix: string = "", depth: number = 0): Promise<PromptEntry[]> {
  if (depth > MAX_RECURSION_DEPTH) {
    return [];
  }

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
      const children = await listPromptFiles(path.join(dir, dirent.name), relativePath, depth + 1);
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
 * Checks for symlinks to prevent writing outside the prompts directory.
 */
export async function writePrompt(relativePath: string, content: string): Promise<void> {
  const resolved = validatePromptPath(relativePath);

  // Check if the target exists and is a symlink
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error("Symlinks are not allowed in prompts directory");
    }
  } catch (err: unknown) {
    // File doesn't exist yet — that's fine, but re-throw symlink errors
    if (err instanceof Error && err.message === "Symlinks are not allowed in prompts directory") {
      throw err;
    }
  }

  // Verify the real path is still within PROMPTS_DIR after resolving any parent symlinks
  const parentDir = path.dirname(resolved);
  try {
    const realParent = await fs.realpath(parentDir);
    if (!realParent.startsWith(PROMPTS_DIR + path.sep) && realParent !== PROMPTS_DIR) {
      throw new Error("Path traversal detected via symlink");
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("symlink")) {
      throw err;
    }
    if (err instanceof Error && err.message.includes("traversal")) {
      throw err;
    }
    // Parent directory doesn't exist yet — will fail at writeFile
  }

  await fs.writeFile(resolved, content, "utf-8");
}
