import { describe, it, expect, vi } from "vitest";
import {
  requireAuth,
  requireRole,
  injectUser,
} from "../../src/auth/middleware.js";

/** Helper to build a minimal mock request with an optional session user. */
function mockReq(user?: { id: number; role: string }) {
  return {
    session: user ? { user } : ({} as Record<string, unknown>),
  } as any;
}

/** Helper to build a minimal mock response with spies. */
function mockRes() {
  const res: any = {
    locals: {},
    redirect: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return res;
}

// ── requireAuth ─────────────────────────────────────────────────────────────

describe("requireAuth", () => {
  it("calls next() when session has a user", () => {
    const req = mockReq({ id: 1, role: "user" });
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects to /auth/login when session is empty", () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      requireAuth(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith("/auth/login");
      expect(next).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

// ── requireRole ─────────────────────────────────────────────────────────────

describe("requireRole('admin')", () => {
  const middleware = requireRole("admin");

  it("returns 403 for role='user'", () => {
    const req = mockReq({ id: 1, role: "user" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith("Forbidden");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes for role='admin'", () => {
    const req = mockReq({ id: 1, role: "admin" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("requireRole('user')", () => {
  const middleware = requireRole("user");

  it("passes for role='user'", () => {
    const req = mockReq({ id: 1, role: "user" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("passes for role='admin'", () => {
    const req = mockReq({ id: 1, role: "admin" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 403 for role='viewer'", () => {
    const req = mockReq({ id: 1, role: "viewer" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith("Forbidden");
    expect(next).not.toHaveBeenCalled();
  });
});

// ── injectUser ──────────────────────────────────────────────────────────────

describe("injectUser", () => {
  it("sets res.locals.user from session", () => {
    const user = { id: 1, role: "user", email: "a@b.com", displayName: "A" };
    const req = mockReq(user as any);
    const res = mockRes();
    const next = vi.fn();

    injectUser(req, res, next);

    expect(res.locals.user).toEqual(user);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not set res.locals.user when session is empty", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    injectUser(req, res, next);

    expect(res.locals.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
