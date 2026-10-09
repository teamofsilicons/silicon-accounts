---
title: How the hosted sign-in works
description: A browser sign-in from your app to us and back, step by step, and why redirect URLs, state, PKCE, consent and provider settings matter.
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

Your app starts a sign-in by sending the browser to `/authorize`. We check who the Carbon is, ask for any details that are missing and get their agreement to share them with your app. Then we send the browser back to your redirect URI.

This page walks through those steps and the rules behind each one. To build the flow, start with [Sign in with the hosted pages](../start/hosted-pages.md).

## The steps

`/authorize` is a page. It turns your request into a *flow*: a server-side record of one sign-in, bound to the browser that opened it, that lives for 60 minutes. The hosted pages move the flow through these steps:

```text
choose_method ──email/phone──▶ verify_code ──┐
      │  └──Google/Apple─────────────────────┼──▶ signup (first time, or finishing an import)
      └──Continue as the browser's Carbon ───┤        │
                                             ▼        ▼
                       details[0] ──▶ details[1] … ──▶ review ──▶ complete: redirect_uri?code=…&state=…
                       (Back between pages; Cancel anywhere)       (or error=access_denied)
prompt=none that can't sign in silently ──────────────────────▶ failed:   redirect_uri?error=…&state=…
```

- **choose_method**: your app's enabled methods in your order (Google, Apple, email, phone by default), plus "Continue as …" when the browser is already signed in with us. It's the sign-up version when your app sent `intent=signup`. A direct button on your app opens one method: `email`/`phone` on its empty field, and `google`/`apple` on the Opening page ("Opening Google to sign you in to {app}…"), which moves on to the provider by itself.
- **verify_code**: a 6-digit code went to the email or phone.
- **signup**: the email, phone or Google/Apple identity belongs to nobody yet, so this is the Carbon signing up.
- **details**: the pages of your app's flow, each with the details it asks for. Required ones come first (a missing email or phone is added right on the page, with a code), then optional checkboxes, which stay unticked until the Carbon ticks them. There's one page when your app has no flow of its own.
- **review**: everything that will be shared, when your flow turns the review page on.
- **complete** or **failed**: the flow is over, and the browser goes to your redirect URI.

A step is skipped when it has nothing to ask. An existing Carbon who already granted everything you need goes from "Continue as" straight to `complete`, in one click.

## The redirect URI must match exactly

The code is the key to the account's tokens, so where we send it is the most important rule. We compare `redirect_uri` with your registered list character for character: no prefixes, no wildcards, no forgiving a trailing slash. A looser rule (say, any path on your host) would let anyone who controls one page on that host, or finds an open redirect on it, collect codes.

There are two exceptions, both from how native and local software works (RFC 8252). `http://localhost`, `http://127.0.0.1` and `http://[::1]` match on any port when registered with that host, because a local server often can't choose its port. Reverse-domain schemes such as `com.example.app:/callback` are allowed for native apps. Everything else must be `https`.

The checks run in a fixed order: first the app, then the redirect URI, then everything else. If the app or redirect URI is wrong, the request stops on our page and never redirects. Redirecting to an address we haven't verified would make us an open redirect that carries our own credibility. Once we know the redirect URI is yours, other mistakes (a bad `scope`, `prompt` or PKCE parameter) can safely go back to it as `error=invalid_request` and friends.

## state, PKCE and single-use codes

Each one covers a different attack:

- **`state` stops login CSRF.** Without it, an attacker could start a sign-in with their own account, stop before the callback, and send the callback link to your user. Your app would sign your user in as the attacker, and whatever your user saves would land in the attacker's account. A state your server issued to *this* browser (in a cookie), and checks once, makes such a link fail. We return `state` byte for byte, but we can't check it for you: only your app knows which browser it gave it to.
- **PKCE makes a stolen code useless.** Codes travel in URLs, and URLs end up in browser history, logs and `Referer` headers. With a `code_challenge` on `/authorize`, the exchange needs the matching `code_verifier`, which never left your server. Once you send a challenge the verifier is required. The reverse is refused too: a verifier for a request that had no challenge is a sign of a downgrade attack (RFC 9700), so that exchange fails.
- **Codes are single use and live 2 minutes.** Any refused exchange burns the code. If a code comes in a second time, we revoke every token issued from the first exchange and your app hears `membership.signed_out` with reason `authorization_code_reuse`, because whoever exchanged first may not have been you.

Every app authenticates with its secret, and PKCE still matters: the secret proves *which app* is exchanging, and PKCE proves it's *the same sign-in your app started*.

## A flow belongs to one browser

When `/authorize` creates the flow, it sets a cookie that binds the flow to that browser, and every step checks it. Nobody can continue a half-finished sign-in from another browser, so a link to someone else's flow is worthless. The same browser can run several sign-ins at once (two tabs, two apps), and they share the binding.

## Codes by email and phone

A code is 6 digits and lasts 10 minutes. Sending it again retires the previous code. The limits count per address (the email or phone), whichever flow, app or tab sent the code:

- at most 10 codes to one address in 10 minutes (and 30 per network), then `429 rate_limited` until the window passes;
- 10 wrong codes in a row lock every code to that address for 1 minute (`423`); a right code ends the streak.

Counting per address, not per flow, is what stops someone guessing in parallel across many flows.

## The first time: sign-up

When a code proves an email or phone that belongs to nobody, or Google or Apple vouch for an identity nobody has, the Carbon signs up right there. We fill in everything on the sign-up page already, so one click finishes it:

- the display name, from Google or Apple, else from the email, else "Carbon 1234" from the phone;
- a free `c:` id made from the email;
- the timezone from the network, else the browser's;
- a date of birth exactly 18 years ago;
- the default profile photo.

We hold the verified email or phone in a sign-up session for 48 hours. A Carbon who closes the tab picks it up again in the same browser, through any app that allows sign-up, offers the same method and accepts the email's domain.

A few rules decide who becomes what:

- **An existing account is never duplicated.** If Google or Apple vouch for an email that already belongs to an account, the Carbon signs in to that account (and the provider is linked to it). Only verified emails and phones identify an account.
- **`allow_signup: false`** refuses new accounts *after* the code proves the address (`signup_not_allowed`). Refusing earlier would tell anyone who types an address whether it has an account. Existing accounts still sign in, so the setting limits new Silicon Accounts accounts being created through your app, not which accounts join it.
- **Imported Carbons finish their account.** A Carbon your app [imported](imports.md) proves their email or phone and lands on the sign-up page, prefilled from your import (`finishing_import`). Finishing keeps the account's uuid, so your records already point at it.
- **`allowed_email_domains`** is checked before an email code is sent, on Google and Apple emails, for "Continue as", after a phone code, and on an email added on a details page. Only an account with a verified email at one of the domains gets in, whichever way it signs in. A new Carbon who signs up by phone is asked for an email at the domains on the details page when your app requires an email, and refused at once when it doesn't. We check once more right before the sign-in completes.

## Continue as …

We keep our own session in the browser (an HttpOnly cookie on `accounts.teamofsilicons.com`, up to 900 days). When a flow starts in a browser that's signed in, `choose_method` offers "Continue as Grace Hopper": one click, no code. This is what makes one account across many apps pleasant, and it only ever works in the browser that holds the session.

Your app can turn it off with `remember_browser: false`, for shared computers or if you want a fresh proof every time. The chooser goes away and `prompt=none` always fails with `login_required`. `prompt=login` does the same for a single sign-in. "Not you?" forgets the offered account for that flow.

Our session and your app's sign-in are separate on purpose. Signing out of your app doesn't sign the browser out of Silicon Accounts, and signing out of Silicon Accounts doesn't end your app's sign-in. See [Tokens and sessions](tokens-and-sessions.md).

## prompt

`prompt` lets your app ask for a specific behaviour:

- `login`: the Carbon must prove who they are again, and the `id_token`'s `auth_time` then shows the new moment. "Continue as" and `prompt=none` keep the earlier `auth_time`, which is how you tell a fresh proof from a remembered one.
- `consent`: show every details page, even when nothing new is asked. The Carbon can untick optional details there, which replaces the grant.
- `select_account`: show the chooser. The hosted pages never continue silently with the browser's account, so the chooser already shows up whenever there is one.
- `none`: show nothing. The flow either completes at once with the browser's account or fails with `login_required`, `consent_required` or `interaction_required`. `none` combined with anything else contradicts itself, so we refuse it (OIDC Core §3.1.2.1).

## Google and Apple

**Managed or your own.** With `managed`, sign-in uses our Google and Apple setup, and their consent screens show Silicon Accounts. With `byo`, you bring your own Google OAuth client or Apple Services ID. Their screens then show your app's name and logo, and you look after their quotas and reviews.

Either way, Google or Apple sends the Carbon back to our callback (`/v1/oauth/callback/google` or `/apple`). We finish the sign-in and send the browser back to your app. So you register our callback with the provider, and your app's redirect URI with us.

Creating accounts, linking and the details pages work the same in both modes. Even a direct "Continue with Google" button opens one of our pages first, in your app's style, so the Carbon sees which app is asking before they reach Google.

**What is checked.** We verify the provider's `id_token` against the provider's keys: signature, issuer, audience (the client that was used), expiry, the nonce we sent, and `email_verified`. With a Google `hosted_domain`, the Workspace domain must match. Google gets PKCE as well; Apple answers with a form post.

**Only the browser that started can finish.** We accept the provider's answer only from the browser that holds the flow's binding cookie. Apple posts its answer cross-site, which carries no such cookie, so we park the answer and send the browser (303) to a same-site address that does carry it. An answer delivered by any other browser is thrown away and can't be replayed. Without this rule, a genuine Google link forwarded to someone else would sign the sender in as that Carbon.

**Who signs in.** A Google or Apple identity we've seen before signs in to its account. A new one whose verified email belongs to an account is linked to that account. Anything else signs up.

## Where a sign-in is recorded

Every completed (or refused) sign-in goes into the account's sign-in history with its method (`email`, `phone`, `google`, `apple`, `session` for "Continue as", `slt` for a Silicon) and outcome. It also goes into your user base: `GET /v1/apps/{app_id}/users/{uuid}` lists an account's last 20 sign-ins to your app (time, method, outcome, never an IP address). See [What your app sees about an account](what-apps-see.md#your-user-base).

## Silicons never come here

A Silicon has no browser to redirect and no inbox for a code. It signs in to Silicon Accounts with its si:id and STK, asks us for a short-lived token for your app and hands it to you, and your app exchanges it. Nothing on this page applies to it: no flow, no code, no what's-shared screen. See [Sign a Silicon in to an app](../start/silicon-sign-in-to-apps.md) and [Silicons and custodians](silicons-and-custodians.md).
