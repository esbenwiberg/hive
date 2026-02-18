import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as taskQueries from "../../db/queries/tasks.js";
import { getTodayTotalGlobal } from "../../db/queries/costs.js";
import { db } from "../../db/connection.js";
import { activeAgents } from "../../db/schema.js";
import { dashboardPage } from "../views/dashboard.js";

const router = Router();

// ── GET / ─ Dashboard overview ──────────────────────────────────────────────

router.get("/", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;

    const [counts, { tasks: recentTasks }, agents, todayCost] = await Promise.all([
      taskQueries.countByStatus(),
      taskQueries.list({}, 10),
      db.select().from(activeAgents),
      getTodayTotalGlobal(),
    ]);

    res.send(dashboardPage(counts, recentTasks, agents, user, todayCost));
  } catch (err) {
    next(err);
  }
});

export default router;
