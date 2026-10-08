# App verification and User verification

Silicon Accounts doesn't run any app's endpoints. It issues proofs and verifies them;
consent screens and what each endpoint does stay with the apps.

* **User verification (on behalf of)** — app A wants to act at app B for an account. App A gets the
  account's consent in its own UI, then asks Silicon Accounts for a proof. App B asks
  Silicon Accounts whether the proof is valid.
* **App verification (app to app)** — app A proves to app B that a request really comes from app A.
  An app verification proof is always for exactly one app: to talk to apps B and C, app A gets one
  proof for B and another for C, and each verifies its own.

Proofs use the same token logic as sign-in: a short-lived proof token (default 30
minutes, 60 to 1800 seconds) plus a rotating proof refresh token held by the issuing
app.

## Issue a User verification proof (app A)

```sh
accounts app --app-id dm proof user-verification --subject-token "$ACCOUNT_ACCESS_TOKEN" --to briefcase --scope files.write --ttl 600
```

`--subject-token` is the account's access token issued to app A. The account must
still have an active membership with app A. Scopes are your own strings (up to 20,
`[A-Za-z0-9_.:/-]`); the receiving app decides what they mean.

Send the `proof_token` to app B, for example as `Authorization: Proof sap_…`.

## Issue an app verification proof (app A)

```sh
accounts app proof app-verification --to remind --ttl 300
accounts app proof app-verification --to waveform --ttl 300     # a second app gets its own proof
```

`--to` takes exactly one app. Why one app per proof: each receiving app verifies only
the proofs made for it, so revoking or refreshing the proof for one app never affects
the others, and a proof leaked by one app can't be replayed at another.

Owners can also make, see and revoke App verification proofs through their session: the app's App verification
page on developers.teamofsilicons.com calls the same endpoint
(`POST /v1/apps/{app_id}/proofs/app-verification` with `{"receiving_app": "remind"}`). A request
that lists several apps (`audiences`) is refused with `app_verification_single_app`.

## Verify (app B)

```sh
accounts app --app-id briefcase proof verify sap_… --json && echo valid
```

Exit code 0 means valid, 2 means not valid. A valid answer says until when, who issued
it, who it is for, and (User verification) which account:

```json
{"valid":true,"kind":"user_verification","expires_at":"…","issuing_app":{"app_id":"dm"},
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
accounts app proof list --kind user_verification
```

Presenting an already-used proof refresh token revokes the proof, as with sign-in
refresh tokens.

## What accounts see

A Carbon or Silicon sees every User verification proof issued on its behalf
(`accounts proofs list`, or the account site) and can revoke any of them
(`accounts proofs revoke <proof-id>`). Removing an app's access also invalidates the
User verification proofs that app issued.

## Retained App verification history

The central App verification page at https://developers.teamofsilicons.com/app-verification
shows records issued by every app you currently manage, including records generated through
the CLI or API. Filter by issuing app and status, then expand a record to see issuance,
refreshes and revocation. An active proof family and its current token have separate expiry times.
Older derived expiry values are identified; missing historical values are not invented.

The records and events remain after credentials expire or are removed. Raw proof and refresh
tokens are shown when generated and cannot be recovered from history. Current management
access is checked on every request; being the receiving app alone grants no history access.

Use `accounts app proof app-verification` and `accounts app proof user-verification` to issue
verification tokens. JSON kinds are `app_verification` and `user_verification`.
`accounts user-verification list` and `revoke` are aliases for `accounts proofs list` and `revoke`.
