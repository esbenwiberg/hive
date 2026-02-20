import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import logger from "../../logger.js";
import { getSecret } from "../../vault/keyvault.js";
import type { DockerHostConfig } from "../../domain/autonomous-config.js";

const CERT_DIR = "/tmp/hive-docker-tls";
const REMOTE_BASE = "/home/azureuser/hive-previews";

/** Paths to cached cert/key files on the local filesystem. */
interface CertPaths {
  ca: string;
  cert: string;
  key: string;
  sshKey: string;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function sshArgs(config: DockerHostConfig, sshKeyPath: string): string[] {
  return [
    "-i", sshKeyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
  ];
}

function sshTarget(config: DockerHostConfig): string {
  return `${config.ssh_user}@${config.ip}`;
}

/**
 * Fetch TLS certs + SSH key from Key Vault and cache them to disk.
 * Idempotent — skips download if files already exist.
 */
export async function ensureCerts(config: DockerHostConfig): Promise<CertPaths> {
  const paths: CertPaths = {
    ca: join(CERT_DIR, "ca.pem"),
    cert: join(CERT_DIR, "client-cert.pem"),
    key: join(CERT_DIR, "client-key.pem"),
    sshKey: join(CERT_DIR, "ssh-key"),
  };

  if (
    existsSync(paths.ca) &&
    existsSync(paths.cert) &&
    existsSync(paths.key) &&
    existsSync(paths.sshKey)
  ) {
    return paths;
  }

  logger.info("Fetching Docker TLS certs + SSH key from Key Vault");
  mkdirSync(CERT_DIR, { recursive: true });

  const [ca, cert, key, sshKey] = await Promise.all([
    getSecret(config.tls_ca_vault_secret),
    getSecret(config.tls_cert_vault_secret),
    getSecret(config.tls_key_vault_secret),
    getSecret(config.ssh_key_vault_secret),
  ]);

  if (!ca || !cert || !key || !sshKey) {
    const missing = [
      !ca && config.tls_ca_vault_secret,
      !cert && config.tls_cert_vault_secret,
      !key && config.tls_key_vault_secret,
      !sshKey && config.ssh_key_vault_secret,
    ].filter(Boolean);
    throw new Error(`Missing Key Vault secrets: ${missing.join(", ")}`);
  }

  writeFileSync(paths.ca, ca, { mode: 0o600 });
  writeFileSync(paths.cert, cert, { mode: 0o600 });
  writeFileSync(paths.key, key, { mode: 0o600 });
  writeFileSync(paths.sshKey, sshKey, { mode: 0o600 });

  // SSH is strict about key file permissions
  chmodSync(paths.sshKey, 0o600);

  return paths;
}

/**
 * Rsync the local worktree to the remote Docker host.
 * Returns the remote path where files were synced.
 */
export async function syncWorktree(
  config: DockerHostConfig,
  localPath: string,
  taskId: string,
  sshKeyPath: string,
): Promise<string> {
  const remotePath = `${REMOTE_BASE}/${taskId}/`;

  // Ensure remote directory exists
  await exec("ssh", [
    ...sshArgs(config, sshKeyPath),
    sshTarget(config),
    `mkdir -p ${remotePath}`,
  ]);

  // Rsync worktree (trailing slash on localPath = contents only)
  const rshFlag = `ssh ${sshArgs(config, sshKeyPath).join(" ")}`;
  await exec("rsync", [
    "-az", "--delete",
    "-e", rshFlag,
    `${localPath}/`,
    `${sshTarget(config)}:${remotePath}`,
  ]);

  logger.info({ taskId, remotePath }, "Worktree synced to remote host");
  return remotePath;
}

/**
 * SSH into the remote host and run `docker compose up -d`.
 */
export async function remoteComposeUp(
  config: DockerHostConfig,
  sshKeyPath: string,
  remotePath: string,
  project: string,
  composeFile: string,
  env?: Record<string, string>,
): Promise<void> {
  const envPrefix = env
    ? Object.entries(env).map(([k, v]) => `${k}=${shellEscape(v)}`).join(" ") + " "
    : "";

  const cmd = `cd ${remotePath} && ${envPrefix}docker compose -p ${project} -f ${composeFile} up -d`;

  await exec("ssh", [
    ...sshArgs(config, sshKeyPath),
    sshTarget(config),
    cmd,
  ]);

  logger.info({ project, remotePath }, "Remote docker compose up succeeded");
}

/**
 * SSH into the remote host and run `docker compose down --remove-orphans`.
 */
export async function remoteComposeDown(
  config: DockerHostConfig,
  sshKeyPath: string,
  project: string,
): Promise<void> {
  const cmd = `docker compose -p ${project} down --remove-orphans`;

  await exec("ssh", [
    ...sshArgs(config, sshKeyPath),
    sshTarget(config),
    cmd,
  ]);

  logger.info({ project }, "Remote docker compose down succeeded");
}

/**
 * SSH into the remote host and remove the synced worktree directory.
 */
export async function cleanupRemoteWorktree(
  config: DockerHostConfig,
  taskId: string,
  sshKeyPath: string,
): Promise<void> {
  const remotePath = `${REMOTE_BASE}/${taskId}`;

  await exec("ssh", [
    ...sshArgs(config, sshKeyPath),
    sshTarget(config),
    `rm -rf ${remotePath}`,
  ]);

  logger.info({ taskId, remotePath }, "Remote worktree cleaned up");
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
