import { ConfidentialClientApplication } from "@azure/msal-node";
import logger from "../logger.js";

const clientId = process.env.ENTRA_CLIENT_ID ?? "";
const clientSecret = process.env.ENTRA_CLIENT_SECRET ?? "";
const tenantId = process.env.ENTRA_TENANT_ID ?? "";

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId,
    clientSecret,
    authority: `https://login.microsoftonline.com/${tenantId}`,
  },
});

const SCOPES = ["openid", "profile", "email"];

export interface EntraUserProfile {
  oid: string;
  email: string;
  displayName: string;
}

/**
 * Builds an authorization URL for the Entra ID login flow.
 */
export async function getAuthUrl(redirectUri: string): Promise<string> {
  const url = await msalClient.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri,
  });
  return url;
}

/**
 * Exchanges an authorization code for tokens and returns the user profile.
 */
export async function handleCallback(
  code: string,
  redirectUri: string,
): Promise<EntraUserProfile> {
  const result = await msalClient.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri,
  });

  const claims = result.idTokenClaims as Record<string, unknown>;

  const oid = (claims.oid as string) ?? result.uniqueId;
  const email =
    (claims.preferred_username as string) ??
    (claims.email as string) ??
    "";
  const displayName =
    (claims.name as string) ??
    result.account?.name ??
    email;

  logger.info({ oid, email }, "Entra ID authentication successful");

  return { oid, email, displayName };
}

/**
 * Clears the MSAL token cache.
 */
export async function logout(): Promise<void> {
  msalClient.clearCache();
}
