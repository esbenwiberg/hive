import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { create } from "../db/queries/tasks.js";
import { isDuplicate } from "./base.js";
import type { Producer, ProducerContext, ProducerResult } from "./base.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCE = "producer:doc-auditor";
const TASK_TYPE = "documentation";

/** File extensions considered documentation. */
const DOC_EXTENSIONS = new Set([".md", ".rst", ".txt", ".adoc"]);

/** Directories to skip when scanning. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  ".turbo", "__pycache__", ".venv", "vendor",
]);

/** Regex to detect markdown/rst references to file paths. */
const CODE_REF_RE = /`([a-zA-Z0-9_/.-]+\.[a-zA-Z]+)`/g;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively collects all file paths in a directory (bounded depth).
 */
function collectFiles(dir: string, maxDepth = 3, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(full);
    } else if (entry.isDirectory()) {
      files.push(...collectFiles(full, maxDepth, depth + 1));
    }
  }
  return files;
}

/**
 * Collects doc files from a directory (1-level recursion).
 */
function collectDocFiles(dir: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && isDocFile(entry.name)) {
      files.push(full);
    } else if (entry.isDirectory()) {
      try {
        const subEntries = readdirSync(full, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile() && isDocFile(sub.name)) {
            files.push(join(full, sub.name));
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return files;
}

function isDocFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return DOC_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// ── Checks ───────────────────────────────────────────────────────────────────

interface Finding {
  title: string;
  description: string;
}

/**
 * Check 1: Staleness — docs reference files/functions that no longer exist.
 */
function checkBrokenReferences(
  repoDir: string,
  docFiles: string[],
): Finding[] {
  const findings: Finding[] = [];

  for (const docPath of docFiles) {
    let content: string;
    try {
      content = readFileSync(docPath, "utf-8");
    } catch {
      continue;
    }

    const brokenRefs: string[] = [];
    let match;
    while ((match = CODE_REF_RE.exec(content)) !== null) {
      const ref = match[1];
      // Only check paths that look like project files (have a directory component)
      if (!ref.includes("/")) continue;
      // Skip URLs and obvious non-paths
      if (ref.startsWith("http") || ref.startsWith("//")) continue;
      const resolved = join(repoDir, ref);
      if (!existsSync(resolved)) {
        brokenRefs.push(ref);
      }
    }

    if (brokenRefs.length > 0) {
      const rel = relative(repoDir, docPath);
      findings.push({
        title: `Broken references in ${rel}`,
        description: [
          `The documentation file \`${rel}\` references ${brokenRefs.length} path(s) that no longer exist:`,
          "",
          ...brokenRefs.slice(0, 10).map((r) => `- \`${r}\``),
          ...(brokenRefs.length > 10 ? [`- ... and ${brokenRefs.length - 10} more`] : []),
          "",
          "These references should be updated or removed.",
        ].join("\n"),
      });
    }
  }

  return findings;
}

/**
 * Check 2: Coverage gaps — docs/internal/ exists but is missing expected sections.
 */
function checkCoverageGaps(repoDir: string): Finding[] {
  const findings: Finding[] = [];
  const internalDir = join(repoDir, "docs/internal");

  if (!existsSync(internalDir)) {
    // If source dirs like src/enrichers or src/agents exist, docs/internal/ probably should too
    const hasSrcDirs = ["src/enrichers", "src/agents", "src/producers"].some(
      (d) => existsSync(join(repoDir, d)),
    );
    if (hasSrcDirs) {
      findings.push({
        title: "Missing docs/internal/ directory",
        description: [
          "This repository has source directories (enrichers, agents, or producers)",
          "but no `docs/internal/` directory for developer documentation.",
          "",
          "Consider creating `docs/internal/` with architecture and module documentation.",
        ].join("\n"),
      });
    }
    return findings;
  }

  const docFiles = collectDocFiles(internalDir);
  if (docFiles.length === 0) {
    findings.push({
      title: "Empty docs/internal/ directory",
      description:
        "The `docs/internal/` directory exists but contains no documentation files. " +
        "Add developer documentation covering architecture, module guides, and conventions.",
    });
  }

  return findings;
}

/**
 * Check 3: External doc freshness — if docs/external/ has API docs, check if
 * API-related source files are newer than the docs.
 */
function checkExternalDocFreshness(repoDir: string): Finding[] {
  const findings: Finding[] = [];
  const externalDir = join(repoDir, "docs/external");

  if (!existsSync(externalDir)) return findings;

  const docFiles = collectDocFiles(externalDir);
  if (docFiles.length === 0) return findings;

  // Find the oldest doc mtime
  let oldestDocMtime = Infinity;
  for (const f of docFiles) {
    try {
      const s = statSync(f);
      if (s.mtimeMs < oldestDocMtime) oldestDocMtime = s.mtimeMs;
    } catch {
      continue;
    }
  }
  if (oldestDocMtime === Infinity) return findings;

  // Check if any API-related source files are newer than the oldest doc
  const apiPatterns = ["routes", "api", "router", "controller", "endpoint"];
  const srcDir = join(repoDir, "src");
  if (!existsSync(srcDir)) return findings;

  const sourceFiles = collectFiles(srcDir, 2);
  const staleSourceFiles: string[] = [];

  for (const sf of sourceFiles) {
    const name = sf.toLowerCase();
    if (!apiPatterns.some((p) => name.includes(p))) continue;
    try {
      const s = statSync(sf);
      if (s.mtimeMs > oldestDocMtime) {
        staleSourceFiles.push(relative(repoDir, sf));
      }
    } catch {
      continue;
    }
  }

  if (staleSourceFiles.length > 0) {
    findings.push({
      title: "External docs may be outdated",
      description: [
        `${staleSourceFiles.length} API-related source file(s) have been modified more recently than external docs:`,
        "",
        ...staleSourceFiles.slice(0, 10).map((f) => `- \`${f}\``),
        ...(staleSourceFiles.length > 10 ? [`- ... and ${staleSourceFiles.length - 10} more`] : []),
        "",
        "Review `docs/external/` to ensure API documentation is up to date.",
      ].join("\n"),
    });
  }

  return findings;
}

// ── Producer ─────────────────────────────────────────────────────────────────

export class DocAuditorProducer implements Producer {
  name = "doc-auditor";
  needsRepo = true;

  async run(ctx: ProducerContext): Promise<ProducerResult> {
    const result: ProducerResult = {
      tasksCreated: 0,
      duplicatesSkipped: 0,
      errors: [],
      costUsd: 0, // No Claude calls
    };

    if (!ctx.repoDir || !existsSync(ctx.repoDir)) {
      result.errors.push(
        `Repo directory not available for ${ctx.repoFullName}, skipping`,
      );
      return result;
    }

    // Collect all doc files for broken-reference checking
    const allDocFiles: string[] = [];
    for (const dir of ["docs/internal", "docs/external", "docs", "doc"]) {
      const full = join(ctx.repoDir, dir);
      if (existsSync(full)) {
        allDocFiles.push(...collectDocFiles(full));
      }
    }
    // Also check root-level docs
    const rootDocs = ["README.md", "CONTRIBUTING.md", "ARCHITECTURE.md"];
    for (const f of rootDocs) {
      const full = join(ctx.repoDir, f);
      if (existsSync(full)) allDocFiles.push(full);
    }

    // Deduplicate by full path
    const uniqueDocFiles = [...new Set(allDocFiles)];

    // Run all checks
    const findings: Finding[] = [
      ...checkBrokenReferences(ctx.repoDir, uniqueDocFiles),
      ...checkCoverageGaps(ctx.repoDir),
      ...checkExternalDocFreshness(ctx.repoDir),
    ];

    // Create tasks for findings
    for (const finding of findings) {
      try {
        if (await isDuplicate(SOURCE, finding.title)) {
          result.duplicatesSkipped++;
          continue;
        }

        if (!ctx.dryRun) {
          await create({
            title: finding.title,
            body: finding.description,
            source: SOURCE,
            type: TASK_TYPE,
            repoId: ctx.repoId,
            createdBy: ctx.createdBy,
          });
        }

        result.tasksCreated++;
      } catch (err) {
        result.errors.push(
          `Failed to create doc task "${finding.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}

export const docAuditor = new DocAuditorProducer();
export default docAuditor;
