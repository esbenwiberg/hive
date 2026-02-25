// Tests for blueprint toggle / blueprint-mode rendering in taskCreateForm

import { describe, it, expect } from "vitest";
import { taskCreateForm } from "../../src/dashboard/views/tasks.js";
import type { RepoRow } from "../../src/db/queries/repos.js";
import type { SessionUser } from "../../src/domain/types.js";

// Minimal stubs
const repos: RepoRow[] = [
  {
    id: 1,
    fullName: "org/repo-a",
    provider: "github",
    installationId: 123,
    settings: {},
    createdAt: new Date().toISOString(),
  } as unknown as RepoRow,
];

const user: SessionUser = {
  id: 42,
  login: "tester",
  name: "Tester",
  avatarUrl: "",
  role: "user",
  provider: "github",
};

describe("taskCreateForm — blueprint toggle off (default)", () => {
  it("renders the form without blueprint errors", () => {
    const html = taskCreateForm(repos, user);
    expect(html).toContain('<input type="checkbox" id="blueprint-toggle"');
    expect(html).toContain("Provide blueprint");
  });

  it("blueprint panel is hidden by default", () => {
    const html = taskCreateForm(repos, user);
    // The blueprint panel has id="blueprint-panel" and starts with 'hidden' class
    expect(html).toMatch(/id="blueprint-panel"\s+class="hidden/);
  });

  it("slide-over panel starts with translate-x-full (closed) when no errors", () => {
    const html = taskCreateForm(repos, user);
    // The outer panel div should start closed
    expect(html).toMatch(/translate-x-full/);
  });

  it("does not render error banner when no blueprint errors are provided", () => {
    const html = taskCreateForm(repos, user);
    expect(html).not.toContain("Blueprint validation failed");
  });
});

describe("taskCreateForm — blueprint toggle on (blueprintMarkdown provided)", () => {
  const sampleMarkdown = "## Approach\n\nDo the thing.\n\n---\n\n## Milestone 1: Setup\n\nDescription.\n\n### Files to Modify\n\n- `src/foo.ts`\n\n### Acceptance Criteria\n\n- It works.";

  it("blueprint panel is visible when blueprintMarkdown is provided", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    // Panel should NOT have hidden class when blueprint is active
    expect(html).not.toMatch(/id="blueprint-panel"\s+class="hidden/);
  });

  it("textarea contains the provided markdown", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    expect(html).toContain("Do the thing.");
    expect(html).toContain("Milestone 1: Setup");
  });

  it("the slide-over panel is open when blueprint is active", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    // translate-x-full should NOT appear in the panel's class list when open
    // The outer div should not have translate-x-full class when blueprintActive=true
    // We check that the opening div class does NOT start with translate-x-full
    const panelMatch = html.match(/<div id="create-panel"[^>]*class="([^"]*)"/)!;
    expect(panelMatch).toBeTruthy();
    expect(panelMatch[1]).not.toContain("translate-x-full");
  });

  it("blueprint toggle checkbox is checked when blueprint is active", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    expect(html).toContain("checked");
  });

  it("shows 'Blueprint template' collapsible helper", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    expect(html).toContain("Blueprint template");
    expect(html).toContain("Copy template into editor");
  });

  it("textarea is labelled 'Blueprint (Markdown)'", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    expect(html).toContain("Blueprint (Markdown)");
  });

  it("normal description field is still present alongside blueprint textarea", () => {
    const html = taskCreateForm(repos, user, undefined, [], sampleMarkdown);
    // The body textarea should still be rendered
    expect(html).toContain('name="body"');
    // And the blueprint textarea
    expect(html).toContain('name="blueprintMarkdown"');
  });
});

describe("taskCreateForm — blueprint validation errors", () => {
  const errors = [
    "Blueprint must have at least one milestone.",
    'milestones[0].title: Title is required.',
  ];

  it("renders the error banner with all error messages", () => {
    const html = taskCreateForm(repos, user, undefined, errors, "## Approach\n\nBad blueprint.");
    expect(html).toContain("Blueprint validation failed");
    expect(html).toContain("Blueprint must have at least one milestone.");
    expect(html).toContain("milestones[0].title: Title is required.");
  });

  it("slide-over panel is open when there are blueprint errors", () => {
    const html = taskCreateForm(repos, user, undefined, errors, "## Approach\n\nBad.");
    const panelMatch = html.match(/<div id="create-panel"[^>]*class="([^"]*)"/)!;
    expect(panelMatch).toBeTruthy();
    expect(panelMatch[1]).not.toContain("translate-x-full");
  });

  it("blueprint panel is visible when there are errors", () => {
    const html = taskCreateForm(repos, user, undefined, errors, "## Approach\n\nBad.");
    expect(html).not.toMatch(/id="blueprint-panel"\s+class="hidden/);
  });

  it("does not render error banner when errors array is empty", () => {
    const html = taskCreateForm(repos, user, undefined, [], "some content");
    expect(html).not.toContain("Blueprint validation failed");
  });
});

describe("taskCreateForm — title always required", () => {
  it("title input has required attribute in default mode", () => {
    const html = taskCreateForm(repos, user);
    // The title input should be marked required
    expect(html).toContain('name="title"');
    expect(html).toContain("required");
  });

  it("title input has required attribute in blueprint mode", () => {
    const html = taskCreateForm(repos, user, undefined, [], "## Approach\n\nDo it.");
    expect(html).toContain('name="title"');
    expect(html).toContain("required");
  });
});

describe("taskCreateForm — XSS safety", () => {
  it("escapes blueprint markdown with HTML special characters", () => {
    const xssMarkdown = '<script>alert("xss")</script>';
    const html = taskCreateForm(repos, user, undefined, [], xssMarkdown);
    // Raw script tag must NOT appear
    expect(html).not.toContain("<script>alert");
    // Escaped form must appear
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes blueprint error messages with HTML special characters", () => {
    const xssErrors = ['<img src=x onerror="alert(1)"> bad field'];
    const html = taskCreateForm(repos, user, undefined, xssErrors, "some blueprint");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
  });
});
