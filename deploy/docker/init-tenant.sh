#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <tenant_name>"
  exit 1
fi

TENANT="$1"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TENANT_DIR="$ROOT_DIR/tenants/$TENANT"
DATA_DIR="$TENANT_DIR/data"
ENV_TEMPLATE="$ROOT_DIR/deploy/docker/tenant.env.example"
ENV_FILE="$TENANT_DIR/.env"

mkdir -p \
  "$DATA_DIR/files" \
  "$DATA_DIR/logs" \
  "$DATA_DIR/workspace" \
  "$DATA_DIR/extracted" \
  "$DATA_DIR/docs_analysis" \
  "$DATA_DIR/docs_runs" \
  "$DATA_DIR/docs_ppt" \
  "$DATA_DIR/audit"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  echo "Created: $ENV_FILE"
else
  echo "Exists:  $ENV_FILE"
fi

cat <<EOF

Tenant scaffold ready: $TENANT
Path: $TENANT_DIR

Next:
1. Edit tenant env:
   vi $ENV_FILE
2. Start tenant container:
   TENANT=$TENANT docker compose -p xiaoba-$TENANT -f deploy/docker-compose.multitenant.yml up -d --build
3. Check logs:
   docker logs -f xiaoba-$TENANT
EOF
