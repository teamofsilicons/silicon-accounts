#!/usr/bin/env bash
# The whole local Silicon Accounts stack, one command:
#
#   Postgres (scripts/dev-db.sh) → accounts-migrate → accounts-seed (testkit/fake-apps.json)
#   → testkit (mock Google/Apple, mock Postmark/Twilio, the fake app server)
#   → accounts-api on 127.0.0.1:8589, wired to the mocks (ACCOUNTS_DELIVERY=providers, dev outbox on)
#   → the account site (Next.js, web/) on http://localhost:8590: the public origin. It serves the
#     pages and proxies /v1/* and /.well-known/* to accounts-api (ACCOUNTS_API_URL).
#
#   scripts/dev.sh               run in the foreground; Ctrl-C stops everything it started
#   scripts/dev.sh --detach      start in the background, print the URLs and return
#                                (stop it with scripts/stop.sh)
#   scripts/dev.sh --prod        run the site as a production build (pnpm -C web build, then start)
#   scripts/dev.sh --web=MODE    what serves the public origin:
#       auto      (default) next when web/package.json depends on "next", else none (with a warning)
#       next      the Next.js site: `pnpm -C web dev` (or build + start with --prod)
#       proxy     scripts/dev-proxy.mjs: forwards /v1/* and /.well-known/* like the site's rewrites,
#                 serves no pages (proves the API behind a proxy without building the site)
#       external  nothing; you run the site yourself:
#                 PORT=8590 ACCOUNTS_API_URL=http://127.0.0.1:8589 pnpm -C web dev
#       none      API only: the public URL is accounts-api's own origin (http://localhost:8589)
#   scripts/dev.sh --api-only    same as --web=none;   scripts/dev.sh --proxy   same as --web=proxy
#   scripts/dev.sh --no-build    use the binaries that are already built (skip cargo build)
#   scripts/dev.sh --release     build and run the release binaries
#   scripts/dev.sh --reseed      re-apply every fake app's sign-in setup and webhook (accounts-seed --force)
#   scripts/dev.sh --reset-db    drop and recreate the database first (all local data is lost)
#
# Idempotent: running it again stops the stack it started before on the same ports, applies
# pending migrations, seeds (existing apps keep their users and setup) and starts again.
# Postgres keeps running afterwards (scripts/stop.sh --db stops it too).
#
# Environment (defaults in brackets) — set them to run a second stack on other ports:
#   ACCOUNTS_PORT [8590] (the public site)   ACCOUNTS_API_PORT [8589] (accounts-api)
#   MOCK_OIDC_PORT [8591]   MOCK_MESSAGING_PORT [8592]   FAKE_APPS_PORT [8593]
#   ACCOUNTS_PGPORT [5444]  ACCOUNTS_DB_NAME [silicon_accounts]
#   ACCOUNTS_PUBLIC_URL [http://localhost:$ACCOUNTS_PORT; with --web=none http://localhost:$ACCOUNTS_API_PORT]
#   ACCOUNTS_EXTRA_ALLOWED_ORIGINS [the public URL's port on 127.0.0.1]
#   ACCOUNTS_TRUST_FORWARDED_FOR [true: accounts-api runs behind the site]
#   TESTKIT_ACCOUNTS_URL [the API]   how the fake apps reach Silicon Accounts server to server
#   ACCOUNTS_WEB_DIR [web]   the Next.js site to run (another checkout or a probe app)
#   CARGO_TARGET_DIR [target]   PG_BIN [/opt/homebrew/opt/postgresql@16/bin]
#
# Logs: .dev/logs/ (or .dev/logs/<ACCOUNTS_PORT>/ for a non-default port).
# State (pid files, the generated env): .dev/run/<ACCOUNTS_PORT>/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

DETACH=0
BUILD=1
PROFILE=debug
RESEED=0
RESET_DB=0
PROD=0
WEB_MODE=auto
for arg in "$@"; do
  case "$arg" in
    -d|--detach) DETACH=1 ;;
    --no-build) BUILD=0 ;;
    --release) PROFILE=release ;;
    --reseed) RESEED=1 ;;
    --reset-db) RESET_DB=1 ;;
    --prod) PROD=1 ;;
    --api-only) WEB_MODE=none ;;
    --proxy) WEB_MODE=proxy ;;
    --web=*) WEB_MODE="${arg#--web=}" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      echo "hint: scripts/dev.sh [--detach] [--prod] [--web=auto|next|proxy|external|none] [--api-only] [--proxy] [--no-build] [--release] [--reseed] [--reset-db]" >&2
      exit 2
      ;;
  esac
done
case "$WEB_MODE" in
  auto|next|proxy|external|none) ;;
  *)
    echo "error: --web=$WEB_MODE is not a mode" >&2
    echo "hint: use --web=auto, next, proxy, external or none (scripts/dev.sh --help explains each)" >&2
    exit 2
    ;;
esac

say() { printf 'dev: %s\n' "$*"; }
rel() { case "$1" in "$ROOT"/*) printf '%s' "${1#"$ROOT"/}" ;; *) printf '%s' "$1" ;; esac; }
warn() { printf 'dev: warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf 'hint: %s\n' "$2" >&2
  exit 1
}

WEB_DIR="${ACCOUNTS_WEB_DIR:-$ROOT/web}"
case "$WEB_DIR" in /*) ;; *) WEB_DIR="$ROOT/$WEB_DIR" ;; esac

# Does the site directory hold the Next.js site (a "next" dependency in its package.json)?
web_has_next() {
  [ -f "$WEB_DIR/package.json" ] || return 1
  node -e '
    const p = require(process.argv[1]);
    const has = (d) => !!(d && Object.prototype.hasOwnProperty.call(d, "next"));
    process.exit(has(p.dependencies) || has(p.devDependencies) ? 0 : 1);
  ' "$WEB_DIR/package.json" 2>/dev/null
}

if [ "$WEB_MODE" = auto ]; then
  if web_has_next; then
    WEB_MODE=next
  else
    WEB_MODE=none
    warn "$(rel "$WEB_DIR")/package.json has no \"next\" dependency yet, so there is no site to start: serving the API only (its own origin is the public URL). Use --web=proxy to put the site's proxy in front, or --web=external to run the site yourself."
  fi
fi
if [ "$WEB_MODE" = next ] && ! web_has_next; then
  fail "--web=next needs the Next.js site, but $(rel "$WEB_DIR")/package.json has no \"next\" dependency" \
    "build the site in web/ first, or use --web=proxy / --web=none"
fi
if [ "$PROD" = 1 ] && [ "$WEB_MODE" != next ]; then
  fail "--prod runs the Next.js site as a production build, but the site mode is '$WEB_MODE'" \
    "drop --prod, or use it with --web=next once web/ has its Next.js app"
fi

ACCOUNTS_PORT="${ACCOUNTS_PORT:-8590}"
API_PORT="${ACCOUNTS_API_PORT:-8589}"
MOCK_OIDC_PORT="${MOCK_OIDC_PORT:-8591}"
MOCK_MESSAGING_PORT="${MOCK_MESSAGING_PORT:-8592}"
FAKE_APPS_PORT="${FAKE_APPS_PORT:-8593}"
PGPORT="${ACCOUNTS_PGPORT:-5444}"
DB="${ACCOUNTS_DB_NAME:-silicon_accounts}"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"

for p in "$ACCOUNTS_PORT" "$API_PORT" "$MOCK_OIDC_PORT" "$MOCK_MESSAGING_PORT" "$FAKE_APPS_PORT" "$PGPORT"; do
  case "$p" in
    ''|*[!0-9]*) echo "error: ports must be numbers, got '$p'" >&2; exit 2 ;;
  esac
done
[ "$ACCOUNTS_PORT" != "$API_PORT" ] || fail "ACCOUNTS_PORT and ACCOUNTS_API_PORT are both $API_PORT" \
  "the site and accounts-api need their own ports, e.g. ACCOUNTS_PORT=8590 ACCOUNTS_API_PORT=8589"

# The public origin: the site (or its stand-in), or accounts-api itself when nothing fronts it.
if [ "$WEB_MODE" = none ]; then
  DEFAULT_PUBLIC_URL="http://localhost:$API_PORT"
else
  DEFAULT_PUBLIC_URL="http://localhost:$ACCOUNTS_PORT"
fi
PUBLIC_URL="${ACCOUNTS_PUBLIC_URL:-$DEFAULT_PUBLIC_URL}"
PUBLIC_URL="${PUBLIC_URL%/}"
public_port="$(node -e 'const u = new URL(process.argv[1]); process.stdout.write(u.port || (u.protocol === "https:" ? "443" : "80"))' "$PUBLIC_URL" 2>/dev/null || echo "$ACCOUNTS_PORT")"
EXTRA_ORIGINS="${ACCOUNTS_EXTRA_ALLOWED_ORIGINS-http://127.0.0.1:$public_port}"
TRUST_FORWARDED_FOR="${ACCOUNTS_TRUST_FORWARDED_FOR:-true}"
API_URL="http://127.0.0.1:$API_PORT"
FRONT_URL="http://127.0.0.1:$ACCOUNTS_PORT"
TESTKIT_ACCOUNTS_URL="${TESTKIT_ACCOUNTS_URL:-$API_URL}"
DB_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"

RUN_DIR="$ROOT/.dev/run/$ACCOUNTS_PORT"
if [ "$ACCOUNTS_PORT" = 8590 ]; then LOG_DIR="$ROOT/.dev/logs"; else LOG_DIR="$ROOT/.dev/logs/$ACCOUNTS_PORT"; fi
mkdir -p "$RUN_DIR" "$LOG_DIR" "$ROOT/.dev/seed"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="$ROOT/$TARGET_DIR" ;; esac
BIN="$TARGET_DIR/$PROFILE"

# Is something listening on 127.0.0.1:$1? (bash's /dev/tcp; no lsof/nc needed)
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

who_listens() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
  fi
}

# --- 0. stop what an earlier run of this script left running on these ports --------------------
if [ -d "$RUN_DIR" ] && ls "$RUN_DIR"/*.pid >/dev/null 2>&1; then
  say "stopping the stack started earlier on port $ACCOUNTS_PORT"
  ACCOUNTS_PORT="$ACCOUNTS_PORT" "$ROOT/scripts/stop.sh" --quiet
fi

ports_to_check=("$API_PORT" "$MOCK_OIDC_PORT" "$MOCK_MESSAGING_PORT" "$FAKE_APPS_PORT")
case "$WEB_MODE" in next|proxy) ports_to_check+=("$ACCOUNTS_PORT") ;; esac
for p in "${ports_to_check[@]}"; do
  if port_busy "$p"; then
    fail "port $p is already in use by $(who_listens "$p" || echo 'another process')" \
      "stop it, or pick other ports: ACCOUNTS_PORT=9590 ACCOUNTS_API_PORT=9589 MOCK_OIDC_PORT=9591 MOCK_MESSAGING_PORT=9592 FAKE_APPS_PORT=9593 scripts/dev.sh"
  fi
done

# --- 1. binaries ------------------------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  say "building accounts-api, accounts-migrate, accounts-seed and the accounts CLI ($PROFILE) into $TARGET_DIR"
  release_flag=()
  [ "$PROFILE" = release ] && release_flag=(--release)
  CARGO_TARGET_DIR="$TARGET_DIR" cargo build ${release_flag[@]+"${release_flag[@]}"} \
    -p silicon-accounts-server -p silicon-accounts-cli >"$LOG_DIR/build.log" 2>&1 \
    || { tail -n 40 "$LOG_DIR/build.log" >&2; fail "cargo build failed (full log: $LOG_DIR/build.log)"; }
fi
for b in accounts-api accounts-migrate accounts-seed accounts; do
  [ -x "$BIN/$b" ] || fail "$BIN/$b does not exist" "run without --no-build, or set CARGO_TARGET_DIR to the target dir you built into"
done

# --- 2. Postgres + database ---------------------------------------------------------------------------
if [ "$RESET_DB" = 1 ]; then
  say "dropping database $DB (--reset-db)"
  ACCOUNTS_PGPORT="$PGPORT" ACCOUNTS_DB_NAME=postgres PG_BIN="$PG_BIN" "$ROOT/scripts/dev-db.sh" >/dev/null
  PGOPTIONS='--client-min-messages=warning' "$PG_BIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U postgres --if-exists --force "$DB"
  rm -f "$ROOT/.dev/seed/$DB-$PGPORT.sha256"
fi
ACCOUNTS_PGPORT="$PGPORT" ACCOUNTS_DB_NAME="$DB" PG_BIN="$PG_BIN" "$ROOT/scripts/dev-db.sh" | grep -v '^next:' | sed 's/^dev-db: /dev: /'

# Everything the three binaries share. Explicit values win over a .env file in the repo root.
base_env() {
  export ACCOUNTS_ENVIRONMENT=development
  export ACCOUNTS_DATABASE_URL="$DB_URL"
  export ACCOUNTS_BIND_ADDR="127.0.0.1:$API_PORT"
  export ACCOUNTS_PUBLIC_URL="$PUBLIC_URL"
  export ACCOUNTS_EXTRA_ALLOWED_ORIGINS="$EXTRA_ORIGINS"
}

say "applying migrations to $DB_URL"
( base_env; exec "$BIN/accounts-migrate" ) >"$LOG_DIR/migrate.log" 2>&1 \
  || { cat "$LOG_DIR/migrate.log" >&2; fail "accounts-migrate failed (log: $LOG_DIR/migrate.log)"; }

# --- 3. seed the fake apps ----------------------------------------------------------------------------
# fake-apps.json points every webhook at the fake app server on 127.0.0.1:8593; another port
# gets a rewritten copy so deliveries reach this stack's fake apps.
FAKE_APPS_JSON="$ROOT/testkit/fake-apps.json"
if [ "$FAKE_APPS_PORT" != 8593 ]; then
  sed "s#http://127.0.0.1:8593#http://127.0.0.1:$FAKE_APPS_PORT#g" "$ROOT/testkit/fake-apps.json" >"$RUN_DIR/fake-apps.json"
  FAKE_APPS_JSON="$RUN_DIR/fake-apps.json"
fi
# Existing apps keep their sign-in setup and webhook; when the seeded file changed since the last
# seed of this database (or --reseed), re-apply them so the database follows the file.
SEED_STAMP="$ROOT/.dev/seed/$DB-$PGPORT.sha256"
seed_sum="$(shasum -a 256 "$FAKE_APPS_JSON" | cut -d' ' -f1)"
force_flag=()
if [ "$RESEED" = 1 ] || { [ -f "$SEED_STAMP" ] && [ "$(cat "$SEED_STAMP")" != "$seed_sum" ]; }; then
  force_flag=(--force)
fi
say "seeding the fake apps from ${FAKE_APPS_JSON#"$ROOT"/}${force_flag[0]+ (re-applying sign-in setups and webhooks)}"
( base_env; exec "$BIN/accounts-seed" --fake-apps "$FAKE_APPS_JSON" ${force_flag[@]+"${force_flag[@]}"} ) >"$LOG_DIR/seed.log" 2>&1 \
  || { cat "$LOG_DIR/seed.log" >&2; fail "accounts-seed failed (log: $LOG_DIR/seed.log)"; }
printf '%s\n' "$seed_sum" >"$SEED_STAMP"

# --- 4. testkit ---------------------------------------------------------------------------------------
if [ ! -x "$ROOT/testkit/node_modules/.bin/tsx" ]; then
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed" "install Node >= 24 and pnpm (corepack enable), then run this again"
  say "installing the testkit's dependencies"
  pnpm -C "$ROOT/testkit" install --frozen-lockfile >"$LOG_DIR/testkit-install.log" 2>&1 \
    || { tail -n 20 "$LOG_DIR/testkit-install.log" >&2; fail "pnpm install in testkit/ failed"; }
fi

PIDS=()
started=0
cleanup_done=0
stop_all() {
  [ "$cleanup_done" = 1 ] && return
  cleanup_done=1
  echo
  say "stopping…"
  ACCOUNTS_PORT="$ACCOUNTS_PORT" "$ROOT/scripts/stop.sh" --quiet || true
  say "stopped (Postgres keeps running; scripts/stop.sh --db stops it)"
}
# Foreground: Ctrl-C (or any failure) stops everything. Detached: only a failure during start-up does.
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM
trap 'if [ "$DETACH" = 0 ] || [ "$started" = 0 ]; then stop_all; fi' EXIT

# Each background service gets its own process group (job control on just for the launch), so
# stopping it stops its children too (tsx and pnpm run node as children), and Ctrl-C reaches
# only this script, which then stops the services in order.
launch() { # name, then the command; output goes to $LOG_DIR/<name>.log, pid to $RUN_DIR/<name>.pid
  # (stop.sh only stops a pid whose command still contains $RUN_DIR/<name>.match, when present)
  local name="$1"; shift
  set -m
  if [ "$DETACH" = 1 ]; then
    nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  else
    "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  fi
  local pid=$!
  set +m
  printf '%s\n' "$pid" >"$RUN_DIR/$name.pid"
  PIDS+=("$pid")
  LAST_PID="$pid"
}

# Waits until `curl $2` answers 2xx, while process $3 lives; $1 names it, $4 is the timeout (s).
wait_ready() {
  local name="$1" url="$2" pid="$3" timeout="$4"
  local deadline=$((SECONDS + timeout))
  until curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; do
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 30 "$LOG_DIR/$name.log" >&2
      fail "$name exited during start-up (log: $LOG_DIR/$name.log)"
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "$name did not answer $url within $timeout s (log: $LOG_DIR/$name.log)"
    sleep 0.2
  done
}

rm -f "$RUN_DIR/testkit.json"
say "starting the testkit (mock-oidc :$MOCK_OIDC_PORT, mock-messaging :$MOCK_MESSAGING_PORT, fake apps :$FAKE_APPS_PORT)"
launch testkit env \
  ACCOUNTS_URL="$TESTKIT_ACCOUNTS_URL" ACCOUNTS_PUBLIC_URL="$PUBLIC_URL" \
  MOCK_OIDC_PORT="$MOCK_OIDC_PORT" MOCK_MESSAGING_PORT="$MOCK_MESSAGING_PORT" FAKE_APPS_PORT="$FAKE_APPS_PORT" \
  TESTKIT_LOG=1 \
  "$ROOT/testkit/node_modules/.bin/tsx" "$ROOT/testkit/src/start.ts" --ready-file "$RUN_DIR/testkit.json"
TESTKIT_PID="$LAST_PID"

deadline=$((SECONDS + 60))
until [ -s "$RUN_DIR/testkit.json" ]; do
  if ! kill -0 "$TESTKIT_PID" 2>/dev/null; then
    tail -n 30 "$LOG_DIR/testkit.log" >&2
    fail "the testkit exited during start-up (log: $LOG_DIR/testkit.log)"
  fi
  [ "$SECONDS" -lt "$deadline" ] || fail "the testkit did not become ready within 60 s (log: $LOG_DIR/testkit.log)"
  sleep 0.2
done

# --- 5. accounts-api ------------------------------------------------------------------------------
# The ACCOUNTS_* values that point the service at the mocks come from the testkit itself; the
# explicit values below (topology, database) win because they come later in the file.
ENV_FILE="$RUN_DIR/accounts-api.env"
(
  cd "$ROOT/testkit"
  MOCK_OIDC_PORT="$MOCK_OIDC_PORT" MOCK_MESSAGING_PORT="$MOCK_MESSAGING_PORT" \
    ./node_modules/.bin/tsx src/print-env.ts --format shell --api-port "$API_PORT" --public-url "$PUBLIC_URL"
) >"$ENV_FILE.tmp" || fail "could not compute the testkit environment (testkit/src/print-env.ts)"
{
  cat "$ENV_FILE.tmp"
  for kv in \
    "ACCOUNTS_ENVIRONMENT=development" \
    "ACCOUNTS_DATABASE_URL=$DB_URL" \
    "ACCOUNTS_BIND_ADDR=127.0.0.1:$API_PORT" \
    "ACCOUNTS_PUBLIC_URL=$PUBLIC_URL" \
    "ACCOUNTS_EXTRA_ALLOWED_ORIGINS=$EXTRA_ORIGINS" \
    "ACCOUNTS_TRUST_FORWARDED_FOR=$TRUST_FORWARDED_FOR" \
    "ACCOUNTS_DELIVERY=providers" \
    "ACCOUNTS_EXPOSE_DEV_OUTBOX=true" \
    "ACCOUNTS_WORKER_ENABLED=true" \
    "ACCOUNTS_WEB_DIST=${ACCOUNTS_WEB_DIST-}"; do
    printf 'export %s=%q\n' "${kv%%=*}" "${kv#*=}"
  done
} >"$ENV_FILE"
rm -f "$ENV_FILE.tmp"

say "starting accounts-api on $API_URL (public URL $PUBLIC_URL)"
launch accounts-api bash -c 'set -a; . "$1"; set +a; exec "$2"' accounts-api "$ENV_FILE" "$BIN/accounts-api"
API_PID="$LAST_PID"
wait_ready accounts-api "$API_URL/readyz" "$API_PID" 60

# --- 6. the public origin -------------------------------------------------------------------------
FRONT_PID=""
FRONT_NAME=""
case "$WEB_MODE" in
  next)
    command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed" "install Node >= 24 and pnpm (corepack enable), then run this again"
    if [ ! -e "$WEB_DIR/node_modules/.bin/next" ]; then
      say "installing the site's dependencies (pnpm -C $(rel "$WEB_DIR") install)"
      install_flags=()
      [ -f "$WEB_DIR/pnpm-lock.yaml" ] && install_flags=(--frozen-lockfile)
      pnpm -C "$WEB_DIR" install ${install_flags[@]+"${install_flags[@]}"} >"$LOG_DIR/web-install.log" 2>&1 \
        || { tail -n 20 "$LOG_DIR/web-install.log" >&2; fail "pnpm install in web/ failed (log: $LOG_DIR/web-install.log)"; }
    fi
    web_env=(PORT="$ACCOUNTS_PORT" ACCOUNTS_API_URL="$API_URL" ACCOUNTS_PUBLIC_URL="$PUBLIC_URL" NEXT_TELEMETRY_DISABLED=1)
    printf '%s\n' "$WEB_DIR" >"$RUN_DIR/web.match"
    if [ "$PROD" = 1 ]; then
      say "building the site for production (pnpm -C $(rel "$WEB_DIR") build; log: $(rel "$LOG_DIR")/web-build.log)"
      env "${web_env[@]}" NODE_ENV=production pnpm -C "$WEB_DIR" build >"$LOG_DIR/web-build.log" 2>&1 \
        || { tail -n 40 "$LOG_DIR/web-build.log" >&2; fail "pnpm -C web build failed (log: $LOG_DIR/web-build.log)"; }
      say "starting the site (next start) on $FRONT_URL"
      launch web env "${web_env[@]}" NODE_ENV=production pnpm -C "$WEB_DIR" start
      FRONT_PID="$LAST_PID"
      FRONT_NAME=web
      wait_ready web "$FRONT_URL/v1/meta" "$FRONT_PID" 120
    else
      say "starting the site (next dev) on $FRONT_URL"
      launch web env "${web_env[@]}" pnpm -C "$WEB_DIR" dev
      FRONT_PID="$LAST_PID"
      FRONT_NAME=web
      wait_ready web "$FRONT_URL/v1/meta" "$FRONT_PID" 180
    fi
    ;;
  proxy)
    say "starting the site's stand-in proxy (scripts/dev-proxy.mjs) on $FRONT_URL → $API_URL"
    launch proxy node "$ROOT/scripts/dev-proxy.mjs" --port "$ACCOUNTS_PORT" --target "$API_URL"
    FRONT_PID="$LAST_PID"
    FRONT_NAME=proxy
    wait_ready proxy "$FRONT_URL/v1/meta" "$FRONT_PID" 30
    ;;
esac

# Up: from here on a detached stack stays up even if printing the summary fails (closed pipe).
started=1
case "$WEB_MODE" in
  next) site_line="$PUBLIC_URL   (Next.js $( [ "$PROD" = 1 ] && echo 'production build' || echo 'dev server'); proxies /v1/* and /.well-known/* to the API)" ;;
  proxy) site_line="$PUBLIC_URL   (scripts/dev-proxy.mjs: /v1/* and /.well-known/* only, no pages)" ;;
  external) site_line="$PUBLIC_URL   (not started: PORT=$ACCOUNTS_PORT ACCOUNTS_API_URL=$API_URL pnpm -C $(rel "$WEB_DIR") dev)" ;;
  none) site_line="$PUBLIC_URL   (API only: no site; this is accounts-api itself)" ;;
esac
cat <<EOF

Silicon Accounts dev stack is up
  public URL (site)    $site_line
  accounts-api         $API_URL   (readiness: /readyz, dev outbox: /v1/dev/outbox)
  fake apps            http://127.0.0.1:$FAKE_APPS_PORT/
  mock Google/Apple    http://127.0.0.1:$MOCK_OIDC_PORT   (/_requests, /_identities)
  mock email/SMS       http://127.0.0.1:$MOCK_MESSAGING_PORT/_messages
  database             $DB_URL
  logs                 $(rel "$LOG_DIR")/ (accounts-api.log, testkit.log$( [ -n "$FRONT_NAME" ] && echo ", $FRONT_NAME.log"), migrate.log, seed.log)
  CLI                  $(rel "$BIN")/accounts --url $PUBLIC_URL --help
EOF

if [ "$DETACH" = 1 ]; then
  echo "  stop                 $([ "$ACCOUNTS_PORT" = 8590 ] || echo "ACCOUNTS_PORT=$ACCOUNTS_PORT ")scripts/stop.sh"
  exit 0
fi
echo "  Ctrl-C stops everything"

# Foreground: stay until Ctrl-C, or stop everything when one of the services exits on its own.
alive_all() {
  kill -0 "$API_PID" 2>/dev/null && kill -0 "$TESTKIT_PID" 2>/dev/null \
    && { [ -z "$FRONT_PID" ] || kill -0 "$FRONT_PID" 2>/dev/null; }
}
while alive_all; do
  sleep 1
done
if ! kill -0 "$API_PID" 2>/dev/null; then dead=accounts-api
elif ! kill -0 "$TESTKIT_PID" 2>/dev/null; then dead=testkit
else dead="$FRONT_NAME"; fi
say "$dead exited on its own; last lines of $(rel "$LOG_DIR")/$dead.log:"
tail -n 20 "$LOG_DIR/$dead.log" >&2 || true
exit 1
