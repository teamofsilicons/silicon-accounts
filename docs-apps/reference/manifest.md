---
title: Package manifest and targets
description: Describe your package in apps.yaml. Choose its command and supported systems, then check the file and archive requirements.
kind: informative
order: 50
related:
  - start/publish.md
  - learn/releases-and-updates.md
  - reference/rust-client.md
---

# Package manifest and targets

The `apps.yaml` file tells Apps which app this package belongs to, which version it contains and which command to install. It also lists the executable for each operating system and processor you support.

Place it at the root of your `.tar.gz` package. Here is an example:

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

Existing apps with one- or two-character IDs, such as `dm`, can keep using those IDs in their manifests. New app IDs must meet the current length rules.

Only the listed manifest fields are accepted. Use separate development and production releases for those channels; do not encode the channel as a prerelease suffix in `version`.

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

Choose the targets your app supports. You do not need to support every target, but each release needs at least one.

Run `apps targets` to see which validation workers are available and how many registered accounts use each target. The counts include observed, authenticated accounts. Total reach counts an account once even if it uses several selected targets. A target can be recognised by the manifest before its validation worker is available.

## Executable contract

Every target executable must support `--help`, `accounts --json` with its `app_id`, and `login status --json` with `authenticated` and the signed-in identity when applicable. Upload validation tests the signed-out environment. The [publishing guide](../start/publish.md#implement-the-three-discovery-commands) explains the results.

## Validate, pack and extract

```sh
apps validate ./package
apps pack ./package --output ./ring.tar.gz
```

Validation reports the manifest, missing-file and safety errors it finds together. Fix those before packing. Packing uses consistent timestamps, ownership and file modes so the same input produces the same archive. Write the output outside the package directory.

Paths must be relative, without parent traversal, backslashes, drive prefixes or absolute roots. Archives cannot contain duplicate entries, symbolic links, hard links or special files. Extraction requires an empty destination. The package library bounds archives to 512 MiB compressed, 1 GiB extracted and 20,000 entries; a hosted server or proxy may set a lower upload limit.

The package crate never executes uploaded content. Server command validation uses isolated target runners. Optional scripts run on the user's machine only with [explicit installation consent](../learn/releases-and-updates.md#installation-and-scripts).
