import os from "node:os";
import { execSync } from "node:child_process";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { resolveGitCredentials } from "../../execution/worktree.js";
import logger from "../../logger.js";
import type { SystemStats } from "../views/health.js";
import { healthPage, statsPartial, upgradeSuccess, upgradeError } from "../views/health.js";

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
