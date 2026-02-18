#!/usr/bin/env bash
# ── The Hive — Azure Infrastructure Teardown ─────────────────────────────────
#
# Removes ALL Azure resources created by setup.sh.
#
# Usage:
#   ./infra/teardown.sh
#   ./infra/teardown.sh --name my-hive --resource-group my-hive
#   ./infra/teardown.sh --keep-entra   # Keep Entra ID app registrations
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

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

ENVIRONMENT_NAME="the-hive"
RESOURCE_GROUP="the-hive"
KEEP_ENTRA="false"

while [[ $# -gt 0 ]]; do
  case $1 in
    --name)             ENVIRONMENT_NAME="$2"; shift 2 ;;
    --resource-group)   RESOURCE_GROUP="$2"; shift 2 ;;
    --keep-entra)       KEEP_ENTRA="true"; shift ;;
    --help)
      echo "Usage: $0 [--name NAME] [--resource-group RG] [--keep-entra]"
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

echo -e "${RED}${BOLD}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║  WARNING: This will PERMANENTLY DELETE all resources  ║"
echo "  ║  in resource group '${RESOURCE_GROUP}'."
echo "  ║                                                       ║"
echo "  ║  This includes the database and all data.             ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"
read -p "  Type '${RESOURCE_GROUP}' to confirm deletion: " CONFIRM
[[ "$CONFIRM" != "$RESOURCE_GROUP" ]] && { echo "Aborted."; exit 0; }

# ── Delete Entra ID apps ────────────────────────────────────────────────────
if [[ "$KEEP_ENTRA" == "false" ]]; then
  step "Removing Entra ID app registrations"

  for APP_NAME in "${ENVIRONMENT_NAME}-app" "${ENVIRONMENT_NAME}-github-actions"; do
    APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].id" -o tsv 2>/dev/null || true)
    if [[ -n "$APP_ID" && "$APP_ID" != "None" ]]; then
      az ad app delete --id "$APP_ID" -o none
      ok "Deleted: $APP_NAME"
    else
      ok "Not found (already deleted): $APP_NAME"
    fi
  done
else
  step "Keeping Entra ID apps (--keep-entra)"
fi

# ── Delete resource group (everything else) ──────────────────────────────────
step "Deleting resource group '$RESOURCE_GROUP' and all resources"
echo "  This takes 2-5 minutes..."

if az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  az group delete --name "$RESOURCE_GROUP" --yes --no-wait
  ok "Resource group deletion initiated (running in background)"
  echo ""
  echo -e "  Monitor progress: ${BOLD}az group show -n $RESOURCE_GROUP --query properties.provisioningState -o tsv${NC}"
else
  ok "Resource group '$RESOURCE_GROUP' does not exist"
fi

echo ""
echo -e "${GREEN}${BOLD}Teardown complete.${NC}"
echo ""
