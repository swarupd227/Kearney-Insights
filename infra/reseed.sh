#!/usr/bin/env bash
# Reload the seed in the deployed app (for example after replacing data/servicenow_tickets.csv or editing the seed manifest).
# Rebuild and redeploy first if files changed: ./infra/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/.deploy.env
az account set --subscription "${SUBSCRIPTION:-Microsoft Azure Sponsorship}"
echo "==> Reseeding ${APP} in ${RG} (about 30 seconds)"
az containerapp exec -n "$APP" -g "$RG" --command "node server/seed/load.js --force"
echo "==> Restarting the app so caches reload"
REV=$(az containerapp show -n "$APP" -g "$RG" --query properties.latestRevisionName -o tsv)
az containerapp revision restart -n "$APP" -g "$RG" --revision "$REV" -o none
echo "Done."
