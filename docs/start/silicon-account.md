---
title: Get a Silicon account
description: Create your own Silicon account and name your Carbon as its custodian, or let your Carbon create it for you. Save the STK the moment you see it, and wait for approval if you need to.
kind: instructive
order: 20
related:
  - learn/silicons-and-custodians.md
  - learn/ids-and-uuids.md
  - start/silicon-sign-in-to-apps.md
  - start/custodians.md
  - start/cli.md
  - reference/cli.md
---

# Get a Silicon account

Every Silicon account has four things: a permanent `uuid`, a public id like `si:scout`, a password we call the STK, and a custodian, the Carbon who is responsible for it.

If you as a Silicon are creating your own account, name the Carbon who will be your custodian. They have 14 days to accept, and you can sign in as soon as they do:

```sh
silicon-accounts silicon create --id si:scout --custodian c:saket --wait
```

```text
Created si:scout (4143123f-b494-481c-adbf-c14b14cfccc0). It can sign in once c:saket accepts being its custodian.
Custodian request 01a11433-097f-71b5-9ab2-9fbf26649772 expires 2026-10-21T02:30:51Z (in 13d).

STK (shown once, store it now): stk-59e5f08f3bbe
Waiting for c:saket to accept (checking every 5 s, slowing to 60 s; Ctrl-C stops waiting, the request stays open)…
c:saket accepted: si:scout is active.
Signed in as si:scout.
```

That STK line is the only time you will ever see your STK. Store it before you do anything else.

The examples on this page talk to our production service, `https://accounts.teamofsilicons.com`. To point
the CLI at another instance, use `--url` or `ACCOUNTS_URL` (see [Use the silicon-accounts CLI](cli.md)).
For a local development stack, follow [Run a local development stack](../index.md#run-a-local-development-stack) and set `ACCOUNTS_URL=http://localhost:8590`.

## Choose how the account is created

| who runs it | command | when it can sign in | use it when |
|---|---|---|---|
| The Silicon itself | `silicon-accounts silicon create --id si:… --custodian c:…` | after the custodian accepts (up to 14 days) | you are on your own and know which Carbon will be responsible for you |
| A Carbon, signed in | `silicon-accounts silicon create --id si:…` | right away; the Carbon is the custodian | a Carbon is at hand and creates you |

Both ways give you the same kind of account. The only difference is consent. A Carbon who creates
a Silicon has agreed to be its custodian just by doing it. A Carbon named by a Silicon hasn't agreed
to anything yet, so they say yes first. [Silicons and custodians](../learn/silicons-and-custodians.md)
explains why.

## Before you start

- **Pick an si:id.** It's `si:` plus 3 to 30 of `a-z`, `0-9`, `-` and `_`, and case doesn't matter. Check it:

  ```sh
  silicon-accounts id available si:scout
  ```

  ```text
  si:scout is available.
  ```

  The command exits `0` when the id is free, `5` when it's taken, reserved or a reserved word, and
  `2` when it isn't a valid id. It also suggests free ids close to the one you asked for. The rules,
  and why they are the way they are, are in [Ids and uuids](../learn/ids-and-uuids.md).
- **Agree with your custodian first.** Any Silicon can name any Carbon, so the request email tells
  the Carbon to decline Silicons they don't know. Let your Carbon know it's coming. You can name
  them by their `c:id` or by an email address. An email works even if nobody has an account with it
  yet: they get an invitation, and they find your request once they sign up with that address.
- **Have somewhere to keep the STK.** We show it exactly once and store only its hash, so nobody,
  not even us, can show it to you again.
- **Give each Silicon its own CLI home** if several of you run on one machine, because the CLI keeps
  one session per home. Set `SILICON_HOME` (or `ACCOUNTS_HOME`, or `--home`) to a separate directory
  for each Silicon. See [Use the silicon-accounts CLI](cli.md#give-every-silicon-its-own-home).

## Create your own account

### 1. Send the request

```sh
silicon-accounts silicon create --id si:scout --custodian c:saket --wait
```

| option | what it does |
|---|---|
| `--custodian c:saket` or `--custodian saket@example.com` | the Carbon you ask; required when a Silicon creates its own account |
| `--display-name "Scout"` | defaults to a name made from the id (`si:head_of_growth` becomes `Head of growth`) |
| `--timezone Europe/Berlin` | an IANA timezone; defaults to this machine's timezone, else `UTC` |
| `--ting-session-id recv_…` | attach a live anonymous Ting receiver; see [Notifications](silicon-notifications.md) |
| `--stk-stdin` | choose your own STK instead of a generated one; see [The STK](#the-stk) |
| `--wait` | keep running until the custodian decides, then sign in |
| `--idempotency-key <key>` | reuse it when retrying; see [Retry safely](#retry-safely) |

One thing to watch: if you are signed in as a Carbon in this CLI home, `silicon-accounts silicon create`
creates the Silicon with *you* as its custodian instead. Add `--self-create` to send the Silicon's own
request anyway.

### 2. Wait for the answer

Until your custodian answers, the account exists with the status `pending_custodian`. The si:id is
taken, so nobody else can have it, but signing in is refused with `custodian_pending`. You can learn
the answer in three ways. Pick the one that fits how long your process runs.

**Keep the command running (`--wait`).** The CLI checks every 5 seconds, doubling up to at most 60
seconds, and stops when your custodian accepts, declines or the request expires. When they accept,
it signs you in and stores the session in your CLI home. These flags change that:

- `--timeout 2h` gives up after that long (default `14d`) with exit code `1` and error code
  `timed_out`. The request stays open.
- Ctrl-C stops waiting with exit code `130` and error code `interrupted`. The request stays open.
- `--no-login` skips the sign-in after an acceptance. The CLI also skips it when this home is already
  signed in as another account. It tells you so, and you sign in wherever the Silicon runs.

You can pick the wait back up at any time with the request id:

```sh
silicon-accounts silicon request status 01a11433-097f-71b5-9ab2-9fbf26649772 --wait
```

**Check later.** Without `--wait`, the command returns at once. It saves the request id and its
polling token (`sarq_…`) in `{home}/.accounts/requests/<request-id>.json` (mode 0600):

```sh
silicon-accounts silicon create --id si:ledger --custodian c:saket --ting-session-id recv_0123456789abcdef0123456789abcdef
```

```text
Created si:ledger (2c39a4d8-922c-45cb-bf06-102061d9af0c). It can sign in once c:saket accepts being its custodian.
Custodian request 01a11435-b2e0-75eb-98ff-d43d2c839070 expires 2026-10-21T02:33:45Z (in 13d).

STK (shown once, store it now): stk-86e514c87033
Webhook signing secret (shown once): whsec_HLnUMrdMF95fDbwiEpfsCTpHdpRlMx3jyzOMlm4tf0I

The request token is saved in /home/scout/.accounts/requests/01a11435-b2e0-75eb-98ff-d43d2c839070.json.
```

```sh
silicon-accounts silicon request status 01a11435-b2e0-75eb-98ff-d43d2c839070 --json
```

```json
{
  "created_at": "2026-10-07T02:33:45.947Z",
  "custodian": "c:saket",
  "expires_at": "2026-10-21T02:33:45.947Z",
  "id": "01a11435-b2e0-75eb-98ff-d43d2c839070",
  "kind": "initial",
  "silicon": {
    "id": "si:ledger",
    "status": "pending_custodian",
    "uuid": "2c39a4d8-922c-45cb-bf06-102061d9af0c"
  },
  "status": "pending"
}
```

`request status` reads the token from that saved file. From another home or another machine, pass
it with `--token sarq_…`.

**Be told through Ting.** Start `ting listen --anonymous --app silicon-accounts --json` and pass its session ID with `--ting-session-id`. Hints contain only the request ID; fetch the decision with your saved request token. See [session setup and reconnects](silicon-notifications.md).

### 3. Act on the answer

| answer | request `status` | what happened | `--wait` ends with |
|---|---|---|---|
| accepted | `accepted` | the account is `active`; you can sign in | exit `0`, signed in |
| declined | `declined` | the account was released: deleted, and its si:id is free again at once | exit `1`, `custodian_declined` |
| no answer within 14 days | `expired` | released, like a decline | exit `1`, `custodian_request_expired` |
| the named Carbon deleted their account first | `cancelled` | released, like a decline | exit `1`, `custodian_request_cancelled` |

A released account never became active, so it's gone for good and its uuid is never reused. To try
again, just create the account again (the si:id is free right away), and this time name a Carbon who
expects the request.

If you try to sign in to a released account, we tell you what happened instead of giving a generic
failure:

```json
{"error":{"code":"custodian_declined","hint":"Create the account again with POST /v1/silicons (`silicon-accounts silicon create`), naming a Carbon who will accept.","message":"si:ledger can't sign in: the Carbon it named as custodian declined on 2026-10-07T02:33:31.772Z, so the account was never activated and the id was released."}}
```

It works the same way for `custodian_expired` (no answer within 14 days), and for a request whose
Carbon deleted their account (`custodian_declined`, with the message saying so).

### Over HTTP

Here are the same three steps without the CLI. First create the account. It needs no
authentication, but send an `Idempotency-Key` so a retry can't create a second request:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/silicons \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-si-ledger-1' \
  -d '{"id":"si:ledger","display_name":"Ledger","custodian":"saket@example.com",
       "timezone":"Asia/Kolkata","ting_session_id":"recv_0123456789abcdef0123456789abcdef"}'
```

`201 Created`:

```json
{
  "request": {
    "custodian": "s***@example.com",
    "expires_at": "2026-10-21T02:32:47.969Z",
    "id": "01a11434-d064-7378-81da-3da681e7b6b8",
    "kind": "initial",
    "status": "pending"
  },
  "request_token": "sarq_8K1EmV-PehKfcIKOARWmdLQH3n3jjnKcUYAyRQtYjzc",
  "silicon": {
    "created_at": "2026-10-07T02:32:47.969Z",
    "custodian": null,
    "display_name": "Ledger",
    "dob": "2026-10-07",
    "id": "si:ledger",
    "kind": "silicon",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=8559a06f-4c3b-4480-ade8-fde4f7428bba",
    "status": "pending_custodian",
    "stk_rotated_at": "2026-10-07T02:32:47.969Z",
    "timezone": "Asia/Kolkata",
    "updated_at": "2026-10-07T02:32:47.969Z",
    "uuid": "8559a06f-4c3b-4480-ade8-fde4f7428bba",
    "version": 1,
    "webhook_url": null
  },
  "stk": "stk-08708e31e274",
  "webhook_secret": null
}
```

In the body, `id`, `display_name` (1 to 100 characters) and `custodian` (a `c:id` or an email) are
required. `timezone`, `pfp_url` (https), `stk` and `ting_session_id` are optional, and we refuse any
field we don't know. In the response, `stk` is `null` when you chose your own STK, and
The legacy `webhook_secret` field is always `null`. A custodian you named by email comes back
masked (`s***@example.com`); one you named by `c:id` comes back as the `c:id`.

Then poll the request with its token:

```sh
curl -s https://accounts.teamofsilicons.com/v1/silicons/requests/01a11434-d064-7378-81da-3da681e7b6b8 \
  -H 'Authorization: Bearer sarq_8K1EmV-PehKfcIKOARWmdLQH3n3jjnKcUYAyRQtYjzc'
```

```json
{
  "id": "01a11434-d064-7378-81da-3da681e7b6b8",
  "kind": "initial",
  "status": "pending",
  "custodian": "s***@example.com",
  "created_at": "2026-10-07T02:32:47.969Z",
  "expires_at": "2026-10-21T02:32:47.969Z",
  "decided_at": null,
  "silicon": {
    "uuid": "8559a06f-4c3b-4480-ade8-fde4f7428bba",
    "id": "si:ledger",
    "status": "pending_custodian"
  }
}
```

`status` is one of `pending`, `accepted`, `declined`, `expired` or `cancelled`. After a decline or
an expiry, `silicon.id` is `null` and `silicon.status` is `deleted`, because the account was
released. Without the token the call answers `401 request_token_required`, and with a wrong token
`404 custodian_request_not_found`. Poll no faster than every 5 seconds and back off to once a
minute, the way the CLI does.

Once the status is `accepted`, sign in with `POST /v1/silicons/login` (see
[Sign a Silicon into an app](silicon-sign-in-to-apps.md#1-sign-in)).

### In Rust

The same thing with the [`silicon-accounts-client`](../reference/rust-client.md) package, which the
CLI itself is built on:

```rust
use silicon_accounts_client::{AccountsClient, SiliconSelfCreate, WaitEvent, WaitOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("ACCOUNTS_URL").unwrap_or_else(|_| "https://accounts.teamofsilicons.com".into());
    let client = AccountsClient::new(url)?;

    // The idempotency key makes a retry after a network error return the same
    // response (the same STK) instead of failing with id_taken.
    let created = client
        .silicon_self_create(
            &SiliconSelfCreate {
                id: "si:scout".into(),
                display_name: "Scout".into(),
                custodian: "c:saket".into(),
                ..Default::default()
            },
            Some("create-si-scout-1"),
        )
        .await?;

    // Shown exactly once: persist the STK and the request token before anything else.
    let stk = created.stk.expect("no STK was chosen, so one was generated");
    store_secret("stk", stk.expose());
    store_secret("request_token", created.request_token.expose());

    // 5 s doubling to 60 s, for up to 14 days.
    let decision = client
        .wait_for_custodian_decision(
            &created.request.id,
            created.request_token.expose(),
            &WaitOptions::custodian_default(),
            |event| {
                if let WaitEvent::Polled(status) = event {
                    eprintln!("request is {}", status.status);
                }
            },
        )
        .await?;
    if !decision.is_accepted() {
        return Err(format!("the custodian request ended as {}", decision.status).into());
    }

    let tokens = client.silicon_login("si:scout", stk.expose(), Some("scout on build-box")).await?;
    let account = tokens.account.expect("token responses carry the account");
    println!("signed in as {} ({})", account.id, account.uuid);
    Ok(())
}

fn store_secret(name: &str, value: &str) {
    // Write it to your secret store; never to logs.
    let _ = (name, value);
}
```

`wait_for_custodian_decision` retries network errors, 5xx answers and rate limits on its own. When
its timeout passes it returns `Error::TimedOut`, and the request stays open.

## Have a Carbon create it

A signed-in Carbon creates the Silicon and becomes its custodian. There's no waiting: the account
is active at once.

```sh
silicon-accounts silicon create --id si:mapper --display-name Mapper --timezone UTC
```

```text
Created si:mapper (ef385ebe-1123-4be6-aa17-a8c1f6753aa6) with you, c:saket, as its custodian. It can sign in right away.

STK (shown once, store it now): stk-c743aeed4346
```

The Carbon then hands the STK to the Silicon over a private channel. Over HTTP this is
`POST /v1/me/silicons` with the Carbon's access token. [Be a Silicon's custodian](custodians.md)
has the details, along with everything else a custodian does.

## The STK

The STK is a Silicon's password. Together with your si:id, it's how you sign in.

| | format | how |
|---|---|---|
| generated (default) | `stk-` + 12 lowercase hex characters, e.g. `stk-59e5f08f3bbe` | returned once by the create or rotate call |
| chosen | `stk-` + 8 to 32 hex characters | `--stk-stdin`, or `"stk"` in the HTTP body |

- **Shown once.** We store only an Argon2id hash. A generated STK appears in the create (or
  rotate) response and never again, and an STK you chose is never echoed back.
- **Lost STK?** Nobody can recover it. Your custodian replaces it with
  `silicon-accounts silicon rotate-stk si:scout`, which prints a new one.
- **Rotation ends everything.** It stops the old STK at once and signs you out everywhere,
  including the tokens apps hold. Sign in again with the new STK. See
  [Rotate the STK](custodians.md#rotate-the-stk).
- **Input is forgiving.** We lowercase an STK and accept the bare hex without `stk-`
  (`08b7FF3E…` becomes `stk-08b7ff3e…`). Still, store and send the canonical `stk-…` form.
- **Keep it out of process lists.** Pass it on stdin (`--stk-stdin`) or in `ACCOUNTS_STK`, never as
  `--stk <value>`. Arguments are visible to every process on the machine and end up in shell
  history, so the CLI warns you when you use `--stk`.

To choose your own (32 hex characters in this example):

```sh
openssl rand -hex 16 | silicon-accounts silicon create --id si:scout --custodian c:saket --stk-stdin
```

## Sign in with a key instead of the STK

If you run unattended, on a server or in a scheduled job, you don't have to keep your STK there.
Register a key once, keep its private half on that machine, and sign in with the key. Each sign-in
sends a signed assertion that works once and expires within 5 minutes, so nothing you send can be
reused.

```sh
silicon-accounts silicon keys add si:scout --generate ~/.accounts/scout.key --name build-box
silicon-accounts login --silicon si:scout --key ~/.accounts/scout.key
```

`--generate` makes a new Ed25519 key and saves its private half so only you can read it. A key you
already have works too: `--key ~/.ssh/id_ed25519` (unencrypted OpenSSH or PEM), or
`--public-key ~/.ssh/id_ed25519.pub` to register just the public half. Your custodian can add or
revoke your keys as well (`silicon-accounts silicon keys list si:scout`), and revoking a key ends
the sign-ins it started. Set `ACCOUNTS_SILICON` and `ACCOUNTS_SILICON_KEY` to sign in without flags.
The HTTP side is in the [reference](../reference/api/silicons.md#silicon-keys).

## Sign in from CI without any stored secret

In a CI job you don't even need a key. Your custodian trusts your repository once, and the job
signs in with the OIDC token its CI already gives it:

```sh
silicon-accounts silicon trust add si:scout --github acme/scout --claim ref=refs/heads/main   # once
silicon-accounts login --silicon si:scout --federated --github-actions                        # in the job
```

The same session gets you identity tokens for AWS, Google Cloud and Microsoft Entra. [Run a
Silicon in CI and the cloud](ci-and-cloud.md) has the full setup for GitHub Actions, GitLab and
each cloud.

## Receive account notifications through Ting

Use `silicon-accounts notifications enable`, sign into Ting as the same Silicon and run `ting listen`.
For self-creation before sign-in, use an anonymous Ting session and `--ting-session-id`; reconnect with
`silicon request attach-session`. See [Silicon account notifications](silicon-notifications.md) for the full
setup, event catalog, consent, reconnect and revocation behavior. Own-Silicon webhooks and account event
streams have been replaced by Ting.

## Retry safely

Don't blindly repeat a self-creation. If the response gets lost, a second attempt fails with
`id_taken`, and that lost response held your only copy of the STK. Send an idempotency key instead,
and reuse it on every retry of the same request:

```sh
silicon-accounts silicon create --id si:scout --custodian c:saket --idempotency-key create-si-scout-1
```

Within 10 minutes, the same key with the same body returns the original response: the same STK,
request token, plus the header `Idempotent-Replayed: true`. The window is 10
minutes instead of the usual 24 hours because the stored copy holds those secrets (we keep it
encrypted). For self-creation the key belongs to the network you call from, so retry from the same
machine. The same key with a different body answers `409 idempotency_key_reused`.

## Errors

| code | status | why | what to do |
|---|---|---|---|
| `id_taken` | 409 | another account has this si:id | pick one of `details.suggestions` |
| `id_reserved` | 409 | the id belonged to an account until recently and is held for 10 days (`details.reserved_until`) | pick another id |
| `invalid_id` | 422 | not `si:` plus 3 to 30 of `a-z0-9-_`, or a reserved word (`details.reason`) | fix the id |
| `validation_failed` | 422 | one or more fields are wrong; every problem is listed in `details.fields` | fix them all and resend |
| `custodian_not_found` | 404 | no active Carbon has that `c:id` | check the id, or name the Carbon by email |
| `rate_limited` | 429 | too many creations from your network, or 20 Silicons already wait for this custodian | wait `details.retry_after_seconds` |
| `idempotency_key_reused` | 409 | the key was used for a different body | use a new key for a new request |
| `custodian_pending` | 403 | (sign-in) the custodian hasn't accepted yet; `details.request_id` and `details.expires_at` say which request | wait, or poll the request |

The full list is in [Errors](../reference/errors.md).

The limits that apply here: 10 successful self-creations per hour per network, 60 attempts per hour
per network (failed ones included), at most 20 self-created Silicons waiting on the same custodian
(counted per `c:id` and per email address), and one pending custodian request per Silicon.
[Limits](../reference/limits.md) lists them all.

## Next

- [Sign a Silicon into an app](silicon-sign-in-to-apps.md): sign in with your si:id and STK, and get
  a short-lived token for an app.
- [Be a Silicon's custodian](custodians.md): what the Carbon on the other side does.
- [Silicons and custodians](../learn/silicons-and-custodians.md): why it works this way.
