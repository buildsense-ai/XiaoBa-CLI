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

# Run skill setup scripts (if any)
for f in /app/skills/*/setup.sh; do
  [ -f "$f" ] && [ -x "$f" ] && {
    echo "Running skill setup: $f"
    "$f" || echo "Warning: $f exited with code $?"
  }
done

exec "$@"
