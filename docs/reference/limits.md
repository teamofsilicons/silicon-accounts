---
title: Limits
description: Look up request limits, token lifetimes, file sizes and retention periods. Learn which response to expect when you reach a limit.
kind: informative
order: 71
related:
  - reference/api.md
  - reference/errors.md
  - learn/tokens-and-sessions.md
  - learn/security.md
---

# Limits

This page lists the limits Accounts enforces. Values marked **contract** are part of the product’s rules and apply to every deployment. Other limits protect the service and can be configured.

Too many requests return `429 rate_limited`. Too many incorrect codes or STKs return `423`. Both responses include `Retry-After` and `details.retry_after_seconds`, in seconds. Wait that long before trying again.

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
IP" means the client address (the right-most `X-Forwarded-For` entry behind the load balancer).

## Rate limits

| What | Limit | Counted per |
|---|---|---|
| Verification codes sent to one email or phone (sign-in, CLI, adding an address, requirements) | 10 per 10 minutes (**contract**) | address |
| Verification codes sent from one network | 30 per 10 minutes | IP |
| Adding an email or phone (`POST /v1/me/emails`, `/phones`), counted before any refusal | 20 per 10 minutes; 30 per 10 minutes | account; IP |
| Hosted sign-in flows started (`POST /v1/flows`) | 300 per minute | IP |
| CLI code sign-ins started (`POST /v1/cli/login/start`) | 60 per 10 minutes | IP |
| Device sign-ins started (`POST /v1/device/authorize`) | 60 per 10 minutes | IP |
| Connecting Google or Apple (`POST /v1/me/identities/{provider}`) | 30 per hour | account |
| Silicon sign-in attempts (`POST /v1/silicons/login`) | 60 per minute | IP |
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
| Access token | 30 minutes, 1800 seconds (**contract**) |
| Refresh token / sign-in | 900 days from the sign-in, not extended by refreshing (**contract**); every refresh rotates the token |
| Authorization code | 120 seconds, single use |
| Short-lived token (`slt_…`) | 120 seconds, single use, one app |
| Device code | 600 seconds; poll every 5 seconds (`slow_down` if faster) |
| Silicon custodian request (initial or transfer) | 14 days (**contract**: 2 weeks) |
| Id reservation after a change | 10 days (**contract**); the previous owner may take it back meanwhile |
| Proof token (`sap_…`) | 60–1800 seconds, default 1800 |
| Proof (its refresh token, `sapr_…`) | 900 days; a User verification proof ends with its sign-in |
| Idempotency results | 24 hours; 10 minutes for responses carrying a new secret; an unfinished request holds its key for at most 120 seconds |
| Webhook deliveries | retried for 72 hours after the event (or after a replay) |
| Discovery document and JWKS | cacheable for 5 minutes |
| App credentials | verified results are cached for 60 seconds per server |

## Sizes and counts

| What | Limit |
|---|---|
| Handle (after `c:` / `si:`) | 3–30 characters of `a-z 0-9 - _`, case-insensitive (**contract**); reserved words: `admin`, `administrator`, `root`, `system`, `support`, `help`, `security`, `silicon-accounts`, `account`, `silicon`, `silicons`, `carbon`, `carbons`, `api`, `www`, `mail`, `null`, `undefined`, `me`, `owner`, `staff` |
| uuid | `a-z A-Z 0-9`, case-sensitive; 3 characters, then 4 once every 3-character uuid is used (**contract**); never reused |
| App id | 2–40 characters of `a-z 0-9 -`, starting with a letter |
| Emails per Carbon / phones per Carbon | 10 / 10 (**contract**) |
| Display name | 1–100 characters, no control characters |
| Date of birth | in the past, not before 1900-01-01; a Silicon's is its creation date |
| STK | generated: `stk-` + 12 hex characters; chosen: `stk-` + 8 to 32 hex characters (**contract**) |
| URLs (photos, webhooks, …) | 2048 characters |
| `client_label` | 100 characters (longer ones are cut) |
| Profile photo | 2 MB (2,097,152 bytes); PNG, JPEG, WebP or GIF; 8192 px a side; 50 megapixels |
| Request body | 64 KB; photos 2 MB; `PATCH …/signin-config` 512 KB; imports 50 MB; Silicon Apps sync 5 MB |
| Time budget per request | 30 seconds; photo uploads and sync 60 seconds; imports 5 minutes (then 503 `request_timeout`) |
| Page size | 1–200, default 50 |
| `Idempotency-Key` | 1–200 visible ASCII characters |
| `X-Request-Id` kept from the client | 1–128 characters of `A-Z a-z 0-9 - _ . :` |
| Redirect URIs / allowed origins / allowed email domains per app | 50 / 50 / 100 |
| Branding | `logo_height` 16–96 px, `radius` 0–40 px, inline logos 128 KB each, text contrast at least 4.5:1, `copy.title` 80 and `copy.subtitle` 200 characters |
| Import | 100,000 rows; 200 columns; column names 200 bytes; values 8 KB; lists 50 items; 10 emails and 10 phones per row; `external_id` 255 characters; display names cut at 100 characters |
| Concurrent import parses | 2 per server; a request waits up to 30 seconds for a slot, then 503 `imports_busy` (`Retry-After: 15`) |
| Webhook replay | 100 deliveries per request |
| Proof scopes | 20 per proof, each 1–100 characters of `A-Z a-z 0-9 _ . : / -` |
| App verification receiving apps | exactly 1 per proof |
| Report message | 1–10,000 characters; `pr_url` https |
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

## Retention

A sweep every 10 minutes deletes, in batches: sign-in flows 1 day after they expired;
authorization codes, short-lived tokens and device codes 7 days after; verification codes 1 day
after; expired idempotency results; id reservations 1 day after they ended; sign-up sessions 7
days after they expired or were used; rate-limit windows older than a day. Proof tokens are
deleted 1 day after they expire, and every token of a proof 30 days after the proof ended.
History (sign-ins, id changes, custodian transfers, proofs, sign-in setup versions, the audit
log) is never deleted.
