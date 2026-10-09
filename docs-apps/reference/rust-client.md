---
title: Rust packages
description: Use the Apps Rust libraries to manage apps, build packages and install updates. You choose where local sessions and installation records live.
kind: informative
order: 80
related:
  - reference/api.md
  - reference/manifest.md
  - reference/cli.md
---

# Rust packages

Use `silicon-apps-client` to call Apps from Rust. The CLI is built on this same library. You create the HTTP client with a service URL and, when you need one, a bearer token. Creating it doesn't read environment variables, save a session or set up local files.

Use `silicon-apps-package` to check manifests, build archives and work out checksums. It reads and writes package files without ever running what's in them.

```toml
[dependencies]
silicon-apps-client = "0.1.8"
silicon-apps-package = "0.1.2"
```

The CLI release is 0.1.10, and the package versions move independently of it. The full generated Rust references are on [docs.rs for the client](https://docs.rs/silicon-apps-client) and [docs.rs for package tooling](https://docs.rs/silicon-apps-package).

## Read the catalog

```rust
use silicon_apps_client::Client;

async fn browse() -> anyhow::Result<()> {
    let apps = Client::new("https://apps.teamofsilicons.com", None)?
        .with_telemetry(false);
    let matches = apps.search("terminal", false, false).await?;
    let details = apps.app("silicon-apps").await?;
    println!("{matches}\n{details}");
    Ok(())
}
```

`create`, `edit`, `action`, `upload`, `upload_signed`, `withdraw_release`, `resolve`, `report` and `register_platform` cover authoring and store operations. `capabilities`, `events`, `stream_events` and the `subscriptions` methods follow what happens ([events](events.md)), and `author_keys`, `add_author_key`, `revoke_author_key` and `signing_keys` manage keys. `request` gives you the documented user-facing HTTP contract directly, for extra filters and optional fields.

An error answer from the service is an `ApiError` with `status`, `code`, `message`, `hint` and `details`. Get it with `error.downcast_ref::<silicon_apps_client::ApiError>()`. Mutations take an idempotency key you supply, and if you don't, a new UUID identifies the operation. When you don't know whether a request got through, keep one key across your retries.

## Local operations use explicit state

```rust
use silicon_apps_client::{Client, Config, LocalState, install};

async fn install_app() -> anyhow::Result<()> {
    let state = LocalState::new("/home/me")?; // existing directory
    let config = Config::default();
    let apps = Client::new(&config.server, None)?;
    let spec = "ring>dev@1.2.3".parse()?;
    let result = install::install(&apps, &state, &config, &spec, false).await?;
    println!("{}", result.message);
    Ok(())
}
```

Pass a `LocalState` when an operation needs to save sessions or installation records. You choose its home directory.

`auth::authenticated_client` uses the official Silicon Accounts client. It saves tokens per service URL and coordinates refreshes across processes, so a rotating token is never used twice. The CLI reads `APPS_TOKEN`, but creating a `Client` doesn't read it for you.

During installation, the library checks the metadata, the checksum and the release signature (`signing::verify_package`), and the author signature when there is one. Only then does it extract the archive within its limits and check that no other app owns the command. A failed check is a `signing::VerificationError` with a stable `code`. Trusted keys live in the state you pass, per service ([signed releases](../learn/signed-releases.md)). It prepares the new files before replacing the installation, and puts the previous package back if installation fails. Bundled scripts run automatically during installs and updates, with a timeout.

If the server is unavailable when the installation receipt is sent, the library saves the receipt and retries it later, without counting the same installation twice. The installed record also keeps the registry the app came from.

`install::inspect_install_script` checks a release's signatures and returns its install script without installing anything. `InstallOutcome.notice` is one line about a changed install script or author signature. `signing::AuthorKey` creates, saves, loads and signs with author keys.

`updater::run` checks the installed channels, Apps included, using explicit state. It moves an app off a withdrawn release to the latest good one and reports `replaced_withdrawn`. `service_definition` builds the launchd, systemd or Task Scheduler configuration, and `install_service` turns it on when you ask. On Windows, self-update uses a helper and a runtime copy so installed executables can be replaced.

## Package tooling

`validate_directory` reports every error it finds at once. `pack_directory` creates deterministic `.tar.gz` bytes. `inspect_archive` checks the archive's structure and manifest, and `extract_archive` needs an empty destination. `sha256` returns the lowercase digest of the content. See [manifest and archive rules](manifest.md).

The bundled instructive and informative guides are available through `docs::guide(topic)` with no filesystem or network access. It's the same text `silicon-apps docs TOPIC` shows. Service-internal migration and isolated-runner administration are deliberately left out of the public client.
