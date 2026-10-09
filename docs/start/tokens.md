---
title: Exchange, refresh, check and revoke tokens
description: Turn a sign-in into tokens, keep the session going, check who a token belongs to and end it when the account signs out.
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

Once an account signs in, your app gets two tokens. The access token tells you who is signed in. The refresh token gets you a new pair when the access token expires. When the account signs out, you revoke the session.

This page walks through each step, including how to check a token and read the account details it lets you see. Refreshing is a form POST with your app's credentials:

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

Save the new `refresh_token` the moment the answer arrives. The one you sent is now spent and won't work again, and sending it again ends the whole session. [Tokens and sessions](../learn/tokens-and-sessions.md) explains why refresh tokens work this way.

## The token response

Every grant (a code, a Silicon's short-lived token or a refresh) gets the same answer, sent with
`Cache-Control: no-store`:

| Field | Meaning |
|---|---|
| `access_token` | A JWT (EdDSA) for your app, valid `expires_in` seconds: 1800, 30 minutes, or less in the last 30 minutes of a sign-in that ends early, because an access token never outlives its sign-in. Send it to your own API, or to Silicon Accounts' `/v1/userinfo`. |
| `token_type` | Always `Bearer`. |
| `refresh_token` | `sar_…`, opaque. Rotates on every refresh; one use each. |
| `refresh_token_expires_at` | When this sign-in ends at the latest: 900 days after it started, or, for a Silicon's sign-in made from a short-lived token its CI job minted, when that CI sign-in ends. Refreshing never moves it. |
| `scope` | What the account granted your app, space-separated, e.g. `profile email openid`. |
| `id_token` | Only when the sign-in included `openid`. See [the id_token](oidc.md#the-id_token). |
| `membership_id` | `{app_id}:{uuid}`, the account's membership with your app. |
| `account` | The account as your app may see it (the same object as userinfo, without the OIDC aliases). See [What your app sees](../learn/what-apps-see.md). |

Errors come back as RFC 6749 bodies, `{"error": "invalid_grant", "error_description": "…"}`, and
the description says exactly what went wrong.

## Exchange an authorization code

The browser comes back to your redirect URI with `?code=sac_…`. Exchange it once, within 2
minutes, with the same `redirect_uri` and the PKCE verifier:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d redirect_uri=http://localhost:3000/callback -d "code_verifier=$CODE_VERIFIER"
```

[Sign in with the hosted pages](hosted-pages.md#exchange-the-code) lists every refusal with its
exact description.

## A Silicon's short-lived token

A Silicon signs in to your app by handing you a short-lived token (`slt_…`), which it gets with
`silicon-accounts login --app <your app_id>`. The token works once, lasts 2 minutes, and only your
app can exchange it, with its secret, so the exchange runs on your server. A CLI forwards the
token there ([CLI plus backend](add-sign-in.md#cli-plus-backend)). If your app turned on
`public_client`, its own command-line or desktop tool may exchange the token with `client_id`
alone instead (`-d client_id=briefcase` and no secret; in Rust,
`AccountsClient::exchange_slt_public_client`), and we record that sign-in with the method
`slt_public_client`:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
```

```sh
silicon-accounts app token slt "$SLT"          # the same from the CLI, in app mode
```

```rust
//! A Silicon handed your app a short-lived token (`silicon-accounts login --app <app_id>` prints it).
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

The same token a second time:

```text
refused: The short-lived token was already used; each one works once. Get a new one. Hint: Start a new sign-in. …
```

What the token grants depends on who signed in:

- **A Silicon**: `profile`, plus `dob` and `timezone` when your app requires them or asks for them
  as optional. A Silicon has no email or phone, so those are left out and never block it. There
  is no what's-shared screen, and your `allowed_email_domains` don't apply.
- **A Carbon** using the CLI: `profile`, your required details, and the optional details the
  Carbon already granted you. We don't even mint the token when the Carbon is missing a required
  detail (`409 requirements_missing`; the hosted pages would ask for it), or when you set
  `allowed_email_domains` and the Carbon has no verified email at one of them
  (`403 email_domain_not_allowed`).

The exchange counts as a sign-in: the account becomes a member of your app (source `slt`), and
it shows up in your user base and in the account's sign-in history. Every refusal is
`invalid_grant`, and it says which case it is:

| Case | `error_description` starts with |
|---|---|
| Unknown | `The short-lived token is not known: it is mistyped or was never issued.` |
| Used before | `The short-lived token was already used; each one works once.` |
| Older than 2 minutes | `The short-lived token expired at … (they last 120 seconds); …` |
| Minted for another app | `The short-lived token was issued for the app 'briefcase', not for 'dm'; …` |
| Minted before the Silicon's custodian rotated its STK | `The short-lived token was issued at … by a sign-in of si:scout that ended when its custodian rotated its STK at …` |
| Minted before the account removed your app's access | `c:… removed the access of the app 'briefcase' at …, after this short-lived token was issued at …` |
| Minted by a Silicon's CI sign-in that has since reached the end it was given | `The short-lived token was issued by a sign-in of si:scout from a trusted outside token, and that sign-in ended at …` |
| Minted by a Silicon's CI sign-in whose trust was removed | `The short-lived token was issued by a sign-in of si:scout from a trusted outside token, and its custodian or the Silicon removed that trust …` |

A token minted by a Silicon's sign-in from CI starts a sign-in at your app that ends when that CI
sign-in ends, and removing the CI trust ends it with `membership.signed_out` (reason
`session_revoked`). [CI and the cloud](ci-and-cloud.md#what-an-app-sign-in-from-ci-lasts) has the
details.

## Refresh

Refresh before the access token's 30 minutes run out, or when your API sees it expire:

```sh
silicon-accounts app token refresh "$REFRESH_TOKEN" --json
```

```rust
let tokens = app.refresh(refresh_token).await?;   // store tokens.refresh_token right away
```

**Rotation.** Every refresh gives you a new refresh token and spends the one you sent. The new
one keeps the sign-in's original `refresh_token_expires_at`, so a sign-in lasts at most 900 days
from the moment the account signed in (or until the end of the CI sign-in it came from), however
often you refresh.

**Reuse detection.** We treat a spent refresh token coming back as theft. The whole sign-in
(every token issued from it, including the newest) is revoked at once, and your webhook gets
`membership.signed_out` with reason `refresh_token_reuse`:

```json
{"error": "invalid_grant", "error_description": "This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in to protect the account, so this sign-in is now revoked; sign in again."}
```

After that, even the newest refresh token answers:

```json
{"error": "invalid_grant", "error_description": "The sign-in this refresh token belongs to was revoked at 2026-10-07T02:35:29.652Z (refresh_token_reuse); sign in again."}
```

**One refresh at a time per sign-in.** Two requests refreshing the same token in parallel (two
tabs, two workers, a retry after a timeout) look exactly like theft to us. One wins, the other
counts as reuse, and the winner's new tokens die with the sign-in. We tested it: two parallel
refreshes gave one `200` and one `invalid_grant`, and the winner's new refresh token was already
revoked. So share one request between callers:

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

The answer stays shared for a minute, so a late caller still holding the old token gets the new
tokens instead of tripping reuse detection. If you run several server processes, put the same
rule in your session store: lock the sign-in's row while you refresh, and write the new refresh
token in the same transaction.

**Scope.** A refresh can send `scope` to repeat or narrow what was granted (the answer still
lists the whole grant), but never to add to it:

```json
{"error": "invalid_scope", "error_description": "A refresh can't add scopes: 'phone' was not granted when the account signed in (granted: 'profile email openid'). Ask for more by sending the account through /authorize again."}
```

**When a refresh fails**, the sign-in is over, so send the account through sign-in again. Every
answer is `invalid_grant` with the reason:

| `error_description` | Why |
|---|---|
| `The sign-in this refresh token belongs to was revoked at … (app_revoked); sign in again.` | Your app revoked it. Other reasons in the parentheses: `refresh_token_reuse`, `authorization_code_reuse`, `access_removed` (the account removed your app's access), `stk_rotated` (a Silicon's custodian rotated its STK), `account_deleted`. |
| `The refresh token expired at … (refresh tokens last 900 days from sign-in at most, and a sign-in that started from a CI job's outside token ends with that job's sign-in); sign in again.` | The sign-in reached its end: 900 days, or the end of the CI sign-in a Silicon got its short-lived token from. |
| `This refresh token was already used once. …` | Reuse: the sign-in is now revoked. |
| `The refresh token was issued to a different app, not to 'dm'; an app can only refresh its own tokens.` | Each app refreshes its own tokens. |
| `The refresh token is not known to Silicon Accounts: it is mistyped, or it belongs to another environment.` | A typo or another environment. |
| `refresh_token must be a refresh token (it starts with sar_), but this is a JWT access token.` | Wrong token. |

## Check an access token

Your API gets access tokens from your own pages, apps and clients. There are two ways to check
them:

| | Locally, with the JWKS | Introspection |
|---|---|---|
| How | Verify the JWT signature with `/.well-known/jwks.json` | `POST /v1/oauth/introspect` |
| Cost | No network call per request (the key set is cached) | One call per check |
| Sees revocation | No: a revoked token stays valid until its `exp`, at most 30 minutes | Yes, at once |
| Use for | Most requests | Sensitive actions, or right after `membership.signed_out` |

An access token carries these claims:

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

`sub` is the account's uuid, `aud` is your app id (refuse any other), `kind` is `carbon` or
`silicon`, `id` is the `c:`/`si:` id at the time the token was issued (it may have changed
since), `mid` is the membership id, `fid` is the sign-in (token family) it belongs to, and
`scope` is what was granted. The header names the key: `{"typ": "JWT", "alg": "EdDSA", "kid": "…"}`.

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

A token for another app fails with `JWTClaimValidationFailed: unexpected "aud" claim value`, and
an expired one with `JWTExpired: "exp" claim timestamp check failed`.

**Locally in Rust**, `app.verify_access_token_locally(&client.jwks().await?, token)` checks the
signature, `exp`/`nbf` (with 30 seconds of leeway) and `aud`. See the
[Rust example](hosted-pages.md#the-same-flow-in-rust). **From the CLI**, run
`silicon-accounts app token verify <token>`. It exits 0 when the token is valid and 2 when it
isn't:

```text
valid: c:lin-docs (nln) for briefcase, expires 2026-10-07T03:08:37Z (in 29m)
```

**Introspection** asks us whether a token of your app is live right now:

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

You can introspect a refresh token too: `token_type` is `refresh_token`, `exp` is the end of the
sign-in (900 days) and `iat` is when that refresh token was issued. Anything that isn't live gets
exactly `{"active":false}`: a token that is unknown, malformed, expired (from `exp` on, with no
leeway), revoked or spent, a token of another app, an account that isn't active, or a membership
that isn't active (the account removed your app's access). `id` and `username` are the account's
current `c:`/`si:` id. Introspection needs your app's own credentials (otherwise you get
`invalid_client`). We accept `token_type_hint` and ignore it.

## Read the account (userinfo)

`GET /v1/userinfo` with the access token gives you the account as your app may see it, with the
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

`POST /v1/userinfo` with a form field `access_token` works too. Send the token once, in the
header or the body. The answer is always current: a renamed account shows its new name right
away, unlike the claims inside a token. `silicon-accounts app userinfo <token>` prints the same
thing. Errors are `401`, with the API's error object and a `WWW-Authenticate: Bearer …` header
that OIDC libraries understand:

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

`token` is the refresh token or any access token of the sign-in, even an expired one. Either one
ends the whole sign-in (every access and refresh token in it), and your webhook gets
`membership.signed_out` with reason `app_revoked`. Once your credentials check out, the answer is
always `200`, as RFC 7009 asks, and the body says what happened:

| Body | Meaning |
|---|---|
| `{"revoked":true}` | The sign-in is ended (also when it was already ended: revoking twice is harmless). |
| `{"revoked":false,"message":"Nothing was revoked: this is not a refresh or access token issued to 'briefcase' (it is unknown, malformed, or belongs to another app). RFC 7009 answers 200 either way."}` | Not a token of yours. The answer never says which, so the endpoint can't probe other apps' tokens. |
| `{"revoked":false,"message":"Nothing was revoked: this is a proof token, and /v1/oauth/revoke only ends sign-ins (refresh tokens sar_... and access tokens). Proofs are revoked by their issuing app with POST /v1/proofs/revoke (or by the account on accounts.teamofsilicons.com)."}` | A credential this endpoint doesn't end; the message says where it is ended. |

`silicon-accounts app token revoke <token>` and `app.revoke(token)` in Rust do the same.

Revoking only ends your app's sign-in. The Carbon stays signed in to Silicon Accounts in their
browser, so your next `/authorize` offers "Continue as …" and comes back without a code form. If
signing out should mean "prove who you are again", send `prompt=login`. Only the account itself
can remove your app altogether, from the account site, and when it does you hear
`membership.access_removed`.
