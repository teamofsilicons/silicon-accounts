---
title: App endpoints
description: Set up your app's sign-in and see its history, look after its user base, import the users you already have, and manage webhooks, event subscriptions and account verification requests.
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

Create your app in Silicon Apps first. Then use these endpoints to set up its sign-in, look after its users, bring in the users you already have and hear about changes through webhooks.

Most `/v1/apps/{app_id}/…` routes take **app or author** authentication: either the app's own credentials (`-u app_id:app_secret`) or the session of one of its authors, meaning its owner or a co-author who accepted an invite in Silicon Apps. Three routes work differently: `/public`, `/account-verification-request` and [verification history](proofs.md#get-v1appsapp_idproofsproof_idhistory) at `/proofs/{proof_id}/history`. Their sections say what access they need.

When the caller is wrong, we say how. Credentials for a different app get `403 app_mismatch`, an account that isn't one of the app's authors gets `403 not_app_owner`, and an unknown app gets `404 unknown_app`. A disabled app's own credentials get `403 app_disabled`, but its authors can still manage it.

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
  "owner": { "uuid": "6667d4b4-7c57-45de-b2c3-94185db3e175", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "…", "status": "active" },
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
counts live members (active or imported, and not deleted). `imported_unclaimed` counts imported
Carbons who haven't finished setting up their account yet.

## Manual account verification requests

If you want your app's sign-in to run on your own domain, open the app's **Sign-in** setup on [Silicon Developers](https://developers.teamofsilicons.com) and click **Request account verification**. A small form asks why you need it. Sending it starts a manual review of whether your account can run app authorization on its own domain. A reply can take up to 48 hours.

Sending the form doesn't verify your account, approve a domain or set up hosting on your domain. The Team (the people who run Silicon Accounts and Silicon Apps) does the review, and any domain setup, by hand.

### `GET /v1/apps/{app_id}/account-verification-request`

**A signed-in account that currently manages the app**: an Accounts session, or an access token issued to `silicon-accounts` or to the developer platform (`developer`). The app's Basic credentials can't submit or read the account's request. We check current ownership or accepted authorship on every request.

Returns **200** with your latest request, or `null` if you have none:

```json
{"request": null, "response_time_hours": 48}
```

The request belongs to your account, not to each app separately, so a request you sent from another app you manage can show up here. Other managers of the app don't see your reason or your request. Responses are `Cache-Control: no-store`.

### `POST /v1/apps/{app_id}/account-verification-request`

The same signed-in manager authentication. The body is `{"reason":"Why I need account verification"}`. We trim the reason; it must be 1 to 5,000 characters with no NUL, and we treat it as plain text. Unknown fields are refused, so a caller can't choose the email recipients or the approval state. An optional `Idempotency-Key` replays the same submission, with its original status; reusing the key with a different body is a conflict.

A new request returns **201**:

```json
{
  "request": {
    "request_id": "01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a79",
    "account_uuid": "6667d4b4-7c57-45de-b2c3-94185db3e175",
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

There is at most **one pending request per immutable account**, across all of its apps. Sending again with a new or missing idempotency key while one is pending returns **200** with `created: false` and the original request: the reason isn't replaced and no more notifications go out. This holds for concurrent submissions too. `response_expected_by` is when to expect a reply, not a deadline for automatic approval and not an expiry for the request.

We save the request and two separate email notifications in one transaction. They always go to `lords@teamofsilicons.com` and `saket@teamofsilicons.com`. Each email has the request ID, the reason, the requesting account, its verified primary email when it has one, and the app it was sent from. The emails go out through our retrying outbox, so **201 means the request and its notifications were saved, not that either email has reached its recipient**. There is no public approve or reject endpoint and no automatic domain change. As the Team handles the request, its status may later become `approved` or `rejected`, with `reviewed_at` set.

Validation failures are **422** `validation_failed`, missing or unsuitable sign-in is **401**, and a caller who doesn't currently manage the app gets **403** `not_app_owner`. Losing management access also stops you replaying an earlier submission through that app.

## `GET /v1/apps/{app_id}/public`

Everything a sign-in page needs to know about the app. It's public and sends
`Access-Control-Allow-Origin: *`, on errors too, so an embed can read why it failed. It's
`Cache-Control: no-cache`, so branding changes show at once.

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

`methods` lists the enabled methods in order. Managed Google and Apple are left out when this
deployment has no credentials for them. `allowed_origins` are the origins that may frame the
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

The app with its sign-in setup, webhook and statistics (the example is at the top of this page).
We never return secrets: `google.client_secret_set` and `apple.private_key_set` tell you whether
one is stored.

## `PATCH /v1/apps/{app_id}/signin-config`

Changes the sign-in setup. **Idempotent.** Send only what you want to change: objects merge,
arrays and plain values replace, and `null` resets a field to its default. Unknown keys are
refused. Add `"expected_version": n` (from `config_version`) and we fail with 409
`config_version_conflict` instead of overwriting a change someone else made in between. The body
can be up to 512 KB, enough for two inline logos of up to 128 KB each. Answers **200** with the
same body as `GET /v1/apps/{app_id}`.

```sh
curl -s -X PATCH "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: cfg-2026-10-07-1' \
  -d '{"expected_version":1,"optional_fields":["email","dob"],"copy":{"subtitle":"Reminders that respect your timezone."}}'
```

Your own Google or Apple secrets go in the same patch. We store them encrypted, outside the
document, and never return them: `{"google": {"client_secret": "…"}}`, `{"apple": {"private_key": "-----BEGIN
PRIVATE KEY-----\n…"}}` (a PKCS#8 P-256 key; `null` removes it). The read-only masks
`client_secret_set` and `private_key_set` are accepted and ignored, so you can PATCH back exactly
what you GET. A patch that changes nothing makes no new version, and every change adds a history
entry.

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
| `flow` | `null` | the app's pages: `{steps: [{id, fields, title, subtitle, continue_label, layout}], review}`; 1 to 8 steps, every requested detail on exactly one step; `null` is one page with every detail. See [Flows](../../start/sign-in-config.md#flows). Without `flow` in a patch, a detail no longer asked leaves its step (an emptied step is dropped) and a new one joins the last step |
| `allowed_email_domains` | `[]` | at most 100 domains; empty = any |
| `allow_signup` | `true` | `false` = only existing (and imported) accounts may sign in |
| `remember_browser` | `true` | offer "Continue as …" for the browser's signed-in Carbon |
| `device_flow` | `false` | let your own command-line tool sign Carbons in with a code they approve on the account site (the device authorization grant, with `client_id` alone): [Sign people into your CLI](../../start/add-sign-in.md#sign-people-into-your-cli) |
| `public_client` | `false` | treat your desktop and command-line tools as public clients: they redeem authorization codes (PKCE S256 required), exchange a Silicon's short-lived tokens (recorded as sign-in method `slt_public_client`) and refresh with `client_id` alone |
| `branding` | the Silicon Accounts look | see [Branding](../../start/branding.md): `theme`, `logo_url`, `logo_dark_url`, `logo_height` (16 to 96), `show_app_name`, `font_family`, `heading_font_family`, `corner_style`, `radius` (0 to 40), `button_style`, `layout`, `background_style`, `background_image_url`, `density`, `light` and `dark` palettes (`#RRGGBB`; button text and page text need 4.5:1 contrast) |
| `copy` | nulls | `title` (≤ 80 characters), `subtitle` (≤ 200), `signup_title` (≤ 80), `signup_subtitle` (≤ 200), `opening_title` (≤ 80, only the `{provider}` and `{app}` placeholders), `terms_url`, `privacy_url`, `support_email` |

The page footer always says "Powered by Silicon Accounts", and no setting removes it. Errors:
422 `validation_failed` with every problem keyed by its path, 409 `config_version_conflict`
(with `details.current_version`) and 413 `payload_too_large`.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid fields: branding.light.primary: 'blue' must be a #RRGGBB colour; branding.radius: is 99 but must be between 0 and 40 (pixels); redirect_uris[0]: 'http://example.com/cb' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development.",
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

Every option is explained in the guide, [Sign-in configuration](../../start/sign-in-config.md).

## `GET /v1/apps/{app_id}/signin-config/history`

Every version of the setup, newest first, paginated. `actor` is `app`, `system` or the uuid of
the author who made the change (then `actor_account` names them). Secrets show as
`"[redacted]"` with `"secret": true`.

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

Every account that signed into the app or was imported. You can filter with:

- `q`: matches the uuid exactly, the id, display name, `external_id`, the emails and phones you
  imported, and the primary email or phone only where you were granted that scope;
- `status`: `active`, `imported`, `access_removed` or `deleted`;
- `kind`: `carbon` or `silicon`;
- `source`: `signin`, `slt` or `import`;
- `limit` and `cursor`.

```json
{
  "items": [
    {
      "membership_id": "briefcase:4143123f-b494-481c-adbf-c14b14cfccc0",
      "uuid": "4143123f-b494-481c-adbf-c14b14cfccc0",
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

The contact fields follow what your app may see. For an `active` member you get the primary
email and phone (Carbons only), and dob and timezone within the granted scopes. For an
`imported` member you get the values from your import. For `access_removed` you get nothing. A
deleted account stays in the list as history, with `status: "deleted"`,
`display_name: "Deleted account"`, the default photo, `id: null` and no contact details. A
Silicon's entry has no `custodian`: read it from the token response, `/v1/userinfo` or
`GET /v1/accounts/{uuid}`. Errors: 400 `invalid_query` (an unknown `status`, `kind` or `source`).

### `GET /v1/apps/{app_id}/users/{uuid}`

One member, plus its `history`: the last 20 sign-ins at this app (`at`, `method`, `outcome`, and
no IP addresses).

```json
{
  "uuid": "4143123f-b494-481c-adbf-c14b14cfccc0",
  "membership_id": "briefcase:4143123f-b494-481c-adbf-c14b14cfccc0",
  "status": "active",
  "…": "…",
  "history": [
    { "at": "2026-10-07T02:33:16.195Z", "method": "session", "outcome": "success" },
    { "at": "2026-10-07T02:32:55.947Z", "method": "email", "outcome": "new_account" }
  ]
}
```

404 `user_not_found`. Use the canonical lowercase UUIDv4 returned by Accounts.

## Imports

Bring in the users your app already has. Follow [Import existing users](../../start/import-users.md)
for the steps; [How imports work](../../learn/imports.md) explains the rules behind every row
outcome.

### `POST /v1/apps/{app_id}/imports`

**Idempotent.** Send either CSV (`Content-Type: text/csv` or `application/csv`) with the options
as query parameters, or JSON (`application/json`) as `{"rows": [ {…}, … ], "options": {…}}`.

- Columns (case-insensitive): `external_id`, `email`, `emails` (a list, or `;`-separated),
  `phone`, `phones`, `display_name` (alias `name`), `username` (the handle they'd like),
  `dob`, `timezone`, `pfp_url`, `email_verified` (informational). Nothing else: your app's user
  base has only the columns Silicon Accounts gives it.
- Options: `default_country` (the ISO code for local phone numbers), `ignore_unknown_columns`,
  `dry_run` (decide everything, write nothing) and `update_existing`. Unknown options are refused.
- Limits: at most 100,000 rows and 50 MB per import, 60 imports per app per hour, and 2,000,000
  rows per app per 24 hours.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/apps/$APP_ID/imports?default_country=US" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: text/csv' -H 'Idempotency-Key: import-users-2026-10-07' --data-binary @users.csv
```

Answers **202** `{"job": ImportJob}`, and the rows are processed in the background:

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

`status` goes `queued` → `running` → `completed` or `failed`. These are refused before a job is
made:

- 400 `invalid_content_type`, `invalid_query`, `invalid_json`;
- 413 `payload_too_large`;
- 422 `unknown_columns` (`details.unknown_columns`, `details.allowed_columns`),
  `duplicate_columns`, `no_identifier_columns`, `empty_import`, `too_many_rows`, `invalid_csv`,
  `too_many_columns` (over 200), `value_too_large` (a cell over 8 KB), `too_many_items` (a list
  over 50 items), `validation_failed`;
- 429 `rate_limited`;
- 503 `imports_busy`: the server is already parsing two imports and none freed up within 30
  seconds (`Retry-After: 15`).

### `GET /v1/apps/{app_id}/imports` and `GET /v1/apps/{app_id}/imports/{job_id}`

The jobs, newest first (paginated), or one job as `{"job": ImportJob}`. 404 `import_not_found`.

### `GET /v1/apps/{app_id}/imports/{job_id}/rows`

Every row's outcome, in file order. You can filter with `outcome` (`pending`, `created`,
`matched`, `updated`, `skipped`, `error`), `level` (rows with a message of that level: `error`,
`warning`, `info`), `code` (rows with that message code, like `missing_identifier`), `limit` and
`cursor`.

```json
{
  "items": [
    {
      "row_number": 1,
      "outcome": "created",
      "account_uuid": "93524e0d-db12-458e-aa7a-07d08c9906d5",
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
(`account_uuid` and `id` are null), because a dry run must not become a way to map addresses to
accounts.

## The app webhook

How events reach your app. The format, signature and event types are in
[Webhooks](webhooks.md), and the guide is [Webhooks](../../start/webhooks.md).

### `PUT /v1/apps/{app_id}/webhook`

Send `{"url", "events"?, "preserve_secret"?}` and get **200** `{"url", "secret", "events"}`
(`Cache-Control: no-store`). **Idempotent** (10 minutes). Unknown fields are refused. In
production the URL must be https and reach a public address
([the SSRF guard](../../learn/security.md#webhooks-never-reach-private-networks)).

- **The secret.** Saving the URL, the same one or another, keeps the stored signing secret:
  the answer has `"secret": null`, and your receiver keeps working. A new secret is made, and
  shown once, only when none is stored: on the first PUT, or the first after
  [`DELETE`](#delete-v1appsapp_idwebhook) (and not after
  [`generate-secret`](#post-v1appsapp_idwebhookgenerate-secret), whose secret is kept). To
  replace the secret, use [`rotate-secret`](#post-v1appsapp_idwebhookrotate-secret). A retry with
  the same key within 10 minutes returns the same answer. `preserve_secret` (true or false) is
  still accepted and changes nothing, since keeping the secret is what every PUT does; it is
  deprecated. Creating the webhook with [`POST …/subscriptions`](#post-v1appsapp_idsubscriptions)
  instead always makes a new secret.
- **The updates.** `events` takes the update names of [Event subscriptions](#event-subscriptions).
  Leave it out to keep the updates already picked (a new webhook gets every update), send `null`
  for every update, or send a list to pick those. The answer's `events` is the picks now in
  effect (null = every update), not an echo of what you sent.

```json
{ "url": "https://app.example/hooks/accounts", "secret": "whsec_8LgRbzxd9LxcEbtBTPvcSHb4asLvlAskd-SVFU20-oY", "events": null }
```

Saving it again, to another URL:

```json
{ "url": "https://app.example/hooks/accounts-v2", "secret": null, "events": null }
```

Silicon Apps' `PUT /v1/apps/{app_id}/webhook` writes this same record and keeps the secret the
same way. When you leave `events` out there, it sends the five recommended updates, which replace
the picks. So the secret is the same whichever you use (this endpoint,
`silicon-accounts app webhook set`, the developer platform's Webhooks tab, Silicon Apps' API,
`silicon-apps webhook APP set`, or the publishing step on the developer platform), and the last
save decides the URL and the updates. Moving the URL with
[`PATCH …/subscriptions/{subscription_id}`](#patch-v1appsapp_idsubscriptionssubscription_id)
keeps the secret too.

### `GET /v1/apps/{app_id}/webhook`

**200** `{"url", "secret_set", "events", "subscription_id", "status"}`: the endpoint (or null), whether
a signing secret is stored, the updates it gets (`events`, null for every update), and the webhook
subscription behind it with its status ([Event subscriptions](#event-subscriptions)).

```json
{ "url": "http://127.0.0.1:8798/briefcase", "secret_set": true, "events": ["id_change"], "subscription_id": "70a1e076-0f93-4b95-ab86-70b681893a19", "status": "active" }
```

### `DELETE /v1/apps/{app_id}/webhook`

**204.** The URL and the signing secret are removed, so the next `PUT` makes a new secret.
Pending deliveries become `failed`, and you can replay them once a URL is set again. Calling it
twice is harmless.

### `POST /v1/apps/{app_id}/webhook/rotate-secret`

**200** `{"secret": "whsec_…"}`. **Idempotent** (10 minutes). The old secret stops signing at
once, and every delivery, retry and replay is signed with the new one. 409 `webhook_not_set`
when no URL is set.

### `POST /v1/apps/{app_id}/webhook/generate-secret`

The same as `rotate-secret`, and it also works before a URL is set: **200** `{"secret": "whsec_…"}`,
**idempotent** (10 minutes), never 409 `webhook_not_set`. Use it to set up your receiver with the
secret first, then `PUT` the URL, which keeps it. Silicon Apps'
`POST /v1/apps/{app_id}/webhook/rotate` calls this endpoint and returns the secret as
`webhook_secret`.

### `POST /v1/apps/{app_id}/webhook/test`

Queues a `ping`. **Idempotent**: a retry doesn't queue a second ping. **202**
`{"event_id", "delivery_id", "type": "ping"}`. 409 `webhook_not_set`.

### `GET /v1/apps/{app_id}/webhook/deliveries`

Newest first. Filter with `status` (`pending`, `delivered`, `failed`), `limit` and `cursor`.

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
`attempt_count`, and the exact `payload` that was signed. If the account no longer has a live
membership with your app (it removed your access) or was deleted, events carrying its data show
`payload.data` cut down to `{uuid, membership_id}`, with `payload_redacted: true` and
`payload_redacted_reason`. 404 `delivery_not_found`.

### `POST /v1/apps/{app_id}/webhook/replay`

Sends deliveries again. **Idempotent.** The body is either `{"delivery_ids": ["…"]}` (1 to 100),
or `{"status": "failed", "since": "2026-10-01T00:00:00Z"}` (`since` is optional) for up to 100
failed deliveries, oldest first. A replay goes to the **current** URL, signed with the
**current** secret, with the same `event_id` and payload, and gets a fresh 72 hours of retries.

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

The skip reasons are `already_pending`, `not_found`, `membership_inactive` and
`account_deleted`. We never replay events carrying an account's data to an app that lost access
to it. With `status: "failed"`, `remaining` counts the replayable failed deliveries still waiting
(call again until it's 0), and `not_replayable` counts the failed ones that will never be sent.
Errors: 422 `validation_failed` (neither field, or more than 100 ids), 409 `webhook_not_set`.

## Event subscriptions

A subscription says where your app's updates go, which updates it wants, and whether it's
active or paused. `delivery` is `webhook` (signed POSTs to your URL) or `stream` (kept for
[`GET /v1/events/stream`](webhooks.md#event-stream)). An app has at most one of each. The webhook
subscription is your app's webhook, so `PUT /v1/apps/{app_id}/webhook` and these endpoints change
the same thing. Auth: **app or author**.

The updates are the ones you pick in Silicon Apps, and each one brings these event types:

| Update | Event types | Picked for a new subscription |
|---|---|---|
| `id_change` | `account.id_changed` | yes |
| `display_name_change` | `account.updated` with `display_name` in `changed` | yes |
| `pfp_change` | `account.updated` with `pfp_url` in `changed` | yes |
| `timezone_change` | `account.updated` with `timezone` in `changed` | no |
| `email_change` | `account.updated` with `email` in `changed` | no |
| `phone_change` | `account.updated` with `phone` in `changed` | no |
| `custodian_change` | `silicon.custodian_changed`, and `account.updated` with `custodian` in `changed` | no |
| `access_removed` | `membership.signed_out`, `membership.access_removed` | yes |
| `account_deleted` | `account.deleted` | yes |

`ping` always arrives. `updates: null` means every update, including ones we add later. Webhooks
set up before subscriptions existed have it, so they keep getting what they got before. In
`account.updated`, `changed` lists only the fields your subscription picked (and your app may
see), and when none is left the event isn't sent at all. A paused subscription records nothing
until it's active again, but deliveries already queued still go out.

The Subscription object:

```json
{
  "id": "01a11e45-c73a-7003-a0b9-38ed30a0fd80",
  "app_id": "briefcase",
  "delivery": "stream",
  "status": "active",
  "url": null,
  "secret_set": false,
  "updates": ["id_change", "display_name_change", "pfp_change", "access_removed", "account_deleted"],
  "event_types": ["account.id_changed", "account.updated", "account.deleted", "membership.signed_out", "membership.access_removed", "ping"],
  "stream_url": "https://accounts.teamofsilicons.com/v1/events/stream",
  "created_at": "2026-10-09T01:27:31.898Z",
  "updated_at": "2026-10-09T01:27:31.898Z"
}
```

### `GET /v1/apps/{app_id}/subscriptions`

**200** `{"items": [Subscription…], "next_cursor": null}`, with the webhook first.

### `POST /v1/apps/{app_id}/subscriptions`

`{"delivery": "webhook" | "stream", "url"?, "updates"?, "status"?}` → **201** Subscription.
**Idempotent** (10 minutes). `url` is required for a webhook and refused for a stream. Leave
`updates` out to get the defaults above, or send `null` for every update. `status` defaults to
`active`. Creating the webhook subscription always makes a new signing secret, even when one
made with [`generate-secret`](#post-v1appsapp_idwebhookgenerate-secret) is stored (unlike
`PUT …/webhook`, which keeps it), and returns it once, in `secret`; a retry with the same key
returns the same secret. Unknown fields are refused.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/apps/$APP_ID/subscriptions" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: stream-sub-1' \
  -d '{"delivery":"stream"}'
```

Errors: 409 `subscription_exists` (`details.subscription_id`: change that one instead), 422
`invalid_updates` (`details.allowed`), 422 `validation_failed` (`url` missing, refused, or not a
public https URL in production).

### `GET /v1/apps/{app_id}/subscriptions/{subscription_id}`

**200** Subscription. 404 `subscription_not_found`.

### `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}`

`{"updates"?, "status"?, "url"?}` (at least one) → **200** Subscription. **Idempotent** (24 hours).
`status: "paused"` pauses it and `"active"` resumes it. `url` moves a webhook to another endpoint
and keeps its signing secret (rotate it with `POST …/webhook/rotate-secret`).

```sh
curl -s -X PATCH "$ACCOUNTS_URL/v1/apps/$APP_ID/subscriptions/$SUB_ID" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -d '{"updates":["id_change"]}'
```

Errors: 404 `subscription_not_found`, 422 `invalid_updates`, 422 `validation_failed` (nothing to
change, or a `url` for a stream).

### `DELETE /v1/apps/{app_id}/subscriptions/{subscription_id}`

**204.** Deleting the webhook subscription removes the webhook URL and secret, just like
`DELETE /v1/apps/{app_id}/webhook` (pending deliveries fail, and you can replay them once a URL is
set again). Deleting the stream subscription ends its open streams within 30 seconds
(`stream.closed`, reason `subscription_deleted`). 404 `subscription_not_found`.

### `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test`

Queues a `ping` on that subscription, whether it's active or paused. **Idempotent**: a retry
doesn't queue a second ping. **202** `{"subscription_id", "event_id", "delivery_id", "type": "ping"}`.
`delivery_id` is null for a stream, where the ping arrives as a frame with that `event_id`.

```json
{ "subscription_id": "01a11e45-c73a-7003-a0b9-38ed30a0fd80", "event_id": "01a11e45-eec2-774a-83b0-138146e4f988", "delivery_id": null, "type": "ping" }
```

## `POST /v1/internal/apps/sync`

The Silicon Apps stand-in: Silicon Apps upserts the apps it owns through this endpoint. Auth:
**internal** (`Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>`), so apps and accounts can't call
it. The body is `{"apps": [SiliconAppsApp…]}` (or a bare array), at most 5 MB. Each app has
`app_id`, `name`, `description`, `logo_url`, `logo_dark_url`, `homepage_url`, `owner_uuid` /
`owner_id` / `owner_email`, `secret`, `status`, `created_at` and `signin_defaults` (a partial
sign-in config applied when the app is new).

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

Everything is checked first, then applied in one transaction. An existing app keeps its app_id,
users, sign-in setup and webhook. Errors: 403 `internal_api_disabled` (no token configured on
the server), 401 `internal_token_required` / `invalid_internal_token`, 422 `validation_failed`
(paths like `apps[0].secret`), 422 `owner_not_found`, 409 `owner_email_conflict` and 409
`owner_unavailable`.
