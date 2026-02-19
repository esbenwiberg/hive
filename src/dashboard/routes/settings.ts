import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import {
  getAutonomousConfig,
  getConfigOverrides,
  saveConfigOverrides,
  type ConfigOverrides,
  type GateMode,
} from "../../domain/autonomous-config.js";
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
    const overrides = tab === "global" ? await getConfigOverrides() : undefined;

    res.send(settingsPage(config, repos, user, tab, overrides));
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
      const overrides = await getConfigOverrides();
      res.send(globalSettingsPartial(config, overrides));
    } else {
      const repos = await repoQueries.listAll();
      res.send(repoSettingsPartial(repos));
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /settings/global ─ Update global config overrides ─────────────────

const VALID_TYPES = new Set(["bug", "feature", "security", "refactor", "improvement"]);
const VALID_SIZES = new Set(["trivial", "small", "medium", "large"]);

router.post("/settings/global", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, string>;

    // Validate classification
    const defaultType = body.defaultType?.trim();
    if (defaultType && !VALID_TYPES.has(defaultType)) {
      res.status(400).send("Invalid default type");
      return;
    }

    const defaultSize = body.defaultSize?.trim();
    if (defaultSize && !VALID_SIZES.has(defaultSize)) {
      res.status(400).send("Invalid default size");
      return;
    }

    // Validate gate mode
    const gateMode = body.gateMode?.trim();
    if (gateMode && !VALID_GATE_MODES.has(gateMode)) {
      res.status(400).send("Invalid gate mode. Must be one of: ai, human, auto");
      return;
    }

    // Validate budget
    const dailyDefault = body.dailyDefault?.trim();
    if (dailyDefault !== undefined && dailyDefault !== "") {
      const val = Number(dailyDefault);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Daily default must be a non-negative number");
        return;
      }
    }

    const perTaskMax = body.perTaskMax?.trim();
    if (perTaskMax !== undefined && perTaskMax !== "") {
      const val = Number(perTaskMax);
      if (Number.isNaN(val) || val < 0) {
        res.status(400).send("Per-task max must be a non-negative number");
        return;
      }
    }

    // Build overrides object
    const overrides: ConfigOverrides = {};

    if (defaultType || defaultSize) {
      overrides.classification = {};
      if (defaultType) overrides.classification.defaultType = defaultType;
      if (defaultSize) overrides.classification.defaultSize = defaultSize;
    }

    if (gateMode) {
      overrides.gate = { mode: gateMode as GateMode };
    }

    if ((dailyDefault !== undefined && dailyDefault !== "") ||
        (perTaskMax !== undefined && perTaskMax !== "")) {
      overrides.budget = {};
      if (dailyDefault !== undefined && dailyDefault !== "") {
        overrides.budget.dailyDefault = Number(dailyDefault);
      }
      if (perTaskMax !== undefined && perTaskMax !== "") {
        overrides.budget.perTaskMax = Number(perTaskMax);
      }
    }

    // Handle enricher toggles — look for enricher_* checkbox fields
    const config = getAutonomousConfig();
    if (config.enrichers.length > 0) {
      overrides.enrichers = config.enrichers.map((e) => ({
        name: e.name,
        enabled: body[`enricher_${e.name}`] === "true",
      }));
    }

    const updatedConfig = await saveConfigOverrides(overrides);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Global settings saved", type: "success" } }),
    );
    res.send(globalSettingsPartial(updatedConfig, overrides));
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

    // Producer toggles & config
    const PRODUCER_NAMES = ["log-scanner", "bug-hunter", "security-scanner", "feature-scout", "self-monitor"];
    const MAX_CONFIG_SIZE = 10 * 1024; // 10 KB

    const producers: Record<string, { enabled: boolean; config?: Record<string, unknown> }> = {};
    for (const name of PRODUCER_NAMES) {
      const enabledKey = `producer_enabled_${name}_${repoId}`;
      const configKey = `producer_config_${name}_${repoId}`;

      const enabled = body[enabledKey] === "true";
      const configRaw = body[configKey]?.trim();

      let config: Record<string, unknown> | undefined;
      if (configRaw && configRaw !== "") {
        if (configRaw.length > MAX_CONFIG_SIZE) {
          res.status(400).send(`Producer config for "${name}" exceeds 10 KB limit`);
          return;
        }
        try {
          const parsed = JSON.parse(configRaw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            res.status(400).send(`Producer config for "${name}" must be a JSON object`);
            return;
          }
          config = parsed as Record<string, unknown>;
        } catch {
          res.status(400).send(`Invalid JSON in producer config for "${name}"`);
          return;
        }
      }

      producers[name] = { enabled, ...(config ? { config } : {}) };
    }
    settings.producers = producers;

    // Enricher toggles
    const ENRICHER_NAMES = ["codebase", "docs", "git-history", "dependencies"];
    const enrichers: Record<string, { enabled: boolean }> = {};
    for (const name of ENRICHER_NAMES) {
      const enabledKey = `enricher_enabled_${name}_${repoId}`;
      enrichers[name] = { enabled: body[enabledKey] === "true" };
    }
    settings.enrichers = enrichers;

    // Preview settings
    const preview: Record<string, unknown> = {};
    const previewEnabledKey = `previewEnabled_${repoId}`;
    const previewEnabledVal = body[previewEnabledKey]?.trim();
    if (previewEnabledVal === "true") {
      preview.enabled = true;
    } else if (previewEnabledVal === "false") {
      preview.enabled = false;
    }
    // If empty/omitted, don't set — falls through to global default

    const previewTimeoutKey = `previewTimeout_${repoId}`;
    const previewTimeoutVal = body[previewTimeoutKey]?.trim();
    if (previewTimeoutVal && previewTimeoutVal !== "") {
      const val = Number(previewTimeoutVal);
      if (Number.isNaN(val) || val < 1 || val > 1440) {
        res.status(400).send("Preview timeout must be between 1 and 1440 minutes");
        return;
      }
      preview.cleanup_timeout_minutes = val;
    }

    if (Object.keys(preview).length > 0) {
      settings.preview = preview;
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
