import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import * as producerRunQueries from "../../db/queries/producer-runs.js";
import { getConfig, setConfig } from "../../domain/config.js";
import type { ProducerData, ProducersPageData } from "../views/producers.js";
import { producersPage } from "../views/producers.js";

const router = Router();

// ── Constants ────────────────────────────────────────────────────────────────

const PRODUCER_NAMES = [
  "bug-hunter",
  "feature-scout",
  "log-scanner",
  "security-scanner",
  "self-monitor",
];

// ── GET /producers ─ Full producers page ─────────────────────────────────────

router.get("/producers", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;

    const producers: ProducerData[] = await Promise.all(
      PRODUCER_NAMES.map(async (name) => {
        const runs = await producerRunQueries.listRecent(name);
        const schedule = (await getConfig(`producer.${name}.schedule`)) as string | null ?? null;
        return { name, runs, schedule };
      }),
    );

    const data: ProducersPageData = { producers };
    res.send(producersPage(data, user));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/producers/:name/trigger ─ Trigger a manual run (placeholder) ──

router.post("/api/producers/:name/trigger", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name);

    if (!PRODUCER_NAMES.includes(name)) {
      res.status(400).send("Unknown producer");
      return;
    }

    // Placeholder — actual trigger logic will be added later
    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: `Manual run queued for ${name}`, type: "success" } }),
    );
    res.send("");
  } catch (err) {
    next(err);
  }
});

// ── POST /api/producers/:name/config ─ Save producer target config ──────────

router.post("/api/producers/:name/config", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name);

    if (!PRODUCER_NAMES.includes(name)) {
      res.status(400).send("Unknown producer");
      return;
    }

    const body = req.body as Record<string, unknown>;
    await setConfig(`producer.${name}.config`, body);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: `Config saved for ${name}`, type: "success" } }),
    );
    res.send("");
  } catch (err) {
    next(err);
  }
});

export default router;
