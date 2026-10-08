---
title: App endpoints
description: Reference for everything an app (or its owner) manages — the public sign-in config, app details, the sign-in setup and its history, the user base, user imports, the app webhook with its deliveries and replays, manual account verification requests, and the Silicon Apps sync.
kind: informative
order: 65
related:
  - reference/api.md
  - start/sign-in-config.md
  - start/branding.md
  - start/import-users.md
  - start/webhooks.md
  - learn/imports.md
  - learn/webhooks.md
  - reference/api/webhooks.md
  - reference/errors.md
---

# App endpoints

An app manages its sign-in setup, its user base, imports and its webhook here. Apps are created in
Silicon Apps; their sign-in setup lives in Silicon Accounts. Every `/v1/apps/{app_id}/…` route
except `/public`, `/account-verification-request`, and the [verification history](proofs.md#get-v1appsapp_idproofsproof_idhistory)
route `/proofs/{proof_id}/history` takes **app or owner** auth: the app's own credentials
(`-u app_id:app_secret`), or the session of the Carbon who owns the app. Another app's
credentials get 403 `app_mismatch`; another Carbon gets 403 `not_app_owner`; an unknown app is 404
`unknown_app`; a disabled app's credentials get 403 `app_disabled` (its owner can still manage it).

```sh
curl -s "$ACCOUNTS_URL/v1/apps/$APP_ID" -u "$APP_ID:$APP_SECRET"
```

```json
{
  "app_id": "briefcase",
  "name": "Briefcase",
  "description": "File storage for Carbons and Silicons: upload, share and keep every file in one place.",
  "logo_url": "data:image/svg+xml;base64,…",
  "logo_dark_url": "data:image/svg+xml;base64,…",
  "homepage_url": "http://127.0.0.1:8593/briefcase/",
  "owner": { "uuid": "zQo", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "…", "status": "active" },
  "status": "active",
  "source": "fake",
  "created_at": "2026-09-01T09:00:00.000Z",
  "updated_at": "2026-10-07T02:31:52.122Z",
  "signin_config": {
    "methods": { "email": true, "phone": true, "google": true, "apple": true },
    "method_order": ["google", "apple", "email", "phone"],
    "google": { "mode": "managed", "client_id": null, "prompt": "select_account", "hosted_domain": null, "client_secret_set": false },
    "apple": { "mode": "managed", "services_id": null, "team_id": null, "key_id": null, "private_key_set": false },
    "redirect_uris": ["http://127.0.0.1:8593/briefcase/callback"],
    "allowed_origins": ["http://127.0.0.1:8593"],
    "required_fields": ["email"],
    "optional_fields": ["timezone"],
    "allowed_email_domains": [],
    "allow_signup": true,
    "remember_browser": true,
    "branding": { "theme": "auto", "…": "…" },
    "copy": { "title": "Sign in to Briefcase", "subtitle": "Your files, for every Carbon and Silicon.", "terms_url": "https://teamofsilicons.com/legal/terms", "privacy_url": "https://teamofsilicons.com/legal/privacy", "support_email": "support@teamofsilicons.com" }
  },
  "config_version": 1,
  "webhook": { "url": "http://127.0.0.1:8593/briefcase/webhooks", "secret_set": true },
  "stats": { "users": 2, "active_last_30d": 2, "imported_unclaimed": 0 }
}
```

`source` is `silicon_apps`, `fake` (a development stand-in) or `first_party`. `stats.users`
counts live members (active or imported, accounts not deleted); `imported_unclaimed` counts
imported Carbons who haven't finished their account yet.

## Manual account verification requests

In an app's **Sign-in** setup on [Silicon Developers](https://developers.teamofsilicons.com), **Request account verification** opens a small form asking why verification is needed. This starts a manual review of the account's eligibility to run app authorization on its own domain. A reply can take up to 48 hours. Submitting the form does not verify the account, approve a domain, or provision custom-domain hosting; the team handles review and any domain configuration manually.

### `GET /v1/apps/{app_id}/account-verification-request`

**Signed-in account that currently manages the app**: an Accounts session or an access token issued to `accounts` or the developer platform (`developer`). The app's Basic credentials cannot submit or read the account's request. Current ownership or accepted authorship is checked on every request.

Returns **200** with the calling account's latest request, or `null` if it has none:

```json
{"request": null, "response_time_hours": 48}
```

The request belongs to the account, not separately to every app. A request submitted from another managed app can therefore appear here. Another manager does not see the requester's reason or request record. Responses have `Cache-Control: no-store`.

### `POST /v1/apps/{app_id}/account-verification-request`

Same signed-in manager authentication. Body: `{"reason":"Why I need account verification"}`. The reason is trimmed, must contain 1–5,000 characters without NUL, and is treated as plain text. Unknown fields are refused; callers cannot choose email recipients or approval state. An optional `Idempotency-Key` replays the same submission, including its original status; reusing it with a different body conflicts.

A new request returns **201**:

```json
{
  "request": {
    "request_id": "01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a79",
    "account_uuid": "zQo",
    "context_app": {"app_id": "briefcase", "name": "Briefcase", "logo_url": null},
    "reason": "I need authorization on my own domain for my app.",
    "status": "pending",
    "submitted_at": "2026-10-08T12:00:00.000Z",
    "response_expected_by": "2026-10-10T12:00:00.000Z",
    "reviewed_at": null
  },
  "created": true,
  "response_time_hours": 48
}
```

There is at most **one pending request per immutable account**, across all its apps. A repeat submission with a new or omitted idempotency key while one is pending returns **200**, `created: false`, and the original request without replacing the reason or sending more notifications. The guard also applies to concurrent submissions. `response_expected_by` is a reply estimate, not an automatic approval deadline or request expiry.

The request and two independent email notifications are saved in one transaction. The fixed recipients are `lords@teamofsilicons.com` and `saket@teamofsilicons.com`. Each email contains the request ID, reason, requesting account, available verified primary email, and context app. Delivery uses the existing retrying outbox; **201 means the request and notifications were saved, not that either email has reached its recipient**. There is no public approve/reject endpoint or automatic domain change. Review status may later be `approved` or `rejected` with `reviewed_at`, as part of manual handling.

Validation failures are **422** `validation_failed`; missing or unsuitable sign-in is **401**; a caller who does not currently manage the app gets **403** `not_app_owner`. Removing management access also prevents replaying an earlier submission through that app.

## `GET /v1/apps/{app_id}/public`

What a sign-in page needs. Public, `Access-Control-Allow-Origin: *` (errors too, so an embed can
read why it failed), `Cache-Control: no-cache` (branding changes show at once).

```json
{
  "app_id": "remind",
  "name": "Remind",
  "logo_url": "data:image/svg+xml;base64,…",
  "logo_dark_url": "data:image/svg+xml;base64,…",
  "homepage_url": "http://127.0.0.1:8593/remind/",
  "methods": ["email"],
  "branding": { "theme": "auto", "font_family": "Geist", "radius": 18, "light": { "primary": "#1F5FB8", "…": "…" }, "dark": { "…": "…" }, "…": "…" },
  "copy": { "title": "Sign in to Remind", "subtitle": "Reminders on your own clock.", "terms_url": "…", "privacy_url": "…", "support_email": "…" },
  "allowed_origins": ["http://127.0.0.1:8593"]
}
```

`methods` lists the enabled methods in order (managed Google/Apple are hidden when this
deployment has no credentials for them). `allowed_origins` are the origins that may frame the
sign-in iframe (`/embed/v1/buttons`, also through the SDK's `mountFrame`); the SDK's own buttons
work on any origin. Errors: 404 `unknown_app`, 403 `app_disabled`.

## `GET /v1/me/owned-apps`

**account (Carbon)**: the apps you own, newest first, paginated.

```json
{
  "items": [
    { "app_id": "remind", "name": "Remind", "logo_url": "data:image/svg+xml;base64,…", "status": "active", "source": "fake", "users": 2, "created_at": "2026-09-01T09:20:00.000Z" }
  ],
  "next_cursor": "WzE3ODgyNTQ0MDAwMDAwMDAsInJlbWluZCJd"
}
```

## `GET /v1/apps/{app_id}`

The app, its sign-in setup, webhook and statistics (example at the top). Secrets are never
returned: `google.client_secret_set` and `apple.private_key_set` say whether one is stored.

## `PATCH /v1/apps/{app_id}/signin-config`

Change the sign-in setup. **Idempotent.** The body is a partial sign-in config: objects merge,
arrays and plain values replace, `null` resets a field to its default. Unknown keys are refused.
Add `"expected_version": n` (from `config_version`) to fail with 409 `config_version_conflict`
instead of overwriting a change someone made in between. Body limit 512 KB (two inline logos of
up to 128 KB each fit). **200** the same body as `GET /v1/apps/{app_id}`.

```sh
curl -s -X PATCH "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: cfg-2026-10-07-1' \
  -d '{"expected_version":1,"optional_fields":["email","dob"],"copy":{"subtitle":"Reminders that respect your timezone."}}'
```

Bring-your-own provider secrets ride along and are stored encrypted, never in the document and
never returned: `{"google": {"client_secret": "…"}}`, `{"apple": {"private_key": "-----BEGIN
PRIVATE KEY-----\n…"}}` (a PKCS#8 P-256 key; `null` removes it). The read-only masks
`client_secret_set` / `private_key_set` are accepted and ignored, so you can PATCH back what you
GET. No change means no new version; every change adds a history entry.

| Field | Default | Rule |
|---|---|---|
| `methods` | `{"email": true, "phone": false, "google": false, "apple": false}` | at least one enabled |
| `method_order` | `["google","apple","email","phone"]` | order of the buttons |
| `google.mode` / `apple.mode` | `managed` | `managed` (one click, our credentials) or `byo` (yours) |
| `google.client_id` | null | required with `byo` (with a `client_secret`); at most 255 characters |
| `google.prompt` | `select_account` | `select_account`, `consent`, `none` or `consent select_account` |
| `google.hosted_domain` | null | a domain: only that Google Workspace may sign in |
| `apple.services_id`, `apple.team_id`, `apple.key_id` | null | required with `byo` (with a `private_key`); team and key ids are 10 letters or digits |
| `redirect_uris` | `[]` | at most 50; https, or http on `localhost` / `127.0.0.1` / `[::1]`, or a reverse-domain native scheme |
| `allowed_origins` | `[]` | at most 50 origins that may frame the iframe (`/embed/v1/buttons`, the SDK's `mountFrame`); the SDK's buttons need none |
| `required_fields` | `[]` | any of `email`, `phone`, `dob`, `timezone`: always shared; a missing email or phone is added on the details page before the app gets the account |
| `optional_fields` | `[]` | the same values, a checkbox on the details page (unticked until the Carbon ticks it); never also required |
| `flow` | `null` | the app's pages: `{steps: [{id, fields, title, subtitle, continue_label, layout}], review}`; 1–8 steps, every requested detail on exactly one step; `null` is one page with every detail. See [Flows](../../start/sign-in-config.md#flows). Without `flow` in a patch, a detail no longer asked leaves its step (an emptied step is dropped) and a new one joins the last step |
| `allowed_email_domains` | `[]` | at most 100 domains; empty = any |
| `allow_signup` | `true` | `false` = only existing (and imported) accounts may sign in |
| `remember_browser` | `true` | offer "Continue as …" for the browser's signed-in Carbon |
| `branding` | the Silicon Accounts look | see [Branding](../../start/branding.md): `theme`, `logo_url`, `logo_dark_url`, `logo_height` (16–96), `show_app_name`, `font_family`, `heading_font_family`, `corner_style`, `radius` (0–40), `button_style`, `layout`, `background_style`, `background_image_url`, `density`, `light` and `dark` palettes (`#RRGGBB`; button text and page text need 4.5:1 contrast) |
| `copy` | nulls | `title` (≤ 80 characters), `subtitle` (≤ 200), `signup_title` (≤ 80), `signup_subtitle` (≤ 200), `opening_title` (≤ 80, only the `{provider}` and `{app}` placeholders), `terms_url`, `privacy_url`, `support_email` |

The page footer always says "Powered by Silicon Accounts"; no setting removes it. Errors: 422
`validation_failed` with every problem keyed by path, 409 `config_version_conflict`
(`details.current_version`), 413 `payload_too_large`.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid fields — branding.light.primary: 'blue' must be a #RRGGBB colour; branding.radius: is 99 but must be between 0 and 40 (pixels); redirect_uris[0]: 'http://example.com/cb' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development.",
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "details": {
      "fields": {
        "branding.light.primary": "'blue' must be a #RRGGBB colour",
        "branding.radius": "is 99 but must be between 0 and 40 (pixels)",
        "redirect_uris[0]": "'http://example.com/cb' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development"
      }
    }
  }
}
```

The guide with every option explained: [Sign-in configuration](../../start/sign-in-config.md).

## `GET /v1/apps/{app_id}/signin-config/history`

Every version of the setup, newest first, paginated. `actor` is `app`, `system`, or the owner's
uuid (then `actor_account` names them); secrets show as `"[redacted]"` with `"secret": true`.

```json
{
  "items": [
    {
      "version": 2,
      "actor": "app",
      "actor_account": null,
      "at": "2026-10-07T02:36:18.263Z",
      "changes": [
        { "path": "copy.subtitle", "before": "Reminders on your own clock.", "after": "Reminders that respect your timezone." },
        { "path": "optional_fields", "before": ["email"], "after": ["email", "dob"] }
      ]
    }
  ],
  "next_cursor": null
}
```

## The user base

### `GET /v1/apps/{app_id}/users`

Every account that signed into the app or was imported. Query: `q` (matches the uuid exactly,
the id, display name, `external_id`, the emails and phones you imported, and the primary email or
phone only where you were granted that scope), `status` (`active`, `imported`,
`access_removed`, `deleted`), `kind` (`carbon`, `silicon`), `source` (`signin`, `slt`,
`import`), `limit`, `cursor`.

```json
{
  "items": [
    {
      "membership_id": "briefcase:8HV",
      "uuid": "8HV",
      "kind": "carbon",
      "id": "c:ada",
      "display_name": "Ada King",
      "pfp_url": "https://accounts.teamofsilicons.com/v1/photos/01a11437-b512-76e4-ae95-3378b29e547e",
      "email": "ada.work@example.test",
      "timezone": "Europe/London",
      "status": "active",
      "account_status": "active",
      "source": "signin",
      "external_id": null,
      "granted_scopes": ["profile", "email", "timezone"],
      "first_signed_in_at": "2026-10-07T02:32:55.947Z",
      "last_signed_in_at": "2026-10-07T02:33:16.195Z",
      "created_at": "2026-10-07T02:32:55.947Z"
    }
  ],
  "next_cursor": null
}
```

Contact fields follow what the app may see: an `active` member's primary email/phone (Carbons
only), dob and timezone within the granted scopes; an `imported` member's values from your
import; nothing for `access_removed`. A deleted account stays listed as history with `status:
"deleted"`, `display_name: "Deleted account"`, the default photo, `id: null` and no contact
details. Errors: 400 `invalid_query` (an unknown `status`, `kind` or `source`).

### `GET /v1/apps/{app_id}/users/{uuid}`

One member, plus `history`: its last 20 sign-ins at this app (`at`, `method`, `outcome`; no IP
addresses).

```json
{
  "uuid": "8HV",
  "membership_id": "briefcase:8HV",
  "status": "active",
  "…": "…",
  "history": [
    { "at": "2026-10-07T02:33:16.195Z", "method": "session", "outcome": "success" },
    { "at": "2026-10-07T02:32:55.947Z", "method": "email", "outcome": "new_account" }
  ]
}
```

404 `user_not_found` (uuids are case-sensitive).

## Imports

Bring an app's existing users in. The guide is [Import existing users](../../start/import-users.md);
the rules behind every row outcome are in [How imports work](../../learn/imports.md).

### `POST /v1/apps/{app_id}/imports`

**Idempotent.** Either `Content-Type: text/csv` (or `application/csv`) with the options as query
parameters, or `application/json` `{"rows": [ {…}, … ], "options": {…}}`.

- Columns (case-insensitive): `external_id`, `email`, `emails` (a list, or `;`-separated),
  `phone`, `phones`, `display_name` (alias `name`), `username` (the wanted handle),
  `dob`, `timezone`, `pfp_url`, `email_verified` (informational). Nothing else: an app's user base
  has only the columns Silicon Accounts gives.
- Options: `default_country` (ISO code for local phone numbers), `ignore_unknown_columns`,
  `dry_run` (decide everything, write nothing), `update_existing`. Unknown options are refused.
- At most 100,000 rows and 50 MB per import; 60 imports per app per hour; 2,000,000 rows per app
  per 24 hours.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/apps/$APP_ID/imports?default_country=US" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: text/csv' -H 'Idempotency-Key: import-users-2026-10-07' --data-binary @users.csv
```

**202** `{"job": ImportJob}`; the rows are processed in the background:

```json
{
  "job": {
    "id": "01a11438-429b-73d2-bbc0-cbd7ddb62960",
    "app_id": "remind",
    "status": "queued",
    "format": "csv",
    "dry_run": false,
    "options": { "default_country": "US", "dry_run": false, "ignore_unknown_columns": false, "update_existing": false },
    "total_rows": 4,
    "processed_rows": 0,
    "counts": { "created": 0, "matched": 0, "updated": 0, "skipped": 0, "error": 0, "warnings": 0 },
    "created_by": "app",
    "created_at": "2026-10-07T02:36:33.819Z",
    "started_at": null,
    "finished_at": null,
    "error": null
  }
}
```

`status` goes `queued` → `running` → `completed` or `failed`. Refused before a job exists: 400
`invalid_content_type`, `invalid_query`, `invalid_json`; 413 `payload_too_large`; 422
`unknown_columns` (`details.unknown_columns`, `details.allowed_columns`), `duplicate_columns`,
`no_identifier_columns`, `empty_import`, `too_many_rows`, `invalid_csv`, `too_many_columns`
(over 200), `value_too_large` (a cell over 8 KB), `too_many_items` (a list over 50 items),
`validation_failed`; 429 `rate_limited`; 503 `imports_busy` (the server is parsing two imports
already and none freed up within 30 seconds; `Retry-After: 15`).

### `GET /v1/apps/{app_id}/imports` and `GET /v1/apps/{app_id}/imports/{job_id}`

The jobs, newest first (paginated), or one `{"job": ImportJob}`. 404 `import_not_found`.

### `GET /v1/apps/{app_id}/imports/{job_id}/rows`

Every row's outcome, in file order. Query: `outcome` (`pending`, `created`, `matched`,
`updated`, `skipped`, `error`), `level` (rows with a message of that level: `error`, `warning`,
`info`), `code` (rows with that message code, e.g. `missing_identifier`), `limit`, `cursor`.

```json
{
  "items": [
    {
      "row_number": 1,
      "outcome": "created",
      "account_uuid": "ZE6",
      "id": "c:grace",
      "messages": [],
      "input": { "external_id": "u-1", "email": "grace@example.test", "display_name": "Grace Hopper", "username": "grace", "timezone": "America/New_York" }
    },
    {
      "row_number": 4,
      "outcome": "skipped",
      "account_uuid": null,
      "id": null,
      "messages": [
        { "level": "info", "code": "duplicate_in_file", "message": "Row 4 repeats the email grace@example.test from row 1, so it was skipped; only row 1 was imported." }
      ],
      "input": { "external_id": "u-4", "email": "grace@example.test", "display_name": "Dup", "username": "", "timezone": "" }
    }
  ],
  "next_cursor": null
}
```

Every message code (`missing_identifier`, `ambiguous_match`, `id_conflict`, …) is listed in
[Import existing users](../../start/import-users.md). A dry run never names a matched account
(`account_uuid` and `id` are null), because it must not map addresses to accounts.

## The app webhook

How events reach your app; the format, signature and event types are in
[Webhooks](webhooks.md), the guide in [Webhooks](../../start/webhooks.md).

### `PUT /v1/apps/{app_id}/webhook`

`{"url": "https://app.example/hooks/accounts"}` → **200** `{"url", "secret"}`. **Idempotent**
(10 minutes): every PUT makes a new signing secret, shown once; a retry with the same key returns
the same secret instead of making another. In production the URL must be https and reach a public
address ([the SSRF guard](../../learn/security.md#webhooks-never-reach-private-networks)).

```json
{ "url": "https://app.example/hooks/accounts", "secret": "whsec_8LgRbzxd9LxcEbtBTPvcSHb4asLvlAskd-SVFU20-oY" }
```

### `DELETE /v1/apps/{app_id}/webhook`

**204.** Pending deliveries become `failed` (replayable once a URL is set again). Repeating it is
harmless.

### `POST /v1/apps/{app_id}/webhook/rotate-secret`

**200** `{"secret": "whsec_…"}`. **Idempotent** (10 minutes). The old secret stops signing at
once; deliveries, retries and replays are signed with the new one. 409 `webhook_not_set`.

### `POST /v1/apps/{app_id}/webhook/test`

Queues a `ping`. **Idempotent** (a retry queues no second ping). **202**
`{"event_id", "delivery_id", "type": "ping"}`. 409 `webhook_not_set`.

### `GET /v1/apps/{app_id}/webhook/deliveries`

Newest first. Query: `status` (`pending`, `delivered`, `failed`), `limit`, `cursor`.

```json
{
  "items": [
    {
      "id": "01a11438-935f-7491-b075-4a18742f75c7",
      "event_id": "01a11438-935f-7491-b075-4a171e84916b",
      "type": "ping",
      "status": "pending",
      "url": "https://app.example/hooks/accounts",
      "account_uuid": null,
      "attempts": 1,
      "last_status": 401,
      "last_error": "HTTP 401 Unauthorized: the endpoint must answer with a 2xx status within 10 seconds. Response body: { \"ok\": false, \"error\": { \"code\": \"signature_mismatch\", … } }",
      "last_attempt_at": "2026-10-07T02:36:55.202Z",
      "next_attempt_at": "2026-10-07T02:37:05.202Z",
      "delivered_at": null,
      "manual_replays": 0,
      "created_at": "2026-10-07T02:36:54.494Z"
    }
  ],
  "next_cursor": null
}
```

### `GET /v1/apps/{app_id}/webhook/deliveries/{delivery_id}`

One delivery with its `attempts` (each `{attempted_at, status_code, error, duration_ms}`),
`attempt_count`, and the exact `payload` that was signed. While the account has no live
membership with your app (it removed your access) or was deleted, events carrying its data show
`payload.data` cut down to `{uuid, membership_id}` with `payload_redacted: true` and
`payload_redacted_reason`. 404 `delivery_not_found`.

### `POST /v1/apps/{app_id}/webhook/replay`

Send deliveries again. **Idempotent.** Body: `{"delivery_ids": ["…"]}` (1 to 100), or
`{"status": "failed", "since": "2026-10-01T00:00:00Z"}` (`since` optional) for up to 100 failed
deliveries, oldest first. A replay goes to the **current** URL, signed with the **current**
secret, with the same `event_id` and payload, and gets a fresh 72 hours of retries.

```json
{
  "replayed": ["01a11437-b515-70c4-9a30-c3738c3780a4"],
  "skipped": [
    { "delivery_id": "01a11438-935f-7491-b075-4a18742f75c7", "event_id": "01a11438-935f-7491-b075-4a171e84916b", "type": "ping", "reason": "already_pending", "message": "This delivery is still pending; the worker is already retrying it." }
  ],
  "remaining": 0,
  "not_replayable": 0,
  "url": "https://app.example/hooks/accounts"
}
```

Skip reasons: `already_pending`, `not_found`, `membership_inactive` and `account_deleted` (events
carrying an account's data are never replayed to an app that lost access to it). With
`status: "failed"`, `remaining` counts replayable failed deliveries still waiting (call again until
0) and `not_replayable` the failed ones that will never be sent. Errors: 422 `validation_failed`
(neither field, or more than 100 ids), 409 `webhook_not_set`.

## `POST /v1/internal/apps/sync`

The Silicon Apps stand-in: Silicon Apps upserts the apps it owns. **internal**
(`Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>`); apps and accounts can't call it. Body
`{"apps": [SiliconAppsApp…]}` (or a bare array), at most 5 MB; each app: `app_id`, `name`,
`description`, `logo_url`, `logo_dark_url`, `homepage_url`, `owner_uuid` / `owner_id` /
`owner_email`, `secret`, `status`, `created_at`, `signin_defaults` (a partial sign-in config
applied when the app is new).

```json
{
  "apps": [
    {
      "app_id": "docs-demo",
      "action": "created",
      "owner": "c:ada",
      "owner_created": false,
      "config": "applied",
      "config_version": 1,
      "webhook": "none",
      "changed": [],
      "warnings": []
    }
  ]
}
```

Everything is validated first and applied in one transaction. An existing app keeps its app_id,
users, sign-in setup and webhook. Errors: 403 `internal_api_disabled` (no token configured on
the server), 401 `internal_token_required` / `invalid_internal_token`, 422 `validation_failed`
(paths like `apps[0].secret`), 422 `owner_not_found`, 409 `owner_email_conflict`, 409
`owner_unavailable`.
