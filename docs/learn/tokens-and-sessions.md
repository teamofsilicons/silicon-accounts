---
title: Tokens and sessions
description: Why access tokens are short JWTs, why refresh tokens rotate and punish reuse, what ends a sign-in and how your app hears about it, and how Silicon Accounts' browser session, your app's sign-in and your own session relate.
kind: informative
order: 11
related:
  - start/tokens.md
  - learn/sign-in-flow.md
  - learn/what-apps-see.md
  - learn/webhooks.md
  - learn/security.md
---

# Tokens and sessions

A sign-in gives your app two tokens with very different jobs: a short access token that proves
who is calling, and a long refresh token that renews it. This page explains the reasoning
behind their lifetimes and rules, what ends a sign-in, and how it relates to the sessions
around it. The calls themselves are in
[Exchange, refresh, check and revoke tokens](../start/tokens.md).

## Three sessions, three owners

| Session | Lives in | Lasts | Ended by |
|---|---|---|---|
| Silicon Accounts' browser session | An HttpOnly cookie on `accounts.teamofsilicons.com` | up to 900 days | The Carbon signing out on the account site, or removing it from their sessions list |
| Your app's sign-in (a *token family*) | Your server: the refresh token and the access tokens it mints | up to 900 days from the sign-in | Your app revoking it, the account removing your access, a Silicon's STK rotation, account deletion, token reuse, or its 900 days |
| Your app's own session | Whatever you use (usually your own cookie) | You decide | You |

They are independent on purpose. Signing out of your app (revoking) doesn't sign the browser
out of Silicon Accounts: the Carbon may be signed in to ten other apps there. Signing out of
Silicon Accounts doesn't end your app's sign-in either: your app decides how long its users
stay signed in. The one link that matters runs one way: when your sign-in ends for a reason
you didn't cause, Silicon Accounts tells your webhook, and you end your own session.

Because the browser session outlives your sign-in, a Carbon who signs out of your app and
clicks "Sign in" again is offered "Continue as …" without a code. Send `prompt=login` when
signing back in must mean proving it again.

## Access tokens: short and self-contained

An access token is a JWT signed with Ed25519 (`alg: EdDSA`), issued to your app (`aud` is your
app id) for 30 minutes. It carries everything an API needs to decide who is calling: the
account's uuid (`sub`), its kind, its id at issue time, the membership id, the sign-in it
belongs to (`fid`) and the granted scopes.

- **Self-contained**, so your API can verify it with the public keys at
  `/.well-known/jwks.json` without calling Silicon Accounts on every request. Keys are named by
  `kid`; cache the key set and fetch it again when a token names a key you don't have.
- **Short**, because a self-contained token can't be recalled: once issued, it verifies until
  `exp`. Thirty minutes bounds how long a revoked sign-in can still be used by an API that only
  checks locally. When an action can't wait that long (deleting data, moving money), ask
  [introspection](../start/tokens.md#check-an-access-token), which knows about revocation
  immediately and also refuses tokens whose membership is no longer active.
- **Audience-bound**, so a token minted for one app is useless at another. Your API must check
  `aud`; the libraries do it when you pass your app id. To act at another app on an account's
  behalf, apps use [OBO proofs](../start/obo.md), not each other's tokens.

## Refresh tokens: rotated, reuse-detected, 900 days at most

A refresh token is opaque (`sar_…`) and stored by Silicon Accounts only as a keyed hash, so a
copy of its database can't be replayed. Three rules shape it:

1. **It rotates.** Each refresh returns a new refresh token and spends the old one.
2. **Reuse ends the sign-in.** If a spent refresh token comes back, two parties hold the
   sign-in, and Silicon Accounts can't tell which one is the thief. So it revokes the whole
   family, the newest tokens included, and tells your app (`membership.signed_out`, reason
   `refresh_token_reuse`). A stolen refresh token therefore gets at most one use before the
   theft shows up, instead of silently living for years.
3. **900 days, then sign in again.** The limit counts from the moment the account signed in,
   and refreshing doesn't extend it. A sliding window would let a stolen token live forever as
   long as it is used; a fixed one bounds every sign-in.

The price of rule 2 is that a sign-in can't be refreshed twice in parallel. Two workers or two
tabs that refresh the same token at the same moment look exactly like a thief and the owner:
one succeeds, the other trips reuse detection, and the sign-in ends. Refresh through one place
per sign-in (one in-process request shared by all callers, or a lock in your session store),
and save the new refresh token before using anything else from the answer.

## What ends a sign-in

| Event | Your webhook hears | A refresh then says (`invalid_grant`) |
|---|---|---|
| Your app revokes the refresh or an access token | `membership.signed_out`, reason `app_revoked` | `… was revoked at … (app_revoked)` |
| A spent refresh token is presented again | `membership.signed_out`, reason `refresh_token_reuse` | `… (refresh_token_reuse)` |
| A used authorization code is presented again | `membership.signed_out`, reason `authorization_code_reuse` | `… (authorization_code_reuse)` |
| The account removes your app's access on the account site | `membership.access_removed` | `… (access_removed)` |
| A Silicon's custodian rotates its STK | `membership.signed_out`, reason `stk_rotated` | `… (stk_rotated)` |
| The account is deleted | `account.deleted` | `… (account_deleted)` |
| 900 days pass | nothing | `The refresh token expired at …` |

When the account removes your access, Silicon Accounts revokes every sign-in your app holds for
it (and the OBO proofs your app issued about it), marks the membership `access_removed` in
your user base, and stops showing you its contact details. It comes back only when the account
signs in to your app again, through the what's-shared screen.

The access tokens of an ended sign-in keep verifying locally until their `exp`, at most 30
minutes. Introspection answers `{"active":false}` for them at once, and `/v1/userinfo` refuses
them with `token_revoked` and the reason.

## Codes and short-lived tokens: one use, two minutes

Both are bearer credentials that travel through places your server doesn't control (a URL, a
Silicon's terminal), so both are as narrow as possible:

- An **authorization code** is bound to your app, the redirect URI and the PKCE challenge of
  its request, works once, and expires after 120 seconds. Its exchange and the tokens it
  issues happen in one transaction, so of two simultaneous exchanges exactly one wins, and the
  loser's attempt revokes the winner's tokens (the code had leaked).
- A **short-lived token** (`slt_…`) is how a Silicon signs in to your app: it is minted by the
  Silicon's own signed-in session for one app, works once, and expires after 120 seconds. It
  is refused if the Silicon's STK was rotated after it was minted (rotation ends every sign-in
  of the Silicon, including tokens already handed out), or if the account removed your app's
  access after it was minted.

## The id_token is for your client, not for APIs

With `openid` in the scope, the token response also carries an `id_token`: a statement to
*your app* about who signed in and when (`auth_time`), with your `nonce` so it can't be
replayed into another sign-in. It is for the code that handled the callback. Don't send it to
APIs as a credential; the access token is the credential. Refreshes return a new `id_token`
without a nonce, and `auth_time` stays the time of the original proof.

## Scopes over time

What an account has granted your app accumulates across sign-ins: a later sign-in that asks
for less still returns everything granted so far, so `scope` in a token response is the
current grant, not the current request. Two things reduce it: the Carbon switching optional
details off on the what's-shared screen (shown again when you ask for more, or with
`prompt=consent`), and removing your access altogether. A refresh can narrow its request but
never widen the grant: new details always go through the what's-shared screen.

## Keep tokens on your server

- **Every app is a confidential client.** Exchanging a code needs your app secret, so the
  exchange happens on a server you control, also for single-page and native apps (they hand
  the code, or code and verifier, to that server).
- **Refresh tokens are long-lived credentials.** Keep them server side, encrypted at rest,
  never in `localStorage` or a URL. Give the browser your own session cookie instead.
- **Access tokens may reach the browser** if your pages call your API with them, but every copy is a
  30-minute credential for that account at your app.

The service-side protections (hashing, encryption, cookie rules, what is never logged) are in
[Security](security.md).
