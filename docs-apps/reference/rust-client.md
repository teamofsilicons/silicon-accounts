---
title: Rust packages
description: Use the Apps Rust libraries to manage apps, create packages and install updates. Choose explicitly where local sessions and installation records are stored.
kind: informative
order: 80
related:
  - reference/api.md
  - reference/manifest.md
  - reference/cli.md
---

# Rust packages

Use `silicon-apps-client` to call Apps from Rust. The CLI uses this same library. Create the HTTP client with a service URL and, when needed, a bearer token. Creating it does not read environment variables, save a session or set up local files.

Use `silicon-apps-package` to check manifests, build archives and calculate checksums. It reads and writes package files without running their contents.

```toml
[dependencies]
silicon-apps-client = "0.1.4"
silicon-apps-package = "0.1.2"
```

The CLI release is 0.1.5; package versions are independent. Full generated Rust references are on [docs.rs for the client](https://docs.rs/silicon-apps-client) and [docs.rs for package tooling](https://docs.rs/silicon-apps-package).

## Read the catalog

```rust
use silicon_apps_client::Client;

async fn browse() -> anyhow::Result<()> {
    let apps = Client::new("https://apps.teamofsilicons.com", None)?
        .with_telemetry(false);
    let matches = apps.search("terminal", false, false).await?;
    let details = apps.app("apps").await?;
    println!("{matches}\n{details}");
    Ok(())
}
```

`create`, `edit`, `action`, `upload`, `resolve`, `report` and `register_platform` cover authoring and store operations. `request` exposes the documented user-facing HTTP contract for additional filters and optional fields. Mutations accept caller-supplied idempotency keys; otherwise a new UUID identifies the operation. Retain one key across retries after an unknown network outcome.

## Local operations use explicit state

```rust
use silicon_apps_client::{Client, Config, LocalState, install};

async fn install_app() -> anyhow::Result<()> {
    let state = LocalState::new("/home/me")?; // existing directory
    let config = Config::default();
    let apps = Client::new(&config.server, None)?;
    let spec = "ring>dev@1.2.3".parse()?;
    let result = install::install(&apps, &state, &config, &spec, false, false).await?;
    println!("{}", result.message);
    Ok(())
}
```

Pass a `LocalState` when an operation needs to save sessions or installation records. You choose its home directory.

`auth::authenticated_client` uses the official Silicon Accounts client. It saves tokens for their service URLs and coordinates refreshes across processes so a rotating token is not used twice. The CLI reads `APPS_TOKEN`; creating a `Client` does not read it automatically.

During installation, the library checks the metadata and checksum, extracts the archive within its limits and checks that the command is not owned by another app. It prepares the new files before replacing the installation and restores the previous package if installation fails. Optional scripts require consent and a timeout.

If the server is unavailable when the installation receipt is sent, the library saves it for retry without counting the same installation twice. The installed record also keeps the registry the app came from.

`updater::run` checks the installed channels, including Apps, using explicit state. `service_definition` builds launchd, systemd or Task Scheduler configuration; `install_service` activates it when requested. Windows self-update uses a helper and runtime copy to allow replacement of installed executables.

## Package tooling

`validate_directory` reports discovered errors together. `pack_directory` creates deterministic `.tar.gz` bytes. `inspect_archive` validates archive structure and manifest; `extract_archive` requires an empty destination. `sha256` returns the lowercase content digest. See [manifest and archive rules](manifest.md).

Bundled instructive and informative guides are available without filesystem or network access through `docs::guide(topic)`, the same text used by `silicon-apps docs TOPIC`. Service-internal migration and isolated-runner administration are intentionally not part of the public client.
