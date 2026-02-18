import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the logger so tests don't produce output
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { parseAdoRepoName, createPullRequest, getPullRequest } = await import(
  "../../src/integrations/azure-devops.js"
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parseAdoRepoName", () => {
  it("parses org/project/repo correctly", () => {
    const result = parseAdoRepoName("myorg/myproject/myrepo");
    expect(result).toEqual({ org: "myorg", project: "myproject", repo: "myrepo" });
  });

  it("throws on too few parts", () => {
    expect(() => parseAdoRepoName("myorg/myproject")).toThrow(
      "Invalid Azure DevOps repo name: myorg/myproject. Expected format: org/project/repo",
    );
  });

  it("throws on too many parts", () => {
    expect(() => parseAdoRepoName("myorg/myproject/myrepo/extra")).toThrow(
      "Invalid Azure DevOps repo name: myorg/myproject/myrepo/extra. Expected format: org/project/repo",
    );
  });

  it("throws on single part", () => {
    expect(() => parseAdoRepoName("onlyorg")).toThrow(
      "Invalid Azure DevOps repo name: onlyorg. Expected format: org/project/repo",
    );
  });

  it("throws on empty string", () => {
    expect(() => parseAdoRepoName("")).toThrow(
      "Invalid Azure DevOps repo name: . Expected format: org/project/repo",
    );
  });
});

describe("createPullRequest", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends correct URL, headers, and body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        pullRequestId: 42,
        repository: { webUrl: "https://dev.azure.com/myorg/myproject/_git/myrepo" },
      }),
    });

    await createPullRequest(
      "myorg",
      "myproject",
      "myrepo",
      "feature/branch",
      "main",
      "Fix bug",
      "Fixes the login crash",
      "my-pat-token",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];

    expect(url).toBe(
      "https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests?api-version=7.1",
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers.Authorization).toBe(
      `Basic ${Buffer.from(":my-pat-token").toString("base64")}`,
    );

    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      sourceRefName: "refs/heads/feature/branch",
      targetRefName: "refs/heads/main",
      title: "Fix bug",
      description: "Fixes the login crash",
    });
  });

  it("returns correct PR id and URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        pullRequestId: 99,
        repository: { webUrl: "https://dev.azure.com/myorg/myproject/_git/myrepo" },
      }),
    });

    const result = await createPullRequest(
      "myorg",
      "myproject",
      "myrepo",
      "feature/branch",
      "main",
      "Title",
      "Description",
      "pat",
    );

    expect(result.id).toBe(99);
    expect(result.url).toBe(
      "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/99",
    );
  });

  it("URL-encodes special characters in org/project/repo", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        pullRequestId: 1,
        repository: { webUrl: "" },
      }),
    });

    await createPullRequest(
      "my org",
      "my project",
      "my repo",
      "branch",
      "main",
      "Title",
      "Desc",
      "pat",
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("my%20org");
    expect(url).toContain("my%20project");
    expect(url).toContain("my%20repo");
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request: missing fields",
    });

    await expect(
      createPullRequest("org", "proj", "repo", "branch", "main", "T", "D", "pat"),
    ).rejects.toThrow("Azure DevOps PR creation failed (400): Bad Request: missing fields");
  });
});

describe("getPullRequest", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends correct URL and auth header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        pullRequestId: 42,
        status: "active",
      }),
    });

    await getPullRequest("myorg", "myproject", "myrepo", 42, "my-pat");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];

    expect(url).toBe(
      "https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests/42?api-version=7.1",
    );
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe(
      `Basic ${Buffer.from(":my-pat").toString("base64")}`,
    );
  });

  it("returns correct data", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        pullRequestId: 42,
        status: "completed",
      }),
    });

    const result = await getPullRequest("myorg", "myproject", "myrepo", 42, "pat");

    expect(result).toEqual({
      id: 42,
      url: "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42",
      status: "completed",
    });
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });

    await expect(
      getPullRequest("org", "proj", "repo", 999, "pat"),
    ).rejects.toThrow("Azure DevOps get PR failed (404): Not Found");
  });
});
