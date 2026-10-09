---
title: App verification and User verification endpoints
description: Issue, refresh, verify, revoke and list App verification and User verification proofs, with every request, response and limit.
kind: informative
order: 66
related:
  - reference/api.md
  - start/verify-a-proof.md
  - start/user-verification.md
  - start/app-verification.md
  - learn/proofs.md
  - reference/errors.md
---

# App verification and User verification endpoints

We make proof tokens, and we check them for the app that receives them. A **User verification** proof says which account an app is acting for. An **App verification** proof says which app is calling. Every proof names exactly one receiving app.

What a proof's scopes mean, and which actions they allow, is up to the apps. For the steps, follow [Verify a proof](../../start/verify-a-proof.md), [User verification](../../start/user-verification.md) or [App verification](../../start/app-verification.md). [How proofs work](../../learn/proofs.md) explains what each app is responsible for.

Here the receiving app verifies a proof token:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/proofs/verify" -u "briefcase:$BRIEFCASE_SECRET" \
  -H 'Content-Type: application/json' -d '{"proof_token":"'"$PROOF_TOKEN"'"}'
```

```json
{
  "valid": true,
  "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37",
  "kind": "user_verification",
  "expires_at": "2026-10-07T02:47:19.983Z",
  "issuing_app": { "app_id": "dm", "name": "DM" },
  "receiving_app": { "app_id": "briefcase", "name": "Briefcase" },
  "user": { "uuid": "8HV", "id": "c:ada", "kind": "carbon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

Anything else gets exactly `{"valid": false, "expires_at": null}`.

Every endpoint takes **app** auth (`-u app_id:app_secret`) unless its section says otherwise.
Request bodies refuse unknown fields, and proof responses are `Cache-Control: no-store`.

| Number | Value |
|---|---|
| proof token (`sap_…`) lifetime | `access_ttl_seconds`, 60 to 1800, default 1800 |
| proof lifetime (its `sapr_…` refresh token) | 900 days; a User verification proof never outlives the sign-in it stands on |
| scopes | at most 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -`, defined by the apps |
| App verification receiving apps | exactly 1 per proof (`receiving_app`); one proof per app |

## The issued proof

`POST /v1/proofs/user-verification`, `/app-verification`, `/refresh` and `POST /v1/apps/{app_id}/proofs/app-verification` all answer with:

```json
{
  "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37",
  "kind": "user_verification",
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

An App verification proof has `"kind": "app_verification"`, its one `receiving_app`, and
`"user": null`. Give the `proof_token` to the receiving app and keep the `proof_refresh_token`
yourself. Lifetimes are absolute timestamps (there's no `expires_in`), so a replayed idempotent
response still tells the truth about how much time is left.

## `POST /v1/proofs/user-verification`

**Idempotent** (10 minutes). Body:

| Field | |
|---|---|
| `subject_token` | an access token **your app** received for the account (its `aud` is your app) |
| `receiving_app` | the app that will verify the proof |
| `scopes` | optional list of app-defined strings |
| `access_ttl_seconds` | optional, 60 to 1800 |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/proofs/user-verification" -u "dm:$DM_SECRET" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: user_verification-briefcase-8HV-1' \
  -d '{"subject_token":"'"$ACCOUNT_ACCESS_TOKEN"'","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}'
```

Answers **201** with the issued proof. Get the account's consent in your own interface first,
because we don't show a consent screen for proofs.

| Status | Code | Why |
|---|---|---|
| 400 | `invalid_subject_token` | not an access token, bad signature, expired, or its sign-in ended (`details.reason`: `not_an_access_token`, `invalid`, `expired`, `revoked`) |
| 403 | `subject_token_wrong_app` | the token was issued to another app (`details.token_app`): an app can only turn its own tokens into proofs |
| 403 | `account_not_active` | the account isn't active (`details.status`) |
| 403 | `membership_inactive` | the account has no active membership with your app (`details.membership_id`) |
| 400 | `unknown_receiving_app` | no such app (`details.app_ids`) |
| 400 | `invalid_receiving_app` | your own app, or `silicon-accounts` |
| 403 | `receiving_app_disabled` | the receiving app is disabled (`details.app_ids`) |
| 422 | `validation_failed` | `scopes[i]`, `access_ttl_seconds` |

```json
{
  "error": {
    "code": "subject_token_wrong_app",
    "message": "subject_token was issued to the app 'dm', but 'briefcase' is asking for the proof. An app can only turn access tokens it received itself into User verifications.",
    "hint": "Use the access token 'briefcase' received when the account signed into 'briefcase'.",
    "details": { "token_app": "dm" }
  }
}
```

## `POST /v1/proofs/app-verification`

**Idempotent** (10 minutes). Send `{"receiving_app": "remind", "scopes"?, "access_ttl_seconds"?}`
and get **201** with the issued App verification proof. An App verification proof is always for
exactly one app, so to talk to `remind` and `waveform` you issue one proof for each.

Errors:

- 422 `app_verification_single_app`: the body has `audiences`, of any length ("An app verification
  is for exactly one app; ask for one proof per app.", with `details.field: "audiences"` and
  `details.apps`);
- 400 `unknown_receiving_app`;
- 400 `invalid_receiving_app`: your own app, or `silicon-accounts`/`developer`;
- 403 `receiving_app_disabled`;
- 422 `validation_failed`: `receiving_app`, `scopes[i]`, `access_ttl_seconds`.

## `POST /v1/apps/{app_id}/proofs/app-verification`

The same, for **app or author**: an app's authors can issue App verification proofs from the
app's App verification page on developers.teamofsilicons.com without the app secret. The body
and response are the same (including the 422 `app_verification_single_app` for `audiences`), and
a disabled app gets 403 `app_disabled`.

## `POST /v1/proofs/refresh`

Only the issuing app can refresh. Send `{"proof_refresh_token": "sapr_…", "access_ttl_seconds"?}`
and get **200** with the issued proof: the same `proof_id`, a new `proof_token` and a **rotated**
`proof_refresh_token`. With an `Idempotency-Key`, a retried refresh returns the same new tokens.

If a refresh token that was already used is presented again, we revoke the whole proof (400
`proof_refresh_token_reused`), and later refreshes get 410 `proof_revoked`:

```json
{
  "error": {
    "code": "proof_revoked",
    "message": "Proof 01a11438-f6ef-75f2-86a0-091d4d1b9b37 was revoked at 2026-10-07T02:37:31.704Z because one of its proof refresh tokens was presented again after it had been used (refresh_token_reuse), so it can't be refreshed.",
    "hint": "Issue a new proof with POST /v1/proofs/user-verification (the account must still be signed into your app).",
    "details": { "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37", "reason": "refresh_token_reuse", "revoked_at": "2026-10-07T02:37:31.704Z" }
  }
}
```

Other errors: 400 `invalid_proof_refresh_token` (not a `sapr_` token, or unknown), 403
`not_issuing_app`, 410 `proof_expired`, and 410 `proof_revoked` (revoked, or a User verification
proof whose sign-in ended).

## `POST /v1/proofs/verify`

The app that received the token sends `{"proof_token": "sap_…"}`. The answer is always **200**:
valid (the example at the top) or exactly:

```json
{ "valid": false, "expires_at": null }
```

A proof is valid only when all of these hold:

- the token is a known, unexpired proof token;
- the proof isn't revoked;
- the calling app is its receiving app;
- the issuing app is active;
- for User verification, the account is active, its membership with the issuing app is active,
  and the sign-in behind the subject token is still live.

Every other case gets the same body, so a caller learns nothing about proofs that aren't theirs.
A malformed input (a refresh token, a JWT, an empty string) adds an `x-accounts-hint` header that
describes it:

```text
x-accounts-hint: proof_token must be a proof token (it starts with sap_), but this is a proof refresh token.
```

`user.membership_id` is the account's membership with the **issuing** app (the grant the proof
stands on), and `user.id` is the account's current id. Verifying is one indexed lookup (well under
a millisecond of database time), and the app's credentials are checked through a 60-second cache,
so verify on every call that needs the proof.

## `POST /v1/proofs/revoke`

Only the issuing app can revoke. Send one of `{"proof_id"}`, `{"proof_token"}` or
`{"proof_refresh_token"}` and get **204**. Revoking a revoked proof does nothing. Errors: 404
`proof_not_found` (not one of your proofs; another app's proof id looks unknown to you), 400
`invalid_proof_id`, 403 `not_issuing_app`.

## `GET /v1/apps/{app_id}/proofs`

**app or author**: the proofs your app issued, newest first. Filter with `kind`
(`user_verification`, `app_verification`), `status` (`active`, `revoked`, `expired`), `limit` and
`cursor`.

```json
{
  "items": [
    {
      "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37",
      "kind": "user_verification",
      "receiving_app": "briefcase",
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

`expires_at` is when the proof ends, and `token_expires_at` is when its newest token does. For
User verification, `status` is live: a proof whose sign-in was revoked shows `revoked` with
`revoke_reason` `sign_in_revoked`. The reasons are `revoked_by_app`, `revoked_by_owner`,
`revoked_by_account`, `refresh_token_reuse`, `sign_in_revoked`, `access_removed`,
`account_deleted`, `membership_inactive` and `account_inactive`.

## `DELETE /v1/apps/{app_id}/proofs/{proof_id}`

**app or author**: revokes one of your app's proofs. **204.** Errors: 404 `proof_not_found`, 400
`invalid_proof_id`.

## `GET /v1/me/app-verifications`

**signed-in manager**: the App verification records we keep for every app you currently manage, whether they were made in the portal, the CLI or the API. This is the central history the developer portal shows. Filter with `app_id` or `status=active|revoked|expired`, and page with `limit` and the `next_cursor` we return. Results are newest first. Being the receiving app of a proof doesn't give you access to another app's records.

## `GET /v1/apps/{app_id}/proofs/{proof_id}/history`

**signed-in manager**: the kept history of one App verification record, meaning when it was issued, refreshed and revoked. We check that you currently manage the issuing app. Historical expiry values show whether they were recorded at the time or derived for older (legacy) records, and missing values stay missing rather than being filled in as facts. No raw proof or refresh token values are returned.

Records and their history stay after the credentials expire or are removed. See [central history](../../start/app-verification.md#central-history-for-apps-you-manage) for the portal flow. In JSON the kinds are `app_verification` and `user_verification`, and the issuing routes are `/app-verification` and `/user-verification`.

## `GET /v1/me/proofs`

**account**: the User verification proofs apps issued about you, newest first. Filter with
`?status=active|revoked|expired`, `limit` and `cursor`; unknown query parameters are refused.
Each item has `proof_id`, `issuing_app` and `receiving_app` (app summaries), `scopes`, `status`,
`created_at`, `expires_at`, `token_expires_at`, `last_refreshed_at`, `revoked_at` and
`revoke_reason`.

## `DELETE /v1/me/proofs/{proof_id}`

**account**: revokes a proof about you, and the receiving app's next verification answers
`valid: false`. **204.** Errors: 404 `proof_not_found`, 400 `invalid_proof_id`.

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

Besides revocation and expiry, a User verification proof ends when the grant it stands on ends:
the account signs out of the issuing app or removes its access, the sign-in is revoked (an STK
rotation, a reused refresh token), or the account is deleted. Verification checks all of this
live, so no webhook has to arrive first.
