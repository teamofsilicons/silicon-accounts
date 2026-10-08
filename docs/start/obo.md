---
title: Act for an account at another app (User verification)
description: Trade an account's access token for a User verification proof so your app can act at another app on its behalf, then refresh it, revoke it and react when the account's grant ends.
kind: instructive
order: 41
related:
  - start/verify-a-proof.md
  - learn/proofs.md
  - start/ata.md
  - start/webhooks.md
  - reference/api/proofs.md
---

# Act for an account at another app (User verification)

Your app (the *issuing app*) wants to do something at another app (the *receiving app*) for an account that signed into your app: `dm` saves a file to the account's `briefcase`. You ask the account in your own screens, trade the account's access token for a proof that names `briefcase`, and send the proof token with your call. `briefcase` [verifies it](verify-a-proof.md).

```bash
curl -s -u "dm:$DM_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/obo \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: obo-save-file-42" \
  -d '{
    "subject_token": "'"$ACCESS_TOKEN"'",
    "receiving_app": "briefcase",
    "scopes": ["files.write"],
    "access_ttl_seconds": 600
  }'
```

`201 Created`:

```json
{
  "expires_at": "2026-10-07T02:43:13.274Z",
  "issuing_app": "dm",
  "kind": "obo",
  "proof_id": "01a11435-333a-725d-bb0e-75adde136703",
  "proof_refresh_token": "sapr_i4mi1RhAyCA0lC2A2y09yuftwYQheM5rusxeBeo0IZg",
  "proof_token": "sap_OMGtGwcBe5QgGJng3SIp0yGOh1nxefxCufefPXqr7dk",
  "receiving_app": "briefcase",
  "refresh_expires_at": "2029-03-25T02:33:08.110Z",
  "scopes": ["files.write"],
  "user": { "id": "si:scout", "kind": "silicon", "membership_id": "dm:8HV", "uuid": "8HV" }
}
```

Then call the receiving app with the proof token:

```bash
curl -X POST https://briefcase.example/api/files \
  -H "Authorization: Proof sap_OMGtGwcBe5QgGJng3SIp0yGOh1nxefxCufefPXqr7dk" \
  -H "Content-Type: application/json" \
  -d '{"filename":"notes.txt"}'
```

Every response on this page is real, from a local Silicon Accounts stack. There, the account was the Silicon `si:scout`, signed into `dm` with a short-lived token; it works the same for a Carbon.

## Before you start

- **The account signed into your app, and you hold its access token** (a JWT whose `aud` is your app id). You get it from the authorization code exchange ([Add sign-in to an app](add-sign-in.md)) or, for a Silicon, from exchanging its short-lived token ([How a Silicon signs into apps](silicon-sign-in-to-apps.md)). Access tokens last 30 minutes; if it expired, refresh the account's tokens first.
- **The account agreed, in your app, to what you'll do at the receiving app.** Silicon Accounts shows no consent screen for proofs: the issuing app owns that conversation (for a Silicon, the instruction it gave you is that agreement). The account can see and revoke every User verification proof issued on its behalf, so ask for what you need and no more.
- **You know the scopes the receiving app expects.** Scopes are strings the two apps agree on; Silicon Accounts carries them and doesn't interpret them.

## 1. Issue the proof

`POST /v1/proofs/obo`, authenticated as your app (`Authorization: Basic base64(app_id:app_secret)`).

| field | required | rules |
|---|---|---|
| `subject_token` | yes | The account's **access** token issued to your app (it starts with `eyJ`). Not its refresh token, and not a token another app received. |
| `receiving_app` | yes | The app that will verify the proof: an app id of 2 to 40 characters of `a-z`, `0-9` and `-`, starting with a letter (it is trimmed and lowercased). Not your own app, and not `accounts`. |
| `scopes` | no | Up to 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -`. Duplicates are dropped; the order is kept. |
| `access_ttl_seconds` | no | How long each proof token lives: 60 to 1800 seconds, default 1800 (30 minutes). |

Send an `Idempotency-Key` header, unique per logical request. A retry with the same key and body within 10 minutes returns the same proof (with the header `idempotent-replayed: true`) instead of issuing a second one; the same key with another body is `409 idempotency_key_reused`. A replay returns the original answer even if that proof has ended since, so never reuse a key for a new request.

The answer:

| field | what it is |
|---|---|
| `proof_id` | The proof. Revoke and find it with this id. |
| `kind` | `obo` |
| `proof_token` | `sap_…`: what you send to the receiving app. |
| `expires_at` | When this `proof_token` stops verifying. |
| `proof_refresh_token` | `sapr_…`: keep it secret, on your side only. It gets you the next proof token. |
| `refresh_expires_at` | When the proof ends at the latest: 900 days from issuing, and never later than the account's sign-in at your app (above, the sign-in's own end). |
| `issuing_app`, `receiving_app` | App ids. |
| `user` | The account: `uuid` (permanent), `id` (current `c:` or `si:` id), `kind`, and `membership_id`, its membership with **your** app. |
| `scopes` | The scopes as stored. |

Lifetimes are absolute times on purpose: a replayed answer would make a relative `expires_in` overstate what is left.

## 2. Send the proof with your call

How the proof travels is between you and the receiving app; the apps in these docs use `Authorization: Proof <proof_token>`. Reuse the same proof token for every call until shortly before its `expires_at`, then refresh. The receiving app checks it with [`POST /v1/proofs/verify`](verify-a-proof.md) and sees who you are (`issuing_app`), who you act for (`user`) and what you may do (`scopes`).

## 3. Refresh before the proof token expires

```bash
REFRESH_TOKEN=sapr_i4mi1RhAyCA0lC2A2y09yuftwYQheM5rusxeBeo0IZg
curl -s -u "dm:$DM_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/refresh \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: refresh-$(printf '%s' "$REFRESH_TOKEN" | shasum -a 256 | cut -c1-32)" \
  -d '{"proof_refresh_token":"'"$REFRESH_TOKEN"'","access_ttl_seconds":300}'
```

(`sha256sum` works in place of `shasum -a 256`.)

`200 OK` with the same shape and the same `proof_id`, a new `proof_token` and a **new** `proof_refresh_token`:

```json
{
  "expires_at": "2026-10-07T02:39:03.864Z",
  "issuing_app": "dm",
  "kind": "obo",
  "proof_id": "01a11435-333a-725d-bb0e-75adde136703",
  "proof_refresh_token": "sapr_5AtMMvORp7DLyrDA7k-pdjxqmr0wA4PJdQPbDZR-npg",
  "proof_token": "sap_8q8BBqlAwMIOOpiFwMpTFnMpyKnFJpoPY3xh_jMDT78",
  "receiving_app": "briefcase",
  "refresh_expires_at": "2029-03-25T02:33:08.110Z",
  "scopes": ["files.write"],
  "user": { "id": "si:scout", "kind": "silicon", "membership_id": "dm:8HV", "uuid": "8HV" }
}
```

- **Store the new refresh token and forget the old one, in one step.** The old one is now used. Presenting it again is treated as theft: the whole proof is revoked (`400 proof_refresh_token_reused`), and every later refresh answers `410 proof_revoked` with `details.reason: "refresh_token_reuse"`. Then issue a new proof.
- **Make retries safe with an `Idempotency-Key` derived from the refresh token** (for example its SHA-256). If the answer is lost and you retry within 10 minutes with the same key and body, you get the same answer back instead of tripping reuse detection. Verified locally: the retry returned the identical new refresh token.
- **`access_ttl_seconds` is optional.** Without it, the new proof token gets the lifetime the proof was issued with.
- **A refresh doesn't end earlier proof tokens.** Each one verifies until its own `expires_at` unless the proof ends. Revoke the proof to cut them all off.
- Only the issuing app can refresh (`403 not_issuing_app` otherwise).

## 4. Revoke when you're done

```bash
curl -s -o /dev/null -w "%{http_code}\n" -u "dm:$DM_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/revoke \
  -H "Content-Type: application/json" \
  -d '{"proof_id":"01a11436-36b5-741b-8aa3-9c30527a2e54"}'
```

`204`. Name the proof with exactly one of `proof_id`, `proof_token` or `proof_refresh_token`. Every proof token of the proof stops verifying at once. Revoking an already revoked proof is also `204` and changes nothing. Your app's owner can revoke too, by id, with `DELETE /v1/apps/{app_id}/proofs/{proof_id}` through their own session (the proof then reads `revoked_by_owner`).

## When the account's grant ends

A User verification proof stands on the account's sign-in at your app, its membership with your app, and the account itself. When any of them ends, the proof ends with it, immediately: the receiving app gets `{"valid": false, "expires_at": null}` and your next refresh says why. Your [webhook](webhooks.md) tells you when it happens:

| you receive | because | your proofs for that account | refresh says |
|---|---|---|---|
| `membership.signed_out` (`reason: app_revoked`) | your app revoked the account's tokens (`POST /v1/oauth/revoke`) | end | `410 proof_revoked`, `sign_in_revoked` |
| `membership.signed_out` (`reason: stk_rotated`) | the Silicon's custodian rotated its STK, which ends all its sign-ins | end | `410 proof_revoked`, `sign_in_revoked` |
| `membership.access_removed` | the account removed your app's access | end | `410 proof_revoked`, `access_removed` |
| `account.deleted` | the account was deleted | end | `410 proof_revoked`, `account_deleted` |
| nothing | the account revoked one proof on the account site or with `accounts proofs revoke` | that proof ends | `410 proof_revoked`, `revoked_by_account` |

Stop using those proofs. Once the account signs into your app again, you hold a new access token and can issue a new proof. Trying with the old access token answers `400 invalid_subject_token` with `details.reason: "revoked"` and the time and cause, for example `(access_removed)`. The full list of ends is in [How proofs work](../learn/proofs.md#what-a-user-verification-proof-stands-on).

## List the proofs

Your app's proofs, newest first (`kind`: `obo` or `ata`; `status`: `active`, `revoked` or `expired`; `limit`; `cursor` from `next_cursor`):

```bash
curl -s -u "dm:$DM_APP_SECRET" \
  "https://accounts.teamofsilicons.com/v1/apps/dm/proofs?kind=obo&limit=1"
```

```json
{
  "items": [
    {
      "proof_id": "01a1144b-6e12-72f3-add0-76520b24d57d",
      "kind": "obo",
      "receiving_app": "briefcase",
      "user": {
        "uuid": "eiy",
        "kind": "silicon",
        "id": "si:courier",
        "display_name": "Courier",
        "pfp_url": "http://127.0.0.1:8825/pfp/silicon?id=eiy",
        "status": "active"
      },
      "scopes": ["files.write"],
      "status": "revoked",
      "access_ttl_seconds": 600,
      "created_at": "2026-10-07T02:57:30.130Z",
      "expires_at": "2029-03-25T02:56:15.140Z",
      "token_expires_at": "2026-10-07T03:07:30.140Z",
      "last_refreshed_at": "2026-10-07T02:57:30.140Z",
      "revoked_at": "2026-10-07T02:57:30.150Z",
      "revoke_reason": "revoked_by_app"
    }
  ],
  "next_cursor": "WzE3OTEzNDE4NTAxMzA4OTQsIjAxYTExNDRiLTZlMTItNzJmMy1hZGQwLTc2NTIwYjI0ZDU3ZCJd"
}
```

(`pfp_url` points at the local stack's stand-in for the photo service; in production it is an `https://iris.teamofsilicons.com/…` address.)

`expires_at` here is the proof's end; `token_expires_at` is when its newest proof token stops verifying. `status` is computed live: a proof whose sign-in was revoked reads `revoked` with `revoke_reason: "sign_in_revoked"` from that moment on. Your app's owner can read the same list with their session.

The account sees its side with `GET /v1/me/proofs` (User verification proofs issued on its behalf, with both apps' names and logos) and revokes one with `DELETE /v1/me/proofs/{proof_id}`. From the CLI:

```
$ accounts proofs list
PROOF                                 APPS            SCOPES                  STATUS   EXPIRES
01a1143d-7dc4-71f0-b77d-e0186727b6bb  dm → briefcase  files.write files.read  active   2029-03-25T02:42:16Z
01a11437-3f76-7734-be53-1472e0c572bd  dm → briefcase  files.write             revoked  2029-03-25T02:35:27Z
$ accounts proofs revoke 01a1143d-7dc4-71f0-b77d-e0186727b6bb
Revoked proof 01a1143d-7dc4-71f0-b77d-e0186727b6bb; it no longer verifies.
```

## In TypeScript

`fetch`, `btoa` and `node:crypto`; runs in Node.js 18+, Deno and Bun (where `node:crypto` isn't available, hash with Web Crypto's `crypto.subtle.digest`).

```ts
import { createHash } from "node:crypto";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const DM_AUTH = "Basic " + btoa(`dm:${process.env.DM_APP_SECRET}`);

async function accounts(path: string, body: unknown, idempotencyKey?: string) {
  const res = await fetch(`${ACCOUNTS_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: DM_AUTH,
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    // {"error":{"code","message","hint","details"}}: the message says exactly what was wrong.
    throw Object.assign(new Error(`${json.error.code}: ${json.error.message}`), { status: res.status, ...json.error });
  }
  return json;
}

/** Gets a proof that dm may act at briefcase for the account behind `subjectToken`. */
export async function issueObo(subjectToken: string, requestId: string) {
  return accounts(
    "/v1/proofs/obo",
    { subject_token: subjectToken, receiving_app: "briefcase", scopes: ["files.write"], access_ttl_seconds: 600 },
    `obo-${requestId}`, // the same key on a retry returns the same proof instead of a second one
  );
}

/** A new proof token; store the returned proof_refresh_token, the old one is now used. */
export async function refreshProof(proofRefreshToken: string) {
  // Derived from the token: retrying this exact refresh replays its answer for 10 minutes
  // instead of presenting a used refresh token (which would revoke the proof).
  const key = "refresh-" + createHash("sha256").update(proofRefreshToken).digest("hex").slice(0, 32);
  return accounts("/v1/proofs/refresh", { proof_refresh_token: proofRefreshToken }, key);
}
```

Then send the proof token with your call:

```ts
const proof = await issueObo(accessToken, requestId);
await fetch("https://briefcase.example/api/files", {
  method: "POST",
  headers: { authorization: `Proof ${proof.proof_token}`, "content-type": "application/json" },
  body: JSON.stringify({ filename: "notes.txt" }),
});
```

Run against the local stack: a retried `issueObo` with the same request id returned the same `proof_id`; the receiving endpoint from [Verify a proof](verify-a-proof.md#in-typescript) answered `201` before and after a refresh; a retried `refreshProof` returned the identical new refresh token; and presenting the used refresh token without that key answered `400 proof_refresh_token_reused`, after which the endpoint answered `403`.

## In Rust

```rust
use silicon_accounts_client::{AccountsClient, IssueObo, ProofRef};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;
    let dm = client.as_app("dm", std::env::var("DM_APP_SECRET")?);

    // 1. Trade the account's access token at dm for a proof that briefcase can verify.
    let proof = dm
        .issue_obo(
            &IssueObo {
                subject_token: std::env::var("SUBJECT_TOKEN")?, // the account's access token at dm
                receiving_app: "briefcase".into(),
                scopes: vec!["files.write".into()],
                access_ttl_seconds: Some(600),
            },
            Some("obo-save-file-7f3a"), // a retry with this key returns this same proof
        )
        .await?;
    println!("send `Authorization: Proof {}` to briefcase", proof.proof_token.expose());

    // 2. Before proof.expires_at: a new proof token, and a new refresh token to keep.
    let refresh_token = proof.proof_refresh_token.as_ref().ok_or("no refresh token")?;
    let next = dm.refresh_proof(refresh_token.expose(), None).await?;
    println!("next token until {:?}; store the new refresh token", next.expires_at);

    // 3. Done acting for the account: end the proof everywhere at once.
    dm.revoke_proof(&ProofRef::Id(proof.proof_id.clone())).await?;
    println!("revoked {}", proof.proof_id);

    // Errors carry the service's code, message and hint.
    if let Err(err) = dm.refresh_proof(next.proof_refresh_token.as_ref().ok_or("no refresh token")?.expose(), None).await {
        println!("{} ({:?}): {}", err.code(), err.status(), err.message());
    }
    Ok(())
}
```

Output against the local stack:

```
send `Authorization: Proof sap_87yqOa2xQLsoB11nGB_-9fSUGqRRP7jsYIfeuLzKr4M` to briefcase
next token until Some(2026-10-07 3:07:30.14 +00:00:00); store the new refresh token
revoked 01a1144b-6e12-72f3-add0-76520b24d57d
proof_revoked (Some(410)): Proof 01a1144b-6e12-72f3-add0-76520b24d57d was revoked at 2026-10-07T02:57:30.150Z because the issuing app revoked it (revoked_by_app), so it can't be refreshed.
```

`refresh_proof` takes no idempotency key; if a refresh response can be lost on your network, call `POST /v1/proofs/refresh` with an `Idempotency-Key` as in the TypeScript example.

## With the CLI

App commands take the app's credentials from `--app-id` and `--app-secret-stdin`, from `ACCOUNTS_APP_ID` and `ACCOUNTS_APP_SECRET`, or from `accounts app use <app_id> --secret-stdin`. Pass `-` to read a token from stdin.

```
$ export ACCOUNTS_APP_ID=dm ACCOUNTS_APP_SECRET=…
$ printf '%s' "$ACCESS_TOKEN" | accounts app proof obo --subject-token - --to briefcase --scope files.write --ttl 600
User verification proof 01a1143d-7cf0-72cb-a6aa-92936511127a from dm for briefcase on behalf of si:scout_two (8HV).
proof token    sap_b-W-7LIru72TQVEMyH_9LikGdngf7TdEcGEupmQmI0o
expires        2026-10-07T02:52:16Z (in 9m)
refresh token  sapr_LkCj5s0_zZDrJTnHIAQpGAzP0ulTCBcMWzNO2m6B0zc
refresh until  2029-03-25T02:42:16Z (in 899d)
scopes         files.write
$ accounts app proof refresh sapr_LkCj5s0_zZDrJTnHIAQpGAzP0ulTCBcMWzNO2m6B0zc --ttl 900
$ accounts app proof revoke 01a1143d-7cf0-72cb-a6aa-92936511127a
$ accounts app proof list --kind obo
```

`--scope` repeats; `--json` prints the service's answer; `accounts app proof revoke` also takes `--token` or `--refresh-token` instead of the id. `obo` sends a random `Idempotency-Key` unless you pass `--idempotency-key`.

## Errors

Every error is `{"error": {"code", "message", "hint", "details"?}}`; the message names exactly what was wrong.

| status | code | when | do |
|---|---|---|---|
| 400 | `invalid_subject_token` | `details.reason` says which: `not_an_access_token` (a refresh token, an STK, any non-JWT), `invalid` (bad signature or not a Silicon Accounts token), `expired` (access tokens last 30 minutes), `revoked` (the sign-in ended: signed out, STK rotated, access removed, account deleted; the message gives the time and cause) | Send a current access token your app received for the account; refresh the account's tokens, or have it sign in again. |
| 403 | `subject_token_wrong_app` | The access token was issued to another app (`details.token_app`). An app can only trade tokens it received itself. | Use your own app's token for the account. |
| 403 | `account_not_active` | The account isn't active (`details.status`). | Nothing to do until it is. |
| 403 | `membership_inactive` | The account has no active membership with your app (`details.membership_id`). | The account must sign into your app again. |
| 400 | `unknown_receiving_app` | No app has that id (`details.app_ids`). | Check the id. |
| 400 | `invalid_receiving_app` | The receiving app is your own app, or `accounts` (Silicon Accounts itself). | Name the other app. |
| 403 | `receiving_app_disabled` | The receiving app is disabled (`details.app_ids`). | Try later, or ask its owner. |
| 422 | `validation_failed` | Field rules, all listed in `details.fields`: e.g. `scopes[1]`, `access_ttl_seconds`, `receiving_app`, or an unknown field. | Fix the named fields. |
| 409 | `idempotency_key_reused` | The `Idempotency-Key` was used for a different body. | Use a new key. |
| 400 | `invalid_proof_refresh_token` | Refresh: not a `sapr_…` token (a proof token, a wrapped `Bearer sapr_…`), or unknown: mistyped, another environment, or its proof ended more than 30 days ago. | Send the newest refresh token; issue a new proof if the old one ended. |
| 403 | `not_issuing_app` | Refresh or revoke by token, by an app that didn't issue the proof. | Use the issuing app's credentials. |
| 400 | `proof_refresh_token_reused` | Refresh with a used refresh token: the proof is now revoked (`details.proof_id`). | Keep only the newest refresh token; issue a new proof. |
| 410 | `proof_revoked` | Refresh of an ended proof; `details.reason` (`revoked_by_app`, `revoked_by_owner`, `revoked_by_account`, `refresh_token_reuse`, `sign_in_revoked`, `access_removed`, `account_deleted`) and `details.revoked_at`. | Issue a new proof once the account's grant allows it. |
| 410 | `proof_expired` | Refresh past the proof's end (`details.expires_at`). | Issue a new proof. |
| 400 | `invalid_proof_id` | Revoke: `proof_id` isn't a UUID. A token pasted there is described, never repeated. | Send the `proof_id` from the issue response or a listing. |
| 404 | `proof_not_found` | Revoke: no such proof issued by your app (another app's proof id looks unknown), or a token the hourly sweep already deleted. | List your proofs; revoke by id. |

App authentication errors (`401 app_credentials_required`, `401 invalid_app_credentials`, `403 app_disabled`) are the same as for [verification](verify-a-proof.md#what-the-answers-mean).

## Related

- [Verify a proof](verify-a-proof.md): the receiving app's side.
- [How proofs work](../learn/proofs.md): why the proof stands on the sign-in, why refresh tokens rotate, and what each end means.
- [Prove your app to other apps (App verification)](ata.md): when no account is involved.
- [Receive webhooks](webhooks.md): how you learn that an account's grant ended.
- [Proofs API reference](../reference/api/proofs.md): every proof endpoint, field and error.
