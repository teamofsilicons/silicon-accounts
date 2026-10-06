# silicon-accounts-core (`accounts_core`)

The shared foundation of the Silicon Accounts service. Every server crate (auth, oauth, account,
silicons, apps, proofs, worker, server) builds on it, and feature crates never depend on each
other. Everything shared lives here: configuration, the database and migrations, the API error
shape, account ids and uuids, cryptography, JWTs, models, views, input normalization,
repositories, webhook events, email/SMS delivery, telemetry and the HTTP extractors.

Contract: `understanding/UNDERSTANDING.md`. Build spec: `00-overview.md`, `01-schema.sql`, `02-api.md`.

```toml
# your crate's Cargo.toml
[dependencies]
silicon-accounts-core.workspace = true
axum.workspace = true

[dev-dependencies]
silicon-accounts-core = { workspace = true, features = ["test-support"] }
tokio.workspace = true
```

## A handler, end to end

```rust
use accounts_core::http::{CarbonAuth, ClientMeta, IdempotencyKey, Json, Path};
use accounts_core::ids::AccountId;
use accounts_core::repo::{accounts, audit, idempotency};
use accounts_core::{events, ApiError, ApiResult, AppState};
use axum::{extract::State, http::StatusCode, response::Response, routing::post, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/me/id", post(change_my_id))
}

#[derive(Deserialize, Serialize)]
struct ChangeId { id: String }

async fn change_my_id(
    State(state): State<AppState>,
    me: CarbonAuth,                       // 401/403 handled; cookie mutations pass the CSRF guard
    meta: ClientMeta,
    key: Option<IdempotencyKey>,
    Json(body): Json<ChangeId>,           // 400 invalid_json / 422 validation_failed with paths
) -> Result<Response, ApiError> {
    let scope = idempotency::scope(&format!("account:{}", me.uuid()), "POST", "/v1/me/id");
    idempotency::run(&state.db, key.as_deref(), &scope, &body, false, || async {
        let new_id = AccountId::parse_for_kind(&body.id, me.kind())
            .map_err(|e| accounts::invalid_id_error(&e))?;                   // 422 invalid_id
        let mut tx = state.db.begin().await?;
        let change = accounts::change_id(&mut tx, me.uuid(), &new_id, me.uuid()).await?; // 409 id_taken / id_reserved
        if change.changed {
            events::notify_id_changed(&mut tx, &change.account, &change.old_id, &change.new_id).await?;
        }
        audit::record(&mut tx, &audit::AuditEntry {
            account_uuid: Some(me.uuid()), ip: meta.ip.as_deref(),
            ..audit::AuditEntry::new(accounts_core::models::ActorKind::Account, Some(me.uuid()), "account.id.changed")
        }).await?;
        tx.commit().await?;
        let view = accounts_core::views::load_me(&mut *state.db.acquire().await?, &change.account).await?;
        Ok((StatusCode::OK, serde_json::to_value(view)?))
    }).await
}
```

## Conventions (read these)

- **Connections.** Repository functions take `&mut PgConnection`: pass `&mut tx` (from
  `state.db.begin()`) or `&mut conn` (from `state.db.acquire()`). Multi-statement functions open a
  nested transaction themselves (a savepoint inside yours), so they are atomic either way.
  Functions that must persist a failure even when the request fails take `&PgPool` and commit on
  their own: `otp::verify`, `tokens::refresh`, `tokens::consume_code`, `tokens::consume_slt`,
  `tokens::poll_device`, `accounts::record_stk_failure`, `idempotency::*`. Never call those inside
  your own transaction.
- **SQL.** sqlx 0.9 runtime queries only (no `query!` macros). `sqlx::query(...)` takes a
  `&'static str`; for built strings wrap in `sqlx::AssertSqlSafe(...)` (and never interpolate input).
  Column lists for `concat!`: `accounts_core::account_columns!()`, `app_columns!()`,
  `membership_columns!()` (field order of `Account`, `App`, `Membership`).
- **Time.** TTLs are enforced with Postgres `now()` so tests can time-travel by editing rows.
  JSON timestamps are RFC 3339 UTC with milliseconds: every `OffsetDateTime` field in a view needs
  `#[serde(with = "accounts_core::timefmt::rfc3339_ms")]` (`rfc3339_ms_option`), every `Date`
  `#[serde(with = "accounts_core::timefmt::date")]` (`date_option`). The `time` crate's own serde
  format is not the API format.
- **Errors.** Return `ApiResult<T>` / `Result<_, ApiError>`. Messages say exactly what and why; add
  a `.hint(...)` with the next step. `?` converts `sqlx::Error` (500 or 503), `serde_json::Error`,
  `anyhow::Error`, `CryptoError`, `JwtError`, `ContactError` (422). `/v1/oauth/*` uses `OAuthError`.
- **Events.** Emit webhooks with `events::*` inside the same transaction as the change.
- **Secrets.** Never log tokens, codes, STKs, secrets or Authorization headers. Store only
  `state.keys.pepper.hash(token)`; encrypt read-back secrets with `state.keys.keyring`.
- **Vocabulary.** Carbons and Silicons; never "user/human/AI", "org/team", "frontend/backend" in
  copy, messages or docs.

## Module map

| module | what | key items |
|---|---|---|
| `config` | `ACCOUNTS_*` settings, dev defaults, production refusals | `Settings::from_env`, `Settings::for_tests`, `Settings::from_lookup`, `VARIABLES`, `DEV_*` |
| `state` | shared state | `AppState { db, settings, keys, http, sender, app_cache, telemetry }`, `Keys { pepper, keyring, jwt, stk }` |
| `db` | pool + embedded migrations | `connect`, `connect_url`, `migrate` → `MigrationReport`, `pending_migrations`, `ping`, `MIGRATOR` |
| `error` | API errors | `ApiError`, `ApiResult`, `FieldErrors`, `OAuthError` |
| `ids` | uuid scramble, `c:`/`si:` ids, suggestions | `uuid_for_number`, `number_for_uuid`, `AccountId`, `IdError`, `validate_handle`, `handle_candidates`, `pick_available`, `membership_id`, `validate_app_id` |
| `crypto` | tokens, pepper, keyring, STK, PKCE, codes, signatures | `random_token` + `prefix::*`, `Pepper`, `Keyring`, `stk::{generate, normalize, StkHasher}`, `pkce::*`, `generate_otp`, `generate_user_code`, `normalize_user_code`, `webhook_signature`, `verify_webhook_signature`, `describe_token`, `constant_time_eq` |
| `jwt` | Ed25519 JWTs | `JwtKeys` (`sign_access`, `verify_access`, `sign_id_token`, `verify`, `jwks`), `AccessClaims`, `IdTokenClaims`, `parse_private_key` |
| `models` | enums + rows + sign-in config | `Account`, `App`, `Membership`, `AccountKind`, `AccountStatus`, `Scope`, `ContactField`, `Method`, `TokenOrigin`, `OtpPurpose`, `AccountField`, `SigninConfig`, `Branding`, … |
| `views` | API shapes | `AccountSummary`, `MeView` + `load_me`, `AccountForApp` + `load_account_for_app`, `TokenResponse`, `AppSummary`, `Page<T>` |
| `normalize` | input rules | `normalize_email`, `normalize_phone`, `normalize_timezone`, `validate_display_name`, `validate_dob`, `default_dob`, `parse_date_flexible`, `validate_https_url`, `validate_pfp_url`, `validate_webhook_url`, `is_public_ip`, `mask_email`, `mask_phone`, `display_name_from_email/phone` |
| `pfp` | default photos | `default_pfp_url(iris, kind, uuid)`, `is_default_pfp` |
| `repo::accounts` | accounts and ids | `create_carbon`, `create_silicon`, `get`, `require`, `lock`, `by_handle`, `by_email`, `by_phone`, `by_uuid_or_id`, `id_availability`, `is_id_free`, `suggest_ids`, `suggest_id`, `change_id`, `update_profile`, `bump_version`, `set_status`, `set_custodian`, `set_stk`, `record_stk_failure`, `clear_stk_failures`, `set_silicon_webhook`, `delete_account`, `release_silicon`, `count/list_silicons_in_custody`, `active_reservation`, `reservations_of`, `invalid_id_error` |
| `repo::contacts` | emails/phones | `list_emails`, `list_phones`, `primary_email`, `primary_phone`, `owner`, `check_can_add`, `add_verified(_email/_phone)`, `mark_verified`, `set_primary(_email/_phone)`, `remove(_email/_phone)`, `verified_emails` |
| `repo::identities` | Google/Apple links | `find`, `link`, `touch`, `list_for_account`, `remove` |
| `repo::apps` | apps | `get`, `require_active`, `owned_by`, `signin_row` → `AppSigninRow`, `effective_config`, `webhook_target`, `AppCredentialCache`, `AppAuthError`, `unknown_app`, `app_disabled` |
| `repo::memberships` | `{app_id}:{uuid}` | `get`, `upsert_signin` (+`GrantMode`), `upsert_imported`, `list_for_account`, `remove_access`, `webhook_targets` |
| `repo::tokens` | grants | `issue_tokens`, `refresh`, `verify_access_token`, `create_family`, `find_family`, `family_for_refresh_token`, `revoke_family`, `revoke_families` (+`RevokeFilter`), `list_families`, `count_active_families`, `create_code`/`consume_code`, `create_slt`/`consume_slt`, `create_device`/`device_by_user_code`/`decide_device`/`poll_device`, `GrantError` |
| `repo::sessions` | browser sessions | `create`, `lookup`, `get`, `touch`, `revoke`, `revoke_all`, `list_active` |
| `repo::otp` | 6-digit codes | `send`, `verify` (+`Expect`), `get`, `purge` |
| `repo::rate_limit` | fixed windows | `enforce`, `enforce_pool`, `hit`, `bucket`, `limits::*`, `purge` |
| `repo::idempotency` | Idempotency-Key | `run`, `scope`, `begin`/`complete`/`abandon`, `request_hash`, `purge` |
| `repo::audit` | history | `record(AuditEntry)`, `signin(SigninRecord)`, `handle_history`, `method::*`, `outcome::*` |
| `events` | webhooks | `notify_id_changed`, `notify_profile_updated`, `account_deleted`, `membership_signed_out`, `signed_out_for_families`, `membership_access_removed`, `notify_custodian_changed`, `emit_to_app`, `emit_to_silicon`, `ping_app`, `ping_silicon`, `current_url`, `current_secret`, `new_webhook_secret`, `retry_delay_seconds`, header constants |
| `delivery` | email/SMS | `enqueue`, `enqueue_otp`, `spawn_deliver`, `deliver_now`, `claim_due`, `deliver_claimed`, `Sender`, `PostmarkSender`, `TwilioSender`, `LocalSender`, `templates::*`, `extract_code` |
| `telemetry` | Space Station + logs | `Telemetry::record`, `init_logging` |
| `http` | extractors and helpers | `AccountAuth`, `CarbonAuth`, `SiliconAuth`, `AppAuth`, `AppOrOwner`, `authenticate_client`, `ClientMeta`, `IdempotencyKey`, `Json`, `Query`, `Path`, `parse_form_or_json`, `check_origin`, `cookies::*`, `pagination::*`, `request_id::middleware` |
| `test_support` (feature) | tests | `TestContext`, `TestDb`, `Req`, `call`, factories |

Constants: `FIRST_PARTY_APP_ID = "accounts"`, `PRODUCT_NAME`, `PRODUCT_SITE`, `VERSION`.

## config / state

`Settings::from_env()` loads `.env` (unless the process env says production), reads all 51
variables (`config::VARIABLES`, documented in `/.env.example`) and returns every problem at once.
Without a `.env`, development uses built-in DEV ONLY secrets, so local runs work out of the box.
Production refuses: missing/dev pepper, keyring or JWT key; `ACCOUNTS_DELIVERY=local`; no Postmark
token; `ACCOUNTS_EXPOSE_DEV_OUTBOX=true`; a non-https public URL; insecure cookies; non-contract
TTLs (`OTP_TTL 600`, `OTP_LOCK 60`, `ACCESS_TOKEN_TTL 1800`).

Useful methods: `settings.issuer()`, `settings.url("/v1/photos/x")`, `settings.public_origin`,
`settings.is_allowed_origin(o)`, `settings.allowed_origins()`, `settings.google.managed_configured()`,
`settings.apple.managed_configured()`, `settings.email_delivery_configured()`,
`settings.sms_delivery_configured()`, `settings.dev_outbox_enabled()`. Secrets are
`secrecy::SecretString` (`use accounts_core::secrecy::ExposeSecret;`).

`AppState::new(settings, pool)` builds keys, the shared `reqwest::Client` (10 s timeout, no
redirects), the sender for the delivery mode, the app credential cache and telemetry.
`state.keys.pepper`, `state.keys.keyring`, `state.keys.jwt`, `state.keys.stk` (Argon2id params).

## error

```rust
ApiError::not_found("unknown_app", format!("No app with app_id '{id}' exists."))
    .hint("Check the app_id; apps are created in Silicon Apps.")
    .detail("app_id", id);
ApiError::conflict("id_taken", "...").detail("suggestions", vec!["c:saket-2"]);
ApiError::rate_limited("Too many ...", 42);            // 429 + Retry-After + details.retry_after_seconds
ApiError::locked("verification_locked", "...", 60);    // 423 + Retry-After
let mut f = FieldErrors::new(); f.add("branding.radius", "must be between 0 and 40");
f.into_result()?;                                      // 422 validation_failed, details.fields
ApiError::internal(err);                               // logs err; body never leaks it; adds details.request_id
OAuthError::invalid_grant("The authorization code expired ...");  // {"error","error_description"}
```

Constructors: `bad_request`, `invalid_request`, `unauthenticated`, `forbidden`, `not_found`,
`conflict`, `gone`, `unprocessable`, `validation`, `locked`, `rate_limited`, `unavailable`,
`internal`. `OAuthError`: `invalid_request`, `invalid_client` (401 + `WWW-Authenticate`),
`invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`,
`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, `server_error`.
Responses always echo `X-Request-Id` (install `http::request_id::middleware`, the server does).

## ids

- `uuid_for_number(n)` / `number_for_uuid(s)`: the tiered scramble from the spec; tier-3 starts
  at `uuid_for_number(0) == "zQo"`. The constants are fixed forever. `create_carbon/silicon` call it
  with `nextval('account_number_seq')`; nobody else needs to.
- `AccountId::parse("C:Saket")` → `c:saket`; `AccountId::parse_for_kind("scout", AccountKind::Silicon)`
  → `si:scout` (a bare handle gets the prefix; the wrong prefix is an error). `IdError` explains
  exactly why (`Empty`, `MissingPrefix`, `WrongKind`, `TooShort`, `TooLong`, `InvalidChar` with
  position, `ReservedWord`); `.reason()` is `invalid` | `reserved_word`; `.hint()`.
  `id.to_string()` / `as_full()` is what `accounts.handle` stores; `id.handle()` has no prefix.
- `handle_candidates(&[email_local, name])` yields `base`, other bases, `base-2..base-20`, then
  `base-NNNN`; `repo::accounts::suggest_id(s)` checks them against the database (taken + live
  reservations) in batches.

## crypto / jwt

```rust
let token = crypto::random_token(crypto::prefix::REFRESH);   // "sar_" + 43 chars
let hash = state.keys.pepper.hash(&token);                  // store this (bytea)
let enc = state.keys.keyring.encrypt_str(&secret)?;          // version || nonce || ciphertext
let secret = state.keys.keyring.decrypt_string(&enc)?;
let stk = crypto::stk::generate();                           // "stk-" + 12 hex (show once)
let stk = crypto::stk::normalize(input).map_err(|m| ApiError::unprocessable("invalid_stk", m))?;
let phc = state.keys.stk.hash(&stk)?;                         // Argon2id
crypto::stk::StkHasher::verify(&stk, &phc);                   // bool
crypto::pkce::verify(Some("S256"), verifier, challenge);
crypto::generate_otp();                                      // "042424"
crypto::webhook_signature(&secret, unix_ts, &body_bytes);    // "v1=<hex>"
```

Webhook signature key = the full secret string including `whsec_`, message = `"{ts}.{raw body}"`.
`describe_token("sar_…")` → "a refresh token" for precise "wrong kind of credential" messages.

`state.keys.jwt.jwks()` is the `/.well-known/jwks.json` body. `sign_access(&AccessTokenInput{..})`
returns `(jwt, AccessClaims)`; `verify_access(token, Some(aud))` checks signature, `kid`, `iss`,
`exp`/`nbf` (30 s leeway) and audience (`JwtError::WrongAudience { expected, got }`). Most code
should call `repo::tokens::verify_access_token` instead (also checks the family and the account).

## models

All enums (`AccountKind`, `AccountStatus`, `AppStatus`, `AppSource`, `MembershipStatus`,
`MembershipSource`, `TokenOrigin`, `VerifiedVia`, `Provider`, `Method`, `ContactField`, `Scope`,
`OtpPurpose`, `OtpChannel`, `MessageChannel`, `WebhookTargetKind`, `ActorKind`, `AccountField`, and
the branding enums) serialize as their snake_case text in JSON and in Postgres (`.bind(kind)` and
`FromRow` just work), have `as_str()`, `parse()`, `FromStr`, `ALL` and `expected()`.

- `Scope::parse_list("openid email")` (unknown → error naming them), `parse_list_lenient`,
  `normalize_scopes` (dedupe, sort, always `profile`), `scopes_to_string`, `scope_strings` /
  `scopes_from_strings` for `text[]` columns (bind `Vec<String>`).
- `Account` (`id()`, `display_id()`, `is_active()`, `membership_id(app)`; `Debug` hides secrets),
  `App` (`is_active()`, `is_first_party()`), `Membership` (`scopes()`, `is_live()`),
  `AccountEmail`, `AccountPhone`, `Identity`.
- `AccountField::required_scope()` says which scope sees a change (`None` = profile).

### SigninConfig

```rust
let row = repo::apps::signin_row(&mut conn, app_id).await?;           // stored doc + encrypted secrets
let cfg = repo::apps::effective_config(&mut conn, &state.settings, app_id).await?; // + first-party rules
cfg.available_methods(&state.settings);   // enabled, in order; managed Google/Apple hidden without creds
cfg.redirect_allowed(&state.settings, app_id, redirect_uri);   // exact match, loopback any-port rule, first-party origin rule
cfg.requires(ContactField::Phone); cfg.email_domain_allowed(email);
// PATCH: deep-merge (objects merge, arrays/scalars replace, null resets to default), unknown keys
// rejected, type errors and validation keyed by path; strip BYO secrets from the body first.
let updated = cfg_stored.apply_patch(&patch_without_secrets, secrets_present)
    .map_err(ApiError::validation)?;
```

`SigninConfig::from_stored(&json)` never fails; `parse_strict` validates a full document;
`validate` checks colours (`#RRGGBB`), WCAG contrast ≥ 3:1 for `primary_foreground`/`primary` and
`foreground`/`background` in both themes (message includes the measured ratio), font allowlist,
radius 0..40, logo height 16..96, https/data-image logos, background image required for
`image`, redirect URIs (https; http only on localhost/127.0.0.1/[::1]; reverse-domain native
schemes), origins, disjoint required/optional fields, domains, copy lengths, BYO requirements
(`google.client_id` + `google.client_secret`; `apple.services_id`/`team_id`/`key_id` + `apple.private_key`).
`first_party_redirect_allowed(settings, uri)` compares parsed origins.

## views

- `AccountSummary::from_account(&a)` — `{uuid, kind, id, display_name, pfp_url, status}`.
- `views::load_me(&mut conn, &account)` → `MeView` (Carbon: emails, phones, identities,
  custodian_of; Silicon: custodian, webhook_url, stk_rotated_at).
- `views::load_account_for_app(&mut conn, &account, app_id, &scopes)` → `AccountForApp` (email/
  phone/dob/timezone only with their scope; Silicons never show email/phone and always carry
  `custodian`). `AccountForApp::build(...)` when you already have the data; `.userinfo_json()` adds
  the OIDC aliases for `/v1/userinfo`.
- `TokenResponse` — built by `repo::tokens::issue_tokens` / `refresh`.
- `Page<T>` with `http::pagination::{PageParams, paginate, encode_cursor, decode_cursor}`: fetch
  `limit()+1` rows ordered by a stable key, then `paginate(rows, limit, |r| (r.created_at_str, r.id))`.

## repo::accounts — ids and lifecycle

- `create_carbon(&mut conn, &settings, NewCarbon { id, display_name, pfp_url: None, dob, timezone,
  status: Active|Unclaimed, emails: vec![NewContact { value, verified_via: Some(VerifiedVia::Code) }],
  phones, actor })` → `Account`. The first email/phone becomes primary. `verified_via: None` =
  unverified (imports). Errors: `invalid_id` (422), `id_taken` (409, `details.suggestions` ×3),
  `id_reserved` (409, `details.reserved_until`), `email_in_use` / `phone_in_use` (409).
- `create_silicon(&mut conn, &settings, NewSilicon { id, display_name, pfp_url, timezone, status:
  Active (with custodian_uuid) | PendingCustodian, custodian_uuid, stk_hash, webhook_url,
  webhook_secret_enc, actor })` — dob = today; `stk_rotated_at` = now.
- `id_availability(&mut conn, "c:saket", requester_uuid)` → `IdAvailability { id, available, reason:
  taken|reserved|reserved_word|invalid|None, message, reclaimable }` — exactly the
  `GET /v1/ids/available` body (invalid input is a 200 answer, not an error).
- `change_id(&mut conn, uuid, &new_id, actor)` → `IdChange { account, old_id, new_id, changed,
  reclaimed }`: old id reserved 10 days for this account, reclaiming one's own reserved id deletes
  the reservation, `version` bumps, `handle_history` written; same id = `changed: false`. Then
  `events::notify_id_changed`.
- `update_profile(&mut conn, uuid, &ProfileUpdate { display_name, timezone, dob, pfp_url })` →
  `(Account, Vec<AccountField>)` — only real changes, version bump, a Silicon's dob is immutable
  (422 `dob_immutable`). Validate inputs with `normalize::*` first. Then
  `events::notify_profile_updated(&mut tx, &account, &changed)`.
- `bump_version` after app-visible changes stored elsewhere (new primary email/phone), then
  `events::account_updated(&mut tx, &account, &[AccountField::Email])`.
- `delete_account(&mut conn, uuid, actor, reserve_id)` → `DeletedAccount`: status deleted, handle
  null (reserved 10 days when `reserve_id`), emails/phones/identities removed, sessions + token
  families + OBO proofs revoked, pending custodian requests cancelled, STK + Silicon webhook cleared,
  memberships kept as history. Check "custodian of Silicons" (`count_silicons_in_custody`) before
  calling and emit `events::account_deleted` after. `release_silicon` = delete without reservation
  (declined/expired initial custodian request).
- Silicon helpers: `set_stk` (returns `stk_rotated_at`, resets failures), `record_stk_failure(&pool,
  uuid, 10, 60)` → `Some(locked_until)` when this failure locked login, `clear_stk_failures`,
  `set_silicon_webhook(&mut conn, uuid, url, secret_enc)`, `set_custodian(&mut conn, silicon,
  carbon, AccountStatus::Active)`, `set_status`.

## repo::contacts

`check_can_add(&mut conn, ContactKind::Email, uuid, email)` before sending a code (409
`email_in_use`, 409 `email_already_added`, 422 `email_limit_reached` at 10); after the code
verifies, `add_verified(...)` / `add_verified_email(&mut conn, uuid, email, VerifiedVia::Code)` →
`AddOutcome { became_primary, was_unverified }` (re-checks everything under a row lock). Imported
unverified rows pass the check and become verified. `set_primary` (404 `{kind}_not_found`, 409
`{kind}_not_verified`; returns false if already primary). `remove` (409 `cannot_remove_primary`).
Error codes use `email`/`phone` prefixes. Values must be normalized first.

## repo::apps — credentials

`state.app_cache.verify(&state.db, &state.keys.pepper, app_id, secret)` → `App` or `AppAuthError`
(`.to_api()` / `.to_oauth()`); successes are cached 60 s keyed by `(app_id, HMAC(secret))`. **Call
`state.app_cache.invalidate(app_id)` whenever an app's secret or status changes.** The extractors
use it for you.

## repo::memberships

- `upsert_signin(&mut conn, app_id, uuid, MembershipSource::Signin|Slt, &scopes, GrantMode::Replace|Union)`
  — active, sign-in times, granted scopes (Replace for the consent screen, Union for SLT/continue-as).
- `upsert_imported(&mut conn, app_id, uuid, external_id, imported_profile, overwrite)` — status
  `imported` unless already active; 409 `external_id_conflict`.
- `remove_access(&mut conn, app_id, uuid, actor)` → `AccessRemoved` (membership `access_removed`,
  the app's families revoked, OBO proofs that app issued about the account revoked). Then
  `events::membership_access_removed`.
- `webhook_targets(&mut conn, uuid)` — live members (active/imported) of active apps with a webhook.

## repo::tokens — grants

```rust
// Any successful sign-in (code exchange, SLT, device, CLI code, Silicon login):
let resp: TokenResponse = tokens::issue_tokens(&mut tx, &state.keys, &state.settings, tokens::IssueRequest {
    account: &account, app_id, origin: TokenOrigin::Slt, scopes: &scopes,
    browser_session_id: None, label: Some("accounts CLI on mac"), ip, user_agent, nonce: None,
}).await?;   // family (900 days) + refresh token + access JWT + id_token if `openid` + scoped account view

// grant_type=refresh_token (pool, not a transaction):
let resp = tokens::refresh(&state.db, &state.keys, &state.settings, refresh_token, &client.app.app_id)
    .await.map_err(|e| e.to_oauth())?;   // reuse → GrantError::Reused (family revoked)

// grant_type=authorization_code:
let code = tokens::consume_code(&state.db, &state.keys.pepper, code, app_id, redirect_uri, code_verifier)
    .await.map_err(|e| e.to_oauth())?;   // single use; any failure burns it; PKCE when challenged
// …then issue_tokens with label: Some(&code.family_label()) so a reused code revokes these tokens.

// SLTs and device codes:
let (slt, expires_at) = tokens::create_slt(&mut conn, &state.keys.pepper, &uuid, app_id, &scopes).await?;
let slt_row = tokens::consume_slt(&state.db, &state.keys.pepper, slt, app_id).await.map_err(|e| e.to_oauth())?;
let start = tokens::create_device(&mut conn, &state.keys.pepper, Some(label)).await?;  // DeviceStart
tokens::decide_device(&mut conn, user_code, &me_uuid, approve).await?;
let approved = tokens::poll_device(&state.db, &state.keys.pepper, device_code).await.map_err(|e| e.to_oauth())?;
```

`verify_access_token(&mut conn, &state.keys, jwt, Some(app_id))` → `VerifiedAccess { claims,
family, account }` with 401 `invalid_token` / `token_wrong_audience` / `token_revoked` /
`account_deleted`. `revoke_families(&mut conn, &RevokeFilter { account_uuid, app_id, origin, except },
reason)` returns the revoked families → `events::signed_out_for_families(&mut tx, &families,
signout_reason::STK_ROTATED)`. `family_for_refresh_token` for revoke/introspect.

## repo::otp

```rust
let created = otp::send(&mut tx, &state.keys.pepper, &state.settings, &otp::NewChallenge {
    purpose: OtpPurpose::Signin, channel: OtpChannel::Email, destination: &email,
    account_uuid: None, flow_id: Some(&flow.id), ip: meta.ip.as_deref(),
}).await?;                                  // 429 rate_limited after 10 per destination / 10 min (30 per IP)
let msg_id = delivery::enqueue_otp(&mut tx, &state.settings, &created.challenge, &created.code, Some(&app.name)).await?;
tx.commit().await?;
delivery::spawn_deliver(&state, msg_id);    // send now; the worker retries
// later
let ch = otp::verify(&state.db, &state.keys.pepper, &state.settings, challenge_id, code,
    &otp::Expect { purpose: Some(OtpPurpose::Signin), flow_id: Some(&flow.id), ..Default::default() }).await?;
```

Verify responses: wrong code → 422 `invalid_code` with `details.remaining_attempts` (9..1); the
10th wrong code in a row → 422 `invalid_code`, `remaining_attempts: 0`, `details.locked_until`,
`Retry-After: 60`; any attempt during the cooldown → 423 `verification_locked`; expired or replaced
by a resend → 410 `code_expired`; reused → 409 `code_already_used`; unknown or bound elsewhere →
404 `challenge_not_found`; not 6 digits → 422 `invalid_code` (not counted). A resend retires the
previous code and carries the failure streak and cooldown. `challenge.masked_destination()`,
`challenge.resend_available_at()` (UI hint, +30 s) for FlowView.

## repo::rate_limit / idempotency / audit

- `rate_limit::enforce(&mut conn, &rate_limit::bucket("ids_available:ip", ip), rate_limit::limits::IDS_AVAILABLE_PER_IP, "id lookups from this network")`
  → 429 with `Retry-After`. Limits: `IDS_AVAILABLE_PER_IP` 120/min, `SILICON_SELF_CREATE_PER_IP`
  10/h, `REPORTS_PER_IP` 5/h, `OTP_SEND_PER_IP` 30/10 min (applied by `otp::send`),
  `SILICON_LOGIN_PER_IP` 60/min, `TELEMETRY_PER_IP` 120/min. Use `enforce_pool` outside transactions.
- `idempotency::run(&state.db, key.as_deref(), &scope, &body, secret_bearing, || async { Ok((status, json)) })`
  — replay with `Idempotent-Replayed: true`, 409 `idempotency_key_reused`, 409
  `idempotency_in_progress`, 24 h window (10 min when `secret_bearing`), errors not stored.
  Scope = `idempotency::scope("account:{uuid}" | "app:{app_id}" | "ip:{ip}", "POST", route)`.
- `audit::record(&mut conn, &AuditEntry { … })` (dotted actions such as `silicon.stk.rotated`,
  `app.signin_config.updated`; never secrets in `details`), `audit::signin(&mut conn, &SigninRecord
  { account_uuid, app_id, method: audit::method::EMAIL, outcome: audit::outcome::SUCCESS, ip, user_agent })`.
  `handle_history` is written by the accounts repo.

## events

Call inside the transaction of the change. Each returns the `EmittedEvent`s it stored.

| change | call |
|---|---|
| id changed | `events::notify_id_changed(&mut tx, &account, old, new)` (apps `account.id_changed` + Silicon `silicon.id_changed`) |
| profile changed | `events::notify_profile_updated(&mut tx, &account, &changed)` (apps that can see a changed field; Silicon `silicon.updated`) |
| primary email/phone changed | `events::account_updated(&mut tx, &account, &[AccountField::Email])` |
| account deleted | `events::account_deleted(&mut tx, uuid)` |
| signed out / families revoked | `events::membership_signed_out(&mut tx, app, uuid, signout_reason::APP_REVOKED)` / `signed_out_for_families` |
| access removed | `events::membership_access_removed(&mut tx, app, uuid)` |
| transfer accepted | `events::notify_custodian_changed(&mut tx, &silicon, &from, &to)` |
| Silicon lifecycle | `events::emit_to_silicon(&mut tx, uuid, types::SILICON_CREATED / SILICON_CUSTODIAN_ACCEPTED / _DECLINED / _EXPIRED / SILICON_STK_ROTATED, json!({...}))` |
| test buttons | `events::ping_app`, `events::ping_silicon` |

The worker: deliveries are rows in `webhook_deliveries` (`pending`); body = `webhook_events.payload`
serialized; headers `events::HEADER_*`, `User-Agent: events::USER_AGENT`; sign with
`crypto::webhook_signature(&events::current_secret(..)?, ts, body)`; post to
`events::current_url(..)` (replays go to the current URL); 2xx within 10 s = delivered; retry with
`events::retry_delay_seconds(attempts)` until `GIVE_UP_AFTER_HOURS` (72) → `failed`. New secrets:
`events::new_webhook_secret(&state.keys.keyring)` → `(whsec_…, ciphertext)`.

## delivery

`enqueue(&mut tx, &settings, &NewMessage { channel, to, subject, text_body, html_body, purpose })`
→ id (status `local` in local mode — never sent, shown by the dev outbox; `pending` with
providers). After commit: `spawn_deliver(&state, id)`. Worker: `claim_due(&pool, 50)` then
`deliver_claimed(&pool, state.sender.as_ref(), &settings, &msg)` (retries with backoff, OTP
messages stop retrying once their code would have expired). Templates: `templates::otp_email`,
`otp_sms`, `custodian_request_email`, `custodian_invite_email`, `custodian_transfer_email`,
`bug_report_email` (subjects/text/html). `extract_code(text)` finds the 6-digit code (dev outbox).
Postmark posts to `{ACCOUNTS_POSTMARK_API_URL}/email`; Twilio to
`{ACCOUNTS_TWILIO_API_URL}/2010-04-01/Accounts/{sid}/Messages.json`.

## http

- `AccountAuth` — cookie `sa_session` (`__Host-sa_session` when secure) or `Bearer` access token with
  `aud = accounts` and an active family. Cookie-authenticated POST/PUT/PATCH/DELETE must carry an
  allowed `Origin` (403 `origin_not_allowed`). `auth.uuid()`, `auth.kind()`, `auth.account`,
  `auth.session_id()`, `auth.family_id()`, `auth.is_cookie()`. `Option<AccountAuth>` for optional
  auth (a dead cookie = anonymous; a bad Bearer = 401).
- `CarbonAuth` / `SiliconAuth` deref to `AccountAuth` (403 `carbon_only` / `silicon_only`).
- `AppAuth { app }` — `Authorization: Basic base64(app_id:secret)`.
- `authenticate_client(&state, &headers, form.client_id, form.client_secret)` → `ClientAuth { app,
  public }` for `/v1/oauth/*` (Basic or body; `client_id=accounts` alone = the public first-party
  client: allow it only for the device-code, refresh and CLI grants of `accounts`).
- `AppOrOwner { app, actor }` on routes with `{app_id}`: the app's credentials (403 `app_mismatch`
  for another app) or its owner's session (403 `not_app_owner`, 404 `unknown_app`).
  `history_actor()` → `"app"` | owner uuid; `audit_actor()`.
- `ClientMeta { ip, user_agent, ip_timezone, origin }` — serve with
  `into_make_service_with_connect_info::<SocketAddr>()`; with ACCOUNTS_TRUST_FORWARDED_FOR the IP is
  the right-most `X-Forwarded-For` entry.
- `Json<T>` (in and out), `Query<T>`, `Path<T>` — rejections are `ApiError`s naming the field.
  `parse_form_or_json::<T>(&headers, &bytes)` for the token endpoint (wrap the `String` error in
  `OAuthError::invalid_request`).
- Cookies: `cookies::session_cookie(&settings, &token)`, `flow_cookie`, `signup_cookie`,
  `clear_cookie(&settings, cookies::SESSION_COOKIE)`, `read_cookie(&headers, &settings, base)`,
  `append_cookie(response.headers_mut(), &cookie)`.
- `check_origin(&settings, &headers, &method)` for custom cookie-based endpoints.
- `request_id::middleware` (layer once), `request_id::current()`, `RequestId` extractor.

## test_support (feature `test-support`)

```rust
use accounts_core::test_support::{TestContext, Req, CarbonSpec};

#[tokio::test]
async fn my_endpoint() {
    let ctx = TestContext::new().await;                  // fresh accounts_test_<rand> DB, migrated; dropped at the end
    let carbon = ctx.carbon().await;                     // active, random c:t-xxxx, verified t-xxxx@example.test
    let named = ctx.carbon_with(CarbonSpec { handle: Some("saket".into()), ..Default::default() }).await;
    let (silicon, stk) = ctx.silicon(&carbon.uuid).await;
    let (app, secret) = ctx.app_owned("briefcase", Some(&carbon.uuid)).await;   // app_id "briefcase-<rand>"
    let whsec = ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/x/webhooks").await;
    ctx.membership(&app.app_id, &carbon.uuid, &[Scope::Profile, Scope::Email]).await;
    let token = ctx.first_party_tokens(&carbon).await.access_token;              // aud = accounts
    let cookie = ctx.browser_session(&carbon).await;

    let r = ctx.call(crate::router(), Req::get("/v1/me").bearer(&token)).await;
    assert_eq!(r.status, 200);
    let r = ctx.call(crate::router(), Req::post("/v1/me/x").session(&ctx.state.settings, &cookie).json(json!({}))).await;
    assert_eq!(r.error_code(), Some("validation_failed"));
    let r = ctx.call(crate::router(), Req::get(&format!("/v1/apps/{}", app.app_id)).basic(&app.app_id, &secret)).await;
    ctx.exec("update otp_challenges set locked_until = now()").await;  // time travel
    let sent = ctx.outbox("t-xxxx@example.test").await;                // (purpose, text) newest first
}
```

The test state uses `Settings::for_tests()` (environment `test`, local delivery, dev keys, worker
off, telemetry off) and fast Argon2 parameters. Databases live on `ACCOUNTS_TEST_ADMIN_URL`
(default `postgres://postgres@127.0.0.1:5444/postgres`; start it with `scripts/dev-db.sh`).

## Commands

```bash
scripts/dev-db.sh                                            # Postgres on 127.0.0.1:5444 + silicon_accounts
CARGO_TARGET_DIR=target/core cargo test -p silicon-accounts-core     # unit tests + database tests (needs dev-db)
cargo run -p silicon-accounts-server --bin accounts-migrate  # applies migrations/ and prints each version
```

## Gotchas

- `memberships.granted_scopes`, `token_families.scopes` etc. are `text[]`: bind `Vec<String>`
  (`scope_strings`) and read `Vec<String>` (`scopes_from_strings`).
- Account uuids are case-sensitive (`text collate "C"`); ids (`c:`/`si:`) are stored lowercase.
- `c:saket` and `si:saket` are different ids; reserved words apply to both.
- The first-party app `accounts` exists after migration; its redirect URIs are not stored
  (`SigninConfig::effective` + `redirect_allowed` handle it) and it never shows consent.
- Contract numbers live in code: OTP 600 s / 60 s lock / 10 tries / 10 sends per 10 min;
  access token 1800 s; refresh 900 days; codes and SLTs 120 s; device codes 600 s (poll 5 s);
  id reservations 10 days; 10 emails and 10 phones.
