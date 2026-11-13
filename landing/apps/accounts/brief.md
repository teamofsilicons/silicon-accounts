# Silicon Accounts — landing brief

**Status:** confirmed by Anil, R1 closed 2026-10-18
**Page:** `accounts.teamofsilicons.com` (signed out)
**Sources:** `understanding/UNDERSTANDING.md` (cited below as § section) and Anil's R1
answers (dated). The current landing page was not consulted.

## The app in one sentence
Silicon Accounts is the account system for every Carbon and Silicon, and the
authentication layer for any app that wants one. _(§ intro)_

Carbons are humans and Silicons are AI agents. _(§ Glossary)_

## Who arrives

| Audience | Arrives wanting | Must come away believing | Source |
| --- | --- | --- | --- |
| **Carbon** (a person) | To sign into a Silicon app, or to manage the account they already use | One personal account goes into every app; they control what each app gets and can take access back | § intro, § What's shared with the app, § accounts.teamofsilicons.com |
| **Silicon** (an AI agent) | An identity of its own, to sign into apps | It can create its own account (with a Carbon as custodian) and sign in through the CLI with its si:id and STK, without a browser | § Silicon account, § Signing in › Silicons, § Rust Package & CLI |
| **Custodian** (a Carbon responsible for Silicons) | To create and look after their Silicons | They create a Silicon, rotate its STK, and transfer it; every Silicon always has exactly one accountable Carbon | § Custodian, § accounts.teamofsilicons.com |
| **Developer** | Sign-in for their app | It's quick to turn on and can be configured in depth, and they own the look of every page. Setup lives on developers.teamofsilicons.com | § intro ("simple as Supabase, deep as WorkOS or Okta"), § Making the pages your own, § Adding sign-in |

## Actions
- **Primary:** a Carbon creates their personal account. _(Anil, 2026-10-18)_
- **Secondary:** a Silicon path and a developer path, each further down the page.
  _(Anil, 2026-10-18)_ The developer path is a short handoff to
  developers.teamofsilicons.com, not a pitch. _(Anil, 2026-10-18)_

## What we can actually show

| Proof | What it supports | Source |
| --- | --- | --- |
| Sign in with email code, phone code, Google, Apple | Easy for Carbons | § Signing in › Carbons |
| The "what's shared" screen: required vs. optional details, optional ones unticked until the Carbon ticks them | Carbons control what apps get | § What's shared with the app |
| See every app you've signed into and remove its access; see and revoke User verification proofs | Control after the fact | § accounts.teamofsilicons.com |
| Up to 10 emails and 10 phones on one account, any of them can sign in | One account, many ways in | § Carbon account |
| `c:id` / `si:id` you can change, old id reserved for 10 days; uuid never changes | Your identity is stable and yours | § Identifiers |
| Silicon creates its own account and names a custodian, who has 2 weeks to accept; or a Carbon creates one | Silicons are first-class, but accountable | § Silicon account |
| STK shown once and only its hash stored; the custodian can rotate it | Safe credentials for agents | § Silicon account |
| `silicon-accounts login`, `login status --json` | Silicons work from the CLI | § Rust Package & CLI |
| Apps add sign-in by hosted pages, an iframe, or a snippet | Developer ease | § Adding sign-in to an app |
| Every sign-in page styled as the app's own; "Powered by Silicon Accounts" always stays | Developer control, plus our trust mark | § Making the pages your own |
| An app never takes a Carbon's email or phone itself; the Carbon always types it on our pages | Safety for Carbons | § Adding sign-in to an app |
| Signed, retried, replayable webhooks for every account change | Developer depth | § Webhooks |

## What we can't claim (yet)
- Any outside proof. The product is the proof. _(Anil, 2026-10-18)_
- Customer names, user counts, uptime or any benchmark: there's no source.
- That Silicon Apps exists. It isn't built yet. _(§ Apps › Until Silicon Apps exists)_
- Custom domains for sign-in. That's a manual request, not a feature. _(§ Requesting account verification)_

## Vocabulary
- **Carbon / Silicon:** central to the product. A first-time visitor probably needs one gloss.
- **Custodian:** needed in the Silicon story; gloss it where it first appears.
- **c:id / si:id:** visible to users. Showing one (`c:saket`) probably beats explaining it.
- **uuid, STK, membership id:** likely too deep for the page unless a Silicon section needs STK.

## Open questions for Anil
1. ~~Who is the page for first?~~ **Answered 2026-10-18:** Carbons. The primary action
   is creating a personal account.
2. ~~Do Silicons get their own path?~~ **Answered 2026-10-18:** yes, on this page,
   further down. So do developers, and theirs is a short handoff to
   developers.teamofsilicons.com, not a pitch.
3. ~~Most common way in?~~ **Answered 2026-10-18:** directly, by typed URL or a link
   from another Silicon site. So most visitors already know the Silicon name and come
   looking for Accounts; they aren't arriving mid-sign-in from a third-party app.
4. ~~Outside proof?~~ **Answered 2026-10-18:** none yet. The page proves itself with
   the product: real screens, flows and commands (the table above).
