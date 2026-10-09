---
title: Add sign-in to your app
description: Send your users to us to sign in, bring them back to your app, and exchange the code they return with for their tokens.
kind: instructive
order: 10
related:
  - start/hosted-pages.md
  - start/iframe.md
  - start/sdk.md
  - start/oidc.md
  - start/tokens.md
  - learn/sign-in-flow.md
  - learn/what-apps-see.md
  - learn/tokens-and-sessions.md
---

# Add sign-in to your app

Adding sign-in to your app takes three steps. You register the address your users come back to, you send them to us to sign in, and when they come back, your server exchanges the code in the URL for their account and tokens.

We handle every page in between: email codes, phone codes, Google, Apple and first-time account setup. We also keep the list of everyone who has signed in to your app.

```sh
export ACCOUNTS_URL=https://accounts.teamofsilicons.com   # or a local stack: http://localhost:8590
export ACCOUNTS_APP_ID=briefcase                 # your app_id
export ACCOUNTS_APP_SECRET=sa_app_briefcase_…    # your app secret: server side only

# 1. Register where sign-ins may come back to. Arrays replace: send the whole list.
curl -s -X PATCH -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" \
  "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/signin-config" \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris": ["http://localhost:3000/callback"]}'

# 2. Send a browser here (state and PKCE are explained on the next page):
#    $ACCOUNTS_URL/authorize?app_id=briefcase&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback
#      &response_type=code&scope=email&state=<random>&code_challenge=<S256 of verifier>&code_challenge_method=S256
#    It comes back to http://localhost:3000/callback?code=sac_…&state=<the same random>

# 3. Exchange the code from your server (single use, 2 minutes).
CODE=sac_KjpuMF137oQt0PoSfQ_fhS7IdoE64Cs600N9PcasFhc    # from ?code= on your redirect URI
CODE_VERIFIER=E15DM7MQnflo3tekdOzGQsyGGg_PvzC7c4SEUNCivQI # the PKCE verifier kept for this sign-in
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d redirect_uri=http://localhost:3000/callback -d "code_verifier=$CODE_VERIFIER"
```

The exchange gives you back the account, as your app is allowed to see it:

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGci…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_C81QHHts0NsCxSaoG5BBIdacrQ_jg9XqJXk-bD3MVX4",
  "refresh_token_expires_at": "2029-03-25T02:56:36.117Z",
  "scope": "profile email",
  "membership_id": "briefcase:ptO",
  "account": {
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
}
```

Key your user record on `account.uuid` (or `membership_id`, which is `{app_id}:{uuid}`).
Never key it on `account.id`: a Carbon or Silicon can change its `c:`/`si:` id, and your
webhook hears `account.id_changed` when it does.
[What your app sees about an account](../learn/what-apps-see.md) explains why.

## Before you start

You need three things.

1. **An `app_id` and an app secret.** Apps are created in Silicon Apps, and your app can sign
   Carbons and Silicons in as soon as it exists there. The secret (`sa_app_…`) proves your
   server is the app, so keep it on the server and never put it in a page, a mobile app or a
   repository. Your app is a confidential client unless you turn on `public_client`, so the code
   exchange needs the secret, and single-page apps exchange the code through a server they control.
   Desktop apps and CLIs use `public_client` or the device flow instead (see below).
2. **Registered redirect URIs.** We only ever send a browser back to an address in your
   `redirect_uris`, compared character for character. `https` is required, except
   `http://localhost`, `http://127.0.0.1` and `http://[::1]` for development, which match on
   any port when registered with that host. Native apps can use a reverse-domain scheme such
   as `com.example.app:/callback`. You can register at most 50, with no `#fragment`.
3. **Allowed origins, for the iframe only.** If you frame the sign-in buttons, list your
   page's origin (`https://app.example.com`, no path) in `allowed_origins`.

The CLI does the same setup. It shows you the whole configuration first, so you don't drop an
entry by accident (arrays replace, they never merge):

```sh
printf '%s' "$ACCOUNTS_APP_SECRET" | silicon-accounts app use briefcase --secret-stdin
silicon-accounts app config get                      # the setup as JSON, with its version
silicon-accounts app config set - --expected-version 4 <<'JSON'
{
  "redirect_uris": ["https://briefcase.example/auth/callback", "http://localhost:3000/callback"],
  "allowed_origins": ["https://briefcase.example"],
  "methods": {"email": true, "google": true, "apple": true, "phone": false},
  "required_fields": ["email"],
  "optional_fields": ["timezone"]
}
JSON
```

`--expected-version` (or `"expected_version"` in the PATCH body) refuses the change with
`409 config_version_conflict` if someone else changed the setup since you read it. Every
invalid field is reported at once, for example:

```text
error: Invalid fields: allowed_origins[0]: 'https://briefcase.example/app' must be just scheme://host[:port], without a path; redirect_uris[0]: 'http://briefcase.example/callback' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development.
```

Everything else about sign-in (methods and their order, Google and Apple, required and
optional details, allowed email domains, sign-up and the look of the pages) is in
[Configure sign-in](sign-in-config.md) and [Make the pages your own](branding.md).

## Choose how Carbons reach the sign-in pages

Every way ends the same: the browser lands on your `redirect_uri` with `?code=…&state=…`, and
your server exchanges the code. The only difference is how the browser gets to `/authorize`.

| Way | You add | Pick it when | Page |
|---|---|---|---|
| Hosted pages | a redirect to `/authorize` | you want the least code and full control of the request; works from any server, CLI-launched browser or native app | [Sign in with the hosted pages](hosted-pages.md) |
| Iframe | an `<iframe>` of `/embed/v1/buttons` | you want the app's own sign-in buttons on your page without loading a script | [Embed the sign-in buttons](iframe.md) |
| SDK snippet | one `<script>` tag | you want the buttons rendered in your page (no iframe), or a JavaScript API (`signIn`, `handleCallback`) | [Drop in the SDK snippet](sdk.md) |
| Any OIDC library | discovery URL, client id and secret | you already use an OpenID Connect library, or want a verified `id_token` | [Use any OpenID Connect library](oidc.md) |

The buttons in the iframe and the snippet never sign anyone in inside your page. A click
always takes the whole window to `/authorize`. That way the Carbon sees
`accounts.teamofsilicons.com` in the address bar, the Silicon Accounts session cookie works
without third-party cookies, and no page of yours can draw over or read the code form.
[How the hosted sign-in works](../learn/sign-in-flow.md) has the reasons.

## Silicons sign in without the pages

A Silicon never sees a sign-in page. It signs in to Silicon Accounts with its si:id and STK,
asks us for a short-lived token for your app, and hands that token to you:

```sh
silicon-accounts login --app briefcase      # run by the Silicon: prints slt_… (single use, 2 minutes)
```

Your server exchanges it like a code, with your app's credentials:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt \
  -d slt=slt_EU9dimsSJbNOiICVwz_631KjzBStkrX80nwoV-9pHWQ
```

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGci…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_NYEb1sRFdzrTH8VlepvfKdSgujJPLUr0r1K1msEY97Y",
  "refresh_token_expires_at": "2029-03-25T02:56:55.453Z",
  "scope": "profile timezone",
  "membership_id": "briefcase:1Nx",
  "account": {
    "uuid": "1Nx",
    "membership_id": "briefcase:1Nx",
    "kind": "silicon",
    "id": "si:scout",
    "display_name": "Scout",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=1Nx",
    "timezone": "Asia/Kolkata",
    "custodian": {"uuid": "ptO", "id": "c:grace-hopper"},
    "updated_at": "2026-10-07T02:56:54.507Z",
    "version": 1
  }
}
```

Give Silicons a way to hand your app that token, such as an input field, an API endpoint or a
CLI flag. The exchange needs your app secret, so it happens on your server, and a CLI forwards the
token to your backend. The exception is your own command-line or desktop tool when you turn on
`public_client`: it may exchange the token with your `client_id` alone
([CLI plus backend](#cli-plus-backend) shows both).
For the exchange, your server can also use the shorter alias `grant_type=slt`.

Each token works once, for one app, for 2 minutes. If it was already used, has expired or
belongs to another app, we answer `invalid_grant` with the reason.
[Sign a Silicon in to an app](silicon-sign-in-to-apps.md) covers the Silicon's side, and
[Exchange, refresh, check and revoke tokens](tokens.md#a-silicons-short-lived-token) covers the exchange.

## Sign people into your CLI

Your app's own command-line tool often runs where there's no browser, on a server or over SSH.
It can still sign a Carbon in. Your tool shows a short code, and the Carbon opens the account
site on any device, checks it's your app asking, and approves. This is the OAuth device
authorization grant (RFC 8628), the same one `silicon-accounts login` uses. Your tool needs no
secret, because a secret shipped inside a CLI isn't secret.

Turn it on once, as the app or one of its authors:

```sh
curl -s -X PATCH "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -d '{"device_flow": true}'
```

Then your tool starts a sign-in with your `app_id` and nothing else, and shows the code:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/device/authorize" \
  -d client_id="$APP_ID" -d scope=email -d client_label="notes CLI on build-box"
```

```json
{
  "device_code": "sad_bXmMc5C9tF_K7UZl8cLE5Ff2R1Q0_hbtXv87TIkbngU",
  "user_code": "MVHB-KQAW",
  "verification_uri": "https://accounts.teamofsilicons.com/device",
  "verification_uri_complete": "https://accounts.teamofsilicons.com/device?code=MVHB-KQAW",
  "expires_in": 600,
  "interval": 5
}
```

Print something like "Open https://accounts.teamofsilicons.com/device and enter MVHB-KQAW",
then poll every `interval` seconds until the Carbon decides:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code="$DEVICE_CODE" -d client_id="$APP_ID"
```

While the Carbon looks, you get `authorization_pending`. You get `slow_down` if you poll faster
than every 5 seconds, `access_denied` if they say no, and `expired_token` after 10 minutes.
Once they approve, the next poll returns your app's tokens, exactly like a code exchange, and
the account joins your user base. To refresh, send `grant_type=refresh_token` with your
`client_id` alone.

What the Carbon sees and what you get:

- **Your app, not ours.** The approval page names your app, with its logo and branding, the
  label your tool sent, and what it will share: `profile`, the details you require, and the
  optional ones you asked for in `scope`.
- **Your rules.** Your `allowed_email_domains` and required details apply. A Carbon without a
  verified email at your domains gets `email_domain_not_allowed`, one missing a required email
  or phone gets `requirements_missing`, and neither is signed in.
- **Limits.** 60 device sign-ins started per network and 600 per app every 10 minutes. A Carbon
  can look up 60 codes per 10 minutes.

A Silicon can't use the device flow: only a Carbon can approve a code. It signs in with a
[short-lived token](#silicons-sign-in-without-the-pages) instead. With `public_client` turned on,
your CLI exchanges that token itself with your `client_id` alone, so a CLI with no backend can
sign in Carbons and Silicons both. [CLI plus backend](#cli-plus-backend) shows both, with and
without a server.

### Desktop and native apps

A desktop app, or a CLI that can open a browser, can use the normal hosted pages as a public
client (RFC 8252) instead. Turn on `public_client` in the same sign-in setup, send the Carbon's
browser to `/authorize` with PKCE (`code_challenge` with `code_challenge_method=S256`), and
exchange the code with your `client_id` and the `code_verifier`, with no secret. Register a
loopback redirect URI such as `http://127.0.0.1/callback`. Any port works at sign-in time, so
your app can listen on whatever port is free. For a public client, a code without PKCE is refused.

## CLI plus backend

A CLI can sign both kinds of account in without a server of its own. Three rules meet here:

- Only a signed-in Carbon can approve a device code, so Carbons use the device flow.
- Silicons never use the sign-in pages: they hand you a short-lived token.
- Exchanging a short-lived token needs your app secret, unless your app turned on
  `public_client`. Then your CLI may exchange it with your `client_id` alone, and we record the
  sign-in with the method `slt_public_client`. The token itself is the proof: it works once, for
  120 seconds, only at your app, and only the Silicon that minted it can hand it over. A secret
  shipped inside a CLI isn't secret, so never put your app secret in one.

Without a backend, the CLI exchanges the token itself:

```sh
SLT=$(silicon-accounts login --app notes -q)
curl -s "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d client_id=notes -d "slt=$SLT"
```

The CLI then keeps the refresh token on the machine, as it does for a Carbon's device sign-in.
In Rust, `AccountsClient::exchange_slt_public_client("notes", &slt)` makes the same request. An
app without `public_client` gets `400 unauthorized_client`, and the description lists the grants
a public client may use.

If your CLI talks to an API of yours, a small backend is the usual shape instead: the backend
exchanges the token with the app secret, keeps the refresh tokens, and gives the CLI its own
session. Here is the whole recipe for a `notes` CLI whose backend runs at `https://notes.example`:

```text
Carbon   notes login ── device code ──▶ Silicon Accounts ◀── approves at /device ── the Carbon's browser
Silicon  silicon-accounts login --app notes ──▶ slt_… ──▶ notes login --slt-stdin ──▶ notes backend
                                                            notes backend ── slt_… + app secret ──▶ Silicon Accounts
CI job   signs in as the Silicon with the job's OIDC token, then the same as a Silicon
```

**1. People sign in with the device flow.** Turn on `device_flow` and sign Carbons in as in
[Sign people into your CLI](#sign-people-into-your-cli), with your `client_id` alone. The tokens
are your app's tokens, so your backend can [check them](tokens.md#check-an-access-token) like any
other.

**2. Silicons hand the CLI a short-lived token, and the CLI forwards it.** The Silicon gets a token
for your app and gives it to your CLI, on stdin so it stays out of the process list:

```sh
SLT=$(silicon-accounts login --app notes -q)
printf '%s' "$SLT" | notes login --slt-stdin
```

Your CLI sends it on, unchanged, over https, within its 2 minutes. This is the request it makes:

```sh
curl -s -X POST https://notes.example/api/silicon-login \
  -H 'Content-Type: application/json' -d "{\"slt\":\"$SLT\"}"
```

Your backend exchanges it with the app secret, which never leaves the backend:

```sh
curl -s -u "notes:$NOTES_APP_SECRET" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
```

The answer is the [token response above](#silicons-sign-in-without-the-pages). The backend keys
the user on `account.uuid`, keeps the refresh token, and gives the CLI your own session for your
API. A used, expired or wrong-app token answers `400 invalid_grant` with the reason. Pass that
back, so the Silicon gets a fresh token instead of retrying.

**3. In CI, the Silicon signs in with the job's own token.** A trust set up by its custodian lets
a CI job sign in as the Silicon with no stored STK ([how](ci-and-cloud.md)). With the
`silicon-accounts` CLI it's `silicon-accounts login --silicon si:scout --federated --github-actions`,
then step 2. A Rust CLI can do it itself with the `silicon-accounts-client` crate:

```rust
use silicon_accounts_client::{AccountsClient, TokenSource};

#[tokio::main]
async fn main() -> silicon_accounts_client::Result<()> {
    let client = AccountsClient::new("https://accounts.teamofsilicons.com")?;
    // The job's OIDC token (the workflow needs `permissions: id-token: write`).
    let source = TokenSource::GithubActions { audience: "https://accounts.teamofsilicons.com".into() };
    let ci_token = source.read().await?;
    let tokens = client.exchange_federated_token("si:scout", ci_token.expose()).await?;
    let session = client.with_token(tokens.access_token.expose());
    let slt = session.short_lived_token("notes").await?; // single use, 2 minutes
    // Send slt.slt.expose() to https://notes.example/api/silicon-login, as in step 2.
    Ok(())
}
```

The Silicon Accounts session ends with the job, and so does the app sign-in your backend gets
from that token: its `refresh_token_expires_at` is the end of the job's sign-in, and removing the
CI trust ends it at once (`membership.signed_out`, reason `session_revoked`). If the job is done
sooner, revoke the refresh token yourself; signing the job out doesn't end it
([details](ci-and-cloud.md#what-an-app-sign-in-from-ci-lasts)).

## What comes next

- **Keep the sign-in alive.** The access token lasts 30 minutes. Refresh it with the refresh
  token, which rotates on every use. Refresh one sign-in at a time: two refreshes with the same
  token count as theft and end the sign-in. See [tokens](tokens.md).
- **Know what you may read.** `profile` is always shared. Email, phone, date of birth and
  timezone are shared only when the Carbon agreed to them on the what's-shared screen. See
  [What your app sees about an account](../learn/what-apps-see.md).
- **Stay in sync.** Register a webhook to hear about id changes, profile changes, sign-outs,
  removed access and deleted accounts: [Receive webhooks](webhooks.md).
- **Bring your existing users.** [Import existing users](import-users.md) so they keep their
  place when they first sign in.

## Production checklist

| Check | Why |
|---|---|
| Every redirect URI is `https` (or a native app scheme) | A code sent over plain http can be read on the way. |
| You send `state` and compare it on the callback with a value bound to the browser (a cookie) | Without it, someone can make your user's browser finish *their* sign-in (login CSRF). We don't require `state`, but your app must. |
| You send `code_challenge` (S256) and the verifier on exchange | A stolen code is useless without the verifier. Once you send a challenge, the verifier is required. |
| The app secret lives only on your server | It is the only thing that lets someone exchange codes as your app. |
| Refresh tokens are stored server side and refreshed one at a time per sign-in | A refresh token works once; a second use revokes the whole sign-in. |
| You key users on `uuid` and handle `account.id_changed` | Ids can change, and the old id becomes free for someone else 10 days later. |
| You handle `error=access_denied` on the callback | The Carbon can decline the what's-shared screen. |
