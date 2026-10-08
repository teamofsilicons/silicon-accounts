# silicon-accounts-proofs (`accounts_proofs`)

App verification and User verification for Silicon Accounts: issue, refresh, verify, revoke and list them.
Silicon Accounts only issues and verifies proofs; consent screens and what each endpoint does
stay with the apps (`understanding/UNDERSTANDING.md`, "App verification and User verification").

- **User verification** (on behalf of): app A already has an account's consent and holds the account's access
  token. It trades that token (`subject_token`) for a proof that app B verifies. The proof stands
  on the account's sign-in at app A and ends with it.
- **App verification** (app to app): app A gets a proof for exactly one other app (`receiving_app`), which
  verifies that the token really comes from app A. To talk to several apps, app A gets one proof
  per app; a body naming `audiences` (the pre-v2 shape, any length) is refused with 422
  `app_verification_single_app` ("An app verification is for exactly one app; ask for one proof per app.").

Proofs follow the sign-in token logic: a proof token (`sap_…`) the receiving app verifies, and a
proof refresh token (`sapr_…`) the issuing app keeps and rotates. Only `HMAC(pepper, token)` is
stored.

| number | value |
|---|---|
| proof token lifetime | 60..=1800 s, default 1800 (`access_ttl_seconds`) |
| proof lifetime (refresh token) | 900 days; a User verification never outlives the sign-in it stands on |
| scopes | ≤ 20 distinct app-defined strings, each 1..=100 chars of `A-Z a-z 0-9 _ . : / -` |
| receiving apps | exactly 1 per proof (User verification and App verification); stored as a one-app `audiences` array |

## Endpoints

| route | auth | success |
|---|---|---|
| `POST /v1/proofs/user-verification` | app (IDEMPOTENT) | 201 issued proof |
| `POST /v1/proofs/app-verification` | app (IDEMPOTENT) | 201 issued proof |
| `POST /v1/proofs/refresh` | the issuing app (optional `Idempotency-Key`) | 200 issued proof (same `proof_id`) |
| `POST /v1/proofs/verify` | the verifying app | 200 valid / exactly `{"valid":false,"expires_at":null}` |
| `POST /v1/proofs/revoke` | the issuing app | 204 (`{"proof_id"}` or `{"proof_token"}` or `{"proof_refresh_token"}`) |
| `GET /v1/apps/{app_id}/proofs` | app or owner | 200 page (`?kind=user_verification\|app_verification&status=active\|revoked\|expired&limit&cursor`) |
| `POST /v1/apps/{app_id}/proofs/app-verification` | app or owner (IDEMPOTENT; the owner's session, CLI token or developer platform token) | 201 issued proof (the app's App verification page on developers.teamofsilicons.com) |
| `DELETE /v1/apps/{app_id}/proofs/{proof_id}` | app or owner | 204 |
| `GET /v1/me/proofs` | session (Carbon or Silicon) | 200 page of User verifications about me (`?status&limit&cursor`) |
| `DELETE /v1/me/proofs/{proof_id}` | session | 204 |

App verification request body: `{"receiving_app": "remind", "scopes"?, "access_ttl_seconds"?}`.

Issued proof (User verification; App verification has the same shape with `"kind":"app_verification"` and `user: null`):

```json
{"proof_id":"0192…","kind":"user_verification","proof_token":"sap_…","expires_at":"2026-10-06T12:30:00.000Z",
 "proof_refresh_token":"sapr_…","refresh_expires_at":"2029-03-24T12:00:00.000Z",
 "issuing_app":"dm","receiving_app":"briefcase",
 "user":{"uuid":"a8K","id":"c:saket","kind":"carbon","membership_id":"dm:a8K"},"scopes":["files.write"]}
```

Lifetimes are absolute timestamps only (no relative `expires_in`): an `Idempotency-Key` retry
replays the first response verbatim for up to 10 minutes, and `expires_at` stays exact on a
replay where a relative lifetime would overstate what is left. The stored response holds the
proof tokens, so core keeps it sealed with the keyring (`idempotency::run` with
`secret_bearing`), never in clear.

Valid verification (the `receiving_app` is the verifying app; `user.membership_id` is the
account's membership with the *issuing* app, the grant the proof stands on; `user.id` is the
account's current id):

```json
{"valid":true,"proof_id":"0192…","kind":"user_verification","expires_at":"2026-10-06T12:30:00.000Z",
 "issuing_app":{"app_id":"dm","name":"DM"},"receiving_app":{"app_id":"briefcase","name":"Briefcase"},
 "user":{"uuid":"a8K","id":"c:saket","kind":"carbon","membership_id":"dm:a8K"},"scopes":["files.write"]}
```

A proof verifies only when: the token is a known, unexpired proof token; the proof is not
revoked and within its lifetime; the verifying app is its receiving app; the issuing app is
active; and, for User verification, the account is active, its membership with the issuing app is active and
the sign-in behind the subject token is neither revoked nor expired. Everything else gets exactly
`{"valid":false,"expires_at":null}`. A syntactically wrong input (a refresh token, a JWT, an
empty string) gets the same body plus an `x-accounts-hint` header describing the input only.

Listing items name the proof's one `receiving_app` (a proof issued before single-app App verifications
shows its first) and add `status` (`active` | `revoked` | `expired`), `revoke_reason`,
`revoked_at`, `token_expires_at` (newest proof token) and, for apps, `access_ttl_seconds`. `status` is honest
about User verification grants, live:

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
| 400 | `invalid_receiving_app` | the issuer itself, or the first-party app `silicon-accounts` |
| 403 | `receiving_app_disabled` | receiving app(s) disabled (`details.app_ids`) |
| 403 | `app_disabled` | the issuing app is disabled (App verification page) |
| 400 | `invalid_proof_refresh_token` | not a `sapr_…` token (a wrapped one, `Bearer sapr_…`, is named as such), or unknown: mistyped, another environment, or its proof ended more than 30 days ago (its tokens were deleted) |
| 403 | `not_issuing_app` | refresh/revoke by token from an app that didn't issue the proof |
| 400 | `proof_refresh_token_reused` | a used refresh token was presented: the proof is now revoked |
| 410 | `proof_revoked` | refresh of a revoked proof, or of a User verification whose grant ended (`details.reason`, `details.revoked_at`); a revoked sign-in wins over reuse detection (the proof had already ended) |
| 410 | `proof_expired` | refresh past the proof's lifetime or its sign-in's expiry |
| 400 | `invalid_proof_id` | not a UUID. Only short id-shaped values are repeated in the message; a token (alone or wrapped, `Bearer sap_…`, `Proof sap_…`), a JWT or an STK is described, never echoed |
| 404 | `proof_not_found` | no such proof for this app / account (another app's proof id looks unknown; an app verification id at `/v1/me/proofs`); revoke by a token the sweep already deleted (the message says so; revoke by `proof_id` instead) |
| 422 | `validation_failed` | body rules (`details.fields`: `scopes[3]`, `access_ttl_seconds`, `receiving_app`, …) |
| 422 | `app_verification_single_app` | an app verification body named `audiences`: one proof per app (`details.apps` lists the valid app ids it named; the hint names the endpoint called) |
| 409 | `idempotency_key_reused` | same `Idempotency-Key`, different body |

## History

`audit_log` rows (`target_kind = proof`, `target_id = proof id`, `app_id = issuing app`):
`proof.issued`, `proof.revoked` and `proof.refresh_token_reused` carry the User verification account's uuid
(they show in its history); `proof.refreshed` doesn't (a proof refreshes every few minutes for
up to 900 days). `revoked_by` is the account uuid, `app:{app_id}` or `system`; `revoke_reason`
is `revoked_by_app`, `revoked_by_owner`, `revoked_by_account`, `refresh_token_reuse`,
`sign_in_revoked`, or the core's `access_removed` / `account_deleted`.

A proof's first end is the one its history keeps. When the sign-in behind a User verification is
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
`silicon-accounts`, `memberships` and `token_families` by primary key for User verification (checked with `EXPLAIN
ANALYZE` on 50k proofs: only primary-key index scans, 0.03 ms execution). Measured in-process
(`tests/perf.rs`, debug build, local Postgres 16): 2,000 sequential verifies p50 ≈ 0.16 ms,
p95 ≈ 0.18–0.20 ms; 2,000 more from 100 concurrent callers (pool of 32) p50 ≈ 2.2–2.6 ms,
p95 ≈ 5–13 ms, which is pool queueing.

Listings without a status filter take the page from the `(issuing_app, created_at desc, id desc)`
index first and join the grant state of that page only; a status filter has to evaluate the grant
state before the limit, so it reads all of the app's (or account's) proofs.

`token_expires_at` is `max(expires_at)` over the proof's `access` tokens, read through
`proof_tokens_family_kind_exp_idx (family_id, kind, expires_at desc)` (migration `0002`): one
index probe per listed proof, however many used refresh tokens a live proof keeps for reuse
detection. Measured before and with that index (`EXPLAIN ANALYZE` of a 50-proof page, Postgres 16,
each proof refreshed every 25 minutes for a year): 382 ms without, 0.06–0.2 ms with it. The sweep
uses `proof_tokens_access_expires_idx` and `proof_families_unrevoked_user_verification_idx` (also `0002`).

## Background

`spawn_background` runs an hourly sweep (`store::sweep`, first run 2 minutes after start), in
batches of 5,000 rows (at most 200 batches per step and run):

1. stores the end of User verifications whose sign-in was revoked (see History) — one statement per
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


## Central App verification history

The signed-in developer's `/app-verification` portal uses two first-party read endpoints:

| route | filters | result |
|---|---|---|
| `GET /v1/me/app-verifications` | `app_id`, `status=active|revoked|expired`, `limit`, `cursor` | all retained App verification (`kind: app_verification`) families issued by apps the account currently manages |
| `GET /v1/apps/{app_id}/proofs/{proof_id}/history` | `limit`, `cursor` | retained issuance, refresh and revocation events of that App verification |

Both return `{items, next_cursor}`, newest first with stable timestamp/ID keyset pagination;
`limit` defaults to 50 and clamps to 1–200. Both send `Cache-Control: no-store`.
Only Accounts session cookies and live first-party `silicon-accounts`/`developer` access tokens are
accepted. Authorization matches the existing `AppOrOwner` policy: current owner or accepted
`app_authors` membership of the **issuing** app. Each page reevaluates that permission. An
unmanaged/unknown app filter or record answers 404 `verification_not_found`; receiving-app
credentials, app Basic credentials, Apps-scoped tokens and other app tokens do not grant access.
Nothing adds platform-wide administrator access or changes existing app-author permissions.

Central rows contain the existing `AppProofItem` fields plus `issuing_app`:
`{app_id,name,logo_url,logo_dark_url,homepage_url}`. Revoked and expired families remain
visible permanently. `token_expires_at` is the newest retained access-token expiry; it is
`null` after those working token rows were purged. A family can remain active while its
most recent access token has expired and awaits refresh.

History rows are `{event_id,at,action,actor:{kind,id},details,token_expires_at,token_expiry_source}`.
The immutable audit ID is serialized as a string. Actions retain the compatible codes
`proof.issued`, `proof.refreshed`, `proof.revoked`, `proof.refresh_token_reused`. Details are
an explicit allowlist of historical metadata: `kind`, `issuing_app`, `receiving_app`,
`audiences`, `scopes`, `access_ttl_seconds`, `expires_at`, `reason`, `via`, `revoked_at`,
`sign_in_revoke_reason`. Actor IDs retain the issuing app ID or immutable account UUID.

New issuance/refresh events record the token expiry explicitly (`token_expiry_source:
recorded`). Earlier events use the audit transaction timestamp and its recorded valid TTL,
capped at the family's expiry (`derived`): token minting and the audit insert used the same
PostgreSQL transaction `now()`. Incomplete metadata returns `null` for both expiry fields;
revocation events are not token generations and also return null. Audit entries and proof
families are never purged. Migration 0008 adds only indexes for these reads.

The portal shows retained verification records and their token-generation events. It cannot
recover raw bearer tokens, refresh tokens or purged token identities. No token values,
hashes, IP addresses, or arbitrary audit payloads appear in these endpoints. Existing wire
routes, `app_verification`/`user_verification` kinds, request/response fields, error codes and SDK compatibility remain
unchanged; their human-facing product names are App verification and User verification.
