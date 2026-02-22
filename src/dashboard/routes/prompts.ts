import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireRole } from "../../auth/middleware.js";
import { listPromptFiles, readPrompt, writePrompt, readOriginalPrompt, validatePromptPath } from "../../prompts.js";
import { invalidatePrompt } from "../../prompt-cache.js";
import { promptsPage, promptEditorPartial } from "../views/prompts.js";

const router = Router();

// ── GET /prompts ─ Full prompts page ────────────────────────────────────────

router.get("/prompts", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.session.user!;
    const files = await listPromptFiles();
    res.send(promptsPage(files, user));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/prompts/:path(*) ─ Read a prompt file (HTMX partial) ──────────

router.get("/api/prompts/:path(*)", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const relativePath = req.params.path as string;

    // Validate path before reading
    try {
      validatePromptPath(relativePath);
    } catch (err) {
      res.status(400).send((err as Error).message);
      return;
    }

    const content = await readPrompt(relativePath);
    res.send(promptEditorPartial(relativePath, content));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/prompts/:path(*) ─ Write a prompt file ────────────────────────

router.post("/api/prompts/:path(*)", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const relativePath = req.params.path as string;

    // Validate path before writing
    try {
      validatePromptPath(relativePath);
    } catch (err) {
      res.status(400).send((err as Error).message);
      return;
    }

    const content = typeof req.body.content === "string" ? req.body.content : "";
    await writePrompt(relativePath, content);
    invalidatePrompt(relativePath);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Prompt saved", type: "success" } }),
    );
    res.send(promptEditorPartial(relativePath, content));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/prompts/:path(*)/reset ─ Reset prompt to git-committed version ─

router.post("/api/prompts/:path(*)/reset", requireRole("admin"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const relativePath = req.params.path as string;

    try {
      validatePromptPath(relativePath);
    } catch (err) {
      res.status(400).send((err as Error).message);
      return;
    }

    const original = await readOriginalPrompt(relativePath);
    if (original === null) {
      res.status(404).send("No committed version found");
      return;
    }

    await writePrompt(relativePath, original);
    invalidatePrompt(relativePath);

    res.setHeader(
      "HX-Trigger",
      JSON.stringify({ showToast: { message: "Prompt reset to original", type: "success" } }),
    );
    res.send(promptEditorPartial(relativePath, original));
  } catch (err) {
    next(err);
  }
});

export default router;
