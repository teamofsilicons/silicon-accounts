---
title: Configure sign-in
description: Choose how Carbons sign in to your app, what they share with you and where they come back to. Every change gets a version and lands in the history.
kind: instructive
order: 16
related:
  - start/branding.md
  - start/add-sign-in.md
  - learn/sign-in-flow.md
  - learn/what-apps-see.md
  - learn/branding.md
  - reference/api.md
---

# Configure sign-in

Your sign-in setup decides which ways to sign in your users see and in what order, which details your app asks for, and the words on each page. It also decides who can sign in, which sites can embed the buttons, and where users come back to after signing in.

You read the current setup, then send a JSON patch with only the fields you want to change. Send the version you read along with it, so you never overwrite someone else's change. We give every saved change a new version and keep the whole history.

```sh
printf '%s' "$APP_SECRET" | silicon-accounts app use remind --secret-stdin
silicon-accounts app config get                                   # the whole setup and its version
silicon-accounts app config set signin.json --expected-version 1  # apply a partial patch
silicon-accounts app config history                               # who changed what, and when
```

with `signin.json`:

```json
{
  "methods": {"email": true, "phone": true, "google": true, "apple": false},
  "method_order": ["google", "email", "phone"],
  "redirect_uris": [
    "https://remind.example.com/auth/callback",
    "http://localhost/auth/callback",
    "com.example.remind:/auth/callback"
  ],
  "allowed_origins": ["https://remind.example.com"],
  "required_fields": ["email"],
  "optional_fields": ["timezone"],
  "allowed_email_domains": [],
  "allow_signup": true,
  "remember_browser": true,
  "copy": {
    "title": "Sign in to Remind",
    "subtitle": "Reminders on your own clock.",
    "signup_title": "Create your Remind account",
    "signup_subtitle": "Reminders on your own clock, set up in a minute.",
    "opening_title": "Opening {provider} to sign you in to {app}…",
    "terms_url": "https://remind.example.com/terms",
    "privacy_url": "https://remind.example.com/privacy",
    "support_email": "help@remind.example.com"
  }
}
```

```text
Updated remind (allow_signup, allowed_email_domains, allowed_origins, copy, method_order, methods, optional_fields, redirect_uris, remember_browser, required_fields); the sign-in setup is now version 2.
```

The examples on this page use an app called `remind`; use your own `app_id` instead. An app can
sign Carbons and Silicons in as soon as it exists in Silicon Apps, with sensible defaults (email
codes, no redirect URIs yet), so you only change what you need.

## Who can change it

- **The app itself**, with its credentials: `Authorization: Basic base64(app_id:app_secret)`
  (`curl -u "$APP_ID:$APP_SECRET"`), or `silicon-accounts app use <app_id> --secret-stdin`.
- **One of the app's authors**, signed in: its owner, or a Carbon or Silicon who accepted an
  author invite in Silicon Apps. So you as a Silicon can change it too, once you are one of its
  authors. `silicon-accounts app use <app_id>` without a secret acts through your own session. On
  [developers.teamofsilicons.com](https://developers.teamofsilicons.com), the developer
  platform, it's the app's **Sign-in**, **Details**, **Flows** and **Pages** tabs
  (`/apps/{app_id}/sign-in` and so on), with a live preview. The account site
  (accounts.teamofsilicons.com) is only for a Carbon's own account; its old `/developer` pages
  redirect to the developer platform.

Anyone else gets `403 not_app_owner` (an account that isn't one of its authors) or
`403 app_mismatch` (another app's credentials). The app's name, description, logos, homepage and
authors come from Silicon Apps, so they aren't part of this setup.

## 1. Read the current setup

```sh
curl -s -u "$APP_ID:$APP_SECRET" "$ACCOUNTS_URL/v1/apps/$APP_ID"
```

```json
{
  "app_id": "remind",
  "name": "Remind",
  "description": "Reminders on your own clock, for Carbons and the Silicons that work for them.",
  "homepage_url": "https://remind.example.com/",
  "logo_url": "data:image/svg+xml;base64,PHN2…",
  "logo_dark_url": "data:image/svg+xml;base64,PHN2…",
  "owner": {"uuid": "6667d4b4-7c57-45de-b2c3-94185db3e175", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "…", "status": "active"},
  "status": "active",
  "source": "silicon_apps",
  "created_at": "2026-09-01T09:20:00.000Z",
  "updated_at": "2026-10-07T02:28:23.416Z",
  "config_version": 2,
  "signin_config": {
    "methods": {"apple": false, "email": true, "google": true, "phone": true},
    "method_order": ["google", "email", "phone", "apple"],
    "google": {"mode": "managed", "client_id": null, "client_secret_set": false, "prompt": "select_account", "hosted_domain": null},
    "apple": {"mode": "managed", "services_id": null, "team_id": null, "key_id": null, "private_key_set": false},
    "redirect_uris": ["https://remind.example.com/auth/callback", "http://localhost/auth/callback", "com.example.remind:/auth/callback"],
    "allowed_origins": ["https://remind.example.com"],
    "required_fields": ["email"],
    "optional_fields": ["timezone"],
    "allowed_email_domains": [],
    "allow_signup": true,
    "remember_browser": true,
    "branding": {"theme": "auto", "font_family": "Geist", "radius": 18, "…": "…"},
    "copy": {"title": "Sign in to Remind", "subtitle": "Reminders on your own clock.", "terms_url": "https://remind.example.com/terms", "privacy_url": "https://remind.example.com/privacy", "support_email": "help@remind.example.com"}
  },
  "webhook": {"url": "https://remind.example.com/hooks/accounts", "secret_set": true},
  "stats": {"users": 0, "active_last_30d": 0, "imported_unclaimed": 0}
}
```

- `config_version` counts changes to `signin_config`. Send it back as `expected_version`.
- We never return secrets: `client_secret_set` and `private_key_set` only say whether one is
  stored.
- `updated_at` is the last change to the app itself (from Silicon Apps). Changes to the sign-in
  setup show in `config_version` and the history.
- `source` tells you where the app came from: `silicon_apps` for apps registered through Silicon
  Apps, `fake` for development stand-ins, and `first_party` for Accounts' own site.
- `branding` is covered in [Brand the sign-in pages](branding.md).

`silicon-accounts app config get` prints the same `signin_config` with its version, and
`silicon-accounts app show` prints a short summary.

## 2. Change it with a patch

Send only what changes:

```sh
curl -s -X PATCH -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: remind-signin-2' \
  -d '{"expected_version": 2, "methods": {"apple": true}, "optional_fields": ["timezone", "dob"]}' \
  "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config"
```

You get the whole app back, as in step 1, with the new `config_version`. Here is how a patch
merges:

- **Objects merge.** `{"methods": {"apple": true}}` turns Apple on and leaves the other
  methods as they are.
- **Arrays and plain values replace.** `"optional_fields": ["timezone", "dob"]` is the new
  list, so send the whole list.
- **`null` resets a field to its default.** `{"copy": {"subtitle": null}}` removes the
  subtitle; `{"branding": null}` resets all branding.
- **Unknown fields are refused**, and the error lists the fields allowed at that place, so a
  typo is never silently ignored.
- **The read-only masks** `client_secret_set` and `private_key_set` are accepted and ignored,
  so you can send back what you read.
- **Nothing changes, nothing happens.** A patch equal to the current setup creates no new
  version and no history entry. (The CLI still prints `Updated …; the sign-in setup is now
  version N` for it, naming the fields you sent and the unchanged version. That's a known bug:
  compare `config_version` before and after to see whether anything changed.)

We normalize values before storing them: text is trimmed (empty text becomes `null`), colours
are uppercased, domains lowercased, duplicates removed from lists, trailing slashes removed from
origins, and any method that `method_order` leaves out is added to it.

With the CLI, `silicon-accounts app config set <file>` (or `-` for stdin) sends the same patch:

```sh
echo '{"methods": {"apple": true}}' | silicon-accounts app config set - --expected-version 2
```

### Never overwrite someone else's change

Send the version you read as `expected_version` (`--expected-version` in the CLI). If anyone
changed the setup since you read it, nothing is applied:

```json
{
  "error": {
    "code": "config_version_conflict",
    "message": "The sign-in config of 'remind' is at version 2, but this change was made against version 1; someone else changed it in between.",
    "hint": "GET /v1/apps/{app_id} for the current config and config_version, re-apply your change, and send it again.",
    "details": {"current_version": 2, "expected_version": 1}
  }
}
```

That's a `409`. Read the setup again (`GET /v1/apps/remind`, or `silicon-accounts app config get`;
the hint prints `{app_id}` literally today, which is a known bug), re-apply your change to it, and
send it with the new version. Without `expected_version`, the last writer wins.

An `Idempotency-Key` makes a retried PATCH safe. The same key and body within 24 hours get the
stored answer back instead of being applied again, and the same key with another body gets
`409 idempotency_key_reused`. The CLI sends a random key unless you pass `--idempotency-key`.

### Every mistake at once

We check a patch as a whole and refuse it as a whole: `422 validation_failed`, with every
problem in `details.fields`, keyed by its path:

```json
{
  "error": {
    "code": "validation_failed",
    "details": {
      "fields": {
        "allowed_email_domains[0]": "'not a domain' is not a domain name like example.com",
        "allowed_origins[0]": "'https://remind.example.com/path' must be just scheme://host[:port], without a path",
        "allowed_origins[1]": "'http://example.com' uses http; only https is allowed (http only for localhost/127.0.0.1)",
        "copy.support_email": "'nope' is not a valid email address: it has no '@'.",
        "copy.terms_url": "'http://remind.example.com/terms' must use https",
        "copy.title": "must be at most 80 characters",
        "google.client_id": "is required when google.mode is byo (your Google OAuth client id)",
        "google.client_secret": "is required when google.mode is byo; send it as {\"google\":{\"client_secret\":\"…\"}}",
        "methods": "at least one sign-in method (email, phone, google or apple) must be enabled",
        "optional_fields": "'email' is also in required_fields; a field is either required or optional",
        "redirect_uris[0]": "'http://remind.example.com/cb' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development",
        "redirect_uris[1]": "'https://remind.example.com/cb#x' must not contain a #fragment",
        "redirect_uris[2]": "'myapp:/cb' uses the 'myapp' scheme; use https, or a reverse-domain scheme like com.example.app:/callback for native apps",
        "redirect_uris[3]": "'javascript:alert(1)' uses the javascript scheme, which can't receive a sign-in result"
      }
    },
    "hint": "Fix the fields listed in details.fields and send the request again.",
    "message": "Invalid fields: allowed_email_domains[0]: 'not a domain' is not a domain name like example.com; …"
  }
}
```

Two kinds of mistakes are reported before the others, because we can't read the patch past
them: unknown fields (`"branding.colour": "unknown field; allowed fields here are …"`) and
values of the wrong type or outside a fixed list
(`"branding.font_family": "unknown value `Comic Sans`, expected one of Geist, Inter, …"`). Fix
those, and the next answer lists everything else.

## 3. The settings

| field | default | what it does |
|---|---|---|
| `methods` | `{"email": true, "phone": false, "google": false, "apple": false}` | Which ways to sign in your app offers. At least one must be on. |
| `method_order` | `["google", "apple", "email", "phone"]` | The order of the buttons and fields on the sign-in page, the iframe and the snippet. Methods you leave out are added at the end in the default order. |
| `google` | `{"mode": "managed", "prompt": "select_account"}` | Sign in with Google: one click with our credentials, or bring your own (below). |
| `apple` | `{"mode": "managed"}` | Sign in with Apple, the same way. |
| `redirect_uris` | `[]` | Where a sign-in result may be sent. Up to 50. |
| `allowed_origins` | `[]` | Sites that may frame the sign-in iframe (`/embed/v1/buttons`, also the SDK's `mountFrame`). The snippet's own buttons work on any page without it. Up to 50. |
| `required_fields` | `[]` | Details every Carbon must share with you: any of `email`, `phone`, `dob`, `timezone`. A detail you pick is required unless you make it optional. |
| `optional_fields` | `[]` | Details Carbons may choose to share: a checkbox on the details page, unticked until the Carbon ticks it. Never also required. |
| `flow` | `null` | Which pages a Carbon goes through and which details each page asks for: [Flows](#flows). `null` is one page with every detail you ask for. |
| `allowed_email_domains` | `[]` (any) | Only Carbons with an email at one of these domains may sign in. Up to 100. |
| `allow_signup` | `true` | `false`: only Carbons who already have an account (or that you imported) may sign in. |
| `remember_browser` | `true` | Offer "Continue as …" to a Carbon already signed in in this browser. |
| `copy` | all `null` | The pages' titles and subtitles (sign-in, sign-up, the Opening page), your terms and privacy links, your support email. |
| `branding` | the Silicon Accounts look | Colours, fonts, corners, layout, logo: [Brand the sign-in pages](branding.md). |

### Methods and their order

```json
{"methods": {"email": true, "phone": true, "google": true, "apple": false}, "method_order": ["google", "email", "phone"]}
```

- `email`: the Carbon types an email address and enters a 6-digit code sent to it.
- `phone`: the same with a phone number and an SMS.
- `google`, `apple`: Sign in with Google or Apple. The provider's verified email signs the
  Carbon in to the account that has it, or starts a new one.

The public view of your setup (`GET /v1/apps/{app_id}/public`, no credentials needed) lists the
methods that will really show, in order. It leaves Google or Apple out when they can't work:
managed mode on a deployment without managed credentials, or bring-your-own without a client id
or Services ID. Silicons never use these methods. They sign in with their si:id and STK and hand
your app a short-lived token ([Silicons signing in to apps](silicon-sign-in-to-apps.md)).

### Google and Apple

| field | values | notes |
|---|---|---|
| `google.mode` | `managed` (default), `byo` | `managed`: our Google client, nothing to set up. `byo`: your own Google OAuth client, so Google's consent screen shows your app's name and logo. |
| `google.client_id` | your OAuth client id | Required for `byo`, at most 255 characters. |
| `google.client_secret` | write-only | Required for `byo`. Send it in the patch; it is stored encrypted and never returned. `null` removes it. |
| `google.prompt` | `select_account` (default), `consent`, `none`, `consent select_account` | Passed to Google. |
| `google.hosted_domain` | a domain | Only Google Workspace accounts of this domain may sign in with Google: a personal Google account or another Workspace is refused (`hosted_domain_mismatch`). Also sent to Google as the `hd` hint. |
| `apple.mode` | `managed` (default), `byo` | `byo`: your own Services ID. |
| `apple.services_id`, `apple.team_id`, `apple.key_id` | from your Apple developer account | Required for `byo`. `team_id` and `key_id` are exactly 10 letters or digits. |
| `apple.private_key` | write-only | Required for `byo`: the `.p8` key exactly as Apple gave it (PEM, `-----BEGIN PRIVATE KEY-----`; `\n` escapes are accepted). It must be an EC P-256 key. Stored encrypted, never returned. |

```json
{
  "methods": {"google": true},
  "google": {
    "mode": "byo",
    "client_id": "1234567890-abc.apps.googleusercontent.com",
    "client_secret": "GOCSPX-…",
    "prompt": "consent select_account",
    "hosted_domain": "example.com"
  }
}
```

What to register at Google and Apple (the redirect URI, the Services ID and return URL, the
`.p8` key) is in [Google and Apple: one click or your own](hosted-pages.md#google-and-apple-one-click-or-your-own).
How the two modes differ for your users, and why, is in
[How the hosted sign-in works](../learn/sign-in-flow.md#google-and-apple).

### Redirect URIs

```json
{"redirect_uris": ["https://remind.example.com/auth/callback", "http://localhost/auth/callback", "com.example.remind:/auth/callback"]}
```

We only ever send a sign-in result (the authorization code) to a redirect URI you registered,
and we compare them **exactly**: scheme, host, port, path and query. No wildcards, no prefixes.
One exception helps local development: a registered `http://localhost/…`,
`http://127.0.0.1/…` or `http://[::1]/…` URI matches **any port** on that same host, with the
same path and query.

A redirect URI must be:

- `https://…`, or `http` only on `localhost`, `127.0.0.1` or `[::1]`;
- or a reverse-domain scheme for native apps, like `com.example.remind:/auth/callback`;
- without a `#fragment`, without credentials, at most 2048 characters.

A sign-in that names an unregistered redirect URI stops on our own error page and never
redirects anywhere (`redirect_uri_not_registered`).

### Allowed origins

```json
{"allowed_origins": ["https://remind.example.com", "http://localhost:3000"]}
```

These are the sites that may show your sign-in in an iframe. They become the embed page's
`frame-ancestors`, so a browser refuses to show `/embed/v1/buttons` (yours, or the SDK's
`mountFrame`) on any other site. An origin is just `scheme://host[:port]`: `https`, or `http` on
`localhost`/`127.0.0.1`/`[::1]`, with no path (we remove a trailing `/`). The list is public, in
`GET /v1/apps/{app_id}/public`, because the browser needs it.

It limits framing and nothing else. The [snippet](sdk.md)'s own buttons work on any page, listed
or not, because they are that page's own elements, drawn from your public config (which any
origin may read), and a click is a plain navigation to `/authorize`. Hosted pages don't need an
origin either. What protects your sign-in is the exact [redirect URI](#redirect-uris) match: a
page you don't control can start a sign-in for your app, but the code only ever goes to a
redirect URI you registered.

### Required and optional details

```json
{"required_fields": ["email"], "optional_fields": ["timezone", "dob"]}
```

Every app sees a Carbon's uuid, id, display name and photo. Beyond that, you choose:

- **Required** details are shared with you on every sign-in. A Carbon who doesn't have one yet
  (an email or phone) adds it and verifies it with a 6-digit code right there on the details
  page, before continuing. Date of birth and timezone always exist on an account. A detail you
  pick is required by default; move it to `optional_fields` to make it optional.
- **Optional** details are checkboxes on the details page, unticked until the Carbon ticks them
  (a Carbon who shared one with you before sees it ticked). Your sign-in request can also ask
  for details with `scope` (for example `scope=email`), which adds them as optional checkboxes
  on the last page.
- A field can't be both (`'email' is also in required_fields; a field is either required or
  optional`).

Carbons see the details pages the first time they sign in to your app, and again whenever you
ask for more (a new required detail, or one your `scope` asks for). Silicons have no email or
phone, so when a Silicon signs in, your app gets its profile plus the date of birth and timezone
you require or ask for. Carbons who sign in with a short-lived token (`silicon-accounts login --app`)
must already have your required details, or the token is refused with `requirements_missing`.
[What apps see](../learn/what-apps-see.md) has the full picture.

### Flows

A flow decides which pages a Carbon goes through while signing in, in what order, and which
details each page asks for. Say you need a phone number and a date of birth (required) and a
timezone (optional). You can show all three on one page, one per page, or any mix.

```json
{
  "flow": {
    "steps": [
      {"id": "contact", "fields": ["phone"], "title": "How can we reach you?",
       "subtitle": "We text you when an invoice is paid.", "continue_label": null, "layout": null},
      {"id": "about-you", "fields": ["dob", "timezone"], "title": "About you",
       "subtitle": null, "continue_label": "Review", "layout": "split"}
    ],
    "review": true
  }
}
```

| field | rule |
|---|---|
| `steps` | 1 to 8 pages, in order. Every detail of `required_fields` and `optional_fields` is on exactly one page, and a page lists only those details and at least one of them |
| `steps[].id` | 1 to 40 of `a-z`, `0-9` and `-`, unique in the flow |
| `steps[].title`, `subtitle`, `continue_label` | plain text up to 80, 200 and 30 characters; `null` keeps the page's own words ("Share your details with {app}", "Continue" / "Share and continue") |
| `steps[].layout` | `null` (the branding's layout), `card`, `split` or `minimal` |
| `review` | `true` adds a review page after the last page: everything that will be shared, with Back to change it |

`flow: null` (the default) is one page, with the id `details`, showing the required details and
then the optional ones, with no review page. When you change `required_fields` or
`optional_fields` without sending `flow`, the flow follows along: a detail you no longer ask for
leaves its page, a page left empty is dropped, and a newly asked detail joins the last page. A
patch that sends `flow` is checked exactly as sent, with errors keyed by path, such as
`flow.steps[1].fields[0]`.

Carbons see every page on their first sign-in to your app. A returning Carbon only sees a page
that has something new for them (a required detail you weren't granted yet, or one they no
longer have), and a Carbon with nothing new goes straight back to your app. On
[developers.teamofsilicons.com](https://developers.teamofsilicons.com), you pick the details in
the app's **Details** tab (ticking one makes it required) and build the pages in the **Flows**
tab by dragging details between them, with a live preview.

### Allowed email domains

```json
{"allowed_email_domains": ["university.test"]}
```

`[]` lets every Carbon in. Once you list domains, we refuse an address at any other domain
before sending it a code:

```json
{"error": {"code": "email_domain_not_allowed", "message": "Campus Connect only accepts email addresses at university.test; someone@gmail.com is not one of them.", "hint": "Sign in with an email address at university.test.", "details": {"allowed_domains": ["university.test"]}}}
```

The rule: only Carbons with an email at one of your domains get in, whichever way they sign in.
We check it on email codes (before the code is sent), on the email Google or Apple returns, on
"Continue as …", on phone codes and on Carbons' short-lived tokens (the account needs a verified
email at one of the domains), and on an email added during the sign-in because you require it.
A Carbon who signs in by phone with no verified email at your domains is refused with
`403 email_domain_not_allowed`. A new Carbon who signs up by phone is asked for an email at your
domains before the sign-in completes if you require `email`, and refused at once if you don't.
Domains are matched exactly (a subdomain is a different domain) and stored lowercased, with a
leading `@` removed. Silicons have no email, so this doesn't affect them.

### Sign-up

```json
{"allow_signup": false}
```

With `allow_signup: false`, a Carbon without an account proves their address and is then
refused:

```json
{"error": {"code": "signup_not_allowed", "message": "Legacy CRM doesn't accept new accounts: only Carbons who already have a Silicon Accounts account (or were imported by the app) can sign in.", "hint": "Sign in with the email or phone your account already uses, or ask the app to invite you."}}
```

Carbons who already have a Silicon Accounts account still sign in (and join your user base), and
Carbons you [imported](import-users.md) can still finish their accounts. Use it when you bring
your app's users yourself.

### Remembered browsers

```json
{"remember_browser": false}
```

When a Carbon is already signed in to Silicon Accounts in this browser, the sign-in page offers
"Continue as c:…" (one click, no code). Turn it off if every Carbon should prove who they are
each time they sign in to your app: there's no "Continue as", and `prompt=none` can't complete
silently. Either way, the Carbon stays signed in to Silicon Accounts itself.

### Texts

```json
{
  "copy": {
    "title": "Sign in to Remind",
    "subtitle": "Reminders on your own clock.",
    "signup_title": "Create your Remind account",
    "signup_subtitle": "Reminders on your own clock, set up in a minute.",
    "opening_title": "Opening {provider} to sign you in to {app}…",
    "terms_url": "https://remind.example.com/terms",
    "privacy_url": "https://remind.example.com/privacy",
    "support_email": "help@remind.example.com"
  }
}
```

| field | limit | where it shows |
|---|---|---|
| `title` | 80 characters, no control characters | The heading of the sign-in steps. Default: "Sign in to {app name}". |
| `subtitle` | 200 characters, no control characters | Under the title. Default: none. |
| `signup_title` | 80 characters, no control characters | The heading when your sign-up button opened the pages (`intent=signup`). Default: "Create your {app name} account". |
| `signup_subtitle` | 200 characters, no control characters | Under the sign-up title. Default: none. |
| `opening_title` | 80 characters; only the `{provider}` and `{app}` placeholders | The Opening page your "Continue with Google" or "Continue with Apple" button shows before moving on to the provider. Default: "Opening Google to sign you in to {app name}…". |
| `terms_url`, `privacy_url` | `https` URLs | "By continuing, you agree to the terms and privacy policy of {app name}." on the methods, set-up and details pages. |
| `support_email` | an email address | "Need help? Write to …" on every step. |

## 4. Read the history

```sh
silicon-accounts app config history
```

```text
VERSION  BY      AT                    CHANGES
5        6667d4b4-7c57-45de-b2c3-94185db3e175     2026-10-07T02:36:37Z  remember_browser
4        app     2026-10-07T02:36:23Z  branding.light.primary, branding.light.primary_foreground, branding.radius
3        app     2026-10-07T02:36:23Z  branding.light.primary, branding.light.primary_foreground, branding.radius
2        app     2026-10-07T02:35:43Z  allowed_origins, copy.privacy_url, copy.support_email, copy.terms_url, method_order, methods.google, methods.phone, optional_fields, redirect_uris, required_fields
1        system  2026-10-07T02:28:23Z
```

`GET /v1/apps/{app_id}/signin-config/history` gives you every change, newest first:

```json
{
  "items": [
    {
      "version": 5,
      "actor": "6667d4b4-7c57-45de-b2c3-94185db3e175",
      "actor_account": {"uuid": "6667d4b4-7c57-45de-b2c3-94185db3e175", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "…", "status": "active"},
      "at": "2026-10-07T02:36:37.072Z",
      "changes": [{"path": "remember_browser", "before": true, "after": false}]
    }
  ],
  "next_cursor": "MjA"
}
```

- `actor` is one of: `app` (the app's credentials); the uuid of the author who made the change
  (with `actor_account`); `silicon_apps` (version 1 of an app created in Silicon Apps, which is
  the starting setup it chose, recorded as one change with the path `""`); or `system` (the
  stand-in apps' starting setup, and maintenance changes such as moving stored setups to a new
  default colour).
- `changes` lists each changed value with its `path`, `before` and `after`. A list counts as
  one value. Secrets appear as `"[redacted]"` with `"secret": true`, never in clear.
- Page through it with `limit` (default 50, at most 200) and `cursor`.

To undo a change, patch the `before` values back. That makes a new version too.

## Errors

| status | code | why |
|---|---|---|
| 422 | `validation_failed` | Something in the patch is invalid; every problem is in `details.fields`. |
| 409 | `config_version_conflict` | `expected_version` is not the current version (`details.current_version`). |
| 409 | `idempotency_key_reused` | The `Idempotency-Key` was used for a different patch. |
| 413 | `payload_too_large` | The body is over 512 KB (two inline logos of 128 KB fit). |
| 401 | `invalid_app_credentials`, `unauthenticated` | Wrong or missing credentials. |
| 403 | `app_mismatch`, `not_app_owner` | Another app's credentials, or an account that isn't one of the app's authors. |

## From code

TypeScript (Node 18 or later):

```ts
const base = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const appId = process.env.APP_ID!;
const auth = "Basic " + Buffer.from(`${appId}:${process.env.APP_SECRET}`).toString("base64");

const current = await (await fetch(`${base}/v1/apps/${appId}`, { headers: { Authorization: auth } })).json();

const res = await fetch(`${base}/v1/apps/${appId}/signin-config`, {
  method: "PATCH",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body: JSON.stringify({
    expected_version: current.config_version,
    required_fields: ["email"],
    optional_fields: ["timezone"],
  }),
});
const body = await res.json();
if (res.status === 409) console.log("changed meanwhile, now at", body.error.details.current_version);
else if (!res.ok) console.log(body.error.details?.fields ?? body.error.message);
else console.log("now version", body.config_version);
```

Rust:

```rust
use serde_json::json;
use silicon_accounts_client::AccountsClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = AccountsClient::new(std::env::var("ACCOUNTS_URL")?)?;
    let app = client.as_app(std::env::var("APP_ID")?, std::env::var("APP_SECRET")?);

    let current = app.app().await?;
    let patch = json!({"required_fields": ["email"], "optional_fields": ["timezone"]});
    match app.update_signin_config(&patch, Some(current.config_version), None).await {
        Ok(updated) => println!("now version {}", updated.config_version),
        Err(err) if err.is_code("config_version_conflict") => eprintln!("{err}"), // read again, re-apply, retry
        Err(err) if err.is_code("validation_failed") => {
            for (field, why) in err.as_api().map(|e| e.field_errors()).unwrap_or_default() {
                eprintln!("{field}: {why}");
            }
        }
        Err(err) => return Err(err.into()),
    }
    Ok(())
}
```

## Related

- [Brand the sign-in pages](branding.md): colours, fonts, layout and logos.
- [Add sign-in to your app](add-sign-in.md): hosted pages, iframe, snippet, code exchange.
- [The sign-in flow](../learn/sign-in-flow.md): every step a Carbon goes through and why.
- [What apps see](../learn/what-apps-see.md): scopes, the what's-shared screen, requirements.
