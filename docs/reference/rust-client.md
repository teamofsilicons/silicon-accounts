---
title: Rust client
description: Call Silicon Accounts from Rust with silicon-accounts-client, with every type, method and helper and working examples for accounts, apps and custodians.
kind: informative
order: 72
related:
  - reference/api.md
  - reference/errors.md
  - reference/cli.md
  - start/silicon-sign-in-to-apps.md
  - start/add-sign-in.md
  - start/verify-a-proof.md
  - start/webhooks.md
---

# Rust client

`silicon-accounts-client` is how you call Silicon Accounts from Rust. The `silicon-accounts` CLI is built on it, so anything the CLI does, your code can do too. Each method calls one endpoint of the [HTTP API](api.md).

You decide where credentials live. The client never writes files or keeps tokens, and it reads environment variables only when you call `Config::from_env`.

Here a Silicon signs in, then signs into an app:

```rust
use silicon_accounts_client::AccountsClient;

#[tokio::main]
async fn main() -> silicon_accounts_client::Result<()> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;
    let stk = std::env::var("STK").expect("set STK");

    let tokens = client.silicon_login("si:scout", &stk, Some("scout on build box")).await?;
    let session = client.with_token(tokens.access_token.expose());
    let me = session.me().await?;
    println!("signed in as {} ({})", me.id, me.uuid);

    let slt = session.short_lived_token("briefcase").await?; // single use, 2 minutes
    println!("hand {} to briefcase", slt.slt.expose());
    Ok(())
}
```

Run against a local stack (`ACCOUNTS_URL=http://localhost:8590 STK=stk-… cargo run`), it printed:

```text
signed in as si:scout (K1E)
hand slt_f_92poub5NdUOgmXcmMSPdMIhg3HvS18a1v147ycz3M to briefcase
```

## Install

```toml
[dependencies]
silicon-accounts-client = "0.3"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

To build from a local checkout of the [Silicon Accounts repository](https://github.com/teamofsilicons/silicon-accounts) instead, point the dependency at `/path/to/silicon-accounts/crates/client`, replaced with its location on your machine. Cargo then builds the package with that checkout's workspace settings.

You need Rust 1.98 or newer (edition 2024). Every call is `async` and returns
`silicon_accounts_client::Result<T>`.

## Three handles

| Handle | Made with | Acts as | Auth sent |
|---|---|---|---|
| `AccountsClient` | `AccountsClient::new(url)` or `::builder()` | nobody: public calls, sign-ins | none |
| `AccountSession<'_>` | `client.with_token(access_token)` | a signed-in Carbon or Silicon | `Authorization: Bearer` (a first-party token, `aud = silicon-accounts`) |
| `AppClient<'_>` | `client.as_app(app_id, app_secret)`, or `session.app(app_id)` for an app you author | an app | HTTP Basic, or the author's Bearer token |

`AccountsClient` holds only configuration and a connection pool, so it's cheap to clone: share one
per process. The handles borrow it and hold one credential each. Refreshing an expired access
token is up to you (`refresh_first_party`, `AppClient::refresh`).

In author mode (`session.app("briefcase")`), everything that manages the app works without its
secret, including issuing App verification proofs (through the App verification page route) and
revoking proofs by id. Some calls always need the app's own credentials: code, SLT and
refresh-token exchange, `revoke`, `introspect`, `issue_user_verification`, `refresh_proof`,
`verify_proof` and revoking a proof by token. In author mode they fail before sending anything,
with `Error::InvalidInput` and code `invalid_input`, like this:

```text
Exchanging a short-lived token needs app briefcase's own credentials (app_id + app secret); an author's session can't do it on the app's behalf.
```

## Configuration

`AccountsClient::builder()`:

| Method | Default | |
|---|---|---|
| `.base_url(url)` | `https://accounts.teamofsilicons.com` (`DEFAULT_BASE_URL`) | an origin with an optional path prefix; no query, fragment or credentials |
| `.timeout(d)` | 30 s | whole request |
| `.connect_timeout(d)` | 10 s | |
| `.user_agent("my-app/1.2")` | No custom prefix | prepended to `silicon-accounts-client/<version>` |
| `.telemetry(false)` | `true` | sends `X-Accounts-Telemetry: off` on every request; `send_telemetry` sends nothing |
| `.allow_insecure_http(true)` | `false` | plain `http://` is refused for any host but this machine (`localhost`, `*.localhost`, loopback IPs): STKs and tokens would travel unencrypted |
| `.max_retries(n)` | 2 | retries, with backoff, after a 502/503/504 or a timeout only for GET requests and requests carrying an idempotency key (safe to repeat); any request is retried when the connection never opened |

`client.with_timeout(d)` and `client.with_telemetry(on)` return adjusted copies.

`Config::from_env()` reads these, when you want it to: `ACCOUNTS_URL`, `ACCOUNTS_APP_ID`,
`ACCOUNTS_APP_SECRET`, `ACCOUNTS_TELEMETRY` (`0`/`off`/`false`/`no` turn it off),
`ACCOUNTS_TIMEOUT_SECONDS` (default 30) and `ACCOUNTS_ALLOW_INSECURE_HTTP` (`1` allows plain
http). Then call `config.client()?`, and `config.app_client(&client)` for an `AppClient` when both
app variables are set.

```rust
let client = AccountsClient::builder()
    .base_url("http://localhost:8590")     // a local stack
    .user_agent("docs-demo/1.0")
    .timeout(std::time::Duration::from_secs(20))
    .build()?;
```

## `AccountsClient`

| Method | Endpoint | Returns |
|---|---|---|
| `meta()` | `GET /v1/meta` | `Meta` (`name`, `version`, `environment`, `public_url`, `silicon_apps_url`, `docs_url`, `providers`, `delivery`) |
| `id_available(id)` | `GET /v1/ids/available` | `IdAvailability` (`id`, `available`, `reason`, `message`, `reclaimable`, `suggestions`) |
| `app_public(app_id)` | `GET /v1/apps/{app_id}/public` | `AppPublic` |
| `jwks()` | `GET /.well-known/jwks.json` | `Jwks` (cache it; refetch on an unknown `kid`) |
| `oidc_discovery()` | `GET /.well-known/openid-configuration` | `OidcDiscovery` |
| `authorize_url(&AuthorizeParams)` | builds `/authorize?…` | `Url` (no request) |
| `silicon_login(id, stk, client_label)` | `POST /v1/silicons/login` | `TokenResponse` |
| `silicon_self_create(&SiliconSelfCreate, idempotency_key)` | `POST /v1/silicons` | `SiliconSelfCreated` (`silicon`, `stk`, `request`, `request_token`, `webhook_secret`) |
| `silicon_request_status(request_id, request_token)` | `GET /v1/silicons/requests/{id}` | `CustodianRequestStatus` |
| `wait_for_custodian_decision(request_id, request_token, &WaitOptions, on_event)` | polls the above | the final `CustodianRequestStatus` |
| `device_authorize(client_label)` | `POST /v1/device/authorize` | `DeviceAuthorization` |
| `device_poll(device_code)` | `POST /v1/oauth/token` (device grant) | `DevicePoll`: `Pending`, `SlowDown`, `Denied`, `Expired` or `Tokens(..)` |
| `wait_for_device_tokens(&DeviceAuthorization, on_event)` | polls at `interval`, honouring `slow_down` | `TokenResponse` (`access_denied` / `expired_token` as `Error::OAuth`) |
| `cli_login_start(&Contact)` | `POST /v1/cli/login/start` | `CliLoginChallenge` |
| `cli_login_verify(challenge_id, code, client_label)` | `POST /v1/cli/login/verify` | `TokenResponse` |
| `refresh_first_party(refresh_token)` | `POST /v1/oauth/token` (`client_id=silicon-accounts`) | `TokenResponse` with a new refresh token |
| `revoke_first_party(token)` | `POST /v1/oauth/revoke` (`client_id=silicon-accounts`) | `()` |
| `exchange_developer_code(code, redirect_uri, code_verifier)` | `POST /v1/oauth/token` (`client_id=developer`, PKCE S256, no secret) | `TokenResponse` with `aud = developer` tokens (the developer platform's server side) |
| `refresh_public_client(client_id, refresh_token)`, `revoke_public_client(client_id, token)` | `POST /v1/oauth/token` / `revoke` for `silicon-accounts` or `developer` | `TokenResponse` / `()` |
| `report(message, pr_url, access_token, idempotency_key)` | `POST /v1/reports` | `ReportReceipt` |
| `send_telemetry(&[TelemetryEvent])` | `POST /v1/telemetry/events` (3-second timeout) | `()`; nothing when telemetry is off |
| `with_token(access_token)` | No request | `AccountSession` |
| `as_app(app_id, app_secret)` | No request | `AppClient` |

`Contact` is `Contact::Email(String)` or `Contact::Phone { phone, country: Option<String> }`.
Where a rule can be checked locally (an empty STK, a code that isn't 6 digits, a report over
10,000 characters, more than 50 telemetry events), the input is checked before sending and fails
with `Error::InvalidInput`.

## `AccountSession`

A signed-in Carbon or Silicon. Where a method returns a `Vec`, the client follows the pages for
you (up to 100 pages of 200).

| Method | Endpoint | Returns |
|---|---|---|
| `me()` | `GET /v1/me` | `Me` |
| `update_me(&ProfileUpdate)` | `PATCH /v1/me` | `Me` |
| `change_id(new_id)` | `POST /v1/me/id` | `Me` |
| `id_available(id)` | `GET /v1/ids/available` (signed in: your reserved ids are reclaimable) | `IdAvailability` |
| `silicon_id_available(silicon, id)` | `GET /v1/ids/available?for=` | `IdAvailability` |
| `set_photo(bytes, content_type)` | `POST /v1/me/photo` | `PhotoUploaded` |
| `remove_photo()` | `DELETE /v1/me/photo` | `Me` |
| `emails()`, `add_email(email)`, `verify_email(challenge_id, code)`, `make_email_primary(email)`, `remove_email(email)` | `/v1/me/emails…` | `Vec<EmailAddress>` / `ContactChallenge` |
| `phones()`, `add_phone(phone, country)`, `verify_phone(..)`, `make_phone_primary(..)`, `remove_phone(..)` | `/v1/me/phones…` | `Vec<PhoneNumber>` / `ContactChallenge` |
| `identities()`, `remove_identity(provider, subject)` | `/v1/me/identities…` | `Vec<Identity>` / `()` |
| `apps()`, `remove_app_access(app_id)` | `/v1/me/apps…` | `Vec<MyApp>` / `()` |
| `sessions()`, `revoke_session(id)` | `/v1/me/sessions…` | `Vec<SessionInfo>` / `()` |
| `history(&HistoryQuery)` | `GET /v1/me/history` | `Page<HistoryItem>` |
| `delete_account(confirm)` | `DELETE /v1/me` | `()` |
| `signout(refresh_token)` | `POST /v1/oauth/revoke` | `()` |
| `short_lived_token(app_id)` | `POST /v1/me/short-lived-tokens` | `ShortLivedToken` (`slt`, `app_id`, `expires_at`) |
| `proofs()`, `revoke_proof(proof_id)` | `/v1/me/proofs…` | `Vec<MyProof>` / `()` |
| `set_my_webhook(url)`, `remove_my_webhook()`, `test_my_webhook()` | `/v1/me/webhook…` (Silicons) | `SiliconWebhook` / `()` / `WebhookTestResult` |
| `my_webhook_deliveries(&DeliveriesQuery)`, `my_webhook_delivery(id)` | `GET /v1/me/webhook/deliveries…` (Silicons) | `Page<WebhookDelivery>` / `DeliveryDetail` |
| `replay_my_webhook(&ReplayRequest, idempotency_key)` | `POST /v1/me/webhook/replay` (Silicons) | `ReplayResult` |
| `silicons()`, `get_silicon(uuid)` | `/v1/me/silicons…` | `Vec<ManagedSilicon>` / `ManagedSilicon` |
| `create_silicon(&CreateSilicon, idempotency_key)` | `POST /v1/me/silicons` | `SiliconCreated` (`silicon`, `stk`, `webhook_secret`) |
| `update_silicon(uuid, &UpdateSilicon)` | `PATCH /v1/me/silicons/{uuid}` | `SiliconView` |
| `set_silicon_photo(uuid, bytes, content_type, idempotency_key)` | `POST /v1/me/silicons/{uuid}/photo` | `SiliconPhotoUploaded` |
| `change_silicon_id(uuid, new_id)` | `POST /v1/me/silicons/{uuid}/id` | `SiliconView` |
| `rotate_stk(uuid, stk)` | `POST /v1/me/silicons/{uuid}/stk` | `StkRotated` (`stk` when generated, `rotated_at`) |
| `set_silicon_webhook(uuid, url)`, `remove_silicon_webhook(uuid)` | `/v1/me/silicons/{uuid}/webhook` | `SiliconWebhook` / `()` |
| `silicon_webhook_deliveries(uuid, &DeliveriesQuery)`, `silicon_webhook_delivery(uuid, id)` | `GET /v1/me/silicons/{uuid}/webhook/deliveries…` | `Page<WebhookDelivery>` / `DeliveryDetail` |
| `replay_silicon_webhook(uuid, &ReplayRequest, idempotency_key)` | `POST /v1/me/silicons/{uuid}/webhook/replay` | `ReplayResult` |
| `transfer_silicon(uuid, to)`, `cancel_transfer(uuid)` | `/v1/me/silicons/{uuid}/transfer` | `CustodianRequest` / `()` |
| `delete_silicon(uuid, confirm)` | `DELETE /v1/me/silicons/{uuid}` | `()` |
| `custodian_requests()`, `accept_custodian_request(id)`, `decline_custodian_request(id)` | `/v1/me/custodian-requests…` | `Vec<CustodianRequest>` / `()` |
| `owned_apps()` | `GET /v1/me/owned-apps` | `Vec<OwnedApp>` |
| `app(app_id)` | No request | an author-mode `AppClient` |
| `device_request(user_code)`, `approve_device(user_code)`, `deny_device(user_code)` | `/v1/device/{user_code}…` (user codes are normalized: `wdjb mjht` → `WDJB-MJHT`) | `DeviceRequest` / `()` |
| `lookup(uuid)`, `lookup_by_id(id)`, `resolve(uuid_or_id)` | `/v1/accounts/…` | `AccountSummary` |

`SiliconView` is `Me`. Photos are checked before sending: PNG, JPEG, WebP or GIF, at most 2 MB.

## `AppClient`

| Method | Endpoint | Returns |
|---|---|---|
| `exchange_code(code, redirect_uri, code_verifier)` | token endpoint, `authorization_code` | `TokenResponse` |
| `exchange_slt(slt)` | token endpoint, SLT grant | `TokenResponse` |
| `refresh(refresh_token)` | token endpoint, `refresh_token` | `TokenResponse` (store the new refresh token) |
| `revoke(token)` | `POST /v1/oauth/revoke` | `()` |
| `introspect(token)` | `POST /v1/oauth/introspect` | `Introspection` |
| `userinfo(access_token)` | `GET /v1/userinfo` | `UserInfo` (the `AccountForApp` plus OIDC claims) |
| `verify_access_token_locally(&jwks, token)` | none | `Claims` (EdDSA signature, `exp`/`nbf`, `aud == app_id`; can't see revocation) |
| `app()` | `GET /v1/apps/{app_id}` | `AppDetails` |
| `update_signin_config(&patch, expected_version, idempotency_key)` | `PATCH …/signin-config` | `AppDetails` |
| `signin_config_history(&PageRequest)` | `GET …/signin-config/history` | `Page<ConfigHistoryEntry>` |
| `users(&UsersQuery)`, `user(uuid)` | `/v1/apps/{app_id}/users…` | `Page<AppUser>` / `AppUser` (with `history`) |
| `start_import(&ImportInput, &ImportOptions, idempotency_key)` | `POST …/imports` (5-minute timeout) | `ImportJob` |
| `imports(&PageRequest)`, `import_job(job_id)`, `import_rows(job_id, &ImportRowsQuery)` | `GET …/imports…` | `Page<ImportJob>` / `ImportJob` / `Page<ImportRowResult>` |
| `wait_for_import(job_id, poll)`, `wait_for_import_with(job_id, &WaitOptions, on_event)` | polls the job | the finished `ImportJob` |
| `set_webhook(url, idempotency_key)`, `remove_webhook()`, `rotate_webhook_secret(key)`, `test_webhook(key)` | `…/webhook…` | `AppWebhook` / `()` / `WebhookSecret` / `WebhookTestResult` |
| `deliveries(&DeliveriesQuery)`, `delivery(id)` | `…/webhook/deliveries…` | `Page<WebhookDelivery>` / `DeliveryDetail` |
| `replay(&ReplayRequest, idempotency_key)` | `…/webhook/replay` | `ReplayResult` (`replayed_count()`, `skipped_count()`) |
| `issue_user_verification(&IssueUserVerification, key)` | `POST /v1/proofs/user-verification` | `IssuedProof` |
| `issue_app_verification(&IssueAppVerification, key)` | `POST /v1/proofs/app-verification` (author mode: `/v1/apps/{app_id}/proofs/app-verification`) | `IssuedProof` |
| `refresh_proof(refresh_token, access_ttl_seconds)` | `POST /v1/proofs/refresh` | `IssuedProof` |
| `verify_proof(proof_token)` | `POST /v1/proofs/verify` | `ProofVerification::Valid(..)` or `::Invalid` |
| `revoke_proof(&ProofRef)` | `POST /v1/proofs/revoke` (author mode with `ProofRef::Id`: `DELETE …/proofs/{id}`) | `()` |
| `proofs(&ProofsQuery)` | `GET /v1/apps/{app_id}/proofs` | `Page<AppProof>` |
| `lookup(uuid)`, `lookup_by_id(id)`, `resolve(uuid_or_id)` | `/v1/accounts/…` | `AccountSummary` |

`ImportInput` is `Csv(Bytes)`, `Rows(Vec<ImportRow>)` or `Json(Vec<serde_json::Value>)`.
`ReplayRequest` is `Deliveries(Vec<String>)` (1 to 100) or `Failed { since: Option<OffsetDateTime> }`.
`ProofRef` is `Id`, `Token` or `RefreshToken`. `ProofVerification` is `#[non_exhaustive]`, so
match it with a wildcard arm.

## Types

- **Request types** (`SiliconSelfCreate`, `CreateSilicon`, `UpdateSilicon`, `ProfileUpdate`,
  `IssueUserVerification`, `IssueAppVerification`, `ImportOptions`, `ImportRow`, the `*Query`
  types, `PageRequest`, `AuthorizeParams`) implement `Default`, so you can write
  `CreateSilicon { id: "si:scout".into(), display_name: "Scout".into(), ..Default::default() }`.
- **Response types** are `#[non_exhaustive]`: read their fields. They tolerate fields the service
  adds later, and `null` where a value is usually present.
- **`Page<T>`**: `items`, `next_cursor` (`None` on the last page), `is_last()`, iterable.
- **`Secret`** wraps every secret the service returns (access, refresh and short-lived tokens,
  STKs, webhook secrets, proof tokens, device codes). `Debug` prints only its prefix
  (`Secret(sar_…)`), the memory is zeroed on drop, and `.expose()` gives you the value where it
  has to leave your program.
- **`TokenResponse`**: `access_token: Secret`, `token_type`, `expires_in`,
  `refresh_token: Option<Secret>`, `refresh_token_expires_at`, `scope`, `id_token`,
  `membership_id`, `account: Option<AccountForApp>`; `scopes()`, `access_expires_at(issued_at)`.
- **`Claims`** (local verification): `iss`, `sub`, `aud: Vec<String>`, `exp`, `iat`, `nbf`, `jti`,
  `kind`, `id`, `mid`, `fid`, `scope`; `scopes()`, `has_scope(s)`.
- **`AccountKind`**: `Carbon` | `Silicon`; `AccountKind::of_id("si:scout")`.

## Errors

Every call fails with `silicon_accounts_client::Error`, which is `#[non_exhaustive]`:

| Variant | When |
|---|---|
| `Api(Box<ApiError>)` | the service answered with its error body (or a non-JSON error: code `http_<status>`) |
| `OAuth(Box<OAuthError>)` | an OAuth endpoint answered an RFC 6749 error |
| `Http { message, hint, source }` | no response: DNS, TLS, refused connection, timeout |
| `Decode { message, hint }` | a response this client doesn't understand |
| `InvalidInput { message, hint }` | refused before sending |
| `Token(TokenError)` | local access-token verification failed |
| `TimedOut { message, hint }` | a waiting helper gave up (the work continues in the service) |

Helpers on `Error`: `code()`, `message()`, `hint()`, `status()`, `request_id()`, `details()`,
`retry_after()`, `as_api()`, `as_oauth()`, `is_code(code)`, `is_not_found()`,
`is_unauthenticated()` (401, `invalid_grant` or `invalid_client`) and `is_transport()`. `Display`
prints the message, then ` Hint: ` and the hint. `ApiError` has public `status`, `code`,
`message`, `hint`, `details`, `request_id` and `retry_after`, plus `field_errors()` (the
`details.fields` pairs of a 422). Every code is listed in [Errors](errors.md#rust-client-codes).

```rust
match client.silicon_login("si:scout", "stk-000000000000", None).await {
    Ok(tokens) => { /* … */ }
    Err(err) if err.is_code("invalid_credentials") => eprintln!("{err}"),
    Err(err) if err.is_code("login_locked") => {
        tokio::time::sleep(err.retry_after().unwrap_or(std::time::Duration::from_secs(60))).await;
    }
    Err(err) => return Err(err),
}
```

With a wrong STK, it printed:

```text
Sign-in failed: no Silicon has this si:id, or the STK is wrong. Both cases get this same answer, so ids can't be probed. Hint: Check the si:id (use the current one; ids can change) and the STK (stk- followed by the hex characters shown once at creation or rotation). 10 wrong STKs in a row lock sign-in for 1 minute. A lost STK can be replaced by the Silicon's custodian (`silicon-accounts silicon rotate-stk`).
```

## Examples

Each example ran against a local stack (`scripts/dev.sh`), and the printed values are from those
runs (with the Accounts host written as production's).

### An app signs a Silicon in and checks the token

```rust
let app = client.as_app("briefcase", app_secret);
let tokens = app.exchange_slt(&slt_from_the_silicon).await?;
let account = tokens.account.clone().expect("token responses carry the account");
println!("{} signed in as {} (membership {})", account.uuid, account.id, account.membership_id);

let jwks = client.jwks().await?;                                         // cache it
let claims = app.verify_access_token_locally(&jwks, tokens.access_token.expose())?;
println!("aud={:?} scopes={:?}", claims.aud, claims.scopes());

let live = app.introspect(tokens.access_token.expose()).await?;          // sees revocation
println!("active={}", live.active);

let rotated = app.refresh(tokens.refresh_token.as_ref().unwrap().expose()).await?;
// store rotated.refresh_token now: the old one is dead, and presenting it again
// revokes the whole sign-in (invalid_grant).
```

```text
K1E signed in as si:scout (membership briefcase:K1E)
aud=["briefcase"] scopes=["profile", "timezone"]
active=true
```

### Send a browser to the hosted sign-in

```rust
use silicon_accounts_client::{AuthorizeParams, pkce_pair, random_state};

let pkce = pkce_pair();               // keep pkce.verifier server-side
let state = random_state();           // check it on the callback
let url = client.authorize_url(
    &AuthorizeParams::new("briefcase", "https://briefcase.example/auth/callback")
        .state(&state)
        .pkce(&pkce)
        .scopes(["openid", "email"]),
);
// redirect to `url`; on the callback, after checking state:
let tokens = app.exchange_code(&code, "https://briefcase.example/auth/callback", Some(&pkce.verifier)).await?;
```

`url` is `https://accounts.teamofsilicons.com/authorize?response_type=code&app_id=briefcase&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&scope=openid+email`.
`AuthorizeParams` also takes `.nonce()`, `.prompt()`, `.intent()` (`signin` or `signup`, for your
"Sign in" and "Sign up" buttons) and `.method()` (for a direct "Continue with …" button). There is
no `login_hint`, because an app never hands Silicon Accounts a Carbon's email or phone.

### A Carbon signs in on a device

```rust
let device = client.device_authorize(Some("my tool on laptop")).await?;
println!("Open {} and enter {}", device.verification_uri, device.user_code);
let tokens = client.wait_for_device_tokens(&device, |_| {}).await?;
let me = client.with_token(tokens.access_token.expose()).me().await?;
println!("signed in as {} ({})", me.id, me.uuid);
```

```text
Open https://accounts.teamofsilicons.com/device and enter PJG8-55WW
signed in as c:ada (8HV)
```

The Carbon approves on the account site. From Rust, a signed-in Carbon can approve with
`session.approve_device(&device.user_code)`.

### A Silicon creates its own account and waits for its custodian

```rust
use silicon_accounts_client::{SiliconSelfCreate, WaitEvent, WaitOptions};

let created = client
    .silicon_self_create(
        &SiliconSelfCreate {
            id: "si:pilot".into(),
            display_name: "Pilot".into(),
            custodian: "c:ada".into(),
            ..Default::default()
        },
        Some("self-create-si-pilot-1"), // a retry never creates a second request
    )
    .await?;
let stk = created.stk.clone().expect("generated STKs are returned once"); // store it now
println!("{} is {}", created.silicon.id, created.silicon.status);

let decision = client
    .wait_for_custodian_decision(
        &created.request.id,
        created.request_token.expose(),
        &WaitOptions::custodian_default(),   // 5 s doubling to 60 s, for up to 14 days
        |event| if let WaitEvent::Polled(status) = event { println!("polled: {}", status.status) },
    )
    .await?;
if decision.is_accepted() {
    let tokens = client.silicon_login("si:pilot", stk.expose(), None).await?;
}
```

```text
si:pilot is pending_custodian
polled: accepted
```

`WaitOptions::fixed(d)`, `WaitOptions::backoff(initial, max)` and `.with_timeout(Some(d))` shape
the polling. Transient errors (network, 5xx, 429) are reported as `WaitEvent::TransientError` and
retried.

### A custodian manages its Silicons

```rust
use silicon_accounts_client::CreateSilicon;

let ada = client.with_token(carbon_access_token);
let made = ada
    .create_silicon(&CreateSilicon { id: "si:copilot".into(), display_name: "Copilot".into(), ..Default::default() },
                    Some("create-si-copilot-1"))
    .await?;
let rotated = ada.rotate_stk(&made.silicon.uuid, None).await?;   // None = generate one
let check = ada.silicon_id_available(&made.silicon.uuid, "si:copilot-2").await?;
```

### An app manages its setup, imports and webhook

```rust
use silicon_accounts_client::{DeliveriesQuery, ImportInput, ImportOptions, ReplayRequest};

let app = client.as_app("remind", app_secret);
let details = app.app().await?;
let patched = app
    .update_signin_config(&serde_json::json!({"copy": {"subtitle": "Reminders on your own clock."}}),
                          Some(details.config_version), Some("remind-cfg-1"))
    .await?;

let job = app
    .start_import(&ImportInput::Csv(csv_bytes.into()), &ImportOptions { dry_run: true, ..Default::default() }, Some("import-1"))
    .await?;
let job = app.wait_for_import(&job.id, std::time::Duration::from_secs(1)).await?;

let hook = app.set_webhook("https://remind.example/hooks/accounts", Some("webhook-1")).await?;
let page = app.deliveries(&DeliveriesQuery { status: Some("failed".into()), ..Default::default() }).await?;
let result = app.replay(&ReplayRequest::Failed { since: None }, None).await?;
```

In the run, `config_version` went from 2 to 3. Sending another patch with the old
`expected_version` failed with `err.code() == "config_version_conflict"` and `err.details()` =
`{"current_version": 3, "expected_version": 2}`. The two-row dry run finished `completed` with
`ImportCounts { created: 1, matched: 0, updated: 0, skipped: 0, error: 1, warnings: 1 }`.

### Proofs

```rust
use silicon_accounts_client::{IssueAppVerification, IssueUserVerification, ProofRef, ProofVerification};

// App A, for an account that consented in A's own interface:
let proof = app_a
    .issue_user_verification(&IssueUserVerification { subject_token: account_access_token, receiving_app: "briefcase".into(),
                           scopes: vec!["files.write".into()], access_ttl_seconds: Some(600) },
               Some("user_verification-req-42"))
    .await?;

// App B, receiving proof.proof_token:
match app_b.verify_proof(&proof_token).await? {
    ProofVerification::Valid(p) => println!("from {} scopes={:?}", p.issuing_app.app_id, p.scopes),
    _ => { /* not valid: refuse */ }
}

let app_verification = commit.issue_app_verification(&IssueAppVerification { receiving_app: "remind".into(), scopes: vec!["builds.read".into()], access_ttl_seconds: Some(600) }, Some("app_verification-1")).await?;
commit.revoke_proof(&ProofRef::Id(app_verification.proof_id.clone())).await?;
```

In the run, `remind` verified the App verification token as `Valid` (issued by `commit`, scopes
`["builds.read"]`). After `revoke_proof`, the same token verified as `Invalid`.

## Webhooks

```rust
use silicon_accounts_client::{verify_and_parse_webhook, WebhookPayload, DEFAULT_WEBHOOK_TOLERANCE};

let event = verify_and_parse_webhook(
    &webhook_secret,                // whsec_…, used as-is as the HMAC key
    timestamp_header,               // X-Accounts-Timestamp
    signature_header,               // X-Accounts-Signature
    &raw_body,                      // the exact bytes received, before JSON parsing
    DEFAULT_WEBHOOK_TOLERANCE,      // 5 minutes
)?;
match event.payload {
    WebhookPayload::AccountIdChanged(change) => { /* show change.new_id; keep keying on change.uuid */ }
    WebhookPayload::AccountDeleted(gone) => { /* delete gone.uuid's data */ }
    WebhookPayload::Ping => {}
    _ => {}
}
// dedupe on event.event_id: retries and replays reuse it
```

In the run, a real `ping` delivery verified (`event.payload` was `WebhookPayload::Ping`), and the
same headers with another body were refused with `WebhookError::SignatureMismatch`, which
displays as:

```text
The webhook signature does not match the body. Hint: Verify against the raw request body bytes (before any JSON parsing) with the current whsec_… secret; after rotating the secret, deliveries are signed with the new one.
```

| Item | |
|---|---|
| `verify_webhook_signature(secret, ts, sig, body, tolerance)` | checks the timestamp and any `v1=` signature (constant time) |
| `verify_webhook_signature_at(.., now_unix)` | the same with an explicit clock, for tests |
| `verify_and_parse_webhook(..)` | verify, then `parse_webhook` |
| `parse_webhook(body)` | `WebhookEvent { event_id, event_type, occurred_at, app_id, silicon, data, payload }` |
| `sign_webhook(secret, ts, body)` | the `v1=…` header value (tests, tools) |
| `WebhookPayload` | `AccountIdChanged`, `AccountUpdated`, `AccountDeleted`, `MembershipSignedOut`, `MembershipAccessRemoved`, `CustodianChanged`, `Ping`, the Silicon events (`SiliconCreated`, `SiliconCustodianAccepted`, `SiliconCustodianDeclined`, `SiliconCustodianExpired`, `SiliconUpdated`, `SiliconIdChanged`, `SiliconStkRotated`, `SiliconCustodianChanged`, carrying the raw `data`), `Unknown` for types this version doesn't know |
| `WebhookError` | `EmptySecret`, `MissingHeader`, `InvalidTimestamp`, `TimestampOutOfTolerance`, `InvalidSignatureFormat`, `SignatureMismatch`, `InvalidBody`: refuse the delivery (400 or 401) |
| Header constants | `EVENT_ID_HEADER`, `EVENT_TYPE_HEADER`, `DELIVERY_ID_HEADER`, `TIMESTAMP_HEADER`, `SIGNATURE_HEADER` |

The wire format is in [Webhook deliveries and events](api/webhooks.md).

## Local token verification and PKCE

| Item | |
|---|---|
| `verify_access_token(&jwks, token, &VerifyOptions)` | EdDSA (Ed25519) signature by a JWKS key (by `kid`), `exp`/`nbf`, `aud`, optionally `iss` → `Claims`; `Error::Token(TokenError)` otherwise |
| `VerifyOptions::for_app(app_id)` | accept tokens issued to your app; `.with_issuer(url)`; `leeway_seconds` 30. An empty audience list is refused (any app's token would pass) |
| `pkce_pair()` | `PkcePair { verifier (43 characters), challenge }`, S256 |
| `pkce_challenge(verifier)`, `random_state()`, `random_nonce()`, `random_token(bytes)` | base64url values from the OS random generator |

Local verification can't see revocation (a sign-out, removed access), and access tokens live at
most 30 minutes. Call `introspect` when you need to know at once.

## Constants

`DEFAULT_BASE_URL` (`https://accounts.teamofsilicons.com`), `FIRST_PARTY_APP_ID` (`silicon-accounts`),
`DEVELOPER_APP_ID` (`developer`),
`VERSION`, `SLT_GRANT_TYPE` (`urn:silicon:params:oauth:grant-type:slt`),
`DEVICE_CODE_GRANT_TYPE` (`urn:ietf:params:oauth:grant-type:device_code`), `TELEMETRY_HEADER`,
`IDEMPOTENCY_HEADER`, `IDEMPOTENT_REPLAYED_HEADER`, `REQUEST_ID_HEADER`.

## Identifiers

Store the account `uuid` (permanent) or the membership id `{app_id}:{uuid}`. The `c:`/`si:` id is
for display only: it can change, and apps hear about it through `account.id_changed`.
