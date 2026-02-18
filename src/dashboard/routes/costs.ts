import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as costQueries from "../../db/queries/costs.js";
import type { BreakdownDimension, CostsPageData } from "../views/costs.js";
import { costsPage, costsBreakdownPartial } from "../views/costs.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_DIMENSIONS = new Set<BreakdownDimension>(["user", "repo", "agent", "model"]);

function isValidDimension(value: unknown): value is BreakdownDimension {
  return typeof value === "string" && VALID_DIMENSIONS.has(value as BreakdownDimension);
}

const BREAKDOWN_QUERIES: Record<BreakdownDimension, () => Promise<costQueries.BreakdownRow[]>> = {
  user: () => costQueries.getBreakdownByUser(),
  repo: () => costQueries.getBreakdownByRepo(),
  agent: () => costQueries.getBreakdownByAgent(),
  model: () => costQueries.getBreakdownByModel(),
};

// ── GET /costs ─ Full costs page ────────────────────────────────────────────

router.get("/costs", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const defaultDimension: BreakdownDimension = "user";

    const [todayTotal, monthTotal, allTimeTotal, breakdown, dailyBreakdown, monthlySummary] =
      await Promise.all([
        costQueries.getTodayTotalGlobal(),
        costQueries.getMonthTotal(),
        costQueries.getAllTimeTotal(),
        BREAKDOWN_QUERIES[defaultDimension](),
        costQueries.getDailyBreakdown(),
        costQueries.getMonthlySummary(),
      ]);

    const data: CostsPageData = {
      todayTotal,
      monthTotal,
      allTimeTotal,
      breakdown,
      breakdownDimension: defaultDimension,
      dailyBreakdown,
      monthlySummary,
    };

    res.send(costsPage(data, user));
  } catch (err) {
    next(err);
  }
});

// ── GET /costs/breakdown ─ HTMX partial for dimension switching ─────────────

router.get("/costs/breakdown", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dimension = req.query.dimension;

    if (!isValidDimension(dimension)) {
      res.status(400).send("Invalid dimension. Must be one of: user, repo, agent, model");
      return;
    }

    const rows = await BREAKDOWN_QUERIES[dimension]();
    res.send(costsBreakdownPartial(rows, dimension));
  } catch (err) {
    next(err);
  }
});

export default router;
