# silicon-accounts-proofs (`accounts_proofs`)

OBO and ATA proofs for Silicon Accounts: issue, refresh, verify, revoke and list them.
Silicon Accounts only issues and verifies proofs; consent screens and what each endpoint does
stay with the apps (`understanding/UNDERSTANDING.md`, "Proofs (OBO and ATA)").

- **OBO** (on behalf of): app A already has an account's consent and holds the account's access
  token. It trades that token (`subject_token`) for a proof that app B verifies. The proof stands
  on the account's sign-in at app A and ends with it.
- **ATA** (app to app): app A gets one proof for the apps it names (its audiences); each of them
  can verify that the token really comes from app A.

Proofs follow the sign-in token logic: a proof token (`sap_…`) the receiving app verifies, and a
proof refresh token (`sapr_…`) the issuing app keeps and rotates. Only `HMAC(pepper, token)` is
stored.

| number | value |
|---|---|
| proof token lifetime | 60..=1800 s, default 1800 (`access_ttl_seconds`) |
| proof lifetime (refresh token) | 900 days; an OBO proof never outlives the sign-in it stands on |
| scopes | ≤ 20 distinct app-defined strings, each 1..=100 chars of `A-Z a-z 0-9 _ . : / -` |
| ATA audiences | 1..=20 app ids |

## Endpoints

| route | auth | success |
|---|---|---|
| `POST /v1/proofs/obo` | app (IDEMPOTENT) | 201 issued proof |
| `POST /v1/proofs/ata` | app (IDEMPOTENT) | 201 issued proof |
| `POST /v1/proofs/refresh` | the issuing app (optional `Idempotency-Key`) | 200 issued proof (same `proof_id`) |
| `POST /v1/proofs/verify` | the verifying app | 200 valid / exactly `{"valid":false,"expires_at":null}` |
| `POST /v1/proofs/revoke` | the issuing app | 204 (`{"proof_id"}` or `{"proof_token"}` or `{"proof_refresh_token"}`) |
| `GET /v1/apps/{app_id}/proofs` | app or owner | 200 page (`?kind=obo\|ata&status=active\|revoked\|expired&limit&cursor`) |
| `POST /v1/apps/{app_id}/proofs/ata` | app or owner (IDEMPOTENT) | 201 issued proof (the ATA page stand-in) |
| `DELETE /v1/apps/{app_id}/proofs/{proof_id}` | app or owner | 204 |
| `GET /v1/me/proofs` | session (Carbon or Silicon) | 200 page of OBO proofs about me (`?status&limit&cursor`) |
| `DELETE /v1/me/proofs/{proof_id}` | session | 204 |

Issued proof (OBO; ATA has `receiving_apps: [...]` instead of `receiving_app` and `user: null`):

```json
{"proof_id":"0192…","kind":"obo","proof_token":"sap_…","expires_at":"2026-10-06T12:30:00.000Z",
 "proof_refresh_token":"sapr_…","refresh_expires_at":"2029-03-24T12:00:00.000Z",
 "issuing_app":"dm","receiving_app":"briefcase",
 "user":{"uuid":"a8K","id":"c:saket","kind":"carbon","membership_id":"dm:a8K"},"scopes":["files.write"]}
```

Lifetimes are absolute timestamps only (no relative `expires_in`): an `Idempotency-Key` retry
replays the first response verbatim for up to 10 minutes, and `expires_at` stays exact on a
replay where a relative lifetime would overstate what is left.

Valid verification (the `receiving_app` is the verifying app; `user.membership_id` is the
account's membership with the *issuing* app, the grant the proof stands on; `user.id` is the
account's current id):

```json
{"valid":true,"proof_id":"0192…","kind":"obo","expires_at":"2026-10-06T12:30:00.000Z",
 "issuing_app":{"app_id":"dm","name":"DM"},"receiving_app":{"app_id":"briefcase","name":"Briefcase"},
 "user":{"uuid":"a8K","id":"c:saket","kind":"carbon","membership_id":"dm:a8K"},"scopes":["files.write"]}
```

A proof verifies only when: the token is a known, unexpired proof token; the proof is not
revoked and within its lifetime; the verifying app is one of its audiences; the issuing app is
active; and, for OBO, the account is active, its membership with the issuing app is active and
the sign-in behind the subject token is neither revoked nor expired. Everything else gets exactly
`{"valid":false,"expires_at":null}`. A syntactically wrong input (a refresh token, a JWT, an
empty string) gets the same body plus an `x-accounts-hint` header describing the input only.

Listing items add `status` (`active` | `revoked` | `expired`), `revoke_reason`, `revoked_at`,
`token_expires_at` (newest proof token) and, for apps, `access_ttl_seconds`. `status` is honest
about OBO grants, live:

- the sign-in behind the proof was revoked (signed out, STK rotated, sign-in refresh token
  reused, …) before the proof expired → `revoked`, `sign_in_revoked`, at the moment the sign-in
  was revoked (never before the proof was issued). A revoked sign-in never comes back, so this
  end is also **stored** on the proof (`revoked_by = system`) with a `proof.revoked` audit entry:
  by the hourly sweep, or at once when the issuing app refreshes or revokes the proof. Storing it
  changes nothing a listing shows;
- the membership with the issuing app or the account is not active → `revoked`,
  `membership_inactive` (at `access_removed_at`) / `account_inactive` (at `deleted_at`, if
  any). Derived only: the service's real paths store these ends themselves (`access_removed`,
  `account_deleted`, by `accounts_core`), and anything else is not made permanent here;
- the sign-in expired → `expired`.

## Errors

| status | code | when |
|---|---|---|
| 400 | `invalid_subject_token` | not an access token, bad signature, expired, sign-in revoked/expired (`details.reason`: `not_an_access_token` / `invalid` / `expired` / `revoked`) |
| 403 | `subject_token_wrong_app` | the subject token was issued to another app (`details.token_app`) |
| 403 | `account_not_active` | the subject account is not active (`details.status`) |
| 403 | `membership_inactive` | the account has no active membership with the issuing app (`details.membership_id`) |
| 400 | `unknown_receiving_app` | receiving app(s) don't exist (`details.app_ids`) |
| 400 | `invalid_receiving_app` | the issuer itself, or the first-party app `accounts` |
| 403 | `receiving_app_disabled` | receiving app(s) disabled (`details.app_ids`) |
| 403 | `app_disabled` | the issuing app is disabled (ATA page) |
| 400 | `invalid_proof_refresh_token` | not a `sapr_…` token (a wrapped one, `Bearer sapr_…`, is named as such), or unknown: mistyped, another environment, or its proof ended more than 30 days ago (its tokens were deleted) |
| 403 | `not_issuing_app` | refresh/revoke by token from an app that didn't issue the proof |
| 400 | `proof_refresh_token_reused` | a used refresh token was presented: the proof is now revoked |
| 410 | `proof_revoked` | refresh of a revoked proof, or of an OBO proof whose grant ended (`details.reason`, `details.revoked_at`); a revoked sign-in wins over reuse detection (the proof had already ended) |
| 410 | `proof_expired` | refresh past the proof's lifetime or its sign-in's expiry |
| 400 | `invalid_proof_id` | not a UUID. Only short id-shaped values are repeated in the message; a token (alone or wrapped, `Bearer sap_…`, `Proof sap_…`), a JWT or an STK is described, never echoed |
| 404 | `proof_not_found` | no such proof for this app / account (another app's proof id looks unknown; an ATA proof id at `/v1/me/proofs`); revoke by a token the sweep already deleted (the message says so; revoke by `proof_id` instead) |
| 422 | `validation_failed` | body rules (`details.fields`: `scopes[3]`, `access_ttl_seconds`, `audiences[1]`, …) |
| 409 | `idempotency_key_reused` | same `Idempotency-Key`, different body |

## History

`audit_log` rows (`target_kind = proof`, `target_id = proof id`, `app_id = issuing app`):
`proof.issued`, `proof.revoked` and `proof.refresh_token_reused` carry the OBO account's uuid
(they show in its history); `proof.refreshed` doesn't (a proof refreshes every few minutes for
up to 900 days). `revoked_by` is the account uuid, `app:{app_id}` or `system`; `revoke_reason`
is `revoked_by_app`, `revoked_by_owner`, `revoked_by_account`, `refresh_token_reuse`,
`sign_in_revoked`, or the core's `access_removed` / `account_deleted`.

A proof's first end is the one its history keeps. When the sign-in behind an OBO proof is
revoked, the proof is stored as revoked at that moment (`sign_in_revoked`, `revoked_by =
system`) with a `proof.revoked` entry (`actor_kind = system`, `details`: `kind`, `reason` and
`via` = `sign_in_revoked`, `audiences`, `revoked_at`, `sign_in_revoke_reason` such as
`app_revoked` / `stk_rotated` / `refresh_token_reuse` / `user_signed_out`). A later revoke of
such a proof (by the app, its owner or the account) is a no-op that stores this first end, and
a used refresh token presented after the sign-in was revoked gets `proof_revoked`
(`sign_in_revoked`), not a second revocation. The account's history (`GET /v1/me/history`,
account crate) reads revocations from `proof_families`, so it shows every one of them.

## Verification cost

The verifying app's credentials are checked through the core's 60 s in-memory credential
cache; then one query: `proof_tokens` (PK) → `proof_families` (PK) → `apps` (PK), plus
`accounts`, `memberships` and `token_families` by primary key for OBO (checked with `EXPLAIN
ANALYZE` on 50k proofs: only primary-key index scans, 0.03 ms execution). Measured in-process
(`tests/perf.rs`, debug build, local Postgres 16): 2,000 sequential verifies p50 ≈ 0.16 ms,
p95 ≈ 0.18–0.20 ms; 2,000 more from 100 concurrent callers (pool of 32) p50 ≈ 2.2–2.6 ms,
p95 ≈ 5–13 ms, which is pool queueing.

Listings without a status filter take the page from the `(issuing_app, created_at desc)` index
first and join the grant state of that page only; a status filter has to evaluate the grant
state before the limit, so it reads all of the app's (or account's) proofs.

Known cost until the index below exists: `token_expires_at` is `max(expires_at)` over the
proof's `access` tokens, and the only index is `proof_tokens (family_id)`, so every listed proof
reads all of its token rows, including the used refresh tokens a live proof keeps for reuse
detection (one per refresh). `EXPLAIN ANALYZE` of a 50-proof page on Postgres 16: 0.1–0.4 ms
for fresh proofs; 382 ms when each proof was refreshed every 25 minutes for a year (21,000 used
refresh tokens each, interleaved in the heap as real refreshes are; ≈ 7 ms per proof per year
of refreshes); 0.06–0.2 ms for that same data with
`create index proof_tokens_family_kind_exp_idx on proof_tokens (family_id, kind, expires_at desc)`
(an index-only probe per proof). Requested as a `0002` migration.

## Background

`spawn_background` runs an hourly sweep (`store::sweep`, first run 2 minutes after start), in
batches of 5,000 rows (at most 200 batches per step and run):

1. stores the end of OBO proofs whose sign-in was revoked (see History) — one statement per
   batch updates the proofs and writes their audit entries, skipping rows a request holds;
2. deletes proof tokens that expired more than a day ago;
3. deletes every token of proofs revoked or expired more than 30 days ago.

Proof refresh tokens of live proofs are kept even when used (reuse detection needs them);
proof rows stay forever as history. Verification and listings never wait for the sweep: they
check every grant live.

## Tests

```bash
scripts/dev-db.sh   # Postgres on 127.0.0.1:5444
CARGO_TARGET_DIR=target/proofs cargo test -p silicon-accounts-proofs
CARGO_TARGET_DIR=target/proofs cargo test -p silicon-accounts-proofs --test perf -- --nocapture   # latency numbers
```
