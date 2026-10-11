#!/usr/bin/env bash
# Deploy Astra Insights for Kearney to Azure from Cloud Shell (bash) with Azure CLI only.
#
#   Azure Container Registry (image built in the cloud by `az acr build`, no local Docker needed)
#   Azure Database for PostgreSQL Flexible Server (Postgres 16)
#   Azure Container Apps (external HTTPS ingress, 1–2 replicas)
#
# Usage (from the repository root, in Cloud Shell):
#   chmod +x infra/*.sh
#   ./infra/deploy.sh                 # first run creates everything; later runs rebuild the image and update the app
#   LOCATION=northeurope ./infra/deploy.sh
#   WITH_AI=true ./infra/deploy.sh    # also create Azure OpenAI (gpt-4o-mini) and Azure AI Speech and wire them in
#
# Generated names and the database password are kept in infra/.deploy.env (git-ignored) so re-runs are idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> Astra Insights for Kearney: Azure deployment ($(date -u +%H:%M:%S) UTC)"

SUBSCRIPTION=${SUBSCRIPTION:-Microsoft Azure Sponsorship}
PREFIX=${PREFIX:-astra}
LOCATION=${LOCATION:-westeurope}
RG=${RG:-rg-${PREFIX}-insights}
ENVFILE=infra/.deploy.env
if [ -f "$ENVFILE" ]; then source "$ENVFILE"; echo "==> Re-using settings from $ENVFILE"; fi
SUFFIX=${SUFFIX:-$(openssl rand -hex 8 | cut -c1-5)}
ACR=${ACR:-acr${PREFIX}${SUFFIX}}
PG_SERVER=${PG_SERVER:-pg-${PREFIX}-${SUFFIX}}
PG_ADMIN=${PG_ADMIN:-astraadmin}
PG_PASSWORD=${PG_PASSWORD:-$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24)}
PG_DB=${PG_DB:-astra}
CAE=${CAE:-cae-${PREFIX}-${SUFFIX}}
APP=${APP:-ca-${PREFIX}-insights}
DEMO_TODAY=${DEMO_TODAY:-2026-10-13}
WITH_AI=${WITH_AI:-false}
AOAI=${AOAI:-aoai-${PREFIX}-${SUFFIX}}
SPEECH=${SPEECH:-speech-${PREFIX}-${SUFFIX}}
AOAI_DEPLOYMENT=${AOAI_DEPLOYMENT:-gpt-4o-mini}
TAG=$(date -u +%Y%m%d%H%M%S)
IMAGE="${ACR}.azurecr.io/astra-insights:${TAG}"

cat > "$ENVFILE" <<EOF
SUFFIX=$SUFFIX
RG=$RG
LOCATION=$LOCATION
ACR=$ACR
PG_SERVER=$PG_SERVER
PG_ADMIN=$PG_ADMIN
PG_PASSWORD=$PG_PASSWORD
PG_DB=$PG_DB
CAE=$CAE
APP=$APP
AOAI=$AOAI
SPEECH=$SPEECH
AOAI_DEPLOYMENT=$AOAI_DEPLOYMENT
EOF
echo "==> Settings saved to $ENVFILE (resource group $RG, location $LOCATION, suffix $SUFFIX)"

echo "==> Subscription: $SUBSCRIPTION"
az account set --subscription "$SUBSCRIPTION"
az account show --query "{name:name, id:id, tenant:tenantId}" -o table

echo "==> Providers and extensions"
az extension add --name containerapp --upgrade --only-show-errors >/dev/null
az provider register -n Microsoft.App --wait >/dev/null
az provider register -n Microsoft.OperationalInsights --wait >/dev/null
az provider register -n Microsoft.DBforPostgreSQL --wait >/dev/null
az provider register -n Microsoft.ContainerRegistry --wait >/dev/null

echo "==> Resource group"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Container registry $ACR"
if ! az acr show -n "$ACR" -g "$RG" -o none 2>/dev/null; then
  az acr create -n "$ACR" -g "$RG" -l "$LOCATION" --sku Basic --admin-enabled true -o none
fi
echo "==> Building image in the cloud: $IMAGE (about 2 minutes)"
az acr build --registry "$ACR" --image "astra-insights:${TAG}" --file Dockerfile . -o none
ACR_USER=$(az acr credential show -n "$ACR" --query username -o tsv)
ACR_PASS=$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)

echo "==> PostgreSQL flexible server $PG_SERVER (about 5 minutes on first run)"
if ! az postgres flexible-server show -n "$PG_SERVER" -g "$RG" -o none 2>/dev/null; then
  az postgres flexible-server create -n "$PG_SERVER" -g "$RG" -l "$LOCATION" \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --sku-name Standard_B2s --tier Burstable --storage-size 32 --version 16 \
    --public-access 0.0.0.0 --yes -o none
fi
echo "==> Database $PG_DB"
az postgres flexible-server db show -g "$RG" -s "$PG_SERVER" -d "$PG_DB" -o none 2>/dev/null || az postgres flexible-server db create -g "$RG" -s "$PG_SERVER" -d "$PG_DB" -o none
PG_HOST=$(az postgres flexible-server show -n "$PG_SERVER" -g "$RG" --query fullyQualifiedDomainName -o tsv)
DATABASE_URL="postgres://${PG_ADMIN}:${PG_PASSWORD}@${PG_HOST}:5432/${PG_DB}?sslmode=require"

AI_ENV=()
AI_SECRETS=()
if [ "$WITH_AI" = "true" ]; then
  echo "==> Azure OpenAI $AOAI and Azure AI Speech $SPEECH (regions with gpt-4o-mini availability only)"
  az provider register -n Microsoft.CognitiveServices --wait >/dev/null
  az cognitiveservices account show -n "$AOAI" -g "$RG" -o none 2>/dev/null || \
    az cognitiveservices account create -n "$AOAI" -g "$RG" -l "$LOCATION" --kind OpenAI --sku S0 --custom-domain "$AOAI" --yes -o none
  az cognitiveservices account deployment show -n "$AOAI" -g "$RG" --deployment-name "$AOAI_DEPLOYMENT" -o none 2>/dev/null || \
    az cognitiveservices account deployment create -n "$AOAI" -g "$RG" --deployment-name "$AOAI_DEPLOYMENT" --model-name gpt-4o-mini --model-version "2024-07-18" --model-format OpenAI --sku-capacity 10 --sku-name Standard -o none
  az cognitiveservices account show -n "$SPEECH" -g "$RG" -o none 2>/dev/null || \
    az cognitiveservices account create -n "$SPEECH" -g "$RG" -l "$LOCATION" --kind SpeechServices --sku S0 --yes -o none
  AOAI_ENDPOINT=$(az cognitiveservices account show -n "$AOAI" -g "$RG" --query properties.endpoint -o tsv)
  AOAI_KEY=$(az cognitiveservices account keys list -n "$AOAI" -g "$RG" --query key1 -o tsv)
  SPEECH_KEY=$(az cognitiveservices account keys list -n "$SPEECH" -g "$RG" --query key1 -o tsv)
  AI_SECRETS=(aoai-key="$AOAI_KEY" speech-key="$SPEECH_KEY")
  AI_ENV=(AZURE_OPENAI_ENDPOINT="$AOAI_ENDPOINT" AZURE_OPENAI_API_KEY=secretref:aoai-key AZURE_OPENAI_DEPLOYMENT="$AOAI_DEPLOYMENT" AZURE_SPEECH_KEY=secretref:speech-key AZURE_SPEECH_REGION="$LOCATION")
fi

echo "==> Container Apps environment $CAE"
if ! az containerapp env show -n "$CAE" -g "$RG" -o none 2>/dev/null; then
  az containerapp env create -n "$CAE" -g "$RG" -l "$LOCATION" -o none
fi

echo "==> Container app $APP"
if ! az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  az containerapp create -n "$APP" -g "$RG" --environment "$CAE" \
    --image "$IMAGE" --registry-server "${ACR}.azurecr.io" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --target-port 8080 --ingress external --min-replicas 1 --max-replicas 2 --cpu 1.0 --memory 2.0Gi \
    --secrets database-url="$DATABASE_URL" "${AI_SECRETS[@]}" \
    --env-vars DATABASE_URL=secretref:database-url PORT=8080 DEMO_TODAY="$DEMO_TODAY" DEMO_MODE=true SEED_ON_BOOT=true NODE_ENV=production "${AI_ENV[@]}" \
    -o none
else
  az containerapp registry set -n "$APP" -g "$RG" --server "${ACR}.azurecr.io" --username "$ACR_USER" --password "$ACR_PASS" -o none
  az containerapp secret set -n "$APP" -g "$RG" --secrets database-url="$DATABASE_URL" "${AI_SECRETS[@]}" -o none
  az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" \
    --set-env-vars DATABASE_URL=secretref:database-url PORT=8080 DEMO_TODAY="$DEMO_TODAY" DEMO_MODE=true SEED_ON_BOOT=true NODE_ENV=production "${AI_ENV[@]}" -o none
fi

FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo
echo "============================================================"
echo " Astra Insights for Kearney is deploying."
echo " URL:        https://${FQDN}"
echo " Health:     https://${FQDN}/api/health   (seeded: 1.0.0 once the first boot has loaded the seed, about 60 seconds)"
echo " Postgres:   ${PG_HOST}  database ${PG_DB}  user ${PG_ADMIN}  (password in ${ENVFILE})"
echo " Logs:       az containerapp logs show -n ${APP} -g ${RG} --follow"
echo " Reseed:     ./infra/reseed.sh        Destroy: ./infra/destroy.sh"
echo "============================================================"
