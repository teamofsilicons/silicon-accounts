---
title: How App verification and User verification work
description: Why User verification and App verification proofs exist, what a proof stands on, why verification is a live call that says only valid or not valid, and what ends a proof.
kind: informative
order: 40
related:
  - start/verify-a-proof.md
  - start/obo.md
  - start/ata.md
  - learn/webhooks.md
  - reference/api/proofs.md
---

# How App verification and User verification work

A proof is a statement that Silicon Accounts makes about a call between two apps. There are two kinds:

- **User verification (on behalf of):** "app A may act at app B for this account." The account signed into app A and agreed, in app A's own screens, to what app A will do at app B.
- **App verification (app to app):** "this call comes from app A, to app B." Each App verification proof is for exactly one app: to talk to app B and app C, app A gets one proof for each, so a token one app received can never be replayed to another, and each proof can be revoked on its own.

Silicon Accounts only issues proofs and verifies them. It never sees the call between the apps, never runs either app's endpoints and never shows a consent screen for a proof. What a scope means, what the receiving app allows, and how the issuing app asks for consent all stay with the apps. This page explains why the pieces are shaped the way they are, so you can decide well when the instructions don't cover your case.

To do the work, read the instructive pages: [Verify a proof](../start/verify-a-proof.md), [Act for an account at another app (User verification)](../start/obo.md) and [Prove your app to other apps (App verification)](../start/ata.md).

The whole exchange, as it ran on a local stack (tokens shortened):

```
# dm holds si:scout's access token at dm, and asks for a proof to act at briefcase
POST /v1/proofs/obo     (as dm)         {"subject_token":"eyJ…","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}
→ 201 {"proof_id":"01a11435-333a-…","proof_token":"sap_OMGt…","expires_at":"2026-10-07T02:43:13.274Z","proof_refresh_token":"sapr_i4mi…",…}

# dm calls briefcase with "Authorization: Proof sap_OMGt…"; briefcase asks Silicon Accounts
POST /v1/proofs/verify  (as briefcase)  {"proof_token":"sap_OMGt…"}
→ 200 {"valid":true,"kind":"obo","issuing_app":{"app_id":"dm",…},"user":{"uuid":"8HV","id":"si:scout",…},"scopes":["files.write"],…}

# the same token, checked by remind, which the proof doesn't name
POST /v1/proofs/verify  (as remind)     {"proof_token":"sap_OMGt…"}
→ 200 {"valid":false,"expires_at":null}
```

## Why not forward the access token

When an account signs into app A, app A gets an access token whose audience (`aud`) is `A`. It is tempting to send that token to app B. Don't, and Silicon Accounts is built so that it doesn't work:

- **Audience confusion.** If app B accepted tokens issued to app A, any app that ever received a token for app A could act at app B. Access tokens are bound to one app on purpose.
- **B can't tell who is calling.** A forwarded token says who the account is, not which app is acting for it.
- **Too much power.** The access token is everything app A may do. A proof carries only the scopes app A chose for this one purpose, for one receiving app.
- **Reuse elsewhere.** A token copied from app B's logs could be replayed at app C. A proof verifies only for the apps it names, and only when they ask with their own credentials.

So app A trades the access token (the *subject token*) for a proof that names app B, and app B checks the proof with Silicon Accounts. App A is the only app that can do the trade: the subject token must have been issued to app A itself (`subject_token_wrong_app` otherwise).

## Two tokens, the sign-in pattern

A proof follows the same token logic as a sign-in:

| | proof token | proof refresh token |
|---|---|---|
| looks like | `sap_` + 43 characters | `sapr_` + 43 characters |
| who sees it | the issuing app, and every receiving app it is sent to | the issuing app only |
| lives | 60 to 1800 seconds, default 1800 (`access_ttl_seconds`) | as long as the proof: at most 900 days |
| used for | `POST /v1/proofs/verify` | `POST /v1/proofs/refresh` (rotates on every use) |

Why short proof tokens: a proof token travels to another app, into its logs, caches and error reports. A short life bounds what a leaked one is worth. Why a refresh token: the issuing app can keep acting for months without asking the account again, while each token that leaves the issuing app stays short-lived.

Why rotation and reuse detection: each refresh returns a new refresh token and marks the old one used. If a used refresh token is ever presented again, either the issuing app has a bug or someone copied the token. Silicon Accounts can't tell which party is the real one, so it revokes the whole proof (`proof_refresh_token_reused`, and every later refresh gets `410 proof_revoked` with `details.reason: "refresh_token_reuse"`). The issuing app issues a new proof; the copy is now worthless.

Two consequences to design around:

- **A refresh doesn't end earlier proof tokens.** Each proof token verifies until its own `expires_at`, unless the proof itself ends. Verified on the local stack: after a refresh, the previous `sap_…` token still answered `{"valid": true, …}` with its original `expires_at`. To cut a token off, revoke the proof.
- **Lifetimes are absolute times, never `expires_in`.** Issuing and refreshing accept an `Idempotency-Key`, and a retry with the same key replays the first answer verbatim for up to 10 minutes. A relative lifetime would overstate what is left on a replay; `expires_at` stays exact.

## Verification is a live call

Proof tokens are random strings, not signed JWTs, so a receiving app can't check one offline: it asks `POST /v1/proofs/verify` with its own app credentials. That costs one network call per check. In exchange:

- **Revocation is immediate.** There is no window in which a revoked proof still verifies somewhere.
- **The whole grant is checked every time.** A User verification proof is only as good as the sign-in, the membership and the account behind it, and those are read live on each verification, not copied into the token.

The check itself is cheap: the verifying app's credentials go through a 60-second in-memory cache, then one query that follows primary keys only (proof token → proof → issuing app, plus the account, the membership and the sign-in for User verification). Measured on a local stack (debug build, Postgres 16, HTTP over loopback with keep-alive, on a machine busy with other test runs):

| verifications | p50 | p95 | p99 |
|---|---|---|---|
| one after another (1,000) | 0.46 ms | 0.70 ms | 0.89 ms |
| 10 at a time (2,000) | 1.02 ms | 2.57 ms | 4.13 ms |
| 50 at a time (2,000) | 9.45 ms | 23.6 ms | 43.2 ms |

At 50 at once, requests wait for one of the 32 database connections and for the busy machine's CPU, not for the query itself. Inside the server the query takes about 0.03 ms (`EXPLAIN ANALYZE` on 50,000 proofs; the crate's own benchmark measures p50 ≈ 0.16 ms for a whole in-process verification). Issuing a User verification proof and refreshing one write rows, so they cost more: on the same busy machine, issuing measured p50 8.9 ms and a refresh p50 5.7 ms. Over the internet the round trip to Silicon Accounts dominates all of these.

So verify on every call that needs the proof. If you cache an answer, cache it for seconds, never past its `expires_at`, and accept that a revocation reaches you only when the cached answer expires.

## Valid, or not valid, and nothing more

A valid answer tells the receiving app everything it needs:

```json
{
  "valid": true,
  "proof_id": "01a11435-333a-725d-bb0e-75adde136703",
  "kind": "obo",
  "expires_at": "2026-10-07T02:43:13.274Z",
  "issuing_app": { "app_id": "dm", "name": "DM" },
  "receiving_app": { "app_id": "briefcase", "name": "Briefcase" },
  "user": { "uuid": "8HV", "id": "si:scout", "kind": "silicon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

`expires_at` is when this proof token stops verifying. `receiving_app` is always the app that asked. `user` is the account (User verification; `null` for App verification): `uuid` is permanent, `id` is its current `c:` or `si:` id, and `membership_id` is its membership with the **issuing** app, because that membership is the grant the proof stands on.

Anything else is exactly this, with HTTP 200:

```json
{"valid": false, "expires_at": null}
```

That covers an unknown token, an expired token, a revoked proof, a proof past its lifetime, a proof that names other apps, a disabled issuing app, and (User verification) an account that is no longer active, a membership that is no longer active, or a sign-in that was revoked or expired. The receiving app is a third party to the proof, so the answer deliberately tells it nothing more: "revoked" versus "unknown" would reveal that a token exists, "not for you" would reveal what other apps do, and "account inactive" would reveal that an account was deleted. Treat every `valid: false` the same way: refuse the call.

When the *input* is malformed (a refresh token, a JWT, an empty string, or a token with a label such as `Proof sap_…` around it) the body is the same, and an `x-accounts-hint` header describes the input, never the proof:

```
x-accounts-hint: proof_token must be a proof token (it starts with sap_), but this is a proof refresh token.
```

The issuing app, on the other hand, gets precise errors (`410 proof_revoked` with the reason and the time, `410 proof_expired`, …) when it refreshes: it owns the proof and needs to know whether to issue a new one.

## What a User verification proof stands on

A User verification proof is issued from a subject token, and it stands on everything behind that token:

```
proof ── the sign-in at the issuing app (the token family of the subject token)
      ── the account's membership with the issuing app (must be active)
      ── the account (must be active)
```

If any link ends, the proof ends with it, at once, everywhere. The proof also never outlives the sign-in: its `refresh_expires_at` is the earlier of 900 days and the sign-in's own expiry. In the local run, a User verification proof issued from a sign-in that ends on `2029-03-25T02:33:08.110Z` got exactly that `refresh_expires_at`.

| what happened | verify says | refresh says (issuing app) | listings show |
|---|---|---|---|
| the issuing app revoked the proof (`POST /v1/proofs/revoke`, or `DELETE /v1/apps/{app_id}/proofs/{id}`) | `valid: false` | `410 proof_revoked`, reason `revoked_by_app` | `revoked`, `revoked_by_app` |
| the issuing app's owner revoked it (`DELETE /v1/apps/{app_id}/proofs/{id}` with their session) | `valid: false` | `410 proof_revoked`, `revoked_by_owner` | `revoked`, `revoked_by_owner` |
| the account revoked it (`DELETE /v1/me/proofs/{id}`, `accounts proofs revoke`, the account site) | `valid: false` | `410 proof_revoked`, `revoked_by_account` | `revoked`, `revoked_by_account` |
| a used proof refresh token was presented again | `valid: false` | `400 proof_refresh_token_reused`, then `410 proof_revoked`, `refresh_token_reuse` | `revoked`, `refresh_token_reuse` |
| the sign-in behind it was revoked: the issuing app revoked the account's token (`membership.signed_out`, `app_revoked`), a custodian rotated the Silicon's STK (`stk_rotated`), the app reused a sign-in refresh token or an authorization code | `valid: false` | `410 proof_revoked`, `sign_in_revoked` (with when and why) | `revoked`, `sign_in_revoked` |
| the account removed the issuing app's access (`membership.access_removed`) | `valid: false` | `410 proof_revoked`, `access_removed` | `revoked`, `access_removed` |
| the account was deleted (`account.deleted`) | `valid: false` | `410 proof_revoked`, `account_deleted` | `revoked`, `account_deleted` |
| the proof reached its end: 900 days, or the end of the sign-in it stands on, whichever comes first (its `refresh_expires_at`) | `valid: false` | `410 proof_expired` (`details.expires_at`) | `expired` |
| only this proof token expired | `valid: false` for that token | refresh works: the proof lives on | `active` |

Each row was run against a local stack, except the `proof_expired` row and the sign-in refresh token and authorization code causes, which go through the same checks.

A revoked sign-in never comes back, so that end is also stored on the proof (`revoked_by = system`), by an hourly sweep or at once when the issuing app refreshes or revokes the proof. Storing it changes nothing a listing shows: verification and listings already derive it live, and `revoked_at` is when the sign-in was revoked. A later revoke of such a proof is a no-op that keeps this first end, so a proof's history never changes its mind about when and why it ended.

App verification proofs stand only on themselves and the issuing app: they end when revoked, at the end of their lifetime, or (for verification) while the issuing app is disabled.

## Who can do what

| action | User verification | App verification |
|---|---|---|
| issue | the issuing app, with its credentials and the account's access token | the issuing app with its credentials, or its owner through the App verification page (`POST /v1/apps/{app_id}/proofs/ata` with their session) |
| verify | only the receiving app | only the receiving app (an App verification proof is for exactly one app; one proof per app) |
| refresh | only the issuing app | only the issuing app |
| revoke | the issuing app (by `proof_id`, `proof_token` or `proof_refresh_token`), its owner (by id), and the account it speaks for (by id) | the issuing app and its owner |
| list | the issuing app and its owner (`GET /v1/apps/{app_id}/proofs`); the account (`GET /v1/me/proofs`) | the issuing app and its owner |

A receiving app can't revoke a proof. If it no longer trusts one, it simply stops accepting it; the issuing app is the one that revokes.

The account's view matters most for User verification. Every Carbon and Silicon sees each User verification proof issued on its behalf (`GET /v1/me/proofs`, `accounts proofs list`, the account site) and can revoke any of them. Issued and revoked proofs also appear in the account's history (`GET /v1/me/history?kind=proof`), for example "DM got a proof to act for you at Briefcase". Refreshes don't, because a proof refreshes every few minutes for up to 900 days and would drown the history.

## Scopes are yours

Scopes are app-defined strings carried as they are: at most 20 distinct ones per proof, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -`. Duplicates are dropped and the order is kept. Silicon Accounts doesn't interpret them. The issuing app asks the account's consent for them in its own screens; the receiving app decides what each one allows and must check the scopes on every call (a valid proof without the scope you need is still a refusal).

## Idempotent issuing

`POST /v1/proofs/obo`, `POST /v1/proofs/ata` and `POST /v1/apps/{app_id}/proofs/ata` take an `Idempotency-Key` header, and `POST /v1/proofs/refresh` accepts one. A retry with the same key and the same body within 10 minutes returns the first response again, with the header `idempotent-replayed: true`, instead of issuing a second proof (or, for a refresh, instead of presenting a used refresh token and revoking the proof). The same key with a different body is `409 idempotency_key_reused`. The stored response holds the tokens, so it is kept encrypted.

A replay returns the original answer even if that proof has ended since. Use a new key for each new logical request, and the same key only to retry.

## What is stored

Silicon Accounts stores only an HMAC of each proof token and proof refresh token, keyed with a server-side secret (a pepper), never the token itself: a copy of the database can't be turned into working tokens. Proof rows stay forever as history. Tokens are deleted by the hourly sweep: proof tokens a day after they expire, and every token of a proof 30 days after the proof was revoked or expired. After that, refreshing or revoking *by token* reports that the token is not known (`invalid_proof_refresh_token`, or `404 proof_not_found` with a message saying why), while revoking by `proof_id` still answers `204`.

## Related

- [Verify a proof](../start/verify-a-proof.md): the receiving app's side, step by step.
- [Act for an account at another app (User verification)](../start/obo.md): issuing, refreshing and revoking.
- [Prove your app to other apps (App verification)](../start/ata.md).
- [How webhooks work](webhooks.md): the events that announce the same ends (`membership.signed_out`, `membership.access_removed`, `account.deleted`).
- [Proofs API reference](../reference/api/proofs.md): every proof endpoint, field and error.

## Retained verification history

[App verification history](https://developers.teamofsilicons.com/app-verification) brings together records issued by apps you currently manage, regardless of whether they were generated in the portal, through the CLI or through the API. Each retained family can include issuance, refresh and revocation events. Expired credentials can be removed without removing these records. Historical expiry values identify whether they were recorded or derived, and absent values are shown as unavailable.

History never reveals raw proof or refresh tokens. Copy those only when they are generated. Each history request checks current management access; receiving a proof does not grant access to the issuing app's history. Accounts see and revoke their own User verifications at the account site's existing `/proofs` route.

The product names are App verification and User verification. Protocol values and existing integration commands remain `ata` and `obo` respectively.
