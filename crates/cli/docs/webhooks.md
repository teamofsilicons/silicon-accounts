# Webhooks

Silicon Accounts tells your app when something changes about an account that signed
into it, and tells a Silicon about its own account. Both kinds follow the same rules.

## Set one up

```sh
accounts app webhook set https://briefcase.example/webhooks   # app; prints whsec_… once
accounts webhook set https://scout.example/hooks              # a Silicon's own
accounts app webhook test                                     # sends a `ping`
```

A new signing secret is generated every time you set the URL; `accounts app webhook
rotate` makes a new one without changing the URL. Store it where your receiver can
read it. `set`, `rotate` and `test` send an idempotency key (random, or yours with
`--idempotency-key`): a retried request returns the same secret, or queues no second ping,
instead of doing it twice.

## Verify every delivery

Each delivery is a `POST` with JSON and these headers:

| header | meaning |
|---|---|
| `X-Accounts-Event-Id` | unique per event and receiver; retries and replays reuse it |
| `X-Accounts-Event-Type` | e.g. `account.id_changed` |
| `X-Accounts-Delivery-Id` | this delivery |
| `X-Accounts-Timestamp` | unix seconds when it was signed |
| `X-Accounts-Signature` | `v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>` |

The key is the whole secret string, `whsec_` included. Check that the timestamp is
within 5 minutes of your clock (stops replays), compute the HMAC over the raw body
bytes (before parsing JSON) and compare in constant time. In Rust:

```rust
let event = silicon_accounts_client::verify_and_parse_webhook(
    &secret, timestamp_header, signature_header, &raw_body,
    silicon_accounts_client::DEFAULT_WEBHOOK_TOLERANCE,
)?;
```

Answer with any 2xx within 10 seconds, then do the work. Dedupe on `event_id`: the
same event can arrive more than once.

## Event body

```json
{"event_id":"…","type":"account.id_changed","occurred_at":"…","app_id":"briefcase","silicon":null,
 "data":{"uuid":"a8K","membership_id":"briefcase:a8K","kind":"carbon","old_id":"c:saket","new_id":"c:saket_dev"}}
```

App events:

| type | data | what to do |
|---|---|---|
| `account.id_changed` | uuid, membership_id, kind, old_id, new_id | update the shown id; keep keying on uuid |
| `account.updated` | uuid, membership_id, changed, account | refresh the fields you store |
| `account.deleted` | uuid, membership_id | delete or anonymise the account's data |
| `membership.signed_out` | uuid, membership_id, reason | drop its sessions (tokens are already revoked) |
| `membership.access_removed` | uuid, membership_id | the account removed your access; stop using its data |
| `silicon.custodian_changed` | uuid, membership_id, from, to | a Silicon you serve has a new custodian |
| `ping` | {} | test delivery |

`account.updated` only lists fields your app is allowed to see, and only reaches apps
that can see at least one changed field. Use `account.version` to ignore stale updates.

Silicon events: `silicon.created`, `silicon.custodian.accepted`,
`silicon.custodian.declined`, `silicon.custodian.expired`, `silicon.updated`,
`silicon.id_changed`, `silicon.stk_rotated`, `silicon.custodian.changed`, `ping`.

## Retries and replay

A delivery that doesn't get a 2xx within 10 s is retried after 10 s, 30 s, 1 m, 5 m,
15 m, 30 m, then hourly, for up to 72 hours. Then it is marked `failed` and can be
replayed:

```sh
accounts app webhook deliveries --status failed
accounts app webhook delivery <delivery-id>          # attempts and the exact payload
accounts app webhook replay <delivery-id>…
accounts app webhook replay --failed --since 2026-10-01T00:00:00Z
```

A replay keeps the event id (so your dedupe works), goes to the current URL, is
signed with the current secret and gets a fresh 72 hours of retries from the replay. Deliveries about accounts that no longer have a
membership with your app are skipped: data is never replayed to an app that lost
access.

`--failed` re-queues at most 100 deliveries per call, the oldest first; the answer's
`remaining` says how many failed ones are still waiting, so call it again until it is 0.
A retried call with the same `--idempotency-key` re-queues nothing twice.

### A Silicon's own webhook

A Silicon's webhook follows the same rules: the Silicon (signed in with its STK) sees and
replays its own deliveries, and its custodian can do the same for it.

```sh
# as the Silicon
accounts webhook deliveries --status failed
accounts webhook delivery <delivery-id>              # attempts and the exact payload
accounts webhook replay --failed                     # or: accounts webhook replay <delivery-id>…
# as its custodian
accounts silicon webhook deliveries si:scout --status failed
accounts silicon webhook replay si:scout --failed --since 2026-10-01T00:00:00Z
```

Every event of a Silicon's webhook is about the Silicon itself, so nothing is withheld
from it or its custodian. Test pings are never replayed (a replay would get around the
limit of 10 pings an hour): send a new one with `accounts webhook test`. A replay with no
webhook set fails with `webhook_not_set`: set one first with `accounts webhook set`.

In Rust: `AccountSession::my_webhook_deliveries`, `my_webhook_delivery` and
`replay_my_webhook` for the Silicon; `silicon_webhook_deliveries`,
`silicon_webhook_delivery` and `replay_silicon_webhook` for its custodian.
