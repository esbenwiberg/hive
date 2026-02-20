import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { resolveGitCredentials } from "../../execution/worktree.js";
import logger from "../../logger.js";
import { upgradePage, upgradeSuccess, upgradeError } from "../views/upgrade.js";

const router = Router();

router.get("/upgrade", requireAuth, requireRole("admin"), (req: Request, res: Response) => {
  res.send(upgradePage(req.session.user!));
});

router.post("/upgrade/trigger", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repo = process.env.HIVE_SELF_REPO;
    if (!repo) {
      res.send(upgradeError("HIVE_SELF_REPO env var not configured"));
      return;
    }

    const userId = req.session.user!.id;
    const creds = await resolveGitCredentials(userId, "github");

    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (response.status === 204) {
      logger.info({ repo, userId }, "Upgrade workflow dispatched");
      res.send(upgradeSuccess());
    } else {
      const body = await response.text();
      logger.warn({ repo, status: response.status, body }, "Upgrade dispatch failed");
      res.send(upgradeError(`GitHub returned ${response.status}`));
    }
  } catch (err) {
    next(err);
  }
});

export default router;
