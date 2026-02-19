import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative } from "node:path";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";

const execFileAsync = promisify(execFile);

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
    description: "Write content to a file relative to the working directory. Creates parent directories if needed.",
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

// ── Tool executor ───────────────────────────────────────────────────────────

/**
 * Creates a tool executor bound to a specific worktree path.
 * Returns a callback suitable for `AgenticRequest.executeTool`.
 */
export function createWorktreeToolExecutor(
  worktreePath: string,
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

      case "list_directory": {
        const dirPath = safePath(worktreePath, (input.path as string) ?? ".");
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");
      }

      case "run_command": {
        const command = input.command as string;
        const args = (input.args as string[] | undefined) ?? [];
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: worktreePath,
          timeout: CMD_TIMEOUT_MS,
          maxBuffer: CMD_MAX_BUFFER,
        });
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        return output || "(no output)";
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}
