import { describe, it, expect } from "vitest";
import {
  costsPage,
  costsBreakdownPartial,
} from "../../src/dashboard/views/costs.js";
import type {
  CostsPageData,
  BreakdownDimension,
} from "../../src/dashboard/views/costs.js";
import type { BreakdownRow } from "../../src/db/queries/costs.js";
import type { SessionUser } from "../../src/domain/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const mockUser: SessionUser = {
  id: 1,
  entraOid: "oid-123",
  email: "alice@example.com",
  displayName: "Alice Test",
  role: "admin",
};

const mockPageData: CostsPageData = {
  todayTotal: 12.34,
  monthTotal: 456.78,
  allTimeTotal: 9999.99,
  breakdown: [
    { dimension: "Alice", totalUsd: 100, count: 10 },
    { dimension: "Bob", totalUsd: 50, count: 5 },
  ],
  breakdownDimension: "user",
  dailyBreakdown: [
    { date: "2026-02-17", totalUsd: 5.5, count: 3 },
    { date: "2026-02-18", totalUsd: 6.84, count: 4 },
  ],
  monthlySummary: [
    { month: "2026-01", totalUsd: 200.0, count: 50 },
    { month: "2026-02", totalUsd: 456.78, count: 80 },
  ],
};

// ── costsPage ───────────────────────────────────────────────────────────────

describe("costsPage", () => {
  it("returns valid HTML with doctype and closing tags", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("renders the page title", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("Cost Reports");
  });

  it("renders today total stat card", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("$12.34");
    expect(html).toContain("Today");
  });

  it("renders month total stat card", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("$456.78");
    expect(html).toContain("This Month");
  });

  it("renders all-time total stat card", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("$9999.99");
    expect(html).toContain("All Time");
  });

  it("renders breakdown rows", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain("$100.00");
    expect(html).toContain("$50.00");
  });

  it("renders dimension tabs with user active", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("By User");
    expect(html).toContain("By Repo");
    expect(html).toContain("By Agent");
    expect(html).toContain("By Model");
  });

  it("renders daily breakdown dates", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("02-17");
    expect(html).toContain("02-18");
  });

  it("renders monthly summary", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("2026-01");
    expect(html).toContain("2026-02");
    expect(html).toContain("Monthly Summary");
  });

  it("renders the user display name in the layout", () => {
    const html = costsPage(mockPageData, mockUser);
    expect(html).toContain("Alice Test");
  });
});

// ── costsBreakdownPartial ───────────────────────────────────────────────────

describe("costsBreakdownPartial", () => {
  it("renders a table with dimension rows", () => {
    const rows: BreakdownRow[] = [
      { dimension: "my-repo", totalUsd: 42.5, count: 7 },
    ];
    const html = costsBreakdownPartial(rows, "repo");
    expect(html).toContain("my-repo");
    expect(html).toContain("$42.50");
    expect(html).toContain("7");
    expect(html).toContain("Repo"); // dimension header
  });

  it("renders empty state when no rows", () => {
    const html = costsBreakdownPartial([], "model");
    expect(html).toContain("No cost data for this dimension");
  });

  it.each<[BreakdownDimension, string]>([
    ["user", "User"],
    ["repo", "Repo"],
    ["agent", "Agent"],
    ["model", "Model"],
  ])("renders correct header for dimension %s", (dimension, expectedHeader) => {
    const rows: BreakdownRow[] = [
      { dimension: "test-dim", totalUsd: 1.0, count: 1 },
    ];
    const html = costsBreakdownPartial(rows, dimension);
    expect(html).toContain(expectedHeader);
  });
});
