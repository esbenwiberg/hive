import path from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import sessionMiddleware from "../auth/session.js";
import { getAuthUrl, handleCallback } from "../auth/entra.js";
import { injectUser } from "../auth/middleware.js";
import { findOrCreateByEntraOid } from "../db/queries/users.js";
import logger from "../logger.js";
import dashboardRouter from "./routes/dashboard.js";
import taskRouter from "./routes/tasks.js";
import profileRouter from "./routes/profile.js";
import costsRouter from "./routes/costs.js";
import settingsRouter from "./routes/settings.js";
import producersRouter from "./routes/producers.js";
import promptsRouter from "./routes/prompts.js";
import hivemindRouter from "./routes/hivemind.js";
import logsRouter from "./routes/logs.js";
import previewRouter from "../execution/preview/proxy.js";

const app = express();

// Trust the reverse proxy (Azure Container Apps terminates TLS at the ingress).
// Without this, express-session's secure cookies won't be set because Express
// sees the connection as plain HTTP.
app.set("trust proxy", 1);

// ── Static files ────────────────────────────────────────────────────────────

// Static files: resolve from project root so it works whether running
// compiled JS from dist/ or source TS via tsx from src/.
const publicDir = path.resolve("src", "dashboard", "public");
app.use("/public", express.static(publicDir));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(injectUser);

// ── CSRF protection (Origin check) ───────────────────────────────────────────

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST") {
    next();
    return;
  }

  const origin = req.headers["origin"] ?? req.headers["referer"];
  if (!origin) {
    res.status(403).send("Forbidden: missing Origin header");
    return;
  }

  try {
    const originHost = new URL(origin as string).host;
    const expectedHost = req.get("host");
    if (originHost !== expectedHost) {
      res.status(403).send("Forbidden: Origin mismatch");
      return;
    }
  } catch {
    res.status(403).send("Forbidden: invalid Origin header");
    return;
  }

  next();
});

// ── Auth routes (public) ────────────────────────────────────────────────────

function getRedirectUri(req: Request): string {
  if (process.env.REDIRECT_URI) {
    return process.env.REDIRECT_URI;
  }
  // Fallback for local dev only — never use Host header in production
  if (process.env.NODE_ENV === "production") {
    throw new Error("REDIRECT_URI environment variable is required in production");
  }
  return `${req.protocol}://${req.get("host")}/auth/callback`;
}

app.get("/auth/login", async (req, res, next) => {
  try {
    const redirectUri = getRedirectUri(req);
    const url = await getAuthUrl(redirectUri);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

app.get("/auth/callback", async (req, res, next) => {
  try {
    const code = req.query.code as string | undefined;
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }

    const redirectUri = getRedirectUri(req);
    const profile = await handleCallback(code, redirectUri);
    const user = await findOrCreateByEntraOid(
      profile.oid,
      profile.email,
      profile.displayName,
    );

    req.session.user = {
      id: user.id,
      entraOid: user.entraOid,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    // Explicitly save session to PostgreSQL before redirecting.
    // Without this, the redirect fires before the async store write completes,
    // causing the next request to not find the session → infinite login loop.
    req.session.save((saveErr) => {
      if (saveErr) {
        next(saveErr);
        return;
      }
      logger.info({ userId: user.id }, "User logged in");
      res.redirect("/");
    });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      next(err);
      return;
    }
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

// ── Health check ─────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Protected routes (routers) ──────────────────────────────────────────────

app.use("/", dashboardRouter);
app.use("/", taskRouter);
app.use("/", profileRouter);
app.use("/", costsRouter);
app.use("/", settingsRouter);
app.use("/", producersRouter);
app.use("/", promptsRouter);
app.use("/", hivemindRouter);
app.use("/", logsRouter);
app.use(previewRouter);

// ── Error handler ────────────────────────────────────────────────────────────

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const isHtmx = !!req.headers["hx-request"];
  const status = err.message.startsWith("Invalid transition") || err.message.endsWith("not found") ? 400 : 500;

  if (status === 500) {
    logger.error(err, "Unhandled error");
  }

  if (isHtmx) {
    res.status(status).setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: err.message, type: "error" } }),
    );
    res.send("");
  } else {
    const message = process.env.NODE_ENV === "production" && status === 500
      ? "Internal server error"
      : err.message;
    res.status(status).send(message);
  }
});

export default app;
