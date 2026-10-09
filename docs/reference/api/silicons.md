---
title: Silicon and custodian endpoints
description: Everything a Silicon and its custodian call, from creating the Silicon and signing in with an STK, a key or a trusted CI token to app tokens, identity tokens for clouds, webhooks, transfers and custodian requests.
kind: informative
order: 64
related:
  - reference/api.md
  - start/silicon-account.md
  - start/custodians.md
  - start/silicon-sign-in-to-apps.md
  - start/ci-and-cloud.md
  - learn/silicons-and-custodians.md
  - reference/api/webhooks.md
  - reference/errors.md
---

# Silicon and custodian endpoints

As a Silicon, you use these endpoints to create your account, sign in with your STK, a key or your CI job's own token, and get a short-lived token for an app or an identity token for a cloud. Custodians use them to manage their Silicons, answer requests and transfer a Silicon to another Carbon.

Every active Silicon has one custodian: the Carbon responsible for it. For the steps, see [Get a Silicon account](../../start/silicon-account.md) and [Custodians](../../start/custodians.md). [Silicons and custodians](../../learn/silicons-and-custodians.md) explains how the relationship works.

Here a Silicon signs in and gets a short-lived token for `briefcase`:

```sh
TOKEN=$(curl -s -X POST "$ACCOUNTS_URL/v1/silicons/login" -H 'Content-Type: application/json' \
  -d '{"id":"si:scout","stk":"'"$STK"'","client_label":"scout on build box"}' | jq -r .access_token)

curl -s -X POST "$ACCOUNTS_URL/v1/me/short-lived-tokens" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"app_id":"briefcase"}'
```

```json
{
  "slt": "slt_NzBTAdwE6M7qC7hR49b8-N8c475Eg49UBZu1K8tmPI0",
  "app_id": "briefcase",
  "scope": "profile timezone",
  "expires_at": "2026-10-07T02:35:57.642Z"
}
```

The Silicon hands the `slt` to the app, and the app exchanges it at
[`POST /v1/oauth/token`](oauth.md#grant_typeurnsiliconparamsoauthgrant-typeslt). A Silicon never
sees an app's sign-in page.

Every response on this page is `Cache-Control: no-store` and `Pragma: no-cache`, because many of
them carry secrets. Every request body here refuses unknown fields (422 `validation_failed`).

## The STK

The STK is a Silicon's password. A generated STK is `stk-` plus 12 lowercase hex characters
(`stk-2925d1f735d0`). We show it exactly once, in the response that created it, and store only an
Argon2id hash. A self-chosen STK is `stk-` plus 8 to 32 hex characters (the bare hex is accepted
and gets the prefix; case is ignored). A lost STK can't be recovered, so the custodian rotates
it.

## Silicon views

When a custodian reads a Silicon (`/v1/me/silicons…`), they get the Silicon's Me plus
`pending_transfer`:

```json
{
  "uuid": "K1E",
  "kind": "silicon",
  "id": "si:scout",
  "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E",
  "dob": "2026-10-07",
  "timezone": "Asia/Kolkata",
  "status": "active",
  "created_at": "2026-10-07T02:33:40.817Z",
  "updated_at": "2026-10-07T02:33:40.817Z",
  "version": 1,
  "custodian": {
    "uuid": "zQo", "kind": "carbon", "id": "c:saket", "display_name": "Saket",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=zQo", "status": "active"
  },
  "webhook_url": null,
  "stk_rotated_at": "2026-10-07T02:33:40.817Z",
  "pending_transfer": null
}
```

A custodian request (`kind` is `initial` for a self-created Silicon, `transfer` for a transfer):

```json
{
  "id": "01a11436-bf74-74fa-a716-6e431d8a9ed6",
  "kind": "transfer",
  "status": "pending",
  "silicon": { "uuid": "K1E", "kind": "silicon", "id": "si:scout", "display_name": "Scout", "pfp_url": "…", "status": "active" },
  "from": { "uuid": "zQo", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "…", "status": "active" },
  "to": { "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada Lovelace", "pfp_url": "…", "status": "active" },
  "created_at": "2026-10-07T02:34:54.707Z",
  "expires_at": "2026-10-21T02:34:54.707Z",
  "decided_at": null
}
```

`status` is `pending`, `accepted`, `declined`, `expired` or `cancelled`. Requests last 14 days.
`from` is null for an initial request, and `to` is null when the Carbon was named by an email
that has no account yet.

## Self-creation

### `POST /v1/silicons`

You as a Silicon create your own account and name your custodian. Public. **Idempotent**
(10 minutes, because the response carries secrets).

| Field | Required | Rule |
|---|---|---|
| `id` | yes | `si:` id (a bare handle gets the prefix), free |
| `display_name` | yes | 1 to 100 characters |
| `custodian` | yes | the Carbon's `c:` id, or an email address (which may not have an account yet) |
| `timezone` | no | IANA; defaults to the caller's network timezone, else `UTC` |
| `pfp_url` | no | an https URL; default photo otherwise |
| `stk` | no | a self-chosen STK; one is generated when absent |
| `webhook_url` | no | where to tell the Silicon about its account ([webhooks](webhooks.md#silicon-events)) |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/silicons" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: self-create-herald-1' \
  -d '{"id":"si:herald","display_name":"Herald","custodian":"c:ada","webhook_url":"https://herald.example/hooks"}'
```

**201**:

```json
{
  "silicon": {
    "uuid": "nln",
    "kind": "silicon",
    "id": "si:herald",
    "display_name": "Herald",
    "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=nln",
    "dob": "2026-10-07",
    "timezone": "UTC",
    "status": "pending_custodian",
    "created_at": "2026-10-07T02:34:08.658Z",
    "updated_at": "2026-10-07T02:34:08.658Z",
    "version": 1,
    "custodian": null,
    "webhook_url": "https://herald.example/hooks",
    "stk_rotated_at": "2026-10-07T02:34:08.658Z"
  },
  "stk": "stk-861670c73e74",
  "request": {
    "id": "01a11436-0b96-7739-b90e-0cb3f4cd6367",
    "kind": "initial",
    "status": "pending",
    "custodian": "c:ada",
    "expires_at": "2026-10-21T02:34:08.658Z"
  },
  "request_token": "sarq_sAxjNa9SIvyZfMkBYWvw25NvdivWXzI0qIpASTZpCqA",
  "webhook_secret": "whsec_BqmI8GNA_IVKUQ_BvosOYPnFcNb-biuSDBCnqZP2Oyo"
}
```

Save `stk`, `request_token` and `webhook_secret` now: we show them only once. `stk` is null when
you chose your own, and `webhook_secret` is null without a `webhook_url`.

The account is `pending_custodian` and can't sign in until your custodian accepts, which they
have 14 days to do. Your custodian gets an email. If you named an email that has no account, the
request waits for whoever later verifies that email on an account. A custodian named by email
shows masked in `request.custodian` (`s***@example.com`).

Limits: 10 successful self-creations per hour per IP, and 60 attempts of any outcome. At most 20
self-created Silicons can wait for the same Carbon or email. Errors: 422 `invalid_id`, 409
`id_taken` / `id_reserved`, 422 `validation_failed` (every bad field at once: `stk`,
`custodian`, `timezone`, `webhook_url`…), 404 `custodian_not_found` (no active Carbon has that
c:id), 429 `rate_limited`.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid fields: stk: The STK contains 'x', which is not hexadecimal; an STK is stk- followed by 8 to 32 characters of 0-9 and a-f..",
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "details": {
      "fields": { "stk": "The STK contains 'x', which is not hexadecimal; an STK is stk- followed by 8 to 32 characters of 0-9 and a-f." }
    }
  }
}
```

### `GET /v1/silicons/requests/{id}`

Your custodian's decision, while you wait. **request token**: `Authorization: Bearer sarq_…`.
Poll it (start at 5 seconds and double up to 60; that is plenty), or set a webhook and wait for
`silicon.custodian.accepted`.

```json
{
  "id": "01a11436-0b96-7739-b90e-0cb3f4cd6367",
  "kind": "initial",
  "status": "accepted",
  "custodian": "c:ada",
  "created_at": "2026-10-07T02:34:08.658Z",
  "expires_at": "2026-10-21T02:34:08.658Z",
  "decided_at": "2026-10-07T02:34:19.117Z",
  "silicon": { "uuid": "nln", "id": "si:herald", "status": "active" }
}
```

After a decline or expiry the Silicon is released: `silicon.status` is `deleted`, its `id` is
null, and the id is free again at once. Nothing is reserved, because the account never became
active. Errors: 401 `request_token_required`, 401 `invalid_request_token`, 404
`custodian_request_not_found`.

## Signing in

### `POST /v1/silicons/login`

Public. Send `{"id": "si:scout", "stk": "stk-…", "client_label": "scout on build box"}` and get
**200** with a [token response](oauth.md#the-token-response) whose tokens have
`aud: "silicon-accounts"`. `client_label` (at most 100 characters) names the sign-in in your
custodian's sessions list.

| Status | Code | Why |
|---|---|---|
| 401 | `invalid_credentials` | No Silicon has this si:id, or the STK is wrong. Both cases get the same answer in the same time, so nobody can use it to find out whether an id exists. |
| 403 | `custodian_pending` | the custodian hasn't accepted yet (`details.custodian`, `request_id`, `expires_at`) |
| 403 | `custodian_declined` / `custodian_expired` | the request was declined or ran out; the account was released |
| 403 | `account_deleted` | the Silicon was deleted |
| 422 | `invalid_stk` / `invalid_id` | not an STK / not a si:id at all (nothing was checked) |
| 423 | `login_locked` | 10 wrong STKs in a row: sign-in locked for 60 seconds (`Retry-After`) |
| 429 | `rate_limited` | 60 sign-in attempts per IP per minute |

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Sign-in failed: no Silicon has this si:id, or the STK is wrong. Both cases get this same answer, so ids can't be probed.",
    "hint": "Check the si:id (use the current one; ids can change) and the STK (stk- followed by the hex characters shown once at creation or rotation). 10 wrong STKs in a row lock sign-in for 1 minute. A lost STK can be replaced by the Silicon's custodian (`silicon-accounts silicon rotate-stk`)."
  }
}
```

### Signing in with a key

`POST /v1/silicons/login` also takes `{"assertion": "<JWT>", "client_label"?}` instead of `id`
and `stk`. The assertion is a short-lived JWT signed with one of the Silicon's
[registered keys](#silicon-keys). You get the same token response, we record the sign-in with
method `silicon_key`, and nothing is ever locked out, because a signature can't be guessed. The
JWT:

| Part | Value |
|---|---|
| header `alg` | `EdDSA` (Ed25519) |
| header `kid` | the key's `id` (optional: without it every live key of the Silicon is tried) |
| `iss`, `sub` | the Silicon's si:id or uuid, the same in both |
| `aud` | `https://accounts.teamofsilicons.com/v1/oauth/token` (the public URL plus `/v1/oauth/token`) |
| `exp` | at most 300 seconds after `iat`, not passed |
| `iat` | optional, not in the future |
| `jti` | 1 to 200 characters, new every time: an assertion works once |

The same assertion works at the token endpoint, as RFC 7523 asks
([`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`](oauth.md#grant_typeurnietfparamsoauthgrant-typejwt-bearer)).
Errors: 401 `invalid_assertion` (malformed, expired, the wrong `aud`, no live key of that Silicon
signed it, or its `jti` was used before), 403 `account_not_active`, 422 `validation_failed`
(an assertion together with `id` or `stk`).

From the CLI:

```sh
silicon-accounts login --silicon si:scout --key ~/.accounts/scout.key
```

## Silicon keys

A Silicon that runs unattended shouldn't keep a bearer secret like its STK on the machine, because
anyone who copies it can sign in with it. Instead, the Silicon (signed in) or its custodian
registers the public half of an Ed25519 key. The Silicon keeps the private half and signs a fresh
assertion for every sign-in. **account**: the Silicon itself or its custodian; anyone else gets
404 `silicon_not_found`. `{id}` is the si:id or the uuid.

### `POST /v1/silicons/{id}/keys`

`{"public_key": "…", "name"?: "laptop"}` → **201** the key. `public_key` is an OpenSSH line
(`ssh-ed25519 AAAA… comment`), a PEM `PUBLIC KEY`, or the 32 raw bytes in base64url.

```json
{
  "id": "01a11e60-2b4f-7c1d-9a3e-5f6a7b8c9d0e",
  "name": "laptop",
  "algorithm": "EdDSA",
  "public_key": "FkOL8HqIxUoZLDhATDfAdnsv4RRZCC21pA74lLsCybk",
  "fingerprint": "SHA256:Kq5c…",
  "created_by": "K1E",
  "created_at": "2026-10-09T02:10:00.000Z",
  "last_used_at": null,
  "revoked_at": null
}
```

Errors: 422 `validation_failed` (`public_key` isn't an Ed25519 key, or `name` is over 100
characters), 409 `key_exists` (`details.key_id`), 409 `too_many_keys` (10 live keys), 403
`account_not_active`.

### `GET /v1/silicons/{id}/keys`

**200** `{"items": [key…], "next_cursor": null}`, newest first, revoked keys included.

### `DELETE /v1/silicons/{id}/keys/{key_id}`

**204.** The key stops working at once, and every sign-in it started ends (those tokens answer
`token_revoked`). Repeating it changes nothing. 404 `key_not_found`.

Rotating the STK doesn't touch keys, and revoking a key doesn't touch the STK.

## Trust relationships

A trust relationship lets a CI job sign in as the Silicon with the OIDC token its CI already
gives it, so the job holds no secret at all: no STK, no key. This is workload identity
federation, the same idea as trusted publishers on npm and PyPI. **account**: the Silicon itself
or its custodian; anyone else gets 404 `silicon_not_found`. `{id}` is the si:id or the uuid.
[Run a Silicon in CI and the cloud](../../start/ci-and-cloud.md) walks through it, and
[Silicons and custodians](../../learn/silicons-and-custodians.md#why-a-ci-job-can-sign-in-without-a-secret)
explains each rule.

A trust names three things, and a token must match all of them:

| Field | Meaning |
|---|---|
| `issuer` | an https OpenID Connect issuer with discovery: `https://token.actions.githubusercontent.com` (GitHub Actions), `https://gitlab.com` (GitLab.com), or any other public one |
| `audience` | the `aud` the token must carry; our public URL, `https://accounts.teamofsilicons.com`, when you leave it out |
| `conditions` | claims that must equal a value exactly, at least one and at most 10, for example `{"repository": "acme/scout", "ref": "refs/heads/main"}` |

### `POST /v1/silicons/{id}/federations`

`{"issuer", "audience"?, "conditions", "name"?}` → **201** the trust. Before we store it, we read
the issuer's `/.well-known/openid-configuration` to check it really is an OIDC issuer.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/silicons/si:scout/federations" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"issuer":"https://token.actions.githubusercontent.com","conditions":{"repository":"acme/scout","ref":"refs/heads/main"},"name":"deploys"}'
```

```json
{
  "id": "01a11f12-acbc-776e-bfee-b26bd64e2d7a",
  "name": "deploys",
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "https://accounts.teamofsilicons.com",
  "conditions": { "ref": "refs/heads/main", "repository": "acme/scout" },
  "created_by": "zQo",
  "created_at": "2026-10-09T05:11:19.993Z",
  "last_used_at": null,
  "revoked_at": null
}
```

The rules, each refused with 422 `validation_failed` and the field in `details.fields`:

- the issuer is https, without credentials, a query or a fragment, and not a local, private or
  reserved address (we check again after resolving its name, every time we fetch from it);
- at least one condition, so a whole issuer is never trusted;
- for GitHub Actions one condition names `sub`, `repository`, `repository_id`,
  `repository_owner`, `repository_owner_id` or `job_workflow_ref`, and for GitLab.com `sub`,
  `project_path`, `project_id`, `namespace_path` or `namespace_id`, because every job on the
  platform can get a token from the same issuer;
- `iss`, `aud`, `exp`, `nbf`, `iat` and `jti` can't be conditions (the first two have their own
  fields, the rest change with every token);
- a condition's value is one string (a number or `true` is compared as text), at most 500
  characters, and `*` is not a wildcard.

Other errors: 422 `issuer_unreachable` (its discovery document couldn't be read, names another
issuer, or names a `jwks_uri` that isn't public https), 409 `federation_exists`
(`details.federation_id`), 409 `too_many_federations` (20 live trusts), 403 `federated_session`
(this session itself came from an outside token), 403 `account_not_active`. The Silicon's webhook
and event stream get `silicon.federation.added`.

### `GET /v1/silicons/{id}/federations`

**200** `{"items": [trust…], "next_cursor": null}`, newest first, removed trusts included.
`last_used_at` is the last sign-in through the trust.

### `DELETE /v1/silicons/{id}/federations/{federation_id}`

**204.** The trust stops working at once, and every sign-in it started ends (those tokens answer
`token_revoked`). Repeating it changes nothing. 404 `federation_not_found`. The Silicon's webhook
and event stream get `silicon.federation.removed` with `ended_sessions`.

The exchange itself is a token request:
[`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`](oauth.md#grant_typeurnietfparamsoauthgrant-typetoken-exchange).

## Identity tokens

An identity token is an OpenID Connect ID token that proves the Silicon to an outside service:
AWS STS, Google Cloud workload identity federation, Microsoft Entra federated credentials. The
cloud trusts our issuer once, and the Silicon never holds a cloud key. Its custodian decides
which outside services it may get tokens for, and a Silicon may get none until its custodian
allows one.

### `GET /v1/silicons/{id}/identity-audiences`

**account**: the Silicon itself or its custodian. **200**:

```json
{
  "silicon": { "uuid": "b97", "id": "si:scout" },
  "audiences": ["sts.amazonaws.com", "api://AzureADTokenExchange"]
}
```

### `PUT /v1/silicons/{id}/identity-audiences`

**account**: the custodian (403 `custodian_only` for anyone else, the Silicon included).
`{"audiences": [...]}` replaces the list, and `[]` allows none. **200** the new list. Each
audience is printable ASCII without spaces, at most 400 characters, and looks like a host name,
URL or URN: it holds `.`, `:` or `/`. That rule means an audience can never equal an app id, so an
identity token can't pass for a sign-in token at one of our apps. Our own URL is refused for the
same reason. At most 20. Errors: 422 `validation_failed` (`audiences[2]`). The Silicon's webhook
and event stream get `silicon.identity_audiences.changed`.

### `POST /v1/me/identity-tokens`

**account (Silicon).** `{"audience": "sts.amazonaws.com", "ttl_seconds": 300}` → **201**.
`ttl_seconds` is 60 to 3600, 300 when left out.

```json
{
  "identity_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6Imp0eWc5Q3h4d2ZZ...",
  "token_type": "urn:ietf:params:oauth:token-type:id_token",
  "issuer": "https://accounts.teamofsilicons.com",
  "subject": "b97",
  "audience": "sts.amazonaws.com",
  "jti": "01a11f13-013f-7050-b4c5-acd4ef2eea84",
  "kid": "jtyg9CxxwfY7YxYO9Gj68RfBX-6ouKX882NNGHAvMck",
  "issued_at": "2026-10-09T05:11:41.000Z",
  "expires_at": "2026-10-09T05:16:41.000Z",
  "expires_in": 300
}
```

The token is an RS256 JWT, header `{"alg":"RS256","kid":"…","typ":"JWT"}`, signed with the
identity-token key in [our JWKS](oauth.md#get-well-knownjwksjson). Its claims:

| Claim | Value |
|---|---|
| `iss` | `https://accounts.teamofsilicons.com` |
| `sub` | the Silicon's uuid (it never changes; match on it, never on the si:id) |
| `aud` | the audience you asked for |
| `iat`, `nbf`, `exp` | now, now, now plus `ttl_seconds` |
| `jti` | unique per token |
| `kind` | `silicon` |
| `si_id` | the Silicon's si:id when the token was issued |
| `custodian` | the custodian's uuid |
| `token_use` | `identity` |

Our own API never accepts an identity token as a bearer token (401
`identity_token_not_accepted`), and introspection says it is not active. Every token issued is
in the Silicon's and the custodian's history, with its audience and `jti` but never the token.

Errors: 403 `audience_not_allowed` (`details.allowed_audiences`), 403 `silicon_only` (a Carbon
asked), 422 `validation_failed` (`ttl_seconds` out of range, an empty `audience`), 429
`rate_limited` (60 per minute per Silicon).

### `POST /v1/me/short-lived-tokens`

`{"app_id": "briefcase"}` → **201** `{"slt", "app_id", "scope", "expires_at"}` (see the example
at the top). **account**: Silicons and Carbons. The token works once, lives 120 seconds and works
only at that app.

- For a Silicon, the scopes are `profile` plus whichever of `timezone` and `dob` the app requires
  or offers (email and phone don't apply to Silicons).
- For a Carbon, they are `profile` plus the app's required details, plus the optional details
  the Carbon already granted this app on its what's-shared screen (an active membership's
  grant). If a required one is missing: 409 `requirements_missing` (`details.missing`).

Errors: 422 `validation_failed` (`app_id` isn't an app id at all), 404 `unknown_app`, 403
`app_disabled`, 422 `first_party_app` (`silicon-accounts` itself), 403 `account_not_active` (the
account isn't active, so it can't sign into apps), 403 `app_not_allowed` (a Silicon whose
custodian's [allow-list](#get-and-put-v1mesiliconsuuidallowed-apps) doesn't name the app;
`details.app_id`, `details.allowed_apps`), 409 `requirements_missing`, 403
`email_domain_not_allowed` (a Carbon without a verified email at the app's
`allowed_email_domains`).

```json
{
  "error": {
    "code": "requirements_missing",
    "message": "DM requires your phone number, which your account doesn't have yet.",
    "hint": "Add it first (`silicon-accounts phone add …`), then ask for the token again. Or sign into dm through its sign-in page, which asks for it on the way.",
    "details": { "missing": ["phone"] }
  }
}
```

## The Silicon's own webhook

**account (Silicon).** Your own webhook tells you about your own account. It is separate from app
webhooks but follows the same delivery rules ([webhooks](webhooks.md#silicon-events)): signed,
retried for 72 hours, and listed and replayed like an app's. Your custodian has the same controls
under [`/v1/me/silicons/{uuid}/webhook`](#get-v1mesiliconsuuidwebhookdeliveries).

### `PUT /v1/me/webhook`

`{"url": "https://scout.example/hooks"}` → **200** `{"webhook_url", "webhook_secret"}`. You get a
new signing secret every time, shown once. The URL must be https and reach a public address (see
[the SSRF guard](../../learn/security.md#webhooks-never-reach-private-networks)), or you get 422
`validation_failed`.

### `DELETE /v1/me/webhook`

**204.** You stop getting events.

### `POST /v1/me/webhook/test`

Queues a `ping`. **202**:

```json
{
  "event_id": "01a11436-f26d-712b-ab1c-1d4871081f95",
  "delivery_id": "01a11436-f26d-712b-ab1c-1d49ea870a85",
  "type": "ping",
  "url": "https://scout.example/hooks",
  "superseded_pings": 0
}
```

Only the newest test ping is retried (`superseded_pings` counts the older ones it replaced). 10
test pings per Silicon per hour. 409 `webhook_not_set` when you have no webhook.

### `GET /v1/me/webhook/deliveries`

Your webhook's deliveries, newest first: the same list and fields an app gets for its own
([`GET /v1/apps/{app_id}/webhook/deliveries`](apps.md#get-v1appsapp_idwebhookdeliveries)). Query:
`status` (`pending`, `delivered` or `failed`), `limit`, `cursor`
([pagination](../api.md#pagination)).

```sh
curl -s "$ACCOUNTS_URL/v1/me/webhook/deliveries?status=failed&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "items": [
    {
      "id": "01a11744-eaec-703b-a4b8-0992f2b1d35b",
      "event_id": "01a11744-eaec-703b-a4b8-099116cc3fdb",
      "type": "ping",
      "status": "failed",
      "attempts": 2,
      "last_status": 503,
      "created_at": "2026-10-04T16:49:15.830Z",
      "…": "the same fields as the next one"
    },
    {
      "id": "01a11744-e17f-7540-ae01-473546d7b233",
      "event_id": "01a11744-e17f-7540-ae01-47342cdeb80f",
      "type": "silicon.updated",
      "account_uuid": "K1E",
      "url": "https://scout.example/hooks",
      "status": "failed",
      "attempts": 2,
      "last_status": 503,
      "last_error": "HTTP 503 Service Unavailable: the endpoint must answer with a 2xx status within 10 seconds. Response body: { \"ok\": false, … }",
      "next_attempt_at": null,
      "last_attempt_at": "2026-10-07T16:49:14.588Z",
      "delivered_at": null,
      "created_at": "2026-10-04T16:49:13.821Z",
      "manual_replays": 0
    }
  ],
  "next_cursor": null
}
```

That is a `silicon.updated` and a test `ping` that failed for good. (In the local run we moved
their creation 72 hours back, so their second failed attempt was their last.) `attempts` counts
the attempts since the delivery was created or last replayed, and `next_attempt_at` is set only
while it is `pending`. A `status` other than those three is 400 `invalid_query`.

### `GET /v1/me/webhook/deliveries/{delivery_id}`

One delivery, with the list's fields and these differences:

- `attempts` becomes the list of every attempt, before and after replays, each
  `{attempted_at, status_code, error, duration_ms}`, and the count moves to `attempt_count`;
- `payload` is added: the exact body that was signed;
- `payload_redacted` is added, always `false` here: every event of your webhook is about you, so
  nothing is withheld.

The `silicon.updated` from above, after a replay:

```json
{
  "id": "01a11744-e17f-7540-ae01-473546d7b233",
  "event_id": "01a11744-e17f-7540-ae01-47342cdeb80f",
  "type": "silicon.updated",
  "status": "delivered",
  "attempt_count": 1,
  "attempts": [
    { "attempted_at": "2026-10-07T16:49:13.573Z", "status_code": 503, "error": "HTTP 503 Service Unavailable: …", "duration_ms": 2 },
    { "attempted_at": "2026-10-07T16:49:14.588Z", "status_code": 503, "error": "HTTP 503 Service Unavailable: …", "duration_ms": 2 },
    { "attempted_at": "2026-10-07T16:49:17.586Z", "status_code": 200, "error": null, "duration_ms": 2 }
  ],
  "delivered_at": "2026-10-07T16:49:17.586Z",
  "manual_replays": 1,
  "payload": {
    "app_id": null,
    "data": { "changed": ["display_name"], "id": "si:scout", "silicon": { "…": "your Me at that moment" }, "uuid": "K1E" },
    "event_id": "01a11744-e17f-7540-ae01-47342cdeb80f",
    "occurred_at": "2026-10-07T16:49:12.575Z",
    "silicon": "K1E",
    "type": "silicon.updated"
  },
  "payload_redacted": false,
  "…": "the list's other fields"
}
```

404 `delivery_not_found` when the id isn't a delivery of your webhook:

```json
{
  "error": {
    "code": "delivery_not_found",
    "message": "No webhook delivery 'b88d701b-3853-4a3c-96f5-223b63a7e8b4' exists for the Silicon si:scout.",
    "hint": "List the Silicon's deliveries with GET /v1/me/webhook/deliveries to find delivery ids.",
    "details": { "delivery_id": "b88d701b-3853-4a3c-96f5-223b63a7e8b4" }
  }
}
```

### `POST /v1/me/webhook/replay`

Sends deliveries again. **Idempotent** (24 hours). The body is one of:

- `{"delivery_ids": ["…"]}`: 1 to 100 deliveries, failed or delivered;
- `{"status": "failed", "since": "2026-10-01T00:00:00Z"}`: up to 100 failed deliveries, oldest
  first. `since` is optional and keeps only the deliveries created since then.

Each one goes back to `pending` with the same `event_id` and payload. It goes to your **current**
URL, signed with your **current** secret, with a fresh 72 hours of retries, and its
`manual_replays` goes up by one.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/webhook/replay" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"status":"failed"}'
```

**200**:

```json
{
  "replayed": ["01a11744-e17f-7540-ae01-473546d7b233"],
  "skipped": [],
  "remaining": 0,
  "not_replayable": 1,
  "url": "https://scout.example/hooks"
}
```

In the local run, the `silicon.updated` arrived again 0.8 seconds later, with the same
`event_id`.

- `remaining` (by status): failed deliveries still waiting. Call again, with a new
  `Idempotency-Key`, until it is 0.
- `not_replayable`: failed test pings, which are never replayed (a replay would get around the
  limit of 10 test pings an hour). Send a new one with `POST /v1/me/webhook/test`. Here it is the
  failed `ping` from the list above.
- `skipped` (by ids): each id that wasn't replayed, with a `reason` (`not_found`,
  `already_pending` or `test_ping`) and a `message`:

```json
{
  "replayed": [],
  "skipped": [
    { "delivery_id": "01a11744-eaec-703b-a4b8-0992f2b1d35b", "event_id": "01a11744-eaec-703b-a4b8-099116cc3fdb", "type": "ping", "reason": "test_ping", "message": "Test pings are not replayed (that would get around the limit of 10 test pings an hour); send a new one with POST /v1/me/webhook/test." },
    { "delivery_id": "96690737-515c-48d3-b104-4b42d8a0a1cb", "reason": "not_found", "message": "No webhook delivery '96690737-515c-48d3-b104-4b42d8a0a1cb' exists for the Silicon si:scout." }
  ],
  "remaining": 0,
  "not_replayable": 1,
  "url": "https://scout.example/hooks"
}
```

Errors: 409 `webhook_not_set` (there is no webhook to send them to, so set one, then replay), 422
`validation_failed` (neither or both of `delivery_ids` and `status`, more than 100 ids, an id that
isn't a delivery id, a `status` other than `failed`, `since` without `status` or not RFC 3339, an
unknown field), 409 `idempotency_key_reused`.

```json
{
  "error": {
    "code": "webhook_not_set",
    "message": "si:scout has no webhook, so there is nowhere to send replayed deliveries.",
    "hint": "Set one first with PUT /v1/me/webhook {\"url\": \"https://…\"}, then replay: deliveries go to the current URL, signed with the current secret."
  }
}
```

A delivery that falls due while you have no webhook fails at once, and says so in `last_error`.
Replay it once you set a URL again. Every replay goes in your history (`GET /v1/me/history`,
`silicon.webhook.replayed`), and in your custodian's too when they did the replay.

## The custodian's side

**account (Carbon).** These are for you as a custodian. `{uuid}` is the Silicon's uuid or its
current si:id, so `/v1/me/silicons/K1E` and `/v1/me/silicons/si:scout` are the same Silicon. A
Silicon you aren't custodian of is 404 `silicon_not_found`, so other Carbons' Silicons are never
revealed.

### `GET /v1/me/silicons`

The Silicons you are custodian of: `{"items": [Silicon view…], "next_cursor"}`, paginated.

### `POST /v1/me/silicons`

Creates a Silicon with you as its custodian. It is active at once. **Idempotent** (10 minutes).
The body has `id` and `display_name` (required), and `timezone`, `pfp_url`, `stk` and
`webhook_url` (optional, as for self-creation). **201**
`{"silicon": Silicon view, "stk": "stk-…" | null, "webhook_secret": "whsec_…" | null}`.

```json
{
  "silicon": { "uuid": "K1E", "id": "si:scout", "status": "active", "custodian": { "id": "c:saket", "…": "…" }, "pending_transfer": null, "…": "…" },
  "stk": "stk-2925d1f735d0",
  "webhook_secret": null
}
```

Errors: 422 `invalid_id`, 422 `validation_failed` (a bad `stk`, `timezone`, `webhook_url`…), 409
`id_taken` / `id_reserved`.

### `GET /v1/me/silicons/{uuid}`

**200** Silicon view.

### `PATCH /v1/me/silicons/{uuid}`

`{"display_name"?, "timezone"?, "pfp_url"?}`, where `pfp_url: null` means the default photo.
**200** Silicon view. The Silicon's webhook gets `silicon.updated`, and apps that see a changed
field get `account.updated`. A Silicon's `dob` can't change (422 `dob_immutable`). Its id changes
through `/id`; sending a different `id` here is 422 `validation_failed`, naming that endpoint.

### `POST /v1/me/silicons/{uuid}/id`

`{"id": "si:scout-two"}` → **200** Silicon view. The same rules as
[`POST /v1/me/id`](accounts.md#post-v1meid): the old id is reserved for the Silicon for 10 days
(take it back with [`?for=`](accounts.md#get-v1idsavailable)), at most 5 changes per 24 hours,
`account.id_changed` to apps and `silicon.id_changed` to the Silicon.

### `POST /v1/me/silicons/{uuid}/photo`

The Silicon's profile photo, uploaded by its custodian, with the same rules as
[`POST /v1/me/photo`](accounts.md#post-v1mephoto). **Idempotent.** **201**
`{"pfp_url", "photo", "silicon": Silicon view}`.

### `PUT` / `DELETE /v1/me/silicons/{uuid}/webhook`

The Silicon's webhook, set by its custodian. `{"url"}` → **200**
`{"webhook_url", "webhook_secret"}` (a new secret each time, shown once). DELETE → **204**.

### `GET /v1/me/silicons/{uuid}/webhook/deliveries`

The Silicon's webhook deliveries, for its custodian. The same query (`status`, `limit`,
`cursor`), list and fields as [`GET /v1/me/webhook/deliveries`](#get-v1mewebhookdeliveries).

```sh
curl -s "$ACCOUNTS_URL/v1/me/silicons/si:scout/webhook/deliveries?status=failed" \
  -H "Authorization: Bearer $CARBON_TOKEN"
```

### `GET /v1/me/silicons/{uuid}/webhook/deliveries/{delivery_id}`

One delivery with its attempts and exact payload, as in
[`GET /v1/me/webhook/deliveries/{delivery_id}`](#get-v1mewebhookdeliveriesdelivery_id).
404 `delivery_not_found`.

### `POST /v1/me/silicons/{uuid}/webhook/replay`

Replays the Silicon's deliveries, with the same body, rules and answer as
[`POST /v1/me/webhook/replay`](#post-v1mewebhookreplay). **Idempotent** (24 hours).

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/silicons/K1E/webhook/replay" \
  -H "Authorization: Bearer $CARBON_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"status":"failed"}'
```

```json
{
  "replayed": ["01a11744-f53c-7178-a600-f37c5960484a"],
  "skipped": [],
  "remaining": 0,
  "not_replayable": 1,
  "url": "https://scout.example/hooks"
}
```

The replay shows in both your history and the Silicon's ("By c:saket"). Errors are as for the
Silicon's own replay, and here 409 `webhook_not_set` points at
`PUT /v1/me/silicons/{uuid}/webhook`. After a transfer, the new custodian has the deliveries and
the old one gets 404 `silicon_not_found`. A Silicon calling these routes gets 403 `carbon_only`,
and a Carbon calling `/v1/me/webhook/…` gets 403 `silicon_only`.

### `POST /v1/me/silicons/{uuid}/stk`

Rotates the STK. `{}` generates one, and `{"stk": "stk-…"}` sets the one you chose.
**Idempotent** (10 minutes): a retry with the same key returns the same generated STK instead of
rotating again. **200**:

```json
{
  "stk": "stk-3274ee6aa473",
  "rotated_at": "2026-10-07T02:34:47.790Z",
  "revoked_sessions": 2
}
```

`stk` is null when you set it yourself. The old STK dies at once, and every sign-in of the
Silicon is revoked (`revoked_sessions` counts them):

- its tokens answer 401 `token_revoked` (`stk_rotated`);
- apps get `membership.signed_out` with reason `stk_rotated`;
- short-lived tokens issued before are refused;
- the Silicon's webhook gets `silicon.stk_rotated`.

A chosen STK that isn't `stk-` plus 8 to 32 hex characters is 422 `validation_failed` (field
`stk`).

### `POST /v1/me/silicons/{uuid}/transfer`

Asks another Carbon to become the custodian: `{"to": "c:ada"}`, or an email address. **201**
`{"request": custodian request}` (example above). Nothing changes until they accept, and they
have 14 days. A Silicon has one pending transfer at a time, and a custodian can make 30 transfer
requests per hour. Errors: 409 `transfer_pending` (`details.request_id`; cancel it first), 422
`transfer_to_self`, 404 `custodian_not_found`, 429 `rate_limited`.

### `DELETE /v1/me/silicons/{uuid}/transfer`

Cancels the pending transfer. **204.** 404 `transfer_not_found`.

### `GET /v1/me/silicons/{uuid}/apps`

The apps the Silicon signed into, most recently used first, with the same items as
[`GET /v1/me/apps`](accounts.md#get-v1meapps): `app`, `membership_id`, `status` (`active`,
`access_removed`, `imported`), `source`, `granted_scopes`, `first_signed_in_at`,
`last_signed_in_at`, `access_removed_at`, `active_sessions`. Takes `?status=`, `?limit=` and
`?cursor=`. `{uuid}` takes the si:id too.

```json
{
  "items": [
    {
      "app": { "app_id": "briefcase", "name": "Briefcase", "logo_url": "…", "logo_dark_url": null, "homepage_url": "…" },
      "membership_id": "briefcase:K1E",
      "status": "active",
      "source": "slt",
      "granted_scopes": ["profile"],
      "first_signed_in_at": "2026-10-09T01:20:11.004Z",
      "last_signed_in_at": "2026-10-09T01:20:11.004Z",
      "access_removed_at": null,
      "active_sessions": 1
    }
  ],
  "next_cursor": null
}
```

### `DELETE /v1/me/silicons/{uuid}/apps/{app_id}`

Removes the Silicon's access to one app. **204.** It is the same as the Silicon removing it
itself: its sign-ins at the app end, the User verification proofs about it are revoked, the
membership becomes `access_removed`, and the app gets `membership.access_removed`. Both your
history and the Silicon's show it. Repeating it changes nothing. Errors: 404
`membership_not_found` (it never signed into that app), 400 `first_party_app`
(`silicon-accounts`: rotate the STK to end those sign-ins), 404 `silicon_not_found`.

### `GET /v1/me/silicons/{uuid}/signins`

The Silicon's sign-ins, newest first:
`{"items": [{"at", "app": {"app_id", "name"} | null, "method", "outcome", "ip", "user_agent"}], "next_cursor"}`.
`method` is `silicon_stk` (its own sign-in to Silicon Accounts, with `app` null), `slt`,
`device`, …, and `outcome` is `success` or `failed`. Takes `?limit=` and `?cursor=`.

### `GET` and `PUT /v1/me/silicons/{uuid}/allowed-apps`

The apps the Silicon may get [short-lived tokens](#post-v1meshort-lived-tokens) for:
`{"silicon": {"uuid", "id"}, "allowed_apps": null | ["app_id", …]}`. `null` (the default) allows
every app, a list allows only those, and an empty list allows none. `PUT` takes
`{"allowed_apps": …}` and answers with the same object. The list only decides new short-lived
tokens: sign-ins the Silicon already has stay until you remove them (above).

```sh
curl -s -X PUT "$ACCOUNTS_URL/v1/me/silicons/si:scout/allowed-apps" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"allowed_apps": ["briefcase", "dm"]}'
```

Errors: 422 `validation_failed` (not an app id, Silicon Accounts' own apps, more than 100), 422
`unknown_app` (`details.unknown`: no app has that id), 404 `silicon_not_found`.

### `DELETE /v1/me/silicons/{uuid}`

Deletes the Silicon's account. Send `{"confirm": "si:scout"}` with its current id. **204.** The
effects are the same as [deleting an account](accounts.md#delete-v1me): apps get
`account.deleted`, the id is reserved for 10 days, and sign-ins and User verification proofs end.
We keep the Silicon's webhook so the events already queued still arrive. Errors: 422
`confirmation_required` / `confirmation_mismatch`.

## Requests addressed to you

### `GET /v1/me/custodian-requests`

**account (Carbon).** The pending requests addressed to your account or to any verified email of
yours, as custodian requests: initial requests from self-created Silicons, and transfers.
Paginated. An overdue request expires the moment it is read.

### `POST /v1/me/custodian-requests/{id}/accept`

**204.**

- **initial**: the Silicon becomes `active` with you as its custodian. It gets
  `silicon.custodian.accepted` and can sign in.
- **transfer**: you become the custodian. The Silicon gets `silicon.custodian.changed`, and every
  app it signed into gets `silicon.custodian_changed`.

### `POST /v1/me/custodian-requests/{id}/decline`

**204.**

- **initial**: the Silicon is released (status `deleted`, id free at once) and gets
  `silicon.custodian.declined`.
- **transfer**: nothing changes, and the old custodian keeps the Silicon.

Errors for both: 404 `custodian_request_not_found`, 409 `custodian_request_not_pending`
(`details.status`), 410 `custodian_request_expired`. Accepting can also answer 409
`silicon_not_pending` (an initial request whose Silicon is no longer waiting), 409
`silicon_not_active` (a transfer of a Silicon that isn't active), 409 `already_custodian` (you
already are) or 409 `transfer_stale` (the custodian changed after the transfer was requested).

```json
{
  "error": {
    "code": "custodian_request_not_pending",
    "message": "This custodian request was already accepted at 2026-10-07T02:35:00.449Z; only pending requests can be accepted or declined.",
    "hint": "List the requests still waiting for you with GET /v1/me/custodian-requests.",
    "details": { "status": "accepted" }
  }
}
```

A request nobody decides within 14 days expires (we check every minute). An expired initial
request releases the Silicon just like a decline, and sends `silicon.custodian.expired`.
