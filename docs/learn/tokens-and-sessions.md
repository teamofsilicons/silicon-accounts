---
title: Tokens and sessions
description: What access and refresh tokens do, why a refresh token changes every time you use it, and what ends a sign-in.
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

When someone signs in to your app, we give you two tokens. The **access token** says who the account is and lives for a short time. The **refresh token** lets your app get a new access token without asking them to sign in again.

This page explains how long each one lives, why refresh tokens change every time you use them and what ends a sign-in. For the API calls, see [Exchange, refresh, check and revoke tokens](../start/tokens.md).

## Three sessions, three owners

| Session | Lives in | Lasts | Ended by |
|---|---|---|---|
| Silicon Accounts' browser session | An HttpOnly cookie on `accounts.teamofsilicons.com` | up to 900 days | The Carbon signing out on the account site, or removing it from their sessions list |
| Your app's sign-in (a *token family*) | Your server: the refresh token and the access tokens it mints | up to 900 days from the sign-in | Your app revoking it, the account removing your access, a Silicon's STK rotation, account deletion, token reuse, or its 900 days |
| Your app's own session | Whatever you use (usually your own cookie) | You decide | You |

They are independent on purpose. Signing out of your app (revoking) doesn't sign the browser out of Silicon Accounts, because the Carbon may be signed in to ten other apps there. Signing out of Silicon Accounts doesn't end your app's sign-in either, because your app decides how long its users stay signed in. The one link that matters runs one way: when your sign-in ends for a reason you didn't cause, we tell your webhook and you end your own session.

Since the browser session outlives your sign-in, a Carbon who signs out of your app and clicks "Sign in" again is offered "Continue as …" without a code. Send `prompt=login` when signing back in must mean proving it again.

## Access tokens: short and self-contained

An access token is a JWT signed with Ed25519 (`alg: EdDSA`), issued to your app (`aud` is your app id) for 30 minutes. It carries everything an API needs to decide who is calling: the account's uuid (`sub`), its kind, its id when the token was issued, the membership id, the sign-in it belongs to (`fid`) and the granted scopes.

- **Self-contained**, so your API can verify it with the public keys at `/.well-known/jwks.json` without calling us on every request. Keys are named by `kid`. Cache the key set, and fetch it again when a token names a key you don't have.
- **Short**, because a self-contained token can't be called back: once issued, it verifies until `exp`. Thirty minutes caps how long an API that only checks locally can still accept a revoked sign-in. When an action can't wait that long (deleting data, moving money), ask [introspection](../start/tokens.md#check-an-access-token). It knows about revocation right away, and it also refuses tokens whose membership is no longer active.
- **Audience-bound**, so a token minted for one app is useless at another. Your API must check `aud`; the libraries do it when you pass your app id. To act at another app on an account's behalf, apps use [User verification proofs](../start/user-verification.md), never each other's tokens.

## Refresh tokens: rotated, reuse-detected, 900 days at most

A refresh token is opaque (`sar_…`), and we store it only as a keyed hash, so a copy of our database can't be replayed. Three rules shape it:

1. **It rotates.** Each refresh gives you a new refresh token and spends the old one.
2. **Reuse ends the sign-in.** If a spent refresh token comes back, two parties hold the sign-in and we can't tell which one is the thief. So we revoke the whole family, the newest tokens included, and tell your app (`membership.signed_out`, reason `refresh_token_reuse`). A stolen refresh token gets at most one use before the theft shows up, instead of quietly living for years.
3. **900 days, then sign in again.** The limit counts from the moment the account signed in, and refreshing doesn't extend it. A sliding window would let a stolen token live forever as long as someone keeps using it; a fixed one puts an end on every sign-in.

The cost of rule 2 is that you can't refresh one sign-in twice in parallel. Two workers or two tabs refreshing the same token at the same moment look exactly like a thief and the owner: one succeeds, the other trips reuse detection, and the sign-in ends. Refresh through one place per sign-in (one in-process request shared by all callers, or a lock in your session store), and save the new refresh token before you use anything else from the answer.

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

When an account removes your access, we revoke every sign-in your app holds for it (and the User verification proofs your app issued about it), mark the membership `access_removed` in your user base, and stop showing you its contact details. They come back only when the account signs in to your app again, through the what's-shared screen.

The access tokens of an ended sign-in keep verifying locally until their `exp`, at most 30 minutes. Introspection answers `{"active":false}` for them at once, and `/v1/userinfo` refuses them with `token_revoked` and the reason.

## Codes and short-lived tokens: one use, two minutes

Both are bearer credentials that pass through places your server doesn't control (a URL, a Silicon's terminal), so we keep both as narrow as we can:

- An **authorization code** is bound to your app, the redirect URI and the PKCE challenge of its request. It works once and expires after 120 seconds. Its exchange and the tokens it issues happen in one transaction, so of two exchanges at the same moment exactly one wins, and the loser's attempt revokes the winner's tokens (the code had leaked).
- A **short-lived token** (`slt_…`) is how a Silicon signs in to your app. The Silicon's own signed-in session mints it for one app. It works once and expires after 120 seconds. We refuse it if the Silicon's STK was rotated after it was minted (rotation ends every sign-in of the Silicon, tokens already handed out included), or if the account removed your app's access after it was minted.

## The id_token is for your client, not for APIs

With `openid` in the scope, the token response also carries an `id_token`. It's a statement to *your app* about who signed in and when (`auth_time`), with your `nonce` so nobody can replay it into another sign-in. It's for the code that handled the callback. Don't send it to APIs as a credential; the access token is the credential. Refreshes return a new `id_token` without a nonce, and `auth_time` stays the time of the original proof.

## Scopes over time

We remember which details an account has agreed to share with your app, across sign-ins. Asking for fewer details in a later sign-in doesn't take back the earlier agreement. The `scope` in the token response tells you what's granted right now.

A Carbon can shrink that grant by turning off optional details on the what's-shared screen, or by removing your app's access. To show them the what's-shared screen again, ask for more details or use `prompt=consent`. A refresh can ask for less, but it can't add a new grant: new details always go through the what's-shared screen.

## Keep tokens on your server

- **Every app is a confidential client.** Exchanging a code needs your app secret, so the exchange happens on a server you control. That goes for single-page and native apps too: they hand the code (or the code and verifier) to that server.
- **Refresh tokens are long-lived credentials.** Keep them on your server, encrypted at rest, never in `localStorage` or a URL. Give the browser your own session cookie instead.
- **Access tokens may reach the browser** if your pages call your API with them, but every copy is a 30-minute credential for that account at your app.

How we protect things on our side (hashing, encryption, cookie rules, what we never log) is in [Security](security.md).
