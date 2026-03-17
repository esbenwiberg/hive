import { describe, it, expect } from "vitest";
import {
  producersPage,
  producerSummaryCard,
  producerDetailPanel,
  producerCardPartial,
} from "../../src/dashboard/views/producers.js";
import type {
  ProducerData,
  ProducerRun,
  ProducersPageData,
} from "../../src/dashboard/views/producers.js";
import type { SessionUser } from "../../src/domain/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const mockUser: SessionUser = {
  id: 1,
  entraOid: "oid-123",
  email: "alice@example.com",
  displayName: "Alice Admin",
  role: "admin",
};

const mockRun: ProducerRun = {
  id: 1,
  producer: "bug-hunter",
  repo: "acme/frontend",
  tasksCreated: 5,
  duplicatesSkipped: 2,
  errors: [],
  costUsd: "0.1234",
  durationMs: 45000,
  createdAt: new Date("2026-02-18T10:30:00Z"),
};

const mockRunWithErrors: ProducerRun = {
  id: 2,
  producer: "bug-hunter",
  repo: "acme/frontend",
  tasksCreated: 3,
  duplicatesSkipped: 1,
  errors: ["timeout connecting to API"],
  costUsd: "0.0500",
  durationMs: 120000,
  createdAt: new Date("2026-02-17T08:15:00Z"),
};

const mockProducer: ProducerData = {
  name: "bug-hunter",
  runs: [mockRun, mockRunWithErrors],
  schedule: "every 6h",
  enabledRepos: ["acme/frontend", "acme/backend"],
  intervalMs: 900000,
};

const mockProducerNoRuns: ProducerData = {
  name: "feature-scout",
  runs: [],
  schedule: null,
  enabledRepos: [],
  intervalMs: 900000,
};

const mockPageData: ProducersPageData = {
  producers: [mockProducer, mockProducerNoRuns],
};

// ── producersPage ───────────────────────────────────────────────────────────

describe("producersPage", () => {
  it("returns valid HTML with doctype and closing tags", () => {
    const html = producersPage(mockPageData, mockUser);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("renders the page title", () => {
    const html = producersPage(mockPageData, mockUser);
    expect(html).toContain("Producers");
  });

  it("renders the page description", () => {
    const html = producersPage(mockPageData, mockUser);
    expect(html).toContain("Monitor producer health, schedules, and run history");
  });

  it("renders the user display name in the layout", () => {
    const html = producersPage(mockPageData, mockUser);
    expect(html).toContain("Alice Admin");
  });

  it("renders all producer names", () => {
    const html = producersPage(mockPageData, mockUser);
    expect(html).toContain("bug-hunter");
    expect(html).toContain("feature-scout");
  });

  it("renders empty state when no producers", () => {
    const emptyData: ProducersPageData = { producers: [] };
    const html = producersPage(emptyData, mockUser);
    expect(html).toContain("No producers configured");
  });

  it("renders a responsive card grid", () => {
    const html = producersPage(mockPageData, mockUser);
    expect(html).toContain("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3");
    expect(html).toContain('id="producer-grid"');
  });
});

// ── producerSummaryCard ─────────────────────────────────────────────────────

describe("producerSummaryCard", () => {
  it("renders the producer name", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain("bug-hunter");
  });

  it("renders health badge as Healthy when last run has no errors", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain("Healthy");
  });

  it("renders health badge as Errors when last run has errors", () => {
    const producerWithErrors: ProducerData = {
      name: "log-scanner",
      runs: [mockRunWithErrors],
      schedule: "daily",
      enabledRepos: [],
      intervalMs: 900000,
    };
    const html = producerSummaryCard(producerWithErrors);
    expect(html).toContain("Errors");
  });

  it("renders No runs badge when producer has no runs", () => {
    const html = producerSummaryCard(mockProducerNoRuns);
    expect(html).toContain("No runs");
  });

  it("renders schedule info", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain("every 6h");
  });

  it("renders dash when schedule is null", () => {
    const html = producerSummaryCard(mockProducerNoRuns);
    expect(html).toContain("\u2014");
  });

  it("renders repo count", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain("Repos");
    expect(html).toContain(">2<");
  });

  it("renders total tasks across runs", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain("Total Tasks");
    expect(html).toContain(">8<"); // 5 + 3
  });

  it("renders the card container with correct id", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain('id="producer-card-bug-hunter"');
  });

  it("has HTMX attributes for loading detail panel", () => {
    const html = producerSummaryCard(mockProducer);
    expect(html).toContain('hx-get="/producers/bug-hunter"');
    expect(html).toContain('hx-target="#detail-panel"');
  });

  it("shows Never for last run when no runs exist", () => {
    const html = producerSummaryCard(mockProducerNoRuns);
    expect(html).toContain("Never");
  });
});

// ── producerDetailPanel ─────────────────────────────────────────────────────

describe("producerDetailPanel", () => {
  it("renders the producer name in header", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("bug-hunter");
  });

  it("renders health and schedule badges in header", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("Healthy");
    expect(html).toContain("every 6h");
  });

  it("renders interval selector with current value selected", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("Poll interval");
    expect(html).toContain('value="900000" selected');
  });

  it("renders repo badges when repos are enabled", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("acme/frontend");
    expect(html).toContain("acme/backend");
  });

  it("renders 'No repos enabled' when enabledRepos is empty", () => {
    const html = producerDetailPanel(mockProducerNoRuns);
    expect(html).toContain("No repos enabled");
  });

  it("renders last run stat cards with correct values", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("Tasks Created");
    expect(html).toContain("5");
    expect(html).toContain("Duplicates Skipped");
    expect(html).toContain("2");
    expect(html).toContain("$0.1234");
    expect(html).toContain("45s");
  });

  it("renders last run timestamp", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("Last run:");
    expect(html).toContain("2026-02-18 10:30:00");
  });

  it("renders recent runs table", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("Recent Runs");
    expect(html).toContain("Time");
    expect(html).toContain("Tasks");
    expect(html).toContain("Dupes");
    expect(html).toContain("Cost");
    expect(html).toContain("Duration");
    expect(html).toContain("Status");
  });

  it("renders OK badge for runs without errors", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("OK");
  });

  it("renders error count badge for runs with errors", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("1 error");
  });

  it("renders empty state when producer has no runs", () => {
    const html = producerDetailPanel(mockProducerNoRuns);
    expect(html).toContain("No runs recorded yet");
  });

  it("renders close button", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("closePanel()");
  });

  it("renders as a slide-out panel", () => {
    const html = producerDetailPanel(mockProducer);
    expect(html).toContain("fixed inset-y-0 right-0");
    expect(html).toContain("w-[680px]");
  });

  it("formats duration correctly for longer runs", () => {
    const producerLongRun: ProducerData = {
      name: "security-scanner",
      runs: [{
        ...mockRun,
        durationMs: 125000, // 2m 5s
      }],
      schedule: null,
      enabledRepos: [],
      intervalMs: 900000,
    };
    const html = producerDetailPanel(producerLongRun);
    expect(html).toContain("2m 5s");
  });
});

// ── producerCardPartial (backward compat) ───────────────────────────────────

describe("producerCardPartial", () => {
  it("returns the same output as producerSummaryCard", () => {
    const partial = producerCardPartial(mockProducer);
    const summary = producerSummaryCard(mockProducer);
    expect(partial).toBe(summary);
  });
});
