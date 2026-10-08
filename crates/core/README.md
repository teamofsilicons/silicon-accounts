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
    idempotency::run(&state, key.as_deref(), &scope, &body, false, || async {
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
  `tokens::poll_device`, `accounts::begin_stk_attempt`, `accounts::stk_attempt_failed`,
  `idempotency::begin`/`complete`/`abandon`. Never call those inside your own transaction.
- **Locks.** A function that row-locks and then fails ends its savepoint itself (rollback), so a
  caller that keeps its connection never holds a lock it doesn't know about. Lock order
  everywhere: custodian requests, then account rows (the Silicon before its custodian), then
  membership rows.
- **SQL.** sqlx 0.9 runtime queries only (no `query!` macros). `sqlx::query(...)` takes a
  `&'static str`; for built strings wrap in `sqlx::AssertSqlSafe(...)` (and never interpolate input).
  Column lists for `concat!`: `accounts_core::account_columns!()`, `app_columns!()`,
  `membership_columns!()` (field order of `Account`, `App`, `Membership`).
- **Time.** Every expiry, lock and window stored in the database is stamped and compared with
  Postgres `now()` (the repository selects `expires_at <= now()` rather than comparing with the
  node's clock), so tests can time-travel by editing rows and node clock skew doesn't matter. A
  JWT's own `exp`/`nbf` are checked with the node's clock (as JWTs are; 30 s leeway on `nbf`).
  `stk_rotated_at` is `clock_timestamp()` (the moment the rotation holds the row lock).
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
| `crypto` | tokens, pepper, keyring, STK, PKCE, codes, signatures | `random_token` + `prefix::*`, `Pepper`, `Keyring`, `stk::{generate, normalize, StkHasher}` (`hash_async`, `verify_async`, `burn_async` on the blocking pool), `pkce::*`, `generate_otp`, `generate_user_code`, `normalize_user_code`, `webhook_signature`, `verify_webhook_signature`, `describe_token`, `constant_time_eq` |
| `jwt` | Ed25519 JWTs | `JwtKeys` (`sign_access`, `verify_access`, `verify_access_ignoring_expiry` (revocation only), `sign_id_token`, `verify`, `jwks`), `AccessClaims`, `IdTokenClaims`, `parse_private_key` |
| `models` | enums + rows + sign-in config | `Account`, `App`, `Membership`, `AccountKind`, `AccountStatus`, `Scope`, `ContactField`, `Method`, `TokenOrigin`, `OtpPurpose`, `AccountField`, `SigninConfig`, `Branding`, … |
| `views` | API shapes | `AccountSummary`, `MeView` + `load_me`, `AccountForApp` + `load_account_for_app`, `TokenResponse`, `AppSummary`, `Page<T>` |
| `normalize` | input rules, the webhook SSRF guard | `normalize_email`, `normalize_phone`, `normalize_timezone`, `validate_display_name`, `validate_dob`, `default_dob`, `parse_date_flexible`, `validate_https_url`, `validate_pfp_url`, `validate_webhook_url`, `is_public_ip`, `resolve_checked` (+ `BlockedAddress`, `LookupFailed`), `MAX_URL_LEN`, `mask_email`, `mask_phone`, `display_name_from_email/phone` |
| `pfp` | photo URLs | `default_pfp_url(iris, kind, uuid)`, `is_default_pfp`, `photo_url_prefix`, `photo_url`, `photo_ref` → `PhotoRef::{External, Exact, Inexact}` |
| `image` | photo bytes | `inspect(bytes, declared)` → `ImageInfo` (PNG/JPEG/GIF/WebP by their bytes, dimensions from the headers), `ImageKind`, `ImageError`, `MAX_DIMENSION`, `MAX_PIXELS` |
| `photo_upload` | reading a photo upload | `read(&headers, body, route)` → `UploadedPhoto { bytes, info }` (`fingerprint()` for idempotency, `view(id)` for responses), `MAX_PHOTO_BYTES`, `count_account_upload` (20/hour per uploader), `count_signup_upload` (20/hour per sign-up), `too_large` |
| `repo::accounts` | accounts and ids | `create_carbon`, `create_silicon`, `get`, `require`, `lock`, `by_handle`, `by_email`/`by_phone` (any row: uniqueness only), `by_uuid_or_id`, `id_availability`, `id_availability_for` (for a Silicon its custodian manages), `is_id_free`, `suggest_ids`, `suggest_id`, `change_id` (+ `ID_CHANGES_PER_DAY`), `update_profile`, `bump_version`, `set_status`, `set_custodian`, `finish_claim`, `set_stk`, `begin_stk_attempt` → `StkAttempt`, `stk_attempt_failed`, `clear_stk_failures` (+ `MAX_STK_FAILURES`, `STK_LOCK_SECONDS`), `set_silicon_webhook`, `delete_account` → `DeletedAccount`, `release_silicon`, `count/list_silicons_in_custody`, `active_reservation`, `reservations_of`, `invalid_id_error` |
| `repo::contacts` | emails/phones | `lookup` → `Holder` (who an address signs in to), `after_proof`, `prove`, `drop_unverified`, `list_emails`, `list_phones`, `primary_email`, `primary_phone`, `owner`, `check_can_add`, `add_verified(_email/_phone)`, `mark_verified`, `set_primary(_email/_phone)`, `remove(_email/_phone)`, `verified_emails` |
| `repo::photos` | uploaded photos | `insert_for_account`, `check_usable` (an account's own or its custodian's upload), `prune`; sign-up uploads: `insert_for_signup`, `signup_photo`, `check_usable_for_signup`, `attach_signup_photo`, `discard_signup_photos`, `sweep_signup_photos` |
| `repo::identities` | Google/Apple links | `find`, `link`, `touch`, `list_for_account`, `remove` |
| `repo::apps` | apps | `get`, `require_active`, `owned_by`, `signin_row` → `AppSigninRow`, `effective_config`, `webhook_target`, `AppCredentialCache`, `AppAuthError`, `unknown_app`, `app_disabled` |
| `repo::memberships` | `{app_id}:{uuid}` | `get`, `upsert_signin` (+`GrantMode`), `upsert_imported`, `list_for_account`, `remove_access`, `webhook_targets` |
| `repo::tokens` | grants | `issue_tokens`, `refresh`, `verify_access_token`, `create_family`, `find_family`, `family_for_refresh_token`, `revoke_family`, `revoke_families` (+`RevokeFilter`), `list_families`, `count_active_families`, `create_code`/`consume_code`, `create_slt`/`consume_slt`, `create_device`/`device_by_user_code`/`decide_device`/`poll_device`, `GrantError` |
| `repo::sessions` | browser sessions | `create`, `lookup`, `get`, `touch`, `mark_authenticated`, `authenticated_at`, `revoke`, `revoke_all`, `list_active` |
| `repo::otp` | 6-digit codes | `send`, `verify` (+`Expect`, `Attempt`), `get`, `purge` |
| `repo::rate_limit` | fixed windows | `enforce`, `enforce_pool`, `hit`, `peek` (no count), `take` (weighted), `bucket`, `limits::*`, `purge` |
| `repo::idempotency` | Idempotency-Key | `run` (sealed when secret-bearing), `scope`, `begin`/`complete`/`abandon`, `seal`/`unseal`, `request_hash`, `purge` |
| `repo::audit` | history | `record(AuditEntry)`, `signin(SigninRecord)`, `handle_history`, `method::*`, `outcome::*` |
| `events` | webhooks | `notify_id_changed`, `notify_profile_updated`, `account_deleted`, `membership_signed_out`, `signed_out_for_families`, `membership_access_removed`, `notify_custodian_changed`, `silicon_custodian_declined`, `silicon_custodian_expired`, `emit_to_app`, `emit_to_silicon`, `ping_app`, `ping_silicon`, `current_url`, `current_secret`, `new_webhook_secret`, `retry_delay_seconds`, `signout_reason::*`, `declined_reason::*`, header constants |
| `delivery` | email/SMS | `enqueue`, `enqueue_otp`, `spawn_deliver`, `deliver_now`, `claim_due`, `deliver_claimed` (claim-checked), `CLAIM_SECONDS`, `Sender`, `PostmarkSender`, `TwilioSender`, `LocalSender`, `templates::*`, `extract_code` |
| `telemetry` | Space Station + logs | `Telemetry::record`, `record_progress`, `Telemetry::capturing` (tests), `request_opts_out(&headers)` (`X-Accounts-Telemetry: off` or cookie `sa_telemetry=off`), `with_request_opt_out` (the server wraps each request; every event recorded inside an opted-out request is dropped), `init_logging` |
| `http` | extractors and helpers | `AccountAuth`, `CarbonAuth`, `SiliconAuth`, `AppAuth`, `AppOrOwner`, `authenticate_client`, `ClientMeta`, `IdempotencyKey`, `Json`, `Query`, `Path`, `parse_form_or_json`, `check_origin`, `cookies::*`, `pagination::*`, `request_id::middleware` |
| `test_support` (feature) | tests | `TestContext`, `TestDb`, `Req`, `call`, factories |

Constants: `FIRST_PARTY_APP_ID = "silicon-accounts"`, `DEVELOPER_APP_ID = "developer"` (and
`is_first_party_app_id`), `PRODUCT_NAME`, `PRODUCT_SITE` (`https://accounts.teamofsilicons.com`),
`VERSION`. Settings: `developer_url` (ACCOUNTS_DEVELOPER_URL), `developer_callback_url()`,
`developer_redirect_allowed(uri)`.

## config / state

`Settings::from_env()` loads `.env` (unless the process env says production), reads all 51
variables (`config::VARIABLES`, documented in `/.env.example`) and returns every problem at once.
Without a `.env`, development uses built-in DEV ONLY secrets, so local runs work out of the box.
Production refuses: missing/dev pepper, keyring or JWT key; `ACCOUNTS_DELIVERY=local`; no Postmark
token; `ACCOUNTS_EXPOSE_DEV_OUTBOX=true`; `ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=true` (the SSRF guard
off); a non-https public URL; insecure cookies; non-contract TTLs (`OTP_TTL 600`, `OTP_LOCK 60`,
`ACCESS_TOKEN_TTL 1800`).

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
  → `si:scout` (a bare handle gets the prefix; the wrong prefix is an error). The handle is checked
  as written: only ASCII letters, digits, `-` and `_` (no Unicode case folding: `c:\u{212A}elvin`
  is refused, not read as `c:kelvin`). `IdError` explains exactly why (`Empty`, `MissingPrefix`,
  `WrongKind`, `TooShort`, `TooLong`, `InvalidChar` with position, `ReservedWord`); `.reason()` is
  `invalid` | `reserved_word`; `.hint()`.
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
let phc = state.keys.stk.hash_async(stk.clone()).await?;     // Argon2id on the blocking pool
crypto::stk::StkHasher::verify_async(stk, phc).await;         // bool (also off the runtime)
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
`verify_access_ignoring_expiry(token)` checks signature, `kid` and `iss` only: for revoking a
sign-in with an access token that already expired, never to authorize a request.

Debug output of `TokenResponse`, `otp::CreatedChallenge` and `tokens::DeviceStart` redacts the
tokens and codes they carry (like `Account`, `Pepper` and `Keyring`).

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
`validate` checks colours (`#RRGGBB`), WCAG contrast ≥ 4.5:1 (AA for text, `MIN_TEXT_CONTRAST`)
for `primary_foreground`/`primary` (button text) and `foreground`/`background` (page text) in both
themes (message includes the measured ratio), font allowlist,
radius 0..40, logo height 16..96, https/data-image logos, background image required for
`image`, redirect URIs (https; http only on localhost/127.0.0.1/[::1]; reverse-domain native
schemes), origins, disjoint required/optional fields, domains, copy lengths (`copy.opening_title`
≤ 80 with only the `{provider}`/`{app}` placeholders, `signup_title` ≤ 80, `signup_subtitle` ≤ 200),
BYO requirements (`google.client_id` + `google.client_secret`; `apple.services_id`/`team_id`/`key_id`
+ `apple.private_key`), and the `flow` (1 to 8 steps, ids `[a-z0-9-]{1,40}` unique, every requested
detail on exactly one step and nothing else, no empty step, short plain titles, subtitles and
continue labels, `layout` null or card|split|minimal; errors keyed `flow.steps[i].fields[j]` etc.).
`effective_flow()` is the flow a sign-in walks: the app's own, or (`flow: null`) one step `details`
with the required then the optional details and no review page. The PATCH merge keeps `flow`
valid when the details change without it: a detail no longer requested leaves its step, an emptied
step is dropped (no step left = `null`), a newly requested detail joins the last step; a PATCH that
carries `flow` is validated exactly as sent.
`first_party_redirect_allowed(settings, uri)` compares parsed origins.

Default palettes (`Palette::default_light`, `default_dark`): filled buttons are the brand blue
`#1F5FB8` under `#FFFDF9` text in both themes (6.1:1). The dark default was `#5B8FE0` (3.2:1 under
`#FFFDF9`, below AA); migration 0003 moved every stored config still carrying that old default pair
to `#1F5FB8` (a new config version and a `system` history entry). `#5B8FE0` remains the site's ink
for links and accents on dark surfaces, not a fill. Error text (`danger`) meets 4.5:1 on the card
and the page in both themes: the dark default is `#FF8A80` (5.45:1 on `#353432`); migration 0004
moved stored configs that still paired the old `#F97066` (4.46:1) with the default dark card.

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
  unverified, allowed only for an `Unclaimed` (imported) account. Errors: `invalid_id` (422),
  `email_limit_reached` / `phone_limit_reached` (422, more than 10 of a kind), `id_taken` (409,
  `details.suggestions` ×3), `id_reserved` (409, `details.reserved_until`), `email_in_use` /
  `phone_in_use` (409).
- `create_silicon(&mut conn, &settings, NewSilicon { id, display_name, pfp_url, timezone, status:
  Active (with custodian_uuid) | PendingCustodian, custodian_uuid, stk_hash, webhook_url,
  webhook_secret_enc, actor })` — dob = today; `stk_rotated_at` = now.
- `id_availability(&mut conn, "c:saket", requester_uuid)` → `IdAvailability { id, available, reason:
  taken|reserved|reserved_word|invalid|None, message, reclaimable }` — exactly the
  `GET /v1/ids/available` body (invalid input is a 200 answer, not an error).
- `change_id(&mut conn, uuid, &new_id, actor)` → `IdChange { account, old_id, new_id, changed,
  reclaimed }`: old id reserved 10 days for this account, reclaiming one's own reserved id deletes
  the reservation, `version` bumps, `handle_history` written; same id = `changed: false`. **At most
  `ID_CHANGES_PER_DAY` (5) changes per rolling 24 hours** per account, whoever makes them (a
  Silicon's custodian too) and reclaims included, counted under the row lock: 429 `rate_limited`
  with `Retry-After` and `details.{limit, window_seconds, retry_at}`. Then `events::notify_id_changed`.
- `update_profile(&mut conn, uuid, &ProfileUpdate { display_name, timezone, dob, pfp_url })` →
  `(Account, Vec<AccountField>)` — only real changes, version bump, a Silicon's dob is immutable
  (422 `dob_immutable`). Validate inputs with `normalize::*` first, and a photo of this service
  with `repo::photos::check_usable`. Then `events::notify_profile_updated(&mut tx, &account, &changed)`.
- `bump_version` after app-visible changes stored elsewhere (new primary email/phone), then
  `events::account_updated(&mut tx, &account, &[AccountField::Email])`.
- `by_email` / `by_phone` match **any** row, verified or not: uniqueness checks only. Who an
  address signs in to is `repo::contacts::lookup`.
- `finish_claim(&mut conn, uuid, &[(ContactKind::Email, "a@x.test", VerifiedVia::Code)])` →
  `ClaimFinished { account, changed }`: finishes an `unclaimed` (imported) Carbon for the Carbon who
  proved those addresses — they become verified (primary when the primary of their kind wasn't),
  **every other unverified email/phone is removed** (an unproven address must never sign anyone in),
  status `active`, `version` bumps when an address changed. Profile/id changes and the webhooks
  (`notify_profile_updated` with `changed` + the profile fields) are the caller's. 409
  `account_not_unclaimed` when someone finished it already.
- `delete_account(&mut conn, &settings, uuid, actor, reserve_id)` → `DeletedAccount { before, old_id,
  revoked_families, revoked_proofs, deleted_photos, released_silicons, deleted_now }`, one
  transaction: status deleted, handle null (reserved 10 days when `reserve_id`), emails/phones/
  identities removed, sessions + token families (`account_deleted`) + User verification proofs revoked (with
  `proof.revoked` audit rows), the photo back to the Iris default and uploads nobody else shows
  deleted, memberships kept as history without `imported_profile` (the app's `external_id` stays),
  STK cleared, the Silicon webhook **kept** (events emitted before still reach it), pending custodian
  requests cancelled, and `events::account_deleted` emitted. A Carbon who is still custodian of a
  Silicon that isn't deleted is refused: 409 `custodian_of_silicons` (`details.silicons`), checked
  under its row lock. Self-created Silicons waiting for this Carbon are told
  (`silicon.custodian.declined`, reason `custodian_account_deleted`) and released
  (`released_silicons`; audit `silicon.custodian_request.closed`). Lock order: pending requests
  addressed to the account, then the account. Idempotent (`deleted_now: false`).
- `release_silicon(&mut conn, uuid, actor)` → `Option<old id>`: a self-created Silicon that never
  became active (declined, expired, named Carbon deleted) is deleted with its id freed at once (no
  reservation), its STK cleared, its webhook kept, still-pending requests cancelled. `None` (and
  nothing done) unless it is `pending_custodian`. Decline/expiry order: decide the request, emit
  `events::silicon_custodian_declined` / `_expired` (while it still has its id), then release.
- Silicon sign-in lock: `begin_stk_attempt(&pool, uuid, MAX_STK_FAILURES, STK_LOCK_SECONDS)` →
  `StkAttempt::Check { attempt }` (counted before the STK is checked, so parallel guesses get at
  most 10 checks per lock window) or `StkAttempt::Locked { retry_after_seconds }`; verify with
  `StkHasher::verify_async`; then `clear_stk_failures` on success or
  `stk_attempt_failed(&pool, uuid, attempt, 10, 60)` → `Some(locked_until)` when it locked.
- Silicon helpers: `set_stk` (returns `stk_rotated_at` = `clock_timestamp()` under the row lock,
  resets failures), `set_silicon_webhook(&mut conn, uuid, url, secret_enc)`, `set_custodian(&mut
  conn, silicon, carbon, AccountStatus::Active)`, `set_status`.

## repo::contacts

Only the addresses an app import attached to an account nobody finished yet (`unclaimed`) are
unverified. `lookup(&mut conn, ContactKind::Email, email)` → `Holder::{Free, Active(account),
Unclaimed(account), Unavailable(account), Unproven(account)}` is the one lookup to authenticate
with: a verified address of an active Carbon signs it in, an unfinished import's address finishes
it, an unverified row anywhere else (`Unproven`) identifies nobody. `after_proof(...)` is the same
once the Carbon proved the address, and first removes an unproven row (audit
`contact.unverified_removed`), so the prover can have it. `prove(&mut conn, kind, uuid, value,
via)` → primary changed? (verified, added when missing, primary when the primary wasn't verified).
`drop_unverified(&mut conn, uuid)` → fields whose primary changed.

`check_can_add(&mut conn, ContactKind::Email, uuid, email)` before sending a code (409
`email_in_use`, 409 `email_already_added`, 422 `email_limit_reached` at 10); after the code
verifies, `add_verified(...)` / `add_verified_email(&mut conn, uuid, email, VerifiedVia::Code)` →
`AddOutcome { became_primary, was_unverified }` (re-checks everything under the account's row
lock; 409 `account_deleted` for a deleted account). An imported unverified row on the same account
passes and becomes verified; an unproven row on another account passes and moves to the prover.
`set_primary` (404 `{kind}_not_found`, 409 `{kind}_not_verified`; returns false if already
primary). `remove` (409 `cannot_remove_primary`). Error codes use `email`/`phone` prefixes. Values
must be normalized first.

## repo::photos

A photo of this service is `{PUBLIC_URL}/v1/photos/{photo_id}` written exactly as
`POST /v1/me/photo` returns it (`pfp::photo_ref`; `normalize::validate_pfp_url` refuses other
spellings). Read uploads with `photo_upload::read`, store them with
`insert_for_account(&mut tx, owner_uuid, &upload)` (hold the owner's row lock).
`check_usable(&mut tx, &settings, url, &[uploader uuids], "you")` (422
`validation_failed`, `details.fields.pfp_url`) lets an account show only its own uploads (a
Silicon: also its custodian's); it share-locks the uploader's row so the photo can't be pruned
before the change commits. `prune(&mut tx, &settings, uuid)` deletes the account's uploads that no
account that isn't deleted shows (hold the uploader's row lock).

Sign-up uploads (`POST /v1/flows/{id}/signup/photo`) belong to the sign-up session until the
account exists (`photos.signup_session_id`; a photo always has exactly one owner). Hold the
session's row lock (`select … for update`) around all of these: `insert_for_signup` (replaces the
session's earlier upload), `signup_photo` (the current choice, the sign-up prefill),
`check_usable_for_signup(&mut tx, &settings, url, session_id, route)` → `Some(photo_id)` for the
session's upload, `None` for an external URL, 422 otherwise, then `attach_signup_photo(&mut tx,
session_id, photo_id, account_uuid)` once the account exists (it becomes that account's own
upload). `discard_signup_photos` drops a session's uploads; `sweep_signup_photos(&pool)` deletes
the uploads of sessions that expired or were used.

## repo::apps — credentials

`state.app_cache.verify(&state.db, &state.keys.pepper, app_id, secret)` → `App` or `AppAuthError`
(`.to_api()` / `.to_oauth()`); successes are cached 60 s keyed by `(app_id, HMAC(secret))`. **Call
`state.app_cache.invalidate(app_id)` whenever an app's secret or status changes.** The extractors
use it for you.

## repo::memberships

- `upsert_signin(&mut conn, app_id, uuid, MembershipSource::Signin|Slt, &scopes, GrantMode::Replace|Union)`
  — active, sign-in times, granted scopes (Replace when the Carbon went through the details pages
  of the hosted flow, Union for SLT/continue-as).
- `upsert_imported(&mut conn, app_id, uuid, external_id, imported_profile, overwrite)` — status
  `imported` unless already active; 409 `external_id_conflict`. A membership whose account removed
  the app's access is returned untouched (`access_removed`): an import never undoes that; only a
  new sign-in (`upsert_signin`) does.
- `remove_access(&mut conn, app_id, uuid, actor)` → `AccessRemoved` (membership `access_removed`,
  the app's families revoked, User verification proofs that app issued about the account revoked with
  `proof.revoked` audit rows). Then `events::membership_access_removed`.
- `webhook_targets(&mut conn, uuid)` — live members (active/imported) of apps with a webhook, disabled apps
  included (the worker holds their deliveries until the app is re-enabled).

## repo::tokens — grants

```rust
// Any successful sign-in (code exchange, SLT, device, CLI code, Silicon login):
let resp: TokenResponse = tokens::issue_tokens(&mut tx, &state.keys, &state.settings, tokens::IssueRequest {
    account: &account, app_id, origin: TokenOrigin::Slt, scopes: &scopes,
    browser_session_id: None, label: Some("silicon-accounts CLI on mac"), ip, user_agent, nonce: None,
    auth_time: None,   // code exchanges pass the code's auth_time (id_token auth_time, kept on refresh)
}).await?;   // family (900 days) + refresh token + access JWT + id_token if `openid` + scoped account view

// grant_type=refresh_token (pool, not a transaction):
let resp = tokens::refresh(&state.db, &state.keys, &state.settings, refresh_token, &client.app.app_id)
    .await.map_err(|e| e.to_oauth())?;   // reuse → GrantError::Reused (family revoked)

// grant_type=authorization_code (the oauth crate consumes and issues in ONE transaction under the
// code's row lock; consume_code commits first, so use it only where a reuse race doesn't matter):
let code = tokens::consume_code(&state.db, &state.keys.pepper, code, app_id, redirect_uri, code_verifier)
    .await.map_err(|e| e.to_oauth())?;   // single use; any failure burns it; PKCE when challenged,
                                         // and a code_verifier without a challenge is refused (RFC 9700)
// …then issue_tokens with label: Some(&code.family_label()) and auth_time: code.auth_time.
// Other crates select codes with `accounts_core::auth_code_columns!()`.

// SLTs and device codes:
let (slt, expires_at) = tokens::create_slt(&mut conn, &state.keys.pepper, &uuid, app_id, &scopes).await?;
let slt_row = tokens::consume_slt(&state.db, &state.keys.pepper, slt, app_id).await.map_err(|e| e.to_oauth())?;
let start = tokens::create_device(&mut conn, &state.keys.pepper, Some(label)).await?;  // DeviceStart
tokens::decide_device(&mut conn, user_code, &me_uuid, approve).await?;
let approved = tokens::poll_device(&state.db, &state.keys.pepper, device_code).await.map_err(|e| e.to_oauth())?;
```

`create_code` takes `NewAuthCode { …, auth_time }` (the browser session's `authenticated_at`).
A missing `code_challenge_method` is stored as `S256` (stricter than RFC 7636's `plain`
default; every client of ours sends S256). `decide_device` locks the code's row, so concurrent
decisions get one winner and 409 `device_code_used`.
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
    &otp::Expect { purpose: Some(OtpPurpose::Signin), flow_id: Some(&flow.id), ..Default::default() },
    Some(otp::Attempt { app_id, ip, user_agent })).await?;   // None for codes that don't sign in
```

Both limits count **per destination**, whatever flow, account or purpose sent the code. `send`
serializes the sends to one address (an advisory lock held until your transaction ends), so a
burst of parallel requests never passes the 10. `verify` row-locks every live code to the address:
wrong codes of all of them add up to one streak, the 10th in a row locks every one for 60 s.
Verify responses: wrong code → 422 `invalid_code` with `details.remaining_attempts` (9..1, for the
address); the 10th wrong code in a row → 422 `invalid_code`, `remaining_attempts: 0`,
`details.locked_until`, `Retry-After: 60`; any attempt during the cooldown → 423
`verification_locked` (`details.locked_until`); expired or replaced by a resend → 410
`code_expired`; reused → 409 `code_already_used`; unknown or bound elsewhere → 404
`challenge_not_found`; not 6 digits → 422 `invalid_code` (not counted). A right code ends the
streak. With an `Attempt`, a lock on a `signin`/`cli_login` code of an active Carbon's address adds
a `failed` row to its sign-in history and audit `signin.locked`. A resend retires the previous code
and carries the failure streak and cooldown. `challenge.masked_destination()`,
`challenge.resend_available_at()` (UI hint, +30 s) for FlowView.

## repo::rate_limit / idempotency / audit

- `rate_limit::enforce(&mut conn, &rate_limit::bucket("ids_available:ip", ip), rate_limit::limits::IDS_AVAILABLE_PER_IP, "id lookups from this network")`
  → 429 with `Retry-After`. Limits: `IDS_AVAILABLE_PER_IP` 120/min, `SILICON_SELF_CREATE_PER_IP`
  10/h, `REPORTS_PER_IP` 5/h, `OTP_SEND_PER_IP` 30/10 min (applied by `otp::send`),
  `SILICON_LOGIN_PER_IP` 60/min, `TELEMETRY_PER_IP` 120/min. Use `enforce_pool` outside transactions.
  `peek` answers without counting (refuse a flood before any work, count successes only);
  `take(&mut tx, bucket, n, limit)` takes `n` at once (weighted budgets such as imported rows).
- `idempotency::run(&state, key.as_deref(), &scope, &body, secret_bearing, || async { Ok((status, json)) })`
  — replay with `Idempotent-Replayed: true`, 409 `idempotency_key_reused`, 409
  `idempotency_in_progress`, 24 h window (10 min when `secret_bearing`), errors not stored. A
  secret-bearing response is stored **sealed** with the keyring (`{"$sealed": …}`, bound to its
  scope and key), never in clear; one that can't be opened any more answers 409
  `idempotency_result_unavailable` instead of running again.
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
| initial request declined / expired | `events::silicon_custodian_declined(&mut tx, &silicon, request_id, label, decided_at, declined_reason::DECLINED)` / `silicon_custodian_expired(...)` (before `release_silicon`) |
| Silicon lifecycle | `events::emit_to_silicon(&mut tx, uuid, types::SILICON_CREATED / SILICON_CUSTODIAN_ACCEPTED / SILICON_STK_ROTATED, json!({...}))` |
| test buttons | `events::ping_app`, `events::ping_silicon` |

The worker: deliveries are rows in `webhook_deliveries` (`pending`); body = `webhook_events.payload`
serialized; headers `events::HEADER_*`, `User-Agent: events::USER_AGENT`; sign with
`crypto::webhook_signature(&events::current_secret(..)?, ts, body)`; post to
`events::current_url(..)` (replays go to the current URL; a deleted or released Silicon keeps its
webhook so its last events still arrive); connect only to addresses `normalize::resolve_checked`
returned (the SSRF guard); 2xx within 10 s = delivered; retry with
`events::retry_delay_seconds(attempts)` until `GIVE_UP_AFTER_HOURS` (72, counted from the event,
or from `requeued_at` after a replay) → `failed`. New secrets:
`events::new_webhook_secret(&state.keys.keyring)` → `(whsec_…, ciphertext)`.

## delivery

`enqueue(&mut tx, &settings, &NewMessage { channel, to, subject, text_body, html_body, purpose })`
→ id (status `local` in local mode — never sent, shown by the dev outbox; `pending` with
providers). After commit: `spawn_deliver(&state, id)`. Worker: `claim_due(&pool, n)` (each claim
holds the message `CLAIM_SECONDS`, 60 s) then `deliver_claimed(&pool, state.sender.as_ref(),
&settings, &msg)` (retries with backoff, OTP messages stop retrying once their code would have
expired). Results are recorded only while the claim still holds; a send that outlived its claim
after another node claimed the message again records nothing (`DeliveryOutcome::ClaimLost`). Templates: `templates::otp_email`,
`otp_sms`, `custodian_request_email`, `custodian_invite_email`, `custodian_transfer_email`,
`bug_report_email` (subjects/text/html). `extract_code(text)` finds the 6-digit code (dev outbox).
Postmark posts to `{ACCOUNTS_POSTMARK_API_URL}/email`; Twilio to
`{ACCOUNTS_TWILIO_API_URL}/2010-04-01/Accounts/{sid}/Messages.json`.

## http

- `AccountAuth` — cookie `sa_session` (`__Host-sa_session` when secure) or `Bearer` access token with
  `aud = silicon-accounts` and an active family. A developer platform token (`aud = developer`) is accepted
  only on `GET /v1/me`, `GET /v1/session` and `GET /v1/me/owned-apps` (`DEVELOPER_READ_ROUTES`,
  judged by the matched route) and by `AppOrOwner`; anywhere else it is 401
  `token_wrong_audience` naming the route. Cookie-authenticated POST/PUT/PATCH/DELETE must carry an
  allowed `Origin` (403 `origin_not_allowed`). `auth.uuid()`, `auth.kind()`, `auth.account`,
  `auth.session_id()`, `auth.family_id()`, `auth.is_cookie()`. `Option<AccountAuth>` for optional
  auth (a dead cookie = anonymous; a bad Bearer = 401).
- `CarbonAuth` / `SiliconAuth` deref to `AccountAuth` (403 `carbon_only` / `silicon_only`).
- `AppAuth { app }` — `Authorization: Basic base64(app_id:secret)`.
- `authenticate_client(&state, &headers, form.client_id, form.client_secret)` → `ClientAuth { app,
  public }` for `/v1/oauth/*` (Basic or body; `client_id=silicon-accounts` or `client_id=developer` alone =
  a public first-party client: `silicon-accounts` only for the device-code and refresh grants, `developer`
  only for the code grant with PKCE S256 and refresh; both may revoke their own tokens).
- `AppOrOwner { app, actor }` on routes with `{app_id}`: the app's credentials (403 `app_mismatch`
  for another app) or its owner's session — cookie, `aud = silicon-accounts` or `aud = developer` Bearer
  (403 `not_app_owner`, 404 `unknown_app`).
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
    let (waiting, request_id) = ctx.pending_silicon(&carbon.uuid, Some("http://127.0.0.1:8593/hooks")).await;
    let (app, secret) = ctx.app_owned("briefcase", Some(&carbon.uuid)).await;   // app_id "briefcase-<rand>"
    let whsec = ctx.set_app_webhook(&app.app_id, "http://127.0.0.1:8593/x/webhooks").await;
    ctx.membership(&app.app_id, &carbon.uuid, &[Scope::Profile, Scope::Email]).await;
    let token = ctx.first_party_tokens(&carbon).await.access_token;              // aud = silicon-accounts
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
- The first-party apps `silicon-accounts` and `developer` (migration 0005) exist after migration; their
  redirect rules are applied in code (`SigninConfig::effective` + `redirect_allowed`: any URL on
  the public origin for `silicon-accounts`, exactly `{ACCOUNTS_DEVELOPER_URL}/auth/callback` for
  `developer`) and they never show the details pages or record memberships.
- Contract numbers live in code: OTP 600 s / 60 s lock / 10 tries / 10 sends per 10 min (both per
  address); access token 1800 s; refresh 900 days; codes and SLTs 120 s; device codes 600 s (poll
  5 s); id reservations 10 days; 10 emails and 10 phones. Beyond the contract: 5 id changes per
  24 hours; 10 wrong STKs lock a Silicon's sign-in for 60 s.
- Migrations: `0001_init` (the spec schema) and `0002_hardening` (removes unverified rows left on
  non-imported accounts, `browser_sessions.authenticated_at`, `authorization_codes.auth_time`,
  `token_families.auth_time`, `webhook_deliveries.requeued_at`, and indexes for proof listings and
  sweeps, photo pruning and webhook attempts) and `0003_signup_photos_and_dark_palette`
  (`photos.signup_session_id` with one owner per photo; moves stored sign-in configs off the old
  default dark primary `#5B8FE0` to `#1F5FB8` with a `system` history entry), `0004_dark_danger`
  (the dark default error colour) and `0005_developer_platform` (the first-party app `developer`,
  the `silicon-accounts` app's homepage on accounts.teamofsilicons.com, and `signin_flows.login_hint`
  dropped: an app's login_hint is ignored). Never edit an applied
  migration. Test a data migration with `TestDb::empty()`, `db::MIGRATOR.run_to(n, &db.pool)`,
  rows, then `db::migrate` (see `tests/migrations.rs`).
