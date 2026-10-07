#!/usr/bin/env bash
# The browser end-to-end walk (web/e2e: journeys in a real browser) against a fresh stack of its own, then tears it
# down: its own ports, its own database, its own site build. Any number of these can run at the same time (each one
# leases a port base), which is how scripts/e2e-all.sh runs suites in parallel. web/e2e/README.md is the guide.
#
#   scripts/e2e.sh                       every journey of every suite, in Chromium, on a production build of the site
#   scripts/e2e.sh --suite core          one suite (repeat --suite, or comma-separate); core is web/e2e/journeys
#   scripts/e2e.sh b-apps silicons/      journeys by name prefix (or suite/prefix); what they need comes along
#   scripts/e2e.sh --webkit              walk in WebKit (or --engine webkit)
#   scripts/e2e.sh --dev                 the site on `next dev` instead of a production build
#   scripts/e2e.sh --no-build            use the Rust binaries already built (scripts/e2e-all.sh builds them once)
#   scripts/e2e.sh --keep                leave the stack running, keep its database and site build
#   scripts/e2e.sh --list                list the suites and journeys, start nothing
#
# Ports: the base is the site's port; accounts-api is base-1, mock-oidc base+1, mock-messaging base+2, the fake apps
# base+3, mock Iris base+4, the developer platform base+5 (when developer/ has its Next.js app; its build is
# developer/.next-<base>/). E2E_PORT_BASE (or --base N) picks it; otherwise the first free base of 9600, 9610, … 9990
# (from E2E_BASE_START when set) is leased (.dev/locks/e2e-<base>/ while this runs), so parallel runs never collide.
# E2E_BASE_FILE=<path>: write the base this run got there as soon as it has it (scripts/e2e-all.sh reads it).
# Per stack: database accounts_e2e_<base> (dropped afterwards), site build web/.next-<base>/ (deleted afterwards),
# logs .dev/logs/<base>/ (copied to the artifacts), artifacts web/e2e/.artifacts/<base>/ (report.json, report.md,
# shots/, logs/). The stack trusts X-Forwarded-For (each browser context and journey has its own address).
# CARGO_TARGET_DIR [target]. Exit 0 when every selected journey passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
fail() {
  printf 'error: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf 'hint: %s\n' "$2" >&2
  exit 2
}

KEEP=0
ENGINE="${E2E_ENGINE:-chromium}"
PROD=1
NO_BUILD=0
LIST=0
BASE="${E2E_PORT_BASE:-}"
RUN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --no-build) NO_BUILD=1 ;;
    --dev) PROD=0 ;;
    --prod) PROD=1 ;;
    --webkit) ENGINE=webkit ;;
    --chromium) ENGINE=chromium ;;
    --engine) [ $# -gt 1 ] || fail "--engine needs chromium or webkit"; ENGINE="$2"; shift ;;
    --engine=*) ENGINE="${1#--engine=}" ;;
    --base) [ $# -gt 1 ] || fail "--base needs a port number"; BASE="$2"; shift ;;
    --base=*) BASE="${1#--base=}" ;;
    --suite|-s) [ $# -gt 1 ] || fail "--suite needs a suite name"; RUN_ARGS+=(--suite "$2"); shift ;;
    --suite=*) RUN_ARGS+=(--suite "${1#--suite=}") ;;
    --list) LIST=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option '$1'" "scripts/e2e.sh [--suite <name>] [--webkit] [--dev] [--keep] [--no-build] [--base N] [--list] [journey…]" ;;
    *) RUN_ARGS+=("$1") ;;
  esac
  shift
done
case "$ENGINE" in chromium|webkit) ;; *) fail "--engine is chromium or webkit, not '$ENGINE'" ;; esac

if [ ! -e "$ROOT/web/node_modules/.bin/tsx" ]; then
  fail "web/node_modules is missing (the walk runs with the site's Playwright)" "pnpm -C web install"
fi
TSX="$ROOT/web/node_modules/.bin/tsx"

if [ "$LIST" = 1 ]; then
  exec "$TSX" "$ROOT/web/e2e/run.ts" --list
fi

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
PGPORT="${ACCOUNTS_PGPORT:-5444}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="$ROOT/$TARGET_DIR" ;; esac

# --- the port base: leased, so two runs never take the same one ---------------------------------------------------
LOCKS="$ROOT/.dev/locks"
mkdir -p "$LOCKS"
LEASE=""
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
ports_free() { # base
  local offset
  for offset in -1 0 1 2 3 4 5; do
    if port_busy "$(($1 + offset))"; then return 1; fi
  done
  return 0
}
# Takes .dev/locks/e2e-<base> (mkdir is atomic); a lease whose run is gone (its pid is dead) is taken over.
lease() { # base
  local dir="$LOCKS/e2e-$1" owner
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$dir/pid"
    LEASE="$dir"
    return 0
  fi
  owner="$(cat "$dir/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    # Rename first: of several runs taking over the same dead lease, only one rename succeeds.
    if mv "$dir" "$dir.stale.$$" 2>/dev/null; then
      rm -rf "$dir.stale.$$"
      if mkdir "$dir" 2>/dev/null; then
        printf '%s\n' "$$" >"$dir/pid"
        LEASE="$dir"
        return 0
      fi
    fi
  fi
  return 1
}
release() { [ -n "$LEASE" ] && rm -rf "$LEASE"; LEASE=""; }

if [ -n "$BASE" ]; then
  case "$BASE" in ''|*[!0-9]*) fail "the port base must be a number, got '$BASE'" ;; esac
  [ "$BASE" -ge 1025 ] && [ "$BASE" -le 65530 ] || fail "the port base must be between 1025 and 65530, got $BASE"
  lease "$BASE" || fail "port base $BASE is leased by another e2e run (pid $(cat "$LOCKS/e2e-$BASE/pid" 2>/dev/null || echo '?'))" \
    "pick another one (E2E_PORT_BASE=9610 …), or leave it out and a free base is chosen"
  if ! ports_free "$BASE"; then
    release
    fail "a port of base $BASE ($((BASE - 1))–$((BASE + 5))) is in use" "stop what holds it, or leave E2E_PORT_BASE out and a free base is chosen"
  fi
else
  # From E2E_BASE_START up to 9990, then from 9600 up to it: the first base that can be leased and whose ports are free.
  start="${E2E_BASE_START:-9600}"
  case "$start" in ''|*[!0-9]*) fail "E2E_BASE_START must be a port number, got '$start'" ;; esac
  first=""
  wrap=""
  [ "$start" -le 9990 ] && first="$(seq "$start" 10 9990)"
  [ "$start" -gt 9600 ] && wrap="$(seq 9600 10 "$((start - 10))")"
  for candidate in $first $wrap; do
    if lease "$candidate"; then
      if ports_free "$candidate"; then BASE="$candidate"; break; fi
      release
    fi
  done
  [ -n "$BASE" ] || fail "no free port base between 9600 and 9990" "stop finished stacks (scripts/stop.sh --all), or set E2E_PORT_BASE"
fi
[ -z "${E2E_BASE_FILE:-}" ] || printf '%s\n' "$BASE" >"$E2E_BASE_FILE"

export ACCOUNTS_PORT="$BASE"
export ACCOUNTS_API_PORT="$((BASE - 1))"
export MOCK_OIDC_PORT="$((BASE + 1))"
export MOCK_MESSAGING_PORT="$((BASE + 2))"
export FAKE_APPS_PORT="$((BASE + 3))"
export MOCK_IRIS_PORT="$((BASE + 4))"
export DEVELOPER_PORT="$((BASE + 5))"
export ACCOUNTS_DB_NAME="${E2E_DB_NAME:-accounts_e2e_$BASE}"
export NEXT_DIST_DIR=".next-$BASE"
export DEVELOPER_NEXT_DIST_DIR=".next-$BASE"
export ACCOUNTS_TRUST_FORWARDED_FOR=true
unset ACCOUNTS_PUBLIC_URL ACCOUNTS_EXTRA_ALLOWED_ORIGINS ACCOUNTS_WEB_DIST ACCOUNTS_IRIS_BASE_URL ACCOUNTS_WEB_DIR \
  ACCOUNTS_DEVELOPER_URL ACCOUNTS_DEVELOPER_DIR
ARTIFACTS="$ROOT/web/e2e/.artifacts/$BASE"
LOG_DIR="$ROOT/.dev/logs/$BASE"

# A fresh artifacts directory (a stale report must never pass for this run's), keeping run.log, which
# scripts/e2e-all.sh writes there while this runs.
mkdir -p "$ARTIFACTS"
rm -rf "$ARTIFACTS/report.json" "$ARTIFACTS/report.md" "$ARTIFACTS/shots" "$ARTIFACTS/logs"

say() { printf 'e2e: %s\n' "$*"; }
STATUS=1
teardown() {
  local code=$?
  trap - EXIT INT TERM
  # The stack's own logs go with the report.
  if [ -d "$LOG_DIR" ]; then
    mkdir -p "$ARTIFACTS/logs"
    cp "$LOG_DIR"/*.log "$ARTIFACTS/logs/" 2>/dev/null || true
  fi
  if [ "$KEEP" = 1 ]; then
    say "the stack keeps running on base $BASE (database $ACCOUNTS_DB_NAME, site build web/$NEXT_DIST_DIR, developer platform on :$DEVELOPER_PORT); its ports keep other runs off the base"
    say "stop it: ACCOUNTS_PORT=$BASE scripts/stop.sh --clean   walk it again: E2E_PORT_BASE=$BASE pnpm -C web e2e [journey…]"
  else
    ACCOUNTS_PORT="$BASE" "$ROOT/scripts/stop.sh" --quiet --clean || true
    rm -rf "$ROOT/web/$NEXT_DIST_DIR" "$ROOT/web/$NEXT_DIST_DIR.tsconfig.json" "$ROOT/.dev/run/$BASE"
    rm -rf "$ROOT/developer/$DEVELOPER_NEXT_DIST_DIR" "$ROOT/developer/$DEVELOPER_NEXT_DIST_DIR.tsconfig.json"
    PGOPTIONS='--client-min-messages=warning' "$PG_BIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U postgres --if-exists --force "$ACCOUNTS_DB_NAME" 2>/dev/null || true
    rm -f "$ROOT/.dev/seed/$ACCOUNTS_DB_NAME-$PGPORT.sha256"
  fi
  release
  exit "$code"
}
trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "base $BASE: site http://localhost:$BASE, developer platform http://localhost:$DEVELOPER_PORT, accounts-api :$ACCOUNTS_API_PORT, database $ACCOUNTS_DB_NAME, site build web/$NEXT_DIST_DIR ($ENGINE)"
DEV_FLAGS=(--detach --reset-db --web=next)
[ "$PROD" = 1 ] && DEV_FLAGS+=(--prod)
[ "$NO_BUILD" = 1 ] && DEV_FLAGS+=(--no-build)
"$ROOT/scripts/dev.sh" "${DEV_FLAGS[@]}"

echo
STATUS=0
E2E_PORT_BASE="$BASE" \
E2E_SITE="http://localhost:$BASE" \
E2E_DEVELOPER="http://localhost:$DEVELOPER_PORT" \
E2E_API="http://127.0.0.1:$ACCOUNTS_API_PORT" \
E2E_MESSAGING="http://127.0.0.1:$MOCK_MESSAGING_PORT" \
E2E_OIDC="http://127.0.0.1:$MOCK_OIDC_PORT" \
E2E_APPS="http://127.0.0.1:$FAKE_APPS_PORT" \
E2E_IRIS="http://127.0.0.1:$MOCK_IRIS_PORT" \
E2E_DB="postgres://postgres@127.0.0.1:$PGPORT/$ACCOUNTS_DB_NAME" \
E2E_PG_BIN="$PG_BIN" \
E2E_CLI="$TARGET_DIR/debug/accounts" \
E2E_ENGINE="$ENGINE" \
E2E_ARTIFACTS="$ARTIFACTS" \
  "$TSX" "$ROOT/web/e2e/run.ts" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} || STATUS=$?
exit "$STATUS"
