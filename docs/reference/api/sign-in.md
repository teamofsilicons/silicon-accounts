---
title: Hosted sign-in, sessions and CLI sign-in endpoints
description: Reference for the hosted sign-in flow behind /authorize (/v1/flows/*), Google and Apple legs and callbacks, connecting Google or Apple to an account, browser sessions, device approval and the CLI's code sign-in.
kind: informative
order: 62
related:
  - reference/api.md
  - reference/api/oauth.md
  - start/hosted-pages.md
  - start/cli.md
  - learn/sign-in-flow.md
  - learn/security.md
  - reference/errors.md
---

# Hosted sign-in, sessions and CLI sign-in endpoints

This page covers how a Carbon proves who they are. The hosted flow (`/v1/flows/*`) is the API
the account site's `/authorize` page drives in the browser; apps never call it, they send the
browser to `/authorize` ([OAuth and OIDC](oauth.md)). The CLI code sign-in and the device flow
(approved here in a signed-in browser) are how a Carbon signs a terminal in. The guide is
[Hosted pages](../../start/hosted-pages.md); the reasons behind each step are in
[The sign-in flow](../../learn/sign-in-flow.md).

A Carbon signs in from a terminal with a 6-digit code:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/cli/login/start" \
  -H 'Content-Type: application/json' -d '{"email":"saket@example.com"}'
```

```json
{
  "challenge_id": "01a11434-631f-77f2-ae39-1e04944e2637",
  "destination": "s***@example.com",
  "expires_at": "2026-10-07T02:42:19.996Z"
}
```

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/cli/login/verify" -H 'Content-Type: application/json' \
  -d '{"challenge_id":"01a11434-631f-77f2-ae39-1e04944e2637","code":"594873","client_label":"my script"}'
```

The answer is a [token response](oauth.md#the-token-response) whose tokens have
`aud: "accounts"`, ready for every account endpoint.

## The hosted flow

A flow is one sign-in attempt in one browser, 60 minutes long. Its `step` moves:

```text
choose_method ──email/phone code──▶ verify_code ──┐
      │  └──Google/Apple (provider round trip)──────┼──▶ signup  (new account, or finishing an imported one)
      └──continue as the browser's account ─────────┤       │
                                                    ▼       ▼
                         details[0] ──▶ details[1] … ──▶ review (flow.review) ──▶ complete  (redirect_to = code)
                         (Back between pages; Cancel on any page) ─────────────▶ complete  (error=access_denied)
prompt=none that can't finish silently ───────────────────────────────────────▶ failed    (redirect_to = error redirect)
```

`details` is one page of the app's [flow](../../start/sign-in-config.md#flows): the details
it asks for on that page, each required (always shared; a missing email or phone is added on the
page with a code) or optional (a checkbox, unticked until the Carbon ticks it). An app without a
flow of its own gets one page with every detail it asks for. A Carbon sees every page on their
first sign-in to the app (and with `prompt=consent`); after that only a page with something new
on it, and a Carbon with nothing new goes straight to `complete`. `review` is shown only when the
app turned it on. The first-party apps (`accounts`, `developer`) never show these pages.

Rules every flow endpoint follows:

- **Bound to the browser.** `POST /v1/flows` sets the `sa_flow` cookie; every other flow
  endpoint needs it (403 `flow_not_bound` without). Someone who learns a flow id can't continue
  it.
- **Same origin.** Every flow POST needs an `Origin` header equal to the public origin (403
  `origin_not_allowed`).
- **The account site's own cookies.** A verified code or provider answer for an existing account
  sets the browser session cookie `sa_session`; a new address gets a 48-hour sign-up session in
  `sa_signup`. All cookies are `HttpOnly; SameSite=Lax; Path=/` (and `__Host-` prefixed and
  `Secure` in production).
- **Responses** are `{"flow": FlowView}` with `Cache-Control: no-store`; a finished flow keeps
  answering `GET /v1/flows/{id}` with its `redirect_to`.

### FlowView

```json
{
  "id": "bujeLTroDILuAzYSBod8Lg",
  "step": "details",
  "expires_at": "2026-10-07T03:32:36.925Z",
  "app": {
    "app_id": "briefcase",
    "name": "Briefcase",
    "logo_url": "data:image/svg+xml;base64,…",
    "logo_dark_url": "data:image/svg+xml;base64,…",
    "homepage_url": "http://127.0.0.1:8593/briefcase/",
    "branding": { "theme": "auto", "font_family": "Geist", "radius": 18, "…": "…" },
    "copy": { "title": "Sign in to Briefcase", "subtitle": "Your files, for every Carbon and Silicon.", "terms_url": "…", "privacy_url": "…", "support_email": "…" },
    "first_party": false
  },
  "methods": ["google", "apple", "email", "phone"],
  "signed_in_as": {
    "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada Lovelace",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=8HV", "status": "active"
  },
  "challenge": null,
  "signup": null,
  "details": {
    "index": 0,
    "count": 1,
    "id": "details",
    "title": null,
    "subtitle": null,
    "continue_label": null,
    "layout": null,
    "fields": [
      { "field": "email", "mode": "required", "label": "Email address", "value": "a***@example.test",
        "missing": false, "shared": true, "previously_granted": false },
      { "field": "timezone", "mode": "optional", "label": "Timezone", "value": "Asia/Kolkata",
        "missing": false, "shared": false, "previously_granted": false }
    ],
    "challenge": null,
    "review_next": false
  },
  "review": null,
  "redirect_to": null,
  "error": null,
  "prompt": null,
  "intent": "signin",
  "method_hint": null
}
```

| Field | |
|---|---|
| `step` | `choose_method`, `verify_code`, `signup`, `details`, `review`, `complete` or `failed` |
| `app` | what the page needs to look like the app: name, logos, `branding`, `copy`; `first_party` is true for the account site itself |
| `methods` | the enabled methods, in the app's order (managed Google/Apple are hidden when this deployment has no credentials for them) |
| `signed_in_as` | the browser's signed-in Carbon (offered as "Continue as"), or null |
| `challenge` | at `verify_code`: `{channel, destination (masked), expires_at, resend_available_at}` |
| `signup` | at `signup`: the prefilled details `{display_name, id, timezone, dob, pfp_url, email, phone, provider, provider_pfp_url, finishing_import, imported_by, expires_at}`; `imported_by` is `{app_id, name}` of the app whose import created the account when `finishing_import` is true (it can be another app than the one being signed into), else null |
| `details` | at `details`: the page on screen. `index` and `count` are its position among the pages this sign-in shows (not every page of the flow); `id`, `title`, `subtitle`, `continue_label` and `layout` come from the app's flow step (null keeps the page's own words, and the branding's layout). `fields[]`: `{field, mode (required\|optional), label, value (contact values masked), missing (an email or phone the account doesn't have yet), shared (the checkbox: always true for required; for optional, the Carbon's answer, else whether they shared it with this app before), previously_granted}`. `challenge` is the code sent to add a missing email or phone. `review_next` is true when continuing opens the review page |
| `review` | at `review`: `{fields: [{field, mode, label, value, shared}]}`, everything the app will see: `profile` (name, id and photo) first, then each shared detail in flow order |
| `redirect_to` | at `complete`/`failed`: where to send the browser (your `redirect_uri` with `code` and `state`, or an error) |
| `error` | the last failure `{code, message, hint}` (a cancelled provider, an expired sign-up…) until the next action |
| `prompt`, `intent`, `method_hint` | from the authorize request so the page can honour them: `intent` is `signin` or `signup` (which version of the pages), `method_hint` the app's direct button (`google`/`apple` open the Opening page, `email`/`phone` their empty field). An app's `login_hint` is never stored or echoed |

### `POST /v1/flows`

Public, same origin. The body is the `/authorize` query as JSON (see
[the parameters](oauth.md#get-authorize)), plus an optional `timezone` (the browser's IANA
timezone, used to prefill sign-up). Unknown fields are ignored; empty strings count as absent;
`state` and `nonce` are kept byte for byte. `intent` is `signin` (default) or `signup`; `method`
is one enabled method. `login_hint` is accepted without an error and ignored: an app can never
hand Silicon Accounts a Carbon's email or phone, the Carbon always types it on the hosted pages.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/flows" -c jar -b jar -H "Origin: $ACCOUNTS_URL" \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"briefcase","redirect_uri":"http://127.0.0.1:8593/briefcase/callback","state":"st-123","code_challenge":"'"$CHALLENGE"'","code_challenge_method":"S256","scope":"openid email timezone","nonce":"n-456","timezone":"Asia/Kolkata"}'
```

**201** `{"flow": FlowView}` at `choose_method`, and `Set-Cookie: sa_flow=saf_…; HttpOnly;
SameSite=Lax; Path=/; Max-Age=3600`. With `prompt=none` the flow is decided at once: `complete`,
or `failed` with `error` and `redirect_to` (`login_required`, `consent_required`,
`interaction_required`), still 201.

Errors, before the redirect URI is trusted (shown as an error page, never redirected to): 400
`unknown_app`, `app_disabled`, `redirect_uri_not_registered`, `invalid_request` (no `app_id`, or
no `redirect_uri`).
After it: 400 `invalid_request` (also an `intent` other than `signin`/`signup`), `invalid_scope`, `unsupported_response_type` or
`method_not_enabled`, each with `details.redirect_to` (the RFC 6749 error redirect the page may
offer as "back to the app"). Also 403 `origin_not_allowed`, 429 `rate_limited` (300 flows per
minute per IP).

```json
{
  "error": {
    "code": "redirect_uri_not_registered",
    "message": "redirect_uri 'https://evil.example/cb' is not registered for the app 'commit': it must equal one of the app's registered redirect_uris exactly (http://localhost and http://127.0.0.1 match on any port when registered with that host).",
    "hint": "Register it in the app's sign-in setup (on developer.teamofsilicons.com, or PATCH /v1/apps/commit/signin-config with redirect_uris), or use a registered URI.",
    "details": { "app_id": "commit" }
  }
}
```

### `GET /v1/flows/{id}`

The flow. It also **claims** a Google or Apple answer that arrived for this flow: the browser
session or sign-up session is created here, on the request that carries the binding cookie, not
on the provider's callback. Errors: 404 `flow_not_found`, 403 `flow_not_bound`, 410
`flow_expired`.

### `POST /v1/flows/{id}/continue`

Continue as the browser's signed-in Carbon (`signed_in_as`). No body. Moves to `details` or
`complete`. Errors: 401 `session_required` (the browser isn't signed in), 403
`continue_not_allowed` (the app turned `remember_browser` off), 403 `reauthentication_required`
(`prompt=login`), 403 `carbon_only` (a Silicon's session), 403 `email_domain_not_allowed`, 409
`invalid_step`.

### `POST /v1/flows/{id}/switch`

"Not you?": forget the chosen account and go back to `choose_method`; the browser's account is
not offered again in this flow. At the `signup` step it ends that sign-up (its session expires
and `sa_signup` is cleared). The browser stays signed in. No body.

### `POST /v1/flows/{id}/email` and `/phone`

Send a 6-digit sign-in code. Bodies: `{"email": "ada@example.com"}` or
`{"phone": "98765 43210", "country": "IN"}` (`country` is an ISO code for local numbers; E.164
numbers like `+919876543210` need none). Moves to `verify_code` with a masked `challenge`.

```json
{
  "step": "verify_code",
  "challenge": {
    "channel": "email",
    "destination": "a***@example.test",
    "expires_at": "2026-10-07T02:42:41.426Z",
    "resend_available_at": "2026-10-07T02:33:11.426Z"
  }
}
```

Errors: 422 `invalid_email`, `invalid_phone`, `invalid_country`; 403 `method_not_enabled`; 403
`email_domain_not_allowed` (the app limits email domains); 429 `rate_limited` (10 codes per
address per 10 minutes, 30 per IP per 10 minutes); 409 `invalid_step`.

### `POST /v1/flows/{id}/resend`

A new code to the same destination (the sign-in code, or at `details` the code that adds a
missing email or phone). The old code stops working; the failure count carries over. Counts toward the send
limits. 409 `no_code_sent` when nothing was sent yet. `resend_available_at` is a hint for the
page (30 seconds after a send), not enforced.

### `POST /v1/flows/{id}/verify`

`{"code": "594873"}`. A right code:

- an active account's verified address: signs the browser in (`Set-Cookie: sa_session=…`) and
  moves on (`details` or `complete`);
- an imported account nobody finished: `signup` with `finishing_import: true`, prefilled from
  the import;
- an unknown address: a sign-up (`Set-Cookie: sa_signup=sau_…; Max-Age=172800`) and `signup`
  with the prefill: display name from the address, a free c:id from it, timezone from the IP or
  the browser, `dob` exactly 18 years ago, the default photo.

```json
{
  "step": "signup",
  "signup": {
    "display_name": "Ada",
    "id": "c:ada",
    "timezone": "Asia/Kolkata",
    "dob": "2008-10-07",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=new",
    "email": "ada@example.test",
    "phone": null,
    "provider": null,
    "provider_pfp_url": null,
    "finishing_import": false,
    "imported_by": null,
    "expires_at": "2026-10-09T02:32:46.324Z"
  }
}
```

Errors: 422 `invalid_code` (`details.remaining_attempts`; not 6 digits is also `invalid_code`,
not counted); the 10th wrong code in a row is 422 `invalid_code` with `remaining_attempts: 0`,
`details.locked_until` and `Retry-After: 60`; during the cooldown 423 `verification_locked`; 410
`code_expired` (after 10 minutes, or replaced by a resend); 409 `code_already_used`; 409
`invalid_step` (the flow isn't at `verify_code`: no code was sent); 403
`signup_not_allowed` (the app takes no new accounts); 403 `email_domain_not_allowed`; 409
`account_unavailable` (the address belongs to an account that can't sign in); 409
`flow_changed` (the flow moved in another tab). Wrong codes are counted per address, across every
flow, the CLI and the account site.

```json
{
  "error": {
    "code": "invalid_code",
    "message": "That code is wrong; 9 more tries for a***@example.test before a 60 second cooldown.",
    "hint": "Check the latest code you received and type it again.",
    "details": { "remaining_attempts": 9 }
  }
}
```

### `POST /v1/flows/{id}/signup`

Needs the flow cookie and the `sa_signup` cookie of the same browser. Every field is optional;
missing fields keep the prefill:

| Field | Rule |
|---|---|
| `display_name` | 1–100 characters after trimming, no control characters |
| `id` | a free `c:` id (a bare handle gets the prefix): handle of 3–30 `a-z 0-9 - _` |
| `timezone` | an IANA timezone |
| `dob` | `YYYY-MM-DD`, in the past and not before 1900-01-01 |
| `pfp_url` | an https URL, this sign-up's own upload, or `null` for the default photo |

Creates the Carbon (or finishes the imported one, keeping its uuid), signs the browser in
(`Set-Cookie: sa_session=…; Max-Age=77760000`), clears `sa_signup` and moves on, usually to
the first `details` page. Errors: 409 `id_taken` (`details.suggestions`), 409 `id_reserved`, 422 `invalid_id`,
422 `validation_failed`, 403 `signup_not_bound`, 410 `signup_expired`, 409
`signup_already_completed`, 403 `signup_not_allowed`.

### `POST /v1/flows/{id}/signup/photo`

The photo picked on the sign-up page, before the account exists. The raw image body, same rules
as [`POST /v1/me/photo`](accounts.md#post-v1mephoto) (PNG, JPEG, WebP or GIF, at most 2 MB, 20
per sign-up per hour). **201** `{"pfp_url", "photo": {"id", "content_type", "bytes", "width",
"height"}}`; the upload replaces the sign-up's earlier one and becomes `signup.pfp_url`.

### The details pages: `POST /v1/flows/{id}/details/…`

Every details endpoint needs the flow cookie, the `Origin` guard and the browser signed in as the
flow's account (403 `account_changed` when it is now someone else), and answers
`{"flow": FlowView}`. A page stays on screen until the Carbon continues.

**`POST /v1/flows/{id}/details/add`** `{"email": "…"}` or `{"phone": "…", "country"?: "IN"}`:
sends a 6-digit code to add an email or phone that is `missing` on the page on screen (required,
or optional). `details.challenge` then holds the masked destination. When the account already has
it (added in another tab), nothing is sent and the page shows it. Errors: 422
`validation_failed` (neither or both, or an invalid value), 409 `detail_not_on_page`, 403
`email_domain_not_allowed`, 409 `email_in_use` / `phone_in_use`, 422 `email_limit_reached` /
`phone_limit_reached`, 429 `rate_limited`.

**`POST /v1/flows/{id}/details/verify`** `{"code": "594873"}`: adds the address, verified, to the
account (its primary when it has none). The flow stays on the page, which now shows it; an
optional detail added this way starts ticked. Errors: 409 `no_code_sent`, the code errors of
`/verify` above, 409 `email_in_use` / `phone_in_use`, 409 `flow_changed`.

**`POST /v1/flows/{id}/details/continue`** `{"share": ["timezone"]}`: `share` lists the optional
details of this page the Carbon ticked (required ones are always shared and may be listed). The
answers are kept per detail, so going back keeps them. Moves to the next page, to `review`, or
completes. Errors: 409 `requirements_missing` (`details.missing`: a required email or phone of this
page isn't on the account yet), 422 `validation_failed` (`details.fields["share[0]"]`: not an
optional detail of this page, or a missing one), 409 `flow_changed` (the app changed its flow and
this page is gone: `GET /v1/flows/{id}` shows where it is now).

**`POST /v1/flows/{id}/details/back`**: the previous page this sign-in shows (also from `review`,
back to the last page), answers kept. 409 `no_previous_page` on the first page.

### `POST /v1/flows/{id}/review`

`{"approve": true}` on the review page completes the sign-in: the app is granted `profile`, every
required detail and the ticked optional ones (`openid` too when the `scope` parameter asked), and
`redirect_to` carries `code` and `state`. `{"approve": false}`, on the review page or on any
details page, is Cancel: the flow completes with `?error=access_denied`. Errors: 409
`invalid_step` (approving before the review page), 409 `requirements_missing` (a required detail
went missing meanwhile; the flow goes back to its page). Without a review page, the last
`details/continue` completes the same way.

```json
{
  "step": "complete",
  "redirect_to": "http://127.0.0.1:8593/briefcase/callback?code=sac_5DS7-pCLpVt5N5S17nJpplGuyoT8uxLWiS_TLzX1M0A&state=st-123"
}
```

### `POST /v1/flows/{id}/oauth/{provider}`

`provider` is `google` or `apple` and must be enabled for the app. **200**
`{"authorize_url": "…"}`: send the browser there. Uses the app's own Google or Apple
credentials in bring-your-own mode, ours otherwise. Errors: 404 `unknown_provider`, 403
`method_not_enabled`, 503 `provider_not_configured`.

```json
{
  "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=https%3A%2F%2Faccounts.teamofsilicons.com%2Fv1%2Foauth%2Fcallback%2Fgoogle&response_type=code&state=…&nonce=…&scope=openid+email+profile&code_challenge=…&code_challenge_method=S256&prompt=select_account"
}
```

### `GET` / `POST /v1/oauth/callback/{provider}`

Where Google and Apple send the browser back (register
`https://accounts.teamofsilicons.com/v1/oauth/callback/google` or `/apple` with the provider when
you bring your own credentials). The callback verifies the provider's answer (state, PKCE, the
`id_token` against the provider's keys, issuer, audience, expiry, nonce, a verified email) and
answers **302** to `{PUBLIC_URL}/authorize/flow/{flow_id}`; the next `GET /v1/flows/{id}` claims
the outcome. Apple's `form_post` is a cross-site POST without cookies, so it is answered **303**
to `GET /v1/oauth/callback/apple?ticket=…`, a same-site request that carries the binding cookie.
Only the browser that started the sign-in can deliver the answer: an answer from any other
browser is discarded (403 `flow_not_bound` page). A malformed `state` is a 400 `invalid_state`
page.

Failures land on the flow as `error.code`: `provider_cancelled`, `provider_error`,
`provider_token_invalid`, `provider_unavailable`, `provider_config_changed`,
`provider_answer_elsewhere`, `provider_email_invalid`, `provider_not_configured` (the
Apple key, the app's own or the managed one, can't sign a client secret), `email_not_verified`, `hosted_domain_mismatch` (the Google
account isn't in the app's `google.hosted_domain` Workspace), `account_not_active` (the identity's
account can't sign in), `email_domain_not_allowed`, `signup_not_allowed`.

## Connecting Google or Apple

### `POST /v1/me/identities/{provider}`

The account site's "Connect Google". **account (Carbon) by browser cookie**, with `Origin`.
Optional body `{"return_to": "/sign-in-methods"}` (a path or URL on the account site; that is
the default). **201** and `Set-Cookie: sa_flow=…`:

```json
{
  "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=…%2Fv1%2Foauth%2Fcallback%2Fgoogle&…",
  "flow_id": "26WRqCpcIxQtq8MHx89CRA",
  "provider": "google",
  "expires_at": "2026-10-07T03:43:19.382Z"
}
```

The browser goes to `authorize_url`; the callback links the provider account and adds its
verified email without a code, then redirects to
`return_to?linked=google&email_added=true|false`, or
`return_to?link_error={code}&provider={provider}&flow={flow_id}` when refused. Refusals change
nothing: `identity_in_use` (linked to another account), `email_in_use`, `email_limit_reached`,
`email_not_verified`, `provider_email_invalid`, `session_changed` (the browser is no longer
signed in as that Carbon), `provider_cancelled`, `provider_error`, `provider_token_invalid`.

Errors at the start: 400 `browser_session_required` (a Bearer token was used: the provider must
send a signed-in browser back), 403 `method_not_enabled` (no managed credentials), 404
`unknown_provider`, 422 `validation_failed` (`return_to`), 429 `rate_limited` (30 per account per
hour).

```json
{
  "error": {
    "code": "browser_session_required",
    "message": "Connecting Google happens in a browser: the provider sends that browser back, signed in as you. This request used an access token, not the account site's session.",
    "hint": "Open the account site's sign-in methods page and choose Connect Google."
  }
}
```

Removing a link is [`DELETE /v1/me/identities/{provider}/{subject}`](accounts.md#delete-v1meidentitiesprovidersubject).

## Browser sessions

### `GET /v1/session`

**account (cookie)**. The browser's session:

```json
{
  "account": {
    "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada King",
    "pfp_url": "https://accounts.teamofsilicons.com/v1/photos/01a11437-b512-76e4-ae95-3378b29e547e",
    "status": "active"
  },
  "session": {
    "id": "01a11434-dc55-749b-ade3-86876993bf97",
    "kind": "browser",
    "created_at": "2026-10-07T02:32:51.018Z",
    "last_seen_at": "2026-10-07T02:38:36.518Z",
    "expires_at": "2029-03-25T02:32:51.018Z"
  }
}
```

401 `unauthenticated` without a cookie, 401 `session_expired` when it was signed out, revoked or
expired.

### `POST /v1/session/signout`

Revokes the browser session. **204**, clearing `sa_session` and `sa_signup`
(`Set-Cookie: sa_session=; Max-Age=0`). Other browsers and CLI sign-ins stay signed in; list and
revoke them with [`/v1/me/sessions`](accounts.md#get-v1mesessions).

## Device approval

The account site's half of the device flow ([`POST /v1/device/authorize`](oauth.md#post-v1deviceauthorize)).
**account (Carbon)**, cookie or Bearer. User codes are matched without case, spaces or dashes.

### `GET /v1/device/{user_code}`

```json
{
  "user_code": "MVHB-KQAW",
  "client_label": "accounts CLI on build box",
  "created_at": "2026-10-07T02:36:05.176Z",
  "expires_at": "2026-10-07T02:46:05.176Z",
  "status": "pending"
}
```

### `POST /v1/device/{user_code}/approve` and `/deny`

**204**. Approving signs the waiting CLI in as you (its next poll gets first-party tokens);
denying makes its poll return `access_denied`. Errors: 404 `device_code_not_found`, 410
`device_code_expired`, 409 `device_code_used` (already decided), 403 `carbon_only`.

## CLI code sign-in

### `POST /v1/cli/login/start`

Public. `{"email": "…"}` or `{"phone": "…", "country": "IN"}`. Sends a 6-digit code (10-minute
lifetime) to a verified address of an **existing, active** Carbon. **200**
`{"challenge_id", "destination" (masked), "expires_at"}`. Unknown fields are ignored.

Errors: 404 `account_not_found` (no active Carbon signs in with it: sign up on the account site
first; the answer reveals nothing else), 400 `invalid_request` (neither email nor phone), 422
`invalid_email` / `invalid_phone`, 429 `rate_limited` (60 starts per IP per 10 minutes; 10 codes
per address per 10 minutes).

### `POST /v1/cli/login/verify`

`{"challenge_id", "code", "client_label"?}` → **200** [token response](oauth.md#the-token-response)
(`aud: "accounts"`, origin `cli_code` in the sessions list, labelled with `client_label`).
Errors: 422 `invalid_code` (`details.remaining_attempts`), 423 `verification_locked`
(`Retry-After`), 410 `code_expired`, 409 `code_already_used`, 404 `challenge_not_found`.

```json
{
  "error": {
    "code": "verification_locked",
    "message": "Too many wrong codes in a row for a***@example.test: verification is locked for 60 more seconds (until 2026-10-07T02:41:21.818Z).",
    "hint": "Wait 60 seconds, then type the code again. Every code sent to this address waits out the same cooldown.",
    "details": { "locked_until": "2026-10-07T02:41:21.818Z", "retry_after_seconds": 60 }
  }
}
```
