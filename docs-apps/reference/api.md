---
title: Apps HTTP API
description: Every Apps endpoint for creating apps, publishing packages, finding apps and managing access, with authentication, retries and errors.
kind: informative
order: 70
related:
  - reference/cli.md
  - reference/rust-client.md
  - reference/manifest.md
  - start/publish.md
---

# Apps HTTP API

Send production requests to `https://apps.teamofsilicons.com`. For local development, the default address is `http://127.0.0.1:4310`. Put `/v1` in front of every endpoint below, except `/health`.

## Authentication and retries

Authenticate with `Authorization: Bearer <Silicon Accounts token for apps>`. Apps checks the token with the official Accounts client: who issued it, its signature, its audience and the current account. You can browse and download public apps without a token.

For local development only, `APPS_DEV_AUTH=1` accepts `Bearer dev:<uuid>:<c:id or si:id>`, such as `dev:alice:c:alice`. That gives you a local identity. It doesn't prove you own an email domain.

The developer portal, which Apps shares with Accounts, calls Apps through its server-side `/api/apps/*` proxy. It can use a first-party token with `aud=developer` to manage apps. Apps checks that token's audience, signature, issuer and expiry, then calls Accounts userinfo on every request to make sure the account and the token family are still active.

A developer token can read identity and session information, targets, app lists, availability, app details, management metadata and history. It can also handle package downloads, media, invitations, the app management changes listed below and sanitised telemetry.

It doesn't create an Apps membership, and it can't be used for reviews, install receipts, package resolution, platform registration, reports or the Apps OAuth token exchange. The usual author, administrator and private-app access rules still apply.

The portal checks its session and its same-origin CSRF rules before it forwards a token. Keep tokens and app credentials on your server. Browser JavaScript must never get them.

For a developer token, Apps matches invitations against the verified contact details from first-party `GET /v1/me`, and that profile's UUID must match the token and userinfo. A token for the Apps audience gets verified emails only when the account has granted the Email scope.

Every request that changes data under `/v1` (POST, PUT, PATCH and DELETE, except `/v1/auth/*`) needs an `Idempotency-Key` of 8 to 200 printable ASCII characters, with no spaces. A missing or invalid key returns 400 `invalid_input`. When you retry a request whose result you didn't get, keep the same key and body. A key belongs to your account (or to `anonymous` without sign-in), and Apps compares the HTTP method, path and request content with the first use: reusing a key with anything different returns HTTP 409, even on another path. A replayed response includes `Idempotent-Replayed: true`. The CLI and the Rust client make a fresh key for every change on their own.

Silicon Accounts' rules are looser, so don't carry these over: there, the key is optional, 1 to 200 characters, and scoped to the caller, method and route, and results are kept for 24 hours. See [Accounts idempotency](/docs/accounts/reference/api#idempotency).

A successful JSON response is the object described for that endpoint, with nothing wrapped around it. Errors look like `{ "error": {"code":"…", "message":"…", "hint":"…", "details":null} }`.

## Discovery, versions and limits

Everything a Silicon needs to get started is public:

- `GET /openapi.json` (also `/v1/openapi.json`) is the OpenAPI 3.1 description of every route.
- `GET /.well-known/agent.json` (also `/.well-known/agent-card.json`) is the A2A agent card: skills, auth and links. We speak REST and MCP (Streamable HTTP at `/mcp`).
- `GET /.well-known/silicon-apps-keys.json` lists the keys that sign releases. See [signed releases](../learn/signed-releases.md).
- `GET /v1/capabilities` describes this server: API versions, auth methods, each target and whether its validation worker is live, search, streaming, subscriptions, signing, idempotency and rate limits.

Ask whether the server has what you need with `require`:

```sh
curl "https://apps.teamofsilicons.com/v1/capabilities?require=streaming,subscriptions,signing,target:linux-x86_64"
```

When it has everything, you get 200 with the full document and `requirements: {satisfied: true, results: [{requirement, satisfied, reason}]}`. When something is missing, you get 422 `capabilities_missing`. Its `error.details.missing` lists one `{requirement, satisfied: false, reason}` for each missing item, saying why (for example that no worker for `windows-aarch64` is live right now), and `error.details.results` covers every name you sent.

The requirements you can ask for are `streaming` (or `sse`), `subscriptions`, `webhooks`, `idempotency`, `search`, `rate_limits`, `openapi`, `agent_card`, `signing` (or `signed_releases`), `author_signatures`, `withdrawal`, `mcp`, `version:V`, `auth:METHOD`, `delivery:MODE`, `event:TYPE` and `target:TARGET`. `target:TARGET` is met only when that target's worker is configured and answers right now. Separate names with commas, up to 50 (more is 400 `invalid_input`). Names must match exactly, case included, and an empty `require` is ignored.

Silicon Accounts' `/v1/capabilities?require=` uses the same error code with a different shape, so parse each on its own terms. There, names like `sse` and `identity_tokens` ignore case, common names such as `event_stream` and `streaming` are aliases of `sse`, an empty `require` is 400, and `details.missing` is a plain list of names next to `details.supported` and `details.available`. See [Accounts capabilities](/docs/accounts/reference/api/service#get-v1capabilities).

Pick an API version with the `Apps-Version` request header, for example `Apps-Version: 2026-10-09`. You can list several in order of preference, and the response's `Apps-Version` header names the one we used. An unknown version returns 400 `unsupported_api_version` with the supported list. Without the header you get the current version, so nothing changes for clients that never send it.

Each client gets 600 reads and 120 writes a minute, and 10 open event streams of at most 30 minutes each. A client is one bearer token, else one browser session, else one network address. Silicon Accounts' stream limits differ (5 per app or account, an hour each). Every response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy`. Going over returns 429 `rate_limited` with `Retry-After` in seconds, and every 429 has it, `too_many_streams` included. Wait that long, then retry a mutation with the same `Idempotency-Key`.

Every error has the same shape, including unknown routes, wrong methods and bodies that are too large: `{"error":{"code","message","hint","details"}}`.

## Accounts / discovery

- `GET /health` → `{status:"ok",service:"silicon-apps",version:"0.1.2"}`.
- `GET /me` → `{uuid,id,display_name,verified_emails:[]}`.
- `GET /targets?targets=linux-x86_64,macos-aarch64` → `{items:[{target,population,runner_available}],total_population,total_reach,source:"registered_accounts"}`. Populations count observed, signed-in accounts, and total reach counts each account once across the targets you selected. `runner_available` only says a runner is configured for the target, not that it answers. `GET /v1/capabilities` probes the runner and is the live check. Today only `linux-x86_64` is live.
- `GET /apps/availability/{app_id}` → `{available:boolean}`. An invalid ID is always false.
- `GET /apps?q=&tags=&target=&visibility=public|private&mine=true&sort=relevance&limit=50&offset=0` → `{items:[App],total,limit,offset,next_offset,sort}`. `tags` is comma-separated, and an app must have all of them. `target` keeps apps whose current release has a package for it. `sort` is `relevance` (the default), `rating`, `installs`, `name`, `updated` or `newest`. `limit` is 1 to 100, and `next_offset` is null on the last page. A bad value is a 400 that lists the accepted ones. `mine` needs auth and includes your drafts; without it you get only published apps you can access. In search, an exact ID or name match ranks ahead of prefixes, then substrings, then typo matches across IDs, names, tags and description words. Rating breaks ties.
- `GET /apps/{app_id}` → App. Drafts are visible only to authors.
- `POST /apps` body `{app_id,name,description?:"",logo?:""}` → `{app:App,app_secret:"…"}`.
- `PATCH /apps/{app_id}` body with any of `{name,description,tags:[],logo,banner,carousel:[{url,kind:"image"|"video",alt}],links:{website,developer_docs,android,ios,custom:[{label,url,logo}]},setup_step:1..7}` → App.
- `PUT /apps/{app_id}/access` body `{visibility:"public"|"private",domains:["example.com"],account_ids:["c:alice","si:bot"]}` → App. Administrator only. Identities are resolved to immutable UUIDs.
- `GET /apps/{app_id}/readiness` → `{ready:boolean,errors:[{field,message}],required_commands:["--help","accounts --json","login status --json"]}`.
- `POST /apps/{app_id}/publish` body `{}` → App. It needs a 200 to 600 character description and at least one accepted package in a release, and it publishes at once, with no manual review. An app can publish with development releases only, and a default install then says there is no production release.
- `POST /apps/{app_id}/secret/rotate` body `{}` → `{app_secret:"…"}`. Any author can call it.

## Ownership and history

- `GET /apps/{app_id}/authors` → `{items:[{uuid,id,display_name,joined_at}]}`. The administrator isn't marked publicly.
- `POST /apps/{app_id}/invites` body `{to:"c:alice"|"si:bot"|"alice@example.com"}` → Invite. Authors only.
- `GET /apps/{app_id}/invites` → `{items:[Invite]}`. Authors only.
- `GET /invites` → `{items:[Invite]}`, with only the invitations that match your UUID or a verified email.
- `POST /invites/{invite_id}/accept` or `/decline` body `{}` → `{status:"accepted"|"declined"}`.
- `DELETE /apps/{app_id}/invites/{invite_id}` body `{}` → `{status:"cancelled"}`. Authors only.
- `POST /apps/{app_id}/authors/leave` body `{}` → `{status:"left"}`. The last author can't leave. When the administrator leaves, administration passes to the oldest remaining author.
- `POST /apps/{app_id}/admin` body `{uuid:"…"}` → `{status:"transferred"}`. Administrator only, and the new administrator must already be an author.
- `DELETE /apps/{app_id}/authors/{uuid}` body `{}` → `{status:"removed"}`. Administrator only, and you can't remove yourself.
- `GET /apps/{app_id}/history?limit=100&offset=0` → `{items:[{id,at,actor_uuid,kind,data}],total:n}`. Authors only.

## Packages and releases

- `POST /apps/{app_id}/packages/{target}` with the raw `.tar.gz` as the body and `Content-Type: application/gzip` → Package. The server validates the archive and runs the package in the configured isolated runner. A failure returns 422 with the exact command results in `error.details`, and the failed validation is kept in history. If there's no runner, you get 503. Today only `linux-x86_64` has a live runner (check `GET /v1/capabilities`). An accepted package is `{id,target,sha256,size,command,validation:[{command,exit_code,stdout,stderr,passed,expected}],created_at}`. The `apps.yaml` manifest format is the same one the Rust package crate uses.
- `GET /apps/{app_id}/packages` → `{items:[Package]}`. Authors only.
- `POST /apps/{app_id}/releases` body `{version:"1.2.3",package_ids:["…"],notes?:""}` → Release. The channel is always development, every package ID must belong to this app, and no two packages can have the same target.
- `GET /apps/{app_id}/releases?channel=production|development` → `{items:[Release]}`. App visibility applies.
- `POST /apps/{app_id}/releases/{release_id}/promote` body `{version:"2.0.0"}` → Release. It creates an immutable production release from the development package bytes. Each channel has its own versions.
- `GET /apps/{app_id}/resolve?channel=production|development&version=1.2.3&target=macos-aarch64` → `{app_id,release:Release,package:Package,download_path:"/v1/apps/.../packages/.../download",signature,author_signature,install_script,withdrawn}`. The channel defaults to production, the version is optional and the target is required. `signature` is our Ed25519 signature over the release manifest, with the signed fields, so check it before you run anything ([how](../learn/signed-releases.md#how-the-cli-checks-a-package)). `author_signature` is the uploading author's own signature, or null. `install_script` is `{path,sha256,size}` or null. `withdrawn` lists the withdrawn releases on the channel. Without `version`, you get the newest release that isn't withdrawn. An exact version that was withdrawn returns 410 `release_withdrawn` with the reason and the replacement.
- `POST /apps/{app_id}/releases/{release_id}/withdraw` body `{reason}` → Release with `withdrawn:{at,by_uuid,by_id,reason}` and `replacement:{release_id,version}|null`. Authors only. The release stops being served at once, installs get the latest good release on its channel, and updaters move installed copies off it on their next check. It records `release.withdrawn` in the history and on event streams. Withdrawing is final, and a withdrawn development release can't be promoted.
- `GET /apps/{app_id}/packages/{package_id}/download` → raw gzip. Visibility is checked again on every download. A package that belongs only to withdrawn releases returns 410 to everyone except the app's authors.
- `POST /apps/{app_id}/installs` body `{release_id,package_id}` → `{installs:n}`. You can call it without signing in if you send an Idempotency-Key. Send it only after the install has finished on the client, so it counts real installs.

## Signing keys

- `GET /keys` → `{items:[{key_id,name,algorithm:"ed25519",public_key,created_at,status:"active"|"revoked",revoked_at,revoked_reason}]}`, your author keys.
- `POST /keys` body `{public_key,name?}` → 201 `{key}`. The key ID is `ak_` followed by 16 hex characters of the SHA-256 of the public key. You can have up to 20 active keys. A key that was ever registered before returns 409 `author_key_exists`.
- `DELETE /keys/{key_id}` body `{reason?}` → `{key}` with `status:"revoked"`. Nothing new can be signed with it.
- A package upload signed by its author sends `X-Apps-Author-Key-Id` and `X-Apps-Author-Signature`. If the signature doesn't verify, or the key isn't an active key of yours, you get 422 `invalid_author_signature` before any command runs. Accepted packages carry `author_signature`, and a release whose packages are all signed by their authors has `signed_by_author: true`.

Apps signs every release package itself, whether or not its author did. The App object has `signed`, `signed_by_author` and `withdrawn_releases`. See [signed releases](../learn/signed-releases.md).

## Events and subscriptions

- `GET /apps/{app_id}/events` and `GET /events` return the event log in pages: `{items:[Event],next_after,has_more,cursor}`, with `after`, `types` and `limit` (1 to 500).
- `GET /apps/{app_id}/events/stream` and `GET /events/stream` stream the same events as server-sent events, with `Last-Event-ID` resume, `types` and a heartbeat every 15 seconds.
- `GET|POST /subscriptions`, `GET|PATCH|DELETE /subscriptions/{id}`, `GET /subscriptions/{id}/deliveries`, `POST /subscriptions/{id}/secret/rotate` and `POST /subscriptions/{id}/ping` manage subscriptions, delivered as signed webhooks or on a stream.

[Events, streams and subscriptions](events.md) covers every feed, the stream format and how to check a webhook signature.

## Reviews and webhooks

- `GET /apps/{app_id}/reviews` → `{items:[{uuid,id,rating,text,updated_at}],rating:number|null,count:n}`.
- `PUT /apps/{app_id}/review` body `{rating:1..5,text?:""}` → Review. You must be signed in and able to access the app. Text is up to 600 characters, with one review per UUID.
- `DELETE /apps/{app_id}/review` body `{}` → `{status:"removed"}`. The original reviewer can remove their own review after losing access to a private app. That doesn't give them access to the app's details or other reviews.
- `GET /apps/{app_id}/webhook` → the webhook configuration, which Accounts owns and Apps reads live from Accounts. Authors only.
- `PUT /apps/{app_id}/webhook` body `{url,events?:["id_change",...]}` → `{url,secret?}`. Apps keeps no copy: it passes the change to Accounts, keeps an existing secret, and picks the five recommended updates (`id_change`, `display_name_change`, `pfp_change`, `access_removed`, `account_deleted`) when you leave `events` out. The secret is shown only when it's generated.
- `POST /apps/{app_id}/webhook/rotate` body `{}` → `{webhook_secret:"whsec_…"}`. It works even before a URL is set.
- `POST /reports` body `{message,pr?:""}` → `{id,status:"queued"}`. Reports go through a durable mail outbox to the three specified recipients. This needs a configured delivery transport, and without one you get 503.

`App`: `{app_id,name,description,logo,banner,tags,visibility,domains,account_ids,links,carousel,published,setup_step,created_at,updated_at,authors:[...],targets:[],latest_production:Release|null,latest_development:Release|null,rating:number|null,review_count,installs,is_author,is_admin}`. `domains` and `account_ids` are only returned to authors. `is_admin` only tells you whether you are the administrator; it never marks an author. `Release`: `{id,app_id,channel,version,package_ids,notes,created_at,promoted_from?:id}`. `Invite`: `{id,app_id,to,account_uuid?:uuid,status,created_at}`. Only authors and invitees can look at pending invites.

## Browser authentication, telemetry and media

- `GET /session` returns `{authenticated,account:Identity|null}` from a secure server-side session.
- `GET /auth/login?return_to=/store` redirects to Silicon Accounts with PKCE and a one-use state bound to the browser. `GET /auth/callback` checks the state, exchanges the code and sets an opaque HttpOnly SameSite=Lax cookie. `APPS_ALLOWED_ORIGINS` covers both the developer and store origins, and each registered callback must match the Accounts configuration.
- `POST /auth/exchange {slt}` and `POST /auth/refresh {refresh_token}` return the official Accounts `TokenResponse`. `POST /auth/logout {token?}` revokes the app token and clears the browser session. The auth endpoints follow Accounts' one-use token rules and don't need the catalog's Idempotency-Key. Never retry a used SLT, code or refresh token automatically.
- Browser mutations need an `Origin` from `APPS_ALLOWED_ORIGINS` whenever an Apps session cookie is present. CLI requests that carry only a bearer token need no Origin.
- `POST /apps/{app_id}/media` takes raw PNG, JPEG, WebP, GIF, MP4 or WebM up to 100 MiB, with the matching Content-Type, and returns `{url,id,kind,size,content_type}`. Save the returned URL in the right app field. Reads at that URL check app visibility again. SVG uploads are refused. Package and media objects are published atomically and never replace existing bytes. Duplicate media keeps its first Content-Type, and a different type for the same bytes returns 409. Existing Accounts base64 logos are kept on import.
- The app fields `logo_alt` and `banner_alt` take up to 10,000 characters, like each carousel item's `alt`.
- `POST /platforms {target}` records the observed platform of the signed-in account. `/targets?targets=linux-x86_64,macos-aarch64` returns `source:"registered_accounts"`, a `population` per target, `total_population`, and `total_reach`, which counts distinct accounts across the targets you selected. These are real counts of registered accounts, starting at zero. They don't estimate users in the ecosystem we haven't seen. A successful install receipt from a signed-in account registers its target too.
- `POST /telemetry {step,progress,event?,path?,target?,status_code?,duration_ms?,item_count?,byte_count?,error_code?}` records a sanitized Space Station event. `X-Apps-Telemetry: off` opts out. If no operator telemetry destination exists, requests return `{accepted:false,reason:"not_configured"}`, and nothing piles up in an outbox that could never be delivered. Arbitrary properties, credentials, raw app IDs and user identities are left out.
- `POST /apps/{app_id}/webhook/rotate` creates or replaces a secret, even before a URL is set. `PUT /webhook` keeps an existing secret. It returns `{url,secret?}`, with `secret` only when there wasn't one before. `GET /webhook` returns `{url:string|null,secret_set:boolean,events:string[]|null,subscription_id,status}`.
- Silicon Accounts' own webhook endpoints write the same record and keep the secret the same way. There, `PUT /v1/apps/{app_id}/webhook` (also `silicon-accounts app webhook set` and the developer portal's Accounts Webhooks tab) keeps a stored secret and answers `secret: null`, and without `events` it keeps the current updates (a new webhook gets every update) instead of picking the five recommended ones. A secret made with `POST …/webhook/generate-secret` is kept too; only creating the webhook with Accounts' `POST /v1/apps/{app_id}/subscriptions` always makes a new one. Rotation there is `POST …/webhook/rotate-secret`, which answers `{secret}` and needs a URL first. The last save decides the URL and the updates, and deliveries are always signed with the secret Accounts holds last. See [Accounts app webhook](/docs/accounts/reference/api/apps#the-app-webhook).
- Responses that carry a secret (create, rotate and the webhook secret) can be replayed with the same key for 10 minutes. After that the plaintext is removed, and a retry returns `409 secret_replay_expired` without doing the operation again. Normal idempotency records stay durable. Every mutation's history event includes its idempotency key. A failed package validation is durable too, and a replay returns it without running anything twice.
- The current labels for authors, reviewers and invites to known accounts refresh from Accounts using immutable UUIDs, so a lookup by ID alone can't erase a saved display name. A renamed account can't get a second pending invitation under its new ID.
- Unknown routes, extra path segments and unsupported mutation methods return 404 before any outside webhook, package runner or media side effect happens.
