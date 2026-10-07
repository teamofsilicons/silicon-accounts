# web-auth: the hosted sign-in pages

The pages a Carbon sees while signing into an app, the account site's own sign-in, CLI device approval and the embed
page. Routes are in `app/(auth)/`, everything else is here. Read `web/README.md` first (topology, conventions, hooks,
branding runtime); the product contract is `understanding/UNDERSTANDING.md`.

| Route | Component | What it does |
| --- | --- | --- |
| `/authorize` | `authorize.tsx` | Creates the flow from the app's query (`POST /v1/flows`, with the browser's time zone) and hands it to the flow page through the query cache. `intent=signin\|signup` and `method=` pass through; `login_hint` (and any email or phone) is dropped: an app never hands us a Carbon's email or phone. A link that cannot start shows why in plain words and never redirects (the server's reason and fix are in the details for the app's developers); mistakes the server may report to the app offer "Back to the app", the rest "Go to your account". |
| `/authorize/flow/[id]` | `flow-page.tsx` | One sign-in, driven by `FlowView.step`: the Opening page (`method=google\|apple`), `choose_method` (Continue as / Use another account, Google and Apple, email or phone; the sign-in or sign-up version by `intent`), `verify_code`, `signup`, `details` (each page of the app's flow), `review`, `complete`, `failed`. Google and Apple come back here. |
| `/sign-in` | `sign-in.tsx` | Both ends of the account site's own sign-in (first-party app `accounts`, redirect `{origin}/sign-in`): starts it with `return_to` remembered against the state, and finishes it (`?code&state`, or `?error&state` with a way to try again). A code or error counts only when this browser saved its state; the page never shows the address's `error` or `error_description` (fixed words per error code), so nobody can put their own text on it with a link. |
| `/device` | `device.tsx` | Approving a CLI sign-in: enter (or arrive with) the code, review it (the whole client label, who approves, when it expires), approve or deny, and every status after; a code that runs out while the page is open turns into "This code expired" by the clock. Signed out, it signs in and comes back with the code. |
| `/embed/v1/buttons` | `embed/embed-buttons.tsx` | The buttons apps frame: a button per method ("Continue with Google", "Continue with email", "Continue with phone number"…, `method=` keeps one), or with `buttons=intents` "Sign in" and "Sign up" (`intent=` keeps one), each opening our pages (`intent=signup` the sign-up version). No email or phone is ever passed on. The page declares the frame's color scheme from `theme` on the first byte. A config read the browser cut off is tried twice more (after 0.5 s and 1.5 s) before a problem is reported: Safari cancels a frame's requests when the page around it starts leaving, before the answer (`network_error`) or after its 200 headers while the body is still on its way (`http_200`). |

## Inside

- `flow/controller.ts`: the flow's state (`useFlowController`): the FlowView in the query cache, fatal failures, the
  notice kept when the server moved the flow, and every action. Failures come back to the step that asked.
- `flow/model.ts`: browser memory (the /authorize query for "Start again", "already redirected", the once-per-flow
  provider jump, the app's look), safe redirects, and the split layout's hero copy, which follows the step: the app's
  own title on the sign-in steps, "Welcome to {app}" for a first visit, never a "welcome back" to a new account.
- `flow/errors.ts`: every error in the Carbon's words (API instructions, internal ids and exact UTC instants stay out,
  with the words that introduced them: "expired at 2026-…Z: a verified…" reads "expired. A verified…"), with the
  one-click fix where there is one ("Sign in again").
- `flow/hosted-frame.tsx`: the page around a step: the app's branding on its own subtree, card, split or minimal, logo
  and name, and "Powered by Silicon Accounts" outside the branded subtree (in the split layout, in the form's column).
- `flow/morph.tsx`: the card morph between steps (Arc's sign-in block motion); the leaving step is inert.
- `flow/parts.tsx`: headings, field notes, alerts, rows, provider buttons, the code entry (submits on the sixth digit,
  shakes, tries left, a live lockout, expiry, resend), and the email/phone form. The account and destination rows never
  cut a name, c:id or address short: the action moves under the text when it needs the room, and an address breaks after
  "@" or before a ".". "Resend code in 0:27" is named by exactly those words (a visually hidden copy; the rolling digits
  are aria-hidden) and shows keyboard focus while it waits.
- Phone numbers go through the foundation's `components/foundation/phone-field` (PhoneField + phone-data, moved there
  from this area so the account site's "Add a phone number" takes any country too): Arc's picker knows 49 countries; a
  number it would rewrite moves to a field for the number with its country code and is sent exactly as typed.
- `flow/id-field.tsx`, `id-check.ts`: the c:id with live availability and free ids. `flow/dob-field.tsx`: Arc's date
  picker look with a year grid behind the month title.
- The sign-up timezone is Arc's Combobox as is: the list opens on typing, ArrowDown or a click rather than on focus,
  closes when focus moves on, and is no Tab stop (fixed in Arc itself; the former `flow/combobox-field.tsx` wrapper is
  gone).
- `flow/legible.ts`: error text stays at 4.5:1 in every app's colours: a `danger` below that on the card or page moves
  toward the text colour. Every other colour stays as the app chose it. (The default dark danger is #FF8A80 now, 5.45:1
  on #353432; migration 0004 moved stored configs off the old #F97066.)
- Keyboard focus shows on everything (Arc draws no rings). Arc's Switch, SegmentedControl and DatePicker trigger and
  the foundation's "Powered by" pill show it themselves now; the hosted pages add the rest (the consent switches' rows,
  the footer links, the date of birth trigger's refused state).
- `steps/*`: one file per step. `mocks/flows.ts`: sample FlowViews for every step (and `scenarioAfter`, how the mock walks a
  multi-page flow).

## The v2 pages (UNDERSTANDING.md "What's shared with the app", "Flows", "Adding sign-in to an app")

- **Intents.** `FlowView.intent` (`signin` default, `signup`) picks the sign-in or the sign-up version of the methods page:
  "Sign in to Briefcase" / "Create your Briefcase account" (the app's `copy.title` / `copy.signup_title`, with
  `copy.subtitle` / `copy.signup_subtitle`), "Other ways to sign in/up", the split layout's "Sign in"/"Sign up" label.
  The account logic does not change: a first visit is a sign-up either way.
- **Direct buttons** (`FlowView.method_hint`). `email`/`phone` open on that method's empty field (nothing is ever
  prefilled; there is no login_hint), with "Other ways to sign in". `google`/`apple` first show the **Opening page**
  (`steps/opening.tsx`): "Opening Google to sign you in to Briefcase…" (or `copy.opening_title` with `{provider}` and
  `{app}`), in the app's look with "Powered by Silicon Accounts", then the browser moves on by itself after 900 ms
  (`OPENING_DELAY_MS`). "Continue to Google" is always there as the fallback, "Other ways to sign in" leaves for the
  methods. The move happens once per flow in this tab (`claimAutoStart`): back from Google (back button, or a reload)
  the page is paused with its button. Reduced motion: no pulse and no filling bar, same behaviour. A flow that comes
  back with an error (a cancelled Google sign-in) shows the methods page with the error instead.
- **Details** (`steps/details.tsx`, `FlowView.details`): one page of the app's flow, with the step's own title,
  subtitle, continue label and layout (`HostedFrame`'s `layout` overrides the branding's for that page), "Step 1 of 2"
  when the sign-in shows several pages. Required details are locked ("Required"); a required email or phone the
  account lacks is added right there (`details/add` → the code → `details/verify`), and Continue says what is still
  missing instead of asking the server. Optional details are checkboxes, unticked until the Carbon ticks them (the
  server's `shared` starts them: ticked when shared before, or when the Carbon just added that email or phone on the
  page). The first page shows the account (with "Switch account") and the profile every app sees. Continue sends the
  ticked optional details of the page (`details/continue {share}`), Back returns with the choices kept
  (`details/back`), Cancel ends the sign-in (`review {approve:false}`, the app gets error=access_denied). Without a flow
  of its own an app gets one page: the what's-shared screen ("Share and continue").
- **Review** (`steps/review.tsx`, `FlowView.review`): everything the app will see, profile first; "Share and
  continue" (`review {approve:true}`), Back, Cancel.
- Every page, the Opening page and the details and review pages included, keeps "Powered by Silicon Accounts" linking
  to https://accounts.teamofsilicons.com (HostedFrame renders it outside the branded subtree).

The sign-up photo uploads to the sign-up itself as soon as it is picked (`POST /v1/flows/{id}/signup/photo`); the
account takes it when it is created. Finishing an imported account names the app that imported it
(`signup.imported_by`), which may be another app than the one being signed into ("Legacy CRM added you to Silicon
Accounts. Check the details it gave us, then continue to Briefcase."), and names no app when the server does not say. "Not you?" calls `POST /v1/flows/{id}/switch`, which ends that sign-up in this
browser (the server clears its cookie).

The hosted content renders after hydration: the flow is read in the browser (its cookies prove it is this browser's)
and the visitor's theme is known only there. Before that the server sends a quiet loading card in the site's look.

## Screens and checks

`test/*.test.ts` are unit tests of the pure helpers (error lines, which page a flow is on), no stack needed:
`pnpm exec tsx --test components/auth/test/*.test.ts`.

`checks.ts` (the Playwright checks below) is paused: it was written for the v1 steps (requirements, consent) and is
out of date with v2, so tsconfig.json and eslint skip it until it is rewritten. The screens are current.

```
pnpm screens --only auth-,device-                   every step for 4 brandings, interactions, device states
SCREENS_ERRORS=1 pnpm screens --only auth-problem,auth-default-verify-wrong --allow-errors
pnpm exec tsx components/auth/checks.ts --base http://localhost:8590            58 checks, mock API
pnpm exec tsx components/auth/checks.ts --base http://localhost:8590 --engine webkit
LIVE_OIDC_URL=http://127.0.0.1:8591 LIVE_APP_ORIGIN=http://127.0.0.1:8593 LIVE_PSQL="psql -h 127.0.0.1 -p 5444 -U postgres -d silicon_accounts" \
  pnpm exec tsx components/auth/checks.ts --live http://localhost:8590              25 checks end to end
```

Keyboard checks walk with Tab in Chromium and Option+Tab in WebKit (like Safari on macOS, WebKit's plain Tab skips
buttons and links).

The mock checks need any running site (`--base`); the browser's API calls are answered by `scripts/mock` with
`mocks/flows.ts`. The embed checks cut the config's body off after its 200 (and, with a local server that holds the
body back, let the page around the frame leave meanwhile: Safari's race, failing on the code before the fix in WebKit),
and the Resend check runs axe-core's label-content-name-mismatch. The live checks need the site, accounts-api with the dev outbox (`scripts/dev.sh` sets it) and the
testkit's mock Google/Apple; `LIVE_APP_ORIGIN` is the fake apps' registered origin (dev.sh on other ports rewrites it,
for example `http://127.0.0.1:8703`). Apps' own pages (callbacks, pages that frame the buttons or load the SDK) are
answered inside the browser on that origin. `CHECKS_SHOTS=<dir>` keeps screenshots of failed checks.
