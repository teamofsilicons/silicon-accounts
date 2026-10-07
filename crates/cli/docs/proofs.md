# Proofs: OBO and ATA

Silicon Accounts doesn't run any app's endpoints. It issues proofs and verifies them;
consent screens and what each endpoint does stay with the apps.

* **OBO (on behalf of)** — app A wants to act at app B for an account. App A gets the
  account's consent in its own UI, then asks Silicon Accounts for a proof. App B asks
  Silicon Accounts whether the proof is valid.
* **ATA (app to app)** — app A proves to app B that a request really comes from app A.
  An ATA proof is always for exactly one app: to talk to apps B and C, app A gets one
  proof for B and another for C, and each verifies its own.

Proofs use the same token logic as sign-in: a short-lived proof token (default 30
minutes, 60 to 1800 seconds) plus a rotating proof refresh token held by the issuing
app.

## Issue an OBO proof (app A)

```sh
accounts app --app-id dm proof obo --subject-token "$ACCOUNT_ACCESS_TOKEN" --to briefcase --scope files.write --ttl 600
```

`--subject-token` is the account's access token issued to app A. The account must
still have an active membership with app A. Scopes are your own strings (up to 20,
`[A-Za-z0-9_.:/-]`); the receiving app decides what they mean.

Send the `proof_token` to app B, for example as `Authorization: Proof sap_…`.

## Issue an ATA proof (app A)

```sh
accounts app proof ata --to remind --ttl 300
accounts app proof ata --to waveform --ttl 300     # a second app gets its own proof
```

`--to` takes exactly one app. Why one app per proof: each receiving app verifies only
the proofs made for it, so revoking or refreshing the proof for one app never affects
the others, and a proof leaked by one app can't be replayed at another.

Owners can also make, see and revoke ATA proofs through their session: the app's ATA
page on developer.teamofsilicons.com calls the same endpoint
(`POST /v1/apps/{app_id}/proofs/ata` with `{"receiving_app": "remind"}`). A request
that lists several apps (`audiences`) is refused with `ata_single_app`.

## Verify (app B)

```sh
accounts app --app-id briefcase proof verify sap_… --json && echo valid
```

Exit code 0 means valid, 2 means not valid. A valid answer says until when, who issued
it, who it is for, and (OBO) which account:

```json
{"valid":true,"kind":"obo","expires_at":"…","issuing_app":{"app_id":"dm"},
 "receiving_app":{"app_id":"briefcase"},"user":{"uuid":"a8K","membership_id":"dm:a8K"},"scopes":["files.write"]}
```

Anything else (unknown, expired, revoked, issued for another app, the account removed
app A's access or was deleted, app A disabled) is exactly
`{"valid":false,"expires_at":null}`. The service deliberately doesn't say which, so a
proof can't be used to learn anything. Only the app a proof names can verify it.

## Refresh and revoke (app A)

```sh
accounts app proof refresh sapr_… --ttl 900     # new proof token + rotated refresh token
accounts app proof revoke <proof-id>
accounts app proof list --kind obo
```

Presenting an already-used proof refresh token revokes the proof, as with sign-in
refresh tokens.

## What accounts see

A Carbon or Silicon sees every OBO proof issued on its behalf
(`accounts proofs list`, or the account site) and can revoke any of them
(`accounts proofs revoke <proof-id>`). Removing an app's access also invalidates the
OBO proofs that app issued.
