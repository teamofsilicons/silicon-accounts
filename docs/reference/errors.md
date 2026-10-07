---
title: Errors
description: Every error Silicon Accounts returns — the two body shapes, every code with its HTTP status, what caused it and what to do — plus the OAuth errors, the Rust client's own codes and webhook verification failures.
kind: informative
order: 70
related:
  - reference/api.md
  - reference/limits.md
  - reference/rust-client.md
  - reference/cli.md
  - learn/security.md
---

# Errors

Every error says exactly what went wrong and why, and what to do next. This page lists every
code so a program can branch on it and a Silicon can decide what to do without guessing.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/silicons/login" -H 'Content-Type: application/json' \
  -d '{"id":"si:scout","stk":"stk-000000000000"}'
```

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Sign-in failed: no Silicon has this si:id, or the STK is wrong. Both cases get this same answer, so ids can't be probed.",
    "hint": "Check the si:id (use the current one; ids can change) and the STK (stk- followed by the hex characters shown once at creation or rotation). 10 wrong STKs in a row lock sign-in for 1 minute. A lost STK can be replaced by the Silicon's custodian (`accounts silicon rotate-stk`)."
  }
}
```

## The two shapes

Everything except the three OAuth endpoints:

```json
{ "error": { "code": "…", "message": "…", "hint": "…", "details": { } } }
```

- `code`: stable, snake_case; branch on it, never on the message text.
- `message`: what went wrong and why, naming the values involved.
- `hint`: what to do next (sometimes absent).
- `details`: structured extras — `fields` (422 `validation_failed`: path → problem),
  `retry_after_seconds` (423, 429), `suggestions` (`id_taken`), `request_id` (5xx), and the
  per-code details listed below.
- 423 and 429 also set the `Retry-After` header; 401 responses are `Cache-Control: no-store`; 5xx
  bodies never describe internals.

`POST /v1/oauth/token`, `/v1/oauth/revoke` and `/v1/oauth/introspect` answer RFC 6749 bodies,
`{"error": "invalid_grant", "error_description": "…"}`, because OAuth libraries expect them
([OAuth errors](#oauth-errors)).

Always log the `X-Request-Id` response header with an error; it identifies the request in the
service's logs (`accounts report` and `POST /v1/reports` take it in the message).

## How to react, by status

| Status | Meaning | What to do |
|---|---|---|
| 400 | the request is malformed | fix the request; retrying it unchanged fails again |
| 401 | no or bad credentials | sign in again, or fix the token or app secret |
| 403 | authenticated but not allowed | a different account or app, or a different route, is needed |
| 404 | not found (or not visible to you) | check the identifier |
| 409 | conflicts with the current state | read the current state, then decide |
| 410 | expired | start that step again |
| 413 / 415 | body too large / wrong media type | send a smaller or correct body |
| 422 | well-formed but invalid values | fix the fields named in the message or `details.fields` |
| 423 | locked after too many failures | wait `Retry-After` seconds |
| 429 | rate limited | wait `Retry-After` seconds |
| 5xx | a fault on our side, or a timeout | retry later with the same `Idempotency-Key`; report it with the request id if it persists |

## Request format

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_json` | 400 | the body isn't valid JSON (line and column given) |
| `invalid_content_type` | 400 | a body was sent without `Content-Type: application/json` (or, for imports, `text/csv`) |
| `invalid_body` | 400 | the body couldn't be read (connection broken mid-upload) |
| `invalid_query` | 400 | a query parameter is missing, has the wrong type or an unknown value (named) |
| `invalid_path` | 400 | a path parameter is malformed |
| `invalid_cursor` | 400 | `cursor` isn't a `next_cursor` from this list; pass it unchanged or omit it |
| `invalid_request` | 400 | the request is missing something it needs (the message names it) |
| `validation_failed` | 422 | fields are missing, of the wrong type, invalid, or unknown: `details.fields` maps each path (`branding.radius`, `scopes[3]`) to its problem; every problem is reported at once |
| `payload_too_large` | 413 | the body is over the route's limit (`details.limit_bytes`: 64 KB by default) |
| `unsupported_media_type` | 415 | a photo upload's `Content-Type` isn't PNG, JPEG, WebP or GIF |
| `route_not_found` | 404 | no endpoint has this path |
| `method_not_allowed` | 405 | the path exists with other methods (the `Allow` header lists them) |
| `not_found` | 404 | a file of the account site doesn't exist |

## Idempotency

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_idempotency_key` | 400 | `Idempotency-Key` isn't 1–200 visible ASCII characters (no spaces) |
| `idempotency_key_reused` | 409 | the key was used for a different body on this endpoint; use a new key for a new request |
| `idempotency_in_progress` | 409 | a request with this key is still running; retry in a few seconds |
| `idempotency_result_unavailable` | 409 | the stored secret-bearing result can no longer be decrypted, so it isn't run again; check the current state (e.g. list your Silicons) before retrying with a new key |
| `idempotency_key_required` | 400 | reserved for endpoints that require a key (none currently do) |

## Authentication and permission

| Code | Status | Cause and fix |
|---|---|---|
| `unauthenticated` | 401 | no credentials; sign in (`accounts login`) or send the app's Basic credentials |
| `account_auth_required` | 401 | app credentials (Basic) were sent to an endpoint that acts for an account |
| `invalid_authorization` | 401 | the `Authorization` header is unreadable or uses an unsupported scheme |
| `invalid_token` | 401 | not an access token, a bad signature, or expired (access tokens last 30 minutes: refresh) |
| `token_wrong_audience` | 401 | an app's token was used where a first-party (`aud = accounts`) token is needed, or a developer-platform token (`aud = developer`, `details.aud`) outside the routes it may use (`GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps` and the owner routes under `/v1/apps/{app_id}/…`); the message names the method and route |
| `token_revoked` | 401 | the sign-in behind the token ended (signed out, STK rotated, account deleted, refresh token reuse); the message says when and why; sign in again |
| `session_expired` | 401 | the session cookie was signed out, revoked or expired |
| `account_deleted` | 401 / 403 / 404 / 409 | the account was deleted: 401 for its own tokens, 403 at Silicon sign-in, 404 at lookups, 409 when it happened during the request |
| `origin_not_allowed` | 403 | a cookie-authenticated POST/PUT/PATCH/DELETE came without the account site's `Origin`; use a Bearer token instead of the cookie |
| `carbon_only` | 403 | a Silicon called an endpoint for Carbons (emails, phones, custodian side…) |
| `silicon_only` | 403 | a Carbon called an endpoint for Silicons (`/v1/me/webhook`) |
| `account_not_active` | 403 | the account isn't active (pending custodian, unfinished import) |
| `app_credentials_required` | 401 | an app endpoint got no credentials |
| `invalid_app_credentials` | 401 | unknown app_id, wrong secret, or malformed Basic header |
| `app_disabled` | 403 (400 in `/v1/flows`, 401 at userinfo) | the app is disabled |
| `app_mismatch` | 403 | app credentials were used on another app's `/v1/apps/{app_id}` URL |
| `not_app_owner` | 403 | a Carbon who doesn't own the app tried to manage it |
| `unknown_app` | 404 (400 in `/v1/flows`) | no app has this app_id |
| `request_token_required` | 401 | `GET /v1/silicons/requests/{id}` without `Bearer sarq_…` |
| `invalid_request_token` | 401 | the `sarq_` token doesn't belong to this request |
| `internal_token_required` | 401 | `/v1/internal/*` without the internal token (Silicon Apps only) |
| `invalid_internal_token` | 401 | the internal token is wrong |
| `internal_api_disabled` | 403 | the server has no internal token configured |
| `access_removed` | 401 | at userinfo: the account removed your app's access |
| `membership_inactive` | 401 at userinfo, 403 for proofs | the account has no active membership with your app |

## Rate limits and locks

| Code | Status | Cause and fix |
|---|---|---|
| `rate_limited` | 429 | over a limit ([Limits](limits.md)); wait `Retry-After` / `details.retry_after_seconds`. The message names the limit ("the limit is 120 per minute"); id changes add `details.limit`, `window_seconds`, `retry_at`; imports add row budget details |
| `verification_locked` | 423 | 10 wrong codes in a row for this address; every code to it waits 60 seconds (`details.locked_until`) |
| `login_locked` | 423 | 10 wrong STKs in a row for this Silicon; sign-in waits 60 seconds |
| `imports_busy` | 503 | the server is already parsing its maximum of imports; retry after `Retry-After` (15 s) |

## Verification codes

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_code` | 422 | wrong code (`details.remaining_attempts` for the address), or not 6 digits (not counted). The 10th wrong one in a row has `remaining_attempts: 0`, `details.locked_until` and `Retry-After` |
| `code_expired` | 410 | older than 10 minutes, or replaced by a resend; send a new one |
| `code_already_used` | 409 | this code was already accepted |
| `challenge_not_found` | 404 | unknown `challenge_id` (or one of another flow) |
| `no_code_sent` | 409 | a resend (or a requirement verify) before any code was sent in this flow |

## Ids and lookups

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_id` | 422 (400 at `by-id`) | not a valid `c:`/`si:` id, or the wrong kind; `details.reason` is `invalid` or `reserved_word` |
| `id_taken` | 409 | another account has it; `details.suggestions` lists free ones |
| `id_reserved` | 409 | it was changed away from recently and is held for 10 days (`details.reserved_until`) |
| `invalid_uuid` | 400 | not a uuid (an id was given: use `/v1/accounts/by-id/{id}`) |
| `account_not_found` | 404 | no account with this uuid or current id; at CLI sign-in, no active Carbon with that email or phone (sign up first) |
| `silicon_not_found` | 404 | not a Silicon you are custodian of (other Carbons' Silicons are never revealed) |
| `custodian_not_found` | 404 | no active Carbon has the c:id named as custodian or transfer target; name them by email instead |

## Profile, photos and deletion

| Code | Status | Cause and fix |
|---|---|---|
| `dob_immutable` | 422 | a Silicon's date of birth is its creation day |
| `confirmation_required` | 422 | `DELETE` needs `{"confirm": "<current id>"}` |
| `confirmation_mismatch` | 422 | `confirm` isn't the account's current id; nothing was deleted |
| `custodian_of_silicons` | 409 | a Carbon who is custodian of Silicons can't be deleted (`details.silicons`); transfer or delete them first |
| `custodian_required` | 403 | a Silicon can't delete itself; its custodian does |
| `photo_too_large` | 413 | over 2 MB |
| `empty_photo` | 422 | an empty body |
| `invalid_image` | 422 | the bytes aren't a readable PNG, JPEG, WebP or GIF |
| `photo_type_mismatch` | 422 | the bytes are another format than `Content-Type` says (`details.detected_content_type`) |
| `photo_dimensions_too_large` | 422 | over 8192 px a side or 50 megapixels |
| `photo_not_found` | 404 | no such photo (or it was removed) |

## Emails, phones and linked identities

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_email` / `invalid_phone` / `invalid_country` | 422 | the address, number or country code can't be read (the message says why) |
| `email_in_use` / `phone_in_use` | 409 | it belongs to another account; an address belongs to one account only |
| `email_already_added` / `phone_already_added` | 409 | it is already on your account |
| `email_limit_reached` / `phone_limit_reached` | 422 | 10 already; remove one first |
| `email_not_found` / `phone_not_found` | 404 | not on your account |
| `email_not_verified` / `phone_not_verified` | 409 | only a verified address can be primary |
| `cannot_remove_primary` | 409 | make another address primary first |
| `invalid_provider` | 400 | the provider isn't `google` or `apple` |
| `unknown_provider` | 404 | the same, in a sign-in or link URL |
| `identity_not_found` | 404 | no such linked identity |
| `identity_in_use` | 409 | that Google/Apple account is linked to another account |
| `last_sign_in_method` | 409 | removing it would leave no way to sign in (no email or phone) |
| `browser_session_required` | 400 | linking Google/Apple needs the account site's browser session, not a token |
| `provider_not_configured` | 503 | no Google/Apple credentials for this app or deployment |

## Your apps, sessions and history

| Code | Status | Cause and fix |
|---|---|---|
| `membership_not_found` | 404 | you never signed into that app |
| `first_party_app` | 400 / 422 | the account site (`accounts`) can't lose access (400) or get a short-lived token (422) |
| `session_not_found` | 404 | not a session of yours (an app's sign-in is removed with `DELETE /v1/me/apps/{app_id}`) |
| `invalid_history_kind` | 400 | `kind` isn't `signin`, `id_change`, `custodian`, `proof`, `app_access` or `security` |
| `requirements_missing` | 409 | the app requires a detail the account lacks (`details.missing`); add it, then retry |

## Hosted sign-in

| Code | Status | Cause and fix |
|---|---|---|
| `redirect_uri_not_registered` | 400 | the `redirect_uri` isn't registered exactly; never redirected to |
| `invalid_scope` | 400 | an unknown scope (with `details.redirect_to`) |
| `unsupported_response_type` | 400 | `response_type` other than `code` |
| `method_not_enabled` | 400 / 403 | the app didn't enable that method (or no managed credentials exist) |
| `flow_not_found` | 404 | unknown flow id |
| `flow_not_bound` | 403 | the request lacks this flow's `sa_flow` cookie: continue in the browser that started it |
| `flow_expired` | 410 | flows last 60 minutes; start again from the app |
| `invalid_step` | 409 | the flow is at another step (the message names the allowed ones) |
| `flow_completed` / `flow_failed` | 409 | the flow ended; `GET /v1/flows/{id}` returns its `redirect_to` |
| `flow_changed` | 409 | the flow moved on in another tab while this request ran, or the app changed its flow and the details page is gone: `GET /v1/flows/{id}` shows where it is now |
| `account_changed` | 409 | the browser is now signed in as a different account than the flow's |
| `account_unavailable` | 409 | the address belongs to an account that can't sign in |
| `session_required` | 401 | "continue as" without a browser session |
| `continue_not_allowed` | 403 | the app turned off `remember_browser` |
| `reauthentication_required` | 403 | the app asked for `prompt=login` |
| `email_domain_not_allowed` | 403 | the app accepts only some email domains |
| `signup_not_allowed` | 403 | the app takes no new accounts (`allow_signup: false`) |
| `signup_not_bound` | 403 | the sign-up belongs to another browser |
| `signup_expired` | 410 | sign-ups last 48 hours; verify the address again |
| `signup_already_completed` | 409 | this sign-up already created an account; sign in instead |
| `detail_not_on_page` | 409 | `details/add` for a detail that isn't on the page on screen |
| `no_previous_page` | 409 | `details/back` on the first page |
| `requirements_missing` | 409 | a required email or phone of the page isn't on the account yet (`details.missing`): add it with `details/add` + `details/verify` |
| `invalid_state` | 400 | a provider callback with a malformed `state` |

Codes carried in `flow.error` (and in `?error=` on your redirect URI) rather than as HTTP errors:
`login_required`, `consent_required`, `interaction_required` (`prompt=none`), `access_denied`
(cancelled on a details or review page), `provider_cancelled`, `provider_error`, `provider_token_invalid`,
`provider_unavailable`, `provider_config_changed`, `provider_answer_elsewhere`,
`provider_email_invalid`, `email_not_verified`, `hosted_domain_mismatch` (a Google account
outside the app's `google.hosted_domain`), `signup_expired`, `session_changed` (linking),
`identity_in_use`, `email_in_use`, `email_limit_reached` (linking, as `?link_error=`).

## Device sign-in

| Code | Status | Cause and fix |
|---|---|---|
| `device_code_not_found` | 404 | no device sign-in waits for this user code |
| `device_code_used` | 409 | already approved or denied |
| `device_code_expired` | 410 | user codes last 10 minutes; run `accounts login` again |

## Silicons and custodians

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_stk` | 422 | at sign-in: not `stk-` + 8 to 32 hex characters (creating a Silicon or rotating its STK reports a bad chosen STK as `validation_failed` on `stk`) |
| `invalid_credentials` | 401 | unknown si:id or wrong STK (one answer for both) |
| `custodian_pending` | 403 | the custodian hasn't accepted yet (`details.custodian`, `request_id`, `expires_at`) |
| `custodian_declined` | 403 | the custodian declined; the account was released |
| `custodian_expired` | 403 | nobody accepted within 14 days; the account was released |
| `custodian_request_not_found` | 404 | no such request (or not addressed to you) |
| `custodian_request_not_pending` | 409 | already accepted, declined, expired or cancelled (`details.status`) |
| `custodian_request_expired` | 410 | the 14 days ran out |
| `custodian_request_pending` | 409 | the Silicon already has a pending request |
| `silicon_not_pending` | 409 | accepting an initial request for a Silicon that is no longer waiting |
| `silicon_not_active` | 409 | a transfer of a Silicon that isn't active |
| `already_custodian` | 409 | you already are its custodian |
| `transfer_pending` | 409 | one transfer at a time (`details.request_id`): cancel it first |
| `transfer_not_found` | 404 | no pending transfer to cancel |
| `transfer_to_self` | 422 | a transfer must go to another Carbon |
| `transfer_stale` | 409 | the custodian changed after the transfer was requested |
| `webhook_not_set` | 409 | a test ping or secret rotation without a webhook URL |

## Apps

| Code | Status | Cause and fix |
|---|---|---|
| `config_version_conflict` | 409 | the sign-in setup changed since the version you sent (`details.current_version`): re-read, re-apply, resend |
| `user_not_found` | 404 | the uuid isn't in this app's user base (uuids are case-sensitive) |
| `import_not_found` | 404 | no such import job for this app |
| `delivery_not_found` | 404 | no such webhook delivery for this app |
| `unknown_columns` | 422 | the import has columns Silicon Accounts doesn't keep (`details.unknown_columns`, `allowed_columns`); remove them or set `ignore_unknown_columns` |
| `duplicate_columns` | 422 | the same column twice |
| `no_identifier_columns` | 422 | no `email`, `emails`, `phone` or `phones` column |
| `empty_import` | 422 | no rows |
| `too_many_rows` | 422 | over 100,000 rows |
| `invalid_csv` | 422 | the CSV can't be parsed (line given) |
| `too_many_columns` | 422 | over 200 columns |
| `value_too_large` | 422 | a value over 8 KB, or a column name over 200 bytes (`details.row`, `details.column`) |
| `too_many_items` | 422 | a JSON list over 50 items |
| `owner_not_found` / `owner_email_conflict` / `owner_unavailable` | 422 / 409 / 409 | Silicon Apps sync: the owner can't be resolved |

Import rows carry their own message codes (`missing_identifier`, `ambiguous_match`,
`duplicate_in_file`, `external_id_conflict`, `id_conflict`, …): see
[Import existing users](../start/import-users.md).

## Proofs

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_subject_token` | 400 | the subject token isn't a live access token (`details.reason`: `not_an_access_token`, `invalid`, `expired`, `revoked`) |
| `subject_token_wrong_app` | 403 | the subject token belongs to another app (`details.token_app`) |
| `ata_single_app` | 422 | an ATA request named apps in `audiences`: an ATA proof is for exactly one app; send `{"receiving_app": "…"}` once per app (`details.field`, `details.apps`) |
| `unknown_receiving_app` | 400 | the receiving app doesn't exist (`details.app_ids`) |
| `invalid_receiving_app` | 400 | the issuer itself, or Silicon Accounts itself (`accounts`, `developer`) |
| `receiving_app_disabled` | 403 | the receiving app is disabled |
| `invalid_proof_refresh_token` | 400 | not a `sapr_` token, or unknown (mistyped, another environment, or its proof ended over 30 days ago) |
| `not_issuing_app` | 403 | only the issuing app refreshes or revokes a proof |
| `proof_refresh_token_reused` | 400 | a used refresh token was presented: the proof is now revoked |
| `proof_revoked` | 410 | the proof was revoked, or its OBO sign-in ended (`details.reason`, `revoked_at`) |
| `proof_expired` | 410 | past the proof's lifetime |
| `invalid_proof_id` | 400 | not a UUID |
| `proof_not_found` | 404 | not a proof you can see |

A proof that doesn't verify is never an error: `POST /v1/proofs/verify` answers 200
`{"valid": false, "expires_at": null}`.

## Server

| Code | Status | Cause and fix |
|---|---|---|
| `internal` | 500 | a fault on our side; `details.request_id` identifies it — retry later, report it if it persists |
| `database_unavailable` | 503 | the database is unreachable; nothing was changed; retry in a few seconds |
| `request_timeout` | 503 | the request ran past its time budget (30 s, 60 s for uploads, 5 min for imports) |
| `web_not_built` | 503 | (static hosting only) the account site build is incomplete |
| `dev_outbox_disabled` | 404 | the development outbox is off |

When a framework layer (not a handler) refuses a request, the code is derived from the status:
`forbidden` 403, `conflict` 409, `gone` 410, `locked` 423, `not_acceptable` 406,
`length_required` 411, `uri_too_long` 414, `range_not_satisfiable` 416, `not_implemented` 501,
`bad_gateway` 502, `unavailable` 503, `gateway_timeout` 504, `request_failed` (other 4xx).

## OAuth errors

From `/v1/oauth/token`, `/revoke` and `/introspect`, as `{"error", "error_description"}`, with
`Cache-Control: no-store`.

| `error` | Status | Cause |
|---|---|---|
| `invalid_request` | 400 (413 for a body over 64 KB) | a parameter is missing, repeated or malformed; the client authenticated twice |
| `invalid_client` | 401 | unknown app, wrong secret, disabled app, or no credentials; `WWW-Authenticate: Basic realm="Silicon Accounts"` |
| `invalid_grant` | 400 | the code, refresh token, SLT or device code is unknown, expired, already used (a reused refresh token or code also revokes its sign-in), revoked, another app's, or its account is deleted or removed the app's access; a `redirect_uri` or PKCE mismatch |
| `unauthorized_client` | 400 | the public client used a confidential grant, or an app used the device-code grant |
| `unsupported_grant_type` | 400 | the grant isn't supported (the description names the alternative) |
| `invalid_scope` | 400 | a refresh asked for more scopes than were granted |
| `authorization_pending` | 400 | device sign-in not approved yet; keep polling |
| `slow_down` | 400 | polled within 5 seconds of the last poll; add 5 seconds |
| `access_denied` | 400 | the Carbon denied the device sign-in |
| `expired_token` | 400 | the device code expired (10 minutes) |
| `server_error` | 500 | a fault on our side (request id in the description) |
| `temporarily_unavailable` | 503 | the request ran past its time budget |

## Rust client codes

`silicon_accounts_client::Error::code()` returns the service's code for API and OAuth errors,
and its own codes for failures that never reached a response:

| Code | Variant | Meaning |
|---|---|---|
| `connection_failed` | `Error::Http` | DNS, TLS, refused connection |
| `request_timeout` | `Error::Http` | no answer within the client timeout (30 s by default) |
| `unexpected_response` | `Error::Decode` | an answer that isn't what this client expects (wrong URL, newer service) |
| `invalid_input` | `Error::InvalidInput` | refused before sending (an empty STK, an http URL to a remote host…) |
| `timed_out` | `Error::TimedOut` | a waiting helper gave up (the work goes on in the service) |
| `token_malformed`, `token_unsupported_algorithm`, `token_unknown_key`, `token_invalid_key`, `token_bad_signature`, `token_expired`, `token_not_yet_valid`, `token_wrong_audience`, `token_wrong_issuer`, `token_missing_claim` | `Error::Token` | local access-token verification failed |
| `http_<status>` | `Error::Api` | a non-Silicon-Accounts error body (a proxy or load balancer answered) |

Webhook verification (`WebhookError`): `EmptySecret`, `MissingHeader`, `InvalidTimestamp`,
`TimestampOutOfTolerance` (more than 5 minutes off), `InvalidSignatureFormat`,
`SignatureMismatch`, `InvalidBody`. Reject the delivery (answer 400 or 401) in every case.
Details: [Rust client](rust-client.md#errors).

The `accounts` CLI prints these same codes (with `--json`:
`{"error":{"code","message","hint","exit_code","status","request_id","details"}}`) and maps them
to exit codes ([Exit codes](cli.md#exit-codes)). It also has codes of its own, for problems it
finds without asking the service (`not_signed_in`, `wrong_account_kind`, `invalid_arguments`,
`corrupt_state_file`, `unknown_topic`…): [CLI error codes](cli.md#cli-error-codes) lists them
with their exit codes.
