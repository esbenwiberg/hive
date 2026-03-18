import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { getLearningById, listLearnings, getLearningStats, getLearningUsageStats, dismissLearning, applyWeeklyDecay, archiveStale, archiveNeverUsed, deepClean } from "../../db/queries/learnings.js";
import { getEventsForLearning, getEventCountsByType, getDailyEventVolume } from "../../db/queries/learning-events.js";
import { getConfig, setConfig } from "../../domain/config.js";
import { curateLearnings } from "../../agents/keeper.js";
import logger from "../../logger.js";
import type { RetrospectiveReport } from "../../agents/retrospective.js";
import type { HivemindPageData } from "../views/hivemind.js";
import {
  hivemindPage,
  learningsListPartial,
  learningDetailPartial,
} from "../views/hivemind.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

function parseIntOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseFloatOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const n = parseFloat(value);
  return Number.isNaN(n) ? undefined : n;
}

function parseStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

// ── GET /hivemind ─ Full page ───────────────────────────────────────────────

router.get("/hivemind", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;

    const [stats, { learnings, total }, latestReportRaw, usageRaw, eventsLast7d, eventsLast30d, dailyVolume] = await Promise.all([
      getLearningStats(),
      listLearnings({ limit: PAGE_SIZE, offset: 0 }),
      getConfig("lastRetrospectiveReport"),
      getLearningUsageStats(),
      getEventCountsByType(7),
      getEventCountsByType(30),
      getDailyEventVolume(30),
    ]);

    const latestReport = latestReportRaw
      ? (latestReportRaw as RetrospectiveReport)
      : null;

    const data: HivemindPageData = {
      stats,
      usageStats: {
        ...usageRaw,
        eventsLast7d,
        eventsLast30d,
        dailyVolume,
      },
      learnings,
      total,
      currentPage: 1,
      latestReport,
    };

    res.send(hivemindPage(data, user));
  } catch (err) {
    next(err);
  }
});

// ── GET /hivemind/learnings ─ HTMX partial for filtering/paging ─────────────

router.get("/hivemind/learnings", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseIntOrUndefined(req.query.page) ?? 1;
    const scope = parseStringOrUndefined(req.query.scope);
    const category = parseStringOrUndefined(req.query.category);
    const minConfidence = parseFloatOrUndefined(req.query.minConfidence);

    const offset = (page - 1) * PAGE_SIZE;

    const { learnings, total } = await listLearnings({
      scope,
      category,
      minConfidence,
      limit: PAGE_SIZE,
      offset,
    });

    res.send(learningsListPartial(learnings, total, page));
  } catch (err) {
    next(err);
  }
});

// ── GET /hivemind/learnings/:id ─ HTMX partial for learning detail ──────────

router.get("/hivemind/learnings/:id", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id)) {
      res.status(400).send("Invalid learning ID");
      return;
    }

    const [learning, events] = await Promise.all([
      getLearningById(id),
      getEventsForLearning(id),
    ]);

    if (!learning) {
      res.status(404).send("Learning not found");
      return;
    }

    res.send(learningDetailPartial(learning, events));
  } catch (err) {
    next(err);
  }
});

// ── POST /hivemind/learnings/:id/dismiss ─ Dismiss a learning ────────────────

router.post("/hivemind/learnings/:id/dismiss", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id)) {
      res.status(400).send("Invalid learning ID");
      return;
    }

    const user = req.session.user!;
    await dismissLearning(id, String(user.id));

    const [learning, events] = await Promise.all([
      getLearningById(id),
      getEventsForLearning(id),
    ]);

    if (!learning) {
      res.status(404).send("Learning not found");
      return;
    }

    res.set("HX-Trigger", JSON.stringify({ showToast: "Learning dismissed" }));
    res.send(learningDetailPartial(learning, events));
  } catch (err) {
    next(err);
  }
});

// ── POST /hivemind/curate ─ Force a full cleanup cycle ────────────────────────

router.post("/hivemind/curate", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info({ triggeredBy: req.session.user!.id }, "Hivemind: manual curation triggered");

    const decayed = await applyWeeklyDecay();
    await setConfig("lastDecayRun", new Date().toISOString());
    const archived = await archiveStale();
    const neverUsedArchived = await archiveNeverUsed(30);

    // Run the keeper agent for dedup/promotion (async, don't block the response)
    curateLearnings().catch((err) => {
      logger.error({ err }, "Hivemind: manual curation keeper failed");
    });

    logger.info({ decayed, archived, neverUsedArchived }, "Hivemind: manual decay + archival complete, keeper running async");

    res.set("HX-Trigger", JSON.stringify({
      showToast: `Cleanup done: ${decayed} decayed, ${archived + neverUsedArchived} archived. Keeper curation running in background.`,
    }));
    // Refresh the full learnings list
    const { learnings, total } = await listLearnings({ limit: PAGE_SIZE, offset: 0 });
    res.send(learningsListPartial(learnings, total, 1));
  } catch (err) {
    next(err);
  }
});

// ── POST /hivemind/deep-clean ─ Aggressive thorough cleanup ───────────────────

router.post("/hivemind/deep-clean", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info({ triggeredBy: req.session.user!.id }, "Hivemind: deep clean triggered");

    const result = await deepClean();
    const totalArchived = result.neverUsed + result.lowConfidence + result.dormant;

    // Still run keeper for dedup on whatever survives
    curateLearnings().catch((err) => {
      logger.error({ err }, "Hivemind: deep clean keeper failed");
    });

    logger.info(result, "Hivemind: deep clean complete, keeper running async");

    res.set("HX-Trigger", JSON.stringify({
      showToast: `Deep clean done: ${result.decayed} decayed (×0.90), ${totalArchived} archived (${result.neverUsed} never-used, ${result.lowConfidence} low-confidence, ${result.dormant} dormant). Keeper running.`,
    }));

    const { learnings, total } = await listLearnings({ limit: PAGE_SIZE, offset: 0 });
    res.send(learningsListPartial(learnings, total, 1));
  } catch (err) {
    next(err);
  }
});

export default router;
