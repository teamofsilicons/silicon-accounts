#!/usr/bin/env bash
# Local Accounts frontend with the production API and real data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PORT=9100
export ACCOUNTS_API_URL=https://accounts.teamofsilicons.com
export ACCOUNTS_PUBLIC_URL=http://localhost:9100
export NEXT_DIST_DIR=.next-live-9100
exec pnpm -C "$ROOT/web" dev --hostname localhost
