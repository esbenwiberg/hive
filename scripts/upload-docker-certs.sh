#!/usr/bin/env bash
# Upload Docker TLS client certs + SSH key from the Docker host VM to Azure Key Vault.
# Usage: bash scripts/upload-docker-certs.sh
#
# Prerequisites:
#   - az cli logged in with Key Vault write access
#   - SSH access to the Docker host VM (the-hive-docker / 20.107.218.135)

set -euo pipefail

VAULT_NAME="the-hive-vault"
VM_HOST="20.107.218.135"
VM_USER="azureuser"
TLS_DIR="/etc/docker/tls"
LOCAL_TMP=$(mktemp -d)

trap 'rm -rf "$LOCAL_TMP"' EXIT

echo "==> Downloading TLS certs from ${VM_USER}@${VM_HOST}:${TLS_DIR}..."
scp "${VM_USER}@${VM_HOST}:${TLS_DIR}/ca.pem" "$LOCAL_TMP/ca.pem"
scp "${VM_USER}@${VM_HOST}:${TLS_DIR}/client-cert.pem" "$LOCAL_TMP/client-cert.pem"
scp "${VM_USER}@${VM_HOST}:${TLS_DIR}/client-key.pem" "$LOCAL_TMP/client-key.pem"

echo "==> Uploading TLS certs to Key Vault '${VAULT_NAME}'..."
az keyvault secret set --vault-name "$VAULT_NAME" --name docker-tls-ca \
  --file "$LOCAL_TMP/ca.pem" --output none
az keyvault secret set --vault-name "$VAULT_NAME" --name docker-tls-cert \
  --file "$LOCAL_TMP/client-cert.pem" --output none
az keyvault secret set --vault-name "$VAULT_NAME" --name docker-tls-key \
  --file "$LOCAL_TMP/client-key.pem" --output none

echo "==> Uploading SSH private key..."
SSH_KEY_PATH="${HOME}/.ssh/the-hive-docker"
if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "ERROR: SSH key not found at ${SSH_KEY_PATH}"
  echo "       Provide the path to the VM's SSH private key."
  exit 1
fi
az keyvault secret set --vault-name "$VAULT_NAME" --name docker-ssh-key \
  --file "$SSH_KEY_PATH" --output none

echo "==> Verifying secrets..."
for secret in docker-tls-ca docker-tls-cert docker-tls-key docker-ssh-key; do
  if az keyvault secret show --vault-name "$VAULT_NAME" --name "$secret" --query "name" -o tsv > /dev/null 2>&1; then
    echo "  ✓ ${secret}"
  else
    echo "  ✗ ${secret} — MISSING"
    exit 1
  fi
done

echo "==> Done. All 4 secrets uploaded to ${VAULT_NAME}."
