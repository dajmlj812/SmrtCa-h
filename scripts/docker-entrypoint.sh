#!/bin/sh
# 0.18.13 — Docker entrypoint for the smrtcash-app container.
#
# Reads boot-time settings from the app_settings table BEFORE starting
# Node, so settings edited via the /settings UI take effect on the next
# restart. The two flavors:
#
#   • NODE_OPTIONS (free-form Node flags string)
#   • HEAP_MAX_MB (operator-friendly heap cap; we translate to a
#     --max-old-space-size=$N flag appended to NODE_OPTIONS)
#
# Plus three values that the Node modules read from process.env at
# module-load time and must be in env BEFORE Node starts:
#   PG_POOL_MAX, OCR_TIMEOUT_MS, SLOW_QUERY_THRESHOLD_MS
#
# Order matters:
#   1. For each key: prefer the existing container env (compose /
#      .env override). Otherwise pull from app_settings.
#   2. Append --max-old-space-size from HEAP_MAX_MB if NODE_OPTIONS
#      doesn't already specify it.
#   3. Run migrations (idempotent — existing schemas are left alone).
#   4. exec node so docker signals reach Node directly via tini.
#
# Emergency-recovery path: if the DB-stored values are broken (e.g.
# operator typo set heap to 32MB and now Node OOMs at boot), set the
# value in the container env (docker-compose.yml or host .env) — the
# entrypoint honors env over DB.

set -e

load_setting() {
  # load_setting <key> [-> existing env var name (default = key)]
  key="$1"
  envname="${2:-$1}"
  # Already set in env? Honor it (emergency recovery).
  current=$(eval "echo \"\${$envname:-}\"")
  if [ -n "$current" ]; then
    return 0
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    return 0
  fi
  # psql ships in the runtime image. The AND value <> '' guard
  # protects against blank rows from a botched edit.
  staged=$(psql "$DATABASE_URL" -tA -c \
    "SELECT value FROM app_settings WHERE key='$key' AND value <> '' LIMIT 1" \
    2>/dev/null || true)
  if [ -n "$staged" ]; then
    eval "export $envname=\"\$staged\""
    echo "[entrypoint] $envname loaded from app_settings" >&2
  fi
}

load_setting NODE_OPTIONS
load_setting HEAP_MAX_MB
load_setting PG_POOL_MAX
load_setting OCR_TIMEOUT_MS
load_setting SLOW_QUERY_THRESHOLD_MS
# 0.19.4 — observability knobs.
load_setting SLOW_ROUTE_THRESHOLD_MS
load_setting SENTRY_DSN

# Translate HEAP_MAX_MB → --max-old-space-size=$N. Only do this when:
#   (a) HEAP_MAX_MB is set, AND
#   (b) NODE_OPTIONS doesn't already contain --max-old-space-size
# Otherwise the explicit operator-set NODE_OPTIONS wins.
if [ -n "${HEAP_MAX_MB:-}" ]; then
  case "${NODE_OPTIONS:-}" in
    *--max-old-space-size=*)
      echo "[entrypoint] HEAP_MAX_MB ignored — NODE_OPTIONS already has --max-old-space-size" >&2
      ;;
    *)
      # Validate it's a positive integer; reject anything else so a
      # typo doesn't break boot.
      if echo "$HEAP_MAX_MB" | grep -Eq '^[0-9]+$' && [ "$HEAP_MAX_MB" -ge 128 ] && [ "$HEAP_MAX_MB" -le 32768 ]; then
        export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$HEAP_MAX_MB"
        echo "[entrypoint] heap cap set to ${HEAP_MAX_MB}MB via NODE_OPTIONS='$NODE_OPTIONS'" >&2
      else
        echo "[entrypoint] HEAP_MAX_MB='$HEAP_MAX_MB' is invalid (need 128-32768) — ignoring" >&2
      fi
      ;;
  esac
fi

# Run migrations then hand off to Node. exec replaces this shell so
# SIGTERM from docker reaches Node cleanly through tini.
node dist/db/migrate.js
exec node dist/index.js
