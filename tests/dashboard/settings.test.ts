import { describe, it, expect } from "vitest";
import {
  settingsPage,
  globalSettingsPartial,
  repoSettingsPartial,
  repoSettingsCard,
} from "../../src/dashboard/views/settings.js";
import type { SettingsTab } from "../../src/dashboard/views/settings.js";
import type { AutonomousConfig } from "../../src/domain/autonomous-config.js";
import type { RepoRow } from "../../src/db/schema.js";
import type { SessionUser } from "../../src/domain/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const mockUser: SessionUser = {
  id: 1,
  entraOid: "oid-123",
  email: "alice@example.com",
  displayName: "Alice Admin",
  role: "admin",
};

const mockConfig: AutonomousConfig = {
  classification: { defaultType: "improvement", defaultSize: "medium" },
  gate: { mode: "human" },
  budget: { dailyDefault: 100, perTaskMax: 25 },
  models: {
    default: "claude-sonnet-4-20250514",
    components: {},
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [
    { name: "style-guide", enabled: true },
    { name: "codebase-context", enabled: false },
  ],
  clarification: { mode: "human" },
  preview: {
    enabled: true,
    max_concurrent: 3,
    cleanup_timeout_minutes: 30,
    docker_host: {
      ip: "",
      port: 2376,
      tls_cert_vault_secret: "docker-tls-cert",
      tls_key_vault_secret: "docker-tls-key",
      tls_ca_vault_secret: "docker-tls-ca",
    },
    port_range: [4001, 4099],
  },
  concurrency: { maxConcurrent: 5, maxPerUser: 2 },
  prism: { databaseUrl: "", embeddingProvider: "azure-openai", embeddingModel: "text-embedding-3-large" },
};

const mockRepos: RepoRow[] = [
  {
    id: 1,
    provider: "github",
    fullName: "acme/frontend",
    defaultBranch: "main",
    settings: { gateMode: "ai", perTaskMax: 10 },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-15"),
  },
  {
    id: 2,
    provider: "github",
    fullName: "acme/backend",
    defaultBranch: "develop",
    settings: {},
    createdAt: new Date("2026-01-02"),
    updatedAt: new Date("2026-01-16"),
  },
];

// ── settingsPage ────────────────────────────────────────────────────────────

describe("settingsPage", () => {
  it("returns valid HTML with doctype and closing tags", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("renders the page title", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain("Settings");
  });

  it("renders the user display name in the layout", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain("Alice Admin");
  });

  it("renders tab buttons for Global Defaults and Repos", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain("Global Defaults");
    expect(html).toContain("Repos");
  });

  it("renders global tab content by default", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain("autonomous.config.yaml");
    expect(html).toContain("Classification");
  });

  it("renders repos tab content when activeTab is repos", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser, "repos");
    expect(html).toContain("acme/frontend");
    expect(html).toContain("acme/backend");
  });

  it("renders the settings-content target div", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain('id="settings-content"');
  });

  it("renders htmx tab switching attributes", () => {
    const html = settingsPage(mockConfig, mockRepos, mockUser);
    expect(html).toContain('hx-get="/settings/tab?tab=global"');
    expect(html).toContain('hx-get="/settings/tab?tab=repos"');
    expect(html).toContain('hx-target="#settings-content"');
  });
});

// ── globalSettingsPartial ───────────────────────────────────────────────────

describe("globalSettingsPartial", () => {
  it("renders the overrides notice about autonomous.config.yaml", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("autonomous.config.yaml");
    expect(html).toContain("Overrides saved to database");
  });

  it("renders classification defaults", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("Default Type");
    expect(html).toContain("improvement");
    expect(html).toContain("Default Size");
    expect(html).toContain("medium");
  });

  it("renders gate mode", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("Gate");
    expect(html).toContain("human");
  });

  it("renders budget values in form inputs", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain('value="100"');
    expect(html).toContain('value="25"');
  });

  it("renders clarification mode select", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("Clarification");
    expect(html).toContain("clarificationMode");
  });

  it("renders Models card with default model and component inputs", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("Models");
    expect(html).toContain("defaultModel");
    expect(html).toContain("claude-sonnet-4-20250514");
    expect(html).toContain("inputCostPerM");
    expect(html).toContain("outputCostPerM");
    expect(html).toContain("Per-component overrides");
    expect(html).toContain("component_router");
    expect(html).toContain("component_worker");
    expect(html).toContain("component_gate");
  });

  it("renders Low/Medium/High tier buttons in the Models card", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("Low");
    expect(html).toContain("Medium");
    expect(html).toContain("High");
  });

  it("pre-fills component model overrides when present", () => {
    const configWithComponents = {
      ...mockConfig,
      models: {
        ...mockConfig.models,
        components: { router: "claude-haiku-4-5-20251001" },
      },
    };
    const html = globalSettingsPartial(configWithComponents);
    expect(html).toContain("claude-haiku-4-5-20251001");
  });
});

// ── repoSettingsPartial ─────────────────────────────────────────────────────

describe("repoSettingsPartial", () => {
  it("renders repo cards for each repo", () => {
    const html = repoSettingsPartial(mockRepos);
    expect(html).toContain("acme/frontend");
    expect(html).toContain("acme/backend");
  });

  it("renders empty state when no repos", () => {
    const html = repoSettingsPartial([]);
    expect(html).toContain("No repos configured yet");
  });

  it("renders the add repo form", () => {
    const html = repoSettingsPartial(mockRepos);
    expect(html).toContain("Add Repo");
    expect(html).toContain('hx-post="/settings/repos"');
    expect(html).toContain('hx-target="#repo-list"');
  });

  it("renders repo-list container div", () => {
    const html = repoSettingsPartial(mockRepos);
    expect(html).toContain('id="repo-list"');
  });

  it("renders per-repo override values", () => {
    const html = repoSettingsPartial(mockRepos);
    // The first repo has gateMode and perTaskMax overrides
    expect(html).toContain("gateMode");
    expect(html).toContain("ai");
    expect(html).toContain("perTaskMax");
    expect(html).toContain("10");
  });

  it("renders repo card for repo without overrides", () => {
    const html = repoSettingsPartial(mockRepos);
    // All repos get a full card with forms even without overrides
    expect(html).toContain("acme/backend");
    expect(html).toContain("develop");
  });
});

// ── repoSettingsCard ────────────────────────────────────────────────────────

describe("repoSettingsCard", () => {
  it("renders the repo card with correct id", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain('id="repo-card-1"');
  });

  it("renders the repo full name", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain("acme/frontend");
  });

  it("renders the default branch", () => {
    const html = repoSettingsCard(mockRepos[1]);
    expect(html).toContain("develop");
  });

  it("renders the hx-post for updating settings", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain('hx-post="/settings/repos/1"');
    expect(html).toContain(`hx-target="#repo-card-1"`);
  });

  it("renders form fields for gate mode, per-task max, daily budget", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain("Gate Mode");
    expect(html).toContain("Per-Task Budget");
    expect(html).toContain("Daily Budget");
  });

  it("renders save button", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain("Save");
  });

  it("renders producer toggles section with four per-repo producers", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain("Producers");
    expect(html).toContain("log-scanner");
    expect(html).toContain("bug-hunter");
    expect(html).toContain("security-scanner");
    expect(html).toContain("feature-scout");
    // self-monitor is a global producer, not per-repo
  });

  it("renders producer checkbox form fields with correct names", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain('name="producer_enabled_log-scanner_1"');
    expect(html).toContain('name="producer_enabled_bug-hunter_1"');
    expect(html).toContain('name="producer_config_bug-hunter_1"');
  });

  it("pre-checks enabled producers from settings", () => {
    const repoWithProducers: RepoRow = {
      ...mockRepos[0],
      settings: {
        producers: {
          "bug-hunter": { enabled: true, config: {} },
          "log-scanner": { enabled: false },
        },
      },
    };
    const html = repoSettingsCard(repoWithProducers);
    // bug-hunter should be checked
    expect(html).toContain('name="producer_enabled_bug-hunter_1" value="true" checked');
    // log-scanner should NOT be checked
    expect(html).not.toMatch(/name="producer_enabled_log-scanner_1" value="true" checked/);
  });

  it("renders producer config JSON in textarea when present", () => {
    const repoWithConfig: RepoRow = {
      ...mockRepos[0],
      settings: {
        producers: {
          "bug-hunter": { enabled: true, config: { severity: "high" } },
        },
      },
    };
    const html = repoSettingsCard(repoWithConfig);
    expect(html).toContain("severity");
    expect(html).toContain("high");
  });
});
