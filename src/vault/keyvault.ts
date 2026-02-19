import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import logger from "../logger.js";

// ── Secret name helper ───────────────────────────────────────────────────────

export function userSecretName(
  userId: number,
  provider: string,
  label: string,
): string {
  // Key Vault secret names only allow alphanumeric characters and hyphens
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, "-");
  return `hive-user-${userId}-${safe(provider)}-${safe(label)}`;
}

// ── Client initialisation ────────────────────────────────────────────────────

const vaultUri = process.env.AZURE_KEYVAULT_URI;

let client: SecretClient | null = null;
const localStore = new Map<string, string>();

if (vaultUri) {
  client = new SecretClient(vaultUri, new DefaultAzureCredential());
  logger.info({ vaultUri }, "Azure Key Vault client initialised");
} else {
  logger.warn(
    "AZURE_KEYVAULT_URI not set — using in-memory secret store (dev mode)",
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getSecret(name: string): Promise<string | null> {
  if (client) {
    try {
      const secret = await client.getSecret(name);
      return secret.value ?? null;
    } catch (err: unknown) {
      if (err instanceof Error && "statusCode" in err && (err as { statusCode: number }).statusCode === 404) return null;
      throw err;
    }
  }
  return localStore.get(name) ?? null;
}

export async function setSecret(
  name: string,
  value: string,
): Promise<void> {
  if (client) {
    await client.setSecret(name, value);
    return;
  }
  localStore.set(name, value);
}

export async function deleteSecret(name: string): Promise<void> {
  if (client) {
    await client.beginDeleteSecret(name);
    return;
  }
  localStore.delete(name);
}
