import { describe, it, expect } from "vitest";
import { logsPage } from "../../src/dashboard/views/logs.js";
import type { SessionUser } from "../../src/domain/types.js";

const mockUser: SessionUser = {
  id: 1,
  entraOid: "oid-123",
  email: "alice@example.com",
  displayName: "Alice Admin",
  role: "admin",
};

describe("logsPage", () => {
  it("returns HTML containing log-container", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('id="log-container"');
  });

  it("returns HTML with filter inputs", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('id="log-component"');
    expect(html).toContain('id="log-task-id"');
    expect(html).toContain('id="log-search"');
    expect(html).toContain("log-level-filter");
  });

  it("returns HTML with controls", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('id="log-pause"');
    expect(html).toContain('id="log-clear"');
    expect(html).toContain('id="log-scroll-bottom"');
  });

  it("contains script tag for logs.js", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('src="/public/logs.js"');
  });

  it("contains connection status indicator", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('id="connection-status"');
    expect(html).toContain('id="status-dot"');
    expect(html).toContain('id="status-text"');
  });

  it("wraps content in layout with user", () => {
    const html = logsPage(mockUser);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Alice Admin");
    expect(html).toContain("Logs | The Hive");
  });

  it("includes level filter checkboxes for all levels", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('value="debug"');
    expect(html).toContain('value="info"');
    expect(html).toContain('value="warn"');
    expect(html).toContain('value="error"');
    expect(html).toContain('value="fatal"');
  });

  it("includes entry count display", () => {
    const html = logsPage(mockUser);
    expect(html).toContain('id="log-count"');
  });
});
