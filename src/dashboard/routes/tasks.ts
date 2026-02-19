import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as taskQueries from "../../db/queries/tasks.js";
import * as repoQueries from "../../db/queries/repos.js";
import { recordDecision } from "../../db/queries/gate-decisions.js";
import type { TaskFilters } from "../../domain/types.js";
import { isValidTaskType, isValidTaskSize, TaskStatus } from "../../domain/types.js";
import { canTransition } from "../../domain/state-machine.js";
import {
  taskListPage,
  taskListPartial,
  taskDetailPanel,
  previewSection,
  activityEventList,
} from "../views/tasks.js";
import { getEvents } from "../../db/queries/task-events.js";
import { previewManager } from "../../execution/preview/manager.js";
import { cleanupWorktree } from "../../execution/worktree.js";
import logger from "../../logger.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const ATTENTION_STATUSES = ["ready", "reviewing", "done", "failed"];

function parseTaskFilters(query: Request["query"]): TaskFilters {
  const filters: TaskFilters = {};
  const status = query.status as string | undefined;
  if (status === "attention") {
    filters.statuses = ATTENTION_STATUSES;
  } else if (status) {
    filters.status = status;
  }
  if (query.repoId) filters.repoId = Number(query.repoId);
  if (query.search) filters.search = query.search as string;
  return filters;
}

// ── GET /tasks ─ Full task list page ────────────────────────────────────────

router.get("/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Default to "attention" view when no status specified
    if (!req.query.status) {
      req.query.status = "attention";
    }
    const filters = parseTaskFilters(req.query);
    const activeStatus = (req.query.status as string) || "";

    const [{ tasks }, counts, repos] = await Promise.all([
      taskQueries.list(filters),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);

    const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));

    if (req.headers["hx-request"]) {
      res.send(taskListPartial(tasks, counts, activeStatus, repoNames));
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
    const activeStatus = (req.query.status as string) || "";

    const [{ tasks }, counts, repos] = await Promise.all([
      taskQueries.list(filters),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);
    const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));

    res.send(taskListPartial(tasks, counts, activeStatus, repoNames));
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

    const trimmedBody = typeof body === "string" ? body.trim() : "";
    if (trimmedBody.length > 10000) {
      res.status(400).send("Description must be 10,000 characters or fewer");
      return;
    }

    await taskQueries.create({
      title: title.trim(),
      body: trimmedBody,
      source: "user",
      type: type || undefined,
      size: size || undefined,
      repoId: Number(repoId),
      createdBy: user.id,
    });

    // Return updated task list
    const [{ tasks }, counts, allRepos] = await Promise.all([
      taskQueries.list(),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);
    const repoNames = new Map(allRepos.map((r) => [r.id, r.fullName]));

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Task created", type: "success" } }),
    );
    res.send(taskListPartial(tasks, counts, undefined, repoNames));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tasks/:id ─ Task detail panel ──────────────────────────────────

router.get("/api/tasks/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const [task, repos, events] = await Promise.all([
      taskQueries.getById(id),
      repoQueries.listAll(),
      getEvents(id, 50),
    ]);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));
    res.send(taskDetailPanel(task, repoNames, events));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tasks/:id/events ─ Activity log partial (HTMX auto-refresh) ────

router.get("/api/tasks/:id/events", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const events = await getEvents(id, limit);
    res.send(activityEventList(events));
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

    if (!targetStatus || typeof targetStatus !== "string") {
      res.status(400).send("targetStatus is required");
      return;
    }

    const ALL_STATUSES: Set<string> = new Set(Object.values(TaskStatus));
    if (!ALL_STATUSES.has(targetStatus)) {
      res.status(400).send("Invalid target status");
      return;
    }

    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    if (!canTransition(task.status, targetStatus)) {
      res.status(400).send(`Cannot transition from ${task.status} to ${targetStatus}`);
      return;
    }

    const updated = await taskQueries.updateStatus(id, targetStatus, user.id);

    // Record gate decision for approval/rejection/rework actions
    const GATE_STATUSES = new Set(["approved", "rejected", "rework"]);
    if (GATE_STATUSES.has(targetStatus)) {
      await recordDecision(id, targetStatus, "human", user.id);
    }

    // Return updated task list partial
    const [{ tasks }, counts, allRepos] = await Promise.all([
      taskQueries.list(),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);
    const repoNames = new Map(allRepos.map((r) => [r.id, r.fullName]));

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({
        showToast: {
          message: `Task moved to ${updated.status}`,
          type: "success",
        },
      }),
    );
    res.send(taskListPartial(tasks, counts, undefined, repoNames));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/:id/clarify ─ Submit clarification answers ───────────

router.post("/api/tasks/:id/clarify", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { answers } = req.body;

    // Validate answers payload
    if (!Array.isArray(answers) || answers.length === 0) {
      res.status(400).send("answers must be a non-empty array of strings");
      return;
    }

    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }

    // Task must be in "ready" status (paused for human clarification)
    if (task.status !== "ready") {
      res.status(400).send(`Task must be in 'ready' status to submit clarification (current: ${task.status})`);
      return;
    }

    // Validate that the task has clarification questions
    const enrichment = (task.enrichment ?? {}) as Record<string, unknown>;
    const architect = enrichment.architect as Record<string, unknown> | undefined;

    if (!architect?.clarificationQuestions || !Array.isArray(architect.clarificationQuestions)) {
      res.status(400).send("Task does not have pending clarification questions");
      return;
    }

    // Store answers in enrichment, clear awaitingInput
    const updatedArchitect = {
      ...architect,
      clarificationAnswers: answers.map(String),
      awaitingInput: false,
    };
    const updatedEnrichment = { ...enrichment, architect: updatedArchitect };
    await taskQueries.updateEnrichment(id, updatedEnrichment);

    // Transition task back to "enriching" (uses ready → enriching transition)
    const user = req.session.user!;
    await taskQueries.updateStatus(id, "enriching", user.id);

    logger.info({ taskId: id, answerCount: answers.length }, "Clarification answers submitted, task re-entering enrichment");

    // Return updated task list partial with toast
    const [{ tasks }, counts, allRepos] = await Promise.all([
      taskQueries.list(),
      taskQueries.countByStatus(),
      repoQueries.listAll(),
    ]);
    const repoNames = new Map(allRepos.map((r) => [r.id, r.fullName]));

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({
        showToast: {
          message: "Clarification answers submitted, task re-entering enrichment",
          type: "success",
        },
      }),
    );
    res.send(taskListPartial(tasks, counts, undefined, repoNames));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/:id/preview/stop ─ Stop preview ─────────────────────

router.post("/api/tasks/:id/preview/stop", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }

    const info = previewManager.getPreviewInfo(id);

    await previewManager.stopPreview(id);

    // Clean up worktree if we have path info
    if (info?.worktreePath) {
      try {
        // cleanupWorktree only uses .path — other fields are not needed for rm -rf
        await cleanupWorktree({ path: info.worktreePath, branch: "", repoFullName: "", provider: "", createdAt: new Date() });
      } catch (err) {
        logger.warn({ taskId: id, err }, "Failed to cleanup worktree after preview stop");
      }
    }

    // Refresh task from DB to get updated status
    const updated = await taskQueries.getById(id);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Preview stopped", type: "success" } }),
    );
    res.send(updated ? previewSection(updated) : "");
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/:id/preview/extend ─ Extend preview timeout ─────────

router.post("/api/tasks/:id/preview/extend", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }

    await previewManager.extendPreview(id);

    // Refresh task from DB
    const updated = await taskQueries.getById(id);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Preview lifetime extended", type: "success" } }),
    );
    res.send(updated ? previewSection(updated) : "");
  } catch (err) {
    next(err);
  }
});

export default router;
