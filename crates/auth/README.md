# silicon-accounts-auth (`accounts_auth`)

Signing Carbons in: the hosted sign-in flow behind `/authorize`, Google and Apple, browser
sessions, the browser half of the CLI device flow and the CLI's headless code sign-in.
Contract: `understanding/UNDERSTANDING.md`; API: build spec `02-api.md` (sections marked [auth]).

```rust
let app = Router::new().merge(accounts_auth::router());           // routes below
let tasks = accounts_auth::spawn_background(state.clone());        // sweep of expired flows
```

## Endpoints

| route | auth | does |
|---|---|---|
| `POST /v1/flows` | public, same Origin | validates the authorize request, creates the flow (60 min), sets `sa_flow`, `201 {"flow": FlowView}` |
| `GET /v1/flows/{id}` | flow | the flow; also **claims** a Google/Apple outcome (sets `sa_session` / `sa_signup`, see below) |
| `POST /v1/flows/{id}/continue` | flow + session | continue as the browser's Carbon |
| `POST /v1/flows/{id}/switch` | flow | forget the chosen account → `choose_method` (the browser's account is not offered again). At the `signup` step ("Not you?") that sign-up ends: its session expires (no later flow resumes it), its photo upload is dropped and `sa_signup` is cleared when it names that sign-up (a newer sign-up of the same browser keeps its cookie). A signed-in browser stays signed in |
| `POST /v1/flows/{id}/email` · `/phone` | flow | send a 6-digit sign-in code (`{"email"}` · `{"phone","country"?}`) → `verify_code` |
| `POST /v1/flows/{id}/resend` | flow | new code to the same destination (sign-in code, or the requirement code) |
| `POST /v1/flows/{id}/verify` | flow | `{"code"}` → signs in / sign-up / finishing an import |
| `POST /v1/flows/{id}/oauth/{google\|apple}` | flow | `{"authorize_url"}` |
| `GET\|POST /v1/oauth/callback/{google\|apple}` | the starting browser | provider answer → 302 `{PUBLIC_URL}/authorize/flow/{id}`; a cookieless form_post → 303 `GET …?ticket=` (see below); a connection (next row) → 302 back to its `return_to` |
| `POST /v1/me/identities/{google\|apple}` | session (Carbon, browser cookie + Origin) | connect Google/Apple to the signed-in Carbon (the account site's "Connect Google"): optional `{"return_to":"/sign-in-methods"}` (a path or URL on the site; default `/sign-in-methods`) → 201 `{"authorize_url","flow_id","provider","expires_at"}` + `sa_flow`. The browser navigates to `authorize_url`; the callback connects the provider account to this Carbon and adds its verified email **without a code** (UNDERSTANDING.md), then redirects to `return_to?linked={provider}&email_added=true\|false`, or `return_to?link_error={code}&provider={provider}&flow={flow_id}` (`GET /v1/flows/{flow_id}` → step `complete` with `error{code,message,hint}`). Refusals change nothing: `identity_in_use` (connected to another account), `email_in_use`, `email_limit_reached`, `email_not_verified`, `provider_email_invalid`, `session_changed` (the browser is no longer signed in as that Carbon), `provider_cancelled` / `provider_error` / `provider_token_invalid`. Errors at the start: 400 `browser_session_required` (an access token, not the site's cookie), 403 `method_not_enabled` (no managed Google/Apple credentials), 404 `unknown_provider`, 422 `return_to`, 429 after 30 per hour |
| `POST /v1/flows/{id}/signup/photo` | flow + `sa_signup` | the photo picked on the sign-up page, before the account exists: raw image, same rules as `POST /v1/me/photo` (≤ 2 MB, PNG/JPEG/WebP/GIF, 20 per sign-up per hour) → 201 `{"pfp_url","photo":{…}}`; replaces the sign-up's earlier upload and becomes `signup.pfp_url` |
| `POST /v1/flows/{id}/signup` | flow + `sa_signup` | create the Carbon (or finish the imported one) |
| `POST /v1/flows/{id}/requirements/email` · `/phone` · `/verify` | flow + session | add a missing required detail with an inline code |
| `POST /v1/flows/{id}/consent` | flow + session | `{"approve","optional_scopes"}` → code (or `error=access_denied`) |
| `GET /v1/session`, `POST /v1/session/signout` | session | the browser session; sign-out clears `sa_session` + `sa_signup` (204). Without a live session: 401, and stale cookies are cleared only for the site's own pages (Origin passes the CSRF guard): a cross-site form POST carries no SameSite=Lax cookie, but its browser would apply a clearing Set-Cookie (logout CSRF) |
| `GET /v1/device/{user_code}`, `POST …/approve`, `POST …/deny` | session (Carbon) | CLI device approval (204) |
| `POST /v1/cli/login/start`, `POST /v1/cli/login/verify` | public | headless code sign-in → token response (aud = `accounts`) |

Every flow POST passes the CSRF Origin guard (`origin_not_allowed`); every flow endpoint needs
the binding cookie (`flow_not_bound`), and so does the provider callback (see Google and Apple).
Responses carrying flow state are `Cache-Control: no-store`.

## The flow

```text
choose_method ──email/phone──▶ verify_code ──┐
      │  └──google/apple (callback + claim)──┼──▶ signup (new / finishing an import, 48 h sign-up session)
      └──continue as the browser's Carbon ───┤        │
                                             ▼        ▼
                                  requirements ──▶ consent ──▶ complete (code, or error=access_denied)
prompt=none that can't sign in silently ──────────────────────▶ failed (error redirect)
```

- **Consent** is skipped when the membership is active and already grants profile + required +
  details asked for in `scope`, unless `prompt=consent`; never shown for app `accounts` (which also
  creates no membership). Optional = the app's `optional_fields` plus `scope` details that aren't
  required; `consent.optional[].granted` is the toggle's initial state (granted before, or asked for).
- **Requirements**: only email/phone can be missing (a verified primary is needed); dob and timezone
  always exist. A flow never stays stuck there: when nothing is missing any more (added in another
  tab or on the account site, or the app stopped requiring it), `GET /v1/flows/{id}` and the
  requirement send endpoints move it on (consent or complete), for the browser signed in as the
  flow's account.
- **prompt**: `login` ignores the browser session; `consent` forces the screen; `select_account` shows
  the chooser (it is always shown when the browser is signed in — flows never auto-continue);
  `none` completes silently or ends `failed` with `login_required` / `consent_required` /
  `interaction_required` and `redirect_to = redirect_uri?error=…&state=…`.
- **Sign-up prefill**: display name (provider name → email local part → `Carbon 1234`), id
  (`repo::accounts::suggest_id` from the email local part then the name), timezone (IP header →
  browser `timezone` sent to `POST /v1/flows` → UTC), dob (exactly 18 years before the Carbon's own today, counted in the prefilled timezone: just after midnight in Kolkata it is still yesterday in UTC), photo (our default Carbon
  photo from Iris, as UNDERSTANDING.md says; a Google picture is offered separately as
  `signup.provider_pfp_url` and stored only when sent back as `pfp_url`; a photo uploaded with
  `POST …/signup/photo` replaces the default as the prefill). The only photo of this service a
  sign-up may use is its own upload (`POST …/signup/photo`): it becomes the new (or finished
  imported) account's own upload; any other photo of this service is refused (422; keeping an
  imported account's current photo is fine). `POST …/signup` fields are
  all optional: missing ones keep the prefill; `pfp_url: null` = our default photo (the upload is
  dropped). Uploads of sign-ups that expire or finish without them are swept. A live sign-up
  session resumes in a new flow in the same browser (48 h), when the app allows sign-up, has the
  method enabled and accepts the email domain.
- **Only verified emails and phones identify an account** (core's `repo::contacts::lookup` /
  `after_proof`). The one exception is an imported account nobody finished yet (`unclaimed`):
  proving one of its addresses finishes it. Any other unverified row is *unproven* and never signs
  anyone in (hosted codes, Google/Apple email linking, CLI code sign-in); whoever proves such an
  address takes it over (the row is removed from the other account, audit
  `contact.unverified_removed`). Core keeps unverified rows on unfinished imports only.
- **Imported (unclaimed) accounts** go to sign-up with `finishing_import: true`, prefilled from the
  account the import created, and `imported_by: {app_id, name}` naming the app whose import created
  it (the earliest `import` membership; it may differ from the app being signed into, so the page
  never credits the wrong app); completing keeps the uuid and runs core's
  `repo::accounts::finish_claim`: the proven email/phone becomes verified (primary if the old
  primary wasn't), **the import's other (unproven) emails and phones are removed** (the app keeps
  them in `memberships.imported_profile`), and the account is activated; this crate changes the
  id/profile (member apps get webhooks). The claim only holds while the account is unclaimed: other sign-ups that pointed
  at it become ordinary sign-ups of their own proven address (they never see the finished account's
  data); in an app that takes no new accounts such a sign-up ends with `signup_not_allowed` and the
  flow goes back to the methods.
- **Codes** (core's `repo::otp`): the 10-tries lockout counts per address, not per flow. Wrong
  codes of every live code to the same email/phone (any flow, the CLI, requirements, the account
  site's add codes) add up; the 10th in a row locks all of them for 60 s
  (`details.remaining_attempts` counts down for the address), and while one is locked no code to the
  address is checked (423). A right code ends the streak. Sends to one address are serialized, so
  the 10-per-10-minutes limit holds under bursts. When a lock starts on a sign-in code for an
  account's address, its sign-in history gets a `failed` row and the audit log `signin.locked`.
- **auth_time**: a browser session records when its Carbon last proved who they are
  (`authenticated_at`: a code, Google, Apple or a finished sign-up moves it, also when the session
  is reused). The authorization code carries it, so the id_token's `auth_time` is the real
  authentication (continue-as and `prompt=none` keep the earlier time).
- **App rules**: `allowed_email_domains` (checked before sending a code, at verify, for provider
  emails, and for "continue as": a verified email in the domains), `allow_signup: false` (new accounts
  refused after the code proves the address: `signup_not_allowed`; imported accounts still finish).

### FlowView

As in 02-api.md, plus `prompt`, `login_hint` and `method_hint` (so the SPA can honour them), and
`signup.provider_pfp_url` (the Google picture the page may offer). `state` and `nonce` are stored
and echoed exactly as sent (never trimmed; control characters are refused).
`consent.required` starts with `profile`; email/phone values are masked like code destinations.
`redirect_to` is set at `complete`/`failed` (the stored copy is keyring-encrypted: it holds a code).
`error` carries the last failure (provider cancelled, `signup_expired`, …) until the next action.

### Errors (selection)

`unknown_app` · `app_disabled` · `redirect_uri_not_registered` (400, never offers a redirect; also
any `redirect_uri` with a `#fragment`, RFC 6749 §3.1.2, which the loopback any-port rule would
otherwise let through) ·
`invalid_scope` / `invalid_request` / `unsupported_response_type` / `method_not_enabled` (400, with
`details.redirect_to` = the RFC 6749 error redirect) · `flow_not_found` 404 · `flow_not_bound` 403 ·
`flow_expired` 410 · `invalid_step` / `flow_completed` / `flow_failed` 409 · `invalid_code` 422
(`details.remaining_attempts`) · `verification_locked` 423 · `code_expired` 410 · `rate_limited` 429
(`Retry-After`) · `email_domain_not_allowed` 403 · `signup_not_allowed` 403 · `signup_not_bound` 403 ·
`signup_expired` 410 · `id_taken` 409 (`details.suggestions`) · `validation_failed` 422 ·
`requirements_missing` 409 · `email_in_use` / `phone_in_use` 409 · `session_required` 401 ·
`account_changed` 409 · `continue_not_allowed` / `reauthentication_required` 403 ·
`provider_not_configured` 503 · `unknown_provider` 404. Callback pages: `invalid_state` 400,
`flow_not_bound` 403 (an answer delivered by another browser); flow errors include
`provider_answer_elsewhere`, `provider_cancelled`, `provider_error`, `provider_token_invalid`,
`provider_unavailable`.

## Google and Apple

- Start: state = `{flow_id}.{32 random bytes}` (only its HMAC is stored), nonce, PKCE S256 (Google;
  verifier keyring-encrypted), redirect_uri `{PUBLIC_URL}/v1/oauth/callback/{provider}`. Google:
  `scope=openid email profile`, `prompt`/`hd` from the app config, `login_hint` passed through.
  Apple: `response_mode=form_post`, `scope=name email`.
- Credentials: `mode: managed` → `ACCOUNTS_GOOGLE_*` / `ACCOUNTS_APPLE_*`; `mode: byo` → the app's
  client id/Services ID from its config and the secret/.p8 key from `app_signin_configs` (keyring).
  Missing → 503 `provider_not_configured`.
- Callback: the leg is single use; the code is exchanged (Google: client_secret_post + verifier;
  Apple: ES256 client secret JWT `kid`=key id, `iss`=team, `sub`=Services ID, `aud`=Apple issuer,
  5 min); the id_token is verified against the provider JWKS (cached per URL, refetched on unknown
  `kid`; RS256/ES256 only; iss, aud, exp/nbf ±60 s, nonce, `email_verified` true/"true", Google `hd`).
  Resolution: known (provider, sub) → its account; else a verified email of an account → linked;
  else sign-up (Google name + picture, Apple `user` name on first login). Failures become the flow's
  `error`; the browser always lands on `/authorize/flow/{id}`.
- **A provider request that gets no answer at all is sent once more on a new connection**
  (`providers::send`: the code exchange and the JWKS fetch). The usual cause is a kept-alive
  connection the provider already closed: servers drop idle connections after seconds (Node after
  5 s), reqwest's pool reuses them for 90 s, and the request dies with "connection closed before
  message completed". The provider never saw it, so the code is still unused (had it seen it, the
  second exchange is refused with `invalid_grant`). Timeouts are not retried. `provider_unavailable`
  and the logs carry the whole cause chain, e.g. `tcp connect error: Connection refused`, and say
  when it was tried twice.
- **Only the browser that started the sign-in can deliver the answer.** The callback request must
  carry the flow's binding cookie (`sa_flow`, SameSite=Lax). A Google redirect is a top-level GET,
  so it does. Apple's form_post is a cross-site POST, which doesn't: its answer is parked on the leg
  (keyring-encrypted) and the browser is sent `303` to `GET /v1/oauth/callback/apple?ticket=…` (a
  one-time ticket, only its HMAC stored), a same-site GET that carries the cookie and is checked the
  same way. An answer delivered by any other browser is discarded (403 `flow_not_bound` page; the
  leg is used up so it can't be replayed; the flow shows `provider_answer_elsewhere`). Without this
  a genuine Google/Apple link forwarded to a victim would sign the sender in as the victim, and a
  stolen answer could be used for login CSRF.
- **Why the callback sets no cookies**: the verified outcome is recorded on the flow
  (`provider_state.pending`); the next request carrying the binding cookie — normally the SPA's
  `GET /v1/flows/{id}` — creates the browser session or the sign-up session.
- A provider answer refused by the app's rules (domains, Workspace domain, unverified email) for an
  identity already linked to an account is recorded in that account's sign-in history (`failed`,
  audit `signin.refused`).

## Storage

Owns `signin_flows` and `signup_sessions` (and sets `browser_sessions.authenticated_at` /
`authorization_codes.auth_time`, migration 0002). Flow fields without a column live as JSON in
`signin_flows.provider_state` (`FlowExtras`: provider leg, pending outcome, error, browser timezone,
auth method, …). The binding cookie value is reused for every flow of a browser, so parallel
sign-ins stay bound. History: `signin_history` at completion (method email/phone/google/apple/
session, outcome success/new_account), on a declined consent, on a code lockout and on a refused
provider answer for a linked identity (outcome failed); `audit_log` (`account.created`,
`account.claimed`, `identity.linked`, `contact.added`, `contact.unverified_removed`,
`signin.locked`, `signin.refused`, `session.signed_out`, `session.created`, `device.approved|denied`).

## Tests

```bash
scripts/dev-db.sh   # Postgres on 127.0.0.1:5444
CARGO_TARGET_DIR=target/auth cargo test -p silicon-accounts-auth
```

`tests/common/mock_oidc.rs` is an in-process Google/Apple (token + JWKS, strict about client auth,
redirect_uri, PKCE and the ES256 client secret); `tests/common/dropping_front.rs` puts an HTTP/1.1
front before it that closes a kept-alive connection, unanswered, when a request is reused on it.
`tests/testkit_contract.rs` runs the same legs against the real testkit mock-oidc (`node --import tsx src/start.ts` on free ports); it is skipped
(with a note on stderr) when `testkit/node_modules` is missing. Test keys in `tests/fixtures/` are
throwaway, test-only keys.
