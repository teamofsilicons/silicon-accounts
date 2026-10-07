---
title: Proof endpoints
description: Reference for OBO and ATA proofs — issuing, refreshing, verifying, revoking and listing them, with every field, lifetime, limit and error.
kind: informative
order: 66
related:
  - reference/api.md
  - start/verify-a-proof.md
  - start/obo.md
  - start/ata.md
  - learn/proofs.md
  - reference/errors.md
---

# Proof endpoints

Silicon Accounts issues and verifies proofs; what each proof allows is up to the apps. An **OBO**
proof (on behalf of) lets app A act at app B for an account that consented in app A. An **ATA**
proof (app to app) lets app A prove itself to the apps it names. The guides are
[Verify a proof](../../start/verify-a-proof.md), [OBO](../../start/obo.md) and
[ATA](../../start/ata.md); the reasons are in [How proofs work](../../learn/proofs.md).

The receiving app verifies a proof token:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/proofs/verify" -u "briefcase:$BRIEFCASE_SECRET" \
  -H 'Content-Type: application/json' -d '{"proof_token":"'"$PROOF_TOKEN"'"}'
```

```json
{
  "valid": true,
  "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37",
  "kind": "obo",
  "expires_at": "2026-10-07T02:47:19.983Z",
  "issuing_app": { "app_id": "dm", "name": "DM" },
  "receiving_app": { "app_id": "briefcase", "name": "Briefcase" },
  "user": { "uuid": "8HV", "id": "c:ada", "kind": "carbon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

Anything else is exactly `{"valid": false, "expires_at": null}`.

Every endpoint takes **app** auth (`-u app_id:app_secret`) unless noted. Request bodies refuse
unknown fields. Proof responses are `Cache-Control: no-store`.

| Number | Value |
|---|---|
| proof token (`sap_…`) lifetime | `access_ttl_seconds`, 60 to 1800, default 1800 |
| proof lifetime (its `sapr_…` refresh token) | 900 days; an OBO proof never outlives the sign-in it stands on |
| scopes | at most 20 distinct strings, each 1–100 characters of `A-Z a-z 0-9 _ . : / -`, defined by the apps |
| ATA audiences | 1 to 20 app ids |

## The issued proof

`POST /v1/proofs/obo`, `/ata`, `/refresh` and `POST /v1/apps/{app_id}/proofs/ata` answer:

```json
{
  "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37",
  "kind": "obo",
  "proof_token": "sap_ynFCe2dYOohw67CJrGQkC5yFjq4HJxUD2SukHLHZ7J4",
  "expires_at": "2026-10-07T02:47:19.983Z",
  "proof_refresh_token": "sapr_Y06gz3yM8kR4BPPZT_xRDu93d86hGImeipKkaycO2as",
  "refresh_expires_at": "2029-03-25T02:37:19.930Z",
  "issuing_app": "dm",
  "receiving_app": "briefcase",
  "user": { "uuid": "8HV", "id": "c:ada", "kind": "carbon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

An ATA proof has `"kind": "ata"`, `"receiving_apps": ["remind", "waveform"]` instead of
`receiving_app`, and `"user": null`. Give the `proof_token` to the receiving app; keep the
`proof_refresh_token` yourself. Lifetimes are absolute timestamps (no `expires_in`), so a replayed
idempotent response still tells the truth about what is left.

## `POST /v1/proofs/obo`

**Idempotent** (10 minutes). Body:

| Field | |
|---|---|
| `subject_token` | an access token **your app** received for the account (its `aud` is your app) |
| `receiving_app` | the app that will verify the proof |
| `scopes` | optional list of app-defined strings |
| `access_ttl_seconds` | optional, 60–1800 |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/proofs/obo" -u "dm:$DM_SECRET" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: obo-briefcase-8HV-1' \
  -d '{"subject_token":"'"$ACCOUNT_ACCESS_TOKEN"'","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}'
```

**201** the issued proof. Get the account's consent in your own interface first: Silicon
Accounts doesn't show a consent screen for proofs.

| Status | Code | Why |
|---|---|---|
| 400 | `invalid_subject_token` | not an access token, bad signature, expired, or its sign-in ended (`details.reason`: `not_an_access_token`, `invalid`, `expired`, `revoked`) |
| 403 | `subject_token_wrong_app` | the token was issued to another app (`details.token_app`): an app can only turn its own tokens into proofs |
| 403 | `account_not_active` | the account isn't active (`details.status`) |
| 403 | `membership_inactive` | the account has no active membership with your app (`details.membership_id`) |
| 400 | `unknown_receiving_app` | no such app (`details.app_ids`) |
| 400 | `invalid_receiving_app` | your own app, or `accounts` |
| 403 | `receiving_app_disabled` | the receiving app is disabled (`details.app_ids`) |
| 422 | `validation_failed` | `scopes[i]`, `access_ttl_seconds` |

```json
{
  "error": {
    "code": "subject_token_wrong_app",
    "message": "subject_token was issued to the app 'dm', but 'briefcase' is asking for the proof. An app can only turn access tokens it received itself into OBO proofs.",
    "hint": "Use the access token 'briefcase' received when the account signed into 'briefcase'.",
    "details": { "token_app": "dm" }
  }
}
```

## `POST /v1/proofs/ata`

**Idempotent** (10 minutes). `{"audiences": ["remind", "waveform"], "scopes"?, "access_ttl_seconds"?}`
→ **201** the issued ATA proof. Errors: 400 `unknown_receiving_app`, 400 `invalid_receiving_app`,
403 `receiving_app_disabled`, 422 `validation_failed` (`audiences[i]`, …).

## `POST /v1/apps/{app_id}/proofs/ata`

The same for **app or owner**: the app's owner can issue ATA proofs from the account site (the
ATA page) without the app secret. Same body and response; 403 `app_disabled` for a disabled app.

## `POST /v1/proofs/refresh`

The issuing app only. `{"proof_refresh_token": "sapr_…", "access_ttl_seconds"?}` → **200** the
issued proof with the same `proof_id`, a new `proof_token` and a **rotated**
`proof_refresh_token`. An `Idempotency-Key` makes a retried refresh return the same new tokens.

Presenting a refresh token that was already used revokes the whole proof (400
`proof_refresh_token_reused`); later refreshes get 410 `proof_revoked`:

```json
{
  "error": {
    "code": "proof_revoked",
    "message": "Proof 01a11438-f6ef-75f2-86a0-091d4d1b9b37 was revoked at 2026-10-07T02:37:31.704Z because one of its proof refresh tokens was presented again after it had been used (refresh_token_reuse), so it can't be refreshed.",
    "hint": "Issue a new proof with POST /v1/proofs/obo (the account must still be signed into your app).",
    "details": { "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37", "reason": "refresh_token_reuse", "revoked_at": "2026-10-07T02:37:31.704Z" }
  }
}
```

Other errors: 400 `invalid_proof_refresh_token` (not a `sapr_` token, or unknown), 403
`not_issuing_app`, 410 `proof_expired`, 410 `proof_revoked` (revoked, or an OBO proof whose
sign-in ended).

## `POST /v1/proofs/verify`

`{"proof_token": "sap_…"}`, called by the app that received the token. **200** always: valid
(example at the top) or exactly:

```json
{ "valid": false, "expires_at": null }
```

A proof is valid only when the token is a known, unexpired proof token; the proof is not revoked;
the calling app is one of its audiences; the issuing app is active; and, for OBO, the account is
active, its membership with the issuing app is active and the sign-in behind the subject token is
still live. Every other case gets the same body, so a caller learns nothing about proofs that
aren't theirs. A malformed input (a refresh token, a JWT, an empty string) adds an
`x-accounts-hint` header describing the input:

```text
x-accounts-hint: proof_token must be a proof token (it starts with sap_), but this is a proof refresh token.
```

`user.membership_id` is the account's membership with the **issuing** app (the grant the proof
stands on); `user.id` is the account's current id. Verification is one indexed lookup (well under
a millisecond of database time); the app's credentials are checked through a 60-second cache.

## `POST /v1/proofs/revoke`

The issuing app only. One of `{"proof_id"}`, `{"proof_token"}` or `{"proof_refresh_token"}`.
**204.** Revoking a revoked proof is a no-op. Errors: 404 `proof_not_found` (not a proof of
yours; another app's proof id looks unknown), 400 `invalid_proof_id`, 403 `not_issuing_app`.

## `GET /v1/apps/{app_id}/proofs`

**app or owner**: proofs the app issued, newest first. Query: `kind` (`obo`, `ata`), `status`
(`active`, `revoked`, `expired`), `limit`, `cursor`.

```json
{
  "items": [
    {
      "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37",
      "kind": "obo",
      "audiences": ["briefcase"],
      "user": { "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada King", "pfp_url": "…", "status": "active" },
      "scopes": ["files.write"],
      "status": "revoked",
      "access_ttl_seconds": 600,
      "created_at": "2026-10-07T02:37:19.983Z",
      "expires_at": "2029-03-25T02:37:19.930Z",
      "token_expires_at": "2026-10-07T02:47:19.983Z",
      "last_refreshed_at": "2026-10-07T02:37:31.553Z",
      "revoked_at": "2026-10-07T02:37:31.704Z",
      "revoke_reason": "refresh_token_reuse"
    }
  ],
  "next_cursor": null
}
```

`expires_at` is the proof's end, `token_expires_at` its newest token's. `status` is live for OBO
grants: a proof whose sign-in was revoked shows `revoked` with `revoke_reason` `sign_in_revoked`.
Reasons: `revoked_by_app`, `revoked_by_owner`, `revoked_by_account`, `refresh_token_reuse`,
`sign_in_revoked`, `access_removed`, `account_deleted`, `membership_inactive`,
`account_inactive`.

## `DELETE /v1/apps/{app_id}/proofs/{proof_id}`

**app or owner**: revoke one of the app's proofs. **204.** 404 `proof_not_found`, 400
`invalid_proof_id`.

## `GET /v1/me/proofs`

**account**: the OBO proofs apps issued about you, newest first (`?status=active|revoked|expired`,
`limit`, `cursor`; unknown query parameters are refused).
Items: `proof_id`, `issuing_app` and `receiving_app` (app summaries), `scopes`, `status`,
`created_at`, `expires_at`, `token_expires_at`, `last_refreshed_at`, `revoked_at`,
`revoke_reason`.

## `DELETE /v1/me/proofs/{proof_id}`

**account**: revoke a proof about you; the receiving app's next verification answers
`valid: false`. **204.** 404 `proof_not_found`, 400 `invalid_proof_id`.

```json
{
  "error": {
    "code": "invalid_proof_id",
    "message": "'not-a-uuid' is not a proof id; proof ids are UUIDs like 01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a79.",
    "hint": "Use the proof_id from the issue response or from a proofs listing; to revoke by token send proof_token or proof_refresh_token instead."
  }
}
```

## What ends a proof

Besides revocation and expiry, an OBO proof ends with the grant it stands on: the account signing
out of the issuing app or removing its access, the sign-in being revoked (STK rotation, refresh
token reuse), or the account being deleted. Verification checks all of it live, so no webhook has
to arrive first.
