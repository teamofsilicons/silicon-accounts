# Adding sign-in to an app

Silicon Accounts handles the whole sign-in for your app: the sign-in methods (email
code, phone code, Google, Apple), sign up, the pages people see, and your app's user
base. You get back an account with a permanent `uuid`; key your records on it (or on
the membership id `{app_id}:{uuid}`), never on the `c:id`/`si:id`, which can change.

Apps are created in Silicon Apps (`silicon-accounts app new` opens it). As soon as an app
exists there it can sign people in. You get an `app_id` and an app secret.

Everything about an app's sign-in is set up on the developer platform,
https://developers.teamofsilicons.com (its methods, Google and Apple, details and flows,
page styling, redirect URLs, user base and imports, webhooks, App verification proofs). The settings
live in Silicon Accounts, so this CLI reads and changes the same setup.

## 1. Configure sign-in

```sh
printf '%s' "$APP_SECRET" | silicon-accounts app use briefcase --secret-stdin
silicon-accounts app config get
silicon-accounts app config set - <<'JSON'
{
  "methods": {"email": true, "google": true, "apple": false, "phone": false},
  "redirect_uris": ["https://briefcase.example/auth/callback"],
  "required_fields": ["email"],
  "optional_fields": ["timezone"],
  "branding": {"light": {"primary": "#1F5FB8"}, "radius": 12}
}
JSON
```

`required_fields` are details every Carbon must share (if one is missing, say a phone
number, they add it before continuing); `optional_fields` show as checkboxes that start
unticked, and the Carbon decides. A detail you add is required unless you list it as
optional. A `flow` decides which page asks which detail, in what order:

```json
{"flow": {"steps": [
   {"id": "contact", "fields": ["email"], "title": "How can we reach you?"},
   {"id": "about-you", "fields": ["timezone"], "continue_label": "Finish", "layout": "split"}
 ], "review": true}}
```

Every requested detail appears on exactly one page (1 to 8 pages); `"flow": null` is one
page with everything, which is also the what's-shared screen.

The patch is deep-merged (arrays replace). Every invalid field is reported at once.
Pass `--expected-version` (from `config get`) so you never overwrite someone else's
change. Google and Apple work in one click with our credentials (`"mode":"managed"`),
or bring your own (`"mode":"byo"`) so consent screens show your name and logo.
The pages always end with "Powered by Silicon Accounts"; everything else about their
look (colours, fonts, radius, layout, logo) is yours.

## 2. Send people to sign in (pick one)

1. **Hosted pages** — redirect the browser to:
   `https://accounts.teamofsilicons.com/authorize?app_id=briefcase&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&scope=email`
   (the Rust package builds it: `AccountsClient::authorize_url` with `pkce_pair()`).
2. **Iframe** — `<iframe src="https://accounts.teamofsilicons.com/embed/v1/buttons?app_id=briefcase&redirect_uri=…">`
   (add your origin to `allowed_origins`).
3. **Snippet** —
   `<div id="silicon-accounts"></div><script src="https://accounts.teamofsilicons.com/sdk/v1.js" data-app-id="briefcase" data-redirect-uri="https://briefcase.example/auth/callback" data-target="#silicon-accounts" async></script>`

Always send `state` and check it on return; use PKCE. The redirect URI must exactly
match one you registered: Silicon Accounts never redirects anywhere else.

Direct buttons on your own site: add `method=google|apple|email|phone` (Google and Apple
first show our "Opening Google to sign you in to Briefcase…" page in your style, then
move on; email and phone open on that method's empty field). Separate `Sign in` and
`Sign up` buttons: add `intent=signin` or `intent=signup` (the pages say "Sign in to
Briefcase" or "Create your Briefcase account"; a first-time Carbon signs up either way).
Never collect a Carbon's email or phone yourself: they always type it on our pages, and
`login_hint` is ignored.

## 3. Exchange the code

The browser comes back to `redirect_uri?code=sac_…&state=…`. Exchange the code
(single use, 2 minutes) from your server:

```sh
silicon-accounts app token exchange --code sac_… --redirect-uri https://briefcase.example/auth/callback --code-verifier …
```

The response holds an access token (JWT, 30 minutes), a refresh token (rotates on
every use; valid up to 900 days) and the `account` as your app may see it. Reusing an
old refresh token revokes the whole family, which protects accounts if a token
leaks; always store the new one.

## Silicons signing into your app

Silicons never see your sign-in page. A Silicon runs `silicon-accounts login --app briefcase`
and gives you a short-lived token; exchange it:

```sh
silicon-accounts app token slt slt_…
```

## Checking tokens

* Locally (fast, no network): verify the JWT's EdDSA signature against
  `/.well-known/jwks.json` and check `aud` is your app id
  (`silicon-accounts app token verify <access-token>`, or `AppClient::verify_access_token_locally`).
* Remotely (sees revocation): `silicon-accounts app token introspect <token>`.
* Profile: `silicon-accounts app userinfo <access-token>` (OIDC claims included).

OIDC clients work too: discovery is at `/.well-known/openid-configuration`; add
`openid` to the scope for an id token.

## Your user base

```sh
silicon-accounts app users --q saket
silicon-accounts app user <uuid>
silicon-accounts app import users.csv --wait          # see `silicon-accounts docs imports`
```

Every Carbon and Silicon that signed in is listed with its membership id and the
details it shared. The columns are fixed; apps can't add their own.

## Stay in sync

Register a webhook (`silicon-accounts app webhook set https://…`) to hear about id changes,
profile changes, sign-outs, removed access and deleted accounts. See
`silicon-accounts docs webhooks`. To act at another app on an account's behalf, use proofs:
`silicon-accounts docs proofs`.
