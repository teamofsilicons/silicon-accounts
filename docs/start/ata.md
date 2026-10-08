---
title: Prove your app to other apps (App verification)
description: Get an App verification token so another app can check that a request comes from your app. Create one for each receiving app.
kind: instructive
order: 42
related:
  - start/verify-a-proof.md
  - start/obo.md
  - learn/proofs.md
  - reference/api/proofs.md
---

# Prove your app to other apps (App verification)

Use App verification when your app calls another app as itself. For example, `commit` might tell `remind` and `waveform` that a build finished. Each receiving app needs a way to check who sent that request.

`commit` asks Silicon Accounts for one proof for `remind` and another for `waveform`. It sends each app the token made for it. The receiving app then [verifies the token](verify-a-proof.md) with Accounts. A proof is always for exactly one receiving app.

```bash
curl -s -u "commit:$COMMIT_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/ata \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ata-remind-1" \
  -d '{"receiving_app":"remind","scopes":["notify"],"access_ttl_seconds":300}'
```

`201 Created` (a real response from a local stack, like every response on this page):

```json
{
  "expires_at": "2026-10-07T12:41:09.361Z",
  "issuing_app": "commit",
  "kind": "ata",
  "proof_id": "01a1165d-3411-7233-aa94-3be86373c4cc",
  "proof_refresh_token": "sapr_WJYywoB9Cu5Na1of_mPjwTyxR-N0oBeYW5bp_Py7GLU",
  "proof_token": "sap_mpIk5D-xnK9HebJzGmvlkD_ONRKsQUq6ddI9SBUYsa8",
  "receiving_app": "remind",
  "refresh_expires_at": "2029-03-25T12:36:09.361Z",
  "scopes": ["notify"],
  "user": null
}
```

When `remind` verifies the token with its own credentials:

```json
{
  "valid": true,
  "proof_id": "01a1165d-3411-7233-aa94-3be86373c4cc",
  "kind": "ata",
  "expires_at": "2026-10-07T12:41:09.361Z",
  "issuing_app": { "app_id": "commit", "name": "Commit" },
  "receiving_app": { "app_id": "remind", "name": "Remind" },
  "user": null,
  "scopes": ["notify"]
}
```

`waveform`, which this proof is not for, gets `{"valid": false, "expires_at": null}` for the same token: it verifies the proof `commit` issued for it, `{"receiving_app": "waveform", …}`.

Asking for several apps at once is refused, so a proof can never be replayed from one receiving app to another:

```json
{
  "error": {
    "code": "ata_single_app",
    "message": "An App verification is for exactly one app; ask for one proof per app.",
    "hint": "Send {\"receiving_app\": \"remind\"} to POST /v1/proofs/ata instead of \"audiences\", and call it once for every app that should verify a proof from you; each app verifies its own proof.",
    "details": { "field": "audiences", "apps": ["remind", "waveform"] }
  }
}
```

## App verification or User verification

- Use **App verification** when the call is about your app itself: notifications, syncing, one service calling another. The receiving app learns *which app* is calling, and nothing about any account.
- Use **[User verification](obo.md)** when you act for an account. The receiving app then learns which account, and the proof ends by itself when the account signs out of your app, removes its access or is deleted.

Don't stretch App verification to act for accounts by putting an account id in your own payload: the receiving app couldn't tell whether the account agreed or still uses your app, and the account couldn't see or revoke it. That is exactly what User verification is for.

## 1. Issue the proof

With your app's credentials: `POST /v1/proofs/ata`.

| field | required | rules |
|---|---|---|
| `receiving_app` | yes | The one app id that may verify the proof: 2 to 40 characters of `a-z`, `0-9` and `-`, starting with a letter (trimmed and lowercased). Not your own app, and not Silicon Accounts itself (`accounts`, `developer`). It must exist and be active. A body with `audiences` (any length) is 422 `ata_single_app`. |
| `scopes` | no | Up to 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -`. |
| `access_ttl_seconds` | no | How long each proof token lives: 60 to 1800 seconds, default 1800. |

Send an `Idempotency-Key`: a retry with the same key and body within 10 minutes returns the same proof instead of a second one.

The answer has the same fields as a User verification proof, with `user: null`. `refresh_expires_at` is 900 days after issuing. Keep `proof_refresh_token` on your side; send `proof_token` to the apps.

**As the app's owner.** Every app has an App verification page on [developers.teamofsilicons.com](https://developers.teamofsilicons.com) (`/apps/<app_id>/ata`) where its owner makes, sees and revokes App verification proofs, one app at a time. Behind it is the owner endpoint, which takes the owner's session instead of the app secret, with the same body and the same answer:

```bash
curl -s -X POST https://accounts.teamofsilicons.com/v1/apps/commit/proofs/ata \
  -H "Authorization: Bearer $OWNER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ata-page-1" \
  -d '{"receiving_app":"remind","scopes":["notify"]}'
```

`$OWNER_ACCESS_TOKEN` belongs to the owner’s Silicon Accounts session and has audience `accounts`. You get it through code login (`POST /v1/cli/login/start`, then `POST /v1/cli/login/verify`) or the device flow.

The CLI handles this for you. Sign in as the owner with `accounts login`, then run `accounts app --app-id commit proof ata …` without an app secret ([example below](#with-the-cli)). In the developer portal, the App verification page uses your developer session, whose audience is `developer`. A Carbon without ownership gets `403 not_app_owner`.

The resulting proof belongs to the app. Refreshing it still requires the app’s credentials. Pass the refresh token to your app’s server, or create the proof from that server in the first place.

## Central history for apps you manage

Open [App verification](https://developers.teamofsilicons.com/app-verification) in the common developer portal to see every retained App verification record issued by apps you currently manage. Records from the portal, CLI and API appear together, including active, expired and revoked records. Filter by issuing app or status, and load subsequent pages to see older records.

Expand a record to see issuance, token refreshes and revocation. The proof family's expiry and each token's expiry are separate: an active family can be refreshed even after its current proof token expires. History labels distinguish recorded expiry times from derived legacy values; unavailable information stays unavailable.

Proof and refresh token values are shown only when generated. History retains the records after credential material expires or is removed, without recovering raw secrets. Every list and history request checks current management access; receiving a proof does not give its recipient access to the issuing app's history.

The per-app App verification tab keeps its existing `/apps/<app_id>/ata` address and links to this central history with the issuing app selected. API integrations use `GET /v1/me/app-verifications` and `GET /v1/apps/{app_id}/proofs/{proof_id}/history` ([reference](../reference/api/proofs.md)). Existing `ata` commands, endpoints and wire values still mean App verification; `obo` means User verification.

## 2. Send the token with each call

Send `proof_token` to the one app it is for, for example as `Authorization: Proof sap_…`, and keep using it until shortly before `expires_at`. Each receiving app verifies it with [`POST /v1/proofs/verify`](verify-a-proof.md) and checks `kind: "ata"`, `issuing_app.app_id` and `scopes`.

## 3. Refresh, revoke, list

These work exactly as for User verification proofs, with your app's credentials:

- `POST /v1/proofs/refresh` `{"proof_refresh_token": "sapr_…"}` returns a new proof token and a new refresh token; the used refresh token must never be presented again (that revokes the proof). Without `access_ttl_seconds` the new token gets the proof's own lifetime: refreshing the 60-second proof from a local test gave another 60-second token, which verified, while the expired first token answered `{"valid": false, "expires_at": null}`. See [Refresh before the proof token expires](obo.md#3-refresh-before-the-proof-token-expires).
- `POST /v1/proofs/revoke` with one of `proof_id`, `proof_token` or `proof_refresh_token` returns `204`; the owner can use `DELETE /v1/apps/{app_id}/proofs/{proof_id}` with their session.
- `GET /v1/apps/{app_id}/proofs?kind=ata` lists them, newest first:

```json
{
  "items": [
    {
      "proof_id": "01a1165d-3411-7233-aa94-3be86373c4cc",
      "kind": "ata",
      "receiving_app": "remind",
      "user": null,
      "scopes": ["notify"],
      "status": "active",
      "access_ttl_seconds": 300,
      "created_at": "2026-10-07T12:36:09.361Z",
      "expires_at": "2029-03-25T12:36:09.361Z",
      "token_expires_at": "2026-10-07T12:41:09.361Z",
      "last_refreshed_at": null,
      "revoked_at": null,
      "revoke_reason": null
    }
  ],
  "next_cursor": null
}
```

An App verification proof ends only when it is revoked or reaches `refresh_expires_at`. While your app is disabled, its proofs don't verify and it can't issue new ones (`403 app_disabled`).

## In Rust

```rust
use silicon_accounts_client::{AccountsClient, IssueAta, ProofVerification};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;

    // commit: one proof per receiving app.
    let commit = client.as_app("commit", std::env::var("COMMIT_APP_SECRET")?);
    let mut proofs = Vec::new();
    for app in ["remind", "waveform"] {
        let proof = commit
            .issue_ata(
                &IssueAta {
                    receiving_app: app.into(),
                    scopes: vec!["notify".into()],
                    access_ttl_seconds: Some(300),
                },
                Some(&format!("ata-notify-batch-0193-{app}")),
            )
            .await?;
        println!("App verification proof {} for {}", proof.proof_id, proof.receiving_app.as_deref().unwrap_or("?"));
        proofs.push(proof);
    }
    let proof = &proofs[0]; // remind's

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
App verification proof 01a1165d-… for remind
App verification proof 01a1165d-… for waveform
remind: accepted, from commit until 2026-10-07 12:41:09.361 +00:00:00
```

`issue_ata` calls `POST /v1/proofs/ata` with app credentials (it refuses a `receiving_app` that names several apps before sending anything), and the owner endpoint when the client acts as the app's owner (`client.with_token(owner_token).app("commit")`). `refresh_proof` and `revoke_proof` work as shown in [the User verification example](obo.md#in-rust).

## With the CLI

```
$ export ACCOUNTS_APP_ID=commit ACCOUNTS_APP_SECRET=…
$ accounts app proof ata --to waveform --scope notify --ttl 300
App verification proof 01a1165d-49c5-72e3-a5e1-c38f003d30d7 from commit for waveform.
proof token    sap_MJMgDB69Mp_WgDKGdoR_OxnDs8Nf0eg-KmDcCGZM48Q
expires        2026-10-07T12:41:14Z (in 4m)
refresh token  sapr_umG_g5wmVYV48Yp2uXeHS36ya-E2u0yMPsLVqE2xFcM
refresh until  2029-03-25T12:36:14Z (in 899d)
scopes         notify
```

`--to` takes exactly one app. A list is refused before anything is sent, with one command per app:

```
$ accounts app proof ata --to remind,waveform
error: An App verification proof is for exactly one app, but --to names 2: remind, waveform.
hint: Issue one proof per app; each app verifies its own: accounts app proof ata --to remind ; accounts app proof ata --to waveform
```

Signed in as the app's owner (`accounts login`), `accounts app --app-id commit proof ata --to remind --scope notify` works without the secret, through the owner endpoint. `accounts app proof list --kind ata`, `refresh` and `revoke` work as for User verification; refreshing and verifying need the app's own credentials.

## Errors

| status | code | when |
|---|---|---|
| 422 | `ata_single_app` | The body has `audiences` (any length): ask for one proof per app with `receiving_app`. `details.apps` lists the valid app ids that were sent. |
| 400 | `invalid_receiving_app` | `receiving_app` is your own app (`"An app can't issue a proof to itself: …"`) or Silicon Accounts itself (`accounts`, `developer`). |
| 400 | `unknown_receiving_app` | The app doesn't exist. |
| 403 | `receiving_app_disabled` | The receiving app is disabled. |
| 403 | `app_disabled` | Your app is disabled, so it can't issue proofs. |
| 422 | `validation_failed` | Every field problem at once in `details.fields`, for example `{"receiving_app": "…"}` or `{"access_ttl_seconds": "must be between 60 and 1800 seconds; got 30", "scopes[1]": "'has space' contains ' '; …", "scopes[2]": "must not be empty; …"}`. |
| 403 | `not_app_owner` / `app_mismatch` | Owner endpoint: you don't own the app, or your app credentials belong to another app than the one in the URL. |
| 409 | `idempotency_key_reused` | The `Idempotency-Key` was used with a different body. |

Refresh and revoke errors are the same as for User verification: see [the User verification errors](obo.md#errors).

## Related

- [Verify a proof](verify-a-proof.md): what each receiving app does.
- [How proofs work](../learn/proofs.md): why proofs are short-lived, rotate and verify live.
- [Act for an account at another app (User verification)](obo.md).
- [Proofs API reference](../reference/api/proofs.md): every proof endpoint, field and error.
