#!/usr/bin/env bash
set -euo pipefail

ACR_NAME="thehivehnv7pb"
IMAGE_NAME="hive"
RESOURCE_GROUP="the-hive"
CONTAINER_APP_NAME="the-hive"
TAG="${1:-$(git rev-parse --short HEAD)}"

FULL_IMAGE="${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${TAG}"

echo "==> Updating changelog..."
bash "$(dirname "$0")/changelog.sh"

echo "==> Logging in to ACR..."
az acr login --name "$ACR_NAME"

echo "==> Building image: ${FULL_IMAGE}"
docker build --build-arg BUILD_SHA="$(git rev-parse --short HEAD)" -t "$FULL_IMAGE" .

echo "==> Pushing image..."
docker push "$FULL_IMAGE"

echo "==> Updating container app..."
az containerapp update \
  --name "$CONTAINER_APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "$FULL_IMAGE" \
  --min-replicas 1

echo "==> Done. Waiting for health check..."
sleep 10

FQDN=$(az containerapp show \
  --name "$CONTAINER_APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn \
  --output tsv)

STATUS=$(curl -s -o /dev/null -w '%{http_code}' "https://${FQDN}/api/health" || true)
if [ "$STATUS" = "200" ]; then
  echo "==> Health check passed (200) — https://${FQDN}"
else
  echo "==> Health check returned ${STATUS} — https://${FQDN}/api/health"
fi
