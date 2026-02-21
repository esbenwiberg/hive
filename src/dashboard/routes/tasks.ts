import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as taskQueries from "../../db/queries/tasks.js";
import * as repoQueries from "../../db/queries/repos.js";
import * as userQueries from "../../db/queries/users.js";
import { recordDecision } from "../../db/queries/gate-decisions.js";
import type { TaskFilters } from "../../domain/types.js";
import { isValidTaskType, isValidTaskSize, isValidVisibility, TaskStatus } from "../../domain/types.js";
import { canTransition } from "../../domain/state-machine.js";
import {
  taskListPage,
  taskListPartial,
  taskDetailPanel,
  previewSection,
  previewMetaRow,
  activityEventList,
  taskDebugPanel,
} from "../views/tasks.js";
import { getEvents } from "../../db/queries/task-events.js";
import { getLatestByTask as getLatestReview } from "../../db/queries/code-reviews.js";
import * as activeAgentQueries from "../../db/queries/active-agents.js";
import * as enrichmentRunQueries from "../../db/queries/enrichment-runs.js";
import * as costQueries from "../../db/queries/costs.js";
import { previewManager } from "../../execution/preview/manager.js";
import { cleanupWorktree } from "../../execution/worktree.js";
import * as repoAccessQueries from "../../db/queries/user-repo-access.js";
import type { SessionUser } from "../../domain/types.js";
import { db } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import logger from "../../logger.js";

const router = Router();

const HIVE_SELF_REPO = process.env.HIVE_SELF_REPO ?? "";

/**
 * Returns accessible repo IDs for a user.
 * Admins get undefined (no filter), others get their granted list.
 */
async function getAccessibleRepoIds(user: SessionUser): Promise<number[] | undefined> {
  if (user.role === "admin") return undefined;
  return repoAccessQueries.listRepoIdsByUser(user.id);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ATTENTION_STATUSES = ["ready", "reviewing", "done", "failed"];

async function fetchUserNames(): Promise<Map<number, string>> {
  const allUsers = await userQueries.listAll();
  return new Map(allUsers.map((u) => [u.id, u.displayName]));
}

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
    const user = req.session.user!;
    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };

    const [{ tasks }, counts, repos, userNames, budgetRemaining] = await Promise.all([
      taskQueries.listWithCosts(filters, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
      costQueries.checkBudget(user.id),
    ]);

    // Filter repos in create form to only accessible ones
    const filteredRepos = accessibleRepoIds
      ? repos.filter((r) => accessibleRepoIds.includes(r.id))
      : repos;
    const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));

    const isAdmin = user.role === "admin";
    if (req.headers["hx-request"]) {
      res.send(taskListPartial(tasks, counts, activeStatus, repoNames, userNames, isAdmin));
    } else {
      res.send(taskListPage(tasks, filters, counts, user, filteredRepos, userNames, HIVE_SELF_REPO, accessibleRepoIds, budgetRemaining));
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
    const user = req.session.user!;
    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };

    const [{ tasks }, counts, repos, userNames] = await Promise.all([
      taskQueries.listWithCosts(filters, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
    ]);
    const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));

    res.send(taskListPartial(tasks, counts, activeStatus, repoNames, userNames, user.role === "admin"));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks ─ Create a new task ─────────────────────────────────────

router.post("/api/tasks", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, body, repoId, type, size, visibility, skipPreview } = req.body;
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

    // Validate visibility if provided
    const resolvedVisibility = visibility === "private" ? "private" : "public";
    if (visibility && !isValidVisibility(resolvedVisibility)) {
      res.status(400).send("Invalid visibility value");
      return;
    }

    const trimmedBody = typeof body === "string" ? body.trim() : "";
    if (trimmedBody.length > 10000) {
      res.status(400).send("Description must be 10,000 characters or fewer");
      return;
    }

    // Repo access check for non-admins
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, Number(repoId));
      if (!canAccess) {
        res.status(404).send("Repository not found");
        return;
      }
    }

    // Admin-only self-repo check
    if (HIVE_SELF_REPO) {
      const repo = await repoQueries.getById(Number(repoId));
      if (repo && repo.fullName === HIVE_SELF_REPO && user.role !== "admin") {
        res.status(403).send("Only admins can create tasks for the Hive repository");
        return;
      }
    }

    // Budget guard — reject early if user has exhausted their daily budget
    const remaining = await costQueries.checkBudget(user.id);
    if (remaining <= 0) {
      res.status(429).setHeader(
        "HX-Trigger",
        JSON.stringify({
          showToast: {
            message: "Daily budget exhausted! Wait until tomorrow or lure an admin with beers to bump your limit.",
            type: "error",
          },
        }),
      );
      res.send("");
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
      visibility: resolvedVisibility,
      skipPreview: skipPreview === "true" || skipPreview === true,
    });

    // Return updated task list
    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };
    const [{ tasks }, counts, allRepos, userNames] = await Promise.all([
      taskQueries.listWithCosts({}, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
    ]);
    const repoNames = new Map(allRepos.map((r) => [r.id, r.fullName]));

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Task created", type: "success" } }),
    );
    res.send(taskListPartial(tasks, counts, undefined, repoNames, userNames, user.role === "admin"));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tasks/:id ─ Task detail panel ──────────────────────────────────

router.get("/api/tasks/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = req.session.user!;
    const [task, repos, events, latestReview, userNames] = await Promise.all([
      taskQueries.getByIdWithCost(id),
      repoQueries.listAll(),
      getEvents(id, 50),
      getLatestReview(id),
      fetchUserNames(),
    ]);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    // Repo access check
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
    }
    const repoNames = new Map(repos.map((r) => [r.id, r.fullName]));
    res.send(taskDetailPanel(task, repoNames, events, latestReview, userNames, user));
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

// ── GET /api/tasks/:id/debug ─ Debug panel partial (HTMX) ───────────────────

router.get("/api/tasks/:id/debug", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = req.session.user!;

    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
    }

    const [agent, enrichRuns, events, costBreakdown] = await Promise.all([
      activeAgentQueries.getByTaskId(id),
      enrichmentRunQueries.listByTask(id),
      getEvents(id, 20),
      costQueries.getBreakdownForTask(id),
    ]);

    res.send(taskDebugPanel(task, agent, enrichRuns, events, costBreakdown));
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
    // Repo access check
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
    }
    if (!canTransition(task.status, targetStatus)) {
      res.status(400).send(`Cannot transition from ${task.status} to ${targetStatus}`);
      return;
    }

    // Admin-only self-repo check for transitions
    if (HIVE_SELF_REPO && user.role !== "admin") {
      const repo = await repoQueries.getById(task.repoId);
      if (repo && repo.fullName === HIVE_SELF_REPO) {
        res.status(403).send("Only admins can action tasks for the Hive repository");
        return;
      }
    }

    const updated = await taskQueries.updateStatus(id, targetStatus, user.id);

    // Record gate decision for approval/rejection/rework actions
    const GATE_STATUSES = new Set(["approved", "rejected", "rework"]);
    if (GATE_STATUSES.has(targetStatus)) {
      await recordDecision(id, targetStatus, "human", user.id);
    }

    // Return updated task list partial
    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };
    const [{ tasks }, counts, allRepos, userNames] = await Promise.all([
      taskQueries.listWithCosts({}, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
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
    res.send(taskListPartial(tasks, counts, undefined, repoNames, userNames, user.role === "admin"));
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

    // Repo access check
    const user = req.session.user!;
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
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

    // Transition back to "pending" so the daemon picks it up and re-runs the pipeline
    await taskQueries.updateStatus(id, "pending", user.id);

    logger.info({ taskId: id, answerCount: answers.length }, "Clarification answers submitted, task re-entering enrichment");

    // Return updated task list partial with toast
    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };
    const [{ tasks }, counts, allRepos, userNames] = await Promise.all([
      taskQueries.listWithCosts({}, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
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
    res.send(taskListPartial(tasks, counts, undefined, repoNames, userNames, user.role === "admin"));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/:id/preview/stop ─ Stop preview ─────────────────────

router.post("/api/tasks/:id/preview/stop", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = req.session.user!;
    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
    }

    const info = previewManager.getPreviewInfo(id);

    await previewManager.stopPreview(id);

    // Clean up worktree if we have path info
    if (info?.worktreePath) {
      try {
        // cleanupWorktree only uses .path — other fields are not needed for rm -rf
        await cleanupWorktree({ path: info.worktreePath, branch: "", repoFullName: "", provider: "", createdAt: new Date(), baseSha: "" });
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
    const user = req.session.user!;
    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
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

// ── POST /api/tasks/:id/preview/toggle ─ Toggle skipPreview flag ─────────

const PRE_EXECUTION_STATES: Set<string> = new Set(["pending", "queued", "enriching", "ready"]);

router.post("/api/tasks/:id/preview/toggle", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const user = req.session.user!;
    const task = await taskQueries.getById(id);
    if (!task) {
      res.status(404).send("Task not found");
      return;
    }
    if (user.role !== "admin") {
      const canAccess = await repoAccessQueries.hasAccess(user.id, task.repoId);
      if (!canAccess) {
        res.status(404).send("Task not found");
        return;
      }
    }
    if (!PRE_EXECUTION_STATES.has(task.status)) {
      res.status(409).send("Preview can only be toggled before execution");
      return;
    }

    const newValue = !task.skipPreview;
    await db.update(tasks).set({ skipPreview: newValue, updatedAt: new Date() }).where(eq(tasks.id, id));

    const updated = await taskQueries.getById(id);
    const label = newValue ? "Preview disabled" : "Preview enabled";
    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: label, type: "success" } }),
    );
    res.send(updated ? previewMetaRow(updated) : "");
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/bulk-delete ─ Bulk delete tasks (admin-only) ─────────

router.post("/api/tasks/bulk-delete", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    if (user.role !== "admin") {
      res.status(403).send("Admin access required");
      return;
    }

    let ids: string[];
    try {
      ids = typeof req.body.ids === "string" ? JSON.parse(req.body.ids) : req.body.ids;
    } catch {
      res.status(400).send("Invalid ids");
      return;
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).send("ids must be a non-empty array");
      return;
    }

    const deleted = await taskQueries.deleteByIds(ids);

    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };
    const [{ tasks }, counts, allRepos, userNames] = await Promise.all([
      taskQueries.listWithCosts({}, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
    ]);
    const repoNames = new Map(allRepos.map((r) => [r.id, r.fullName]));

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: `Deleted ${deleted} task(s)`, type: "success" } }),
    );
    res.send(taskListPartial(tasks, counts, undefined, repoNames, userNames, true));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tasks/:id/reset ─ Reset task to pending (admin-only) ──────

router.post("/api/tasks/:id/reset", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    if (user.role !== "admin") {
      res.status(403).send("Admin access required");
      return;
    }

    const id = req.params.id as string;
    await taskQueries.resetTask(id);

    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };
    const [{ tasks }, counts, allRepos, userNames] = await Promise.all([
      taskQueries.listWithCosts({}, undefined, undefined, userContext),
      taskQueries.countByStatus(accessibleRepoIds),
      repoQueries.listAll(),
      fetchUserNames(),
    ]);
    const repoNames = new Map(allRepos.map((r) => [r.id, r.fullName]));

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Task reset to pending", type: "success" } }),
    );
    res.send(taskListPartial(tasks, counts, undefined, repoNames, userNames, true));
  } catch (err) {
    next(err);
  }
});

export default router;