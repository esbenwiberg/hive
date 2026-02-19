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
    router: "claude-sonnet-4-20250514",
    gate: "claude-sonnet-4-20250514",
    inputCostPerM: 3,
    outputCostPerM: 15,
  },
  enrichers: [
    { name: "style-guide", enabled: true },
    { name: "codebase-context", enabled: false },
  ],
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

  it("renders enrichers with checkbox toggles", () => {
    const html = globalSettingsPartial(mockConfig);
    expect(html).toContain("style-guide");
    expect(html).toContain("codebase-context");
    expect(html).toContain('name="enricher_style-guide"');
    expect(html).toContain('name="enricher_codebase-context"');
    // style-guide is enabled, so its checkbox should be checked
    expect(html).toContain('name="enricher_style-guide" value="true" checked');
  });

  it("renders empty enrichers message when none configured", () => {
    const configNoEnrichers = { ...mockConfig, enrichers: [] };
    const html = globalSettingsPartial(configNoEnrichers);
    expect(html).toContain("No enrichers configured");
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

  it("renders 'using global defaults' for repo without overrides", () => {
    const html = repoSettingsPartial(mockRepos);
    expect(html).toContain("No per-repo overrides");
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
    expect(html).toContain("Gate Mode Override");
    expect(html).toContain("Per-Task Budget");
    expect(html).toContain("Daily Budget");
  });

  it("renders save button", () => {
    const html = repoSettingsCard(mockRepos[0]);
    expect(html).toContain("Save");
  });
});
