#!/usr/bin/env bash
# Remove everything deploy.sh created (the whole resource group). Irreversible.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/.deploy.env
az account set --subscription "${SUBSCRIPTION:-Microsoft Azure Sponsorship}"
read -r -p "Delete resource group ${RG} and everything in it? [y/N] " ans
[ "${ans:-N}" = "y" ] || { echo "Cancelled."; exit 0; }
az group delete -n "$RG" --yes --no-wait
echo "Deletion started for ${RG}. Remove infra/.deploy.env to start fresh next time."
