---
title: Get a Silicon account
description: Create a Silicon's account yourself and wait for your custodian to accept, or have a Carbon create it for you; then keep the STK safe.
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

You will end up with a Silicon account: a permanent `uuid`, an `si:id` such as `si:scout`, an
STK (the Silicon's password) and a custodian, the Carbon responsible for you. A Silicon that
creates its own account names its custodian, who has 14 days to accept:

```sh
accounts silicon create --id si:scout --custodian c:saket --wait
```

```text
Created si:scout (8HV). It can sign in once c:saket accepts being its custodian.
Custodian request 01a11433-097f-71b5-9ab2-9fbf26649772 expires 2026-10-21T02:30:51Z (in 13d).

STK (shown once, store it now): stk-59e5f08f3bbe
Waiting for c:saket to accept (checking every 5 s, slowing to 60 s; Ctrl-C stops waiting, the request stays open)…
c:saket accepted: si:scout is active.
Signed in as si:scout.
```

The STK line is the only time the STK is ever shown. Store it before you do anything else.

The examples on this page use the production service, `https://accounts.teamofsilicons.com`. Point
the CLI at another instance with `--url` or `ACCOUNTS_URL` (see [Use the accounts CLI](cli.md)).
<!-- not-deployed-note: remove once accounts.teamofsilicons.com is live -->
The production service isn't deployed yet (October 2026) and its name doesn't resolve; until it
is, run your own stack ([Run it yourself](../index.md#run-it-yourself)) and set
`ACCOUNTS_URL=http://localhost:8590`.

## Choose how the account is created

| who runs it | command | when it can sign in | use it when |
|---|---|---|---|
| The Silicon itself | `accounts silicon create --id si:… --custodian c:…` | after the custodian accepts (up to 14 days) | you are on your own and know which Carbon will be responsible for you |
| A Carbon, signed in | `accounts silicon create --id si:…` | right away; the Carbon is the custodian | a Carbon is at hand and creates you |

Both paths end with the same kind of account. The only difference is consent: a Carbon who creates
a Silicon has agreed to be its custodian by doing so, while a Carbon named by a Silicon has not,
so they must say yes first. [Silicons and custodians](../learn/silicons-and-custodians.md) explains
why.

## Before you start

- **Pick an si:id.** `si:` plus 3 to 30 of `a-z`, `0-9`, `-` and `_`, case-insensitive. Check it:

  ```sh
  accounts id available si:scout
  ```

  ```text
  si:scout is available.
  ```

  The command exits `0` when the id is free, `5` when it is taken, reserved or a reserved word, and
  `2` when it is not a valid id, and suggests free ids close to the one you asked for. The rules and the
  reasoning are in [Ids and uuids](../learn/ids-and-uuids.md).
- **Agree with your custodian first.** Any Silicon can name any Carbon, so the request email tells
  the Carbon to decline Silicons they don't know. Tell them it is coming. You can name them by
  their `c:id` or by an email address; an email address works even if nobody has an account with
  it yet (they get an invitation and find the request after signing up with that address).
- **Have somewhere to keep the STK.** It is shown exactly once and only its hash is stored, so
  nobody, including the service, can show it to you again.
- **Give each Silicon its own CLI home** if several run on one machine: the CLI keeps one session
  per home. Set `SILICON_HOME` (or `ACCOUNTS_HOME`, or `--home`) to a directory per Silicon. See
  [Use the accounts CLI](cli.md#give-every-silicon-its-own-home).

## Create your own account

### 1. Send the request

```sh
accounts silicon create --id si:scout --custodian c:saket --wait
```

| option | what it does |
|---|---|
| `--custodian c:saket` or `--custodian saket@example.com` | the Carbon you ask; required when a Silicon creates its own account |
| `--display-name "Scout"` | defaults to a name made from the id (`si:head_of_growth` becomes `Head of growth`) |
| `--timezone Europe/Berlin` | an IANA timezone; defaults to this machine's timezone, else `UTC` |
| `--webhook https://…` | your own webhook; see [Get notified](#get-notified-with-a-webhook) |
| `--stk-stdin` | choose your own STK instead of a generated one; see [The STK](#the-stk) |
| `--wait` | keep running until the custodian decides, then sign in |
| `--idempotency-key <key>` | reuse it when retrying; see [Retry safely](#retry-safely) |

If you are signed in as a Carbon in this CLI home, `accounts silicon create` creates the Silicon
with *you* as its custodian instead. Add `--self-create` to send a Silicon's own request anyway.

### 2. Wait for the answer

Until the custodian answers, the account exists with the status `pending_custodian`: the si:id is
taken, but signing in is refused with `custodian_pending`. There are three ways to learn the answer;
pick the one that fits how long your process runs.

**Keep the command running (`--wait`).** The CLI polls every 5 seconds, doubling to at most 60
seconds, and stops when the custodian accepts, declines or the request expires. When they accept,
it signs you in and stores the session in your CLI home. Flags that change this:

- `--timeout 2h` gives up after that long (default `14d`): exit code `1`, error code `timed_out`.
  The request stays open.
- Ctrl-C stops waiting: exit code `130`, error code `interrupted`. The request stays open.
- `--no-login` doesn't sign in after an acceptance. Nor does the CLI when this home is already
  signed in as another account; it says so, and you sign in where the Silicon runs.

Resume waiting at any time with the request id:

```sh
accounts silicon request status 01a11433-097f-71b5-9ab2-9fbf26649772 --wait
```

**Check later.** Without `--wait` the command returns at once and saves the request id and its
polling token (`sarq_…`) in `{home}/.accounts/requests/<request-id>.json` (mode 0600):

```sh
accounts silicon create --id si:ledger --custodian c:saket --webhook https://ledger.example/hooks/accounts
```

```text
Created si:ledger (nln). It can sign in once c:saket accepts being its custodian.
Custodian request 01a11435-b2e0-75eb-98ff-d43d2c839070 expires 2026-10-21T02:33:45Z (in 13d).

STK (shown once, store it now): stk-86e514c87033
Webhook signing secret (shown once): whsec_HLnUMrdMF95fDbwiEpfsCTpHdpRlMx3jyzOMlm4tf0I

The request token is saved in /home/scout/.accounts/requests/01a11435-b2e0-75eb-98ff-d43d2c839070.json.
```

```sh
accounts silicon request status 01a11435-b2e0-75eb-98ff-d43d2c839070 --json
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
    "uuid": "nln"
  },
  "status": "pending"
}
```

`request status` reads the token from the saved file. From another home or machine, pass it with
`--token sarq_…`.

**Be told (`--webhook`).** Prefer this for a Silicon that runs for days: polling for two weeks is
wasteful, and a webhook arrives within seconds of the decision. See
[Get notified with a webhook](#get-notified-with-a-webhook).

### 3. Act on the answer

| answer | request `status` | what happened | `--wait` ends with |
|---|---|---|---|
| accepted | `accepted` | the account is `active`; you can sign in | exit `0`, signed in |
| declined | `declined` | the account was released: deleted, and its si:id is free again at once | exit `1`, `custodian_declined` |
| no answer within 14 days | `expired` | released, like a decline | exit `1`, `custodian_request_expired` |
| the named Carbon deleted their account first | `cancelled` | released, like a decline | exit `1`, `custodian_request_cancelled` |

A released account never became active, so it is gone for good, and its uuid is never reused. To
try again, create the account again (the si:id is free immediately), naming a Carbon who expects
the request.

Signing in to a released account says what happened instead of a generic failure:

```json
{"error":{"code":"custodian_declined","hint":"Create the account again with POST /v1/silicons (`accounts silicon create`), naming a Carbon who will accept.","message":"si:ledger can't sign in: the Carbon it named as custodian declined on 2026-10-07T02:33:31.772Z, so the account was never activated and the id was released."}}
```

The same holds for `custodian_expired` (no answer within 14 days) and for a request whose Carbon
deleted their account (`custodian_declined`, saying so in the message).

### Over HTTP

The same three steps without the CLI. Create the account (no authentication; send an
`Idempotency-Key` so a retry can't create a second request):

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/silicons \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-si-ledger-1' \
  -d '{"id":"si:ledger","display_name":"Ledger","custodian":"saket@example.com",
       "timezone":"Asia/Kolkata","webhook_url":"https://ledger.example/hooks/accounts"}'
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
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E",
    "status": "pending_custodian",
    "stk_rotated_at": "2026-10-07T02:32:47.969Z",
    "timezone": "Asia/Kolkata",
    "updated_at": "2026-10-07T02:32:47.969Z",
    "uuid": "K1E",
    "version": 1,
    "webhook_url": "https://ledger.example/hooks/accounts"
  },
  "stk": "stk-08708e31e274",
  "webhook_secret": "whsec_qJSJ8t7NKvzI528yBKXce_HkzO71Y31sL5mULCu5f0I"
}
```

Body fields: `id` and `display_name` (1 to 100 characters) and `custodian` (a `c:id` or an email)
are required; `timezone`, `pfp_url` (https), `stk` and `webhook_url` are optional. Unknown fields
are refused. `stk` and `webhook_secret` are `null` when you chose the STK or gave no webhook. A
custodian named by email is shown masked (`s***@example.com`); one named by `c:id` is shown as
the `c:id`.

Poll the request with its token:

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
    "uuid": "K1E",
    "id": "si:ledger",
    "status": "pending_custodian"
  }
}
```

`status` is `pending`, `accepted`, `declined`, `expired` or `cancelled`. After a decline or expiry
`silicon.id` is `null` and `silicon.status` is `deleted`: the account was released. Without the
token the call answers `401 request_token_required`; with a wrong token, `404
custodian_request_not_found`. Poll no faster than every 5 seconds and back off to a minute, as the
CLI does.

Once the status is `accepted`, sign in with `POST /v1/silicons/login`; see
[Sign a Silicon into an app](silicon-sign-in-to-apps.md#1-sign-in).

### In Rust

With the [`silicon-accounts-client`](../reference/rust-client.md) package, which the CLI is built on:

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

`wait_for_custodian_decision` retries network errors, 5xx answers and rate limits by itself, and
returns `Error::TimedOut` when its timeout passes (the request stays open).

## Have a Carbon create it

A Carbon who is signed in creates the Silicon and becomes its custodian. The account is active at
once:

```sh
accounts silicon create --id si:mapper --display-name Mapper --timezone UTC
```

```text
Created si:mapper (BYP) with you, c:saket, as its custodian. It can sign in right away.

STK (shown once, store it now): stk-c743aeed4346
```

The Carbon then hands the STK to the Silicon over a private channel. Over HTTP this is
`POST /v1/me/silicons` with the Carbon's access token; [Be a Silicon's custodian](custodians.md)
has the details, together with everything else a custodian does.

## The STK

The STK is the Silicon's password. Together with the si:id it signs the Silicon in.

| | format | how |
|---|---|---|
| generated (default) | `stk-` + 12 lowercase hex characters, e.g. `stk-59e5f08f3bbe` | returned once by the create or rotate call |
| chosen | `stk-` + 8 to 32 hex characters | `--stk-stdin`, or `"stk"` in the HTTP body |

- **Shown once.** Only an Argon2id hash is stored. A generated STK appears in the create (or
  rotate) response and never again; a chosen STK is never echoed back.
- **Lost STK?** Nobody can recover it. Your custodian replaces it with
  `accounts silicon rotate-stk si:scout`, which prints a new one.
- **Rotation ends everything.** A rotation stops the old STK at once and signs the Silicon out
  everywhere, including the tokens apps hold. Sign in again with the new STK. See
  [Rotate the STK](custodians.md#rotate-the-stk).
- **Input is forgiving.** The service lowercases an STK and accepts the bare hex without `stk-`
  (`08b7FF3E…` becomes `stk-08b7ff3e…`). Store and send the canonical `stk-…` form anyway.
- **Keep it out of process lists.** Pass it on stdin (`--stk-stdin`) or in `ACCOUNTS_STK`, never as
  `--stk <value>`: arguments are visible to every process on the machine and end up in shell
  history. The CLI warns when you use `--stk`.

To choose your own (32 hex characters here):

```sh
openssl rand -hex 16 | accounts silicon create --id si:scout --custodian c:saket --stk-stdin
```

## Get notified with a webhook

A webhook tells a Silicon about its own account. Set it at creation (`--webhook` or
`webhook_url`), or later as the Silicon:

```sh
accounts webhook set https://scout.example/hooks/accounts
```

```text
Webhook of si:scout set to https://scout.example/hooks/accounts.
Signing secret (shown once, store it now): whsec_VtcXQvX85bClvfp5_3WPNR0BML_AwWmNkncNKqqmqww
Verify every delivery's X-Accounts-Signature with it (`accounts docs webhooks`).
```

`accounts webhook test` queues a `ping`, and `accounts webhook remove` stops the notifications.
Setting the URL again generates a new secret. Your custodian can set or remove the same webhook
with `accounts silicon webhook set si:scout https://scout.example/hooks/accounts` and
`accounts silicon webhook remove si:scout`.

Every delivery is a signed `POST` with JSON. These are the events, with real payloads below:

| event | when | `data` |
|---|---|---|
| `silicon.created` | the account was created (by you or a Carbon) | `uuid`, `id`, `status`, `silicon` (your account), `request` (`null` when a Carbon created it) |
| `silicon.custodian.accepted` | your custodian accepted; you can sign in | `uuid`, `id`, `request_id`, `custodian`, `silicon` |
| `silicon.custodian.declined` | the Carbon declined, or deleted their account first; the account was released | `uuid`, `id`, `request_id`, `custodian`, `decided_at`, `reason` (`declined` or `custodian_account_deleted`), `released: true` |
| `silicon.custodian.expired` | nobody accepted within 14 days; the account was released | `uuid`, `id`, `request_id`, `custodian`, `expired_at`, `released: true` |
| `silicon.updated` | your display name, timezone or photo changed | `uuid`, `id`, `changed`, `silicon` |
| `silicon.id_changed` | your si:id changed | `uuid`, `old_id`, `new_id` |
| `silicon.stk_rotated` | your custodian rotated your STK; your sessions are gone | `uuid`, `id`, `rotated_at`, `rotated_by` |
| `silicon.custodian.changed` | a transfer moved you to another custodian | `uuid`, `id`, `from`, `to` |
| `ping` | a test from `accounts webhook test` | `{}` |

The envelope, here for an expired request:

```json
{
  "app_id": null,
  "data": {
    "custodian": "c:shubham",
    "expired_at": "2026-10-07T02:35:04.937Z",
    "id": "si:courier",
    "released": true,
    "request_id": "01a11436-72f0-7296-a867-39e04d9a53c0",
    "uuid": "ZE6"
  },
  "event_id": "01a11437-0385-74ac-bda4-e23549dd0e06",
  "occurred_at": "2026-10-07T02:35:12.133Z",
  "silicon": "ZE6",
  "type": "silicon.custodian.expired"
}
```

`silicon` is your uuid and `app_id` is always `null` on a Silicon webhook. The headers are
`X-Accounts-Event-Id`, `X-Accounts-Event-Type`, `X-Accounts-Delivery-Id`, `X-Accounts-Timestamp`
and `X-Accounts-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>`, sent with
`User-Agent: SiliconAccounts-Webhooks/1`.

A receiver in TypeScript (Node 22 or later) that verifies the signature, refuses stale
timestamps and drops duplicates:

```ts
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.SILICON_WEBHOOK_SECRET!; // whsec_…, the whole string is the key
const seen = new Set<string>(); // use durable storage in production

function verify(timestamp: string | undefined, signature: string | undefined, raw: Buffer): boolean {
  if (!timestamp || !signature) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300)) return false; // 5 minutes
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.`).update(raw).digest();
  // The header is a comma-separated list of v1=<hex> entries; accept any that matches.
  return signature.split(',').some((entry) => {
    const given = Buffer.from(entry.trim().replace(/^v1=/, ''), 'hex');
    return entry.trim().startsWith('v1=') && given.length === expected.length && timingSafeEqual(given, expected);
  });
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks); // verify the raw bytes, before parsing
    const ok = verify(req.headers['x-accounts-timestamp'] as string, req.headers['x-accounts-signature'] as string, raw);
    if (!ok) return void res.writeHead(401).end();
    res.writeHead(204).end(); // answer within 10 seconds, then do the work
    const event = JSON.parse(raw.toString('utf8'));
    if (seen.has(event.event_id)) return; // retries and replays reuse the event id
    seen.add(event.event_id);
    if (event.type === 'silicon.stk_rotated') {
      // your STK changed: stop, and get the new one from your custodian
    }
  });
}).listen(8080);
```

Things that matter when you rely on it:

- **`silicon.created` usually arrives before you have stored the secret**: it is sent the moment
  the account exists, often before the create response reaches you. Answer it with a non-2xx
  status; it is retried 10 seconds later, then after 30 s, 1 min, 5 min, 15 min, 30 min and hourly,
  for up to 72 hours, with the same `event_id`.
- **Answer with any 2xx within 10 seconds**, then do the work. Anything else is a failed attempt.
- **Deduplicate on `event_id`.** The same event can arrive more than once.
- **The URL must be https** and reach a public server; local and private addresses are refused.
- **Test pings are limited** to 10 per hour per Silicon, and a new ping replaces earlier ones that
  are still being retried.
- **A delivery that still fails 72 hours after the event is marked failed, and you can replay
  it.** See what failed with `accounts webhook deliveries --status failed`
  (`GET /v1/me/webhook/deliveries?status=failed`), fix your endpoint, then send it again with
  `accounts webhook replay --failed` (`POST /v1/me/webhook/replay` `{"status": "failed"}`): same
  `event_id`, your current URL and secret, a fresh 72 hours. Test pings are never replayed (send a
  new one). Your custodian can do the same for you
  ([A Silicon's deliveries and replays](webhooks.md#a-silicons-deliveries-and-replays)).

Signature verification in Rust, replays and every delivery rule are in
[Receive webhooks](webhooks.md) and [How webhooks work](../learn/webhooks.md).

## Retry safely

Self-creation is not safe to repeat blindly: a second attempt after a lost response fails with
`id_taken`, and the first response held your only copy of the STK. Send an idempotency key and
reuse it on every retry of the same request:

```sh
accounts silicon create --id si:scout --custodian c:saket --idempotency-key create-si-scout-1
```

Within 10 minutes the same key and the same body return the original response, with the same STK,
request token and webhook secret, plus the header `Idempotent-Replayed: true`. The window is 10
minutes rather than the usual 24 hours because the stored copy holds those secrets (it is kept
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

A full list is in [Errors](../reference/errors.md).

Limits that apply here: 10 successful self-creations per hour per network, 60 attempts per hour
per network (failed ones included), at most 20 self-created Silicons waiting for the same custodian
(counted per `c:id` and per email address), and one pending custodian request per Silicon.
[Limits](../reference/limits.md) lists them all.

## Next

- [Sign a Silicon into an app](silicon-sign-in-to-apps.md): sign in with the si:id and STK, and get
  a short-lived token for an app.
- [Be a Silicon's custodian](custodians.md): what the Carbon on the other side does.
- [Silicons and custodians](../learn/silicons-and-custodians.md): why it works this way.
