import os from "node:os";
import { execSync } from "node:child_process";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { resolveGitCredentials } from "../../execution/worktree.js";
import logger from "../../logger.js";
import type { SystemStats } from "../views/health.js";
import { healthPage, statsPartial, upgradeSuccess, upgradeError, diskScanPartial, diskCleanPartial, escapeHtml } from "../views/health.js";
import { scan, clean, validatePaths } from "../../execution/disk-cleaner.js";
import type { CleanResult } from "../../execution/disk-cleaner.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCpuPercent(): number {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }
  return Math.round(((totalTick - totalIdle) / totalTick) * 100);
}

function getDiskUsage(): { usedGB: number; totalGB: number } {
  try {
    // Works on Linux and macOS
    const output = execSync("df -k / | tail -1", { encoding: "utf-8" });
    const parts = output.trim().split(/\s+/);
    const totalKB = parseInt(parts[1], 10);
    const usedKB = parseInt(parts[2], 10);
    return {
      usedGB: usedKB / 1024 / 1024,
      totalGB: totalKB / 1024 / 1024,
    };
  } catch {
    return { usedGB: 0, totalGB: 0 };
  }
}

function getStats(): SystemStats {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const disk = getDiskUsage();

  return {
    cpuPercent: getCpuPercent(),
    memUsedMB: (totalMem - freeMem) / 1024 / 1024,
    memTotalMB: totalMem / 1024 / 1024,
    diskUsedGB: disk.usedGB,
    diskTotalGB: disk.totalGB,
    uptimeSeconds: os.uptime(),
    loadAvg: os.loadavg(),
  };
}

// ── GET /health ─ Full page ─────────────────────────────────────────────────

router.get("/health", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = getStats();
    res.send(healthPage(stats, req.session.user!));
  } catch (err) {
    next(err);
  }
});

// ── GET /health/stats ─ HTMX partial for auto-refresh ──────────────────────

router.get("/health/stats", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = getStats();
    res.send(statsPartial(stats));
  } catch (err) {
    next(err);
  }
});

// ── POST /health/disk-scan ─ Scan for orphan artefacts ───────────────────────

router.post("/health/disk-scan", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await scan();
    logger.info({ count: items.length }, "health: disk scan requested");
    res.send(diskScanPartial(items));
  } catch (err) {
    next(err);
  }
});

// ── POST /health/disk-clean ─ Delete selected artefacts ──────────────────────

router.post("/health/disk-clean", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Accept both a single string and an array of strings from form body
    const raw = req.body?.paths;
    const paths: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

    if (paths.length === 0) {
      res.status(400).send(`<div id="disk-clean-results" class="mt-4 p-4 rounded bg-yellow-50 border border-yellow-200 text-yellow-800">No paths selected for deletion.</div>`);
      return;
    }

    // Validate all paths first – return 400 without deleting anything if any path is invalid
    try {
      await validatePaths(paths);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.warn({ paths, msg }, "health: disk-clean rejected due to path validation failure");
      res.status(400).send(`<div id="disk-clean-results" class="mt-4 p-4 rounded bg-red-50 border border-red-200 text-red-800"><strong>Invalid path rejected:</strong> ${escapeHtml(msg)}</div>`);
      return;
    }

    const result = await clean(paths);
    logger.info({ removedCount: result.removedCount, freedBytes: result.freedBytes }, "health: disk clean complete");
    res.send(diskCleanPartial(result));
  } catch (err) {
    next(err);
  }
});

// ── POST /upgrade/trigger ─ Deploy via GitHub Actions ──────────────────────

router.post("/upgrade/trigger", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repo = process.env.HIVE_SELF_REPO;
    if (!repo) {
      res.send(upgradeError("HIVE_SELF_REPO env var not configured"));
      return;
    }

    const userId = req.session.user!.id;
    const creds = await resolveGitCredentials(userId, "github");

    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (response.status === 204) {
      logger.info({ repo, userId }, "Upgrade workflow dispatched");
      res.send(upgradeSuccess());
    } else {
      const body = await response.text();
      logger.warn({ repo, status: response.status, body }, "Upgrade dispatch failed");
      res.send(upgradeError(`GitHub returned ${response.status}`));
    }
  } catch (err) {
    next(err);
  }
});

export default router;
