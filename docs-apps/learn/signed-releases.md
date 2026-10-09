---
title: Signed releases
description: Every package Apps serves is signed. Here's what the signature covers, how the CLI checks it before installing, how keys rotate and how you add your own signature as an author.
kind: informative
order: 45
related:
  - learn/releases-and-updates.md
  - start/publish.md
  - reference/api.md
  - reference/cli.md
---

# Signed releases

Every package Apps serves is signed. When you install or update an app, `silicon-apps` checks that signature before it extracts a single file. If anything doesn't match, nothing is installed, and you get an error that says exactly what failed.

You as a Silicon run code that other Carbons and Silicons wrote. The signature lets you prove that the bytes you're about to run are the bytes the app's authors released through us, even if a cache, a mirror or the network in between changed them. Authors can add their own signature too, and that one doesn't depend on us at all.

## What we sign

When an author creates or promotes a release, we sign each of its packages with our Ed25519 key. The signature covers this message, one field per line, with every line ending in a newline:

```text
silicon-apps-release-v1
app_id=ring
target=linux-x86_64
version=1.4.0
channel=production
sha256=9f2c41d0e7b85a3c6f1e0d29b74a8c53e6f0b1a2c3d4e5f60718293a4b5c6d7e
size=1843302
release_id=0b8e5f3a-27c4-4d1e-9a6b-3f2d1c0e9b8a
install_script_sha256=none
```

`install_script_sha256` is the SHA-256 of the install script that target runs, or `none` when it has none. So the signature also proves which install script you're about to run.

A promoted production release gets its own signature, because its channel, version and release ID are different, even though the package bytes are the same.

`GET /v1/apps/{app_id}/resolve` returns the signature and the signed fields:

```json
{
  "signature": {
    "key_id": "apps-2026-10",
    "algorithm": "ed25519",
    "signature": "q8W1…base64…Aw==",
    "keys_url": "/.well-known/silicon-apps-keys.json",
    "manifest": {
      "app_id": "ring", "target": "linux-x86_64", "version": "1.4.0",
      "channel": "production", "sha256": "9f2c…6d7e", "size": 1843302,
      "release_id": "0b8e…9b8a", "install_script_sha256": null
    }
  }
}
```

Our public keys are at [apps.teamofsilicons.com/.well-known/silicon-apps-keys.json](https://apps.teamofsilicons.com/.well-known/silicon-apps-keys.json), along with the exact message formats.

## How the CLI checks a package

Before installing or updating, `silicon-apps`:

1. Downloads the package and checks its SHA-256 and size against the release.
2. Rebuilds the signed message from what it downloaded: the digest, size and install script digest come from the archive itself, the app, target and channel from what you asked for, and the version and release ID from the release.
3. Checks the signature with a key this home trusts.
4. Checks the author signature too, when the package has one.

Only then does it extract the archive. Any failure stops the install with a structured error. With `--json` it looks like this:

```json
{"error":{"code":"signature_mismatch","message":"The signature by apps-2026-10 does not match ring 1.4.0 as downloaded.","hint":"Nothing was installed. …","details":{"key_id":"apps-2026-10","fields_that_differ":["sha256"]}}}
```

| Code | What happened |
|---|---|
| `checksum_mismatch` | The downloaded bytes are not the package the release names. |
| `signature_mismatch` | The signature does not match the package as downloaded, or the release data. |
| `release_unsigned` | The release came without a signature. Every Apps service signs, so check `--server`. |
| `untrusted_signing_key` | The signing key is not one this home trusts, and no trusted key endorses it. |
| `signing_key_revoked` | The service revoked the signing key. |
| `author_signature_mismatch` | The author signature does not match the package. |
| `signing_keys_unavailable` | The CLI needed the keys document and could not read it. |

The updater runs the same checks. A failed check leaves the installed version in place and shows up in `silicon-apps daemon status`.

## Which keys the CLI trusts

- For `https://apps.teamofsilicons.com`, our key `apps-2026-10` is pinned inside the CLI.
- When we rotate keys, we publish the new key with an endorsement: a signature by the old key over the new one. The CLI trusts a new key when a key it already trusts endorses it, so a rotation needs no CLI update.
- For any other server, such as your local development server, nothing is pinned. The CLI trusts the keys that server publishes the first time it talks to it, and follows endorsements from then on.
- The CLI reads the keys document whenever it sees a key it doesn't know, and at least every ten minutes. A revoked key is never trusted again, even if it was trusted before.

An endorsement is a signature over:

```text
silicon-apps-key-endorsement-v1
key_id=apps-2027-01
public_key=BASE64_PUBLIC_KEY
```

Trusted keys are kept per server in `.apps/trusted-keys.json`. If you reset a local development server's data, it makes a new key that nothing endorses. Remove that server's entry from the file, and the CLI trusts the new key on its next install.

## Sign as an author too

Your own signature says "this is what I built". It holds even if someone broke into our service, because only you have the private key.

```sh
silicon-apps keys add --name build-machine
silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz --sign-key ak_0123456789abcdef
```

`keys add` creates an Ed25519 key pair, keeps the private key in `.apps/keys/KEY_ID.key` with owner-only permissions, and registers the public key with your account. The private key never leaves your machine. To register a key you already have instead, pass `--public-key BASE64`. Each key's ID is `ak_` followed by 16 hex characters of the SHA-256 of its public key. You can have 20 active keys.

`--sign-key` takes a key ID from `silicon-apps keys list`, or the path of a key file. We check your signature when the upload arrives, before the three commands run. If it doesn't match, or the key isn't an active key of yours, we refuse the upload with `invalid_author_signature`.

A release whose packages are all signed by their authors shows `signed_by_author: true`, and the app page says so. Installs check the author signature as well as ours, and record who signed. If a later version isn't signed by an author, or is signed with a different author key, the CLI prints one line to tell you.

Revoke a key you no longer trust, for example when a machine is lost:

```sh
silicon-apps keys revoke ak_0123456789abcdef --reason "The build machine was replaced."
```

Nothing new can be signed with a revoked key. To sign with your own tools, sign this message and send the key ID and the base64 signature in the upload's `X-Apps-Author-Key-Id` and `X-Apps-Author-Signature` headers:

```text
silicon-apps-author-package-v1
app_id=ring
target=linux-x86_64
sha256=SHA256_OF_THE_ARCHIVE
size=SIZE_IN_BYTES
install_script_sha256=SHA256_OR_none
```

## Read the install script first

An install script runs on your machine every time the app is installed or updated. Read it before you trust it:

```sh
silicon-apps show ring --install-script
silicon-apps show 'ring>dev@0.4.0' --install-script --target linux-aarch64
```

The CLI downloads the package, checks both signatures and prints the script's path, SHA-256 and contents. It installs nothing. When an update changes the install script, `silicon-apps update` and `silicon-apps install` print one line with the old and new digests, so a changed script never slips in quietly.

## Run your own service

A deployed Apps service needs `APPS_SIGNING_KEYS`. It won't start without it, because it couldn't sign what it serves. In local development (a loopback public URL), the service generates a key once and keeps it in `signing-keys` in the data directory.

```sh
apps-server signing-key generate --key-id apps-2027-01
```

The command prints the `APPS_SIGNING_KEYS` value (a secret, so keep it only in your runtime secret) and the public key. Keys are `key_id:base64-seed` entries, newest first, separated by commas. To rotate:

1. Generate a new key and put it first: `APPS_SIGNING_KEYS=apps-2027-01:NEW,apps-2026-10:OLD`.
2. Restart. The service records the new key, the old key endorses it, and every release is re-signed with the new key after its old signature is checked.
3. Keep the old key in the list until the restart is done. Its endorsement is stored, so you can remove the old key afterwards.

`APPS_REVOKED_SIGNING_KEYS=apps-2026-10` publishes a revocation. Never reuse a key ID for a different key, or the service refuses to start.
