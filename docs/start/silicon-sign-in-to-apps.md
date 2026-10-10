---
title: Sign a Silicon into an app
description: As a Silicon, sign into any app with a short-lived token. You keep your STK to yourself, and the app exchanges the token for its own session.
kind: instructive
order: 21
related:
  - learn/silicons-and-custodians.md
  - start/silicon-account.md
  - start/tokens.md
  - learn/tokens-and-sessions.md
  - learn/what-apps-see.md
  - reference/cli.md
---

# Sign a Silicon into an app

You as a Silicon sign into an app in two moves, through the CLI or the API. First you sign in to Silicon Accounts with your `si:id` and STK. Then you ask us for a short-lived token, an SLT, for the app you want to use.

You hand that token to the app, and the app exchanges it with us for access and refresh tokens, much like it exchanges the code from a Carbon’s browser sign-in. The app never receives your STK.

```sh
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin   # once; the CLI keeps the session
SLT=$(silicon-accounts login --app remind -q)                                 # slt_…: one app, one use, 2 minutes
curl -s -X POST https://remind.example/silicon-login \
  -H 'Content-Type: application/json' -d "{\"slt\":\"$SLT\"}"
```

How an app takes the token is up to the app (here it's remind's `POST /silicon-login`), and step 3
covers what to look for. The whole exchange looks like this:

```text
Silicon ── si:id + STK ───────────▶ Silicon Accounts   POST /v1/silicons/login          → first-party tokens
Silicon ── app_id ────────────────▶ Silicon Accounts   POST /v1/me/short-lived-tokens   → slt_…
Silicon ── slt_… ─────────────────▶ the app            however the app asks for it
the app ── slt_… + its app secret ▶ Silicon Accounts   POST /v1/oauth/token (grant_type …:slt) → the Silicon's tokens + account
          (or client_id alone, for an app's own tool with public_client on)
```

The app never sees your STK, and the token it gets works only for that app.
[Silicons and custodians](../learn/silicons-and-custodians.md#why-silicons-sign-in-with-short-lived-tokens)
explains why we built the flow this way.

## 1. Sign in

Give the CLI your si:id and STK. Pass the STK on stdin, so it never shows up in a process list or
your shell history:

```sh
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin
```

```text
Signed in as si:scout (Scout), a Silicon.
uuid          4143123f-b494-481c-adbf-c14b14cfccc0
url           https://accounts.teamofsilicons.com
access token  2026-10-07T03:01:30Z (in 29m) (refreshed automatically)
session ends  2029-03-25T02:31:29Z (in 899d)
```

There are other ways to pass your credentials:

- `ACCOUNTS_SILICON=si:scout ACCOUNTS_STK=stk-… silicon-accounts login`, for an environment that injects
  secrets as variables (in CI, skip the stored STK: a trust lets the job sign in with its own token,
  see [Run a Silicon in CI and the cloud](ci-and-cloud.md));
- `silicon-accounts login --silicon si:scout` in a terminal prompts for the STK without echoing it;
- `--stk <value>` works, but the CLI warns you, because arguments are visible to every process on
  the machine.

The CLI stores the session in `{home}/.accounts/session.json` (mode 0600). The access token lasts 30
minutes, and the CLI refreshes it on its own when less than a minute is left. The session itself
ends 900 days after you signed in, however often it is refreshed. A CLI home holds one session.
Signing in as another account there signs the previous one out, and running `silicon-accounts login`
again while you're signed in answers `Already signed in as si:scout` (add `--force` to sign in anyway).

Check the session from a script:

```sh
silicon-accounts login status --json
```

```json
{
  "authenticated": true,
  "display_name": "Scout",
  "expires_at": "2026-10-07T03:01:30.006Z",
  "id": "si:scout",
  "kind": "silicon",
  "refresh_expires_at": "2029-03-25T02:31:29.998Z",
  "url": "https://accounts.teamofsilicons.com",
  "uuid": "4143123f-b494-481c-adbf-c14b14cfccc0",
  "verified": true
}
```

With `--json` it always exits `0`, so read `authenticated` (`{"authenticated":false}` when you're not signed in); without `--json` it exits `1` when you're not signed in. `verified`
says whether we confirmed the session just now; `--offline` reads only the stored file.

### Over HTTP

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/silicons/login \
  -H 'Content-Type: application/json' \
  -d '{"id":"si:scout","stk":"stk-59e5f08f3bbe","client_label":"scout on build-box"}'
```

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRldi0xIn0.eyJpc3MiOi…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_peF7apNSIlunmOgn_5eeR3naY_mVAs1_FBGNSOoAkvU",
  "refresh_token_expires_at": "2029-03-25T02:35:39.401Z",
  "scope": "profile",
  "membership_id": "silicon-accounts:4143123f-b494-481c-adbf-c14b14cfccc0",
  "account": {
    "uuid": "4143123f-b494-481c-adbf-c14b14cfccc0",
    "membership_id": "silicon-accounts:4143123f-b494-481c-adbf-c14b14cfccc0",
    "kind": "silicon",
    "id": "si:scout",
    "display_name": "Scout",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=4143123f-b494-481c-adbf-c14b14cfccc0",
    "custodian": {
      "uuid": "6667d4b4-7c57-45de-b2c3-94185db3e175",
      "id": "c:saket"
    },
    "updated_at": "2026-10-07T02:35:33.741Z",
    "version": 2
  }
}
```

These are first-party tokens (audience `silicon-accounts`). They act on your own account; they are
not for apps. `client_label` (up to 100 characters) names this sign-in in `silicon-accounts sessions list`.

Refresh the access token before it expires, and store the new refresh token every time:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=refresh_token -d client_id=silicon-accounts -d "refresh_token=$REFRESH_TOKEN"
```

Refresh tokens rotate on every use. If you present one that was already used, we revoke the whole
sign-in, because only a stolen copy would ever be presented twice:

```json
{"error":"invalid_grant","error_description":"This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in to protect the account, so this sign-in is now revoked; sign in again."}
```

### In Rust

Here's signing in and getting a short-lived token (step 2) with the
[`silicon-accounts-client`](../reference/rust-client.md) package:

```rust
use silicon_accounts_client::AccountsClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;
    let si_id = std::env::var("ACCOUNTS_SILICON")?; // si:scout
    let stk = std::env::var("ACCOUNTS_STK")?; // stk-…

    let tokens = match client.silicon_login(&si_id, &stk, Some("scout on build-box")).await {
        Ok(tokens) => tokens,
        Err(err) if err.is_code("custodian_pending") => {
            eprintln!("{err}"); // message and hint: who has to accept, and until when
            return Ok(());
        }
        Err(err) => return Err(err.into()),
    };

    // A token for one app: single use, 2 minutes. Print it for the app.
    let session = client.with_token(tokens.access_token.expose());
    let slt = session.short_lived_token("remind").await?;
    println!("{}", slt.slt.expose());

    // Before the access token expires (30 minutes), rotate the pair; keep the new refresh token.
    if let Some(refresh) = &tokens.refresh_token {
        let renewed = client.refresh_first_party(refresh.expose()).await?;
        eprintln!("refreshed; access token valid for {} s", renewed.expires_in);
    }
    Ok(())
}
```

### When signing in fails

| code | status | CLI exit | why | what to do |
|---|---|---|---|---|
| `invalid_credentials` | 401 | 3 | no Silicon has this si:id, or the STK is wrong; both get the same answer so ids can't be probed | check both; use the current si:id (ids can change); a lost STK is replaced by your custodian |
| `login_locked` | 423 | 6 | 10 wrong STKs in a row; sign-in is locked for 60 seconds, and during the lock even the right STK is refused | wait `details.retry_after_seconds` (also in `Retry-After`) |
| `custodian_pending` | 403 | 3 | your custodian hasn't accepted yet; `details` has the request id, its expiry and the custodian | wait, or poll the request ([Get a Silicon account](silicon-account.md#2-wait-for-the-answer)) |
| `custodian_declined`, `custodian_expired` | 403 | 3 | the account was released and never became active | create it again, naming a Carbon who will accept |
| `account_deleted` | 403 | 3 | the account was deleted by its custodian | ask your former custodian, or get a new account |
| `invalid_stk` | 422 | 2 | not `stk-` plus 8 to 32 hex characters | send the STK exactly as it was shown |
| `invalid_id` | 422 | 2 | not an si:id (a `c:` id, a typo) | Carbons sign in with `silicon-accounts login` instead |
| `rate_limited` | 429 | 6 | more than 60 Silicon sign-in attempts per minute from your network | wait `details.retry_after_seconds` |

The tenth wrong STK in a row is itself answered with `login_locked`, and a correct sign-in resets
the count. The CLI checks the STK's format before sending it, so a malformed STK fails right there
on your machine with exit code `2`.

## 2. Get a short-lived token

```sh
silicon-accounts login --app remind
```

```text
Short-lived token for remind as si:scout: single use, valid until 2026-10-07T02:33:45Z (in 1m). The app exchanges it with grant_type=urn:silicon:params:oauth:grant-type:slt.
slt_vcB-NXP89QQd386p0r0BTGcO6pC5tudXjLNuf6nBIpQ
```

The token goes to stdout and the explanation to stderr, so `SLT=$(silicon-accounts login --app remind -q)`
captures just the token. With `--json`:

```json
{
  "app_id": "remind",
  "expires_at": "2026-10-07T02:33:45.489Z",
  "slt": "slt_wc7V6A5o6pskrp0KYbZknpmBc2w6rmfjcgVzPYvmK7g"
}
```

Not signed in yet? Do both in one command:

```sh
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin --app remind -q
```

Over HTTP, with your first-party access token:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/me/short-lived-tokens \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"app_id":"remind"}'
```

`201 Created`:

```json
{"app_id":"remind","expires_at":"2026-10-07T02:37:46.761Z","scope":"profile timezone","slt":"slt_cO2a3ENrXHZBq36SkLVBtAuQMINeLP4k2xM93ur-2HE"}
```

In Rust it's `client.with_token(access_token).short_lived_token("remind").await?`, as in the program
[above](#in-rust).

What you should know about the token:

- **Single use.** The first exchange uses it up, whether it succeeds or not.
- **Valid for 120 seconds.** Ask for it right before you hand it over.
- **Bound to one app.** If any other app presents it, it's refused and used up.
- **Already scoped.** `scope` is what the app will see: always `profile`, plus `timezone` and
  `dob` when the app's sign-in setup asks for them. Silicons have no email or phone, so an app that
  requires an email still lets you in; it just never receives one.

| code | status | why |
|---|---|---|
| `unknown_app` | 404 | no app has this `app_id` |
| `app_disabled` | 403 | the app exists but is disabled in Silicon Apps |
| `first_party_app` | 422 | `silicon-accounts` is Silicon Accounts itself, which you are already signed in to |
| `not_signed_in`, `session_ended` | (CLI) | no session in this home, or it ended (signed out, revoked, STK rotated): sign in again |

## 3. Hand it to the app

The app tells you how to deliver the token: an HTTP endpoint like `POST /silicon-login`, a header,
or a field in its own CLI. An app's CLI usually forwards the token to the app's server, which
exchanges it with the app's secret; an app that turned on `public_client` lets its own CLI
exchange it directly. For those two minutes, treat the token like a password. Send it over
https only and never log it. If the app reports a failure, get a new token, because a used, expired
or refused token can't be retried.

## 4. Exchange the token (for apps)

This part is for your app. When a Silicon hands you an SLT, exchange it at our token endpoint with
your app's own credentials, on your server. If your app is a command-line or desktop tool with no
server, turn on `public_client` in its sign-in setup and exchange the SLT with your `client_id`
alone, no secret; we record that sign-in with the method `slt_public_client`. Every other app sends
its secret ([CLI plus backend](add-sign-in.md#cli-plus-backend) shows both).


```sh
curl -s -u "remind:$REMIND_APP_SECRET" https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
```

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImRldi0xIn0.eyJpc3MiOi…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_lpYj7WW7VfC0xv2yCQxmbQwQ_OJ05-dNVn6OYZc7vNw",
  "refresh_token_expires_at": "2029-03-25T02:31:52.745Z",
  "scope": "profile timezone",
  "membership_id": "remind:4143123f-b494-481c-adbf-c14b14cfccc0",
  "account": {
    "uuid": "4143123f-b494-481c-adbf-c14b14cfccc0",
    "membership_id": "remind:4143123f-b494-481c-adbf-c14b14cfccc0",
    "kind": "silicon",
    "id": "si:scout",
    "display_name": "Scout",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=4143123f-b494-481c-adbf-c14b14cfccc0",
    "timezone": "Europe/Berlin",
    "custodian": {
      "uuid": "6667d4b4-7c57-45de-b2c3-94185db3e175",
      "id": "c:saket"
    },
    "updated_at": "2026-10-07T02:31:16.356Z",
    "version": 2
  }
}
```

We also accept `grant_type=slt` as a short alias. Your app's credentials go in HTTP Basic auth (or
as `client_id` and `client_secret` form fields). The access token is an EdDSA-signed JWT made for
your app:

```json
{
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "4143123f-b494-481c-adbf-c14b14cfccc0",
  "aud": "remind",
  "exp": 1791342112,
  "iat": 1791340312,
  "nbf": 1791340312,
  "jti": "01a11433-f8ac-7323-8be0-9d164ab50069",
  "kind": "silicon",
  "id": "si:scout",
  "mid": "remind:4143123f-b494-481c-adbf-c14b14cfccc0",
  "fid": "01a11433-f8ac-7323-8be0-9d1521cfde01",
  "scope": "profile timezone"
}
```

Key your records on `account.uuid` (or `membership_id`), never on `account.id`. The si:id can
change, and the uuid never does ([Ids and uuids](../learn/ids-and-uuids.md)). A Silicon's `custodian`
is always there, and `email` and `phone` never are. [What apps see](../learn/what-apps-see.md) covers
every field and scope.

Here's the app's `POST /silicon-login` in TypeScript (Node 22 or later):

```ts
const ACCOUNTS_URL = process.env.ACCOUNTS_URL ?? 'https://accounts.teamofsilicons.com';

// POST /silicon-login {"slt": "slt_…"}: exchange it and start this app's own session.
export async function exchangeSlt(slt: string) {
  const res = await fetch(`${ACCOUNTS_URL}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.APP_ID}:${process.env.APP_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'urn:silicon:params:oauth:grant-type:slt', slt }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.error}: ${body.error_description}`); // e.g. invalid_grant: …already used…
  return body as {
    access_token: string; refresh_token: string; expires_in: number; scope: string;
    account: { uuid: string; membership_id: string; kind: 'carbon' | 'silicon'; id: string;
               display_name: string; timezone?: string; custodian?: { uuid: string; id: string } };
  };
}
```

In Rust:

```rust
use silicon_accounts_client::AccountsClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let slt = std::env::args().nth(1).ok_or("usage: exchange <slt_…>")?;
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;
    let app = client.as_app("remind", std::env::var("APP_SECRET")?);

    let tokens = app.exchange_slt(&slt).await?;
    let account = tokens.account.expect("token responses carry the account");
    println!("{} signed in as {} (membership {})", account.id, account.uuid, account.membership_id);
    Ok(())
}
```

From the command line, for testing:

```sh
printf '%s' "$REMIND_APP_SECRET" | silicon-accounts app --app-id remind --app-secret-stdin token slt "$SLT"
```

A successful exchange is a sign-in. The Silicon joins your app's user base (source `slt`), and your
app gets a refresh token valid for 900 days from that moment. When the Silicon got the token from a
CI job's sign-in, your app's sign-in ends when that CI sign-in does (`refresh_token_expires_at`
says when, refreshing never moves it, and near it so does the access token's `exp`), and removing
the CI trust ends it with a `membership.signed_out` of reason `session_revoked`. Signing the CI
sign-in out doesn't end it
([CI and the cloud](ci-and-cloud.md#what-an-app-sign-in-from-ci-lasts)). Every refused exchange answers
`400 invalid_grant` with the exact reason, and still uses the token up:

| `error_description` starts with | why |
|---|---|
| `The short-lived token was already used` | it was exchanged before |
| `The short-lived token expired at …` | more than 120 seconds passed |
| `The short-lived token was issued for the app 'remind', not for 'briefcase'` | another app presented it |
| `The short-lived token is not known` | mistyped, or never issued |
| `slt must be a short-lived token (it starts with slt_), but this is a refresh token.` | the wrong kind of token |
| `The short-lived token was issued at … by a sign-in of si:rusty that ended when its custodian rotated its STK at …` | the STK was rotated after the token was issued |
| `The short-lived token was issued by a sign-in of si:rusty from a trusted outside token, and that sign-in ended at …` | it came from a CI sign-in that has reached the end it was given |
| `The short-lived token was issued by a sign-in of si:rusty from a trusted outside token, and its custodian or the Silicon removed that trust …` | it came from a CI sign-in whose trust was removed |

Wrong app credentials answer `401 invalid_client`, and a missing `slt` answers `400 invalid_request`.
A `client_id` without a secret answers `400 unauthorized_client` unless your app turned on
`public_client`.
An SLT issued before the Silicon removed your app's access is refused too. One issued after that is
a new sign-in, and it restores the access.

## Keep the sign-in, or end it

**The app keeps its own session.** It refreshes with its refresh token (which rotates, as above)
and listens on its webhook for changes: `account.id_changed` when the si:id changes,
`account.updated` when a field it can see changes, `silicon.custodian_changed` after a transfer,
and `membership.signed_out` or `membership.access_removed` when the sign-in ends. See
[Receive webhooks](webhooks.md).

**Rotating an STK ends the Silicon’s sign-ins.** Its CLI session answers `session_ended`, its refresh tokens stop working, and introspection reports its tokens as inactive. Each app gets `membership.signed_out` with `reason: stk_rotated`. The Silicon has to sign in again with the new STK and get another SLT.

One catch: a local signature check can't see that a session has ended. An existing access token can still pass a check against the JWKS until it expires, up to 30 minutes later. If your app needs to cut access off immediately, use introspection or handle the sign-out webhook.

**The Silicon can see and leave the apps it signed into:**

```sh
silicon-accounts apps list
```

```text
APP     NAME    STATUS  SHARED            LAST SIGN-IN
remind  Remind  active  profile timezone  2026-10-07T02:43:20Z
```

`silicon-accounts apps remove remind` revokes the app's tokens for you and the User verification proofs it issued about
you, marks the membership `access_removed`, and tells the app (`membership.access_removed`). If you
exchange a new SLT there later, the membership is `active` again.

## Run several Silicons on one machine

Give each Silicon its own CLI home, so their sessions don't replace each other:

```sh
SILICON_HOME=/srv/silicons/scout  silicon-accounts login --app remind -q
SILICON_HOME=/srv/silicons/ledger silicon-accounts login --app remind -q
```

Many processes can share one home. The CLI refreshes the session under a file lock, so two
processes never present the same refresh token (which would end the session). The details are in
[Use the silicon-accounts CLI](cli.md#give-every-silicon-its-own-home).

## Next

- [Get a Silicon account](silicon-account.md), if you don't have one yet.
- [Exchange codes and refresh tokens](tokens.md) and
  [Tokens and sessions](../learn/tokens-and-sessions.md), for the app side in depth.
- [CLI reference](../reference/cli.md#silicon-accounts-login), for every `silicon-accounts login` option.
