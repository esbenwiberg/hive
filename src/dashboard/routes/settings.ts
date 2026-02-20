import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import {
  getAutonomousConfig,
  getConfigOverrides,
  saveConfigOverrides,
  type ConfigOverrides,
  type GateMode,
  type ClarificationConfig,
} from "../../domain/autonomous-config.js";
import * as repoQueries from "../../db/queries/repos.js";
import { create } from "../../db/queries/tasks.js";
import { isDuplicate } from "../../producers/base.js";
import type { SettingsTab } from "../views/settings.js";
import {
  settingsPage,
  settingsPanel,
  globalSettingsPartial,
  repoSettingsPartial,
  repoSettingsCard,
} from "../views/settings.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_TABS = new Set<SettingsTab>(["global", "repos"]);
const VALID_GATE_MODES = new Set(["ai", "human", "auto"]);
const VALID_CLARIFICATION_MODES = new Set(["human", "ai", "auto"]);

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

    let tabContent: string;
    if (tab === "global") {
      const config = getAutonomousConfig();
      const overrides = await getConfigOverrides();
      tabContent = globalSettingsPartial(config, overrides);
    } else {
      const repos = await repoQueries.listAll();
      tabContent = repoSettingsPartial(repos);
    }
    res.send(settingsPanel(tab, tabContent));
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

    // Validate clarification mode
    const clarificationMode = body.clarificationMode?.trim();
    if (clarificationMode && !VALID_CLARIFICATION_MODES.has(clarificationMode)) {
      res.status(400).send("Invalid clarification mode. Must be one of: human, ai, auto");
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

    if (clarificationMode) {
      overrides.clarification = { mode: clarificationMode as ClarificationConfig["mode"] };
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
    const ENRICHER_NAMES = ["codebase", "docs", "git-history", "dependencies", "architect", "scorer"];
    const enrichers: Record<string, { enabled: boolean }> = {};
    for (const name of ENRICHER_NAMES) {
      const enabledKey = `enricher_enabled_${name}_${repoId}`;
      enrichers[name] = { enabled: body[enabledKey] === "true" };
    }
    settings.enrichers = enrichers;

    // Documentation toggle
    const docsEnabledKey = `docs_enabled_${repoId}`;
    const docsEnabled = body[docsEnabledKey] === "true";
    settings.docs = { enabled: docsEnabled };

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

    // Preview deploy config
    const VALID_PREVIEW_TYPES = new Set(["compose", "testcontainers", "process"]);
    const previewTypeVal = body[`previewType_${repoId}`]?.trim();

    if (previewTypeVal && previewTypeVal !== "") {
      if (!VALID_PREVIEW_TYPES.has(previewTypeVal)) {
        res.status(400).send("Invalid preview type. Must be one of: compose, testcontainers, process");
        return;
      }
      preview.type = previewTypeVal;

      // Port — required when type is set
      const portVal = body[`previewPort_${repoId}`]?.trim();
      if (!portVal || portVal === "") {
        res.status(400).send("Port is required when preview type is set");
        return;
      }
      const portNum = Number(portVal);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        res.status(400).send("Port must be an integer between 1 and 65535");
        return;
      }
      preview.port = portNum;

      // Health check path — optional
      const healthVal = body[`previewHealthCheck_${repoId}`]?.trim();
      if (healthVal && healthVal !== "") {
        preview.health_check = healthVal;
      }

      // Startup timeout — optional, 1-600 seconds
      const startupVal = body[`previewStartupTimeout_${repoId}`]?.trim();
      if (startupVal && startupVal !== "") {
        const startupNum = Number(startupVal);
        if (!Number.isInteger(startupNum) || startupNum < 1 || startupNum > 600) {
          res.status(400).send("Startup timeout must be between 1 and 600 seconds");
          return;
        }
        preview.startup_timeout = startupNum;
      }

      // Compose-specific fields
      if (previewTypeVal === "compose") {
        const composeFile = body[`previewComposeFile_${repoId}`]?.trim();
        const appService = body[`previewAppService_${repoId}`]?.trim();
        if (!composeFile || composeFile === "") {
          res.status(400).send("Compose file is required for Docker Compose preview type");
          return;
        }
        if (!appService || appService === "") {
          res.status(400).send("App service name is required for Docker Compose preview type");
          return;
        }
        preview.compose_file = composeFile;
        preview.app_service = appService;
      }

      // Command-specific fields (testcontainers / process)
      if (previewTypeVal === "testcontainers" || previewTypeVal === "process") {
        const startCommand = body[`previewStartCommand_${repoId}`]?.trim();
        if (!startCommand || startCommand === "") {
          res.status(400).send("Start command is required for this preview type");
          return;
        }
        preview.start_command = startCommand;
      }

      // Environment variables — KEY=VALUE per line
      const envRaw = body[`previewEnv_${repoId}`]?.trim();
      if (envRaw && envRaw !== "") {
        const env: Record<string, string> = {};
        for (const line of envRaw.split("\n")) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) {
            res.status(400).send(`Invalid env var line: "${trimmed}". Expected KEY=VALUE format`);
            return;
          }
          env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
        if (Object.keys(env).length > 0) {
          preview.env = env;
        }
      }
    }

    if (Object.keys(preview).length > 0) {
      settings.preview = preview;
    }

    // If docs just got enabled, create a bootstrap task
    if (docsEnabled) {
      const currentRepo = await repoQueries.getById(repoId);
      const currentSettings = (currentRepo?.settings ?? {}) as Record<string, unknown>;
      const wasEnabled = (currentSettings.docs as Record<string, unknown> | undefined)?.enabled === true;

      if (!wasEnabled) {
        const bootstrapTitle = `Bootstrap documentation for ${currentRepo!.fullName}`;
        const bootstrapSource = "docs-bootstrap";

        if (!(await isDuplicate(bootstrapSource, bootstrapTitle))) {
          await create({
            title: bootstrapTitle,
            body: [
              "Scan the codebase and generate initial documentation:",
              "",
              "1. Create `docs/internal/` with:",
              "   - `architecture.md` — high-level system overview, key components, data flow",
              "   - `modules.md` — per-module guide for major source directories",
              "   - `conventions.md` — coding patterns, naming, error handling, testing approach",
              "",
              "2. If the repo has API routes (Express, REST, etc.), create `docs/external/` with:",
              "   - `api.md` — endpoint reference with methods, paths, request/response shapes",
              "",
              "Base everything on the actual source code. Keep docs concise and maintainable.",
            ].join("\n"),
            source: bootstrapSource,
            type: "documentation",
            repoId,
            createdBy: req.session.user!.id,
          });
        }
      }
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

// ── DELETE /settings/repos/:id ─ Delete a repo and all dependent data ──────

router.delete("/settings/repos/:id", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repoId = Number(req.params.id);
    if (Number.isNaN(repoId)) {
      res.status(400).send("Invalid repo id");
      return;
    }

    const deleted = await repoQueries.deleteById(repoId);
    if (!deleted) {
      res.status(404).send("Repo not found");
      return;
    }

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Repo deleted", type: "success" } }),
    );
    res.send("");
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
