---
title: Exchange, refresh, check and revoke tokens
description: What a token response holds, how a Silicon's short-lived token is exchanged, how to refresh safely (rotation, reuse detection, one refresh at a time), how to check an access token locally or by introspection, read userinfo, and sign an account out of your app.
kind: instructive
order: 15
related:
  - learn/tokens-and-sessions.md
  - start/hosted-pages.md
  - start/oidc.md
  - learn/what-apps-see.md
  - reference/errors.md
---

# Exchange, refresh, check and revoke tokens

You'll keep a sign-in alive with its refresh token, check the access tokens your API receives,
read the account behind a token, and end a sign-in when the account signs out of your app.
Every call is a form post with your app's credentials:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=refresh_token -d "refresh_token=$REFRESH_TOKEN"
```

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGci…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_5320RfvmiC21o0R_lANs…",
  "refresh_token_expires_at": "2029-03-25T02:56:36.117Z",
  "scope": "profile email openid",
  "id_token": "eyJ0eXAiOiJKV1QiLCJhbGci…",
  "membership_id": "briefcase:ptO",
  "account": { "uuid": "ptO", "id": "c:grace-hopper", "…": "…" }
}
```

Store the new `refresh_token` before you use anything else from the answer: the one you sent
is now spent, and sending it again ends the whole sign-in. Why it works this way is in
[Tokens and sessions](../learn/tokens-and-sessions.md).

## The token response

Every grant (a code, a Silicon's short-lived token, a refresh) answers with the same shape,
`Cache-Control: no-store`:

| Field | Meaning |
|---|---|
| `access_token` | A JWT (EdDSA) for your app, valid `expires_in` seconds: 1800, 30 minutes. Send it to your own API, or to Silicon Accounts' `/v1/userinfo`. |
| `token_type` | Always `Bearer`. |
| `refresh_token` | `sar_…`, opaque. Rotates on every refresh; one use each. |
| `refresh_token_expires_at` | When this sign-in ends at the latest: 900 days after it started. Refreshing never moves it. |
| `scope` | What the account granted your app, space-separated, e.g. `profile email openid`. |
| `id_token` | Only when the sign-in included `openid`. See [the id_token](oidc.md#the-id_token). |
| `membership_id` | `{app_id}:{uuid}`, the account's membership with your app. |
| `account` | The account as your app may see it (the same object as userinfo, without the OIDC aliases). See [What your app sees](../learn/what-apps-see.md). |

Errors are RFC 6749 bodies, `{"error": "invalid_grant", "error_description": "…"}`, with a
description that says exactly what was wrong.

## Exchange an authorization code

The browser comes back to your redirect URI with `?code=sac_…`. Exchange it within 2 minutes,
once, with the same `redirect_uri` and the PKCE verifier:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d redirect_uri=http://localhost:3000/callback -d "code_verifier=$CODE_VERIFIER"
```

Every refusal, with its exact description, is listed in
[Sign in with the hosted pages](hosted-pages.md#exchange-the-code).

## A Silicon's short-lived token

A Silicon signs in to your app by handing you a short-lived token (`slt_…`) that it got with
`accounts login --app <your app_id>`. It is single use, valid 2 minutes, and only your app can
exchange it:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
```

```sh
accounts app token slt "$SLT"          # the same from the CLI, in app mode
```

```rust
//! A Silicon handed your app a short-lived token (`accounts login --app <app_id>` prints it).
//! Run: ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… cargo run --bin slt -- slt_…
use silicon_accounts_client::Config;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let client = config.client()?;
    let app = config.app_client(&client).ok_or("set ACCOUNTS_APP_ID and ACCOUNTS_APP_SECRET")?;
    let slt = std::env::args().nth(1).ok_or("pass the slt_… token")?;

    match app.exchange_slt(&slt).await {
        Ok(tokens) => {
            let account = tokens.account.ok_or("token responses carry the account")?;
            // A Silicon has no email or phone; it always carries its custodian.
            println!("{} ({:?}) signed in, membership {}", account.id, account.kind, account.membership_id);
            if let Some(custodian) = account.custodian {
                println!("custodian: {} ({})", custodian.id, custodian.uuid);
            }
        }
        // Single use, 2 minutes, one app: a used, expired or another app's token is invalid_grant.
        Err(error) if error.is_code("invalid_grant") => eprintln!("refused: {error}"),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
```

```text
si:scout (Silicon) signed in, membership briefcase:1Nx
custodian: c:grace-hopper (ptO)
```

and the same token a second time:

```text
refused: The short-lived token was already used; each one works once. Get a new one. Hint: Start a new sign-in. …
```

What the token grants:

- **A Silicon**: `profile`, plus `dob` and `timezone` when your app requires or optionally asks
  for them. Silicons have no email or phone; those are simply left out and never block a
  Silicon. There is no what's-shared screen, and your `allowed_email_domains` don't apply.
- **A Carbon** using the CLI: `profile`, your required details, and the optional details the
  Carbon already granted you. The token isn't even minted when the Carbon lacks a required
  detail (`409 requirements_missing`; the hosted pages would ask for it) or, with
  `allowed_email_domains`, has no verified email at one of them (`403 email_domain_not_allowed`).

The exchange is a sign-in: the account becomes a member of your app (source `slt`) and it is
listed in your user base and the account's sign-in history. Every refusal is `invalid_grant`
and says which case it is:

| Case | `error_description` starts with |
|---|---|
| Unknown | `The short-lived token is not known: it is mistyped or was never issued.` |
| Used before | `The short-lived token was already used; each one works once.` |
| Older than 2 minutes | `The short-lived token expired at … (they last 120 seconds); …` |
| Minted for another app | `The short-lived token was issued for the app 'briefcase', not for 'dm'; …` |
| Minted before the Silicon's custodian rotated its STK | `The short-lived token was issued at … by a sign-in of si:scout that ended when its custodian rotated its STK at …` |
| Minted before the account removed your app's access | `c:… removed the access of the app 'briefcase' at …, after this short-lived token was issued at …` |

## Refresh

Refresh before the access token's 30 minutes run out (or when your API sees it expire):

```sh
accounts app token refresh "$REFRESH_TOKEN" --json
```

```rust
let tokens = app.refresh(refresh_token).await?;   // store tokens.refresh_token right away
```

**Rotation.** Every refresh returns a new refresh token and spends the one you sent. The new
one keeps the sign-in's original `refresh_token_expires_at`: a sign-in lasts at most 900 days
from the moment the account signed in, however often you refresh.

**Reuse detection.** Presenting a spent refresh token is treated as theft: the whole sign-in
(every token issued from it, including the newest) is revoked at once, and your webhook gets
`membership.signed_out` with reason `refresh_token_reuse`:

```json
{"error": "invalid_grant", "error_description": "This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in to protect the account, so this sign-in is now revoked; sign in again."}
```

and the newest refresh token then answers:

```json
{"error": "invalid_grant", "error_description": "The sign-in this refresh token belongs to was revoked at 2026-10-07T02:35:29.652Z (refresh_token_reuse); sign in again."}
```

**One refresh at a time per sign-in.** Two requests that refresh the same token in parallel
(two tabs, two workers, a retry after a timeout) are indistinguishable from theft: one wins,
the other is reuse, and the winner's new tokens die with the sign-in. Tested: two parallel
refreshes gave one `200` and one `invalid_grant`, and the winner's new refresh token was
already revoked. Share one request between callers:

```ts
// refresh.ts: one refresh per sign-in at a time. Two parallel refreshes with the same token
// count as reuse and end the sign-in, so callers that race share one request.
const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase";
const APP_SECRET = process.env.ACCOUNTS_APP_SECRET ?? "";

type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };
const inFlight = new Map<string, Promise<Tokens>>(); // refresh token → the request using it

export function refreshTokens(refreshToken: string): Promise<Tokens> {
  let pending = inFlight.get(refreshToken);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(new URL("/v1/oauth/token", ACCOUNTS_URL), {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      const body = await response.json();
      // invalid_grant: the sign-in ended (revoked, reused, access removed, 900 days): sign in again.
      if (!response.ok) throw Object.assign(new Error(body.error_description), { code: body.error });
      return body as Tokens; // store body.refresh_token now: the old one is spent
    })().finally(() => setTimeout(() => inFlight.delete(refreshToken), 60_000).unref());
    inFlight.set(refreshToken, pending);
  }
  return pending;
}

// Demo: three callers refresh at once; one request is made, all get the same new tokens.
const [a, b, c] = await Promise.all([1, 2, 3].map(() => refreshTokens(process.argv[2])));
console.log(a.refresh_token === b.refresh_token && b.refresh_token === c.refresh_token, a.scope);
console.log((await refreshTokens(a.refresh_token)).expires_in);
```

```text
$ node refresh.ts sar_…
true profile email
1800
```

The answer stays shared for a minute, so a late caller that still holds the old token gets
the new tokens instead of tripping reuse detection. With several server processes, put the
same rule in your session store: lock the sign-in's row while refreshing, and write the new
refresh token in the same transaction.

**Scope.** A refresh may send `scope` to repeat or narrow what was granted (the answer still
lists the whole grant) but never to add to it:

```json
{"error": "invalid_scope", "error_description": "A refresh can't add scopes: 'phone' was not granted when the account signed in (granted: 'profile email openid'). Ask for more by sending the account through /authorize again."}
```

**When a refresh fails**, the sign-in is over; send the account through sign-in again. Every
answer is `invalid_grant` with the reason:

| `error_description` | Why |
|---|---|
| `The sign-in this refresh token belongs to was revoked at … (app_revoked); sign in again.` | Your app revoked it. Other reasons in the parentheses: `refresh_token_reuse`, `authorization_code_reuse`, `access_removed` (the account removed your app's access), `stk_rotated` (a Silicon's custodian rotated its STK), `account_deleted`. |
| `The refresh token expired at … (refresh tokens last 900 days from sign-in); sign in again.` | The sign-in reached its 900 days. |
| `This refresh token was already used once. …` | Reuse: the sign-in is now revoked. |
| `The refresh token was issued to a different app, not to 'dm'; an app can only refresh its own tokens.` | Each app refreshes its own tokens. |
| `The refresh token is not known to Silicon Accounts: it is mistyped, or it belongs to another environment.` | A typo or another environment. |
| `refresh_token must be a refresh token (it starts with sar_), but this is a JWT access token.` | Wrong token. |

## Check an access token

Your API receives access tokens from your own pages, apps and clients. Two ways to check them:

| | Locally, with the JWKS | Introspection |
|---|---|---|
| How | Verify the JWT signature with `/.well-known/jwks.json` | `POST /v1/oauth/introspect` |
| Cost | No network call per request (the key set is cached) | One call per check |
| Sees revocation | No: a revoked token stays valid until its `exp`, at most 30 minutes | Yes, at once |
| Use for | Most requests | Sensitive actions, or right after `membership.signed_out` |

An access token's claims:

```json
{
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "ptO",
  "aud": "briefcase",
  "exp": 1791343596,
  "iat": 1791341796,
  "nbf": 1791341796,
  "jti": "01a1144a-9b1a-77ca-b0e4-fabbb9b6c3a5",
  "kind": "carbon",
  "id": "c:grace-hopper",
  "mid": "briefcase:ptO",
  "fid": "01a1144a-9b18-71e4-a5ab-14d69759855c",
  "scope": "profile email openid"
}
```

`sub` is the account uuid, `aud` your app id (refuse any other), `kind` `carbon` or `silicon`,
`id` the `c:`/`si:` id when the token was issued (it may have changed since), `mid` the
membership id, `fid` the sign-in (token family) it belongs to, `scope` what was granted. The
header names the key: `{"typ": "JWT", "alg": "EdDSA", "kid": "…"}`.

**Locally in Node** with [`jose`](https://github.com/panva/jose):

```ts
// verify.ts: check an access token locally (no call to Silicon Accounts per request).
import { createRemoteJWKSet, jwtVerify } from "jose";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase";
// Fetched once, cached, refetched when a token names an unknown kid.
const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", ACCOUNTS_URL));

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ACCOUNTS_URL,       // the token's iss is the Silicon Accounts public URL
    audience: APP_ID,           // a token issued to another app is refused
    algorithms: ["EdDSA"],
  });
  // sub = account uuid, mid = membership id, kind = carbon | silicon, scope = granted scopes
  return payload as typeof payload & { sub: string; mid: string; kind: "carbon" | "silicon"; id: string; scope: string };
}

console.log(await verifyAccessToken(process.argv[2]));
```

A token of another app fails with `JWTClaimValidationFailed: unexpected "aud" claim value`, an
expired one with `JWTExpired: "exp" claim timestamp check failed`.

**Locally in Rust**: `app.verify_access_token_locally(&client.jwks().await?, token)` checks the
signature, `exp`/`nbf` (30 seconds of leeway) and `aud`; see the
[Rust example](hosted-pages.md#the-same-flow-in-rust). **From the CLI**:
`accounts app token verify <token>` (exit 0 valid, 2 invalid):

```text
valid: c:lin-docs (nln) for briefcase, expires 2026-10-07T03:08:37Z (in 29m)
```

**Introspection** asks Silicon Accounts whether a token of your app is live right now:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/introspect" -d "token=$ACCESS_TOKEN"
```

```json
{
  "active": true,
  "aud": "briefcase",
  "client_id": "briefcase",
  "exp": 1791343603,
  "iat": 1791341803,
  "id": "c:grace-hopper",
  "iss": "https://accounts.teamofsilicons.com",
  "jti": "01a1144a-b941-7705-99bc-1f9792d04d22",
  "kind": "carbon",
  "membership_id": "briefcase:ptO",
  "nbf": 1791341803,
  "scope": "profile email openid",
  "sub": "ptO",
  "token_type": "access_token",
  "username": "c:grace-hopper"
}
```

A refresh token can be introspected too: `token_type` is `refresh_token`, `exp` is the end of
the sign-in (900 days) and `iat` when that refresh token was issued. Anything that isn't live
is exactly `{"active":false}`: unknown, malformed, expired (from `exp` on, no leeway), revoked,
spent, a token of another app, an account that isn't active, or a membership that isn't
active (the account removed your app's access). `id` and `username` are the account's current
`c:`/`si:` id. Introspection needs your app's own credentials (`invalid_client` otherwise);
`token_type_hint` is accepted and ignored.

## Read the account (userinfo)

`GET /v1/userinfo` with the access token returns the account as your app may see it, with the
OpenID Connect names added (`sub`, `name`, `picture`, `phone_number`,
`phone_number_verified`, `zoneinfo`, `birthdate`):

```sh
curl -s "$ACCOUNTS_URL/v1/userinfo" -H "Authorization: Bearer $ACCESS_TOKEN"
```

```json
{
  "display_name": "Grace Hopper",
  "email": "grace.hopper@example.com",
  "email_verified": true,
  "id": "c:grace-hopper",
  "kind": "carbon",
  "membership_id": "briefcase:ptO",
  "name": "Grace Hopper",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=ptO",
  "picture": "https://iris.teamofsilicons.com/pfp/carbon?id=ptO",
  "sub": "ptO",
  "updated_at": "2026-10-07T02:56:29.875Z",
  "uuid": "ptO",
  "version": 1
}
```

`POST /v1/userinfo` with a form field `access_token` works too (send the token once, header or
body). The answer is always current: a renamed account shows its new name at once, unlike the
claims inside a token. `accounts app userinfo <token>` prints the same. Errors are `401` with
the API's error object and a `WWW-Authenticate: Bearer …` header OIDC libraries understand:

| `error.code` | Example `message` |
|---|---|
| `unauthenticated` | `/v1/userinfo needs an access token: send Authorization: Bearer <access token>.` |
| `invalid_authorization` | `/v1/userinfo takes Authorization: Bearer <access token>; the 'Basic' scheme is not accepted here.` |
| `invalid_token` | `The access token expired at 2026-10-07T03:09:20.000Z (access tokens last 30 minutes).` (with `details.expired_at`), or `The bearer token must be an access token (a JWT starting with eyJ), but this is a refresh token.` |
| `token_revoked` | `The sign-in behind this access token was revoked at 2026-10-07T02:36:22.408Z (app_revoked).` The reason is the same list as for refresh. |
| `account_deleted` | `The account ptO was deleted.` |
| `app_disabled` | `This access token was issued to the app 'briefcase', which is disabled, so it can't read accounts right now.` |

## Revoke: sign the account out of your app

When an account signs out of your app, end its sign-in so no copy of its tokens keeps working:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/revoke" -d "token=$REFRESH_TOKEN"
# {"revoked":true}
```

`token` is the refresh token or any access token of the sign-in, even an expired one: either
ends the whole sign-in (every access and refresh token of it). Your webhook gets
`membership.signed_out` with reason `app_revoked`. The answer is always `200` once your
credentials check out, as RFC 7009 asks; the body says what happened:

| Body | Meaning |
|---|---|
| `{"revoked":true}` | The sign-in is ended (also when it was already ended: revoking twice is harmless). |
| `{"revoked":false,"message":"Nothing was revoked: this is not a refresh or access token issued to 'briefcase' (it is unknown, malformed, or belongs to another app). RFC 7009 answers 200 either way."}` | Not a token of yours. The answer never says which, so the endpoint can't probe other apps' tokens. |
| `{"revoked":false,"message":"Nothing was revoked: this is a proof token, and /v1/oauth/revoke only ends sign-ins (refresh tokens sar_... and access tokens). Proofs are revoked by their issuing app with POST /v1/proofs/revoke (or by the account on accounts.teamofsilicons.com)."}` | A credential this endpoint doesn't end; the message says where it is ended. |

`accounts app token revoke <token>` and `app.revoke(token)` in Rust do the same.

Revoking ends your app's sign-in only. The Carbon stays signed in to Silicon Accounts in their
browser, so your next `/authorize` offers "Continue as …" and comes back without a code form;
send `prompt=login` when signing out must mean "prove who you are again". To remove your
app from the account altogether, the account itself removes your access on the account site,
and you hear `membership.access_removed`.
