import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { getAutonomousConfig } from "../../domain/autonomous-config.js";
import * as repoQueries from "../../db/queries/repos.js";
import type { SettingsTab } from "../views/settings.js";
import {
  settingsPage,
  globalSettingsPartial,
  repoSettingsPartial,
  repoSettingsCard,
} from "../views/settings.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_TABS = new Set<SettingsTab>(["global", "repos"]);
const VALID_GATE_MODES = new Set(["ai", "human", "auto"]);

function isValidTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && VALID_TABS.has(value as SettingsTab);
}

// ── GET /settings ─ Full settings page ──────────────────────────────────────

router.get("/settings", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const config = getAutonomousConfig();
    const repos = await repoQueries.listAll();
    const tab: SettingsTab = isValidTab(req.query.tab) ? req.query.tab : "global";

    res.send(settingsPage(config, repos, user, tab));
  } catch (err) {
    next(err);
  }
});

// ── GET /settings/tab ─ HTMX partial for tab switching ─────────────────────

router.get("/settings/tab", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tab = req.query.tab;

    if (!isValidTab(tab)) {
      res.status(400).send("Invalid tab. Must be one of: global, repos");
      return;
    }

    if (tab === "global") {
      const config = getAutonomousConfig();
      res.send(globalSettingsPartial(config));
    } else {
      const repos = await repoQueries.listAll();
      res.send(repoSettingsPartial(repos));
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /settings/repos/:id ─ Update per-repo settings ────────────────────

router.post("/settings/repos/:id", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repoId = Number(req.params.id);
    if (Number.isNaN(repoId)) {
      res.status(400).send("Invalid repo id");
      return;
    }

    // Build settings object from form fields, stripping empty strings
    const settings: Record<string, unknown> = {};
    const body = req.body as Record<string, string>;

    // Gate mode override
    const gateModeKey = `gateMode_${repoId}`;
    if (body[gateModeKey] && body[gateModeKey] !== "") {
      if (!VALID_GATE_MODES.has(body[gateModeKey])) {
        res.status(400).send("Invalid gateMode. Must be one of: ai, human, auto");
        return;
      }
      settings.gateMode = body[gateModeKey];
    }

    // Per-task budget
    const perTaskMaxKey = `perTaskMax_${repoId}`;
    if (body[perTaskMaxKey] && body[perTaskMaxKey] !== "") {
      const val = Number(body[perTaskMaxKey]);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Invalid perTaskMax. Must be a non-negative number");
        return;
      }
      settings.perTaskMax = val;
    }

    // Daily budget
    const dailyBudgetKey = `dailyBudget_${repoId}`;
    if (body[dailyBudgetKey] && body[dailyBudgetKey] !== "") {
      const val = Number(body[dailyBudgetKey]);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Invalid dailyBudget. Must be a non-negative number");
        return;
      }
      settings.dailyBudget = val;
    }

    const updated = await repoQueries.updateSettings(repoId, settings);
    if (!updated) {
      res.status(404).send("Repo not found");
      return;
    }

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Repo settings saved", type: "success" } }),
    );
    res.send(repoSettingsCard(updated));
  } catch (err) {
    next(err);
  }
});

// ── POST /settings/repos ─ Create a new repo ───────────────────────────────

router.post("/settings/repos", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, string>;
    const provider = body.provider?.trim();
    const fullName = body.fullName?.trim();
    const defaultBranch = body.defaultBranch?.trim() || undefined;

    if (!provider || !fullName) {
      res.status(400).send("Provider and full name are required");
      return;
    }

    const repo = await repoQueries.findOrCreate(provider, fullName, defaultBranch);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Repo added", type: "success" } }),
    );
    res.send(repoSettingsCard(repo));
  } catch (err) {
    next(err);
  }
});

export default router;
