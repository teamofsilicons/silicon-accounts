#!/usr/bin/env bash
# Runs suites of the browser walk in parallel, each on an isolated stack of its own (scripts/e2e.sh on its own port
# base: 9600, 9610, 9620, …), builds the Rust binaries once, waits for every run and merges their reports into
# web/e2e/.artifacts/summary.md and summary.json (pass or fail per run, journey and check, timings, metrics).
# web/e2e/README.md is the guide.
#
#   scripts/e2e-all.sh                           every suite: core (web/e2e/journeys) and each web/e2e/suites/<suite>
#   scripts/e2e-all.sh core silicons             these suites
#   scripts/e2e-all.sh --engines chromium,webkit every suite in both browsers (a stack per suite and browser)
#   scripts/e2e-all.sh --webkit                  WebKit only (default Chromium)
#   scripts/e2e-all.sh --jobs 4                  at most 4 stacks at a time (default: every run at once, at most 10)
#   scripts/e2e-all.sh --base 9700               the first port base (default 9600); run n asks for base + 10·n and
#                                                takes the next free one when that is busy (scripts/e2e.sh leases it)
#   scripts/e2e-all.sh --no-build                use the Rust binaries already built
#   scripts/e2e-all.sh --dev                     the sites on `next dev` instead of production builds
#   scripts/e2e-all.sh --keep                    leave every stack running (scripts/stop.sh --all --clean stops them)
#
# Each run keeps its output and report in web/e2e/.artifacts/runs/<n>-<suite>-<browser>/ (run.log, report.md,
# report.json, shots/, logs/: copied from web/e2e/.artifacts/<base>/ when it ends, so a later run on the same base
# cannot overwrite them). CARGO_TARGET_DIR [target]. Exit 0 when every run passed, 1 when anything failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
fail() {
  printf 'error: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf 'hint: %s\n' "$2" >&2
  exit 2
}
say() { printf 'e2e-all: %s\n' "$*"; }

ENGINES="chromium"
JOBS=""
BASE_START="${E2E_BASE_START:-9600}"
BUILD=1
PASS=()
SUITES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --engines) [ $# -gt 1 ] || fail "--engines needs a list like chromium,webkit"; ENGINES="$2"; shift ;;
    --engines=*) ENGINES="${1#--engines=}" ;;
    --webkit) ENGINES=webkit ;;
    --chromium) ENGINES=chromium ;;
    --jobs|-j) [ $# -gt 1 ] || fail "--jobs needs a number"; JOBS="$2"; shift ;;
    --jobs=*) JOBS="${1#--jobs=}" ;;
    --base) [ $# -gt 1 ] || fail "--base needs a port number"; BASE_START="$2"; shift ;;
    --base=*) BASE_START="${1#--base=}" ;;
    --no-build) BUILD=0 ;;
    --dev) PASS+=(--dev) ;;
    --keep) PASS+=(--keep) ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option '$1'" "scripts/e2e-all.sh [--engines chromium,webkit] [--jobs N] [--base 9600] [--no-build] [--dev] [--keep] [suite…]" ;;
    *) SUITES+=("$1") ;;
  esac
  shift
done
case "$BASE_START" in ''|*[!0-9]*) fail "--base must be a port number, got '$BASE_START'" ;; esac

TSX="$ROOT/web/node_modules/.bin/tsx"
[ -e "$TSX" ] || fail "web/node_modules is missing (the walk runs with the site's Playwright)" "pnpm -C web install"
[ -e "$ROOT/testkit/node_modules/.bin/tsx" ] || fail "testkit/node_modules is missing" "pnpm -C testkit install"

# Every suite there is, unless named.
if [ "${#SUITES[@]}" -eq 0 ]; then
  while IFS= read -r suite; do [ -n "$suite" ] && SUITES+=("$suite"); done < <("$TSX" "$ROOT/web/e2e/run.ts" --list-suites)
fi
[ "${#SUITES[@]}" -gt 0 ] || fail "no suites found under web/e2e"

# The runs: every suite in every browser, each on its own base.
RUN_SUITE=()
RUN_ENGINE=()
RUN_BASE=()
i=0
for suite in "${SUITES[@]}"; do
  case "$suite" in ''|*[!A-Za-z0-9._-]*) fail "'$suite' is not a suite name (scripts/e2e.sh --list shows them)" ;; esac
  for engine in $(printf '%s' "$ENGINES" | tr ',' ' '); do
    case "$engine" in chromium|webkit) ;; *) fail "--engines takes chromium and webkit, not '$engine'" ;; esac
    RUN_SUITE+=("$suite")
    RUN_ENGINE+=("$engine")
    RUN_BASE+=("$((BASE_START + 10 * i))")
    i=$((i + 1))
  done
done
TOTAL="${#RUN_SUITE[@]}"
[ "$((BASE_START + 10 * (TOTAL - 1) + 5))" -le 65535 ] || fail "$TOTAL runs from base $BASE_START run past port 65535"
if [ -z "$JOBS" ]; then JOBS="$TOTAL"; [ "$JOBS" -le 10 ] || JOBS=10; fi
case "$JOBS" in ''|*[!0-9]*|0) fail "--jobs must be a positive number, got '$JOBS'" ;; esac

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="$ROOT/$TARGET_DIR" ;; esac
export CARGO_TARGET_DIR="$TARGET_DIR"
ARTIFACTS="$ROOT/web/e2e/.artifacts"
mkdir -p "$ARTIFACTS"
rm -rf "$ARTIFACTS/summary.json" "$ARTIFACTS/summary.md" "$ARTIFACTS/runs.json" "$ARTIFACTS/runs"
mkdir -p "$ARTIFACTS/runs"

# --- once for every run: the Rust binaries and Postgres -----------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  say "building accounts-api, accounts-migrate, accounts-seed and the accounts CLI into $TARGET_DIR"
  mkdir -p "$ROOT/.dev/logs"
  cargo build -p silicon-accounts-server -p silicon-accounts-cli >"$ROOT/.dev/logs/e2e-all-build.log" 2>&1 \
    || { tail -n 40 "$ROOT/.dev/logs/e2e-all-build.log" >&2; fail "cargo build failed (log: .dev/logs/e2e-all-build.log)"; }
fi
ACCOUNTS_DB_NAME=postgres "$ROOT/scripts/dev-db.sh" >/dev/null

# --- the runs -------------------------------------------------------------------------------------------------------
PIDS=()
CODES=()
STARTED=()
SECONDS_TAKEN=()
DIRS=()
GOT_BASE=()
for ((n = 0; n < TOTAL; n++)); do
  PIDS+=("")
  CODES+=("")
  STARTED+=(0)
  SECONDS_TAKEN+=(0)
  DIRS+=("$ARTIFACTS/runs/$n-${RUN_SUITE[$n]}-${RUN_ENGINE[$n]}")
  GOT_BASE+=("")
done

stop_runs() {
  local n
  for ((n = 0; n < TOTAL; n++)); do
    if [ -n "${PIDS[$n]}" ] && [ -z "${CODES[$n]}" ] && kill -0 "${PIDS[$n]}" 2>/dev/null; then kill -TERM "${PIDS[$n]}" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap 'say "stopping every run (each tears its stack down)…"; stop_runs; exit 130' INT
trap 'stop_runs; exit 143' TERM

start_run() { # index
  local n="$1" dir="${DIRS[$1]}"
  mkdir -p "$dir"
  say "start  ${RUN_SUITE[$n]} in ${RUN_ENGINE[$n]} (asks for base ${RUN_BASE[$n]}; log: ${dir#"$ROOT"/}/run.log)"
  unset E2E_PORT_BASE
  E2E_BASE_START="${RUN_BASE[$n]}" E2E_BASE_FILE="$dir/base" \
    "$ROOT/scripts/e2e.sh" --no-build --suite "${RUN_SUITE[$n]}" --engine "${RUN_ENGINE[$n]}" ${PASS[@]+"${PASS[@]}"} \
    >"$dir/run.log" 2>&1 &
  PIDS[$n]=$!
  STARTED[$n]=$SECONDS
}

# A finished run's report, screenshots and logs move next to its run.log (the base may serve another run later).
collect_run() { # index
  local n="$1" dir="${DIRS[$1]}" base
  base="$(cat "$dir/base" 2>/dev/null || true)"
  GOT_BASE[$n]="${base:-0}"
  [ -n "$base" ] && [ -d "$ARTIFACTS/$base" ] || return 0
  local item
  for item in report.json report.md shots logs; do
    [ -e "$ARTIFACTS/$base/$item" ] && cp -R "$ARTIFACTS/$base/$item" "$dir/" 2>/dev/null || true
  done
}

next=0
running=0
done_count=0
while [ "$done_count" -lt "$TOTAL" ]; do
  while [ "$running" -lt "$JOBS" ] && [ "$next" -lt "$TOTAL" ]; do
    start_run "$next"
    next=$((next + 1))
    running=$((running + 1))
  done
  sleep 1
  for ((n = 0; n < next; n++)); do
    if [ -z "${CODES[$n]}" ] && ! kill -0 "${PIDS[$n]}" 2>/dev/null; then
      code=0
      wait "${PIDS[$n]}" || code=$?
      CODES[$n]="$code"
      SECONDS_TAKEN[$n]=$((SECONDS - STARTED[n]))
      running=$((running - 1))
      done_count=$((done_count + 1))
      collect_run "$n"
      say "$( [ "$code" = 0 ] && echo 'pass ' || echo 'FAIL ') ${RUN_SUITE[$n]} in ${RUN_ENGINE[$n]} on base ${GOT_BASE[$n]} (exit $code, ${SECONDS_TAKEN[$n]} s; ${DIRS[$n]#"$ROOT"/}/report.md)"
    fi
  done
done
trap - INT TERM

# --- the summary ------------------------------------------------------------------------------------------------------
{
  printf '['
  for ((n = 0; n < TOTAL; n++)); do
    [ "$n" -gt 0 ] && printf ','
    printf '\n  {"suite": "%s", "engine": "%s", "base": %s, "exit_code": %s, "seconds": %s, "dir": "%s"}' \
      "${RUN_SUITE[$n]}" "${RUN_ENGINE[$n]}" "${GOT_BASE[$n]}" "${CODES[$n]}" "${SECONDS_TAKEN[$n]}" "${DIRS[$n]}"
  done
  printf '\n]\n'
} >"$ARTIFACTS/runs.json"
"$TSX" "$ROOT/web/e2e/summary.ts" "$ARTIFACTS/runs.json" "$ARTIFACTS"
