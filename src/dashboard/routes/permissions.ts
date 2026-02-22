import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireRole } from "../../auth/middleware.js";
import { getAutonomousConfig } from "../../domain/autonomous-config.js";
import * as repoAccessQueries from "../../db/queries/user-repo-access.js";
import * as userQueries from "../../db/queries/users.js";
import * as repoQueries from "../../db/queries/repos.js";
import { permissionsPage, permissionsMatrix } from "../views/permissions.js";

const router = Router();

/** Build "userId:repoId" grant set from DB rows. */
async function buildGrantSet(): Promise<Set<string>> {
  const rows = await repoAccessQueries.listAll();
  return new Set(rows.map((r) => `${r.userId}:${r.repoId}`));
}

/** Render updated matrix partial (shared by grant/revoke/budget/max-concurrent handlers). */
async function renderMatrix(res: Response): Promise<void> {
  const [users, repos, grants] = await Promise.all([
    userQueries.listAllWithRole(),
    repoQueries.listAll(),
    buildGrantSet(),
  ]);
  const globalMaxPerUser = getAutonomousConfig().concurrency.maxPerUser;
  res.send(permissionsMatrix(users, repos, grants, globalMaxPerUser));
}

// ── GET /permissions ─ Admin permissions page ────────────────────────────────

router.get("/permissions", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const [users, repos, grants] = await Promise.all([
      userQueries.listAllWithRole(),
      repoQueries.listAll(),
      buildGrantSet(),
    ]);

    const globalMaxPerUser = getAutonomousConfig().concurrency.maxPerUser;
    res.send(permissionsPage(users, repos, grants, user, globalMaxPerUser));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/permissions/grant ─ Grant repo access ──────────────────────────

router.post("/api/permissions/grant", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, repoId } = req.body;
    const admin = req.session.user!;

    if (!userId || !repoId) {
      res.status(400).send("userId and repoId are required");
      return;
    }

    await repoAccessQueries.grant(Number(userId), Number(repoId), admin.id);

    await renderMatrix(res);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/permissions/revoke ─ Revoke repo access ────────────────────────

router.post("/api/permissions/revoke", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, repoId } = req.body;

    if (!userId || !repoId) {
      res.status(400).send("userId and repoId are required");
      return;
    }

    await repoAccessQueries.revoke(Number(userId), Number(repoId));

    await renderMatrix(res);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/permissions/budget ─ Update user daily budget ──────────────────

router.post("/api/permissions/budget", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, dailyBudget } = req.body;

    if (!userId || dailyBudget == null) {
      res.status(400).send("userId and dailyBudget are required");
      return;
    }

    const budget = parseFloat(dailyBudget);
    if (isNaN(budget) || budget < 0) {
      res.status(400).send("dailyBudget must be a non-negative number");
      return;
    }

    await userQueries.updateDailyBudget(Number(userId), budget.toFixed(2));

    await renderMatrix(res);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/permissions/max-concurrent ─ Update user max concurrent tasks ──

router.post("/api/permissions/max-concurrent", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, maxConcurrent } = req.body;

    if (!userId) {
      res.status(400).send("userId is required");
      return;
    }

    // Empty string means "clear override, use global default"
    if (maxConcurrent == null || maxConcurrent === "") {
      await userQueries.updateMaxConcurrent(Number(userId), null);
    } else {
      const val = parseInt(maxConcurrent, 10);
      if (isNaN(val) || val < 1 || val > 20) {
        res.status(400).send("maxConcurrent must be an integer between 1 and 20");
        return;
      }
      await userQueries.updateMaxConcurrent(Number(userId), val);
    }

    await renderMatrix(res);
  } catch (err) {
    next(err);
  }
});

export default router;
