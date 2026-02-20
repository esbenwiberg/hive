import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { getPreviewInstances } from "../../db/queries/preview-instances.js";
import { previewManager } from "../../execution/preview/manager.js";
import { getAutonomousConfig } from "../../domain/autonomous-config.js";
import { instancesPage, instancesTablePartial } from "../views/instances.js";

const router = Router();

function getLiveMap() {
  return previewManager.getRunningPreviews();
}

// ── GET /instances ─ Full page ──────────────────────────────────────────────

router.get("/instances", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const instances = await getPreviewInstances();
    const liveMap = getLiveMap();
    const cfg = getAutonomousConfig().preview;
    res.send(instancesPage(instances, liveMap, cfg.max_concurrent, cfg.port_range, req.session.user!));
  } catch (err) {
    next(err);
  }
});

// ── GET /instances/partial ─ HTMX partial refresh ───────────────────────────

router.get("/instances/partial", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const instances = await getPreviewInstances();
    const liveMap = getLiveMap();
    res.send(instancesTablePartial(instances, liveMap));
  } catch (err) {
    next(err);
  }
});

// ── POST /instances/:taskId/stop ─ Stop a preview ──────────────────────────

router.post("/instances/:taskId/stop", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.taskId as string;
    await previewManager.stopPreview(taskId);
    const instances = await getPreviewInstances();
    const liveMap = getLiveMap();
    res.send(instancesTablePartial(instances, liveMap));
  } catch (err) {
    next(err);
  }
});

export default router;
