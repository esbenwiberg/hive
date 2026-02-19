import { Router } from "express";
import type { Request, Response } from "express";
import { requireRole } from "../../auth/middleware.js";
import { logBuffer, type LogEntry } from "../../log-buffer.js";
import { logsPage } from "../views/logs.js";

const router = Router();

function matchesFilter(
  entry: LogEntry,
  filters: {
    levels?: Set<string>;
    component?: string;
    taskId?: string;
    search?: string;
  },
): boolean {
  if (filters.levels && filters.levels.size > 0 && !filters.levels.has(entry.levelLabel)) {
    return false;
  }
  if (filters.component && entry.component !== filters.component) {
    return false;
  }
  if (filters.taskId && entry.taskId !== filters.taskId) {
    return false;
  }
  if (filters.search && !entry.msg.toLowerCase().includes(filters.search.toLowerCase())) {
    return false;
  }
  return true;
}

// GET /logs — Render logs page
router.get("/logs", requireRole("admin"), (req: Request, res: Response) => {
  const user = req.session.user!;
  res.send(logsPage(user));
});

// GET /logs/stream — SSE endpoint
router.get("/logs/stream", requireRole("admin"), (req: Request, res: Response) => {
  const levelParam = req.query.level as string | undefined;
  const levels = levelParam
    ? new Set(levelParam.split(",").map((l) => l.trim()))
    : undefined;
  const component = (req.query.component as string | undefined)?.trim() || undefined;
  const taskId = (req.query.taskId as string | undefined)?.trim() || undefined;
  const search = (req.query.search as string | undefined)?.trim() || undefined;

  const filters = { levels, component, taskId, search };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Backfill recent entries
  const recent = logBuffer.getRecent();
  for (const entry of recent) {
    if (matchesFilter(entry, filters)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  }
  res.write("event: backfill-complete\ndata: {}\n\n");

  // Live listener
  const onLog = (entry: LogEntry) => {
    if (matchesFilter(entry, filters)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  };

  logBuffer.on("log", onLog);

  // 30s heartbeat to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30_000);

  // Cleanup on disconnect
  req.on("close", () => {
    logBuffer.off("log", onLog);
    clearInterval(heartbeat);
  });
});

export default router;
