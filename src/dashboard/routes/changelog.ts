import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { changelogPage } from "../views/changelog.js";

const router = Router();

router.get("/changelog", requireAuth, requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.send(changelogPage(req.session.user!));
  } catch (err) {
    next(err);
  }
});

export default router;
