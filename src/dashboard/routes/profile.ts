import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.js";
import { db } from "../../db/connection.js";
import { userCredentials } from "../../db/schema.js";
import {
  setSecret,
  deleteSecret,
  userSecretName,
} from "../../vault/keyvault.js";
import { profilePage, credentialsListPartial } from "../views/profile.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getUserCredentials(userId: number) {
  return db
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .orderBy(userCredentials.createdAt);
}

// ── GET /profile ─────────────────────────────────────────────────────────────

router.get(
  "/profile",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.user!;
      const credentials = await getUserCredentials(user.id);
      res.send(profilePage(user, credentials));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/profile/tokens ─────────────────────────────────────────────────

router.post(
  "/api/profile/tokens",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.user!;
      const { provider, label, token } = req.body;

      if (!provider || !label || !token) {
        res.status(400).send("provider, label, and token are required");
        return;
      }

      const secretName = userSecretName(user.id, provider, label);

      await setSecret(secretName, token);

      await db.insert(userCredentials).values({
        userId: user.id,
        provider,
        label,
        vaultSecretId: secretName,
      });

      const credentials = await getUserCredentials(user.id);

      res.setHeader(
        "HX-Trigger",
        JSON.stringify({
          showToast: { message: "Token added", type: "success" },
        }),
      );
      res.send(credentialsListPartial(credentials));
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/profile/tokens/:id ───────────────────────────────────────────

router.delete(
  "/api/profile/tokens/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.user!;
      const credId = Number(req.params.id);

      // Verify the credential belongs to the current user
      const [credential] = await db
        .select()
        .from(userCredentials)
        .where(
          and(
            eq(userCredentials.id, credId),
            eq(userCredentials.userId, user.id),
          ),
        );

      if (!credential) {
        res.status(404).send("Credential not found");
        return;
      }

      await deleteSecret(credential.vaultSecretId);

      await db
        .delete(userCredentials)
        .where(eq(userCredentials.id, credId));

      const credentials = await getUserCredentials(user.id);

      res.setHeader(
        "HX-Trigger",
        JSON.stringify({
          showToast: { message: "Token deleted", type: "success" },
        }),
      );
      res.send(credentialsListPartial(credentials));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
