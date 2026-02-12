#!/usr/bin/env sh
set -eu

mkdir -p \
  /app/files \
  /app/logs \
  /app/workspace \
  /app/extracted \
  /app/docs/analysis \
  /app/docs/runs \
  /app/docs/ppt \
  /app/audit

exec "$@"
