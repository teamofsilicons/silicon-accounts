#!/usr/bin/env bash
# Stops what scripts/dev.sh started: the site (Next.js) or its stand-in proxy, the developer platform
# (Next.js, developer/), accounts-api and the testkit (mock Google/Apple, mock Postmark/Twilio, the fake app server).
#
#   scripts/stop.sh            the stack on ACCOUNTS_PORT (the public site port, default 8590)
#   scripts/stop.sh --all      every stack scripts/dev.sh started (all ports)
#   scripts/stop.sh --db       also stop the local Postgres (scripts/dev-db.sh stop)
#   scripts/stop.sh --clean    also delete the stack's own builds (web/.next-<port>/ and developer/.next-<port>/,
#                              recorded in .dev/run/<port>/web.dist and developer.dist; the default stack's .next
#                              directories are never deleted)
#   scripts/stop.sh --quiet    print nothing unless something goes wrong
#
# Only processes recorded in .dev/run/<port>/*.pid whose command still matches are stopped
# (SIGTERM to the whole process group, SIGKILL after a grace period), so a stale pid file
# never kills an unrelated process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ALL=0
DB=0
QUIET=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --db) DB=1 ;;
    --clean) CLEAN=1 ;;
    -q|--quiet) QUIET=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      echo "hint: scripts/stop.sh [--all] [--db] [--clean] [--quiet]" >&2
      exit 2
      ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf 'stop: %s\n' "$*"; }

# What each pid file's process must look like (so a recycled pid is never killed).
expected_command() {
  case "$1" in
    accounts-api) echo 'accounts-api' ;;
    testkit) echo 'start.ts' ;;
    web) echo "web" ;;
    developer) echo "developer" ;;
    proxy) echo 'dev-proxy.mjs' ;;
    *) echo "$1" ;;
  esac
}

alive() { kill -0 "$1" 2>/dev/null; }

stop_one() { # pid file
  local file="$1" name pid cmd grace expected
  name="$(basename "$file" .pid)"
  pid="$(tr -dc '0-9' <"$file")"
  # dev.sh may record what the command line must contain (<name>.match), e.g. the site's directory.
  expected="$(cat "${file%.pid}.match" 2>/dev/null || expected_command "$name")"
  rm -f "$file" "${file%.pid}.match"
  [ -n "$pid" ] || return 0
  if ! alive "$pid"; then
    say "$name (pid $pid) was not running"
    return 0
  fi
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *"$expected"*) ;;
    *)
      say "pid $pid is no longer $name (it is: ${cmd:-unknown}); leaving it alone"
      return 0
      ;;
  esac
  # accounts-api drains in-flight requests and the worker within 30 s; the site within 10 s;
  # the testkit and the proxy within 5 s.
  case "$name" in
    accounts-api) grace=35 ;;
    web|developer) grace=12 ;;
    *) grace=8 ;;
  esac
  # dev.sh starts each service as its own process group (pgid = pid); fall back to the pid.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while alive "$pid" && [ "$waited" -lt $((grace * 5)) ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
  if alive "$pid"; then
    say "$name (pid $pid) did not stop within ${grace} s; killing it"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  # Children that left the group still die with it in practice; make sure nothing lingers.
  pkill -TERM -g "$pid" 2>/dev/null || true
  say "stopped $name (pid $pid)"
}

stop_stack() { # run dir
  local dir="$1" f
  # The sites first (they front accounts-api), then accounts-api (it talks to the fake apps while
  # it drains), then the testkit.
  for f in "$dir/web.pid" "$dir/developer.pid" "$dir/proxy.pid" "$dir/accounts-api.pid" "$dir/testkit.pid"; do
    [ -f "$f" ] && stop_one "$f"
  done
  for f in "$dir"/*.pid; do
    [ -f "$f" ] && stop_one "$f"
  done
  rm -f "$dir/testkit.json"
  [ "$CLEAN" = 1 ] && clean_build "$dir"
  return 0
}

# Deletes the builds a stack made in its own directories (web/.next-<port>/, developer/.next-<port>/ and the
# .next-<port>.tsconfig.json each next.config.ts writes beside them). Only a directory named .next-<something>: never
# .next, never anything else.
clean_build() { # run dir
  local recorded dist name record
  for record in web.dist developer.dist; do
    recorded="$(cat "$1/$record" 2>/dev/null || true)"
    [ -n "$recorded" ] || continue
    name="$(basename "$recorded")"
    case "$name" in
      .next-*) ;;
      *) continue ;;
    esac
    dist="$recorded"
    if [ -d "$dist" ]; then
      rm -rf "$dist"
      say "deleted the build $dist"
    fi
    rm -f "$dist.tsconfig.json" "$1/$record"
  done
}

if [ "$ALL" = 1 ]; then
  found=0
  for dir in "$ROOT"/.dev/run/*/; do
    [ -d "$dir" ] || continue
    found=1
    stop_stack "${dir%/}"
  done
  [ "$found" = 1 ] || say "no stack is recorded under .dev/run/"
else
  port="${ACCOUNTS_PORT:-8590}"
  dir="$ROOT/.dev/run/$port"
  if [ -d "$dir" ] && ls "$dir"/*.pid >/dev/null 2>&1; then
    stop_stack "$dir"
  else
    say "no stack recorded for port $port (.dev/run/$port has no pid files)"
    if [ "$CLEAN" = 1 ] && [ -d "$dir" ]; then clean_build "$dir"; fi
  fi
fi

if [ "$DB" = 1 ]; then
  "$ROOT/scripts/dev-db.sh" stop | sed 's/^dev-db: /stop: postgres /'
fi
