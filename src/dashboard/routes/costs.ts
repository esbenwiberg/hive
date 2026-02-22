import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import * as costQueries from "../../db/queries/costs.js";
import type { CostScope } from "../../db/queries/costs.js";
import * as repoAccessQueries from "../../db/queries/user-repo-access.js";
import type { BreakdownDimension, BreakdownRange, CostsPageData } from "../views/costs.js";
import { costsPage, costsBreakdownPartial } from "../views/costs.js";
import type { DateRange } from "../../db/queries/costs.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_DIMENSIONS = new Set<BreakdownDimension>(["user", "repo", "agent", "model"]);
const VALID_RANGES = new Set<BreakdownRange>(["today", "week", "month", "all"]);

function isValidDimension(value: unknown): value is BreakdownDimension {
  return typeof value === "string" && VALID_DIMENSIONS.has(value as BreakdownDimension);
}

function isValidRange(value: unknown): value is BreakdownRange {
  return typeof value === "string" && VALID_RANGES.has(value as BreakdownRange);
}

function rangeToDateRange(range: BreakdownRange): DateRange | undefined {
  const now = new Date();
  switch (range) {
    case "today": {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { from };
    }
    case "week": {
      const day = now.getUTCDay();
      const mondayOffset = day === 0 ? 6 : day - 1;
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));
      return { from };
    }
    case "month": {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { from };
    }
    case "all":
      return undefined;
  }
}

async function getCostScope(user: { id: number; role: string }): Promise<CostScope | undefined> {
  if (user.role === "admin") return undefined;
  const repoIds = await repoAccessQueries.listRepoIdsByUser(user.id);
  return { userId: user.id, repoIds };
}

function breakdownQuery(
  dimension: BreakdownDimension,
  dateRange?: DateRange,
  scope?: CostScope,
): Promise<costQueries.BreakdownRow[]> {
  switch (dimension) {
    case "user": return costQueries.getBreakdownByUser(dateRange, scope);
    case "repo": return costQueries.getBreakdownByRepo(dateRange, scope);
    case "agent": return costQueries.getBreakdownByAgent(dateRange, scope);
    case "model": return costQueries.getBreakdownByModel(dateRange, scope);
  }
}

// ── GET /costs ─ Full costs page ────────────────────────────────────────────

router.get("/costs", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const scope = await getCostScope(user);
    const defaultDimension: BreakdownDimension = user.role === "admin" ? "user" : "repo";

    const [todayTotal, monthTotal, allTimeTotal, breakdown, dailyBreakdown, monthlySummary] =
      await Promise.all([
        costQueries.getTodayTotalGlobal(scope),
        costQueries.getMonthTotal(scope),
        costQueries.getAllTimeTotal(scope),
        breakdownQuery(defaultDimension, undefined, scope),
        costQueries.getDailyBreakdown(30, undefined, scope),
        costQueries.getMonthlySummary(12, undefined, scope),
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
    const user = req.session.user!;
    const dimension = req.query.dimension;

    if (!isValidDimension(dimension)) {
      res.status(400).send("Invalid dimension. Must be one of: user, repo, agent, model");
      return;
    }

    const range: BreakdownRange = isValidRange(req.query.range) ? req.query.range : "all";
    const scope = await getCostScope(user);
    const dateRange = rangeToDateRange(range);
    const rows = await breakdownQuery(dimension, dateRange, scope);
    res.send(costsBreakdownPartial(rows, dimension, range, user.role === "admin"));
  } catch (err) {
    next(err);
  }
});

export default router;
