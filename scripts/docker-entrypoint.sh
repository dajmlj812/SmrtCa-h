#!/bin/sh
# 0.18.13 — Docker entrypoint for the smrtcash-app container.
#
# Reads NODE_OPTIONS from the app_settings table BEFORE starting Node,
# so an operator who edits NODE_OPTIONS in the /settings UI and clicks
# Restart in /system gets the new value applied (e.g. a fresh
# --max-old-space-size=1024) without redeploying.
#
# Order matters:
#   1. Read NODE_OPTIONS from DB (best-effort; ignore failures so a
#      fresh install with an empty schema still boots).
#   2. Run migrations (creates / updates the schema).
#   3. exec node — replacing this shell so docker signals reach Node
#      directly via tini.
#
# Bypass: if NODE_OPTIONS is already set in the container env
# (typically from docker-compose.yml or an operator override on the
# host .env), we honor THAT value and skip the DB read. This is the
# emergency-recovery path — if the DB-stored NODE_OPTIONS is broken
# (e.g. operator typo set heap to 32MB and now Node OOMs at boot),
# the operator can set NODE_OPTIONS in compose env to undo it.

set -e

if [ -z "${NODE_OPTIONS:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  # psql is shipped by the postgresql17-client package in the
  # runtime image. -tA strips formatting; the LIMIT 1 + IS NOT NULL
  # guards against an empty-but-existing row.
  STAGED=$(psql "$DATABASE_URL" -tA -c \
    "SELECT value FROM app_settings WHERE key='NODE_OPTIONS' AND value <> '' LIMIT 1" \
    2>/dev/null || true)
  if [ -n "$STAGED" ]; then
    export NODE_OPTIONS="$STAGED"
    echo "[entrypoint] NODE_OPTIONS loaded from app_settings: $NODE_OPTIONS" >&2
  fi
fi

# Run migrations (idempotent — existing schemas are left alone) then
# hand off to Node. exec replaces this shell so SIGTERM from docker
# reaches Node cleanly through tini.
node dist/db/migrate.js
exec node dist/index.js
