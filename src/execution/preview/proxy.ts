import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { requireAuth } from "../../auth/middleware.js";
import { previewManager } from "./manager.js";
import * as taskQueries from "../../db/queries/tasks.js";
import logger from "../../logger.js";
import { escapeHtml } from "../../dashboard/views/components.js";

/** Maps taskId -> proxy target URL, populated by the auth/check middleware. */
const targetMap = new Map<string, string>();

const router = Router();

/**
 * Reverse-proxy requests to running preview environments.
 *
 * GET /preview/:taskId       -> proxy to preview host:port
 * GET /preview/:taskId/*     -> proxy to preview host:port/*
 */
router.use(
  "/preview/:taskId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    const taskId = String(req.params.taskId);
    const safeTaskId = escapeHtml(taskId);
    const info = previewManager.getPreviewInfo(taskId);

    if (!info) {
      res.status(404).send(
        `<div style="font-family:sans-serif;padding:2rem;text-align:center;">
          <h2>Preview Not Found</h2>
          <p>No running preview for task <code>${safeTaskId}</code>.</p>
          <a href="/tasks">Back to tasks</a>
        </div>`,
      );
      return;
    }

    // Check preview status from DB to return 503 while starting
    const task = await taskQueries.getById(taskId);
    if (task?.previewStatus === "starting") {
      res.status(503).send(
        `<div style="font-family:sans-serif;padding:2rem;text-align:center;">
          <h2>Preview Starting</h2>
          <p>The preview for task <code>${safeTaskId}</code> is still starting up. Please try again shortly.</p>
          <a href="/tasks">Back to tasks</a>
        </div>`,
      );
      return;
    }

    // Store target for the proxy middleware to pick up
    targetMap.set(taskId, `http://${info.host}:${info.port}`);

    next();
  },
  createProxyMiddleware({
    router: (req: Request) => {
      const taskId = String(req.params.taskId);
      const target = targetMap.get(taskId);
      targetMap.delete(taskId);
      return target ?? "http://localhost:0";
    },
    pathRewrite: (path, req) => {
      // Strip /preview/:taskId prefix, keep the rest
      const taskId = String((req as Request).params.taskId);
      const prefix = `/preview/${taskId}`;
      const rewritten = path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
      return rewritten;
    },
    changeOrigin: true,
    ws: false,
    on: {
      error: (err, req, res) => {
        logger.warn({ err: err.message, url: (req as Request).originalUrl }, "Preview proxy error");
        if ("status" in res && typeof res.status === "function") {
          (res as Response).status(502).send(
            `<div style="font-family:sans-serif;padding:2rem;text-align:center;">
              <h2>Preview Unavailable</h2>
              <p>The preview environment is not responding. It may still be starting up.</p>
              <a href="/tasks">Back to tasks</a>
            </div>`,
          );
        }
      },
    },
  }),
);

export default router;
