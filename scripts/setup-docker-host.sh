#!/usr/bin/env bash
# Setup the remote Docker host for Hive preview environments.
# Handles: VM discovery, Docker group, SSH key generation + install,
# TLS cert download, Key Vault upload, and config file patching.
#
# Usage:
#   bash scripts/setup-docker-host.sh
#   bash scripts/setup-docker-host.sh --vm the-hive-docker --vault the-hive-kv
#
# Prerequisites: az cli logged in with VM + Key Vault access.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
VM_NAME="the-hive-docker"
RG="THE-HIVE"
VAULT="the-hive-kv"
TLS_DIR="/etc/docker/tls"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)    VM_NAME="$2"; shift 2 ;;
    --vault) VAULT="$2";   shift 2 ;;
    --rg)    RG="$2";      shift 2 ;;
    --tls-dir) TLS_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

LOCAL_TMP=$(mktemp -d)
trap 'rm -rf "$LOCAL_TMP"' EXIT

SSH_KEY="$LOCAL_TMP/ssh-key"
SSH_PUB="$LOCAL_TMP/ssh-key.pub"

echo "==> Config: VM=$VM_NAME  RG=$RG  VAULT=$VAULT  TLS_DIR=$TLS_DIR"

# ── 1. Discover VM ───────────────────────────────────────────────────────────
echo ""
echo "==> Discovering VM..."

VM_IP=$(az vm show -n "$VM_NAME" -g "$RG" --show-details \
  --query "publicIps" -o tsv)
VM_USER=$(az vm show -n "$VM_NAME" -g "$RG" \
  --query "osProfile.adminUsername" -o tsv)

if [[ -z "$VM_IP" || -z "$VM_USER" ]]; then
  echo "ERROR: Could not discover VM IP or admin username."
  echo "       Ensure VM '$VM_NAME' exists in resource group '$RG'."
  exit 1
fi

echo "  VM IP:    $VM_IP"
echo "  VM User:  $VM_USER"

# ── 2. Ensure docker group membership ────────────────────────────────────────
echo ""
echo "==> Ensuring '$VM_USER' is in the docker group..."

az vm run-command invoke \
  -n "$VM_NAME" -g "$RG" \
  --command-id RunShellScript \
  --scripts "usermod -aG docker $VM_USER" \
  --output none

echo "  Done (may require VM session restart to take effect)."

# ── 3. Generate SSH key pair ─────────────────────────────────────────────────
echo ""
echo "==> Generating ed25519 SSH key pair..."

ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
chmod 600 "$SSH_KEY"
echo "  Key: $SSH_KEY"

# ── 4. Install SSH public key on VM ──────────────────────────────────────────
echo ""
echo "==> Installing SSH public key on VM..."

PUB_KEY_CONTENT=$(cat "$SSH_PUB")

az vm run-command invoke \
  -n "$VM_NAME" -g "$RG" \
  --command-id RunShellScript \
  --scripts "
    mkdir -p /home/$VM_USER/.ssh
    chmod 700 /home/$VM_USER/.ssh
    echo '$PUB_KEY_CONTENT' >> /home/$VM_USER/.ssh/authorized_keys
    chmod 600 /home/$VM_USER/.ssh/authorized_keys
    chown -R $VM_USER:$VM_USER /home/$VM_USER/.ssh
  " \
  --output none

echo "  Public key installed."

# ── 5. Verify SSH + docker access ────────────────────────────────────────────
echo ""
echo "==> Verifying SSH connection and docker access..."

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10)

if ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "docker ps" > /dev/null 2>&1; then
  echo "  SSH + docker ps succeeded."
else
  echo "WARNING: SSH or 'docker ps' failed. The docker group change may need a reboot."
  echo "         Trying: az vm restart -n $VM_NAME -g $RG"
  az vm restart -n "$VM_NAME" -g "$RG" --output none
  echo "  VM restarted. Waiting 30s..."
  sleep 30

  if ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "docker ps" > /dev/null 2>&1; then
    echo "  SSH + docker ps succeeded after restart."
  else
    echo "ERROR: Still cannot SSH or run docker ps. Check VM and network config."
    exit 1
  fi
fi

# ── 6. Download TLS certs ────────────────────────────────────────────────────
echo ""
echo "==> Downloading TLS certs from ${VM_USER}@${VM_IP}:${TLS_DIR}..."

scp "${SSH_OPTS[@]}" "$VM_USER@$VM_IP:$TLS_DIR/ca.pem"          "$LOCAL_TMP/ca.pem"
scp "${SSH_OPTS[@]}" "$VM_USER@$VM_IP:$TLS_DIR/client-cert.pem" "$LOCAL_TMP/client-cert.pem"
scp "${SSH_OPTS[@]}" "$VM_USER@$VM_IP:$TLS_DIR/client-key.pem"  "$LOCAL_TMP/client-key.pem"

echo "  Downloaded 3 certs."

# ── 7. Upload to Key Vault ───────────────────────────────────────────────────
echo ""
echo "==> Uploading 4 secrets to Key Vault '$VAULT'..."

az keyvault secret set --vault-name "$VAULT" --name docker-tls-ca \
  --file "$LOCAL_TMP/ca.pem" --output none
az keyvault secret set --vault-name "$VAULT" --name docker-tls-cert \
  --file "$LOCAL_TMP/client-cert.pem" --output none
az keyvault secret set --vault-name "$VAULT" --name docker-tls-key \
  --file "$LOCAL_TMP/client-key.pem" --output none
az keyvault secret set --vault-name "$VAULT" --name docker-ssh-key \
  --file "$SSH_KEY" --output none

echo "  Uploaded."

# ── 8. Verify secrets ────────────────────────────────────────────────────────
echo ""
echo "==> Verifying Key Vault secrets..."

for secret in docker-tls-ca docker-tls-cert docker-tls-key docker-ssh-key; do
  if az keyvault secret show --vault-name "$VAULT" --name "$secret" \
       --query "name" -o tsv > /dev/null 2>&1; then
    echo "  OK  $secret"
  else
    echo "  MISSING  $secret"
    exit 1
  fi
done

# ── 9. Patch autonomous.config.yaml ──────────────────────────────────────────
echo ""
echo "==> Patching autonomous.config.yaml..."

CONFIG_FILE="autonomous.config.yaml"
if [[ -f "$CONFIG_FILE" ]]; then
  # Update ip
  sed -i "s|ip: \".*\"|ip: \"$VM_IP\"|" "$CONFIG_FILE"
  # Update ssh_user
  sed -i "s|ssh_user: .*|ssh_user: $VM_USER|" "$CONFIG_FILE"
  echo "  Set ip=$VM_IP, ssh_user=$VM_USER"
else
  echo "  WARNING: $CONFIG_FILE not found, skipping."
fi

# ── 10. Patch remote-docker.ts REMOTE_BASE ───────────────────────────────────
echo ""
echo "==> Patching src/execution/preview/remote-docker.ts..."

TS_FILE="src/execution/preview/remote-docker.ts"
if [[ -f "$TS_FILE" ]]; then
  sed -i "s|const REMOTE_BASE = \"/home/[^\"]*\"|const REMOTE_BASE = \"/home/$VM_USER/hive-previews\"|" "$TS_FILE"
  echo "  Set REMOTE_BASE=/home/$VM_USER/hive-previews"
else
  echo "  WARNING: $TS_FILE not found, skipping."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "  Setup complete"
echo "  VM:        $VM_NAME ($VM_IP)"
echo "  User:      $VM_USER"
echo "  Vault:     $VAULT (4 secrets)"
echo "  TLS from:  $TLS_DIR"
echo "  Config:    autonomous.config.yaml patched"
echo "  Code:      remote-docker.ts patched"
echo "════════════════════════════════════════════════════════"
