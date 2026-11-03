---
title: Work accounts
description: Work identities, secure linking, account selection, organization app access and durable exchange recovery.
kind: informative
order: 11
---

# Work accounts and linked identities

Organizations owns members, teams, roles and effective access rules. Accounts owns
work identities, credentials, links and enforcement. Work IDs have the form
`c:{handle}.{org_id}` or `si:{handle}.{org_id}`. The local handle is unique across
Carbons and Silicons in one org; old handles retain their ten-day reservation.
An org ID cannot change. Work account UUIDs are never reassigned.

## Account API

All routes below require an Accounts browser session or first-party bearer token.
Cookie mutations retain the normal Origin/CSRF checks.

| Method and route | Body / result |
| --- | --- |
| `GET /v1/me/linked-accounts` | `{main_uuid,accounts}`; each account includes `org`, `is_main`, `allowed`, `reason` |
| `POST /v1/me/linked-accounts/link` | `{target_access_token}`; independently verifies the other account's first-party token |
| `POST /v1/me/linked-accounts/link/start` | Returns `{link_id,authorize_url}` for an independent hosted login |
| `POST /v1/me/linked-accounts/link/complete` | `{link_id}`; requires the original source identity and a still-live initiating browser session |
| `POST /v1/me/linked-accounts/switch` | `{account_uuid}`; switches browser cookie or returns `{account,tokens}` to a bearer client |
| `POST /v1/me/personal-account` | `{id,display_name?}` plus `Idempotency-Key`; creates a linked personal Carbon and returns `{uuid}` |
| `GET /v1/me/linked-accounts/requests` | Pending organization Silicon links the caller may decide |
| `POST /v1/me/linked-accounts/requests/{id}/accept` | Personal Silicon or its current Carbon custodian approves |
| `POST /v1/me/linked-accounts/requests/{id}/decline` | The same recipient authority refuses |
| `POST /v1/me/short-lived-tokens` | `{app_id,account_uuid?}`; optional target must be a controlled linked account |

`GET /v1/me` includes `org` for work accounts and `org_custodian` for org-owned
Silicons. Personal custodian UUIDs never stand in for organization custody.
Work handles and closure are managed through Organizations, so direct own-account
handle-change and delete endpoints reject those operations.

## Hosted account selection

After proving identity, a flow with several linked accounts enters
`select_account`. Its `accounts` array includes every linked identity with its
organization and app eligibility. `POST /v1/flows/{id}/select-account` accepts
`{account_uuid}` under the existing bound-flow and browser-session rules. It checks
link control, active account and current org policy on the server. Only then do
sharing/required-detail pages run for the selected identity. A single identity
skips selection; `prompt=none` cannot silently select among several identities.
A linking flow carries `link_id` and proves the target without replacing the
initiator's browser cookie. Completion requires that original session to remain live.

## Verified invitations

The public endpoints are `GET /v1/work-invitations/{ticket}`,
`POST .../email-code`, and `POST .../verify`. The code always goes to the invite's
fixed email. Verification accepts `{challenge_id,code,display_name,dob,timezone}`
and returns a short-lived invitation proof. It creates no account yet. Existing
verified email ownership or a named Carbon requires that account's authenticated
acceptance. New emails create only a work account; linking to an independently
proved Carbon is optional. Pending invitations can be cancelled or declined;
consumed, cancelled, declined and expired proofs cannot provision a new account.

## Organizations bridge

Internal routes require the existing app authentication and the exact app ID
`silicon-organizations`. Use the official `AppClient::organization_*` methods.
The service projects `{org_id,name,logo_url,version}` and a versioned effective
per-work-account policy `{version,mode,apps,extra_apps,excluded_apps}`. Modes are
`everywhere`, `only`, `except`; exclusions win, then additions, then the org rule.
Accounts and Organizations are always permitted. `initial_policy` on creation
makes provisioning and enforcement atomic.

The bridge supports organization projection, verified actor lookup, private own
linked identities/invitation discovery, work creation, policy changes, account
rename/profile/STK/close/link-request actions, invitation registration/cancel/
decline/resend, and private email/Ting relays. Organization-owned Silicon links
require recipient or custodian approval. Relays resolve recipients inside
Accounts and return delivery counts rather than personal contact or linked UUIDs.
Removal snapshots persist until successful delivery/enqueue. Failed Ting delivery
returns a retryable failure; Organizations durably retries with a stable event key.

`GET /v1/internal/organizations/events?after=N&limit=200` returns
`{items,next_cursor}`. Items have `cursor,event_id,org_id,account_uuid,actor_id,
app_id,kind,details,occurred_at`. Only work activity appears. Actors from personal
or other-org accounts are replaced with the affected work account. Consumers
persist the cursor with event ingestion and deduplicate by `event_id`.

Credential creation, invitation tickets, private delivery and account actions
store encrypted operation receipts in the same transaction as their effect.
Use a stable `Idempotency-Key` per logical operation. The semantic request binds
actor UUID rather than a rotating actor token. A key cannot be reused for changed
input. Receipts never rerun an expired completed operation; reconcile its resource.

## Recoverable token exchange

Code and SLT exchanges accept `Idempotency-Key`. Grant consumption, token creation
and an encrypted receipt commit atomically. Retries with the same app, grant,
redirect/PKCE credentials and key recover the original token pair. A different
key remains ordinary one-use grant replay. Revoked, deleted, expired or already
refreshed sessions cannot be resurrected from a receipt. Keep the key durably
before exchange and retain it through transport/server failures. The Rust methods
are `exchange_code_with_key` and `exchange_slt_with_key`.
