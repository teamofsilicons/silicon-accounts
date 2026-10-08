#!/usr/bin/env bash
# Runs the testkit journeys (testkit/journeys/: the non-browser walks through every part of
# Silicon Accounts with the testkit helpers and the real `silicon-accounts` CLI) against a fresh,
# isolated stack, then tears it down.
#
#   scripts/journeys.sh                 build, start a stack with a new database, run every journey,
#                                       stop the stack, drop the database. API only: browsers, apps
#                                       and the CLI talk to accounts-api directly (no site in front)
#   scripts/journeys.sh --proxy         the same through scripts/dev-proxy.mjs, which forwards
#                                       /v1/* and /.well-known/* exactly like the Next.js site's
#                                       rewrites: every call (cookies, Set-Cookie, Location, Origin,
#                                       X-Forwarded-For, Apple's form_post) crosses the proxy
#   scripts/journeys.sh --next          the same through the real Next.js site (web/ must have it;
#                                       add --prod for a production build)
#   scripts/journeys.sh c e-import      only the journeys whose file name starts with these
#   scripts/journeys.sh --no-build      use the binaries already built
#   scripts/journeys.sh --keep          leave the stack running and keep the database afterwards
#
# Ports: JOURNEYS_PORT_BASE [9690] is the public site (proxy or Next.js), accounts-api is base-1,
# mock-oidc base+1, mock-messaging base+2, the fake apps base+3, mock Iris base+4, and with --next the
# developer platform base+5 (when developer/ has its Next.js app). JOURNEYS_DB_NAME
# [accounts_journeys_<base>], CARGO_TARGET_DIR [target]. With --next the sites build into
# web/.next-<base> and developer/.next-<base> (deleted afterwards unless --keep). The stack runs with
# ACCOUNTS_TRUST_FORWARDED_FOR=true so each journey's random X-Forwarded-For gets its own
# per-network limits. Logs: .dev/logs/<base>/. Exit 0 when every journey passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP=0
MODE=none
DEV_FLAGS=(--detach --reset-db)
JOURNEYS=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) DEV_FLAGS+=(--no-build) ;;
    --proxy) MODE=proxy ;;
    --next) MODE=next ;;
    --api-only) MODE=none ;;
    --prod) DEV_FLAGS+=(--prod) ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) echo "error: unknown option '$arg'" >&2; echo "hint: scripts/journeys.sh [--proxy | --next [--prod] | --api-only] [--keep] [--no-build] [journey…]" >&2; exit 2 ;;
    *) JOURNEYS+=("$arg") ;;
  esac
done
DEV_FLAGS+=("--web=$MODE")

BASE="${JOURNEYS_PORT_BASE:-9690}"
export ACCOUNTS_PORT="$BASE"
export ACCOUNTS_API_PORT="$((BASE - 1))"
export MOCK_OIDC_PORT="$((BASE + 1))"
export MOCK_MESSAGING_PORT="$((BASE + 2))"
export FAKE_APPS_PORT="$((BASE + 3))"
export MOCK_IRIS_PORT="$((BASE + 4))"
export DEVELOPER_PORT="$((BASE + 5))"
export NEXT_DIST_DIR=".next-$BASE"
export DEVELOPER_NEXT_DIST_DIR=".next-$BASE"
export ACCOUNTS_DB_NAME="${JOURNEYS_DB_NAME:-accounts_journeys_$BASE}"
export ACCOUNTS_TRUST_FORWARDED_FOR=true
unset ACCOUNTS_PUBLIC_URL ACCOUNTS_EXTRA_ALLOWED_ORIGINS ACCOUNTS_WEB_DIST ACCOUNTS_IRIS_BASE_URL ACCOUNTS_DEVELOPER_URL
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
PGPORT="${ACCOUNTS_PGPORT:-5444}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="$ROOT/$TARGET_DIR" ;; esac

# Where the journeys (browser stand-ins, apps, the CLI) reach Silicon Accounts, and its public URL.
if [ "$MODE" = none ]; then
  CALLS_URL="http://127.0.0.1:$ACCOUNTS_API_PORT"
  PUBLIC_URL="http://localhost:$ACCOUNTS_API_PORT"
else
  CALLS_URL="http://127.0.0.1:$BASE"
  PUBLIC_URL="http://localhost:$BASE"
  # The fake apps' server-to-server calls cross the front too.
  export TESTKIT_ACCOUNTS_URL="$CALLS_URL"
fi

teardown() {
  if [ "$KEEP" = 1 ]; then
    echo "journeys: the stack keeps running (ACCOUNTS_PORT=$BASE scripts/stop.sh) on database $ACCOUNTS_DB_NAME"
    return
  fi
  ACCOUNTS_PORT="$BASE" "$ROOT/scripts/stop.sh" --quiet --clean || true
  rm -rf "$ROOT/.dev/run/$BASE" "$ROOT/web/$NEXT_DIST_DIR" "$ROOT/web/$NEXT_DIST_DIR.tsconfig.json"
  rm -rf "$ROOT/developer/$DEVELOPER_NEXT_DIST_DIR" "$ROOT/developer/$DEVELOPER_NEXT_DIST_DIR.tsconfig.json"
  PGOPTIONS='--client-min-messages=warning' "$PG_BIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U postgres --if-exists --force "$ACCOUNTS_DB_NAME" 2>/dev/null || true
  rm -f "$ROOT/.dev/seed/$ACCOUNTS_DB_NAME-$PGPORT.sha256"
}
trap teardown EXIT

"$ROOT/scripts/dev.sh" "${DEV_FLAGS[@]}"

echo
case "$MODE" in
  none) echo "journeys: API only — every call goes straight to accounts-api at $CALLS_URL" ;;
  proxy) echo "journeys: through scripts/dev-proxy.mjs at $CALLS_URL (forwarding to accounts-api on :$ACCOUNTS_API_PORT)" ;;
  next) echo "journeys: through the Next.js site at $CALLS_URL (proxying to accounts-api on :$ACCOUNTS_API_PORT)" ;;
esac
ACCOUNTS_URL="$CALLS_URL" \
ACCOUNTS_PUBLIC_URL="$PUBLIC_URL" \
ACCOUNTS_DEVELOPER_URL="http://localhost:$DEVELOPER_PORT" \
ACCOUNTS_API_DIRECT_URL="http://127.0.0.1:$ACCOUNTS_API_PORT" \
JOURNEYS_FRONT="$MODE" \
MOCK_OIDC_URL="http://127.0.0.1:$MOCK_OIDC_PORT" \
MOCK_MESSAGING_URL="http://127.0.0.1:$MOCK_MESSAGING_PORT" \
FAKE_APPS_URL="http://127.0.0.1:$FAKE_APPS_PORT" \
ACCOUNTS_CLI="$TARGET_DIR/debug/silicon-accounts" \
TESTKIT_FORWARDED_FOR="${TESTKIT_FORWARDED_FOR:-random}" \
  "$ROOT/testkit/node_modules/.bin/tsx" "$ROOT/testkit/journeys/run.ts" ${JOURNEYS[@]+"${JOURNEYS[@]}"}
