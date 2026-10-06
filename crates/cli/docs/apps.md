# Adding sign-in to an app

Silicon Accounts handles the whole sign-in for your app: the sign-in methods (email
code, phone code, Google, Apple), sign up, the pages people see, and your app's user
base. You get back an account with a permanent `uuid`; key your records on it (or on
the membership id `{app_id}:{uuid}`), never on the `c:id`/`si:id`, which can change.

Apps are created in Silicon Apps (`accounts app new` opens it). As soon as an app
exists there it can sign people in. You get an `app_id` and an app secret.

## 1. Configure sign-in

```sh
printf '%s' "$APP_SECRET" | accounts app use briefcase --secret-stdin
accounts app config get
accounts app config set - <<'JSON'
{
  "methods": {"email": true, "google": true, "apple": false, "phone": false},
  "redirect_uris": ["https://briefcase.example/auth/callback"],
  "required_fields": ["email"],
  "optional_fields": ["timezone"],
  "branding": {"light": {"primary": "#1F5FB8"}, "radius": 12}
}
JSON
```

The patch is deep-merged (arrays replace). Every invalid field is reported at once.
Pass `--expected-version` (from `config get`) so you never overwrite someone else's
change. Google and Apple work in one click with our credentials (`"mode":"managed"`),
or bring your own (`"mode":"byo"`) so consent screens show your name and logo.
The pages always end with "Powered by Silicon Accounts"; everything else about their
look (colours, fonts, radius, layout, logo) is yours.

## 2. Send people to sign in (pick one)

1. **Hosted pages** — redirect the browser to:
   `https://account.teamofsilicons.com/authorize?app_id=briefcase&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&scope=email`
   (the Rust package builds it: `AccountsClient::authorize_url` with `pkce_pair()`).
2. **Iframe** — `<iframe src="https://account.teamofsilicons.com/embed/v1/buttons?app_id=briefcase&redirect_uri=…">`
   (add your origin to `allowed_origins`).
3. **Snippet** —
   `<div id="silicon-accounts"></div><script src="https://account.teamofsilicons.com/sdk/v1.js" data-app-id="briefcase" data-redirect-uri="https://briefcase.example/auth/callback" data-target="#silicon-accounts" async></script>`

Always send `state` and check it on return; use PKCE. The redirect URI must exactly
match one you registered: Silicon Accounts never redirects anywhere else.

## 3. Exchange the code

The browser comes back to `redirect_uri?code=sac_…&state=…`. Exchange the code
(single use, 2 minutes) from your server:

```sh
accounts app token exchange --code sac_… --redirect-uri https://briefcase.example/auth/callback --code-verifier …
```

The response holds an access token (JWT, 30 minutes), a refresh token (rotates on
every use; valid up to 900 days) and the `account` as your app may see it. Reusing an
old refresh token revokes the whole family, which protects accounts if a token
leaks; always store the new one.

## Silicons signing into your app

Silicons never see your sign-in page. A Silicon runs `accounts login --app briefcase`
and gives you a short-lived token; exchange it:

```sh
accounts app token slt slt_…
```

## Checking tokens

* Locally (fast, no network): verify the JWT's EdDSA signature against
  `/.well-known/jwks.json` and check `aud` is your app id
  (`accounts app token verify <access-token>`, or `AppClient::verify_access_token_locally`).
* Remotely (sees revocation): `accounts app token introspect <token>`.
* Profile: `accounts app userinfo <access-token>` (OIDC claims included).

OIDC clients work too: discovery is at `/.well-known/openid-configuration`; add
`openid` to the scope for an id token.

## Your user base

```sh
accounts app users --q saket
accounts app user <uuid>
accounts app import users.csv --wait          # see `accounts docs imports`
```

Every Carbon and Silicon that signed in is listed with its membership id and the
details it shared. The columns are fixed; apps can't add their own.

## Stay in sync

Register a webhook (`accounts app webhook set https://…`) to hear about id changes,
profile changes, sign-outs, removed access and deleted accounts. See
`accounts docs webhooks`. To act at another app on an account's behalf, use proofs:
`accounts docs proofs`.
