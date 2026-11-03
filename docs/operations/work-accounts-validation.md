---
title: Work account validation
description: Local acceptance and regression evidence for work accounts and Organizations integration.
kind: informative
order: 30
---

# Local validation — November 3, 2026

The isolated stack used Accounts API `localhost:8649`, web `localhost:8650`,
PostgreSQL `127.0.0.1:5548`, and local identity/messaging providers. No production
accounts, credentials or services were used.

`python3 scripts/accept-work-accounts-local.py` passed 13 real HTTP checks. It
creates unique `qaacc-*` fixtures through public OTP signup and verified invite
flows, reads delivered codes from the messaging mock, and keeps local service
credentials in memory. Its [machine-readable evidence](evidence/work-accounts-local.json)
contains no tokens, email addresses or personal account UUIDs.

The checks cover email, Google, Apple form-post and phone sign-in; linked account
selection; independent target proof preserving the initiating cookie; denial of
an unauthenticated link completion; a work main creating an idempotent personal
account; unchanged email ownership; exclusion precedence and immediate token
introspection invalidation; disabled picker choices and server rejection; closure
of work identities; personal-main deletion preserving work; replacement of a
closed work main; and personal-identity privacy in the work event stream.

The PostgreSQL-backed server integration suite covers identity isolation,
organization Silicon custody, cross-kind handle reservation, new-email guest
provisioning without a personal account, immediate policy enforcement, recipient
or custodian consent, semantic bridge replay across actor-token refresh, and
atomic keyed code/SLT recovery. Recovery checks include changed redirect/PKCE
proof, consumed grants, revoked families and already-refreshed sessions. A
receiver-only User verification proof is revoked and audited even when the work
account has no membership at that receiver.

The regression run across core, auth, OAuth, account, Silicons, proofs, client and
CLI ran 754 tests; two performance/environment tests remain intentionally ignored.
Three obsolete fixtures initially failed: the CLI vocabulary guard prohibited
“organization”, and two legacy migration fixtures issued current tokens before
work metadata existed. Their targeted reruns passed after correcting only the
fixtures. Current enforcement was retained.

Commands:

```sh
ACCOUNTS_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5548/postgres \
  cargo test -p silicon-accounts-server --test organizations
ACCOUNTS_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5548/postgres \
  cargo test -p silicon-accounts-oauth -p silicon-accounts-auth \
  -p silicon-accounts-account -p silicon-accounts-silicons \
  -p silicon-accounts-proofs -p silicon-accounts-client \
  -p silicon-accounts-cli -p silicon-accounts-core --no-fail-fast
cargo fmt --all
cargo check -p silicon-accounts-server -p silicon-accounts-cli
git diff --check
```

These results verify the local implementation and mocked provider transports.
Production deployment and external production-provider acceptance are separate.
