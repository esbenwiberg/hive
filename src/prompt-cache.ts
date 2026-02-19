import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── In-memory prompt cache with invalidation ────────────────────────────────

const cache = new Map<string, string>();

/**
 * Loads a prompt from prompts/{name}.md, caching the result.
 * Subsequent calls return the cached version until invalidated.
 */
export function loadPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const content = readFileSync(resolve("prompts", `${name}.md`), "utf-8");
  cache.set(name, content);
  return content;
}

/**
 * Invalidates a single cached prompt so the next loadPrompt() re-reads from disk.
 * Accepts either the cache key ("gate") or a file path ("gate.md", "enrichers/codebase.md").
 */
export function invalidatePrompt(nameOrPath: string): void {
  // Normalize: strip .md extension and any leading path separators
  const key = nameOrPath.replace(/\.md$/, "").replace(/\\/g, "/");
  cache.delete(key);
}

/**
 * Invalidates all cached prompts. Useful for bulk operations.
 */
export function invalidateAllPrompts(): void {
  cache.clear();
}
