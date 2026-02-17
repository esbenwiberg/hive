import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as taskQueries from "../../db/queries/tasks.js";
import * as repoQueries from "../../db/queries/repos.js";
import type { TaskFilters } from "../../domain/types.js";
import {
  taskListPage,
  taskListPartial,
  taskDetailPanel,
} from "../views/tasks.js";

const router = Router();

// ── GET /tasks ─ Full task list page ────────────────────────────────────────

router.get("/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const repoId = req.query.repoId ? Number(req.query.repoId) : undefined;
    const search = req.query.search as string | undefined;

    const filters: TaskFilters = {};
    if (status) filters.status = status;
    if (repoId) filters.repoId = repoId;
    if (search) filters.search = search;

    const [{ tasks }, counts, repos] = await Promise.all([
      taskQueries.list(filters),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);

    if (req.headers["hx-request"]) {
      res.send(taskListPartial(tasks, counts, status));
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
    const status = req.query.status as string | undefined;
    const repoId = req.query.repoId ? Number(req.query.repoId) : undefined;
    const search = req.query.search as string | undefined;

    const filters: TaskFilters = {};
    if (status) filters.status = status;
    if (repoId) filters.repoId = repoId;
    if (search) filters.search = search;

    const [{ tasks }, counts] = await Promise.all([
      taskQueries.list(filters),
      taskQueries.countByStatus(),
    ]);

    res.send(taskListPartial(tasks, counts, status));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks ─ Create a new task ─────────────────────────────────────

router.post("/api/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, body, repoId, type, size } = req.body;
    const user = req.session.user!;

    await taskQueries.create({
      title,
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
