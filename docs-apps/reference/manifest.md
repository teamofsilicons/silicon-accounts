---
title: Package manifest and targets
description: Describe your package in apps.yaml. Choose its command and the systems it supports, then check the rules every file and archive must follow.
kind: informative
order: 50
related:
  - start/publish.md
  - learn/releases-and-updates.md
  - reference/rust-client.md
---

# Package manifest and targets

The `apps.yaml` file tells Apps which app the package belongs to, which version it is and which command to install. It also lists the executable for each operating system and processor you support.

Put it at the root of your `.tar.gz` package, like this:

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
| `app_id` | The existing immutable app ID; new app creation requires 3 to 30 lowercase letters, digits, hyphens or underscores |
| `version` | Strict `x.y.z`, without prerelease or build metadata |
| `command` | 1 to 80 letters, digits, hyphens or underscores; no directory or extension |
| `targets` | At least one supported target |
| `targets.TARGET.binary` | Existing regular file, relative to the package root |
| `targets.TARGET.install_script` | Optional existing regular file, relative to the package root |

Existing apps with one- or two-character IDs, such as `dm`, can keep using them in their manifests. New app IDs must follow the current length rules.

Only the fields listed above are accepted. Use separate development and production releases for those channels, and don't put the channel in `version` as a prerelease suffix.

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

Pick the targets your app supports. You don't need every one, but each release needs at least one.

Run `silicon-apps targets` to see which validation workers are configured and how many registered accounts use each target, and `silicon-apps capabilities` to see which ones answer right now. Today the four Linux workers are live (`linux-x86_64`, `linux-i686`, `linux-aarch64` and `linux-armv7hf`), so those are the targets you can upload for. Windows and macOS have no worker yet, and an upload for one of their targets is refused until its worker is live. The counts include observed, signed-in accounts, and total reach counts an account once even when it uses several of the targets you picked. The manifest can recognise a target before its validation worker is available.

## Executable contract

Every target's executable must support `--help`, `accounts --json` with its `app_id`, and `login status --json` with `authenticated` and, when someone is signed in, who it is. Upload validation tests it signed out. The [publishing guide](../start/publish.md#implement-the-three-discovery-commands) explains what each command must return.

## Validate, pack and extract

```sh
silicon-apps validate ./package
silicon-apps pack ./package --output ./ring.tar.gz
```

Validation reports every manifest, missing-file and safety error it finds at once. Fix them before you pack. Packing uses consistent timestamps, ownership and file modes, so the same input always produces the same archive. Write the output outside the package directory.

Paths must be relative, with no parent traversal, backslashes, drive prefixes or absolute roots. Archives can't contain duplicate entries, symbolic links, hard links or special files. Extracting needs an empty destination. The package library caps archives at 512 MiB compressed, 1 GiB extracted and 20,000 entries, and a hosted server or proxy may set a lower upload limit.

The package crate never runs what you upload. The server validates commands in isolated target runners. Optional scripts run on the user's machine only with [explicit installation consent](../learn/releases-and-updates.md#installation-and-scripts).
