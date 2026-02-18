#!/usr/bin/env bash
# install-docker.sh — Installs Docker CE and configures TLS-secured daemon
# Run as root via Azure Custom Script Extension.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# ── Install Docker CE ────────────────────────────────────────────────────────

# Add Docker's official GPG key and repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# ── Generate self-signed TLS certificates for Docker daemon ──────────────────

CERT_DIR="/etc/docker/tls"
mkdir -p "${CERT_DIR}"

# CA key + cert
openssl genrsa -out "${CERT_DIR}/ca-key.pem" 4096
openssl req -new -x509 -days 365 -key "${CERT_DIR}/ca-key.pem" \
  -sha256 -out "${CERT_DIR}/ca.pem" -subj "/CN=docker-host-ca"

# Server key + cert
openssl genrsa -out "${CERT_DIR}/server-key.pem" 4096
openssl req -new -key "${CERT_DIR}/server-key.pem" \
  -subj "/CN=$(hostname)" -out "${CERT_DIR}/server.csr"

# Detect the VM's private and public IP addresses for the SAN
PRIVATE_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s -H Metadata:true --noproxy "*" \
  "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text" \
  2>/dev/null || true)

SAN="IP:127.0.0.1"
[ -n "${PRIVATE_IP}" ] && SAN="${SAN},IP:${PRIVATE_IP}"
[ -n "${PUBLIC_IP}" ] && SAN="${SAN},IP:${PUBLIC_IP}"

echo "subjectAltName = ${SAN}" > "${CERT_DIR}/extfile.cnf"
echo "extendedKeyUsage = serverAuth" >> "${CERT_DIR}/extfile.cnf"

openssl x509 -req -days 365 -sha256 \
  -in "${CERT_DIR}/server.csr" \
  -CA "${CERT_DIR}/ca.pem" \
  -CAkey "${CERT_DIR}/ca-key.pem" \
  -CAcreateserial \
  -out "${CERT_DIR}/server-cert.pem" \
  -extfile "${CERT_DIR}/extfile.cnf"

# Client key + cert (for the Container App to authenticate)
# TODO: After this script runs, the client certs (ca.pem, client-cert.pem, client-key.pem)
# must be uploaded to Azure Key Vault so the Container App can retrieve them.
# Manual step: az keyvault secret set --vault-name <vault> --name docker-ca --file /etc/docker/tls/ca.pem
#              az keyvault secret set --vault-name <vault> --name docker-client-cert --file /etc/docker/tls/client-cert.pem
#              az keyvault secret set --vault-name <vault> --name docker-client-key --file /etc/docker/tls/client-key.pem
openssl genrsa -out "${CERT_DIR}/client-key.pem" 4096
openssl req -new -key "${CERT_DIR}/client-key.pem" \
  -subj "/CN=client" -out "${CERT_DIR}/client.csr"

echo "extendedKeyUsage = clientAuth" > "${CERT_DIR}/client-extfile.cnf"

openssl x509 -req -days 365 -sha256 \
  -in "${CERT_DIR}/client.csr" \
  -CA "${CERT_DIR}/ca.pem" \
  -CAkey "${CERT_DIR}/ca-key.pem" \
  -CAcreateserial \
  -out "${CERT_DIR}/client-cert.pem" \
  -extfile "${CERT_DIR}/client-extfile.cnf"

# Restrict permissions
chmod 0400 "${CERT_DIR}"/*-key.pem
chmod 0444 "${CERT_DIR}"/ca.pem "${CERT_DIR}"/*-cert.pem

# Clean up CSR and temp files
rm -f "${CERT_DIR}"/*.csr "${CERT_DIR}"/*.cnf "${CERT_DIR}"/*.srl

# ── Configure Docker daemon for TLS on tcp://0.0.0.0:2376 ───────────────────

cat > /etc/docker/daemon.json <<'DAEMON_JSON'
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
  "tls": true,
  "tlsverify": true,
  "tlscacert": "/etc/docker/tls/ca.pem",
  "tlscert": "/etc/docker/tls/server-cert.pem",
  "tlskey": "/etc/docker/tls/server-key.pem",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
DAEMON_JSON

# Override systemd unit to remove -H fd:// (conflicts with daemon.json hosts)
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/override.conf <<'OVERRIDE'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd
OVERRIDE

# ── Enable and start Docker ──────────────────────────────────────────────────

systemctl daemon-reload
systemctl enable docker
systemctl restart docker

echo "Docker CE installed and configured with TLS on port 2376."
