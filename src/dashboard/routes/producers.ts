import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import * as producerRunQueries from "../../db/queries/producer-runs.js";
import { listAll as listAllRepos } from "../../db/queries/repos.js";
import { getConfig, setConfig } from "../../domain/config.js";
import type { ProducerData, ProducersPageData } from "../views/producers.js";
import { producersPage, producerDetailPanel } from "../views/producers.js";

const router = Router();

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PRODUCER_INTERVAL_MS = 15 * 60 * 1_000;

/** Per-producer interval overrides (must match the `intervalMs` on the Producer class). */
const PRODUCER_INTERVAL_OVERRIDES: Record<string, number> = {
  "github-issues": 60_000,
};

const PRODUCER_NAMES = [
  "ado-work-items",
  "bug-hunter",
  "doc-auditor",
  "feature-scout",
  "github-issues",
  "log-scanner",
  "maintenance",
  "security-scanner",
  "self-monitor",
];

function formatIntervalMs(ms: number): string {
  if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `Every ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `Every ${hours}h ${rem}m` : `Every ${hours}h`;
}

// ── GET /producers ─ Full producers page ─────────────────────────────────────

router.get("/producers", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;

    const globalIntervalMs = parseInt(
      process.env.HIVE_PRODUCER_INTERVAL_MS ?? String(DEFAULT_PRODUCER_INTERVAL_MS),
      10,
    );

    // Fetch repos to determine which repos have each producer enabled
    const allRepos = await listAllRepos();

    const producers: ProducerData[] = await Promise.all(
      PRODUCER_NAMES.map(async (name) => {
        const runs = await producerRunQueries.listRecent(name);

        // Check for a config-stored interval override, then class-level, then global default
        const configInterval = await getConfig(`producer.${name}.intervalMs`);
        const effectiveInterval = (typeof configInterval === "number" && configInterval > 0)
          ? configInterval
          : PRODUCER_INTERVAL_OVERRIDES[name] ?? globalIntervalMs;
        const schedule = formatIntervalMs(effectiveInterval);

        // Collect repo names where this producer is enabled
        const enabledRepos: string[] = [];
        for (const repo of allRepos) {
          const settings = (repo.settings ?? {}) as Record<string, unknown>;
          const producersMap = (settings.producers ?? {}) as Record<string, { enabled?: boolean }>;
          if (producersMap[name]?.enabled === true) {
            enabledRepos.push(repo.fullName);
          }
        }

        return { name, runs, schedule, enabledRepos, intervalMs: effectiveInterval };
      }),
    );

    const data: ProducersPageData = { producers };
    res.send(producersPage(data, user));
  } catch (err) {
    next(err);
  }
});

// ── GET /producers/:name ─ Detail panel for a single producer ────────────────

router.get("/producers/:name", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name);

    if (!PRODUCER_NAMES.includes(name)) {
      res.status(404).send("Unknown producer");
      return;
    }

    const globalIntervalMs = parseInt(
      process.env.HIVE_PRODUCER_INTERVAL_MS ?? String(DEFAULT_PRODUCER_INTERVAL_MS),
      10,
    );

    const runs = await producerRunQueries.listRecent(name);

    const configInterval = await getConfig(`producer.${name}.intervalMs`);
    const effectiveInterval = (typeof configInterval === "number" && configInterval > 0)
      ? configInterval
      : PRODUCER_INTERVAL_OVERRIDES[name] ?? globalIntervalMs;
    const schedule = formatIntervalMs(effectiveInterval);

    const allRepos = await listAllRepos();
    const enabledRepos: string[] = [];
    for (const repo of allRepos) {
      const settings = (repo.settings ?? {}) as Record<string, unknown>;
      const producersMap = (settings.producers ?? {}) as Record<string, { enabled?: boolean }>;
      if (producersMap[name]?.enabled === true) {
        enabledRepos.push(repo.fullName);
      }
    }

    const producer: ProducerData = { name, runs, schedule, enabledRepos, intervalMs: effectiveInterval };
    res.send(producerDetailPanel(producer));
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
    const serialized = JSON.stringify(body);
    if (serialized.length > 10_240) {
      res.status(400).send("Config payload too large (max 10KB)");
      return;
    }
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

// ── POST /api/producers/:name/interval ─ Save producer poll interval ────────

const ALLOWED_INTERVALS = new Set([30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000]);

router.post("/api/producers/:name/interval", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name);

    if (!PRODUCER_NAMES.includes(name)) {
      res.status(400).send("Unknown producer");
      return;
    }

    const body = req.body as Record<string, unknown>;
    const intervalMs = parseInt(String(body.intervalMs), 10);

    if (!ALLOWED_INTERVALS.has(intervalMs)) {
      res.status(400).send("Invalid interval value");
      return;
    }

    await setConfig(`producer.${name}.intervalMs`, intervalMs);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: `Poll interval for ${name} set to ${formatIntervalMs(intervalMs)}. Takes effect on next daemon restart.`, type: "success" } }),
    );
    res.send("");
  } catch (err) {
    next(err);
  }
});

export default router;
