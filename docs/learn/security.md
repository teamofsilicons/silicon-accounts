---
title: Security
description: How we protect credentials, sign-in sessions and webhook delivery, and what your app still needs to check itself.
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

We protect sign-in and credentials, and your app has a part in that too. Keep your app secret and tokens on your server. Call the API with bearer tokens or your app's Basic credentials. Store accounts by uuid, check webhook signatures against the raw request body, and treat an access token as good for at most 30 minutes.

This page explains those rules and the protections behind them, so you can decide what your own app needs to check.

You can see two of these protections from a terminal. A cookie-authenticated change without the account site's `Origin` is refused, even with a valid session:

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

(That's a local stack. An https deployment, where cookies are secure, adds `strict-transport-security: max-age=63072000; includeSubDomains`.)

## Every credential, and how it is kept

Every token we generate is a prefix plus 32 random bytes from the operating system's generator, base64url-encoded. Nobody can guess it, and the prefix tells you (and our error messages) what kind of credential it is.

| Credential | Looks like | Lifetime | Stored as |
|---|---|---|---|
| Browser session (cookie) | `sas_…` | 900 days | HMAC-SHA256 with a server-side key (the pepper) |
| Refresh token | `sar_…` | the sign-in, at most 900 days; rotates on every use | HMAC |
| Access token | a JWT (`eyJ…`) | 30 minutes | not stored: an Ed25519 signature; its sign-in (`fid`) is checked on every API call |
| Authorization code | `sac_…` | 120 s, single use | HMAC |
| Short-lived token | `slt_…` | 120 s, single use, one app | HMAC |
| Device code | `sad_…` | 600 s | HMAC |
| Proof token / proof refresh token | `sap_…` / `sapr_…` | 60 to 1800 s / 900 days | HMAC |
| Flow binding / sign-up cookies | `saf_…` / `sau_…` | 60 min / 48 h | HMAC |
| Custodian request token | `sarq_…` | the request | HMAC |
| App secret | `sa_app_…` | until changed in Silicon Apps | HMAC |
| STK (a Silicon's password) | `stk-` + 12 hex (or 8 to 32 chosen) | until rotated | Argon2id |
| Webhook signing secret | `whsec_…` | until set again or rotated | AES-256-GCM, encrypted |
| Bring-your-own Google secret, Apple key | Provider-specific | until replaced | AES-256-GCM, encrypted |

Why we do it this way:

- **Hashes, not tokens.** We look a token up by its HMAC, so a copy of the database (a backup, a leaked dump) holds nothing that signs anyone in. The HMAC key lives outside the database.
- **The STK is hashed slowly.** A generated STK has 48 bits of randomness. That's plenty against online guessing (10 wrong tries lock sign-in for a minute), but not against a fast offline hash. Argon2id (19 MiB, 2 passes) makes every guess expensive. A sign-in for an si:id that doesn't exist spends the same Argon2 work, so response time doesn't reveal which ids exist.
- **Encryption only where a secret must be read back.** Webhook secrets sign every delivery, and your Google/Apple credentials are sent to the providers, so we encrypt them (AES-256-GCM, with a versioned keyring that allows key rotation) instead of hashing them. Nothing returns them after the response that created them.
- **Shown once.** STKs, webhook secrets, request tokens and proof tokens appear in exactly one response. If a request carrying an `Idempotency-Key` is retried, we keep the stored response encrypted for 10 minutes and replay it; it never sits in the database in clear.
- **App credentials** are checked against their HMAC, and the result is cached for 60 seconds, keyed by the HMAC of the presented secret, so a wrong secret can't ride on a cached success.

## Cookies

The account site uses three cookies, all `HttpOnly; SameSite=Lax; Path=/`. In production they're also `Secure` with the `__Host-` prefix (`__Host-sa_session`), which forbids a `Domain` attribute, so no subdomain can set or overwrite them:

| Cookie | For | Max-Age |
|---|---|---|
| `sa_session` | the browser's signed-in Carbon | 900 days |
| `sa_flow` | binds a hosted sign-in to the browser that started it | 60 minutes |
| `sa_signup` | binds a sign-up to the browser that verified the address | 48 hours |

`HttpOnly` keeps them away from page scripts. `SameSite=Lax` sends them on top-level navigations (a provider redirecting back is one), but not on cross-site POSTs, images or fetches. A fourth cookie, `sa_telemetry=off`, isn't a credential: it opts the browser out of telemetry.

Apps never see these cookies and never need them, because they run on another origin. Apps and Silicons authenticate with HTTP Basic (app secret) or Bearer tokens.

## The Origin check

`SameSite=Lax` still lets another site navigate a signed-in browser to us. So we check the `Origin` header on cookie-authenticated requests that change data: POST, PUT, PATCH and DELETE. The origin must match the public site or a configured extra origin, or the request gets `403 origin_not_allowed`.

The browser sets this header itself, so a page can't swap in another site's origin. Creating a hosted sign-in flow with `POST /v1/flows` goes through the same check.

Bearer tokens aren't cookies: a browser never attaches them by itself, so the check doesn't apply to them. That's why scripts, Silicons and servers should always use Bearer tokens.

## Sign-ins are bound to one browser

- A hosted sign-in flow belongs to the browser that started it (`sa_flow`). Someone who learns a flow id from a URL can't continue it (403 `flow_not_bound`).
- We accept a Google or Apple answer only from the browser that started that sign-in. Apple posts its answer cross-site without cookies, so we park the answer and send the browser to a one-time ticket URL that carries the cookie. An answer delivered by any other browser is thrown away. Without this, someone could forward a genuine provider link to a victim and get signed in as them, or sign a victim in to an attacker's account.
- The callback itself sets no cookies; the next request carrying the binding cookie claims the outcome.
- `state` (we store an HMAC of it), `nonce` and PKCE protect the provider leg. We check the provider's `id_token` against its published keys, issuer, audience, expiry and nonce, and only a verified email counts.
- Only a **verified** email or phone identifies an account. Someone who proves an address takes over an unverified copy of it elsewhere (from an unfinished import), so an address nobody proved never signs anyone in.

## Codes and guessing

- Verification codes are 6 uniformly random digits, valid for 10 minutes.
- Wrong codes are counted **per address**, across every flow, the CLI, the account site and the requirement step. The 10th wrong code in a row locks every code to that address for 60 seconds, so starting new flows doesn't buy more guesses.
- At most 10 codes go to one address per 10 minutes (and 30 per network), so nobody can flood an address.
- 10 wrong STKs in a row lock that Silicon's sign-in for 60 seconds, and a network gets at most 60 sign-in attempts per minute.

Our answers are shaped so they don't reveal more than the caller already knows:

- Silicon sign-in answers `invalid_credentials` the same way for an unknown si:id and a wrong STK, in the same time.
- CLI code sign-in only says that no active Carbon signs in with that address.
- Adding an email or phone counts the attempt before checking whether another account has it, so `email_in_use` can't be used to test addresses at scale.
- `POST /v1/oauth/revoke` answers 200 for any token, and introspection answers `{"active": false}` for any token that isn't the caller's.
- `POST /v1/proofs/verify` answers exactly `{"valid": false, "expires_at": null}` for every invalid case.
- A custodian asking about another Carbon's Silicon gets `silicon_not_found`, never "not yours".
- Lookups by uuid are limited to 600 per minute per caller. Uuids look random, but they're short and densely handed out (238,328 three-character values, all used before any longer ones), so without a limit one caller could walk every account.

## Tokens end when they should

- **Audience.** An access token carries the app it was issued to (`aud`). An app's token is refused on account endpoints (`token_wrong_audience`) and at another app's introspection. To act for an account at another app, an app gets a User verification proof, which the account can see and revoke. The developer platform's tokens (`aud = developer`) are narrower still: they only read the signed-in Carbon and manage the apps that Carbon owns, so a leaked one can't change an account's emails, Silicons or the apps it signed into. They never reach a browser. The developer platform's server holds them in a sealed, httpOnly cookie, and the Carbon can sign it out from their account's sessions at any time.
- **Rotation with reuse detection.** Refresh tokens, proof refresh tokens and authorization codes are single use. We treat a used one coming back as theft: we revoke the whole sign-in (or proof) and tell the app (`membership.signed_out`, reason `refresh_token_reuse` or `authorization_code_reuse`).
- **Cascades.** Rotating a Silicon's STK ends every sign-in of it, short-lived tokens already issued included. Removing an app's access revokes its tokens and the User verification proofs it issued about the account. Deleting an account revokes everything. Proof verification checks the sign-in behind a User verification proof live, so nothing waits for a sweep or a webhook.
- **Short access tokens.** A locally verified access token can't know it was revoked, so it only lives 30 minutes. When you must know right away, call `POST /v1/oauth/introspect`.

## Headers, CSP and CORS

API responses (JSON):

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: nothing in a JSON response may load or be framed;
- `Cache-Control: no-store` under `/v1`: tokens, codes and personal data never sit in a cache;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and HSTS (`max-age=63072000; includeSubDomains`) wherever cookies are secure.

Account site pages:

- a per-request nonce CSP: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https:;
  base-uri 'none'`;
- `X-Frame-Options: DENY`, so no page can be framed for clickjacking;
- the one exception is the sign-in iframe (`/embed/v1/buttons`), which only the origins your app lists in `allowed_origins` can frame (`frame-ancestors 'self' <origins>`). An app with none set up, or an unknown app, gets `'none'`. Its buttons navigate the top window to the hosted sign-in, so credentials are never typed inside a frame.

Uploaded photos are served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, after we check their bytes really are PNG, JPEG, WebP or GIF of bounded size. An upload can't become a script on the account site's origin.

Only public resources send `Access-Control-Allow-Origin: *`: the public sign-in configuration, discovery, the JWKS and the SDK. We strip CORS headers from every other response, even if a handler added one, so no other website can read an API response using a visitor's credentials.

## Webhooks never reach private networks

Anyone with an app (or a Silicon) can set a webhook URL, and then we make requests to it. Without a guard, someone could aim us at internal addresses (SSRF). In production:

- the URL must be https, without credentials or a fragment, at most 2048 characters;
- `localhost` and host names ending in `.localhost` or `.internal` are refused when set, and so are literal IP addresses that aren't public;
- at delivery time we resolve the host name and refuse it if it doesn't resolve or if **any** address isn't public: private, loopback, link-local, carrier-grade NAT, benchmarking, documentation, multicast, reserved; IPv6 outside global unicast, unique-local, and IPv6 forms that carry an IPv4 address (IPv4-mapped, NAT64, 6to4), judged by that IPv4 address;
- we connect to exactly the addresses we checked, so DNS rebinding can't swap the address between the check and the request;
- we don't follow redirects and don't use a proxy;
- the error we record for the app's authors (`last_error`) never names the addresses the host resolved to, or whether it resolved at all, so nobody can use the guard to map internal DNS.

Development stacks may allow http and private hosts (`ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=true`); production refuses to start with it. Deliveries are signed (HMAC-SHA256 over the timestamp and the raw body), so your receiver can reject anything that didn't come from us, and the timestamp lets it reject a replayed capture. See [Webhook deliveries and events](../reference/api/webhooks.md#the-signature).

## What is never logged

- Tokens, codes, STKs, secrets and `Authorization` headers are never written to logs or audit records. Types that carry them print redacted (`Secret(sar_…)`), in the service and in the Rust client.
- Request logs and telemetry record the **route template** (`/v1/flows/{id}/verify`), method, status and duration. They leave out the raw path and query string, which can contain ids and OAuth codes.
- Telemetry is opt-out per request: `X-Accounts-Telemetry: off` (or the cookie `sa_telemetry=off`) drops every event the request would cause. The CLI's telemetry never includes tokens, ids or contact details.
- 5xx answers never describe internals; they carry a request id for you to quote instead.
- History rows another actor wrote into an account's history (a custodian, an app, the service) hide the IP address and mask email addresses and phone numbers.
- Database URLs are printed with the password masked.

## Running it safely

`accounts-api` checks its production configuration before it starts. It refuses to start with missing or development-only credential keys, local email delivery that doesn't really send, no Postmark token, the development outbox turned on, or webhook SSRF protection turned off. It also requires an HTTPS public URL, secure cookies and the set lifetimes: 600 seconds for codes, 60 seconds for the lock and 1800 seconds for access tokens.

Behind a load balancer, the API trusts `X-Forwarded-For` only when `ACCOUNTS_TRUST_FORWARDED_FOR=true`. It uses the **right-most** entry, the one the balancer appended, for rate limits and history, because the caller may have supplied the earlier ones.

## What your app should do

- Keep the app secret, refresh tokens and webhook secrets on your server; never ship them to a browser or a mobile binary.
- Use `state` and PKCE on every `/authorize`, and compare `state` when the browser comes back.
- Store the account `uuid` (or `membership_id`), never the c:id or si:id, which can change.
- Store each new refresh token before using it; a reused one ends the sign-in.
- Verify webhook signatures over the raw body with the current secret, dedupe on `event_id`, and answer 2xx quickly.
- When access must stop at once (a sign-out, removed access), use introspection or webhooks, not local token checks alone.

Found a security problem? Report it with `silicon-accounts report "…"` (or `POST /v1/reports`). Security reports reach the Team by email only.

## Related

- [Errors](../reference/errors.md): every refusal described here, with its code.
- [Limits](../reference/limits.md): every rate limit and lockout number.
- [Tokens and sessions](tokens-and-sessions.md): lifetimes and rotation in depth.
- [The sign-in flow](sign-in-flow.md): the steps the browser binding protects.
- [How webhooks work](webhooks.md): delivery and verification.
