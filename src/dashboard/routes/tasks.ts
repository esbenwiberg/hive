import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as taskQueries from "../../db/queries/tasks.js";
import * as repoQueries from "../../db/queries/repos.js";
import { recordDecision } from "../../db/queries/gate-decisions.js";
import type { TaskFilters } from "../../domain/types.js";
import { isValidTaskType, isValidTaskSize } from "../../domain/types.js";
import {
  taskListPage,
  taskListPartial,
  taskDetailPanel,
} from "../views/tasks.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseTaskFilters(query: Request["query"]): TaskFilters {
  const filters: TaskFilters = {};
  if (query.status) filters.status = query.status as string;
  if (query.repoId) filters.repoId = Number(query.repoId);
  if (query.search) filters.search = query.search as string;
  return filters;
}

// ── GET /tasks ─ Full task list page ────────────────────────────────────────

router.get("/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = parseTaskFilters(req.query);

    const [{ tasks }, counts, repos] = await Promise.all([
      taskQueries.list(filters),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);

    if (req.headers["hx-request"]) {
      res.send(taskListPartial(tasks, counts, filters.status));
    } else {
      res.send(taskListPage(tasks, filters, counts, req.session.user!, repos));
    }
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tasks ─ HTMX partial for task list ────────────────────────────

router.get("/api/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = parseTaskFilters(req.query);

    const [{ tasks }, counts] = await Promise.all([
      taskQueries.list(filters),
      taskQueries.countByStatus(),
    ]);

    res.send(taskListPartial(tasks, counts, filters.status));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks ─ Create a new task ─────────────────────────────────────

router.post("/api/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, body, repoId, type, size } = req.body;
    const user = req.session.user!;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).send("Title is required");
      return;
    }
    if (title.length > 500) {
      res.status(400).send("Title must be 500 characters or fewer");
      return;
    }
    if (!repoId || isNaN(Number(repoId))) {
      res.status(400).send("A valid repository is required");
      return;
    }
    if (type && !isValidTaskType(type)) {
      res.status(400).send("Invalid task type");
      return;
    }
    if (size && !isValidTaskSize(size)) {
      res.status(400).send("Invalid task size");
      return;
    }

    await taskQueries.create({
      title: title.trim(),
      body: body || "",
      source: "user",
      type: type || undefined,
      size: size || undefined,
      repoId: Number(repoId),
      createdBy: user.id,
    });

    // Return updated task list
    const [{ tasks }, counts] = await Promise.all([
      taskQueries.list(),
      taskQueries.countByStatus(),
    ]);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Task created", type: "success" } }),
    );
    res.send(taskListPartial(tasks, counts));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tasks/:id ─ Task detail panel ──────────────────────────────────

router.get("/api/tasks/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    res.send(taskDetailPanel(task));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/:id/transition ─ Transition task status ─────────────────

router.post("/api/tasks/:id/transition", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { targetStatus } = req.body;
    const user = req.session.user!;

    const updated = await taskQueries.updateStatus(id, targetStatus, user.id);

    // Record gate decision for approval/rejection/rework actions
    const GATE_STATUSES = new Set(["approved", "rejected", "rework"]);
    if (GATE_STATUSES.has(targetStatus)) {
      await recordDecision(id, targetStatus, "human", user.id);
    }

    // Return updated task list partial
    const [{ tasks }, counts] = await Promise.all([
      taskQueries.list(),
      taskQueries.countByStatus(),
    ]);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({
        showToast: {
          message: `Task moved to ${updated.status}`,
          type: "success",
        },
      }),
    );
    res.send(taskListPartial(tasks, counts));
  } catch (err) {
    next(err);
  }
});

export default router;
