---
title: Account UUID migration
description: Coordinated backfill of existing account identities and linked app data.
kind: informative
order: 20
---

# Account UUID migration

Accounts now creates random UUIDv4 identities: 128 bits (16 bytes), serialized as
36 lowercase characters with hyphens. Public `c:` / `si:` handles and private
resource identifiers retain their existing meaning. The SQL identity columns
remain text so existing SQL clients retain their binding types; their values are
standard UUIDs. This runbook is an offline data cutover, separate from applying
normal numbered schema migrations.

## Prepare one mapping

Back up Accounts, Silicon Apps, every dependent database and any local daemon
registry. Inventory external OIDC trust rules whose subject is an Accounts UUID;
update those rules to the new subject at cutover. Stop account creation before
exporting the final plan and stop APIs, workers, maintenance and import writers
before applying it. Keep application webhook receivers paused until all linked
data has moved.

Confirm that every participant belongs to this exact Accounts database and issuer.
Short IDs can repeat in separately seeded test environments. A matching short ID
or account kind alone does not establish identity across databases. Compare cached
public IDs with current Accounts records and handle history, and investigate any
missing or conflicting source before cutover. Preserve an unrelated fixture
database separately; never invent a mapping or merge identities to make a dry run
pass.

Build the new release and apply its numbered migrations with `accounts-migrate`.
Set `ACCOUNTS_DATABASE_URL` explicitly. This command has no default database URL.

```sh
accounts-migrate-uuids prepare --output account-uuid-map.csv
```

The database saves the randomly generated mapping once, including deleted
accounts. The export has exactly `old_uuid,new_uuid,kind` columns, where kind is
`carbon` or `silicon`. Re-exporting to another new file produces the same mappings.
The export uses mode 0600 on Unix and refuses to overwrite an existing file. It
contains identifiers, not access tokens. Record its SHA-256 and distribute that
exact file to every consumer. Never independently generate mappings in each app.
If legacy accounts were created after preparation, prepare again and redistribute
the complete export before applying any consumer.

## Dry-run and apply

```sh
accounts-migrate-uuids migrate --file account-uuid-map.csv
accounts-migrate-uuids migrate --file account-uuid-map.csv --apply --writers-stopped
```

Without `--apply`, the complete transaction runs and rolls back. Apply requires
the exact saved plan, matching account kinds, no missing sources, no target
collisions and no unplanned legacy accounts. The operation locks its tables,
defers the real foreign keys while rewriting them, checks them, and restores their
original flags before committing. A retry recognizes already-applied rows. The
mapping cannot be edited or deleted. The database rejects any subsequent attempt
to create a short account ID, including a rollback to an old allocator.

The transaction updates accounts, custody, contacts, provider identity bindings,
photos, app owners/authors, memberships (including generated membership IDs),
verification requests, actor/history references, key and federation ownership,
and explicit identity fields in audit metadata. Public handles, resource UUIDs,
provider subjects, credentials, uploaded bytes and external URLs remain intact.
Old IDs that collide with reserved actor markers fail preflight for provenance
review; ambiguous history is never silently reassigned.

Affected browser sessions, bearer families and user-verification proof families
are revoked. Transient authorization, device, signup, OTP and short-lived-token
flows expire. Sealed idempotency results are removed because they can contain old
authorization results. App-verification proof families without account subjects
remain valid. Users sign in again; applications obtain fresh delegated approval
where needed. Stored third-party provider credentials are retained.

Historical webhook bodies and event IDs stay exact. Events containing migrated
identities are retired from delivery, replay and live streams. Pending deliveries
are cancelled, and fresh scoped profile, sign-out, deletion or access-removal
events are queued from current state under the new identities. Restart consumers
only after their own UUID backfills and retired-subject guards are in place.

Run each consumer's dry run and apply with the same CSV, including retained test
environments and local MCPort daemon registries. Silicon Apps catalog ownership,
authors and invitations also belong to this cutover. Check any remaining legacy
Interface/Ting or external integrations before exposing the new identity system.

## Verify and recover

Verify a fresh Carbon sign-in, a Silicon sign-in and short-lived token, app
membership, custody, delegated proof approval, and a real stored artifact or
provider operation. Old bearer, refresh and browser credentials must fail. Check
that every consumer has the same source-to-target map and no old live identity
references. Historical payloads and private resource keys may intentionally retain
old strings; they are not active identity bindings.

There is no reverse alias or in-place reverse migration. Before serving new
traffic, recover a failed cutover by restoring the coordinated backups of all
participants and restarting the previous release together. Once new traffic has
written data, prefer fixing forward; restoring an earlier backup would discard
those writes. Keep the export and migration ledger with the release evidence.

## Local cutover verification, 2026-10-10

Applied this operation to the isolated local stack on PostgreSQL port 5460, with
all writers stopped and coordinated backups saved. One persisted 211-row map
(SHA-256 `750423f3117e11f5eb42025b457ff0f1bf42bd463c31b7e106d9cd10978ca4d9`)
was consumed by Accounts, Apps, Briefcase, DM, Commit, Waveform, Remind, Hook,
Extend and MCPort, including local MCPort daemon state and retained test stores.
Every consumer completed dry-run, apply and a repeat with no changes.

Accounts migrated all 211 source identities, including five deleted accounts.
Comparing a restored backup confirmed that profile and encrypted account fields,
public handles and all 285 historical event payloads were preserved. All custody
references matched the shared map. The replay reported 211 already-applied rows
and no mutations. Old sessions failed and fresh sign-ins returned the mapped
UUIDs; newly created accounts also received canonical UUIDv4 values.

Current-source Rust workspace tests and focused migration/authentication/event
regressions passed, including already-standard UUID preservation and retired-event
queue starvation. Strict production library/binary clippy passed. The web passed
26 tests, typecheck, lint, build and reviewed activity-page screenshots at desktop
and mobile sizes in both themes. All-target strict clippy remains blocked by
pre-existing `unwrap_used` violations in unrelated tests.

This is local verification only. Existing fixtures from a different, reset
Accounts namespace were preserved offline with their keys rather than being
matched by coincidentally equal short IDs. Production backups, identity provenance,
Interface/fleet/Ting and external subject-based trust rules must be verified for
the production cutover. Nothing was pushed, published or deployed.
