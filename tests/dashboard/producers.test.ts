import { describe, it, expect } from "vitest";
import {
  producersPage,
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
};

const mockProducerNoRuns: ProducerData = {
  name: "feature-scout",
  runs: [],
  schedule: null,
  enabledRepos: [],
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
});

// ── producerCardPartial ─────────────────────────────────────────────────────

describe("producerCardPartial", () => {
  it("renders the producer name", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("bug-hunter");
  });

  it("renders health badge as Healthy when last run has no errors", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("Healthy");
  });

  it("renders health badge as Errors when last run has errors", () => {
    const producerWithErrors: ProducerData = {
      name: "log-scanner",
      runs: [mockRunWithErrors],
      schedule: "daily",
      enabledRepos: [],
    };
    const html = producerCardPartial(producerWithErrors);
    expect(html).toContain("Errors");
  });

  it("renders No runs badge when producer has no runs", () => {
    const html = producerCardPartial(mockProducerNoRuns);
    expect(html).toContain("No runs");
  });

  it("renders schedule badge when schedule is set", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("every 6h");
  });

  it("renders No schedule badge when schedule is null", () => {
    const html = producerCardPartial(mockProducerNoRuns);
    expect(html).toContain("No schedule");
  });

  it("renders repo badges when repos are enabled", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("acme/frontend");
    expect(html).toContain("acme/backend");
  });

  it("renders 'No repos enabled' when enabledRepos is empty", () => {
    const html = producerCardPartial(mockProducerNoRuns);
    expect(html).toContain("No repos enabled");
  });

  it("renders last run stat cards with correct values", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("Tasks Created");
    expect(html).toContain("5");
    expect(html).toContain("Duplicates Skipped");
    expect(html).toContain("2");
    expect(html).toContain("$0.1234");
    expect(html).toContain("45s");
  });

  it("renders last run timestamp", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("Last run:");
    expect(html).toContain("2026-02-18 10:30:00");
  });

  it("renders recent runs table", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("Recent Runs");
    expect(html).toContain("Time");
    expect(html).toContain("Tasks");
    expect(html).toContain("Dupes");
    expect(html).toContain("Cost");
    expect(html).toContain("Duration");
    expect(html).toContain("Status");
  });

  it("renders OK badge for runs without errors", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("OK");
  });

  it("renders error count badge for runs with errors", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain("1 error");
  });

  it("renders empty state when producer has no runs", () => {
    const html = producerCardPartial(mockProducerNoRuns);
    expect(html).toContain("No runs recorded yet");
  });

  it("renders the card container with correct id", () => {
    const html = producerCardPartial(mockProducer);
    expect(html).toContain('id="producer-card-bug-hunter"');
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
    };
    const html = producerCardPartial(producerLongRun);
    expect(html).toContain("2m 5s");
  });
});
