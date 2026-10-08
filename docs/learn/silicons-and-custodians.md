---
title: Silicons and custodians
description: Understand why a Silicon has a custodian, how its password is managed and why it uses short-lived tokens to sign into apps.
kind: informative
order: 20
related:
  - start/silicon-account.md
  - start/custodians.md
  - start/silicon-sign-in-to-apps.md
  - learn/ids-and-uuids.md
  - learn/webhooks.md
  - learn/tokens-and-sessions.md
  - learn/security.md
---

# Silicons and custodians

A Silicon has its own account and password, and a Carbon who looks after that account. That Carbon is its custodian. This page explains how that responsibility starts, how it can be transferred and what happens when a password changes.

For the steps, see [Get a Silicon account](../start/silicon-account.md), [Be a Silicon’s custodian](../start/custodians.md) and [Sign a Silicon into an app](../start/silicon-sign-in-to-apps.md).

## A Silicon is a personal account, like a Carbon's

There are no shared or group accounts in Silicon Accounts: every account belongs to one Carbon or
one Silicon. A Silicon's account has the same kind of identity as a Carbon's (a permanent uuid and
a changeable id), signs into the same apps, and those apps receive the same kind of tokens and
webhooks. The differences all follow from one fact: a Silicon has no inbox, no phone and no
browser.

| | Carbon | Silicon |
|---|---|---|
| id | `c:saket` | `si:scout` |
| signs in with | an email or SMS code, Google or Apple | its si:id and STK |
| signs into apps through | the app's sign-in pages | a short-lived token it hands to the app |
| email and phone | up to 10 of each | none |
| date of birth | set by the Carbon | the day the account was created; never changes |
| responsible party | itself | its custodian, a Carbon |
| learns about its own account through | email and the account site | its own webhook |

The only relationship between two accounts is that one: a Silicon's custodian.

## Why every Silicon has a custodian

A custodian makes a Silicon answerable. Apps see a Silicon's custodian in every token response and
userinfo answer and in `account.updated` webhooks, and are told `silicon.custodian_changed` when it
changes, so an app always knows which Carbon stands behind a Silicon that signs in. The custodian
also manages the Silicon's account: its details, its si:id and, above all, its STK.

The STK is why custody is not optional. A Carbon who loses access to their account proves who they
are again through an inbox or a phone. A Silicon that loses its STK has nothing else to prove
itself with, so someone else must be able to issue a new one: its custodian. Without a custodian, a
lost or leaked STK would be the end of the account.

There is always exactly one custodian, never zero and never two. Exactly one keeps responsibility
clear. Never zero is enforced everywhere: a Carbon can't delete their account while they are
custodian of any Silicon (`409 custodian_of_silicons`), and the only way to stop being a custodian
is to delete the Silicon or transfer it to a Carbon who accepts.

## Why the custodian has to accept

A Silicon that creates its own account names its custodian, and anyone can name anyone. Being
custodian means answering for a Silicon, so it can't be imposed: the named Carbon has to accept.
Until then the account exists with the status `pending_custodian`, holding its si:id but unable to
sign in, so nothing can act under a Carbon's name without that Carbon's say.

The same reasoning shapes the details:

- **The request email names the Silicon by its si:id only.** The display name is free text chosen
  by an anonymous caller; putting it in an email sent from Silicon Accounts' own address would let
  anyone send arbitrary words and links in Silicon Accounts' name. An si:id can only contain `a-z`, `0-9`, `-`
  and `_`. The email also says to decline Silicons you don't know.
- **A Carbon can be named by email before they have an account.** A request names a `c:id` or an
  email address. One that names an address is addressed to whichever account has that address
  verified, so someone who signs up later with it finds the request waiting, and an invitation to
  sign up goes to the address.
- **Limits stop requests from becoming spam.** A network can make 10 self-creations per hour
  (counting only successful ones) and 60 attempts per hour (failed ones included, since each costs
  work and answers questions about ids and Carbons). At most 20 self-created Silicons can wait for
  the same custodian, counted separately per `c:id` and per email address. Counting per account
  instead would make the limit answer `429` for an address exactly when it belongs to a busy `c:id`,
  telling an anonymous caller which address belongs to whom.
- **A Silicon has one pending request at a time.** Two open requests could both be accepted, by two
  different Carbons.

A Carbon who creates a Silicon has agreed by doing it, so that Silicon is active at once.

## Why 14 days, and what happens at the end

Fourteen days is long enough for a Carbon to notice an email and decide, and short enough that a
Silicon whose request went unanswered can move on, and that unanswered requests don't hold ids
forever.

Expiry happens exactly on time, not whenever a background job gets to it. A sweep runs every minute,
but every path that reads a request (a sign-in attempt, a status poll, an attempt to accept it)
treats an overdue request as expired at that moment and finishes the job. A Carbon can't accept a
request one second after its 14 days, whatever the sweep is doing.

## Why a declined Silicon is released at once

When the custodian declines, when 14 days pass without an answer, or when the named Carbon deletes
their account first, the Silicon is released: its account is deleted and its si:id is free again
immediately. An account that was active keeps its old id reserved for 10 days instead, because apps
know that id and Carbons and Silicons may still type it. A released Silicon never became active:
no app ever saw it, it never signed in, and nobody can be confused by its id. Holding the id would
only stop the Silicon from trying again, with another custodian, under the same name.

The Silicon learns what happened even though its account is gone: the `silicon.custodian.declined`
or `silicon.custodian.expired` event is created before the release, while the account still has its
id, and the webhook is kept long enough to deliver it. Signing in to a released account says what
happened too (`custodian_declined`, `custodian_expired`) instead of a bare `invalid_credentials`.

## Why the STK works the way it does

The STK is a password, kept as simple as one: a string that fits in an environment variable or a
secret store, with a fixed `stk-` prefix that makes it easy to recognise (and to catch in a secret
scanner). A generated STK is `stk-` plus 12 hex characters, 48 random bits; a Silicon may choose its
own of 8 to 32 hex characters.

**Shown once, stored as a hash.** The service keeps only an Argon2id hash of the STK, so a copy of
the database reveals no STK and guessing one from a hash is slow by design. The plain STK exists
only in the response that created it. For the 10 minutes in which a retried request may replay that
response (with the same `Idempotency-Key`), the stored copy is encrypted, so even that window
reveals nothing to someone reading the database.

**Guessing gets nowhere.** An unknown si:id and a wrong STK get the same answer
(`invalid_credentials`) after the same Argon2id work, so the answer and its timing don't reveal
which ids exist. Ten wrong STKs in a row lock the Silicon's sign-in for 60 seconds, the correct STK
included, so a guesser can't learn that a guess was right by its success during the lock. Attempts
are counted before the STK is checked, so firing many guesses in parallel gets no more than ten
checks. On top of that, a network can make 60 Silicon sign-in attempts per minute. Online guessing
of 48 random bits is hopeless at these rates.

**Rotation ends every sign-in.** If an STK may have leaked, the custodian can rotate it. The old STK stops working immediately. Accounts revokes the Silicon’s sessions and refresh tokens, rejects its previously issued short-lived tokens and sends apps `membership.signed_out` with `reason: stk_rotated`. This prevents someone with an old SLT from starting another session.

An access token can still pass a local signature check until it expires, up to 30 minutes after it was issued. That check cannot see the revocation. An app that needs to stop access immediately must introspect the token or handle the sign-out webhook.

**Only the custodian rotates.** A Silicon can change its own display name, timezone, photo and
si:id, but not its STK, because a Silicon that needs a new STK is either compromised or has lost the
old one, and in neither case can it be trusted to prove who it is.

## Why Silicons sign in with short-lived tokens

A Silicon can't use an app's sign-in page: the methods there (email codes, SMS codes, Google, Apple)
all need an inbox, a phone or a browser. So a Silicon signs in to Silicon Accounts directly with its
STK, and gets apps a short-lived token (SLT) instead:

- **The STK never reaches the app.** The app holds an SLT and then ordinary tokens for its own use.
  A compromised app can't sign in as the Silicon anywhere else.
- **A leaked SLT is worth little.** It works for one app, once, within 120 seconds. Presented by
  another app, it is refused and used up.
- **What the app sees is decided when the SLT is issued.** Its scopes are `profile` plus `timezone`
  and `dob` when the app's sign-in setup asks for them. A Silicon has no email or phone, so an app
  that requires them still lets the Silicon in; it simply never receives them, rather than locking
  Silicons out of every app that wants an email from Carbons.
- **The app needs one grant type, not a second sign-in system.** The exchange is a normal call to
  the token endpoint (`grant_type=urn:silicon:params:oauth:grant-type:slt`), and the answer has the
  same shape as the code exchange for a Carbon: an access token, a refresh token and the account.
- **An SLT carries the authority of the sign-in that issued it.** It is refused if the STK was
  rotated after it was issued, or if the Silicon removed the app's access after it was issued. One
  issued after a removal is a new decision, and restores the access.

## Why a Silicon has its own webhook

A Carbon learns about their account through email and the account site. A Silicon has neither, so
it can register a webhook to learn about its own account: the custodian's answer, changes to its
details and si:id, an STK rotation (its cue to stop and get the new STK), and transfers. It is
separate from app webhooks, which tell an app about the accounts in its user base, but follows the
same delivery rules: signed with HMAC-SHA256, retried for up to 72 hours, deduplicated by
`event_id`. [How webhooks work](webhooks.md) explains those rules.

The first event, `silicon.created`, is sent as soon as the account exists, which is usually before
the Silicon has read the response that holds the webhook secret. A receiver that can't verify it
yet answers with an error, and the delivery is retried 10 seconds later with the same `event_id`.

## Why transfers need the receiver's consent

A transfer moves responsibility, so like the first request it needs the receiving Carbon's
acceptance within 14 days, and until then nothing changes. A Silicon has at most one pending
transfer, so two Carbons can't both end up accepting it. A transfer changes who is responsible, not
the Silicon's credentials: its sessions, STK, uuid and si:id stay as they were, and the new
custodian rotates the STK if the Silicon should start fresh. Every change of custodian is kept in
the Silicon's history (who it moved from, who to, and when), including the first one: created by a
Carbon, or accepted after a Silicon's own request.

## The lifecycle

```text
 Silicon's own request                                   created by a Carbon
 POST /v1/silicons                                       POST /v1/me/silicons
        │                                                        │
        ▼                                                        │
 pending_custodian ── custodian accepts ──────────────▶ active ◀┘
        │                                                │
        │ declined, 14 days pass, or                     │ its custodian deletes it
        │ the named Carbon deletes their account         ▼
        ▼                                             deleted (si:id reserved 10 days)
 deleted (released: si:id free at once)
```

`active` is the only status that can sign in. A deleted account's uuid is never reused.

## Related

- [Ids and uuids](ids-and-uuids.md): why apps store the uuid, and how id changes and reservations
  work.
- [Tokens and sessions](tokens-and-sessions.md): refresh rotation, token families and how a sign-in
  ends.
- [Security](security.md): how secrets are stored and what is never logged.
