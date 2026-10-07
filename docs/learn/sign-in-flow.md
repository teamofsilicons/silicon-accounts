---
title: How the hosted sign-in works
description: What happens between /authorize and your redirect URI, step by step, and why each rule exists, from exact redirect URIs, state and PKCE to codes, sign-up, "Continue as", prompt, and Google and Apple.
kind: informative
order: 10
related:
  - start/hosted-pages.md
  - start/add-sign-in.md
  - learn/tokens-and-sessions.md
  - learn/what-apps-see.md
  - learn/security.md
---

# How the hosted sign-in works

Your app only sees two moments of a sign-in: it sends a browser to `/authorize`, and the
browser comes back to your redirect URI. This page explains what Silicon Accounts does in
between and why, so you can predict how a sign-in behaves and judge the edge cases yourself.
To build one, start at [Sign in with the hosted pages](../start/hosted-pages.md).

## The steps

`/authorize` is a page. It turns your request into a *flow*: a server-side record of one
sign-in, bound to the browser that opened it, that lives 60 minutes. The hosted pages move the
flow through these steps:

```text
choose_method ──email/phone──▶ verify_code ──┐
      │  └──Google/Apple─────────────────────┼──▶ signup (first time, or finishing an import)
      └──Continue as the browser's Carbon ───┤        │
                                             ▼        ▼
                       details[0] ──▶ details[1] … ──▶ review ──▶ complete: redirect_uri?code=…&state=…
                       (Back between pages; Cancel anywhere)       (or error=access_denied)
prompt=none that can't sign in silently ──────────────────────▶ failed:   redirect_uri?error=…&state=…
```

- **choose_method**: the app's enabled methods in its order (Google, Apple, email, phone by
  default), and "Continue as …" when the browser is already signed in to Silicon Accounts. The
  sign-up version when the app sent `intent=signup`. An app's direct button opens one method:
  `email`/`phone` on its empty field, `google`/`apple` on the Opening page ("Opening Google to
  sign you in to {app}…"), which moves on to the provider by itself.
- **verify_code**: a 6-digit code went to the email or phone.
- **signup**: the email, phone or Google/Apple identity belongs to nobody yet, so this is the
  Carbon's sign-up.
- **details**: the pages of your app's flow, each with the details it asks for: required ones
  (a missing email or phone is added on the page, with a code) and optional checkboxes,
  unticked until the Carbon ticks them. One page when your app has no flow of its own.
- **review**: everything that will be shared, when your flow turns the review page on.
- **complete** or **failed**: the flow is over, and the browser is sent to your redirect URI.

Steps are skipped when they have nothing to ask: an existing Carbon who already granted
everything you need goes from "Continue as" straight to `complete`, in one click.

## The redirect URI must match exactly

The code is the key to the account's tokens, so where it is sent is the most important rule.
Silicon Accounts compares `redirect_uri` with your registered list character for character:
no prefixes, no wildcards, no trailing-slash forgiveness. A looser rule (any path on your host,
say) would let anyone who controls one page on that host, or finds an open redirect on it,
collect codes.

Two exceptions, both from how native and local software works (RFC 8252): `http://localhost`,
`http://127.0.0.1` and `http://[::1]` match on any port when registered with that host,
because a local server often can't choose its port; and reverse-domain schemes such as
`com.example.app:/callback` are allowed for native apps. Everything else must be `https`.

The checks run in a fixed order: first the app, then the redirect URI, then everything else.
A request whose app or redirect URI is wrong stops on Silicon Accounts' page and never
redirects, because redirecting to an unverified address would make Silicon Accounts an open
redirect that carries its own credibility. Once the redirect URI is known to be yours, other
mistakes (a bad `scope`, `prompt` or PKCE parameter) can safely be reported back to it as
`error=invalid_request` and friends.

## state, PKCE and single-use codes

They cover three different attacks:

- **`state` stops login CSRF.** Without it, an attacker could start a sign-in with their own
  account, stop before the callback, and send the callback link to your user: your app would
  sign your user in as the attacker, and whatever your user saves lands in the attacker's
  account. A state that your server issued to *this* browser (in a cookie) and checks once
  makes such a link fail. Silicon Accounts returns `state` byte for byte but can't check it
  for you: only your app knows which browser it gave it to.
- **PKCE makes a stolen code useless.** Codes travel in URLs, which end up in browser history,
  logs and `Referer` headers. With a `code_challenge` on `/authorize`, the exchange needs the
  matching `code_verifier`, which never left your server. It is required once you send a
  challenge, and the reverse is refused too: a verifier for a request that had no challenge is
  a sign of a downgrade attack (RFC 9700), so that exchange fails.
- **Codes are single use and live 2 minutes.** Any refused exchange burns the code. If a code is
  presented a second time, every token issued from the first exchange is revoked and your app
  hears `membership.signed_out` with reason `authorization_code_reuse`: whoever exchanged first
  may not have been you.

Even though every app authenticates with its secret, PKCE still matters: the secret proves
*which app* exchanges, PKCE proves it is *the same sign-in your app started*.

## A flow belongs to one browser

When `/authorize` creates the flow it sets a cookie that binds the flow to that browser, and
every step checks it. A half-finished sign-in can't be continued from another browser, so a
link to someone else's flow is worthless. The same browser can run several sign-ins at once
(two tabs, two apps): they share the binding.

## Codes by email and phone

A code is 6 digits and lasts 10 minutes. A resend retires the previous code. The limits count
per address (the email or phone), whatever flow, app or tab sent the code:

- at most 10 codes to one address in 10 minutes (and 30 per network), then `429 rate_limited`
  until the window passes;
- 10 wrong codes in a row lock every code to that address for 1 minute (`423`); a right code
  ends the streak.

Counting per address, not per flow, is what stops someone from guessing in parallel across
many flows.

## The first time: sign-up

When a code proves an email or phone that belongs to nobody, or Google or Apple vouch for an
identity nobody has, the Carbon signs up on the spot. Everything on the sign-up page is filled
in already, so one click finishes it: the display name (from Google or Apple, else from the
email, else "Carbon 1234" from the phone), a free `c:` id derived from the email, the timezone
from the network (else the browser's), a date of birth exactly 18 years ago, and the default
profile photo. The verified email or phone is held in a sign-up session for 48 hours, so a
Carbon who closes the tab picks it up again in the same browser, through any app that allows
sign-up, offers the same method and accepts the email's domain.

Some details shape who becomes what:

- **An existing account is never duplicated.** An email Google or Apple vouch for that already
  belongs to an account signs in to that account (and links the provider to it). Only
  verified emails and phones identify an account.
- **`allow_signup: false`** refuses new accounts *after* the code proves the address
  (`signup_not_allowed`). Refusing earlier would tell anyone who types an address whether it
  has an account. Existing accounts still sign in, so the setting limits the creation of new
  Silicon Accounts accounts through your app, not which accounts join it.
- **Imported Carbons finish their account.** A Carbon your app [imported](imports.md) proves
  their email or phone and lands on the sign-up page prefilled from your import
  (`finishing_import`); finishing keeps the account's uuid, so your records already point at
  it.
- **`allowed_email_domains`** is checked before an email code is sent, on Google and Apple
  emails, for "Continue as" (the account needs a verified email at one of the domains), and on
  an email added on a details page. A phone code isn't checked today, so an account that
  signs in by phone gets through even when its email is at another domain (requiring `email`
  doesn't help when the account already has one). Keep `phone` off on an app that restricts
  domains.

## Continue as …

Silicon Accounts keeps its own session in the browser (an HttpOnly cookie on
`accounts.teamofsilicons.com`, up to 900 days). When a flow starts in a browser that is signed
in, `choose_method` offers "Continue as Grace Hopper": one click, no code. This is what makes
one account across many apps pleasant, and it only ever works in the browser that holds the
session.

Your app can turn it off with `remember_browser: false` (shared computers, or apps that want a
fresh proof every time): the chooser disappears and `prompt=none` always fails with
`login_required`. `prompt=login` does the same for a single sign-in. "Not you?" forgets the
offered account for that flow.

The Silicon Accounts session and your app's sign-in are separate on purpose: signing out of
your app doesn't sign the browser out of Silicon Accounts, and signing out of Silicon Accounts
doesn't end your app's sign-in. See [Tokens and sessions](tokens-and-sessions.md).

## prompt

`prompt` lets your app ask for a specific behaviour:

- `login`: the Carbon must prove who they are again; the `id_token`'s `auth_time` then shows
  the new moment. "Continue as" and `prompt=none` keep the earlier `auth_time`, which is how
  you can tell a fresh proof from a remembered one.
- `consent`: show every details page even when nothing new is asked. The Carbon can untick
  optional details there, which replaces the grant.
- `select_account`: show the chooser. The hosted pages never continue silently with the
  browser's account, so the chooser already appears whenever there is one.
- `none`: show nothing. The flow either completes at once with the browser's account or fails
  with `login_required`, `consent_required` or `interaction_required`. Combining `none` with
  anything else contradicts itself, so it's refused (OIDC Core §3.1.2.1).

## Google and Apple

**Managed or your own.** With `managed`, Silicon Accounts' own Google and Apple clients do the
work and the providers' consent screens name Silicon Accounts. With `byo`, your Google OAuth
client or Apple Services ID is used, so the providers show your app's name and logo, and their
quotas and reviews are yours. In both modes Silicon Accounts is the medium: the provider sends
the Carbon back to Silicon Accounts' callback (`/v1/oauth/callback/google` or `/apple`), which
finishes the sign-in and sends the browser on to your redirect URI. That's why the address
you register with Google or Apple is Silicon Accounts', and why sign-up, linking and the
details pages behave the same for every method. A direct "Continue with Google" button on your
own site first shows the Opening page in your app's style, so the Carbon sees who is asking
before the provider's page appears.

**What is checked.** The provider's `id_token` is verified against the provider's keys:
signature, issuer, audience (the client that was used), expiry, the nonce Silicon Accounts
sent, and `email_verified`. With a Google `hosted_domain`, the Workspace domain must match.
Google gets PKCE as well; Apple answers with a form post.

**Only the browser that started can finish.** The provider's answer is accepted only from the
browser that holds the flow's binding cookie. Apple posts its answer cross-site, which carries
no such cookie, so the answer is parked and the browser is sent (303) to a same-site address
that does carry it. An answer delivered by any other browser is discarded and can't be
replayed. Without this rule, a genuine Google link forwarded to someone else would sign the
sender in as that Carbon.

**Who signs in.** A Google or Apple identity seen before signs in to its account; a new one
whose verified email belongs to an account is linked to that account; anything else signs up.

## Where a sign-in is recorded

Every completed (or refused) sign-in goes into the account's sign-in history with its method
(`email`, `phone`, `google`, `apple`, `session` for "Continue as", `slt` for a Silicon) and
outcome, and into your user base: `GET /v1/apps/{app_id}/users/{uuid}` lists an account's last
20 sign-ins to your app (time, method, outcome, never an IP address). See
[What your app sees about an account](what-apps-see.md#your-user-base).

## Silicons never come here

A Silicon has no browser to redirect and no inbox for a code. It signs in to Silicon Accounts
with its si:id and STK, asks for a short-lived token for your app, and hands it over; your app
exchanges it. Nothing on this page applies to it: no flow, no code, no what's-shared screen.
See [Sign a Silicon in to an app](../start/silicon-sign-in-to-apps.md) and
[Silicons and custodians](silicons-and-custodians.md).
