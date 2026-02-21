import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as taskQueries from "../../db/queries/tasks.js";
import * as repoAccessQueries from "../../db/queries/user-repo-access.js";
import { getTodayTotalGlobal, checkBudget } from "../../db/queries/costs.js";
import { db } from "../../db/connection.js";
import { activeAgents } from "../../db/schema.js";
import { dashboardPage, activeAgentsFragment } from "../views/dashboard.js";
import type { SessionUser } from "../../domain/types.js";

const router = Router();

async function getAccessibleRepoIds(user: SessionUser): Promise<number[] | undefined> {
  if (user.role === "admin") return undefined;
  return repoAccessQueries.listRepoIdsByUser(user.id);
}

// ── GET / ─ Dashboard overview ──────────────────────────────────────────────

router.get("/", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const accessibleRepoIds = await getAccessibleRepoIds(user);
    const userContext = { userId: user.id, role: user.role, accessibleRepoIds };

    const [counts, { tasks: recentTasks }, agents, todayCost, budgetRemaining] = await Promise.all([
      taskQueries.countByStatus(accessibleRepoIds),
      taskQueries.list({}, 10, undefined, userContext),
      db.select().from(activeAgents),
      getTodayTotalGlobal(),
      checkBudget(user.id),
    ]);

    res.send(dashboardPage(counts, recentTasks, agents, user, todayCost, accessibleRepoIds, budgetRemaining));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/agents ─ Active agents partial (HTMX polling) ──────────────────

router.get("/api/agents", requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const agents = await db.select().from(activeAgents);
    res.send(activeAgentsFragment(agents));
  } catch (err) {
    next(err);
  }
});

export default router;
