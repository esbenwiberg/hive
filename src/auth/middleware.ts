import type { Request, Response, NextFunction } from "express";

const ROLE_LEVELS: Record<string, number> = {
  viewer: 0,
  user: 1,
  admin: 2,
};

/** True when Entra env vars are absent and we're not in production. */
export function isDevAuth(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    (!process.env.ENTRA_CLIENT_ID ||
      !process.env.ENTRA_CLIENT_SECRET ||
      !process.env.ENTRA_TENANT_ID)
  );
}

const DEV_USER = {
  id: 0,
  entraOid: "dev",
  email: "dev@localhost",
  displayName: "Dev User",
  role: "admin" as const,
};

/**
 * Middleware that requires an authenticated session.
 * Redirects to /auth/login if no user is in the session.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.session.user) {
    next();
    return;
  }
  if (isDevAuth()) {
    req.session.user = DEV_USER;
    res.locals.user = DEV_USER;
    next();
    return;
  }
  res.redirect("/auth/login");
}

/**
 * Middleware factory that checks if the authenticated user's role
 * meets or exceeds the required role level (admin > user > viewer).
 */
export function requireRole(role: string) {
  const requiredLevel = ROLE_LEVELS[role] ?? 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session.user) {
      if (isDevAuth()) {
        req.session.user = DEV_USER;
        res.locals.user = DEV_USER;
      } else {
        res.redirect("/auth/login");
        return;
      }
    }

    const userLevel = ROLE_LEVELS[req.session.user.role] ?? 0;
    if (userLevel >= requiredLevel) {
      next();
      return;
    }

    res.status(403).send("Forbidden");
  };
}

/**
 * Middleware that attaches the session user to res.locals.user
 * for use in view templates.
 */
export function injectUser(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.session.user) {
    res.locals.user = req.session.user;
  }
  next();
}
