#!/usr/bin/env bash
# Local Postgres for Silicon Accounts: a Postgres 16 cluster in .dev/pg listening on
# 127.0.0.1:5444 (user postgres, trust auth) with the silicon_accounts database.
#
#   scripts/dev-db.sh           start (initialize if needed) and create the database: idempotent
#   scripts/dev-db.sh status    show whether it is running
#   scripts/dev-db.sh stop      stop the cluster
#
# Overrides: PG_BIN (directory with pg_ctl/initdb/psql), ACCOUNTS_PGDATA, ACCOUNTS_PGPORT,
# ACCOUNTS_DB_NAME, ACCOUNTS_PGLOG. No Docker needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
PGDATA="${ACCOUNTS_PGDATA:-$ROOT/.dev/pg}"
PORT="${ACCOUNTS_PGPORT:-5444}"
DB="${ACCOUNTS_DB_NAME:-silicon_accounts}"
LOG="${ACCOUNTS_PGLOG:-$(dirname "$PGDATA")/$(basename "$PGDATA").log}"
CMD="${1:-start}"

if [ ! -x "$PG_BIN/pg_ctl" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else
    echo "error: Postgres binaries not found in $PG_BIN or on PATH" >&2
    echo "hint: install Postgres 16 (brew install postgresql@16) or set PG_BIN to the directory with pg_ctl" >&2
    exit 1
  fi
fi

ready() {
  "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -q
}

case "$CMD" in
  start) ;;
  status)
    if ready; then
      echo "dev-db: running on 127.0.0.1:$PORT (data: $PGDATA)"
      exit 0
    fi
    echo "dev-db: not running on 127.0.0.1:$PORT (data: $PGDATA)"
    exit 1
    ;;
  stop)
    if "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
      "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
      echo "dev-db: stopped"
    else
      echo "dev-db: not running"
    fi
    exit 0
    ;;
  -h|--help|help)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "error: unknown command '$CMD'; use start, status or stop" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$PGDATA")"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "dev-db: initializing a new cluster in $PGDATA"
  "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
fi

if ready; then
  echo "dev-db: Postgres is already accepting connections on 127.0.0.1:$PORT"
else
  if "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    echo "error: a Postgres server runs from $PGDATA but doesn't answer on 127.0.0.1:$PORT" >&2
    echo "hint: check $LOG, or run 'scripts/dev-db.sh stop' and start again" >&2
    exit 1
  fi
  echo "dev-db: starting Postgres on 127.0.0.1:$PORT (log: $LOG)"
  "$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k /tmp" -l "$LOG" -w -t 30 start >/dev/null
fi

exists="$("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -Atc "select 1 from pg_database where datname = '$DB'")"
if [ "$exists" = "1" ]; then
  echo "dev-db: database $DB exists"
else
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$DB"
  echo "dev-db: created database $DB"
fi

echo "dev-db: ready at postgres://postgres@127.0.0.1:$PORT/$DB"
echo "next: cargo run -p silicon-accounts-server --bin accounts-migrate"
