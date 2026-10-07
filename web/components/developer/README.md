# web-developer: the developer pages

Where a Carbon sets up how their apps sign Carbons and Silicons in. Routes are in `app/(shell)/(developer)/`,
everything else is here. Read `web/README.md` first (conventions, hooks, squircles, branding runtime); the product
contract is `understanding/UNDERSTANDING.md`.

| Route | Component | What it does |
| --- | --- | --- |
| `/developer` | `home/developer-home.tsx` | The Carbon's apps as tiles, and "New app", which opens Silicon Apps (`silicon_apps_url` from `/v1/meta`). |
| `/developer/[appId]` (layout) | `app/app-scope.tsx` | Loads the app, owns the sign-in setup editor, the tab frame and the tab itself, and stays mounted while tabs change, so drafts survive tab switches and Back/Forward. A missing app (404) or someone else's (403) says so. |
| `/developer/[appId]/[[...tab]]` | `app/titles.ts` | Renders nothing: names the tab in the document title on a load, and redirects an unknown tab to the overview. |

## Inside

- **Tabs switch in the browser** (`app/app-scope.tsx`, `app/tab-page.tsx`). The tab shown is the one the address
  names; a switch only pushes the new address (`history.pushState`, which Next's router follows), so it is instant,
  never asks the server and can't fail on a lost connection. Back and Forward move between tabs the same way, and the
  document title follows (`app/titles.ts`). Each tab is its own chunk: the first shows a skeleton, the others load in
  the background once the app is on screen, and a tab that fails to load or draw says so in its panel with Try again
  (the header, the tabs and the draft stay).
- `lib/editor.ts`: the sign-in setup editor shared by the Sign-in and Branding tabs (an external store read with
  `useEditor`). Each tab saves only its own settings with `expected_version` and one Idempotency-Key per change set. A
  409, or a newer version read while editing, is compared leaf by leaf with the draft: changes that do not overlap are
  rebased (and saved, when Save asked) with a notice naming what changed underneath; overlapping ones wait for "Save
  mine on top" or "Discard mine, load theirs". 422 field errors land next to their fields. Text typed into a list field
  and not added yet (`typed`) is part of the draft: it counts as unsaved, survives tab switches, and a save first adds it
  (or waits, naming it, when the field refuses it). Drafts with changes are kept per app in this browser tab when the
  page unmounts, and while any draft has unsaved changes a reload or close of the browser tab asks first.
- The leave guard (`app/app-scope.tsx`): while a draft has unsaved changes the layout registers a navigation guard
  (`useNavigationGuard`, the foundation's `lib/navigation-guard.ts`), and the shell asks it before every way out of the
  app: a link on the page, the dock and its phone sheet (which closes itself first), the brand, the command palette, a
  section's number key, the user menu's Settings and signing out. The question offers keep editing, leave with the
  draft, or discard (signing out offers discard only: drafts do not survive it). "Keep editing" puts focus back on the
  link, the key's control or the sheet's button. Navigations nothing can ask about (Back, a typed address) keep the
  draft, and the next page shows a notice with Return (`lib/kept-drafts.ts`) until the Carbon goes back.
- Focus that would fall to the start of the page (`parts/focus-return.ts`): Save and Discard leave the save bar, a
  conflict's choices leave with the conflict, a revoke takes its row's Revoke away. Focus then goes back to the last
  place the Carbon worked in (or to the revoked proof's status), not to `<body>`.
- `lib/config.ts`, `lib/validate.ts`: the editable config, what each tab owns, the wire patch, and the server's
  validation rules in the browser (redirect URIs, origins, domains, Apple and Google credentials, texts, the 4.5:1
  contrast rule, app ids and scopes, webhook URLs). `lib/labels.ts`: every status, method and outcome in words.
- `lib/queries.ts`: lists that keep the previous page while filters change, and the import job poller (stops on a
  final status or a non-retryable error, backs off on others). `lib/importfile.ts`: reading CSV and JSON in the
  browser, with the column check.
- `parts/`: the save bar (⌘S, Review during a conflict), editor alerts, version history with "Undo in draft", tag
  fields, secret fields and the one-time secret reveal, copy fields, app icons. The tag field decides when typed text
  joins its list, not Arc's TagInput: Enter, leaving the field, and a comma only in lists whose values never hold one
  (domains, app ids); values are compared exactly after normalizing (a redirect URI's path and a scope are
  case-sensitive), and a refused value keeps its text and says why.
- `tabs/hosted-preview.tsx`: the live preview of the hosted card for every step, light or dark, desktop or phone, built
  on the branding runtime. In the split layout it follows the hosted page: the copy beside the form comes from
  `heroCopy` (components/auth/flow/model.ts, for a first visit), a short "Sign in" heads the form, and "Powered by"
  sits in the form's half. The Embed tab's preview is the real SDK, loaded again for every stored version; its
  "Open the hosted page" waits for a registered redirect URI.

## Screens and checks

```
pnpm screens --only developer-                    every page and state, mock API
SCREENS_ERRORS=1 pnpm screens --only developer-signin-conflict --allow-errors
LIVE_APP_ORIGIN=http://127.0.0.1:8593 pnpm exec tsx components/developer/checks.ts --live http://localhost:8590
```

The live checks (15) sign in as the owner of `briefcase` through the site's own sign-in (codes from the dev outbox,
which `scripts/dev.sh` turns on) and drive every tab against the real API: tab switches that never ask the server,
saves, conflicts and rebases, typed list text and ⌘S, the leave guard (a link, a number key, the phone dock's sheet,
the kept draft's notice and the reload question), focus after Save, Discard, a conflict's choice and a revoke,
history, branding and the embed preview after a save, an import from dry run to "Import for real", the user base,
webhook retries and replays (the testkit's fake app server answers the webhooks, fails on request and learns a
rotated secret) and ATA proofs. They change that app's setup and data: run them against a scratch database.
`LIVE_APP_ORIGIN` is the fake apps' origin (dev.sh on other ports moves it, for example `http://127.0.0.1:8743`).
