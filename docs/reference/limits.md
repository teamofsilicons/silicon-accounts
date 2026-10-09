---
title: Limits
description: Every limit we enforce, from request rates and lockouts to lifetimes, sizes and retention, and what you get back when you reach one.
kind: informative
order: 71
related:
  - reference/api.md
  - reference/errors.md
  - learn/tokens-and-sessions.md
  - learn/security.md
---

# Limits

These are the limits we enforce. Values marked **contract** are part of the product's rules and hold on every deployment. The others protect the service and can be configured.

Too many requests get `429 rate_limited`. Too many wrong codes or STKs get `423`. Both come with `Retry-After` and `details.retry_after_seconds`, in seconds: wait that long, then try again.

```sh
curl -s "$ACCOUNTS_URL/v1/ids/available?id=c:probe"   # the 121st check in one minute from one IP:
```

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many id availability checks from this network: the limit is 120 per minute.",
    "hint": "Wait 57 seconds before trying again.",
    "details": { "retry_after_seconds": 57 }
  }
}
```

Rate limits are fixed windows counted in the database, so they hold across every server. "Per
IP" means the client's address (the right-most `X-Forwarded-For` entry behind the load balancer).
Everything behind one address shares one budget, so a fleet of runners behind one address should
sign in once per job and reuse the session, not sign in once per command.

## Rate limits

| What | Limit | Counted per |
|---|---|---|
| Verification codes sent to one email or phone (sign-in, CLI, adding an address, requirements) | 10 per 10 minutes (**contract**) | address |
| Verification codes sent from one network | 30 per 10 minutes | IP |
| Adding an email or phone (`POST /v1/me/emails`, `/phones`), counted before any refusal | 20 per 10 minutes; 30 per 10 minutes | account; IP |
| Hosted sign-in flows started (`POST /v1/flows`) | 300 per minute | IP |
| CLI code sign-ins started (`POST /v1/cli/login/start`) | 60 per 10 minutes | IP |
| Device sign-ins started (`POST /v1/device/authorize`) | 60 per 10 minutes; 600 per 10 minutes for one app's tools | IP; app |
| Device codes looked up, approved or denied (`/v1/device/{user_code}…`) | 60 per 10 minutes | Carbon |
| Connecting Google or Apple (`POST /v1/me/identities/{provider}`) | 30 per hour | account |
| Silicon sign-in attempts (`POST /v1/silicons/login`, and `grant_type=…:jwt-bearer` at `POST /v1/oauth/token`, counted together) | 60 per minute | IP |
| Token exchanges with an outside OIDC token (`grant_type=…:token-exchange`) | 60 per minute | IP |
| Identity tokens (`POST /v1/me/identity-tokens`) | 60 per minute | Silicon |
| Silicon self-creations (`POST /v1/silicons`) | 10 successful per hour, and 60 attempts of any outcome per hour | IP |
| Self-created Silicons waiting for one custodian | 20 pending | c:id or email |
| Transfer requests | 30 per hour | custodian |
| Silicon webhook test pings | 10 per hour | Silicon |
| Id availability checks (`GET /v1/ids/available`) | 120 per minute | IP |
| Account lookups (`/v1/accounts/{uuid}` and `/by-id/{id}` together) | 600 per minute | app or account |
| Id changes (own, or a custodian's for its Silicon; reclaims included) | 5 per rolling 24 hours | account |
| Photo uploads | 20 per hour; 20 per hour | account; sign-up |
| Imports | 60 requests per hour (dry runs and refused files count); 2,000,000 rows per 24 hours | app |
| Bug reports (`POST /v1/reports`) | 5 per hour | IP |
| Telemetry (`POST /v1/telemetry/events`) | 120 requests per minute | IP |

## Lockouts

| What | Lock |
|---|---|
| 10 wrong verification codes in a row for one address (any flow, the CLI, the account site) | every code to that address is refused for 60 seconds (**contract**: 1 minute): 423 `verification_locked`. A right code ends the streak; a resend keeps it |
| 10 wrong STKs in a row for one Silicon | its sign-in is refused for 60 seconds: 423 `login_locked` |

## Lifetimes

| What | Lifetime |
|---|---|
| Verification code (6 digits) | 10 minutes (**contract**); a resend replaces it. `resend_available_at` suggests waiting 30 seconds |
| Hosted sign-in flow (and its `sa_flow` cookie) | 60 minutes |
| Sign-up session (`sa_signup`) | 48 hours (**contract**) |
| Browser session (`sa_session`) | 900 days |
| Access token | 30 minutes, 1800 seconds (**contract**), and never past the end of its sign-in: in a sign-in's last 30 minutes, `expires_in` is shorter (a 30-minute CI sign-in may answer 1799) |
| Refresh token / sign-in | 900 days from the sign-in, not extended by refreshing (**contract**); every refresh rotates the token. Shorter for a sign-in from a trusted outside token and for app sign-ins made from its short-lived tokens (below) |
| Authorization code | 120 seconds, single use |
| Short-lived token (`slt_…`) | 120 seconds, single use, one app |
| Sign-in from a trusted outside token (token exchange) | until the outside token expires: at least 30 minutes, at most 12 hours; refresh tokens rotate within it. An app sign-in from a short-lived token minted in it ends no later than it does, and refreshing never moves that end; signing the CI sign-in out early doesn't shorten it, but removing the trust ends it |
| Identity token | 60 to 3600 seconds, default 300 |
| A trusted issuer's keys (JWKS) | cached for 10 minutes; fetched again for an unknown `kid`, at most every 30 seconds per issuer |
| Device code | 600 seconds; poll every 5 seconds (`slow_down` if faster) |
| Silicon custodian request (initial or transfer) | 14 days (**contract**: 2 weeks) |
| Id reservation after a change | 10 days (**contract**); the previous owner may take it back meanwhile |
| Proof token (`sap_…`) | 60 to 1800 seconds, default 1800 |
| Proof (its refresh token, `sapr_…`) | 900 days; a User verification proof ends with its sign-in |
| Idempotency results | 24 hours; 10 minutes for responses carrying a new secret; an unfinished request holds its key for at most 120 seconds |
| Webhook deliveries | retried for 72 hours after the event (or after a replay) |
| Discovery document and JWKS | cacheable for 5 minutes |
| App credentials | verified results are cached for 60 seconds per server |

## Sizes and counts

| What | Limit |
|---|---|
| Handle (after `c:` / `si:`) | 3 to 30 characters of `a-z 0-9 - _`, case-insensitive (**contract**); reserved words: `admin`, `administrator`, `root`, `system`, `support`, `help`, `security`, `silicon-accounts`, `account`, `silicon`, `silicons`, `carbon`, `carbons`, `api`, `www`, `mail`, `null`, `undefined`, `me`, `owner`, `staff` |
| uuid | `a-z A-Z 0-9`, case-sensitive; 3 characters, then 4 once every 3-character uuid is used (**contract**); never reused |
| App id | 3 to 30 characters of `a-z 0-9 - _`, as Silicon Apps creates them (`my_app`, `2fa-tool`); older ids of 2 to 40 characters of `a-z 0-9 -` starting with a letter (`dm`) keep working |
| Emails per Carbon / phones per Carbon | 10 / 10 (**contract**) |
| Display name | 1 to 100 characters, no control characters |
| Date of birth | in the past, not before 1900-01-01; a Silicon's is its creation date |
| STK | generated: `stk-` + 12 hex characters; chosen: `stk-` + 8 to 32 hex characters (**contract**) |
| URLs (photos, webhooks, …) | 2048 characters |
| `client_label` | 100 characters (longer ones are cut) |
| Profile photo | 2 MB (2,097,152 bytes); PNG, JPEG, WebP or GIF; 8192 px a side; 50 megapixels |
| Request body | 64 KB; photos 2 MB; `PATCH …/signin-config` 512 KB; imports 50 MB; Silicon Apps sync 5 MB |
| Time budget per request | 30 seconds; photo uploads and sync 60 seconds; imports 5 minutes (then 503 `request_timeout`) |
| Page size | 1 to 200, default 50 |
| `Idempotency-Key` | 1 to 200 visible ASCII characters, optional (Silicon Apps requires 8 to 200 on every change) |
| `X-Request-Id` kept from the client | 1 to 128 characters of `A-Z a-z 0-9 - _ . :` |
| Redirect URIs / allowed origins / allowed email domains per app | 50 / 50 / 100 |
| Branding | `logo_height` 16 to 96 px, `radius` 0 to 40 px, inline logos 128 KB each, text contrast at least 4.5:1, `copy.title` 80 and `copy.subtitle` 200 characters |
| Import | 100,000 rows; 200 columns; column names 200 bytes; values 8 KB; lists 50 items; 10 emails and 10 phones per row; `external_id` 255 characters; display names cut at 100 characters |
| Concurrent import parses | 2 per server; a request waits up to 30 seconds for a slot, then 503 `imports_busy` (`Retry-After: 15`) |
| Webhook replay | 100 deliveries per request |
| Proof scopes | 20 per proof, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -` |
| App verification receiving apps | exactly 1 per proof |
| Report message | 1 to 10,000 characters; `pr_url` https |
| Telemetry batch | 50 events; `name` `^[a-z0-9_.]{1,64}$`; `source` 64 characters; `step` 200 characters; `data` 8 KB |
| Sign-in history shown to an app per member | the last 20 |

## Webhooks and messages

| What | Value |
|---|---|
| Answer time for a delivery | 10 seconds; a 2xx in time is success |
| Retry schedule | 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, then hourly |
| Give up | 72 hours after the event (or after a replay): `failed`, replayable |
| Redirects | not followed |
| Signature timestamp tolerance (Rust client default) | 5 minutes |
| Email and SMS sending | at most 8 attempts; a code's message stops retrying once the code expired |

## Silicon keys

| What | Value |
|---|---|
| Live keys per Silicon | 10 |
| Assertion lifetime (`exp - iat`) | at most 300 seconds (30 seconds of clock skew allowed) |
| Assertion `jti` | 1 to 200 characters, each used once |
| Key name | at most 100 characters |

## Trust relationships and identity tokens

| What | Value |
|---|---|
| Live trusts per Silicon | 20 |
| Conditions per trust | 1 to 10 |
| Condition claim name / value | 1 to 100 characters of `a-z A-Z 0-9 _ - . : /` / 1 to 500 characters |
| Issuer / audience of a trust | 300 / 400 characters |
| Trust name | at most 100 characters |
| Outside token | 16 KB |
| Clock skew on an outside token's `exp`, `nbf`, `iat` | 30 seconds |
| Fetching an issuer's discovery document or JWKS | https, 5 seconds to connect, 10 seconds in all, 256 KB, no redirects |
| Identity token audiences per Silicon | 0 to 20 (none until the custodian allows one), each at most 400 characters |
| Identity token signing key | RSA 2048, RS256 |

## Event streams

| What | Value |
|---|---|
| Open streams (`GET /v1/events/stream`) | 5 per app or account on each API server (counted in that server's memory); 500 per server (429 `too_many_streams` / 503 `stream_capacity_reached`, with `Retry-After`). Silicon Apps' streams differ: 10 per token or session, 30 minutes each |
| How often a stream looks for new events | every second, at most 100 events per read |
| Heartbeat (`: heartbeat`) | after 15 seconds without events |
| Reconnect delay told to clients (`retry:`) | 5 seconds |
| Credentials checked again | every 30 seconds |
| Longest stream | 1 hour, then `stream.closed` with `max_duration`: reconnect with `Last-Event-ID` |
| Event types in `?types=` | at most 20 |
| Subscriptions per app | one webhook and one stream |

## Retention

Every 10 minutes a sweep deletes, in batches:

- sign-in flows, 1 day after they expired;
- authorization codes, short-lived tokens and device codes, 7 days after they expired;
- verification codes, 1 day after they expired;
- expired idempotency results;
- id reservations, 1 day after they ended;
- sign-up sessions, 7 days after they expired or were used;
- used `jti`s of Silicon key assertions and of outside tokens, once they expired;
- rate-limit windows older than a day.

Proof tokens are deleted 1 day after they expire, and every token of a proof 30 days after the
proof ended.

History is never deleted: sign-ins, id changes, custodian transfers, proofs, sign-in setup
versions and the audit log stay for good.
