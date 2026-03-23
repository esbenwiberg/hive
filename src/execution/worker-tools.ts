import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { BuildSystemInfo } from "./build-system.js";
import { execInGroup, getNodeHeapLimitMB } from "./exec-group.js";

export interface PrismConfig {
  apiUrl: string;
  apiKey?: string;
  repoSlug: string;
}

const MAX_FILE_SIZE = 512 * 1024; // 512 KB
const CMD_TIMEOUT_MS = 120_000;
const CMD_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_CMD_OUTPUT_CHARS = 100_000; // ~25k tokens — prevents a single command from blowing the context

// Generated / lock files that should never be read — they waste context and
// can blow past API token limits (a single package-lock.json can be 200k+ tokens).
const EXCLUDED_FILE_PATTERNS = [
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)Cargo\.lock$/,
  /(?:^|\/)Gemfile\.lock$/,
  /(?:^|\/)composer\.lock$/,
  /(?:^|\/)Pipfile\.lock$/,
  /(?:^|\/)poetry\.lock$/,
  /(?:^|\/)packages\.lock\.json$/,
  /\.min\.[jt]sx?$/,
  /\.min\.css$/,
  /\.(?:js|css)\.map$/,
  /(?:^|\/)node_modules\//,
];

function isExcludedFile(filePath: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some(re => re.test(filePath));
}

// ── Path safety ─────────────────────────────────────────────────────────────

/**
 * Resolves `filePath` relative to `worktreePath` and ensures it stays within
 * the worktree root. Throws on traversal attempts.
 */
export function safePath(worktreePath: string, filePath: string): string {
  const resolved = resolve(worktreePath, filePath);
  const rel = relative(worktreePath, resolved);
  if (rel.startsWith("..") || resolve(resolved) !== resolved && rel.startsWith("/")) {
    throw new Error(`Path escapes worktree: ${filePath}`);
  }
  // Extra guard: resolved must start with the worktree root
  if (!resolved.startsWith(worktreePath)) {
    throw new Error(`Path escapes worktree: ${filePath}`);
  }
  return resolved;
}

// ── Tool definitions ────────────────────────────────────────────────────────

const SEARCH_CODEBASE_TOOL: Tool = {
  name: "search_codebase",
  description:
    "Semantically search the codebase index for files and symbols relevant to a query. " +
    "Returns ranked file paths and summaries without reading file contents — use this to " +
    "identify which files to read rather than browsing directories blindly.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of what you are looking for, e.g. 'session handling middleware' or 'database connection pooling'",
      },
    },
    required: ["query"],
  },
};

export const WORKER_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file relative to the working directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file relative to the working directory. Creates parent directories if needed. For small edits to existing files, prefer edit_file instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        content: { type: "string", description: "The full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Make a targeted edit to an existing file by replacing a specific string. Much more efficient than write_file for small changes — you only need to provide the changed portion, not the entire file. The old_string must match exactly (including whitespace/indentation). If old_string appears multiple times, the first occurrence is replaced.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        old_string: { type: "string", description: "The exact text to find and replace (must match file content exactly, including indentation)" },
        new_string: { type: "string", description: "The replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories. Directories have a trailing /.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory (default: '.')" },
      },
    },
  },
  {
    name: "grep_files",
    description: "Search for a pattern across files in the working directory. Returns matching lines with file paths and line numbers. Use this to discover naming conventions, find usages, locate implementations, or understand patterns before writing code.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for (e.g. 'public.*OrderId', 'class.*Service', 'import.*from')" },
        file_type: { type: "string", description: "Optional file extension filter without dot (e.g. 'cs', 'ts', 'py'). Omit to search all files." },
        max_results: { type: "number", description: "Maximum number of matching lines to return (default: 50, max: 200)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description: "Run a command in the working directory. Use for build, test, lint, git, etc. " +
      "Commands are executed directly (not through a shell) — do NOT use shell syntax like " +
      "pipes (|), redirections (>, 2>&1), chaining (&&, ||, ;), or globs (*). " +
      "If you need shell features, use command: 'bash' with args: ['-c', 'your command here'].",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The executable to run (e.g. 'npm', 'dotnet', 'git')" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments (e.g. ['run', 'build']). Do not include shell syntax like 2>&1 or |.",
        },
      },
      required: ["command"],
    },
  },
];

/** Tool for submitting structured review results instead of free-form JSON text. */
const SUBMIT_REVIEW_TOOL: Tool = {
  name: "submit_review",
  description:
    "Submit your final code review result. You MUST call this tool exactly once as the last action " +
    "of your review. Do NOT output the review as raw JSON text — always use this tool.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "rework"],
        description: "pass = changes are correct & secure; rework = issues found that need fixing",
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "major", "minor", "info"] },
            file: { type: "string", description: "File path (relative)" },
            line: { type: "number", description: "Line number (optional)" },
            message: { type: "string", description: "Description of the issue" },
            category: {
              type: "string",
              enum: ["correctness", "style", "performance", "maintainability", "documentation", "security"],
            },
          },
          required: ["severity", "file", "message", "category"],
        },
        description: "List of code review findings",
      },
      securityFindings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            type: { type: "string", enum: ["xss", "injection", "auth", "secrets", "deserialization", "other"] },
            description: { type: "string" },
            file: { type: "string" },
            advisory: { type: "boolean", description: "True if this is an advisory observation, not a concrete vulnerability" },
          },
          required: ["severity", "type", "description"],
        },
        description: "Security-specific findings",
      },
      verification: {
        type: "object",
        properties: {
          testsRun: { type: "boolean" },
          testsPassed: { type: "boolean" },
          lintClean: { type: "boolean" },
          buildSucceeded: { type: "boolean" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["testsRun", "testsPassed", "lintClean", "buildSucceeded", "notes"],
        description: "Build/test verification status",
      },
    },
    required: ["verdict", "findings", "securityFindings", "verification"],
  },
};

/** Read-only subset of worker tools for the review gate, plus submit_review. */
export const REVIEW_TOOLS: Tool[] = [
  ...WORKER_TOOLS.filter(t => t.name === "read_file" || t.name === "list_directory"),
  SUBMIT_REVIEW_TOOL,
];

/**
 * Returns the worker tool list, including `search_codebase` when prism is configured.
 */
export function getWorkerTools(prismConfig?: PrismConfig): Tool[] {
  if (prismConfig) {
    return [...WORKER_TOOLS, SEARCH_CODEBASE_TOOL];
  }
  return WORKER_TOOLS;
}

// ── Tool executor ───────────────────────────────────────────────────────────

/**
 * Creates a tool executor bound to a specific worktree path.
 * Returns a callback suitable for `AgenticRequest.executeTool`.
 */
export function createWorktreeToolExecutor(
  worktreePath: string,
  prismConfig?: PrismConfig,
  buildInfo?: BuildSystemInfo,
  options?: { readOnly?: boolean; onSubmitReview?: (data: Record<string, unknown>) => void },
): (name: string, input: Record<string, unknown>) => Promise<string> {
  const readOnly = options?.readOnly ?? false;
  return async (name: string, input: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "read_file": {
        const rawPath = input.path as string;
        if (isExcludedFile(rawPath)) {
          throw new Error(
            `${rawPath} is a generated/lock file and should not be read — it would waste context. ` +
            `Use package.json or similar source files instead.`,
          );
        }
        const filePath = safePath(worktreePath, rawPath);
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          throw new Error(`File too large (${stats.size} bytes, limit ${MAX_FILE_SIZE}). Read a smaller portion or a different file.`);
        }
        return await readFile(filePath, "utf-8");
      }

      case "write_file": {
        if (readOnly) throw new Error("write_file is not available in read-only mode");
        const filePath = safePath(worktreePath, input.path as string);
        const dir = resolve(filePath, "..");
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, input.content as string, "utf-8");
        return `Wrote ${filePath}`;
      }

      case "edit_file": {
        if (readOnly) throw new Error("edit_file is not available in read-only mode");
        const filePath = safePath(worktreePath, input.path as string);
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const content = await readFile(filePath, "utf-8");
        const idx = content.indexOf(oldStr);
        if (idx === -1) {
          throw new Error(`old_string not found in ${input.path as string}. Make sure the string matches exactly, including whitespace and indentation.`);
        }
        const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        await writeFile(filePath, updated, "utf-8");
        return `Edited ${input.path as string} (replaced ${oldStr.length} chars with ${newStr.length} chars)`;
      }

      case "list_directory": {
        const dirPath = safePath(worktreePath, (input.path as string) ?? ".");
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");
      }

      case "run_command": {
        if (readOnly) throw new Error("run_command is not available in read-only mode");
        const command = input.command as string;

        // Claude sometimes sends args as a single string instead of an array;
        // coerce gracefully so execFile doesn't throw a confusing type error.
        let args: string[];
        if (Array.isArray(input.args)) {
          args = input.args as string[];
        } else if (typeof input.args === "string") {
          // Try JSON parse first (Claude sometimes sends '["run", "build"]' as a string)
          const raw = (input.args as string).trim();
          if (raw.startsWith("[")) {
            try {
              const parsed = JSON.parse(raw) as unknown;
              args = Array.isArray(parsed) ? (parsed as string[]).map(String) : raw.split(/\s+/).filter(Boolean);
            } catch {
              args = raw.split(/\s+/).filter(Boolean);
            }
          } else {
            args = raw.split(/\s+/).filter(Boolean);
          }
        } else {
          args = [];
        }

        // `cd` is a shell builtin, not an executable — execFile can't run it.
        // The cwd for npm/dotnet is auto-resolved, so `cd` is never needed.
        if (command === "cd") {
          throw new Error(
            "`cd` is not supported — it is a shell builtin. " +
            "npm/npx commands automatically run in the correct directory. " +
            "For other tools, use `bash -c 'cd <dir> && <command>'`.",
          );
        }

        // Block commands that could revert changes or break the worktree.
        // Check both direct git commands and shell-wrapped variants (bash -c "git checkout ...")
        const fullCmd = [command, ...args].join(" ");
        const dangerous = [
          /\bgit\s+(checkout|restore|reset|clean|stash)/,
          /\bgit\s+.*--\s/,  // git <cmd> -- <path> (selective restore)
        ];
        if (dangerous.some((re) => re.test(fullCmd))) {
          throw new Error(`Blocked: git state commands are not allowed (they could revert your changes)`);
        }

        // Block reading excluded files via git (e.g. git show HEAD:package-lock.json)
        if (/\bgit\b/.test(fullCmd)) {
          for (const arg of args) {
            const colonIdx = arg.indexOf(":");
            if (colonIdx > 0) {
              const blobPath = arg.slice(colonIdx + 1);
              if (blobPath && isExcludedFile(blobPath)) {
                throw new Error(`Blocked: ${blobPath} is a generated/lock file and should not be read`);
              }
            }
          }
        }

        // Auto-resolve cwd for npm/dotnet commands when package.json or .sln
        // lives in a subdirectory (mirrors quickVerify behaviour).
        let cwd = worktreePath;
        if (buildInfo) {
          if ((command === "npm" || command === "npx") && buildInfo.npmDir) {
            cwd = buildInfo.npmDir;
          } else if (command === "dotnet" && buildInfo.dotnetDir) {
            cwd = buildInfo.dotnetDir;
          }
        }

        // Strip shell metacharacters that Claude sometimes includes.
        // execFile doesn't interpret shell syntax, so these would be passed
        // literally to the binary (e.g. "2>&1" becomes an ESLint file pattern).
        const shellTokens = /^[|;&]|^[12]?>>?|^2>&1$|^<<|^\|\|$|^&&$/;
        args = args.filter(a => !shellTokens.test(a));

        // Strip NODE_ENV=production (set for the Hive container) so that
        // target-repo npm installs include devDependencies (build tools,
        // postinstall helpers like patch-package, etc.).
        // Set CI=true so tools like vitest/jest disable interactive/watch mode.
        const { NODE_ENV: _drop, ...cleanEnv } = process.env;
        cleanEnv.CI = "true";
        cleanEnv.NODE_OPTIONS = [cleanEnv.NODE_OPTIONS, `--max-old-space-size=${getNodeHeapLimitMB()}`].filter(Boolean).join(" ");

        const { stdout, stderr } = await execInGroup(command, args, {
          cwd,
          timeout: CMD_TIMEOUT_MS,
          maxBuffer: CMD_MAX_BUFFER,
          env: cleanEnv,
        });
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (!output) return "(no output)";
        if (output.length > MAX_CMD_OUTPUT_CHARS) {
          return output.slice(0, MAX_CMD_OUTPUT_CHARS) + "\n\n... (output truncated — exceeded 100 KB)";
        }
        return output;
      }

      case "grep_files": {
        const pattern = input.pattern as string;
        const fileType = input.file_type as string | undefined;
        const maxResults = Math.min(Math.max(1, (input.max_results as number) || 50), 200);

        const args = ["-rn", "--max-count=5"];
        if (fileType) {
          args.push(`--include=*.${fileType}`);
        }
        // Exclude common noise directories and generated files
        args.push(
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "--exclude-dir=dist",
          "--exclude-dir=build",
          "--exclude-dir=obj",
          "--exclude-dir=bin",
          "--exclude-dir=vendor",
          "--exclude-dir=__pycache__",
          "--exclude=*.min.js",
          "--exclude=*.min.css",
          "--exclude=*.map",
          "--exclude=package-lock.json",
          "--exclude=yarn.lock",
          "--exclude=pnpm-lock.yaml",
        );
        args.push("-E", pattern, ".");

        try {
          const { stdout, stderr } = await execInGroup("grep", args, {
            cwd: worktreePath,
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          const output = (stdout || stderr || "").trim();
          if (!output) return "No matches found.";
          const lines = output.split("\n");
          if (lines.length > maxResults) {
            return lines.slice(0, maxResults).join("\n") + `\n\n...(${lines.length - maxResults} more matches truncated)`;
          }
          return output;
        } catch (err) {
          // grep exits 1 when no matches — that's not an error
          const code = (err as { code?: number }).code;
          if (code === 1) return "No matches found.";
          throw err;
        }
      }

      case "search_codebase": {
        if (!prismConfig) {
          return "search_codebase is not available (Prism not configured).";
        }
        const query = input.query as string;
        const response = await fetch(
          `${prismConfig.apiUrl}/api/projects/${prismConfig.repoSlug}/search`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(prismConfig.apiKey ? { Authorization: `Bearer ${prismConfig.apiKey}` } : {}),
            },
            body: JSON.stringify({ query, maxResults: 10, maxSummaries: 0, maxFindings: 0 }),
          },
        );
        if (!response.ok) {
          return `search_codebase is unavailable (HTTP ${response.status}). Use list_directory and read_file to explore the codebase instead.`;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return "search_codebase is unavailable (index server returned non-JSON — likely an auth or config issue). Use list_directory and read_file to explore the codebase instead.";
        }
        const data = await response.json() as {
          relevantCode: Array<{
            filePath: string | null;
            symbolName: string | null;
            symbolKind: string | null;
            summary: string;
            score: number;
          }>;
        };
        if (data.relevantCode.length === 0) {
          return "No relevant code found for that query.";
        }
        return data.relevantCode
          .map((r, i) => {
            const symbol = r.symbolName ? ` — ${r.symbolName}${r.symbolKind ? ` (${r.symbolKind})` : ""}` : "";
            return `${i + 1}. ${r.filePath ?? "(unknown)"}${symbol}\n   ${r.summary} [score: ${r.score.toFixed(2)}]`;
          })
          .join("\n");
      }

      case "submit_review": {
        if (options?.onSubmitReview) {
          options.onSubmitReview(input);
        }
        return "Review submitted successfully.";
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}
