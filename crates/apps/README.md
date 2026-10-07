# silicon-accounts-apps (`accounts_apps`)

Everything Silicon Accounts does for apps except proofs (crate `proofs`) and the token endpoint
(crate `oauth`): the public sign-in config, the sign-in setup and branding, the app's user base,
user imports, the app webhook, and the Silicon Apps stand-in (sync endpoint + fake-app seeder).
Contract: `understanding/UNDERSTANDING.md`; design: build spec `02-api.md` (`[apps]` sections).

```rust
accounts_apps::router()                                  // Router<AppState>, merged by the server
accounts_apps::spawn_background(state)                   // the import job worker
accounts_apps::seed_fake_apps(&state, path, force)       // accounts-seed --fake-apps <path> [--force]
accounts_apps::sync::sync_apps(&state, &apps, mode)      // the shared upsert
accounts_apps::imports::run_pending_jobs(&state)         // process queued imports now (tests)
```

## Routes

`app-or-owner` = `Authorization: Basic base64(app_id:app_secret)` of that app, or the session
(cookie or first-party Bearer) of the Carbon who owns it (403 `app_mismatch` / `not_app_owner`,
404 `unknown_app`; a disabled app's credentials get 403 `app_disabled`, its owner still manages it).

| route | auth | notes |
|---|---|---|
| `GET /v1/apps/{app_id}/public` | public | `{"app_id","name","logo_url","logo_dark_url","homepage_url","methods","branding","copy","allowed_origins"}`. `Access-Control-Allow-Origin: *` (errors too), `Cache-Control: no-cache`. `methods` = enabled methods in order, managed Google/Apple hidden without managed credentials. `allowed_origins` are the origins that may frame the embed and use the SDK: the account site builds the embed page's `frame-ancestors` from them (a CSP is public anyway). |
| `GET /v1/me/owned-apps` | Carbon session | `users` = live members (active + imported, deleted accounts excluded). Paginated. |
| `GET /v1/apps/{app_id}` | app-or-owner | + `updated_at`. `signin_config` has `google.client_secret_set` / `apple.private_key_set`; `webhook {url, secret_set}`; `stats {users, active_last_30d, imported_unclaimed}` (deleted accounts are never counted). |
| `PATCH /v1/apps/{app_id}/signin-config` | app-or-owner, Idempotency-Key | see below; returns the GET body. 512 KB body limit. |
| `GET /v1/apps/{app_id}/signin-config/history` | app-or-owner | `{version, actor, actor_account, changes, at}`, newest first. |
| `GET /v1/apps/{app_id}/users` | app-or-owner | `q, status (active, imported, access_removed, deleted), kind, source, limit, cursor`; items + `account_status`. |
| `GET /v1/apps/{app_id}/users/{uuid}` | app-or-owner | + `history` (last 20 sign-ins at this app: `at, method, outcome`; no IPs). 404 `user_not_found`. |
| `POST /v1/apps/{app_id}/imports` | app-or-owner, Idempotency-Key | CSV or JSON → 202 `{"job": ImportJob}`. 50 MB / 100,000 rows; budgets below. |
| `GET /v1/apps/{app_id}/imports`, `…/imports/{job_id}` | app-or-owner | list / `{"job": ImportJob}`; 404 `import_not_found`. |
| `GET /v1/apps/{app_id}/imports/{job_id}/rows` | app-or-owner | `outcome, level, code, limit, cursor`; file order. In a dry run, matched rows have `account_uuid` and `id` null. |
| `PUT /v1/apps/{app_id}/webhook` | app-or-owner, Idempotency-Key | `{"url"}` → `{"url","secret"}`, new secret every time; `no-store`. A retry with the same key (and body) gets the same secret back instead of a new one (`Idempotent-Replayed: true`); the same key with another URL is 409 `idempotency_key_reused`. Responses carrying a secret are replayable for 10 minutes and stored sealed with the keyring (core's `idempotency::run`), never in clear. |
| `DELETE /v1/apps/{app_id}/webhook` | app-or-owner | 204; pending deliveries become `failed` (replayable). Idempotent. |
| `POST /v1/apps/{app_id}/webhook/rotate-secret` | app-or-owner, Idempotency-Key | `{"secret"}`; 409 `webhook_not_set`. |
| `POST /v1/apps/{app_id}/webhook/test` | app-or-owner, Idempotency-Key | 202 `{"event_id","delivery_id","type":"ping"}`; a retry with the same key queues no second ping. |
| `GET /v1/apps/{app_id}/webhook/deliveries[/{id}]` | app-or-owner | `status, limit, cursor`; detail adds `attempts` (list), `payload` and `payload_redacted` (+ `payload_redacted_reason`). |
| `POST /v1/apps/{app_id}/webhook/replay` | app-or-owner, Idempotency-Key | `{"delivery_ids":[…]}` or `{"status":"failed","since"?}` (max 100) → `{"replayed":[ids],"skipped":[{delivery_id,reason,message}],"remaining","not_replayable","url"}`. |
| `POST /v1/internal/apps/sync` | `Bearer ACCOUNTS_INTERNAL_TOKEN` | `{"apps":[…]}` or a bare array → `{"apps":[SyncedApp]}`. 5 MB body limit. 403 `internal_api_disabled` when the token isn't configured. |

## Sign-in setup (PATCH)

Body = partial SigninConfig (objects merge, arrays and scalars replace, `null` resets a field) +
optional `"expected_version": n` (409 `config_version_conflict` with `details.current_version`) +
optional BYO secrets `{"google":{"client_secret":"…"}}`, `{"apple":{"private_key":"-----BEGIN PRIVATE KEY-----…"}}`
(`null` removes). Secrets are validated (the Apple key must parse as a PKCS#8 P-256 key; `\n`
escapes are accepted), stored AES-GCM-encrypted in the `*_enc` columns, never in the document,
never returned. The read-only masks `client_secret_set` / `private_key_set` are accepted and
ignored, so a client can PATCH back what it GETs. Validation is core's
(`SigninConfig::apply_patch`): 422 `validation_failed` with `details.fields` keyed by path
(`branding.light.primary`, `redirect_uris[0]`; button and page text below 4.5:1 contrast — WCAG AA —
is refused with the measured ratio in the message). No change → no new
version. Each change → `version + 1`, `app_config_history` row `changes: [{path, before, after}]`
(secrets as `"[redacted]"` with `"secret": true`), audit `app.signin_config.updated`.

**Details and flows.** `required_fields` / `optional_fields` are disjoint subsets of email, phone,
dob, timezone (the developer site ticks a detail as required; it can be switched to optional).
`flow` decides the pages that ask for them:
`{"steps": [{"id": "contact", "fields": ["email","phone"], "title", "subtitle", "continue_label", "layout"}…], "review": bool}`
— 1 to 8 steps, ids `[a-z0-9-]{1,40}` unique, every requested detail on exactly one step and
nothing else, title ≤ 80 / subtitle ≤ 200 / continue_label ≤ 30 characters of plain text, layout
`card|split|minimal` or null (= `branding.layout`); errors keyed `flow.steps[1].fields[0]` etc.
`flow: null` (the default) = one page with every requested detail and no review. A PATCH without
`flow` keeps the stored flow valid: a detail no longer requested leaves its step, an emptied step
is dropped (no steps left → `null`), a newly requested detail joins the last step. A PATCH with a
`flow` object is validated as sent; while the stored flow is `null` the object merges into the
default flow (`{"flow":{"review":true}}` turns the review page on). An app with no details can't
have a flow (422 `flow.steps`). `copy` also takes `opening_title` (the page before Google/Apple,
≤ 80, placeholders `{provider}` and `{app}` only), `signup_title` (≤ 80) and `signup_subtitle`
(≤ 200) for `intent=signup`. The first-party apps `accounts` and `developer` can't be synced and
never ask for details.

## User base

Contact fields follow what the app may see: `active` → the account's primary email/phone (Carbons
only), dob, timezone within the granted scopes; `imported` → the values the app supplied in the
import; `access_removed` → none. `q` matches uuid (exact), id, display name, external_id, the
app's imported emails/phones, and the primary email/phone only where the scope is granted — search
can't probe contact details the app was never given.

An account that removed the app's access stays listed as history, and the app sees none of the
account's own data any more (the same rule as webhook deliveries: an app that lost access to an
account no longer sees its data), whatever the account changes afterwards: `display_name: "Access
removed"`, the default photo, no email, phone, dob or timezone. It keeps its uuid, membership id
and current `id` (any uuid resolves to its id through `GET /v1/accounts/{uuid}`), and the app's
own records (external_id, source, the scopes it had been granted, its sign-ins, dates). `q` finds it
by uuid, id, external_id or the app's imported values, never by name. Signing in to the app again
makes it `active` and shows everything it grants again.

A deleted account stays listed as history: `status: "deleted"` (whatever the membership said),
`display_name: "Deleted account"`, the default photo, `id: null` and no email, phone, dob or
timezone (core keeps the membership row and the account's name; neither is shown). `status=deleted`
lists them; the other status filters leave them out; `q` finds them only by uuid or external_id.
Its `external_id` stays shown even after the app imported that external id again for a new
account (the membership then keeps it in `imported_profile.released_external_id`; see Imports).

## Imports

Request (`input.rs`): `text/csv` (also `application/csv`) with options as query parameters, or
`application/json` `{"rows":[…],"options":{…}}` (query options are merged; the same option twice
with different values → 422). Options: `default_country` (ISO alpha-2), `ignore_unknown_columns`,
`dry_run`, `update_existing`; unknown options are refused (a typo'd `dry_run` must not write).
Columns (case-insensitive headers): `external_id, email, emails, phone, phones, display_name`
(alias `name`), `username, dob, timezone, pfp_url, email_verified`. The UTF-8 BOM is stripped;
quoted commas/newlines/quotes work; ragged rows are read flexibly. Refused before a job exists:
400 `invalid_content_type`, 400 `invalid_query`, 400 `invalid_json`, 413 `payload_too_large`,
422 `unknown_columns` (`details.unknown_columns`, `details.allowed_columns`), `duplicate_columns`
(also the same column twice in one JSON row), `no_identifier_columns`, `empty_import`,
`too_many_rows`, `invalid_csv`, `validation_failed`, and the structural limits below.

Parsing is linear and bounded in memory: the JSON body is streamed with serde visitors (never held
as one document), every check is a hash lookup, each row is kept as compact JSON text and inserted
as `text[]` → `jsonb`, and the parse runs on the blocking pool. Structural limits (422, with
`details.row` — 1-based; the message also says "line N" for CSV and "rows[i]" for JSON — and
`details.column`): `too_many_columns` (more than 200 in a CSV header, in one JSON row, or distinct
across a JSON body), `value_too_large` (an import-column value over 8 KB — for a JSON array, all
its text — or a column name over 200 bytes), `too_many_items` (a JSON array with more than 50
items, nested ones included). Values of ignored columns aren't limited because they are never
stored. NUL characters (which `jsonb` refuses) become U+FFFD.

Budgets (`limits.rs`, on core's `rate_limit::peek` / `hit` / weighted `take`): 60 import requests per app per hour, counted when the request gets its import
slot, before its body is read (dry runs, refused files and uploads that stall or break off count;
an app at the limit is refused before it waits for a slot; a retry under an Idempotency-Key whose
import went through is not counted and still gets its stored 202), 2,000,000 rows per app per 24
hours taken in the job's own transaction (dry runs count; a refused import costs nothing) → 429
`rate_limited` with `Retry-After` and `details.limit` / `details.limit_rows`, `remaining_rows`,
`import_rows`; at most 2 bodies read and parsed at once per process and at most 1 per app, so one
app's uploads (however many, however slow) never keep the other apps from importing (a request
waits up to 30 s for a slot before reading its body, then 503 `imports_busy` with
`Retry-After: 15`); a body must average 32 KB/s after its first 10 seconds, or the read stops with
408 `import_upload_too_slow` (`details.received_bytes`, `min_bytes_per_second`) and the slot is
free at once.

Per row (`rules.rs`, `engine.rs`), in file order, chunks of 500 rows per transaction:
trim everything; emails lowercased/validated/de-duplicated (max 10), phones to E.164 with
`default_country` (max 10); a row without a usable email or phone → `error missing_identifier`;
an email/phone seen in an earlier row → `skipped duplicate_in_file` (names the row); identifiers
of two accounts → `error ambiguous_match` (accounts are not named; only addresses that identify an
account count — a verified one, or another unfinished import's — as core's
`repo::contacts::lookup` decides, so an import never links through an address nobody proved);
one account → `matched`
(membership `imported`, an existing active membership stays active, imported_profile only filled
when new or with `update_existing`, which makes the outcome `updated` for an existing membership;
an existing member's external_id is only replaced with `update_existing` — otherwise it is kept
and the row gets `warning external_id_differs`; an empty one is filled in; the account's own data
is never touched); an account that removed the app's access → `skipped access_removed` (an import
never adds it back); a second row for the same account → `skipped duplicate_in_file`; an
external_id used by another member / earlier row → `error external_id_conflict` (an external_id
only a deleted account's membership holds is free again: the row takes it, `info
external_id_released`, and the deleted membership keeps it as history in
`imported_profile.released_external_id`, which the user base still shows as its `external_id`,
because `memberships_external_idx` keeps external ids unique per app); otherwise a new
`unclaimed` Carbon, handle history `import`, membership `imported` (source `import`, external_id,
imported_profile = the cleaned row with every email and phone).

**A new account carries only the row's primary identifier** (the first valid email, else the
first valid phone), unverified; the row's other emails and phones stay in the membership's
imported profile (`info identifiers_not_attached` lists them). Whoever proves an address on an
unclaimed account finishes it, and an address on an account signs into that account — so if a row
could put several addresses on one account, an app could bundle a stranger's email with its own,
claim the account with its own, and capture the stranger's later sign-ins (or the reverse). With
one address, only its owner can claim the account. The id suggestion comes from that address too.
Cost: a Carbon who later signs in with one of the other addresses starts a separate account.

Ids: a valid free username is used as is; taken/reserved → `warning id_conflict` ("Wanted
c:saket, assigned c:saket-2: …"); invalid → `invalid_username`; reserved word →
`reserved_username` (suggestions from username, email, display name). Warnings: `invalid_email`,
`invalid_phone`, `invalid_dob` (formats YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY and MM/DD/YYYY when
unambiguous; ambiguous → warning + default dob), `invalid_timezone` (→ UTC), `invalid_pfp_url`
(https only, and never a photo an account uploaded to Silicon Accounts, which would keep someone
else's removed photo alive → default photo), `unknown_columns`, `extra_fields`, `missing_fields`,
`display_name_truncated`, `too_many_emails/phones`, `invalid_value`, `external_id_differs`.
Info: `identifiers_not_attached`, `duplicate_in_file`, `external_id_released`.
Messages are bounded: at most 5 per kind of invalid list item and row (then one "…and N more"
summary), quoted values cut to 80 characters, no message over 2,000 characters. Display names
collapse control characters (quoted newlines) into spaces. Nothing is ever emailed or texted.
`dry_run` makes every decision (ids included) without writing, and never names a matched account
in the rows API (it writes nothing the Carbon could see, so it must not map addresses to
accounts).

Storage: `import_job_rows.input` = `{"row": {import column: value as received}, "ignored"?:
[names of ignored columns that held a value, at most 5], "ignored_count"?, "extra_cells"?: n,
"missing_cells"?: n, "header_cells"?: n, "id"?}` — values of ignored columns and cells past the
CSV header are never stored. The API shows `row` as `input` (+ `_ignored_columns`,
`_ignored_count`, `_extra_cells`) and the assigned/matched id as `id`. Worker (`worker.rs`): one
job at a time per app; a session advisory lock `import_job:<id>` on a dedicated connection marks
the processor; a job left `running` by a dead process is resumed after its last committed chunk
(each resume is recorded as audit `app.import.resumed` before it runs; after 2 resumes the job is
marked `failed` instead, so a job that keeps killing its worker can't crash-loop the server); a
uniqueness race (concurrent sign-up/import) or deadlock rolls the chunk's writes back to a
savepoint and redoes the rows one by one with fresh checks. Telemetry:
`import.started|resumed|progress|completed|failed` (ids and counts only).

## Webhook replay and lost access

One rule (`webhooks::DataAccess`) for replay and the delivery detail: a delivery whose payload
carries account data may be sent — and its payload shown — only while the account has a live
membership with the app (`active` or `imported`) **and** isn't deleted (core keeps a deleted
account's memberships as history). `ping`, `membership.access_removed`, `membership.signed_out`
and `account.deleted` carry no account data and are always replayable and shown.

Replay re-queues `failed`/`delivered` deliveries (pending ones are reported `already_pending`):
status pending, attempts 0, `manual_replays + 1`, `requeued_at` = now (the worker retries it for 72
hours from the replay), same event id and payload, `url` = the current URL (the worker signs with
the current secret). By ids: withheld ones are `skipped` with reason
`membership_inactive` or `account_deleted`. By status: the SQL picks only replayable failed
deliveries (oldest first, 100 per call), so withheld ones never block newer ones; `remaining` =
replayable failed deliveries still waiting (call again until 0), `not_replayable` = failed ones
that will never be sent. The detail of a withheld delivery shows `payload.data` cut down to
`{uuid, membership_id}` with `payload_redacted: true` and `payload_redacted_reason`.

## Silicon Apps stand-in

`SiliconAppsApp`: `app_id, name, description, logo_url, logo_dark_url, homepage_url, owner_uuid,
owner_id, owner_email, secret, status, created_at, signin_defaults` (+ testkit `webhook_url`,
`webhook_secret`; other unknown fields are ignored). Everything is validated first (422 with
`apps[i].field` paths) and applied in one transaction. New app: fixed app_id and secret,
`signin_defaults` → config version 1 (BYO secrets encrypted), webhook with the given `whsec_`
secret, source `silicon_apps` (sync) or `fake` (seed). Existing app: name/description/logos/
homepage/owner/status/secret follow the payload (credential cache invalidated on secret/status
change; a fake app synced by Silicon Apps becomes `silicon_apps`), sign-in setup and webhook kept
unless `seed_fake_apps(.., force = true)`.

Owner: `owner_uuid` decides when given (422 `owner_not_found` unless it is an active Carbon);
else `owner_id`; else the active Carbon whose *verified* email is `owner_email` — which also
covers an owner who changed their c:id (`warnings` says so). 409 `owner_email_conflict` when
`owner_id` and `owner_email` name two accounts; 409 `owner_unavailable` when `owner_id` isn't an
active Carbon. A missing owner (`owner_id` + `owner_email`) is created as an active Carbon with
`owner_email` verified. An existing app's owner never changes because of a c:id alone (a released
c:id belongs to someone else 10 days later): it takes `owner_uuid` or an `owner_email` verified on
the new owner; otherwise the owner is kept and `warnings` explains. `SyncedApp.owner` is the
owner's current c:id; `SyncedApp.warnings` lists every such decision.

## Tests

```sh
CARGO_TARGET_DIR=target/apps cargo test -p silicon-accounts-apps        # Postgres on 127.0.0.1:5444
CARGO_TARGET_DIR=target/apps cargo test -p silicon-accounts-apps --test imports_big -- --ignored --nocapture
```

`tests/imports_fixtures.rs` imports every testkit fixture (`testkit/fixtures/imports`) into a
database seeded from `testkit/fake-apps.json` and checks each row against `expected.json`.
`tests/imports_safety.rs` covers the review fixes: one address per new account, kept external
ids, dry runs that name no account, budgets, 413s, structural limits, unstored ignored values,
and the resume cap.
