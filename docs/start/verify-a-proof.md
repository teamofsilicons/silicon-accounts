---
title: Verify a proof
description: Check an app verification or User verification token sent to your app. Read the result and decide whether to allow the requested action.
kind: instructive
order: 40
related:
  - learn/proofs.md
  - start/user-verification.md
  - start/app-verification.md
  - reference/api/proofs.md
---

# Verify a proof

When another app sends your app a proof token (`sap_…`), ask Silicon Accounts to check it. Authenticate the check with your own app’s ID and secret. Accounts tells you whether the proof is valid for your app right now, who issued it and, for User verification, which account it represents.

Your app then checks the returned scopes and decides whether to allow the requested action. Start with this verification request:

```bash
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/verify \
  -H "Content-Type: application/json" \
  -d '{"proof_token":"sap_OMGtGwcBe5QgGJng3SIp0yGOh1nxefxCufefPXqr7dk"}'
```

A valid proof answers `200` with everything you need to decide:

```json
{
  "valid": true,
  "proof_id": "01a11435-333a-725d-bb0e-75adde136703",
  "kind": "user_verification",
  "expires_at": "2026-10-07T02:43:13.274Z",
  "issuing_app": { "app_id": "dm", "name": "DM" },
  "receiving_app": { "app_id": "briefcase", "name": "Briefcase" },
  "user": { "uuid": "8HV", "id": "si:scout", "kind": "silicon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

Here the app `dm` may act at `briefcase` for the Silicon `si:scout` (uuid `8HV`), with the scope `files.write`, until 02:43:13 UTC. Anything else answers `200` with exactly:

```json
{"valid": false, "expires_at": null}
```

These are real responses from a local Silicon Accounts stack, like every response on this page.

## Steps

1. **Take the token from the call.** How a proof travels between two apps is up to them; the apps in these docs send `Authorization: Proof sap_…`. Send only the token itself to Silicon Accounts, without the `Proof ` label.
2. **Ask Silicon Accounts** with `POST /v1/proofs/verify`, authenticated as your app (`Authorization: Basic base64(app_id:app_secret)`) and the body `{"proof_token": "sap_…"}`. A proof verifies only for the apps it names, and only when they ask with their own credentials: the same token checked by `remind` instead of `briefcase` is `{"valid": false, "expires_at": null}`.
3. **Refuse unless `valid` is `true`.** Every other case gets the same answer on purpose (see [Valid, or not valid, and nothing more](../learn/proofs.md#valid-or-not-valid-and-nothing-more)), so there is nothing to branch on.
4. **Check what this call needs** before acting:
   - `kind`: `user_verification` means the issuing app acts for an account; `app_verification` means the issuing app calls as itself and `user` is `null`.
   - `issuing_app.app_id`: the app making the call. Accept only the apps you decided to trust for this endpoint.
   - `scopes`: must contain the scope this endpoint requires. Scopes are strings the apps agree on; Silicon Accounts carries them and never interprets them. A valid proof without the scope you need is still a refusal.
   - `user.uuid` (User verification): the account to act for. Key your data on the uuid, which never changes; `user.id` (`c:…` or `si:…`) is for display and can change.
   - `expires_at`: when this proof token stops verifying.
5. **Act and answer.** Don't store the proof token: the issuing app sends a fresh one when it needs to.

## In TypeScript

`verifyProof` needs only `fetch` and `btoa`, so it runs in Node.js 18+, Deno, Bun and Workers. The endpoint around it is plain `node:http`; the same call fits an Express, Fastify or Next.js handler.

```ts
import { createServer } from "node:http";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const BRIEFCASE_AUTH = "Basic " + btoa(`briefcase:${process.env.BRIEFCASE_APP_SECRET}`);

/** The verification, or null when the proof is not valid for briefcase right now. */
export async function verifyProof(proofToken: string) {
  const res = await fetch(`${ACCOUNTS_URL}/v1/proofs/verify`, {
    method: "POST",
    headers: { authorization: BRIEFCASE_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proof_token: proofToken }),
  });
  if (!res.ok) throw new Error(`verify failed with HTTP ${res.status}: ${await res.text()}`); // fail closed
  const result = await res.json();
  return result.valid ? result : null;
}

createServer(async (req, res) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Proof ") ? header.slice("Proof ".length).trim() : "";
  const proof = token ? await verifyProof(token) : null;
  if (!proof || !proof.scopes.includes("files.write")) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid_proof", message: "send a valid proof with the files.write scope" } }));
    return;
  }
  // User verification: act for proof.user.uuid, on behalf of proof.issuing_app.app_id.
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ saved_for: proof.user.uuid, via: proof.issuing_app.app_id }));
}).listen(3000);
```

Against the local stack, a valid User verification proof from `dm` got `201 {"saved_for":"eiy","via":"dm"}`, and the same endpoint answered `403` for a revoked proof and for `sap_nope`.

## In Rust

With the [Rust package](../reference/rust-client.md) (`silicon-accounts-client`, plus `tokio` with the `macros` and `rt-multi-thread` features):

```rust
use silicon_accounts_client::{AccountsClient, AppClient, ProofVerification};

type BoxError = Box<dyn std::error::Error>;

/// The account uuid the proof speaks for (User verification) or the calling app (App verification), when `token` is valid
/// for this app right now and carries `needed_scope`.
async fn check_proof(app: &AppClient<'_>, token: &str, needed_scope: &str) -> Result<Option<String>, BoxError> {
    match app.verify_proof(token).await? {
        ProofVerification::Valid(proof) => {
            if !proof.scopes.iter().any(|s| s == needed_scope) {
                return Ok(None); // valid, but not for this action
            }
            Ok(Some(match &proof.user {
                Some(user) => user.uuid.clone(),          // User verification: act for this account
                None => proof.issuing_app.app_id.clone(), // App verification: the calling app
            }))
        }
        _ => Ok(None), // unknown, expired, revoked, or not for this app: reject
    }
}

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;
    let briefcase = client.as_app("briefcase", std::env::var("BRIEFCASE_APP_SECRET")?);
    let token = std::env::args().nth(1).ok_or("pass the proof token as the first argument")?;
    match check_proof(&briefcase, &token, "files.write").await? {
        Some(account) => println!("act for {account}"),
        None => println!("refuse the call"),
    }
    Ok(())
}
```

`verify_proof` returns `ProofVerification::Invalid` for every `{"valid": false}` answer, and an `Err` only when the request itself failed (bad credentials, network). Against the local stack, `check_proof` returned `Some("eiy")` for a valid User verification proof from `dm`, `None` for the same proof with the scope `files.delete`, `None` when `remind` checked it, and `Some("commit")` for an app verification proof from `commit`; the program printed `refuse the call` for `sap_nope`.

## With the CLI

```bash
ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET="$BRIEFCASE_APP_SECRET" \
  accounts app proof verify sap__tiKwGp_1rNr-6XGJJmGj1YPf7SsUVNNmxvPqBDaVa0
```

```
valid: User verification proof from dm for briefcase, on behalf of si:scout_two (8HV), scopes files.write files.read, until 2026-10-07T03:12:16Z (in 29m)
```

The exit code is `0` when the proof is valid and `2` when it is not, so `accounts app proof verify "$TOKEN" && …` works in scripts and fails closed. Other exit codes mean the check itself didn't happen: `3` when your app's credentials were refused (wrong secret, disabled app), `1` when Silicon Accounts couldn't be reached. A command-line mistake also exits `2`, including running it as the app's owner without the app secret (verifying needs the app's own credentials); add `--json` to tell them apart: a checked proof prints the service's answer (`{"valid": …}`), a failure prints `{"error": {…}}`. Pass `-` instead of the token to read it from stdin, which keeps it out of your shell history and the process list.

## What the answers mean

| answer | meaning | do |
|---|---|---|
| `200`, `"valid": true` | The token is a live proof token, the proof is not revoked or past its lifetime, your app is one of the apps it names, the issuing app is active, and (User verification) the account, its membership with the issuing app and its sign-in there are all still active. | Check `issuing_app`, `scopes` and (User verification) `user.uuid`, then act. |
| `200`, `{"valid": false, "expires_at": null}` | Any other case: unknown, expired, revoked, issued for other apps, the issuing app disabled, or (User verification) the account's sign-in at the issuing app ended, it removed that app's access, or it was deleted. | Refuse the call (`403` is a good answer). The issuing app can refresh or issue a new proof. |
| `200`, not valid, with an `x-accounts-hint` header | Same as above, and your input wasn't a proof token at all: for example a proof refresh token (`sapr_…`), a JWT, an empty string, or `Proof sap_…` with the label still on. The hint describes the input, never the proof. | Fix how you extract the token. |
| `401 app_credentials_required` | No `Authorization: Basic` header. | Send your app id and secret. |
| `401 invalid_app_credentials` | Malformed Basic credentials, a wrong secret, or an app id that doesn't exist. The message says which. | Use your app's current credentials from Silicon Apps. |
| `403 app_disabled` | Your own app is disabled. | Re-enable it in Silicon Apps. |
| `400 invalid_content_type`, `422 validation_failed` | The body isn't JSON, or `proof_token` is missing or there are unknown fields (`details.fields` names them). | Send `Content-Type: application/json` and `{"proof_token": "sap_…"}`. |
| `5xx` or no answer | Silicon Accounts couldn't be reached. | Fail closed: refuse the call, and let the caller retry. |

## Caching answers

Verify on every call that needs the proof. It's cheap: on a local stack, one verification after another measured p50 0.46 ms and p99 0.89 ms, and 10 at a time p50 1.0 ms (numbers and conditions in [How proofs work](../learn/proofs.md#verification-is-a-live-call)). A revocation takes effect at Silicon Accounts immediately; a cached `valid: true` hides it until the cache entry expires. If you must cache, keep entries for seconds and never past the answer's `expires_at`.

## Related

- [How proofs work](../learn/proofs.md): what a proof stands on, why the invalid answer says nothing more, and every way a proof ends.
- [Act for an account at another app (User verification)](user-verification.md): the issuing app's side.
- [Prove your app to other apps (App verification)](app-verification.md).
- [Proofs API reference](../reference/api/proofs.md): every proof endpoint, field and error.
