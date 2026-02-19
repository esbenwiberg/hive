import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import { db } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";
import { notInArray, eq, desc } from "drizzle-orm";
import { workflowPage, pipelinePartial } from "../views/workflow.js";

const router = Router();

const TERMINAL_STATUSES = ["done", "merged", "failed", "rejected", "cancelled"];

// ── GET /workflow ─ Full workflow page ────────────────────────────────────────

router.get("/workflow", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;

    const activeTasks = await db
      .select()
      .from(tasks)
      .where(notInArray(tasks.status, TERMINAL_STATUSES))
      .orderBy(desc(tasks.createdAt));

    res.send(workflowPage(activeTasks, user));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/workflow/pipeline ─ HTMX partial for pipeline status ────────────

router.get("/api/workflow/pipeline", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.query.taskId as string | undefined;

    if (!taskId) {
      res.send(pipelinePartial(null));
      return;
    }

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    res.send(pipelinePartial(task?.status ?? null, taskId, task?.title));
  } catch (err) {
    next(err);
  }
});

export default router;
