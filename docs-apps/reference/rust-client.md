---
title: Rust packages
description: Use the stateless silicon-apps-client library for catalog operations and explicit local adapters for installation, authentication and updates.
kind: informative
order: 80
related:
  - reference/api.md
  - reference/manifest.md
  - reference/cli.md
---

# Rust packages

`silicon-apps-client` is the primary interface used by the CLI. Its HTTP client holds an explicit service URL and optional bearer token; constructing it does not load environment variables, persist sessions or initialize local state. `silicon-apps-package` handles manifests, deterministic archives and checksums without executing package content.

```toml
[dependencies]
silicon-apps-client = "0.1.3"
silicon-apps-package = "0.1.2"
```

The CLI release is 0.1.4; package versions are independent. Full generated Rust references are on [docs.rs for the client](https://docs.rs/silicon-apps-client) and [docs.rs for package tooling](https://docs.rs/silicon-apps-package).

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

The library provides persistence adapters through an explicit `LocalState`. `auth::authenticated_client` uses the official Silicon Accounts client, binds saved tokens to service URLs and serializes rotating refresh use across processes. `APPS_TOKEN` is interpreted by the CLI, not implicitly by `Client`.

Installation verifies metadata and content digest, safely extracts bounded archives, checks command ownership and stages replacements with rollback. Optional scripts require consent and a timeout. The durable idempotent install-receipt outbox handles temporary server unavailability. Each installed record retains its registry source.

`updater::run` checks the installed channels, including Apps, using explicit state. `service_definition` builds launchd, systemd or Task Scheduler configuration; `install_service` activates it when requested. Windows self-update uses a helper and runtime copy to allow replacement of installed executables.

## Package tooling

`validate_directory` reports discovered errors together. `pack_directory` creates deterministic `.tar.gz` bytes. `inspect_archive` validates archive structure and manifest; `extract_archive` requires an empty destination. `sha256` returns the lowercase content digest. See [manifest and archive rules](manifest.md).

Bundled instructive and informative guides are available without filesystem or network access through `docs::guide(topic)`, the same text used by `apps docs TOPIC`. Service-internal migration and isolated-runner administration are intentionally not part of the public client.
