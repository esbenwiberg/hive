import express from "express";
import sessionMiddleware from "../auth/session.js";
import { getAuthUrl, handleCallback } from "../auth/entra.js";
import { requireAuth, injectUser } from "../auth/middleware.js";
import { findOrCreateByEntraOid } from "../db/queries/users.js";
import { layout } from "./views/layout.js";
import { badge, card, escapeHtml } from "./views/components.js";
import logger from "../logger.js";

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(injectUser);

// ── Auth routes ──────────────────────────────────────────────────────────────

app.get("/auth/login", async (req, res, next) => {
  try {
    const redirectUri = `${req.protocol}://${req.get("host")}/auth/callback`;
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

    const redirectUri = `${req.protocol}://${req.get("host")}/auth/callback`;
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

    logger.info({ userId: user.id }, "User logged in");
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});

app.get("/auth/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      next(err);
      return;
    }
    res.redirect("/");
  });
});

// ── Health check ─────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Protected routes ─────────────────────────────────────────────────────────

app.get("/", requireAuth, (req, res) => {
  const user = req.session.user!;
  const roleBadge = badge(user.role, "amber");

  const content = card(
    `<div class="space-y-4">
      <div class="flex items-center gap-3">
        <h2 class="text-2xl font-bold text-slate-50">Welcome, ${escapeHtml(user.displayName)}</h2>
        ${roleBadge}
      </div>
      <p class="text-slate-400 leading-relaxed">
        The Hive is a multi-user autonomous task orchestration system.
        It ingests issues, plans execution, dispatches AI coding agents,
        reviews their output, and tracks costs &mdash; all from this dashboard.
      </p>
    </div>`,
    { padding: "spacious" },
  );

  res.send(layout("Dashboard", content, user));
});

export default app;
