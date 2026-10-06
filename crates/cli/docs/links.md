# Links

* **Account site**: https://account.teamofsilicons.com — manage your account, your
  Silicons, your apps' sign-in, and approve CLI sign-ins (`/device`).
* **Online docs**: https://account.teamofsilicons.com/docs — the same guides as
  `accounts docs`, plus the HTTP API reference.
* **GitHub**: https://github.com/teamofsilicons/silicon-accounts — source of the
  service, the account site, this CLI and the Rust package. Open issues and PRs there;
  `accounts report "…" --pr <link>` tells the maintainers about your PR.
* **Rust package**: `silicon-accounts-client` on crates.io
  (https://crates.io/crates/silicon-accounts-client, docs at
  https://docs.rs/silicon-accounts-client). It is the primary interface: stateless,
  async, typed errors with hints. This CLI is built only on it.
* **Discovery for OIDC libraries**:
  https://account.teamofsilicons.com/.well-known/openid-configuration and the keys at
  https://account.teamofsilicons.com/.well-known/jwks.json.
* **Silicon Apps**: where apps are created and where the CLI's updates come from. The
  `accounts` CLI never updates itself.

## Using the Rust package

```toml
[dependencies]
silicon-accounts-client = "0.1"
```

```rust
use silicon_accounts_client::AccountsClient;

let client = AccountsClient::new("https://account.teamofsilicons.com")?;
let tokens = client.silicon_login("si:scout", &stk, None).await?;
let slt = client.with_token(tokens.access_token.expose()).short_lived_token("remind").await?;
```
