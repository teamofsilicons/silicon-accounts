---
title: Package manifest and targets
description: The apps.yaml schema, supported platforms, required executable commands and safe archive rules.
kind: informative
order: 50
related:
  - start/publish.md
  - learn/releases-and-updates.md
  - reference/rust-client.md
---

# Package manifest and targets

Place `apps.yaml` at the root of a `.tar.gz` package:

```yaml
schema_version: 1
app_id: ring
version: 0.1.0
command: ring
targets:
  macos-aarch64:
    binary: bin/ring
    # install_script: scripts/install.sh
  windows-x86_64:
    binary: windows/ring.exe
    # install_script: scripts/install.cmd
```

| Field | Rule |
|---|---|
| `schema_version` | 1; defaults to 1 if omitted |
| `app_id` | The existing immutable app ID; new app creation requires 3–30 lowercase letters, digits, hyphens or underscores |
| `version` | Strict `x.y.z`, without prerelease or build metadata |
| `command` | 1–80 letters, digits, hyphens or underscores; no directory or extension |
| `targets` | At least one supported target |
| `targets.TARGET.binary` | Existing regular file, relative to the package root |
| `targets.TARGET.install_script` | Optional existing regular file, relative to the package root |

Legacy existing IDs of 1–2 characters, such as `dm`, remain valid in manifests. That does not permit new short IDs. Unknown manifest fields are rejected. Development and production versions are separate histories, not prerelease suffixes.

## Targets

| Target | Operating system and architecture |
|---|---|
| `linux-x86_64` | Linux, Intel/AMD 64-bit |
| `linux-i686` | Linux, Intel/AMD 32-bit i686 |
| `linux-aarch64` | Linux, ARM64 |
| `linux-armv7hf` | Linux, ARMv7 32-bit hard-float |
| `windows-x86_64` | Windows, Intel/AMD 64-bit |
| `windows-i686` | Windows, Intel/AMD 32-bit |
| `windows-aarch64` | Windows, ARM64 |
| `macos-x86_64` | macOS, Intel 64-bit |
| `macos-aarch64` | macOS, Apple Silicon |

Every target is optional; at least one is required per release. `apps targets` reports observed account populations and runner availability. Counts come from registered authenticated accounts; they are not an estimate of all unknown users. Total reach deduplicates accounts across selected targets. A supported target name does not imply a deployed native runner.

## Executable contract

Every target executable must support `--help`, `accounts --json` with its `app_id`, and `login status --json` with `authenticated` and the signed-in identity when applicable. Upload validation tests the signed-out environment. The [publishing guide](../start/publish.md#implement-the-three-discovery-commands) explains the results.

## Validate, pack and extract

```sh
apps validate ./package
apps pack ./package --output ./ring.tar.gz
```

Validation aggregates discoverable manifest, missing-file and safety errors. Packing normalizes timestamps, ownership and modes for deterministic bytes. Keep output outside the package directory.

Paths must be relative, without parent traversal, backslashes, drive prefixes or absolute roots. Archives cannot contain duplicate entries, symbolic links, hard links or special files. Extraction requires an empty destination. The package library bounds archives to 512 MiB compressed, 1 GiB extracted and 20,000 entries; a hosted server or proxy may set a lower upload limit.

The package crate never executes uploaded content. Server command validation uses isolated target runners. Optional scripts run on the user's machine only with [explicit installation consent](../learn/releases-and-updates.md#installation-and-scripts).
