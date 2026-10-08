---
title: Sign in with the hosted pages
description: Send users to our sign-in pages and bring them back to your app. Set up the callback, check state and exchange the code on your server.
kind: instructive
order: 11
related:
  - start/add-sign-in.md
  - start/tokens.md
  - learn/sign-in-flow.md
  - learn/what-apps-see.md
  - start/sign-in-config.md
---

# Sign in with the hosted pages

Your app starts sign-in by sending the user’s browser to `/authorize`. Accounts handles sign-in and sends the browser back to your registered redirect URI with a code. Your server exchanges that code for tokens.

Use `state` to check that the returning request belongs to a sign-in you started. Use PKCE to tie the code exchange to the same request. The example below does both.

The [iframe](iframe.md), [SDK](sdk.md) and [OIDC libraries](oidc.md) all build this same authorize request. This page explains its parameters and errors too.

This complete app has no dependencies. It assumes `http://localhost:3000/callback` is in your
app's `redirect_uris` ([how to register it](add-sign-in.md#before-you-start)).

```ts
// app.ts: a complete app that signs Carbons in with Silicon Accounts' hosted pages.
// Node 24+ runs TypeScript directly: ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… node app.ts
import { createServer, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const APP_ID = process.env.ACCOUNTS_APP_ID ?? "briefcase";
const APP_SECRET = process.env.ACCOUNTS_APP_SECRET ?? ""; // sa_app_…: server side only, never in a page
const PORT = Number(process.env.PORT ?? 3000);
const REDIRECT_URI = `http://localhost:${PORT}/callback`; // registered in the app's redirect_uris

// state → the PKCE verifier of a sign-in this server started (use your session store in production).
const pending = new Map<string, { verifier: string; startedAt: number }>();
const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const send = (res: ServerResponse, status: number, body: string) =>
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/login") {
    const state = random(32);
    const verifier = random(32);
    pending.set(state, { verifier, startedAt: Date.now() });
    const authorize = new URL("/authorize", ACCOUNTS_URL);
    authorize.search = new URLSearchParams({
      app_id: APP_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "email",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    // The cookie binds the state to this browser, so a link someone else started can't sign it in.
    res.writeHead(302, {
      Location: authorize.toString(),
      "Set-Cookie": `signin_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    });
    return res.end();
  }

  if (url.pathname === "/callback") {
    const error = url.searchParams.get("error");
    if (error) return send(res, 400, `Sign-in ended without signing in: ${error} (${url.searchParams.get("error_description") ?? ""})`);
    const state = url.searchParams.get("state") ?? "";
    const cookieState = /(?:^|;\s*)signin_state=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const started = pending.get(state);
    pending.delete(state); // single use
    if (!started || cookieState !== state || Date.now() - started.startedAt > 60 * 60_000) {
      return send(res, 400, "This sign-in was not started in this browser (or it expired). Start again at /login.");
    }
    const response = await fetch(new URL("/v1/oauth/token", ACCOUNTS_URL), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: url.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: started.verifier,
      }),
    });
    const tokens = await response.json();
    if (!response.ok) return send(res, 502, `Token exchange refused: ${tokens.error}: ${tokens.error_description}`);
    // Key your user record on tokens.account.uuid (permanent); tokens.account.id (c:…/si:…) can change.
    // Keep tokens.refresh_token server side: it rotates on every refresh.
    return send(res, 200, `Signed in as ${tokens.account.id} (${tokens.membership_id})\n${JSON.stringify(tokens.account, null, 2)}`);
  }

  res.writeHead(200, { "Content-Type": "text/html" }).end(`<a href="/login">Sign in</a>`);
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
```

Run it, open `http://localhost:3000`, and sign in. A first-time Carbon goes through email code,
sign-up and the details page (what's shared with your app); the callback then shows:

```text
Signed in as c:grace-hopper (briefcase:ptO)
{
  "uuid": "ptO",
  "membership_id": "briefcase:ptO",
  "kind": "carbon",
  "id": "c:grace-hopper",
  "display_name": "Grace Hopper",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=ptO",
  "email": "grace.hopper@example.com",
  "email_verified": true,
  "updated_at": "2026-10-07T02:56:29.875Z",
  "version": 1
}
```

What each step protects against:

- **A fresh `state` per sign-in, bound to the browser by a cookie.** The callback only accepts
  a state this server issued to this browser, once. Otherwise anyone could send your user a
  link that finishes *their* sign-in in your user's browser (login CSRF).
- **PKCE (`code_challenge` now, `code_verifier` at the exchange).** Someone who reads the code
  from a log, a referrer or a proxy still can't exchange it without the verifier.
- **The exchange on your server.** It needs your app secret, which never leaves the server.
- **The 60-minute window.** A hosted flow lives 60 minutes (a first-time Carbon may sign up
  and add a phone on the way), so the example keeps a sign-in's state for that long and
  refuses anything older. The code itself must then be exchanged within 2 minutes.

## The authorize request

`GET https://accounts.teamofsilicons.com/authorize?…` is a page, not an API: the browser opens
it, and the hosted pages create a sign-in flow bound to that browser.

| Parameter | Required | Rules |
|---|---|---|
| `app_id` | yes | Your app id. `client_id` is accepted as an alias (OAuth libraries send it); if both are sent they must agree. |
| `redirect_uri` | yes | Exactly one of your registered `redirect_uris` (loopback hosts match on any port, see [registering](add-sign-in.md#before-you-start)). |
| `response_type` | no | `code`, or leave it out. Anything else is `unsupported_response_type`: only authorization codes are issued (no implicit or hybrid flows). |
| `state` | for you, yes | Up to 1,024 printable characters, returned byte for byte. Silicon Accounts doesn't require it; your app must. |
| `code_challenge` | recommended | 43 to 128 characters of `A-Z a-z 0-9 - . _ ~`. For S256: base64url(SHA-256(verifier)) without padding (43 characters). |
| `code_challenge_method` | with a challenge | `S256` (use this) or `plain`. A challenge without a method is treated as `S256`, not `plain`. A method without a challenge is refused. |
| `scope` | no | Space-separated: `profile` (always granted), `email`, `phone`, `dob`, `timezone`, `openid` (adds an `id_token`), `offline_access` (accepted, ignored: refresh tokens are always issued). Unknown scopes are `invalid_scope`. Without `scope` the request asks for `profile`. |
| `nonce` | with `openid` | Up to 512 printable characters, copied into the `id_token`. |
| `prompt` | no | `none`, `login`, `consent`, `select_account`, several separated by spaces; `none` alone. See [prompt](#prompt). |
| `intent` | no | `signin` (default) or `signup`: the sign-in or the sign-up version of the pages ("Sign in to Briefcase" or "Create your Briefcase account"). Anything else is `invalid_request`. |
| `method` | no | `google`, `apple`, `email` or `phone`: open that method directly. It must be one of the app's enabled methods, else `method_not_enabled`. |

`login_hint` is accepted and ignored: your app can never hand Silicon Accounts a Carbon's email or
phone number; the Carbon always types it on the hosted pages.

Other parameters (`max_age`, `ui_locales`, `request`, `claims`, …) are ignored. Repeated
parameters use their first value.

What you ask for in `scope` is on top of what your sign-in setup already demands: your
`required_fields` are always required and your `optional_fields` are always offered. A detail
you ask for in `scope` that isn't required is offered as optional (an unticked checkbox on the
last page); the Carbon can leave it unticked.
[What your app sees](../learn/what-apps-see.md#the-whats-shared-screen) explains which details
end up granted.

## When the browser comes back

Success:

```text
http://localhost:3000/callback?code=sac_KjpuMF137oQt0PoSfQ_fhS7IdoE64Cs600N9PcasFhc&state=EChNem4VPMzmIxr8frLfQf-CTjKqg8KzfPGVICgiu_U
```

A sign-in that ends without signing anyone in comes back with an RFC 6749 error instead:

```text
http://localhost:3000/callback?error=access_denied&error_description=The+Carbon+declined+to+share+their+details+with+the+app.&state=91b7b09f9ef5dcd6470f7ff132a08777
```

| `error` | When | What to do |
|---|---|---|
| `access_denied` | The Carbon cancelled on a details or review page. | Show your signed-out page; offer to try again. Nothing was shared. |
| `login_required` | `prompt=none`, and the browser isn't signed in to Silicon Accounts (or your app has `remember_browser` off, so the browser's account can't be reused). | Send the browser to `/authorize` without `prompt=none`. |
| `consent_required` | `prompt=none`, and the account hasn't granted everything you now ask for. | Same: without `prompt=none`, so the Carbon sees the details pages. |
| `interaction_required` | `prompt=none`, and the account misses a detail you require (a verified email or phone), or has no verified email at your `allowed_email_domains`. | Same: the pages ask for the missing detail or another account. |
| `invalid_request`, `invalid_scope`, `unsupported_response_type` | Your authorize URL has a mistake (bad `prompt`, PKCE, `method`, scope, response type). The hosted page says so and offers "Back to the app", which lands here. | Read `error_description`, fix the URL. |

Some mistakes never come back to you, because sending the browser to an address the app
never registered would make Silicon Accounts an open redirect. The hosted page explains the
problem and stops: an unknown `app_id` (`unknown_app`), a disabled app (`app_disabled`), a
`redirect_uri` that isn't registered (`redirect_uri_not_registered`), a missing `app_id` or
`redirect_uri`, and more than 300 sign-ins started from one network in a minute
(`rate_limited`).

## Exchange the code

From your server, within 2 minutes, once:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d redirect_uri=http://localhost:3000/callback -d "code_verifier=$CODE_VERIFIER"
```

or with the CLI in app mode (`silicon-accounts app use briefcase --secret-stdin` first, or
`ACCOUNTS_APP_ID` / `ACCOUNTS_APP_SECRET` in the environment):

```sh
silicon-accounts app token exchange --code "$CODE" --redirect-uri http://localhost:3000/callback --code-verifier "$CODE_VERIFIER"
```

```text
Exchanged the code for c:grace-hopper (ptO).
access token   eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6…
expires in     1800s
refresh token  sar_3tEv-OkGuQ6YLovqTGtzbvTAa-jlOCF7YVh7PJrsK3U
scope          profile email
membership     briefcase:ptO
```

Add `--json` for the full token response on stdout.

The client authenticates with HTTP Basic (`client_secret_basic`) or with `client_id` and
`client_secret` in the form body (`client_secret_post`), never both. The body may also be
JSON. The response and every token field are explained in
[Exchange, refresh, check and revoke tokens](tokens.md). Refusals are RFC 6749 errors with an
exact description:

| Status, `error` | `error_description` (real examples) | Cause |
|---|---|---|
| 401 `invalid_client` | `The client_secret sent for 'briefcase' is wrong.` | Wrong or missing credentials (also `WWW-Authenticate: Basic realm="Silicon Accounts"`). |
| 400 `invalid_grant` | `The authorization code is not known: it is mistyped, it was never issued, or it comes from another Silicon Accounts environment.` | A typo, or a code from another environment. |
| 400 `invalid_grant` | `The authorization code was already used. Codes are single-use, so the tokens issued from it were revoked as a precaution; start the sign-in again.` | The code was exchanged before. The first exchange's tokens are revoked and your webhook gets `membership.signed_out` with reason `authorization_code_reuse`: someone else may hold the code. |
| 400 `invalid_grant` | `The authorization code expired at 2026-10-07T02:35:19.274Z (codes are valid for 120 seconds after the sign-in); start the sign-in again.` | Exchanged too late. |
| 400 `invalid_grant` | `redirect_uri 'http://localhost:3000/other' does not match the redirect_uri of the authorization request ('http://localhost:3000/callback'); the two must be exactly equal.` | Send the same `redirect_uri` as in the authorize URL. |
| 400 `invalid_grant` | `code_verifier is required: the authorization request sent a code_challenge (PKCE, method S256).` | You sent a challenge; send its verifier. |
| 400 `invalid_grant` | `PKCE verification failed: the code_verifier does not match the code_challenge sent to /authorize (method S256: BASE64URL(SHA256(code_verifier)) must equal the code_challenge).` | Wrong verifier (often the verifier of another sign-in). |
| 400 `invalid_grant` | `code_verifier was sent, but the authorization request had no code_challenge. …` | Refused to stop PKCE downgrade attacks: send the challenge to `/authorize`, or no verifier. |
| 400 `invalid_grant` | `The authorization code was issued to a different app, not to 'dm'; …` | Each app exchanges only its own codes. |
| 400 `unsupported_grant_type` | `grant_type 'password' is not supported; …` | Only `authorization_code`, `refresh_token`, the SLT grant and the device grant exist. |

Any refused exchange uses the code up, so a retry with the same code always fails: start a
new sign-in.

## prompt

| `prompt` | The hosted pages |
|---|---|
| none given | Offer "Continue as …" when the browser is signed in to Silicon Accounts (and your app allows it), else the sign-in methods. Show the details pages only when the account hasn't granted everything you need. |
| `login` | Ignore the browser's session: the Carbon proves who they are again (code, Google or Apple). Use it before sensitive actions, then check `auth_time` in the `id_token`. |
| `consent` | Always show every details page, even when everything was granted before. The Carbon can also untick optional details there. |
| `select_account` | Show the account chooser. The hosted pages already show it whenever the browser is signed in, so this changes nothing today; it is accepted for OIDC libraries that send it. |
| `none` | Show nothing: complete at once with the browser's account, or come back with `login_required`, `consent_required` or `interaction_required`. It can't be combined with other values (`invalid_request`). |

`prompt=none` is the way to check silently whether someone is already signed in, for example
when your page loads. It never shows a page: a Carbon who hasn't granted what you ask for gets
`consent_required` instead of the details pages, so send them through a normal sign-in next. `max_age` is not supported: use `prompt=login` and compare `auth_time` instead.

## Direct buttons and Sign in / Sign up

Your own site can carry direct buttons: "Continue with Google", "Continue with Apple",
"Continue with email", "Continue with phone number". Each is a link to `/authorize` with
`method=…`:

- `method=email` or `method=phone` opens the hosted page straight on that empty field;
- `method=google` or `method=apple` first opens our Opening page, "Opening Google to sign you in
  to {app name}…" in your app's style (with "Powered by Silicon Accounts" at the bottom), then
  moves on to Google or Apple by itself after a moment. A "Continue to Google" button is there in
  case it doesn't, and "Other ways to sign in" goes back to your other methods. Change its words
  with `copy.opening_title`.

Or just a "Sign in" and a "Sign up" button: send `intent=signup` from your sign-up button, and
the hosted pages show the sign-up version (`copy.signup_title`, default "Create your {app name}
account"); the sign-in button sends nothing extra. The account logic is the same either way: a
first visit with an email, phone, Google or Apple is a sign-up. `intent` and `method` combine,
and the [SDK](sdk.md) and [iframe](iframe.md) render either set of buttons for you.

Every one of these only saves the Carbon a step: they can still go back and pick another method.
Your app never passes their email or phone: the Carbon types it on our pages.

## What the Carbon is asked on the way

After proving who they are, the hosted pages show your app's details pages before coming back:
one page with everything you ask for, or the pages of your own [flow](sign-in-config.md#flows),
with an optional review page at the end.

- **Required details** are listed as shared (with a lock). If your `required_fields` include
  `phone` (or `email`) and the account has no verified one, the Carbon adds it with a 6-digit
  code right there, on that page. Date of birth and timezone are never missing: every account
  has them.
- **Optional details** are checkboxes, unticked until the Carbon ticks them.
- **When.** Every page the first time an account signs in to your app (and with
  `prompt=consent`); after that only a page with something new, such as a detail you now
  require. A Carbon with nothing new comes straight back.

The exact rules are in [What your app sees about an account](../learn/what-apps-see.md).

## Who may sign in

Three settings of your [sign-in setup](sign-in-config.md) decide who gets through:

| Setting | Default | Effect |
|---|---|---|
| `allow_signup` | `true` | `false`: no new Silicon Accounts account can be created through your sign-in. A Carbon who proves an email or phone nobody has gets `403 signup_not_allowed` ("Legacy CRM doesn't accept new accounts: …"). Existing accounts still sign in and become members, and Carbons you [imported](import-users.md) finish their setup. It doesn't limit *which* existing accounts sign in. |
| `allowed_email_domains` | `[]` (any) | Only these domains, checked before an email code is sent (`403 email_domain_not_allowed`), for Google and Apple emails, for "Continue as" (the account needs a verified email at one of them), and for an email added on the way because you require one. A phone code is **not** checked today: a Carbon who signs in by phone gets in, with whatever email the account already has, even one at another domain. Keep `phone` off on an app that restricts domains. |
| `remember_browser` | `true` | `false`: never offer "Continue as …"; every sign-in proves the Carbon again. `POST …/continue` answers `403 continue_not_allowed`, and `prompt=none` always ends with `login_required` (its message says no Carbon is signed in in this browser even when one is: a known bug; the code is the part to trust). |

A Silicon never meets these pages. When it signs in with a short-lived token, your
`allowed_email_domains` are not applied to it (Silicons have no email); a Carbon getting a
short-lived token through the CLI does need a verified email at your domains.

## Google and Apple: one click or your own

For both providers you choose a `mode` in the sign-in setup.

**`managed` (one click).** Turn the method on and nothing else:

```sh
silicon-accounts app config set - <<< '{"methods": {"google": true, "apple": true}}'
```

Google's and Apple's own consent pages then show Silicon Accounts as the requester.

**`byo` (bring your own).** Google's and Apple's consent pages show your app's name and logo,
and the provider's quotas and review are yours. Silicon Accounts stays the medium: the
provider sends the Carbon back to Silicon Accounts, which finishes the sign-in and then sends
them to your redirect URI. So the address you register *at the provider* is Silicon Accounts'
callback, never your own:

| Provider | Register at the provider | Then send |
|---|---|---|
| Google | An OAuth client of type "Web application" with the authorized redirect URI `https://accounts.teamofsilicons.com/v1/oauth/callback/google` | `{"google": {"mode": "byo", "client_id": "…apps.googleusercontent.com", "client_secret": "GOCSPX-…"}}` |
| Apple | A Services ID with Sign in with Apple, domain `accounts.teamofsilicons.com`, return URL `https://accounts.teamofsilicons.com/v1/oauth/callback/apple`, and a Sign in with Apple key (`.p8`) | `{"apple": {"mode": "byo", "services_id": "com.example.signin", "team_id": "ABCDE12345", "key_id": "XYZ9876543", "private_key": "-----BEGIN PRIVATE KEY-----\n…"}}` |

```sh
curl -s -X PATCH -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" \
  "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/signin-config" -H 'Content-Type: application/json' \
  -d '{"methods": {"google": true},
       "google": {"mode": "byo", "client_id": "525053125706-….apps.googleusercontent.com", "client_secret": "GOCSPX-…"}}'
```

The secret and the `.p8` key are stored encrypted and never returned: reading the setup shows
`"client_secret_set": true` and `"private_key_set": true` instead. Sending `null` removes one.
Switching to `byo` without them is refused, with every missing field named:

```json
{
  "error": {
    "code": "validation_failed",
    "details": {
      "fields": {
        "apple.key_id": "is required when apple.mode is byo (10 characters, from your Apple developer account)",
        "apple.private_key": "is required when apple.mode is byo; send the .p8 key as {\"apple\":{\"private_key\":\"-----BEGIN PRIVATE KEY-----…\"}}",
        "apple.services_id": "is required when apple.mode is byo (your Services ID, e.g. com.example.signin)",
        "apple.team_id": "is required when apple.mode is byo (10 characters, from your Apple developer account)",
        "google.client_id": "is required when google.mode is byo (your Google OAuth client id)",
        "google.client_secret": "is required when google.mode is byo; send it as {\"google\":{\"client_secret\":\"…\"}}"
      }
    },
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "message": "Invalid fields: …"
  }
}
```

Two more Google settings shape the provider's own page: `google.prompt` (`select_account` by
default, or `consent`, `none`, `consent select_account`) and `google.hosted_domain`, a Google
Workspace domain. With `hosted_domain` set, Google is asked (with its `hd` hint) to offer only
accounts of that domain, and Silicon Accounts refuses any Google account from another domain
(`hosted_domain_mismatch`), because a hint alone can be edited out of the URL.

Whichever mode: an email that Google or Apple vouch for counts as verified, so it needs no
code, and if that email already belongs to an account, the Carbon signs in to that account
instead of creating a new one. Why the provider's answer can only be delivered by the browser
that started the sign-in is in [How the hosted sign-in works](../learn/sign-in-flow.md#google-and-apple).

## The same flow in Rust

The Rust package builds the authorize URL and makes every token call. This program prints the
URL, reads back the address the browser lands on, then exchanges, checks, refreshes and
revokes. The crate isn't on crates.io yet, so it is a `path` dependency on a checkout of the
repository ([Install](../reference/rust-client.md#install) says why):

```toml
# Cargo.toml
[dependencies]
silicon-accounts-client = { path = "/path/to/silicon-accounts/crates/client" }   # your checkout
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
url = "2"
```

```rust
//! Sign Carbons in to your app from Rust: hosted pages with state + PKCE, then exchange,
//! check, refresh and revoke. Run: ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET=sa_app_… cargo run
use std::collections::HashMap;

use silicon_accounts_client::{AuthorizeParams, Config, pkce_pair, random_state};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ACCOUNTS_URL (default https://accounts.teamofsilicons.com), ACCOUNTS_APP_ID, ACCOUNTS_APP_SECRET.
    let config = Config::from_env()?;
    let client = config.client()?;
    let app = config.app_client(&client).ok_or("set ACCOUNTS_APP_ID and ACCOUNTS_APP_SECRET")?;
    let redirect_uri = "http://localhost:3000/callback"; // one of the app's redirect_uris

    // 1. Send the browser to the hosted pages. Keep `state` and `pkce.verifier` for the callback.
    let pkce = pkce_pair();
    let state = random_state();
    let url = client.authorize_url(
        &AuthorizeParams::new(app.app_id(), redirect_uri)
            .state(&state)
            .pkce(&pkce)
            .scopes(["email"]),
    );
    println!("Open this address, sign in, then paste the address you land on:\n{url}");

    // 2. The browser comes back to redirect_uri?code=…&state=… (or ?error=…&state=…).
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let back: HashMap<String, String> = url::Url::parse(line.trim())?.query_pairs().into_owned().collect();
    if let Some(error) = back.get("error") {
        return Err(format!("the sign-in ended without signing in: {error}").into());
    }
    if back.get("state") != Some(&state) {
        return Err("state does not match: this is not the sign-in this program started".into());
    }

    // 3. Exchange the code (single use, 2 minutes) with the PKCE verifier.
    let tokens = app.exchange_code(&back["code"], redirect_uri, Some(&pkce.verifier)).await?;
    let account = tokens.account.as_ref().ok_or("token responses carry the account")?;
    println!("signed in: {} (uuid {}, membership {})", account.id, account.uuid, account.membership_id);

    // 4. Check the access token: locally with the JWKS (fast), or ask the service (sees revocation).
    let jwks = client.jwks().await?;
    let claims = app.verify_access_token_locally(&jwks, tokens.access_token.expose())?;
    println!("local check: sub {} scopes {:?}", claims.sub, claims.scopes());
    let live = app.introspect(tokens.access_token.expose()).await?;
    println!("introspection: active {}", live.active);
    let info = app.userinfo(tokens.access_token.expose()).await?;
    println!("userinfo: {} {:?}", info.account.display_name, info.account.email);

    // 5. Refresh before the access token's 30 minutes run out; always keep the NEW refresh token.
    let old_refresh = tokens.refresh_token.as_ref().ok_or("no refresh token")?.expose().to_owned();
    let tokens = app.refresh(&old_refresh).await?;
    println!("refreshed: expires in {} s", tokens.expires_in);

    // 6. Sign the account out of your app: the whole sign-in ends.
    app.revoke(tokens.refresh_token.as_ref().ok_or("no refresh token")?.expose()).await?;
    let after = app.introspect(tokens.access_token.expose()).await?;
    println!("after revoke: active {}", after.active);
    Ok(())
}
```

```text
Open this address, sign in, then paste the address you land on:
https://accounts.teamofsilicons.com/authorize?response_type=code&app_id=briefcase&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&state=kSj2dTMJ88E92lB_sXVv7mOHHasuEn5c&code_challenge=_Xwad6JJcE34Gs9gJVVlSABhLnAnsFCd6kYOXrAag5c&code_challenge_method=S256&scope=email
signed in: c:lin (uuid nln, membership briefcase:nln)
local check: sub nln scopes ["profile", "email"]
introspection: active true
userinfo: Lin Okafor Some("lin-docs@example.test")
refreshed: expires in 1800 s
after revoke: active false
```

Errors are typed: `error.is_code("invalid_grant")`, `error.as_oauth()`, and `Display` prints
the service's message and a hint. The whole package is in the
[Rust client reference](../reference/rust-client.md).

## When something goes wrong

| You see | Why | Fix |
|---|---|---|
| The hosted page says "This sign-in link is not set up right" | `redirect_uri` isn't one of your `redirect_uris` (`redirect_uri_not_registered`): a trailing slash, another host (`127.0.0.1` vs `localhost`) or `http` in production all count as different. | Register the exact URI, or send the registered one. |
| "This app is not on Silicon Accounts" | Unknown `app_id`. | Check the app id in the link. |
| The callback gets `error=invalid_request` | A bad `prompt`, `method`, PKCE parameter or `state` (over 1,024 characters or with control characters). | `error_description` names the parameter. |
| `invalid_grant` "already used" right after a successful sign-in | Your callback ran twice (a double request, a browser prefetch, a retry), so the second exchange revoked the first one's tokens. | Exchange each code once; make the callback idempotent per `state`. |
| The Carbon lands on your callback with a `state` you don't know | The sign-in was started in another browser, or your state store forgot it. | Refuse it and start a new sign-in. Never exchange a code whose state you can't match. |
| Every sign-in shows the details pages | You send `prompt=consent`, or ask in `scope` for details the account declined. | Ask in `scope` only for what you need. |
