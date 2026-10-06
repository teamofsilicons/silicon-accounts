# silicon-accounts-client

The Rust package for [Silicon Accounts](https://account.teamofsilicons.com): one personal
account for every Carbon and Silicon, and the sign-in layer for apps.

It is **stateless**: it never writes files or reads the environment (unless you call
`Config::from_env`). You decide where tokens live. The `accounts` CLI is built only on
this package, so everything the CLI does, you can do from Rust.

```toml
[dependencies]
silicon-accounts-client = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

Every call is async and returns `silicon_accounts_client::Result<T>`. Errors are typed
(`Error::Api`, `Error::OAuth`, `Error::Http`, `Error::Decode`, `Error::InvalidInput`,
`Error::Token`, `Error::TimedOut`); each one has a precise `message()` saying what went
wrong and why, and a `hint()` saying what to do next. `Display` prints both.

```rust
match client.silicon_login("si:scout", &stk, None).await {
    Ok(tokens) => { /* … */ }
    Err(err) if err.is_code("custodian_pending") => eprintln!("{err}"),
    Err(err) => return Err(err.into()),
}
```

Identifiers: store the account `uuid` (permanent) or the membership id
`{app_id}:{uuid}`; the `c:`/`si:` id is for display and can change.

## Quickstart for Silicons

```rust
use silicon_accounts_client::{AccountsClient, SiliconSelfCreate};

let client = AccountsClient::new("https://account.teamofsilicons.com")?;

// 1. Get an account (once): name your custodian; they have 14 days to accept.
let created = client
    .silicon_self_create(
        &SiliconSelfCreate {
            id: "si:scout".into(),
            display_name: "Scout".into(),
            custodian: "c:saket".into(),
            ..Default::default()
        },
        Some("create-si-scout-1"), // idempotency key: retries never create twice
    )
    .await?;
let stk = created.stk.expect("generated STKs are returned once"); // store it now
let decision = client
    .wait_for_custodian_decision(
        &created.request.id,
        created.request_token.expose(),
        &silicon_accounts_client::WaitOptions::custodian_default(),
        |_| {},
    )
    .await?;
assert!(decision.is_accepted());

// 2. Sign in, and 3. sign into an app with a short-lived token.
let tokens = client.silicon_login("si:scout", stk.expose(), Some("scout on build box")).await?;
let session = client.with_token(tokens.access_token.expose());
let slt = session.short_lived_token("remind").await?; // single use, 2 minutes
// hand slt.slt.expose() to the app; it calls exchange_slt
```

Refresh the first-party access token (30 minutes) with
`client.refresh_first_party(refresh_token)`; refresh tokens rotate on every use and
presenting a used one revokes the whole session, so always store the new one.

## Quickstart for apps

### Sign people in

```rust
use silicon_accounts_client::{AccountsClient, AuthorizeParams, pkce_pair, random_state};

let client = AccountsClient::new("https://account.teamofsilicons.com")?;
let app = client.as_app("briefcase", app_secret);

// Redirect the browser:
let pkce = pkce_pair();
let state = random_state();
let url = client.authorize_url(
    &AuthorizeParams::new("briefcase", "https://briefcase.example/auth/callback")
        .state(&state)
        .pkce(&pkce)
        .scopes(["email"]),
);
// …store state + pkce.verifier in the browser session, redirect to `url`.

// On the callback (?code=…&state=…), after checking state:
let tokens = app
    .exchange_code(&code, "https://briefcase.example/auth/callback", Some(&pkce.verifier))
    .await?;
let account = tokens.account.expect("token responses carry the account");
println!("{} signed in as membership {}", account.id, account.membership_id);

// Silicons sign in with a short-lived token instead of the browser:
let tokens = app.exchange_slt(&slt_from_the_silicon).await?;
```

### Check access tokens

```rust
let jwks = client.jwks().await?;                               // cache it; refetch on unknown kid
let claims = app.verify_access_token_locally(&jwks, &token)?;  // EdDSA, exp, aud == app id
let live = app.introspect(&token).await?;                      // also sees revocation
```

### Verify proofs (OBO / ATA)

```rust
use silicon_accounts_client::ProofVerification;

match app.verify_proof(&proof_token).await? {
    ProofVerification::Valid(proof) => {
        // proof.issuing_app, proof.user (OBO), proof.scopes, proof.expires_at
    }
    _ => { /* invalid: reject. The service answers {"valid":false,"expires_at":null} */ }
}

// Issuing (as app A): an OBO proof to act at app B for an account that consented in A.
let proof = app
    .issue_obo(
        &silicon_accounts_client::IssueObo {
            subject_token: account_access_token,
            receiving_app: "briefcase".into(),
            scopes: vec!["files.write".into()],
            access_ttl_seconds: Some(600),
        },
        Some("obo-req-42"),
    )
    .await?;
```

### Webhooks

```rust
use silicon_accounts_client::{verify_and_parse_webhook, WebhookPayload, DEFAULT_WEBHOOK_TOLERANCE};

let event = verify_and_parse_webhook(
    &webhook_secret,                 // whsec_…, used as-is as the HMAC key
    headers["X-Accounts-Timestamp"],
    headers["X-Accounts-Signature"], // v1=<hex HMAC-SHA256(secret, "{ts}.{raw body}")>
    &raw_body,                       // the exact bytes received
    DEFAULT_WEBHOOK_TOLERANCE,       // 5 minutes
)?;
match event.payload {
    WebhookPayload::AccountIdChanged(change) => { /* update the shown id; key on change.uuid */ }
    WebhookPayload::AccountDeleted(gone) => { /* delete gone.uuid's data */ }
    _ => {}
}
// Dedupe on event.event_id: retries and replays reuse it.
```

### User base, imports, sign-in setup

```rust
use silicon_accounts_client::{ImportInput, ImportOptions, UsersQuery};

let page = app.users(&UsersQuery { q: Some("saket".into()), ..Default::default() }).await?;
let job = app
    .start_import(&ImportInput::Csv(csv_bytes.into()), &ImportOptions { dry_run: true, ..Default::default() }, Some("import-1"))
    .await?;
let job = app.wait_for_import(&job.id, std::time::Duration::from_secs(1)).await?;
let details = app.update_signin_config(&serde_json::json!({"methods": {"google": true}}), Some(7), None).await?;
```

An app's owner can do the same through their own session without the app secret:
`client.with_token(owner_token).app("briefcase")`. Calls that need the app's own
credentials (token exchange, proof issuing and verifying) are refused in that mode with
a precise error.

## Carbons

```rust
let device = client.device_authorize(Some("my tool on laptop")).await?;
println!("Open {} and enter {}", device.verification_uri, device.user_code);
let tokens = client.wait_for_device_tokens(&device, |_| {}).await?;
let me = client.with_token(tokens.access_token.expose()).me().await?;
```

`AccountSession` covers the whole account: profile, id changes, emails and phones,
linked identities, apps you signed into, sessions, history, OBO proofs about you, the
Silicons you are custodian of (create, rotate STK, transfer, delete), custodian
requests, device approvals and the apps you own.

## Configuration

`AccountsClient::builder()` sets the base URL, timeouts, a User-Agent product token,
telemetry (`X-Accounts-Telemetry: off` when disabled), retries for safe requests, and
whether plain http to non-loopback hosts is allowed (off by default). `Config::from_env`
reads `ACCOUNTS_URL`, `ACCOUNTS_APP_ID`, `ACCOUNTS_APP_SECRET`, `ACCOUNTS_TELEMETRY`,
`ACCOUNTS_TIMEOUT_SECONDS` and `ACCOUNTS_ALLOW_INSECURE_HTTP` when you want that.

Secrets (`Secret`) never print in `Debug` output; call `.expose()` where a value must
leave your program.

## Links

* Docs: https://account.teamofsilicons.com/docs (and `accounts docs` in the CLI)
* Source: https://github.com/teamofsilicons/silicon-accounts
