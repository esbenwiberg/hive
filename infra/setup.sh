#!/usr/bin/env bash
# ── The Hive — Azure Infrastructure Setup ────────────────────────────────────
#
# Creates ALL Azure resources, service principals, Key Vault secrets, Entra ID
# app registration, and GitHub federated credentials needed to run The Hive.
#
# Usage:
#   ./infra/setup.sh --anthropic-key sk-ant-... --github-repo esbenwiberg/hive
#
# Prerequisites:
#   - Azure CLI installed and logged in (az login)
#   - GitHub CLI installed and logged in (gh auth login)
#   - jq installed
#
# What this creates:
#   1. Resource group
#   2. Entra ID app registration (user auth)
#   3. All Azure infra via Bicep (PG, ACR, Key Vault, Container App, ...)
#   4. Key Vault secrets (API keys, Entra creds, session secret)
#   5. Service principal for GitHub Actions (OIDC federated)
#   6. GitHub repo secrets and variables
#   7. First Docker image build + push + deploy
#
# Re-runnable: safe to run again — skips resources that already exist.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${CYAN}${BOLD}▸ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; exit 1; }

# ── Default configuration ────────────────────────────────────────────────────
ENVIRONMENT_NAME="the-hive"
RESOURCE_GROUP="the-hive"
LOCATION="northeurope"
POSTGRES_ADMIN_PASSWORD=""
ANTHROPIC_API_KEY=""
GITHUB_REPO=""
DEPLOY_DOCKER_HOST="false"
DOCKER_HOST_SSH_KEY=""
DOCKER_HOST_ALLOWED_CIDR="*"
SKIP_FIRST_DEPLOY="false"
SKIP_GITHUB="false"
TAGS=""

# ── Parse arguments ──────────────────────────────────────────────────────────
usage() {
  cat <<USAGE
Usage: $0 [OPTIONS]

Required:
  --anthropic-key KEY         Anthropic API key (sk-ant-...)
  --github-repo OWNER/REPO   GitHub repository (e.g. esbenwiberg/hive)

Optional:
  --name NAME                 Environment name (default: the-hive)
  --resource-group RG         Resource group name (default: the-hive)
  --location LOC              Azure region (default: northeurope)
  --postgres-password PASS    PostgreSQL admin password (default: auto-generated)
  --deploy-docker-host        Deploy Docker host VM for preview environments
  --docker-host-ssh-key PATH  Path to SSH public key for Docker host
  --docker-host-cidr CIDR     Allowed source CIDR for Docker host (default: *)
  --tags 'key=val key2=val2'  Tags for the resource group (required by some policies)
  --skip-first-deploy         Skip building and deploying the first container image
  --skip-github               Skip GitHub secrets/variables setup
  --help                      Show this help

Examples:
  # Minimal — just the essentials:
  $0 --anthropic-key sk-ant-xxx --github-repo esbenwiberg/hive

  # With resource group tags (required by some Azure policies):
  $0 --anthropic-key sk-ant-xxx --github-repo esbenwiberg/hive \\
     --tags 'project=the-hive environment=production'

  # Full — with preview environments:
  $0 --anthropic-key sk-ant-xxx --github-repo esbenwiberg/hive \\
     --deploy-docker-host --docker-host-ssh-key ~/.ssh/id_rsa.pub

  # Without GitHub setup (for manual deploys):
  $0 --anthropic-key sk-ant-xxx --skip-github
USAGE
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --anthropic-key)        ANTHROPIC_API_KEY="$2"; shift 2 ;;
    --github-repo)          GITHUB_REPO="$2"; shift 2 ;;
    --name)                 ENVIRONMENT_NAME="$2"; shift 2 ;;
    --resource-group)       RESOURCE_GROUP="$2"; shift 2 ;;
    --location)             LOCATION="$2"; shift 2 ;;
    --postgres-password)    POSTGRES_ADMIN_PASSWORD="$2"; shift 2 ;;
    --deploy-docker-host)   DEPLOY_DOCKER_HOST="true"; shift ;;
    --docker-host-ssh-key)  DOCKER_HOST_SSH_KEY="$2"; shift 2 ;;
    --docker-host-cidr)     DOCKER_HOST_ALLOWED_CIDR="$2"; shift 2 ;;
    --tags)                 TAGS="$2"; shift 2 ;;
    --skip-first-deploy)    SKIP_FIRST_DEPLOY="true"; shift ;;
    --skip-github)          SKIP_GITHUB="true"; shift ;;
    --help)                 usage ;;
    *) fail "Unknown option: $1. Use --help for usage." ;;
  esac
done

# ── Validate required args ───────────────────────────────────────────────────
[[ -z "$ANTHROPIC_API_KEY" ]] && fail "Missing --anthropic-key. Use --help for usage."
if [[ "$SKIP_GITHUB" == "false" && -z "$GITHUB_REPO" ]]; then
  fail "Missing --github-repo. Use --help for usage, or pass --skip-github."
fi

# ── Check prerequisites ─────────────────────────────────────────────────────
step "Checking prerequisites"
command -v az  >/dev/null 2>&1 || fail "Azure CLI not found. Install: https://aka.ms/install-azure-cli"
command -v jq  >/dev/null 2>&1 || fail "jq not found. Install: sudo apt install jq"
az account show >/dev/null 2>&1 || fail "Not logged into Azure. Run: az login"
if [[ "$SKIP_GITHUB" == "false" ]]; then
  command -v gh >/dev/null 2>&1 || fail "GitHub CLI not found. Install: https://cli.github.com"
  gh auth status >/dev/null 2>&1 || fail "Not logged into GitHub. Run: gh auth login"
fi
ok "All prerequisites met"

# ── Resolve derived values ───────────────────────────────────────────────────
KEY_VAULT_NAME="${ENVIRONMENT_NAME}-kv"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

if [[ -z "$POSTGRES_ADMIN_PASSWORD" ]]; then
  POSTGRES_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
  warn "Auto-generated PostgreSQL password (save this): ${BOLD}${POSTGRES_ADMIN_PASSWORD}${NC}"
fi

SESSION_SECRET=$(openssl rand -hex 32)

echo ""
echo -e "${BOLD}Configuration:${NC}"
echo "  Environment:     $ENVIRONMENT_NAME"
echo "  Resource Group:  $RESOURCE_GROUP"
echo "  Location:        $LOCATION"
echo "  Subscription:    $SUBSCRIPTION_ID"
echo "  Tenant:          $TENANT_ID"
echo "  Key Vault:       $KEY_VAULT_NAME"
echo "  Docker Host:     $DEPLOY_DOCKER_HOST"
if [[ -n "$TAGS" ]]; then
  echo "  Tags:            $TAGS"
fi
if [[ "$SKIP_GITHUB" == "false" ]]; then
  echo "  GitHub Repo:     $GITHUB_REPO"
fi
echo ""

# ── 1. Resource Group ────────────────────────────────────────────────────────
step "1/8 — Creating resource group"
TAG_ARGS=()
if [[ -n "$TAGS" ]]; then
  TAG_ARGS=(--tags $TAGS)
fi
if az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  if [[ ${#TAG_ARGS[@]} -gt 0 ]]; then
    az group update --name "$RESOURCE_GROUP" "${TAG_ARGS[@]}" -o none
    ok "Resource group '$RESOURCE_GROUP' already exists — updated tags"
  else
    ok "Resource group '$RESOURCE_GROUP' already exists"
  fi
else
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" "${TAG_ARGS[@]}" -o none
  ok "Created resource group '$RESOURCE_GROUP' in $LOCATION"
fi

# ── 2. Entra ID App Registration (user auth) ────────────────────────────────
step "2/8 — Registering Entra ID application (user auth)"

# Check if app already exists
ENTRA_APP_ID=$(az ad app list --display-name "${ENVIRONMENT_NAME}-app" --query "[0].appId" -o tsv 2>/dev/null || true)

if [[ -n "$ENTRA_APP_ID" && "$ENTRA_APP_ID" != "None" ]]; then
  ok "Entra ID app already exists: $ENTRA_APP_ID"
else
  ENTRA_APP_ID=$(az ad app create \
    --display-name "${ENVIRONMENT_NAME}-app" \
    --sign-in-audience AzureADMyOrg \
    --query appId -o tsv)
  ok "Created Entra ID app: $ENTRA_APP_ID"
fi

# Create/reset client secret
ENTRA_CLIENT_SECRET=$(az ad app credential reset \
  --id "$ENTRA_APP_ID" \
  --display-name "hive-client-secret" \
  --query password -o tsv)
ok "Created Entra ID client secret"

# We'll update the redirect URI after the Container App is deployed (need the FQDN)

# ── 3. Deploy infrastructure via Bicep (without Container App first) ─────────
step "3/9 — Deploying Azure infrastructure (Bicep)"
echo "  This takes 3-5 minutes..."

DEPLOYING_USER_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -z "$DEPLOYING_USER_OID" ]]; then
  # Fallback for service principals
  DEPLOYING_USER_OID=$(az account show --query "user.name" -o tsv | xargs -I{} az ad sp show --id {} --query id -o tsv 2>/dev/null || echo "")
fi

BICEP_PARAMS=(
  "postgresAdminPassword=$POSTGRES_ADMIN_PASSWORD"
  "environmentName=$ENVIRONMENT_NAME"
  "deployDockerHost=$DEPLOY_DOCKER_HOST"
  "deployingUserObjectId=$DEPLOYING_USER_OID"
  "deployContainerApp=false"
)

if [[ "$DEPLOY_DOCKER_HOST" == "true" ]]; then
  if [[ -n "$DOCKER_HOST_SSH_KEY" ]]; then
    SSH_KEY_CONTENT=$(cat "$DOCKER_HOST_SSH_KEY")
    BICEP_PARAMS+=("dockerHostAdminSshPublicKey=$SSH_KEY_CONTENT")
  else
    fail "Docker host requires --docker-host-ssh-key <path>"
  fi
  BICEP_PARAMS+=("dockerHostAllowedSourceAddressPrefix=$DOCKER_HOST_ALLOWED_CIDR")
fi

DEPLOY_OUTPUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file infra/main.bicep \
  --parameters "${BICEP_PARAMS[@]}" \
  --query properties.outputs -o json)

ACR_NAME=$(echo "$DEPLOY_OUTPUT" | jq -r '.acrName.value')
ACR_LOGIN_SERVER=$(echo "$DEPLOY_OUTPUT" | jq -r '.acrLoginServer.value')
KV_URI=$(echo "$DEPLOY_OUTPUT" | jq -r '.keyVaultUri.value')
PG_FQDN=$(echo "$DEPLOY_OUTPUT" | jq -r '.postgresServerFqdn.value')

ok "Base infrastructure deployed"
ok "ACR:            $ACR_LOGIN_SERVER"
ok "Key Vault:      $KV_URI"
ok "PostgreSQL:     $PG_FQDN"

if [[ "$DEPLOY_DOCKER_HOST" == "true" ]]; then
  DOCKER_HOST_PUBLIC_IP=$(echo "$DEPLOY_OUTPUT" | jq -r '.dockerHostPublicIp.value')
  DOCKER_HOST_PRIVATE_IP=$(echo "$DEPLOY_OUTPUT" | jq -r '.dockerHostPrivateIp.value')
  ok "Docker Host:    $DOCKER_HOST_PUBLIC_IP (public) / $DOCKER_HOST_PRIVATE_IP (private)"
fi

# ── 4. Seed Key Vault secrets ────────────────────────────────────────────────
step "4/9 — Seeding Key Vault secrets"

# The Bicep template already creates the database-url secret.
# We need to add the rest.

set_secret() {
  local name="$1" value="$2"
  az keyvault secret set \
    --vault-name "$KEY_VAULT_NAME" \
    --name "$name" \
    --value "$value" \
    -o none 2>/dev/null
  ok "Set secret: $name"
}

set_secret "anthropic-api-key"    "$ANTHROPIC_API_KEY"
set_secret "session-secret"       "$SESSION_SECRET"
set_secret "entra-client-id"      "$ENTRA_APP_ID"
set_secret "entra-client-secret"  "$ENTRA_CLIENT_SECRET"

# ── 5. Build and push container image to ACR ─────────────────────────────────
step "5/9 — Building and pushing container image"

if [[ "$SKIP_FIRST_DEPLOY" == "false" ]]; then
  az acr login --name "$ACR_NAME"
  ok "Logged into ACR"

  echo "  Building Docker image..."
  docker build -t "${ACR_LOGIN_SERVER}/hive:latest" -t "${ACR_LOGIN_SERVER}/hive:initial" . -q
  ok "Built image"

  echo "  Pushing to ACR..."
  docker push "${ACR_LOGIN_SERVER}/hive" --all-tags -q
  ok "Pushed image to $ACR_LOGIN_SERVER"
else
  warn "Skipping image build (--skip-first-deploy)"
fi

# ── 6. Deploy Container App (needs image in ACR) ────────────────────────────
step "6/9 — Deploying Container App"

BICEP_PARAMS_FULL=(
  "postgresAdminPassword=$POSTGRES_ADMIN_PASSWORD"
  "environmentName=$ENVIRONMENT_NAME"
  "deployDockerHost=$DEPLOY_DOCKER_HOST"
  "deployingUserObjectId=$DEPLOYING_USER_OID"
  "deployContainerApp=true"
)

if [[ "$DEPLOY_DOCKER_HOST" == "true" ]]; then
  BICEP_PARAMS_FULL+=("dockerHostAdminSshPublicKey=$SSH_KEY_CONTENT")
  BICEP_PARAMS_FULL+=("dockerHostAllowedSourceAddressPrefix=$DOCKER_HOST_ALLOWED_CIDR")
fi

DEPLOY_OUTPUT_FULL=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file infra/main.bicep \
  --parameters "${BICEP_PARAMS_FULL[@]}" \
  --query properties.outputs -o json)

CONTAINER_APP_FQDN=$(echo "$DEPLOY_OUTPUT_FULL" | jq -r '.containerAppFqdn.value')
ok "Container App deployed: https://$CONTAINER_APP_FQDN"

# ── 6.5. Update Entra ID redirect URI ───────────────────────────────────────
REDIRECT_URI="https://${CONTAINER_APP_FQDN}/auth/callback"
az ad app update --id "$ENTRA_APP_ID" --web-redirect-uris "$REDIRECT_URI" -o none
ok "Set Entra redirect URI: $REDIRECT_URI"

# ── 7. GitHub Actions service principal (OIDC) ──────────────────────────────
if [[ "$SKIP_GITHUB" == "false" ]]; then
  step "7/9 — Creating GitHub Actions service principal (OIDC)"

  GH_SP_NAME="${ENVIRONMENT_NAME}-github-actions"
  GH_SP_APP_ID=$(az ad app list --display-name "$GH_SP_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)

  if [[ -n "$GH_SP_APP_ID" && "$GH_SP_APP_ID" != "None" ]]; then
    ok "Service principal app already exists: $GH_SP_APP_ID"
  else
    GH_SP_APP_ID=$(az ad app create --display-name "$GH_SP_NAME" --query appId -o tsv)
    ok "Created app registration: $GH_SP_APP_ID"
  fi

  # Ensure service principal exists
  GH_SP_OID=$(az ad sp list --filter "appId eq '$GH_SP_APP_ID'" --query "[0].id" -o tsv 2>/dev/null || true)
  if [[ -z "$GH_SP_OID" || "$GH_SP_OID" == "None" ]]; then
    GH_SP_OID=$(az ad sp create --id "$GH_SP_APP_ID" --query id -o tsv)
    ok "Created service principal"
  else
    ok "Service principal already exists"
  fi

  # Federated credential for main branch
  FED_CRED_EXISTS=$(az ad app federated-credential list --id "$GH_SP_APP_ID" --query "[?name=='github-main'].name" -o tsv 2>/dev/null || true)
  if [[ -n "$FED_CRED_EXISTS" ]]; then
    ok "Federated credential 'github-main' already exists"
  else
    az ad app federated-credential create --id "$GH_SP_APP_ID" --parameters "{
      \"name\": \"github-main\",
      \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"repo:${GITHUB_REPO}:ref:refs/heads/main\",
      \"audiences\": [\"api://AzureADTokenExchange\"]
    }" -o none
    ok "Created federated credential for ${GITHUB_REPO}:main"
  fi

  # Role assignments
  RG_SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"
  ACR_SCOPE=$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)

  # Contributor on resource group (for az containerapp update)
  az role assignment create \
    --assignee-object-id "$GH_SP_OID" \
    --assignee-principal-type ServicePrincipal \
    --role "Contributor" \
    --scope "$RG_SCOPE" \
    -o none 2>/dev/null || true
  ok "Assigned Contributor role on resource group"

  # AcrPush on ACR (for docker push)
  az role assignment create \
    --assignee-object-id "$GH_SP_OID" \
    --assignee-principal-type ServicePrincipal \
    --role "AcrPush" \
    --scope "$ACR_SCOPE" \
    -o none 2>/dev/null || true
  ok "Assigned AcrPush role on ACR"

  # ── 8. Set GitHub secrets and variables ──────────────────────────────────────
  step "8/9 — Configuring GitHub repository secrets and variables"

  gh secret set AZURE_CLIENT_ID       --repo "$GITHUB_REPO" --body "$GH_SP_APP_ID"
  ok "Set secret: AZURE_CLIENT_ID"

  gh secret set AZURE_TENANT_ID       --repo "$GITHUB_REPO" --body "$TENANT_ID"
  ok "Set secret: AZURE_TENANT_ID"

  gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION_ID"
  ok "Set secret: AZURE_SUBSCRIPTION_ID"

  gh variable set ACR_NAME            --repo "$GITHUB_REPO" --body "$ACR_NAME"
  ok "Set variable: ACR_NAME"

else
  step "7/9 — Skipping GitHub Actions setup (--skip-github)"
  step "8/9 — Skipping GitHub secrets setup (--skip-github)"
fi

# ── 9. Health check ──────────────────────────────────────────────────────────
step "9/9 — Verifying deployment"
if [[ "$SKIP_FIRST_DEPLOY" == "false" ]]; then
  echo "  Waiting for health check (up to 2 minutes)..."
  sleep 15
  if curl --fail --silent --retry 8 --retry-delay 15 --retry-max-time 120 \
    "https://${CONTAINER_APP_FQDN}/api/health" > /dev/null 2>&1; then
    ok "Health check passed"
  else
    warn "Health check did not pass yet — the app may still be starting"
    warn "Check manually: curl https://${CONTAINER_APP_FQDN}/api/health"
  fi
else
  warn "Skipped (no image deployed)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  The Hive — Setup Complete${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Dashboard:${NC}          https://${CONTAINER_APP_FQDN}"
echo -e "  ${BOLD}Health check:${NC}       https://${CONTAINER_APP_FQDN}/api/health"
echo ""
echo -e "  ${BOLD}Resource Group:${NC}     ${RESOURCE_GROUP}"
echo -e "  ${BOLD}Container App:${NC}      ${ENVIRONMENT_NAME}"
echo -e "  ${BOLD}ACR:${NC}                ${ACR_LOGIN_SERVER}"
echo -e "  ${BOLD}Key Vault:${NC}          ${KEY_VAULT_NAME}"
echo -e "  ${BOLD}PostgreSQL:${NC}         ${PG_FQDN}"
if [[ "$DEPLOY_DOCKER_HOST" == "true" ]]; then
  echo -e "  ${BOLD}Docker Host:${NC}        ${DOCKER_HOST_PUBLIC_IP}"
fi
echo ""
echo -e "  ${BOLD}Entra App ID:${NC}       ${ENTRA_APP_ID}"
echo -e "  ${BOLD}Tenant ID:${NC}          ${TENANT_ID}"
echo -e "  ${BOLD}Subscription:${NC}       ${SUBSCRIPTION_ID}"
if [[ "$SKIP_GITHUB" == "false" ]]; then
  echo -e "  ${BOLD}GitHub SP:${NC}          ${GH_SP_APP_ID}"
fi
echo ""
echo -e "  ${YELLOW}${BOLD}Save these credentials:${NC}"
echo -e "  ${BOLD}PostgreSQL password:${NC} ${POSTGRES_ADMIN_PASSWORD}"
echo -e "  ${BOLD}Session secret:${NC}      ${SESSION_SECRET}"
echo ""
if [[ "$SKIP_GITHUB" == "false" ]]; then
  echo -e "  ${BOLD}CI/CD:${NC} Push to main → tests → build → deploy (automatic)"
fi
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo "    1. Open https://${CONTAINER_APP_FQDN} and sign in with Microsoft"
echo "    2. Add your GitHub token via Profile → Credentials"
echo "    3. Add a repository via Settings → Repos"
echo "    4. Create your first task"
echo ""
