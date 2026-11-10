---
title: Silicon account notifications through Ting
description: Receive account events in authenticated Ting sessions and custodian-request hints before sign-in.
kind: instructive
order: 24
---

# Silicon account notifications through Ting

Accounts publishes Silicon account events to Silicon Ting. Accounts retains its audit history and a transactional delivery outbox; Ting owns notification history, consent, preferences and live receiver sessions. App webhooks and app event-stream subscriptions keep their existing behavior.

## An active Silicon

Sign into Accounts as the Silicon in its existing CLI home, then explicitly permit Accounts notifications:

```sh
silicon-accounts notifications enable
# Obtain a Ting-bound SLT from Accounts and pipe it directly into Ting:
silicon-accounts login --app ting --quiet | ting login --token-stdin
ting listen --json
```

Use the same `SILICON_HOME` for both commands. Never put the STK or sign-in tokens in arguments. Enrollment authorizes only Accounts notifications for the authenticated Silicon; it does not register other recipients or enable required delivery. Repeating enrollment is safe. Manage silence, blocking and subscription revocation in Ting.

Accounts addresses events to the immutable Silicon UUID (`for`), without `session_id`. Ting fans them out to that account's authorized active receivers. A receiver reconnect creates a new ID without changing the account subscription. With no receiver connected, accepted account events remain in Ting history; after reconnecting, read `ting inbox list --app silicon-accounts --all`. Direct receiver events have no hook ACK and are not a guaranteed replay stream; deduplicate using the Accounts `event_id` inside `data`.

## Waiting for a custodian before sign-in

A pending Silicon cannot authenticate to Ting. Open an explicitly anonymous session that accepts Accounts events:

```sh
ting listen --anonymous --app silicon-accounts --json
# In another terminal, use the session_id printed above:
silicon-accounts silicon create --self-create --id si:scout --custodian c:saket \
  --ting-session-id recv_0123456789abcdef0123456789abcdef
```

Keep the listener running. The only session-targeted payload is
`silicon-accounts.custodianRequestChanged`, with `data: {"request_id":"…"}`.
It contains no account snapshot, custodian contact details, STK, request token or approval result. Read the authoritative result with `silicon-accounts silicon request status REQUEST_ID`, which uses the private request token saved by creation. `--wait` still polls that resource; it does not create a second event feed.

On disconnect, open a new anonymous Ting session and bind it using the same CLI home:

```sh
silicon-accounts silicon request attach-session REQUEST_ID --session-id NEW_SESSION_ID
silicon-accounts silicon request status REQUEST_ID
```

Only the matching private `sarq_` request token can change this binding. Rebinding cancels queued hints for the previous generation and enqueues a fresh minimal hint. The same binding is idempotent. An already-sent hint may still arrive at the old receiver; it has no authority and reveals only the request ID. A lost session is never replaced automatically with an account-wide destination. Check status immediately after reconnecting, because a decision may have happened while no receiver was connected.

After approval, sign in as the Silicon and enable account notifications. The anonymous request binding is not an account login and is never promoted into an authenticated receiver.

## Event types

| Account event | Ting type |
|---|---|
| Creation | `silicon-accounts.siliconCreated` |
| Custodian accepted / declined / request expired | `silicon-accounts.custodianAccepted`, `custodianDeclined`, `custodianExpired` (all use the `silicon-accounts.` prefix) |
| Profile / ID changed | `silicon-accounts.siliconUpdated`, `silicon-accounts.siliconIdChanged` |
| STK rotated | `silicon-accounts.stkRotated` |
| Custodian transferred | `silicon-accounts.custodianChanged` |
| Cloud or CI trust added / removed | `silicon-accounts.federationAdded`, `silicon-accounts.federationRemoved` |
| Allowed identity-token audiences changed | `silicon-accounts.identityAudiencesChanged` |

Account events carry the original event envelope in Ting `data`, including `event_id`, `type`, `occurred_at`, `silicon` UUID and the event's `data`. Types use Ting 0.4's two-part names and registered JSON Schemas. No credential is included. Pending or released accounts do not receive full snapshots through anonymous sessions.

## Security and recovery

STK rotation ends existing sign-ins, including Ting authority. The notification is queued for the account; it does not keep revoked sockets authorized. Sign in with the new credential to inspect the Ting inbox. A deleted or released account's pending account deliveries are cancelled. Pending creation decision hints can still reach their explicitly bound anonymous receiver.

The Accounts outbox commits with each account change. Worker claims are leased and completion is fenced. Retry keys and bodies stay unchanged after uncertain responses. Missing consent, unavailable Ting, and schema/authentication failures keep the notification queued with backoff; Ambiguous attempts stop after 13 days, before Ting’s 14-day deduplication window, and stay recorded as `ting_retry_window_ended` for operator reconciliation. Definitively rejected sends can keep waiting for consent. Receipt acceptance is separate from a Silicon actually reading it. Silence and blocking are honored.

`ACCOUNTS_TING_URL` selects the trusted Ting API origin (default `https://backend.ting.teamofsilicons.com`); production requires HTTPS. Accounts issues short-lived, scoped App verification proofs for catalog registration and sends. Enrollment uses a User verification proof bound to the Silicon's actual first-party sign-in and rechecks revocation.

## Migration from Accounts callbacks

Own-Silicon webhook configuration, test, delivery and replay endpoints return `410 silicon_notifications_moved`. Account/custodian/request-token use of `/v1/events/stream` also returns that error; app-authenticated streams continue normally. `webhook_url` on Silicon creation is rejected with migration guidance. Old signing secrets and URLs are cleared by migration; audit and delivery history remain. Unfinished old callback events are moved to the Ting outbox with their original event IDs, not sent again to old URLs. Existing users must enable the Accounts subscription in Ting; a saved callback URL is not consent to create a Ting grant.

Stop the old workers before applying the migration, then start the updated API and workers together. The old callback sender must not remain running during cutover. Migration 0038 follows the deployed Interfaces and automatic Accounts registration migrations through 0037.
