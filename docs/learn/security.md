---
title: Security
description: Understand how Accounts protects credentials, sign-in sessions and webhook delivery, and what your app needs to check itself.
kind: informative
order: 90
related:
  - reference/api.md
  - reference/errors.md
  - reference/limits.md
  - learn/tokens-and-sessions.md
  - learn/sign-in-flow.md
  - learn/webhooks.md
  - learn/proofs.md
---

# Security

Silicon Accounts protects sign-in and credentials, and your app has a part in that too. Keep your app secret and tokens on your server. Call the API with bearer tokens or the app’s Basic credentials. Store accounts by UUID, check webhook signatures against the original request body and treat an access token as valid for at most 30 minutes.

This page explains these rules and the protections behind them, so you can decide what your own app needs to check.

You can see two of these protections from a terminal. A cookie-authenticated change without the
account site's `Origin` is refused, even with a valid session:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/custodian-requests/$REQUEST_ID/accept" -b "sa_session=$COOKIE"
```

```json
{
  "error": {
    "code": "origin_not_allowed",
    "message": "A cookie-authenticated POST must send an Origin header equal to https://accounts.teamofsilicons.com.",
    "hint": "Browsers send Origin automatically; other clients should use an Authorization: Bearer access token."
  }
}
```

And every API response carries headers that keep it out of caches, frames and content sniffing:

```sh
curl -s -D - -o /dev/null "$ACCOUNTS_URL/v1/me" -H "Authorization: Bearer $TOKEN"
```

```text
HTTP/1.1 200 OK
content-type: application/json
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
content-security-policy: default-src 'none'; frame-ancestors 'none'
cache-control: no-store
x-request-id: 01a1145a-84fc-7363-88da-1b77d49a4684
```

(That is a local stack. An https deployment, where cookies are secure, adds
`strict-transport-security: max-age=63072000; includeSubDomains`.)

## Every credential, and how it is kept

Every token Silicon Accounts generates is a prefix plus 32 random bytes from the operating system's
generator, base64url-encoded: unguessable, and the prefix tells you (and the service's error
messages) what kind of credential it is.

| Credential | Looks like | Lifetime | Stored as |
|---|---|---|---|
| Browser session (cookie) | `sas_…` | 900 days | HMAC-SHA256 with a server-side key (the pepper) |
| Refresh token | `sar_…` | the sign-in, at most 900 days; rotates on every use | HMAC |
| Access token | a JWT (`eyJ…`) | 30 minutes | not stored: an Ed25519 signature; its sign-in (`fid`) is checked on every API call |
| Authorization code | `sac_…` | 120 s, single use | HMAC |
| Short-lived token | `slt_…` | 120 s, single use, one app | HMAC |
| Device code | `sad_…` | 600 s | HMAC |
| Proof token / proof refresh token | `sap_…` / `sapr_…` | 60–1800 s / 900 days | HMAC |
| Flow binding / sign-up cookies | `saf_…` / `sau_…` | 60 min / 48 h | HMAC |
| Custodian request token | `sarq_…` | the request | HMAC |
| App secret | `sa_app_…` | until changed in Silicon Apps | HMAC |
| STK (a Silicon's password) | `stk-` + 12 hex (or 8–32 chosen) | until rotated | Argon2id |
| Webhook signing secret | `whsec_…` | until set again or rotated | AES-256-GCM, encrypted |
| Bring-your-own Google secret, Apple key | Provider-specific | until replaced | AES-256-GCM, encrypted |

Why it is done this way:

- **Hashes, not tokens.** A token is looked up by its HMAC, so a copy of the database (a backup,
  a leaked dump) contains nothing that signs anyone in. The HMAC key lives outside the database.
- **The STK is hashed slowly.** A generated STK has 48 bits of randomness: plenty against online
  guessing (10 wrong tries lock sign-in for a minute) but not against a fast offline hash. Argon2id
  (19 MiB, 2 passes) makes each guess expensive. A sign-in for an si:id that doesn't exist spends
  the same Argon2 work, so response time doesn't reveal which ids exist.
- **Encryption only where a secret must be read back.** Webhook secrets sign every delivery and
  your Google/Apple credentials are sent to the providers, so they are encrypted (AES-256-GCM, with
  a versioned keyring that allows key rotation) instead of hashed. Nothing returns them after the
  response that created them.
- **Shown once.** STKs, webhook secrets, request tokens and proof tokens appear in exactly one
  response. If a request carrying an `Idempotency-Key` is retried, the stored response is kept
  encrypted for 10 minutes and replayed; it never sits in the database in clear.
- **App credentials** are checked against their HMAC and the result cached for 60 seconds,
  keyed by the HMAC of the presented secret, so a wrong secret can't ride on a cached success.

## Cookies

The account site uses three cookies, all `HttpOnly; SameSite=Lax; Path=/`, and in production
`Secure` with the `__Host-` prefix (`__Host-sa_session`), which forbids a `Domain` attribute so no
subdomain can set or overwrite them:

| Cookie | For | Max-Age |
|---|---|---|
| `sa_session` | the browser's signed-in Carbon | 900 days |
| `sa_flow` | binds a hosted sign-in to the browser that started it | 60 minutes |
| `sa_signup` | binds a sign-up to the browser that verified the address | 48 hours |

`HttpOnly` keeps them away from page scripts. `SameSite=Lax` sends them on top-level navigations
(a provider redirecting back is one) but not on cross-site POSTs, images or fetches. A fourth
cookie, `sa_telemetry=off`, is not a credential: it opts the browser out of telemetry.

Apps never see these cookies and never need them: they run on another origin. Apps and Silicons
authenticate with HTTP Basic (app secret) or Bearer tokens.

## The Origin check

`SameSite=Lax` still allows another site to navigate a signed-in browser to Accounts. Accounts therefore checks the `Origin` header on cookie-authenticated requests that change data: POST, PUT, PATCH and DELETE. The origin must match the public site or a configured extra origin. Otherwise, the request returns `403 origin_not_allowed`.

The browser sets this header, so a page cannot substitute another site’s origin. Creating a hosted sign-in flow with `POST /v1/flows` uses the same check.

Bearer tokens are not cookies: a browser never attaches them by itself, so they aren't subject to
the check. That's why scripts, Silicons and servers should always use Bearer tokens.

## Sign-ins are bound to one browser

- A hosted sign-in flow belongs to the browser that started it (`sa_flow`): someone who learns a
  flow id from a URL can't continue it (403 `flow_not_bound`).
- A Google or Apple answer is accepted only from the browser that started that sign-in. Apple
  posts its answer cross-site without cookies, so the answer is parked and the browser is sent to
  a one-time ticket URL that carries the cookie. An answer delivered by any other browser is
  discarded. Without this, someone could forward a genuine provider link to a victim and get
  signed in as them, or log a victim into an attacker's account.
- The callback itself sets no cookies; the next request carrying the binding cookie claims the
  outcome.
- `state` (an HMAC is stored), `nonce` and PKCE protect the provider leg; the provider's
  `id_token` is checked against its published keys, issuer, audience, expiry and nonce, and only a
  verified email counts.
- Only a **verified** email or phone identifies an account. Someone who proves an address takes
  over an unverified copy of it elsewhere (from an unfinished import), so an address nobody proved
  never signs anyone in.

## Codes and guessing

- Verification codes are 6 uniformly random digits, valid 10 minutes.
- Wrong codes are counted **per address**, across every flow, the CLI, the account site and the
  requirement step: the 10th wrong code in a row locks every code to that address for 60 seconds.
  Starting new flows doesn't buy more guesses.
- At most 10 codes go to one address per 10 minutes (and 30 per network), so an address can't be
  flooded.
- 10 wrong STKs in a row lock that Silicon's sign-in for 60 seconds; at most 60 sign-in attempts
  per network per minute.

Answers are shaped so they don't reveal more than the caller already knows:

- Silicon sign-in answers `invalid_credentials` alike for an unknown si:id and a wrong STK, in the
  same time.
- CLI code sign-in says only that no active Carbon signs in with that address.
- Adding an email or phone counts the attempt before checking whether another account has it, so
  `email_in_use` can't be used to test addresses at scale.
- `POST /v1/oauth/revoke` answers 200 for any token, and introspection `{"active": false}` for
  any token that isn't the caller's.
- `POST /v1/proofs/verify` answers exactly `{"valid": false, "expires_at": null}` for every
  invalid case.
- A custodian asking about another Carbon's Silicon gets `silicon_not_found`, never "not yours".
- Lookups by uuid are limited to 600 per minute per caller: uuids look random, but they are short
  and densely allocated (238,328 three-character values, handed out until all are used), so
  without a limit one caller could walk every account.

## Tokens end when they should

- **Audience.** An access token carries the app it was issued to (`aud`). An app's token is
  refused on account endpoints (`token_wrong_audience`) and at another app's introspection; to act
  for an account at another app, an app gets a User verification proof, which the account can see and revoke.
  The developer platform's tokens (`aud = developer`) are narrower still: they only read the
  signed-in Carbon and manage the apps that Carbon owns, so a leak of one can't change an
  account's emails, Silicons or apps signed into. They never reach a browser: the developer
  platform's server holds them in a sealed, httpOnly cookie, and the Carbon can sign it out from
  their account's sessions at any time.
- **Rotation with reuse detection.** Refresh tokens, proof refresh tokens and authorization codes
  are single use. Presenting a used one is treated as theft: the whole sign-in (or proof) is
  revoked and the app is told (`membership.signed_out`, reason `refresh_token_reuse` or
  `authorization_code_reuse`).
- **Cascades.** Rotating a Silicon's STK ends every sign-in of it, including short-lived tokens
  already issued. Removing an app's access revokes its tokens and the User verification proofs it issued about
  the account. Deleting an account revokes everything. Proof verification checks the sign-in
  behind a User verification proof live, so nothing waits for a sweep or a webhook.
- **Short access tokens.** A locally verified access token can't know it was revoked, so it lives
  30 minutes. When you must know at once, call `POST /v1/oauth/introspect`.

## Headers, CSP and CORS

API responses (JSON):

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: nothing in a JSON
  response may load or be framed;
- `Cache-Control: no-store` under `/v1`: tokens, codes and personal data never sit in a cache;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and HSTS
  (`max-age=63072000; includeSubDomains`) wherever cookies are secure.

Account site pages:

- a per-request nonce CSP: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https:;
  base-uri 'none'`;
- `X-Frame-Options: DENY`, so no page can be framed for clickjacking;
- the one exception is the sign-in iframe (`/embed/v1/buttons`), framable only by the origins
  the app lists in `allowed_origins` (`frame-ancestors 'self' <origins>`); an app with none
  configured, or an unknown app, gets `'none'`. Its buttons navigate the top window to the
  hosted sign-in, so credentials are never typed inside a frame.

Uploaded photos are served with `Content-Security-Policy: default-src 'none'; sandbox` and
`nosniff`, after their bytes were checked to really be PNG, JPEG, WebP or GIF of bounded size: an
upload can't become a script on the account site's origin.

Only public resources send `Access-Control-Allow-Origin: *`: public sign-in configuration, discovery, the JWKS and the SDK. Other responses have CORS headers removed, even if a handler added one. This prevents another website from reading an API response with a visitor’s credentials.

## Webhooks never reach private networks

A webhook URL is something anyone with an app (or a Silicon) can set, and the service then makes
requests to it. Without a guard that would let someone aim the service at internal addresses
(SSRF). In production:

- the URL must be https, without credentials or a fragment, at most 2048 characters;
- `localhost` and host names ending in `.localhost` or `.internal` are refused when set, as are
  literal IP addresses that aren't public;
- at delivery time the host name is resolved and refused if it doesn't resolve or **any** address
  is not public: private, loopback, link-local, carrier-grade NAT, benchmarking, documentation,
  multicast, reserved; IPv6 outside global unicast, unique-local, and IPv6 forms that carry an IPv4
  address (IPv4-mapped, NAT64, 6to4) judged by that IPv4 address;
- the connection is made to exactly the addresses that were checked, so DNS rebinding can't swap
  the address between check and request;
- redirects are not followed and no proxy is used;
- the error recorded for the app's authors (`last_error`) never names the addresses the host resolved
  to, or whether it resolved at all, so the guard can't be used to map internal DNS.

Development stacks may allow http and private hosts (`ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=true`);
production refuses to start with it. Deliveries are signed (HMAC-SHA256 over the timestamp and the
raw body) so your receiver can reject anything that didn't come from Silicon Accounts, and the
timestamp lets it reject a replayed capture: see
[Webhook deliveries and events](../reference/api/webhooks.md#the-signature).

## What is never logged

- Tokens, codes, STKs, secrets and `Authorization` headers are never written to logs or audit
  records. Types that carry them print redacted (`Secret(sar_…)`), in the service and in the Rust
  client.
- Request logs and telemetry record the **route template** (`/v1/flows/{id}/verify`), method,
  status and duration. It leaves out the raw path and query string, which can contain IDs and OAuth codes.
- Telemetry is opt-out per request: `X-Accounts-Telemetry: off` (or the cookie
  `sa_telemetry=off`) drops every event the request would cause. The CLI's telemetry never
  includes tokens, ids or contact details.
- 5xx answers never describe internals; they carry a request id to quote instead.
- History rows another actor wrote into an account's history (a custodian, an app, the service)
  hide the IP address and mask email addresses and phone numbers.
- Database URLs are printed with the password masked.

## Running it safely

`accounts-api` checks its production configuration before starting. It refuses to start with missing or development-only credential keys, unsent local email delivery, no Postmark token, the development outbox enabled or webhook SSRF protection disabled. It also requires an HTTPS public URL, secure cookies and the defined lifetimes: 600 seconds for codes, 60 seconds for the lock and 1800 seconds for access tokens.

Behind a load balancer, the API trusts `X-Forwarded-For` only when `ACCOUNTS_TRUST_FORWARDED_FOR=true`. It uses the **right-most** entry, which the balancer appended, for rate limits and history. Earlier entries may have been supplied by the caller.

## What your app should do

- Keep the app secret, refresh tokens and webhook secrets on your server; never ship them to a
  browser or a mobile binary.
- Use `state` and PKCE on every `/authorize`, and compare `state` on return.
- Store the account `uuid` (or `membership_id`), never the c:id or si:id, which can change.
- Store each new refresh token before using it; a reused one ends the sign-in.
- Verify webhook signatures over the raw body with the current secret, dedupe on `event_id`, and
  answer 2xx quickly.
- When access must stop at once (a sign-out, removed access), use introspection or webhooks
  rather than local token checks alone.

Found a security problem? Report it with `silicon-accounts report "…"` (or `POST /v1/reports`): reports
go to the maintainers by email only.

## Related

- [Errors](../reference/errors.md): every refusal described here, with its code.
- [Limits](../reference/limits.md): every rate limit and lockout number.
- [Tokens and sessions](tokens-and-sessions.md): lifetimes and rotation in depth.
- [The sign-in flow](sign-in-flow.md): the steps the browser binding protects.
- [How webhooks work](webhooks.md): delivery and verification.
