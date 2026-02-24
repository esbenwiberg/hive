/**
 * Unit tests for GET /admin/models and POST /admin/models/:component.
 *
 * We mock the domain dependencies so no real DB or config file is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: vi.fn(() => ({
    models: {
      default: "claude-sonnet-4-6",
      components: {},
      componentProviders: {},
    },
  })),
  reloadConfig: vi.fn(),
}));

vi.mock("../../../src/domain/config.js", () => ({
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => undefined),
}));

vi.mock("../../../src/auth/middleware.js", () => ({
  requireRole: (_role: string) => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

// ── Test app ─────────────────────────────────────────────────────────────────

async function buildApp() {
  const { modelsRouter } = await import("../../../src/dashboard/routes/models.js");
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/admin/models", modelsRouter);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /admin/models", () => {
  it("returns 200 with HTML listing all pipeline components", async () => {
    const app = await buildApp();
    const res = await request(app).get("/admin/models");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);

    // Should contain the page title
    expect(res.text).toContain("Model Configuration");

    // Should list several known components
    expect(res.text).toContain("worker");
    expect(res.text).toContain("review-gate");
    expect(res.text).toContain("router");
    expect(res.text).toContain("decomposer");
  });
});

describe("POST /admin/models/:component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts valid anthropic config and returns updated row HTML", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/worker")
      .type("form")
      .send({ type: "anthropic", model: "claude-haiku-3-5" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("worker");
  });

  it("accepts valid azure-openai config and returns updated row HTML", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/review-gate")
      .type("form")
      .send({
        type: "azure-openai",
        model: "gpt-4o",
        endpoint: "https://my-resource.openai.azure.com/",
        deploymentName: "gpt-4o-deployment",
        apiKey: "test-key-1234",
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain("review-gate");
    // Success toast header should be present
    expect(res.headers["hx-trigger"]).toBeDefined();
    expect(res.headers["hx-trigger"]).toContain("showToast");
    expect(res.headers["hx-trigger"]).toContain("success");
  });

  it("returns 400 when component name is unknown", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/nonexistent-component")
      .type("form")
      .send({ type: "anthropic", model: "claude-haiku-3-5" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Unknown component");
  });

  it("returns 400 when provider type is invalid", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/worker")
      .type("form")
      .send({ type: "openai-direct", model: "gpt-4o" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Invalid provider type");
  });

  it("returns 400 when model is missing", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/worker")
      .type("form")
      .send({ type: "anthropic", model: "" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Model name is required");
  });

  it("returns 400 when azure-openai is missing endpoint", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/worker")
      .type("form")
      .send({
        type: "azure-openai",
        model: "gpt-4o",
        deploymentName: "my-deployment",
        // no endpoint
      });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Endpoint URL is required");
  });

  it("returns 400 when azure-openai is missing deploymentName", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/worker")
      .type("form")
      .send({
        type: "azure-openai",
        model: "gpt-4o",
        endpoint: "https://my-resource.openai.azure.com/",
        // no deploymentName
      });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Deployment name is required");
  });

  it("returns 400 when azure-anthropic is missing endpoint", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/admin/models/gate")
      .type("form")
      .send({
        type: "azure-anthropic",
        model: "claude-haiku-3-5",
        deploymentName: "haiku-deployment",
      });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Endpoint URL is required");
  });

  it("calls setConfig and reloadConfig when saving valid config", async () => {
    const { setConfig } = await import("../../../src/domain/config.js");
    const { reloadConfig } = await import("../../../src/domain/autonomous-config.js");

    const app = await buildApp();
    await request(app)
      .post("/admin/models/router")
      .type("form")
      .send({ type: "anthropic", model: "claude-opus-4-5" });

    expect(setConfig).toHaveBeenCalledWith(
      "autonomous",
      expect.objectContaining({
        models: expect.objectContaining({
          componentProviders: expect.objectContaining({
            router: expect.objectContaining({
              type: "anthropic",
              model: "claude-opus-4-5",
            }),
          }),
        }),
      }),
    );
    expect(reloadConfig).toHaveBeenCalled();
  });
});
