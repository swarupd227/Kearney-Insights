#!/usr/bin/env bash
# Clears the demo state (drafted actions, boards, audit trail) on the deployed database and restarts the app so the
# decision queue refills itself from the predictions. The seeded firm data is untouched; use reseed.sh to reload that.
# Works from a fresh Cloud Shell: it talks to Postgres directly with psql (the server allows Azure-internal access),
# which is more reliable than running a command inside the container.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f infra/.deploy.env ]; then source infra/.deploy.env; fi
RG=${RG:-rg-astra-insights}; APP=${APP:-ca-astra-insights}
az account set --subscription "${SUBSCRIPTION:-Microsoft Azure Sponsorship}"
DBURL=$(az containerapp secret show -n "$APP" -g "$RG" --secret-name database-url --query value -o tsv)
echo "==> Clearing actions, boards and the audit trail"
psql "$DBURL" -v ON_ERROR_STOP=1 -c "TRUNCATE actions, audit_log, boards RESTART IDENTITY"
echo "==> Restarting the app so the decision queue refills from the predictions"
REV=$(az containerapp show -n "$APP" -g "$RG" --query properties.latestRevisionName -o tsv)
az containerapp revision restart -n "$APP" -g "$RG" --revision "$REV" -o none
echo "Done. The queue refills within about a minute of the restart."
