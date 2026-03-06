import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../auth/middleware.js";
import { diagramPage } from "../views/diagram.js";

const router = Router();

// ── GET /diagram ─ Task lifecycle diagram ────────────────────────────────────

router.get("/diagram", requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    res.send(diagramPage(user));
  } catch (err) {
    next(err);
  }
});

export default router;
