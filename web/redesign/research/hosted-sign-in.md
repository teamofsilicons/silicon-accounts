# Hosted sign-in: how others design these screens (research, 2026-11-19)

Anil, on /__signin D's consent: "not good enough… what's an app that has all these similar screens? i want to understand
from their designs what we're missing". This is what Google, Apple, Microsoft, GitHub, Discord, Slack, Shop, Clerk,
Auth0 and Supabase do on the five screens we have, and what recurs that we don't.

How claims were checked: **seen** = I looked at the live public page (signed out, nothing submitted); **[V]** = read on
the official page; **[2]** = second-hand; **[M]** = from product knowledge, not confirmed on a page here (check before
quoting). The full source list with links is in the agent's notes:
`~/Library/Application Support/Claude/side-session-notes/local_84d3e7df-…/auth-screens-research.md`.

Pictures are in `images/`: screens I captured on the live public pages (signed out), and official screenshots from each
company's own docs where the screen needs a signed-in account. Each has its source under it. The images are other
companies' screens, so they are kept out of this public repository (`images/` is ignored): they are on Anil's machine
only, and every one names its source page, where it can be seen again.

## The one big difference

Every account provider puts **itself first and the app second**:

- Google (seen): a thin "Sign in with Google" bar, then "Sign in" and "to continue to *Google OAuth 2.0 Playground*" (the
  app name is a link), one field, and "Before using this app, you can review *app*'s Privacy Policy and Terms".
- GitHub (seen): GitHub's mark, "Sign in to GitHub", "to continue to GitHub CLI".
- Microsoft (seen): Microsoft's mark, "Sign in", one field, Next.
- Supabase's written pattern (seen, "Connect interstitials"): a **logo pair** (requester ⇄ Supabase); "The interstitial
  should confirm they are connecting to Supabase", the requester named in the title and description.

| Google | GitHub | Microsoft |
|---|---|---|
| ![Google: Sign in with Google, to continue to the app](images/google-signin-continue-to.png) | ![GitHub: Sign in to GitHub, to continue to GitHub CLI](images/github-signin-continue-to.png) | ![Microsoft: Sign in](images/microsoft-signin.png) |
| Captured live, accounts.google.com | Captured live, github.com/login | Captured live, login.microsoftonline.com |

/__signin D does the opposite: the app as the page's first section, Team of Silicons as a smaller heading under it, and
"Powered by Silicon Accounts" as a pill outside the card. Auth vendors that sign in *to an app* (Clerk, seen: "Sign in to
Acme Co" … "Secured by Clerk" in the card's foot band) lead with the app, but they are invisible infrastructure; we are an
account people own, more like Google or GitHub.

## Screen by screen

### 1. Choosing how to sign in
- Provider identity first, app second ("to continue to …") — Google, GitHub, Microsoft (seen).
- The app's privacy policy and terms named on the first screen — Google (seen).
- One field and one button per page; the next step asks the next thing — Google, Microsoft (seen). Clerk keeps one
  card with Google, "or", email, Continue, and "Use passkey instead" (seen).
- One title that stays the same across states; errors and blocking states inside the card, not toasts — Supabase (seen).
- Don't invent a letter tile for an app without a logo; show your own mark alone — Supabase (seen).

| Clerk | Supabase "Connect interstitial" |
|---|---|
| ![Clerk sign-in: Sign in to Acme Co, Secured by Clerk](images/clerk-signin.png) | ![Supabase: logo pair, Authorize Stripe Projects, Signed in as](images/supabase-connect-interstitial.png) |
| Captured live, clerk.com/components/sign-in | Captured live, supabase.com/design-system/docs/ui-patterns/connect-interstitials |

### 2. Continue as (signed in already)
- The account row always carries "Not you?" / sign out beside it — Supabase (seen: account row with a sign-out button),
  OAuth.com ([V]: the user must know "which account they are currently signed in as").
- Google returns a returning user straight to the app once chosen, no extra screen ([V]).

| Google: confirm before an account is made | Google One Tap (browser-shown, FedCM) | Google: a returning user is welcomed |
|---|---|---|
| ![Confirm you want to sign in to MyApp as Camille](images/google-account-chooser-dialog.png) | ![One Tap prompt](images/google-one-tap-fedcm.png) | ![Warm welcome](images/google-warm-welcome.png) |
| [Google for Developers](https://developers.google.com/identity/gsi/web/guides/features) | same page | same page |

Google's first-time confirmation says exactly what is shared: "To create your account, Google will share your name, email
address, and profile picture with *app*", with the app's privacy policy and terms; Cancel / Confirm.

### 3. Choose an account
- "Choose an account / to continue to *app*", each account with photo, name, email; "Use another account"; per-account
  Remove/Forget — Google [M], Microsoft (⋯ › Forget, [2]).
- An org that blocks the app is not a dead end: Microsoft lets the user **send a request to the admin** from the prompt
  [V]; GitHub shows each org's effect on the authorize page and offers **Request approval from owners** [V].
- Slack and Discord pick the workspace/server **on the authorize screen itself** (a dropdown) [V].

| Auth0: consent with the org named | GitHub: an app acting for you |
|---|---|
| ![Auth0: Authorize App, logo pair, requesting access to your Acme account](images/auth0-org-consent.png) | ![GitHub: an app acting on your behalf](images/github-acting-on-your-behalf.png) |
| [Auth0 Docs](https://auth0.com/docs/get-started/applications/confidential-and-public-applications/user-consent-and-third-party-applications) | [GitHub Docs](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps) |

Auth0's org consent pairs the app's and the org's marks, greets the person ("Hi user@email.com"), and names the account the
access is for ("…requesting access to your Acme account").

### 4. Share your details (consent)
- Microsoft's documented anatomy [V]: the user → "Permissions requested" → app logo and name → **publisher with a
  verified badge, or "Unverified"** → the permission list, each line expandable → a link to review/remove access later →
  "Report it here". Microsoft says outright that the app's name and logo are not validated.
- Google [V]: name, email and photo are always shared and can't be deselected; data beyond that is a **separate page**
  with one checkbox per item, and no checkbox when only one extra is asked; the app's Privacy Policy and Terms at the
  foot; "you can always see or remove access in your Google Account" [M].
- Apple [V]: the person can **edit the name** and choose **which email**, or **Hide My Email** (a relay per developer).
- GitHub [V]: plain read/write words ("look at", "change"); on a second ask, **only what's new**; the effect on each org.
- OAuth.com's required list [V]: provider brand, signed-in user, app name/logo/**website**, human-readable scopes,
  **how long access lasts** ("until you revoke"), Allow/Deny.
- Optional data opt-in, off by default (academic study, [2]) — we already do this.

| Google: sign-in data locked on, extras chosen | Google: two extras, one box each | Microsoft: anatomy, numbered by Microsoft |
|---|---|---|
| ![Google granular consent with locked identity items](images/google-granular-identity-and-data.png) | ![Google granular consent, Select all](images/google-granular-two-extras.png) | ![Microsoft Permissions requested, numbered](images/microsoft-consent_prompt.png) |
| [Google for Developers](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions) | same page | [Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience) |

| Microsoft: unverified publisher | Microsoft: admin can consent for the org | GitHub: authorize an app |
|---|---|---|
| ![Microsoft consent, variant](images/microsoft-consent_prompt_1a.png) | ![Microsoft consent with org checkbox](images/microsoft-consent_prompt_3a.png) | ![GitHub Authorize Octo App](images/github-authorize-app.png) |
| [Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience) | same page | [GitHub Docs](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps) |

| Apple: Sign in with Apple sheet | Auth0: consent | Slack: required and optional |
|---|---|---|
| ![Apple sheet: Name, Share My Email, Hide My Email](images/apple-sign-in-sheet.png) | ![Auth0 consent dialog](images/auth0-consent.png) | ![Slack: Required, Optional with Allow boxes](images/slack-optional-scopes.png) |
| [Apple Support](https://support.apple.com/en-us/102609) | [Auth0 Docs](https://auth0.com/docs/get-started/applications/confidential-and-public-applications/user-consent-and-third-party-applications) | [Slack Platform blog](https://slack.dev/introducing-optional-scopes-for-slack-apps/) |

What the pictures confirm (the [M] items above, now seen):
- Google: "*Example App* wants access to your Google Account", the account under it, "Select what *Example App* can
  access", "Select all", each item a line with Learn more and a box; "Make sure you trust *Example App*… You can always see
  or remove access in your Google Account"; "See *Example App*'s Privacy Policy and Terms of Service"; Cancel / Continue.
  With identity and data together: "Because you're using Sign in with Google, *app* will be able to" over the identity
  items, ticked and greyed.
- GitHub: what the app can do as icon rows ("Verify your GitHub identity", "Act on your behalf"), "Resources on your
  account" each with (read)/(write) and one plain line, Cancel / **Authorize Octo App**, "Authorizing will redirect to
  https://…", and a footer strip: "Not owned or operated by GitHub", "Created 3 years ago", "Fewer than 10 GitHub users".
- Apple: the app's icon and "Create an account for Headspace using your Apple Account (…)", Name (editable, with a
  clear button), Share My Email / Hide My Email as two radio rows with the relay address shown, one Continue.
- Slack: "The app requests permission…", a **Required** table, an **Optional** table with an Allow box each (and Allow
  all), Cancel / Approve.

Not found: a current Discord authorize screenshot (Discord's docs don't publish one); its description above stays [M].

### 5. An app's page in the account
- Google [V]: apps filtered by kind of link (Sign in with Google / linked account / access / AI agents); each opens
  details with the access and one matching action ("Stop using Sign in with Google", "Remove access"), **each saying what
  it will not do** ("doesn't delete your data in the app"), with "Report this app".
- Apple [V]: shows "the information that you originally shared"; the action is now **Delete**; removing one app removes
  all apps from the same developer.
- GitHub [V]: Revoke per app and Revoke all; per org, Request access.

| Apple: an app's page |
|---|
| ![Apple: KAYAK, Created April 1, Apple Account, Hide My Email, Delete](images/apple-delete.png) |
| [Apple Support](https://support.apple.com/en-us/102571) |

Apple's page for one app: its icon, name and "Created April 1"; which Apple Account and which email (the relay address);
one sentence of what was shared ("…shared your name and a Hide My Email address"); a red **Delete**; and "Your use of
this account is subject to the developer's privacy policy".

## What we're missing (mapped to our screens)

| # | Pattern | Who does it | Our screen |
|---|---|---|---|
| 1 | The provider first, the app as "to continue to …" (or a logo pair) | Google, GitHub, Microsoft, Supabase | 1–4 |
| 2 | The app's real domain or website shown, not only its self-chosen name | Google FedCM ("example.com"), OAuth.com, GitHub redirect [M] | 1, 4 |
| 3 | Who made the app, with a verified mark (or "Unverified") | Microsoft, Google, GitHub | 4 (needs the API: we have App verification, not a publisher badge) |
| 4 | The app's privacy policy and terms on the first screen, not only in small print | Google | 1, 4 |
| 5 | "You can remove its access any time in *Connected Apps*" with the link | Google, Microsoft, OAuth.com | 4 → 5 |
| 6 | "Not you?" beside the signed-in account on every screen | Supabase, Google, OAuth.com | 2, 4 |
| 7 | Choose an account: Use another account, Remove/Forget per account | Google, Microsoft, Clerk | 3 |
| 8 | Blocked by an org: "Ask your admin / Request access", not just a red line | Microsoft, GitHub | 3 (needs the API) |
| 9 | Consent: always-shared tier stated once, extras as their own choices; on a second ask only what's new | Google, GitHub | 4 (we have `previously_granted`) |
| 10 | Edit or choose which value to share (which email; Apple's relay) | Apple | 4 (needs the API) |
| 11 | "Report this app" | Microsoft, Google | 4, 5 (needs a destination) |
| 12 | Removing access says what it does and doesn't do | Google, Apple | 5 |
| 13 | Filter the access page by kind (signed in, acting for you, Silicons) | Google | 5 |
| 14 | One shell and one title for every state; problems inside the card | Supabase | all |

Items 3, 8, 10 and 11 need something the API doesn't have today (api-gaps.md); the rest are design and words.
