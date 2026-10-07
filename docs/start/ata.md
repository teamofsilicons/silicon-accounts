---
title: Prove your app to other apps (ATA)
description: Issue one ATA proof that the apps you name can verify, so they know a call really comes from your app; refresh, revoke and list it.
kind: instructive
order: 42
related:
  - start/verify-a-proof.md
  - start/obo.md
  - learn/proofs.md
  - reference/api/proofs.md
---

# Prove your app to other apps (ATA)

Your app calls other apps as itself, with no account involved: `commit` tells `remind` and `waveform` that a build finished. You get one ATA proof that names both apps, send its token with each call, and each of them [verifies](verify-a-proof.md) that the call really comes from `commit`.

```bash
curl -s -u "commit:$COMMIT_APP_SECRET" \
  -X POST https://account.teamofsilicons.com/v1/proofs/ata \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ata-notify-1" \
  -d '{"audiences":["remind","waveform"],"scopes":["notify"],"access_ttl_seconds":300}'
```

`201 Created` (a real response from a local stack, like every response on this page):

```json
{
  "expires_at": "2026-10-07T02:41:51.181Z",
  "issuing_app": "commit",
  "kind": "ata",
  "proof_id": "01a11438-866d-73c6-b7f5-d13ab7123927",
  "proof_refresh_token": "sapr_W0rTM9eNj05Cd7KoRhQWaxxoA9Jb79ElSmlNEp0eFt0",
  "proof_token": "sap_4RcksP_maKuK0OkTMM20mPubD9LI8LOA8Z43gUGGbi0",
  "receiving_apps": ["remind", "waveform"],
  "refresh_expires_at": "2029-03-25T02:36:51.181Z",
  "scopes": ["notify"],
  "user": null
}
```

When `remind` verifies the token with its own credentials:

```json
{
  "valid": true,
  "proof_id": "01a11438-866d-73c6-b7f5-d13ab7123927",
  "kind": "ata",
  "expires_at": "2026-10-07T02:41:51.181Z",
  "issuing_app": { "app_id": "commit", "name": "Commit" },
  "receiving_app": { "app_id": "remind", "name": "Remind" },
  "user": null,
  "scopes": ["notify"]
}
```

`waveform` gets the same answer with `"receiving_app": {"app_id": "waveform", "name": "Waveform"}`. `briefcase`, which the proof doesn't name, gets `{"valid": false, "expires_at": null}`.

## ATA or OBO

- Use **ATA** when the call is about your app itself: notifications, syncing, one service calling another. The receiving app learns *which app* is calling, and nothing about any account.
- Use **[OBO](obo.md)** when you act for an account. The receiving app then learns which account, and the proof ends by itself when the account signs out of your app, removes its access or is deleted.

Don't stretch ATA to act for accounts by putting an account id in your own payload: the receiving app couldn't tell whether the account agreed or still uses your app, and the account couldn't see or revoke it. That is exactly what OBO is for.

## 1. Issue the proof

With your app's credentials: `POST /v1/proofs/ata`.

| field | required | rules |
|---|---|---|
| `audiences` | yes | 1 to 20 app ids that may verify the proof, each 2 to 40 characters of `a-z`, `0-9` and `-`, starting with a letter (trimmed and lowercased; duplicates dropped, order kept). Not your own app, and not `accounts`. Every one must exist and be active. |
| `scopes` | no | Up to 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -`. |
| `access_ttl_seconds` | no | How long each proof token lives: 60 to 1800 seconds, default 1800. |

Send an `Idempotency-Key`: a retry with the same key and body within 10 minutes returns the same proof instead of a second one.

The answer has the same fields as an OBO proof, except `receiving_apps` (the audiences) instead of `receiving_app`, and `user: null`. `refresh_expires_at` is 900 days after issuing. Keep `proof_refresh_token` on your side; send `proof_token` to the apps.

**As the app's owner.** Apps get an ATA page in Silicon Apps. Until Silicon Apps exists, the app's owner makes ATA proofs with their own session instead of the app secret, with the same body and the same answer:

```bash
curl -s -X POST https://account.teamofsilicons.com/v1/apps/commit/proofs/ata \
  -H "Authorization: Bearer $OWNER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ata-page-1" \
  -d '{"audiences":["remind"],"scopes":["notify"]}'
```

`$OWNER_ACCESS_TOKEN` is the owner's access token for Silicon Accounts itself (audience `accounts`), from the code login (`POST /v1/cli/login/start`, then `POST /v1/cli/login/verify`) or the device flow. The CLI handles that for you: signed in as the owner with `accounts login`, run `accounts app --app-id commit proof ata …` without the secret ([below](#with-the-cli)). On the account site, the Proofs tab of the app's developer pages (`/developer/<app_id>/proofs`) does the same. A Carbon who doesn't own the app gets `403 not_app_owner`. The proof is still issued *by the app*: refreshing it needs the app's credentials, so hand the refresh token to the app's server, or issue proofs from the server directly.

## 2. Send the token with each call

Send `proof_token` to every app it names, for example as `Authorization: Proof sap_…`, and keep using it until shortly before `expires_at`. Each receiving app verifies it with [`POST /v1/proofs/verify`](verify-a-proof.md) and checks `kind: "ata"`, `issuing_app.app_id` and `scopes`.

## 3. Refresh, revoke, list

These work exactly as for OBO proofs, with your app's credentials:

- `POST /v1/proofs/refresh` `{"proof_refresh_token": "sapr_…"}` returns a new proof token and a new refresh token; the used refresh token must never be presented again (that revokes the proof). Without `access_ttl_seconds` the new token gets the proof's own lifetime: refreshing the 60-second proof from a local test gave another 60-second token, which verified, while the expired first token answered `{"valid": false, "expires_at": null}`. See [Refresh before the proof token expires](obo.md#3-refresh-before-the-proof-token-expires).
- `POST /v1/proofs/revoke` with one of `proof_id`, `proof_token` or `proof_refresh_token` returns `204`; the owner can use `DELETE /v1/apps/{app_id}/proofs/{proof_id}` with their session.
- `GET /v1/apps/{app_id}/proofs?kind=ata` lists them, newest first:

```json
{
  "items": [
    {
      "proof_id": "01a11438-86e5-7200-8c40-4a0ea0461ef8",
      "kind": "ata",
      "audiences": ["remind"],
      "user": null,
      "scopes": ["notify"],
      "status": "active",
      "access_ttl_seconds": 1800,
      "created_at": "2026-10-07T02:36:51.301Z",
      "expires_at": "2029-03-25T02:36:51.301Z",
      "token_expires_at": "2026-10-07T03:06:51.301Z",
      "last_refreshed_at": null,
      "revoked_at": null,
      "revoke_reason": null
    }
  ],
  "next_cursor": "WzE3OTEzNDA2MTEzMDE0NjgsIjAxYTExNDM4LTg2ZTUtNzIwMC04YzQwLTRhMGVhMDQ2MWVmOCJd"
}
```

An ATA proof ends only when it is revoked or reaches `refresh_expires_at`. While your app is disabled, its proofs don't verify and it can't issue new ones (`403 app_disabled`).

## In Rust

```rust
use silicon_accounts_client::{AccountsClient, IssueAta, ProofVerification};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://account.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;

    // commit: one proof that remind and waveform can both check.
    let commit = client.as_app("commit", std::env::var("COMMIT_APP_SECRET")?);
    let proof = commit
        .issue_ata(
            &IssueAta {
                audiences: vec!["remind".into(), "waveform".into()],
                scopes: vec!["notify".into()],
                access_ttl_seconds: Some(300),
            },
            Some("ata-notify-batch-0193"),
        )
        .await?;
    println!("ATA proof {} for {:?}", proof.proof_id, proof.receiving_apps);

    // remind: is this call really from commit?
    let remind = client.as_app("remind", std::env::var("REMIND_APP_SECRET")?);
    match remind.verify_proof(proof.proof_token.expose()).await? {
        ProofVerification::Valid(p) if p.issuing_app.app_id == "commit" && p.scopes.iter().any(|s| s == "notify") => {
            println!("remind: accepted, from {} until {}", p.issuing_app.app_id, p.expires_at);
        }
        _ => println!("remind: refused"),
    }
    Ok(())
}
```

```
ATA proof 01a1144d-8cf6-72f8-b93a-e36b498cfd29 for ["remind", "waveform"]
remind: accepted, from commit until 2026-10-07 3:04:49.109 +00:00:00
```

`issue_ata` calls `POST /v1/proofs/ata` with app credentials, and the owner endpoint when the client acts as the app's owner (`client.with_token(owner_token).app("commit")`). `refresh_proof` and `revoke_proof` work as shown in [the OBO example](obo.md#in-rust).

## With the CLI

```
$ export ACCOUNTS_APP_ID=commit ACCOUNTS_APP_SECRET=…
$ accounts app proof ata --to remind,waveform --scope notify --ttl 300
ATA proof 01a1143d-84fa-74a1-8061-88183770a748 from commit for remind, waveform.
proof token    sap_nees5u_DkFcCfoyYCWRbRTv8oB2BATnWScT_NLvRy04
expires        2026-10-07T02:47:18Z (in 4m)
refresh token  sapr_JREfspJ0feqrILsMLyaoplLsYA4F9wRsG0632C6k4Hg
refresh until  2029-03-25T02:42:18Z (in 899d)
scopes         notify
```

Signed in as the app's owner (`accounts login`), `accounts app --app-id commit proof ata --to remind --scope notify` works without the secret, through the owner endpoint. `accounts app proof list --kind ata`, `refresh` and `revoke` work as for OBO; refreshing and verifying need the app's own credentials.

## Errors

| status | code | when |
|---|---|---|
| 400 | `invalid_receiving_app` | `audiences` names your own app (`"An app can't issue a proof to itself: 'commit' is both the issuing and a receiving app."`) or `accounts`. `details.app_ids` lists them. |
| 400 | `unknown_receiving_app` | Apps that don't exist, all listed: `"These receiving apps don't exist: 'nosuchapp', 'alsonot'."` |
| 403 | `receiving_app_disabled` | Named apps are disabled (`details.app_ids`). |
| 403 | `app_disabled` | Your app is disabled, so it can't issue proofs. |
| 422 | `validation_failed` | Every field problem at once in `details.fields`, for example `{"audiences": "must list at least one app that may verify the proof, e.g. [\"remind\"]"}` or `{"access_ttl_seconds": "must be between 60 and 1800 seconds; got 30", "scopes[1]": "'has space' contains ' '; …", "scopes[2]": "must not be empty; …"}`. |
| 403 | `not_app_owner` / `app_mismatch` | Owner endpoint: you don't own the app, or your app credentials belong to another app than the one in the URL. |
| 409 | `idempotency_key_reused` | The `Idempotency-Key` was used with a different body. |

Refresh and revoke errors are the same as for OBO: see [the OBO errors](obo.md#errors).

## Related

- [Verify a proof](verify-a-proof.md): what each receiving app does.
- [How proofs work](../learn/proofs.md): why proofs are short-lived, rotate and verify live.
- [Act for an account at another app (OBO)](obo.md).
- [Proofs API reference](../reference/api/proofs.md): every proof endpoint, field and error.
