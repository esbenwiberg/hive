import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative } from "node:path";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { BuildSystemInfo } from "./build-system.js";

const execFileAsync = promisify(execFile);

export interface PrismConfig {
  apiUrl: string;
  apiKey?: string;
  repoSlug: string;
}

const MAX_FILE_SIZE = 512 * 1024; // 512 KB
const CMD_TIMEOUT_MS = 120_000;
const CMD_MAX_BUFFER = 2 * 1024 * 1024;

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
    name: "run_command",
    description: "Run a shell command in the working directory. Use for build, test, lint, git, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command to run (e.g. 'npm')" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments (e.g. ['run', 'build'])",
        },
      },
      required: ["command"],
    },
  },
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
): (name: string, input: Record<string, unknown>) => Promise<string> {
  return async (name: string, input: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "read_file": {
        const filePath = safePath(worktreePath, input.path as string);
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          throw new Error(`File too large (${stats.size} bytes, limit ${MAX_FILE_SIZE})`);
        }
        return await readFile(filePath, "utf-8");
      }

      case "write_file": {
        const filePath = safePath(worktreePath, input.path as string);
        const dir = resolve(filePath, "..");
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, input.content as string, "utf-8");
        return `Wrote ${filePath}`;
      }

      case "edit_file": {
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

        // Strip NODE_ENV=production (set for the Hive container) so that
        // target-repo npm installs include devDependencies (build tools,
        // postinstall helpers like patch-package, etc.).
        const { NODE_ENV: _drop, ...cleanEnv } = process.env;

        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd,
          timeout: CMD_TIMEOUT_MS,
          maxBuffer: CMD_MAX_BUFFER,
          env: cleanEnv,
        });
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        return output || "(no output)";
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}
