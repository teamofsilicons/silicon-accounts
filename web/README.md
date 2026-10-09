# Silicon Accounts: the account site

The public site of Silicon Accounts (accounts.teamofsilicons.com): the account pages Carbons and Silicons use, the
hosted sign-in pages apps send people to, the embeddable sign-in buttons and the SDK script. Documentation for
Silicon Accounts and Silicon Apps is shared at `https://developers.teamofsilicons.com/docs`.

Building apps is not done here. Everything about an app's sign-in (its methods, Google and Apple, details and flows,
page styling, redirect URLs, user base and imports, webhooks, App verification proofs, embed snippets) lives on the developer site,
developers.teamofsilicons.com (`developer/` in this repository, its own Next.js app). This site only links there: the
dock's Developer item, the landing page's footer and the apps page lead to `developer_url` from `GET /v1/meta`, and
`/developer[/*]` redirects there (see Topology).

> **The areas' Playwright checks are paused, out of date with v2.** `components/*/checks.ts` were written for the v1
> hosted steps (requirements, consent), login hints and the developer pages that moved to the developer site;
> tsconfig.json and eslint skip them (one line each) until they are rewritten. The end-to-end walk (`e2e/`) is current
> with v2 and type-checked and linted with the rest of the site; `pnpm screens` is current.

Next.js 16 (App Router, Turbopack) with React 19 and TypeScript in strict mode, pnpm, Arc UI installed with the shadcn
CLI, TanStack Query for data. The product contract is `understanding/UNDERSTANDING.md`; nothing here overrides it.

```
pnpm install
pnpm dev            # http://localhost:8590 (builds the SDK first; PORT=… to change)
pnpm typecheck      # next typegen + tsc --noEmit
pnpm lint           # eslint, zero warnings
pnpm build          # builds the SDK, then next build (output: standalone)
pnpm test:redirects # docs redirects, proxy matchers and configured navigation
pnpm start          # the production build on $PORT (8590)
pnpm screens        # Playwright screenshots into .screens/ (see "Screens")
```

Node 24 or newer. Read the bundled Next docs in `node_modules/next/dist/docs/` before relying on memory: this Next has
breaking changes (`proxy.ts` instead of `middleware.ts`, async `params`/`searchParams`, `PageProps<"/route">` from
`next typegen`, Turbopack by default).

## Topology

The account site uses `silicon-accounts` as its first-party app ID. Existing browser cookies and saved return paths remain valid through the rename.

Next serves the whole public origin and proxies the API, so the browser only ever talks to one origin (cookies, the
API's Origin check):

| Path | Served by |
| --- | --- |
| `/v1/*`, `/.well-known/*` (but `security.txt`), `/openapi.json` | rewritten to `ACCOUNTS_API_URL` (default `http://127.0.0.1:8589`), unchanged: method, body, cookies, `Set-Cookie`, `Location`. That includes the API's discovery (`/openapi.json`, `/v1/openapi.json`, `/v1/capabilities`, `/.well-known/agent.json`, `/.well-known/openid-configuration`) and its event stream (`/v1/events/stream`; production's Caddy sends it and `/openapi.json` straight to the API) |
| `/`, signed out | the public landing page, server-rendered with no client providers (see "The public landing page") |
| `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt`, `/manifest.webmanifest`, `/mcp` | the site's own agent files and MCP server (see "Agent entry points") |
| `/sdk/v1.js` | `public/sdk/v1.js`, built from `sdk/v1.ts` by `pnpm build:sdk` (runs before `dev` and `build`); `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300` |
| `/docs`, `/docs/*`, `/docs.md` | permanent redirects to the configured developer site (mapping below) |
| everything else | the pages below |

The rewrite proxy accepts bodies up to 52 MB and waits up to 5 minutes (`experimental.proxyClientMaxBodySize`,
`proxyTimeout` in `next.config.ts`): user imports send up to 50 MB, and Next's default 10 MB limit fails them with a
500 after 30 s.

**`ACCOUNTS_API_URL` is read at build time.** Next bakes rewrites into the build: `next dev` reads it at start,
`next build` fixes it for `next start` and the standalone server. Build with the address production will use;
`instrumentation.ts` warns at start when the runtime value differs.

`proxy.ts` (Next 16's middleware) gives every page a per-request nonce and these headers: a nonce CSP
(`script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, …), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, a strict referrer policy. The root layout puts the nonce on the inline theme boot
script; Next adds it to its own scripts. It skips `/v1`, `/.well-known`, `/_next` and static files.

`proxy.ts` also sends every old developer address to the developer site with a `307`: `/developer` to its home and
`/developer/{app_id}[/{tab}]` to `/apps/{app_id}[/{tab}]` there, query kept. The site's address is `developer_url` from
`GET /v1/meta` (cached for a minute; `ACCOUNTS_DEVELOPER_URL`, then https://developers.teamofsilicons.com, when the API
cannot say).

Documentation redirects use that same runtime developer-site configuration and HTTP **308**, including prefetch,
RSC, `HEAD` and static Markdown requests. `/docs` goes to the shared `/docs` landing; `/docs/<path>` goes to
`/docs/accounts/<path>`; `/docs.md` goes to `/docs/accounts/index.md`. The old `/docs/search-index.json` goes to the
shared endpoint at the same path (`/llms.txt` and `/llms-full.txt` are this site's own now). Queries are preserved, and browsers inherit the
original fragment because `Location` does not replace it. Unknown deep paths reach the developer site's docs 404.
The account dock, phone sheet, command palette and signed-out landing link directly to its `/docs`, using
`developer_url` rather than an obsolete account-site docs address. Account pages, API rewrites, hosted sign-in and
the embed remain on the Accounts origin.

The embed page `/embed/v1/buttons` is the one page other sites may frame: `proxy.ts` reads the app's
`GET /v1/apps/{app_id}/public` and answers `frame-ancestors 'self' <allowed_origins>` (none listed, unknown app or API
unreachable: `'none'` plus `X-Frame-Options: DENY`). The page renders on a transparent document, reports its height to
the parent (`{type: "silicon-accounts:resize", height}`) and its buttons navigate the top window to `/authorize`.

## Local stack

From the repository root, `scripts/dev.sh` runs everything: Postgres on 127.0.0.1:5444, migrations, the testkit apps
(`testkit/fake-apps.json`), the mocks, accounts-api on 8589 and this site on http://localhost:8590.
`scripts/dev.sh --web=external` leaves the site to you:

```
PORT=8590 ACCOUNTS_API_URL=http://127.0.0.1:8589 pnpm -C web dev
```

`scripts/dev.sh --prod` builds the site (`pnpm -C web build`, with `ACCOUNTS_API_URL` baked into the rewrites) and runs
what production runs: the standalone server, `node .next/standalone/server.js`, with `.next/static` and `public/`
copied beside it (`next start` only remains as a fallback for a build without `output: "standalone"`).

Rust binaries share one target directory: `CARGO_TARGET_DIR=target/integration scripts/dev.sh --no-build` reuses
binaries that are already built there. A second stack on other ports (`ACCOUNTS_PORT=8690 ACCOUNTS_API_PORT=8689
MOCK_OIDC_PORT=8691 MOCK_MESSAGING_PORT=8692 FAKE_APPS_PORT=8693 MOCK_IRIS_PORT=8694 ACCOUNTS_DB_NAME=… scripts/dev.sh`)
builds this site into `.next-8690` (`NEXT_DIST_DIR`), so it never touches the default stack's `.next`; by hand:
`NEXT_DIST_DIR=.next-8690 PORT=8690 ACCOUNTS_API_URL=http://127.0.0.1:8689 pnpm build` (or `pnpm dev`). Next allows
one `next dev` per build directory at a time. `scripts/e2e.sh` stacks work the same way (`e2e/README.md`).

## Who owns what

Routes live in `app/`, grouped by area; an area's components live in `components/<area>/`. The foundation built the
shared parts and a first version of each route; each area's builder owns its routes and components from there.

| Area | Routes | Code |
| --- | --- | --- |
| web-account | `/` (identity home when signed in), `/sign-in-methods`, `/apps`, `/silicons`, `/proofs`, `/activity`, `/settings` | `app/(app)/(shell)/(account)/`, `components/account/` |
| public | `/` when signed out (the landing page, rewritten by `proxy.ts` to `app/landing`), the agent files, `/mcp` | `app/landing/`, `components/landing/`, `components/site/`, `app/*.txt`, `app/mcp/`, `lib/agent/`, `lib/mcp/` |
| web-auth | `/sign-in`, `/authorize`, `/authorize/flow/[id]`, `/device`, `/embed/v1/buttons` (polish) | `app/(app)/(auth)/`, `components/auth/` |
| legacy web-docs | former docs routes redirect through `proxy.ts`; the old renderer and generated build remain temporarily as source, while `developer/` owns the public docs | `app/(app)/(docs)/`, `components/docs/`, `lib/docs/` (guide: `lib/docs/README.md`), `lib/docs-redirects.ts` |
| foundation | root layout, providers, shell, dock, command palette, theme, squircles, branding runtime, API client and hooks, SDK, `proxy.ts`, `/__kitchen`, screens | `app/layout.tsx`, `components/foundation/`, `components/kitchen/`, `lib/`, `styles/`, `sdk/`, `scripts/` |
| Arc UI | the installed components (local edits below) | `components/arc/` |

`app/(app)/layout.tsx` mounts the client providers for everything under it (one query cache across the account pages
and the hosted pages); the root layout and the public landing load none. `app/(app)/(shell)/layout.tsx` wraps the
account pages in the account shell (dock, ⌘K palette, sign-in gate). `app/(app)/(auth)/` pages render bare (the hosted card and the branding runtime). `/__kitchen` (the style guide) is
development only: production answers 404 unless the server runs with `ACCOUNTS_KITCHEN=1`.

## Conventions

- **Words.** Accounts are Carbons and Silicons, in copy, docs and comments alike; no other words for them or for
  groups of them (the vocabulary of UNDERSTANDING.md). Name parts of the system by what they are: the account site,
  the API, the SDK, the embed. Errors say what happened and what to do next, in the server's words when it sent them
  (`message` + `hint`).
- **Styling.** CSS modules next to each component, tokens from `styles/tokens.css` (the brand mapped onto Arc's
  semantic roles, light and dark), no Tailwind. Filled primary actions use `--primary*` (brand blue with light text,
  readable in both themes); `--accent` is for indicators, `--accent-ink` for accent-coloured text.
- **Themes.** `lib/theme.ts` + `useTheme()` (`components/foundation/theme/use-theme.ts`); light, dark or device,
  stored per browser, painted before first paint by the nonce'd boot script (no flash). Change it with
  `change(next, triggerElement)` for the eclipse transition from the switch.
- **Data.** Never `fetch` the API from components: use the hooks in `lib/query/` (or `api` from `lib/api` inside
  them). Errors are `ApiError` (`status`, `code`, `message`, `hint`, `requestId`, `retryAfter`, `lockedUntil`,
  `redirectTo`). Failed mutations toast message + hint unless `meta: { toast: false }` (show those inline); failed
  queries render inline. Any 401 marks the session gone and the shell sends the visitor to sign in. The account's own
  lists (apps, proofs, sessions, Silicons, custodian requests, owned apps) are read whole: every page of 200, up to 25
  pages (`lib/query/pages.ts`: `readEveryPage`, `useWholeList`, `MAX_LIST_PAGES`), so counts and filters never stop
  at the first page. Toasts read the service's RFC 3339 times and "N seconds from now" as clock times and spans
  (`readableTimes` and `durationText` in `lib/format.ts`).
- **Idempotency.** Every create/act endpoint takes an `Idempotency-Key`: `useIdempotentMutation(fn)` or
  `useIdempotencyKey()` keep one key per logical action and input, so retrying never does it twice.
- **Secrets shown once** (a generated or chosen STK, a webhook signing secret, a proof token): the action is a
  `useSecretMutation(fn)` (`lib/query/idempotency.ts`): `run(input)` resolves with the answer and resets the mutation,
  and nothing is cached (gcTime 0), so the page that shows the secret holds the only copy. `useCreateSilicon`,
  `useRotateStk`, `useSetSiliconWebhook`, `useSetOwnWebhook`, `useSetWebhook`, `useRotateWebhookSecret` and
  `useCreateAppVerification` are secret mutations.
- **Telemetry.** Opted in by default; turning it off (settings) sends `X-Accounts-Telemetry: off` on every API call
  from the first request on, and sets the `sa_telemetry=off` cookie for requests without headers.
- **Navigation.** `lib/navigation.ts` has every path and the dock's sections. Page changes use View Transitions
  (`router.push(href, { transitionTypes: ["page-forward"] })`); the dock morphs its highlight.
- **Unsaved work** asks before it is lost through the navigation guard (`lib/navigation-guard.ts`): a page registers
  `useNavigationGuard(dirty ? { protects, confirm } : null)` (or `question` for the shell's own "Leave this page?"
  dialog, `<LeaveQuestionHost>`), and the shell asks it before every navigation it starts (the dock and its phone
  sheet, the brand, the command palette, the section number keys, the user menu's Settings, signing out) and before a
  plain click on any other same-origin link (`useGuardedLinks`, a window capture listener). Links that ask through
  `confirmNavigation` themselves carry `data-guarded-navigation`. Back/Forward, typed addresses, reloads and closing
  the tab cannot be asked through it: keep the work for the tab and set `beforeunload`. The section number keys never
  fire while any dialog, drawer, sheet, menu or listbox is open.
- **Phone numbers** go through `components/foundation/phone-field` (`PhoneField`): Arc's picker formats the 49
  countries it lists, and every other number is typed with its country code and sent exactly as typed (the hosted
  pages and the account site's "Add a phone number" both use it; `guessCountry()` starts it in the visitor's country).
- **Signing out** waits for the server, then leaves with a full load (`useSignOut()`): no account page stays mounted
  without a session.
- **Arc rules.** One primary action per surface; destructive actions ask in place (ConfirmMorph) or need a hold;
  focus is shown by borders and fills, never rings; toasts are for background work.

### Hooks (`lib/query/`)

| File | Hooks |
| --- | --- |
| `session.ts` | `useSession`, `useMe`, `useMeta`, `useDeveloperUrl` (the developer site's address from the meta), `useSignOut`, `useRefreshSession`, `useTelemetryEnabled`, the first-party sign-in round trip (`beginSignIn` → /sign-in → `firstPartySignInUrl` → back to /sign-in, which reads `savedSignInReturn` / `forgetSignInReturn`; the home page never reads a code or error from its address), `sameSitePath`, `safeReturnPath` |
| `account.ts` | profile (`useUpdateProfile`, `useUploadPhoto`, `useRemovePhoto`, `useChangeId`, `useIdAvailability`, `useDeleteAccount`), emails, phones, identities, apps (`useMyApps`, `useRemoveAppAccess`), sessions, history, proofs, the Carbon's own webhook |
| `silicons.ts` | `useSilicons`, `useSilicon`, create, update, change id, photo, `useRotateStk`, webhook, transfer, delete, custodian requests |
| `auth.ts` | `useCreateFlow`, `useFlow`, `useFlowAction`, `useRefreshFlow`, `useDeviceRequest`, `useDecideDevice` (the hosted flow's own actions, details and review included, are in `components/auth/flow/controller.ts`) |
| `keys.ts`, `client.ts`, `idempotency.ts`, `pages.ts` | query keys, the shared client, idempotency helpers and `useSecretMutation`, whole lists |

`lib/notify.ts` raises toasts from anywhere (`notify.success`, `notify.error(apiError, title)`, `notify.loading` then
`notify.update`). `lib/format.ts` formats dates, relative times, phones and scopes, and reads the service's times in
its sentences (`readableTimes`, `durationText`); `lib/timezones.ts` lists zones.

## Squircles

Every rounded surface is a squircle (Figma-style corner smoothing). Mark the element and style it through variables:

```css
.card { --sq-r: var(--radius-panel); --sq-fill: var(--surface); --sq-stroke: var(--border);
        border: 1px solid var(--sq-stroke); background: var(--sq-fill); }
.card:hover { --sq-stroke: var(--border-strong); }   /* change the variables, never border-radius */
```
```tsx
<div data-sq="surface" className={styles.card} />        // fill and border follow the curve
<img data-sq="clip" className={styles.photo} … />        // clips the element and its content (avatars, logos)
<div data-sq-native="" className={styles.morph} />       // native only: elements that draw their own ::before/::after
```

- **Native** (Chromium, Safari with `corner-shape`): `styles/squircle.css` sets `corner-shape: squircle` with the
  radius scaled by `--sq-k` (1.6), so backgrounds, borders, shadows and overflow clipping follow the curve. No script.
- **Fallback** (Firefox, older Safari): the runtime (`<SquircleRuntime>` in the root providers) watches every
  `[data-sq]` element, computes the smoothed path for its size (one ResizeObserver) and paints it with `::before`
  (fill) and `::after` (border ring); an outer box-shadow becomes a drop-shadow filter. Nothing changes layout. Replaced
  elements (inputs, images) in `surface` mode keep plain rounded corners. Plain-styled elements still render, but only
  the `--sq-*` variables follow state changes. Review it in Chromium with `?squircle=fallback` on any page.
- `--sq-r` never inherits (an element without its own radius gets `--radius-control`, not its parent's). Square
  individual corners with `--sq-tl`, `--sq-tr`, `--sq-br`, `--sq-bl` (`0` or `1`; non-inheriting), as drawers and
  sheets do on the screen edge.
- `squircleRadiusScale(el)` (lib/squircle/core.ts) is the native multiplier for script that animates pixel radii;
  `squirclePath()` draws the same curve as SVG (the file dropzone's dashed edge); `useSquircle()` / `<Squircle>` in
  `components/foundation/squircle/` for refs and one-off surfaces.
- Branded pages may opt out (`corner_style` rounded or sharp): `[data-corner]` on the branding scope overrides both
  paths.

## Branding runtime

`lib/branding/` maps an app's `Branding` (palette per theme, radius, corner and button style, fonts, density, layout,
background, logos) onto Arc's tokens for one subtree: `brandingVariables(branding, theme)` and
`brandingAttributes(branding, theme)`, rendered by `<BrandingScope>` (`components/foundation/branding/`) with
`<BrandStage>`, `<BrandAside>` (split layout) and `<BrandPanel>` (the squircle card). Every Arc component inside
follows it without knowing about branding, and nothing leaks out. `resolveBrandTheme(mode, visitorTheme)` picks the
painted theme (a forced light/dark, else the visitor's). Fonts load lazily (`loadBrandingFonts`, Fontsource files
bundled with the site). `brandingContrastIssues()` checks text against the 4.5:1 minimum the server enforces.

The server holds only two pairs to 4.5:1 (button text on the primary, text on the page), so the runtime keeps the
colours it derives from the primary readable itself: `--accent-ink` (links, and the words of soft and outline buttons)
reads at 4.5:1 on the page, the card and the tint a soft or hovered outline button lays under it, and `--accent-line`
(an outline button's edge) at 3:1 on the page and the card, and `--accent-strong` (an info badge's words on the
accent tint, the active tab, a hovered link) at 4.5:1 on that tint over the card and the page, on a hovered badge's
tint and on the page and the card (`accentStrong`: the default dark palette's #5383C9 was 2.9:1 on its tint #313C4A;
it is #85A7D9 now, 4.55:1; `lib/branding/apply.test.ts`). Each is the theme's usual colour (light: the primary;
dark: the primary half-way to the text colour) whenever that already reads, so those palettes look exactly as chosen;
otherwise it moves toward the text colour in 5 % steps just far enough (`legibleTint`, judged in OKLab as the styles
mix). pixel-studio's #E5007E on its #FFF5FA page (4.25:1) becomes #C40F6D (5.42:1) on outline buttons, and a primary
equal to the page colour no longer leaves the main action's words invisible. The hosted pages do the same for
`danger` (`components/auth/flow/legible.ts`).

`<PoweredBy>` ("Powered by Silicon Accounts", linking to https://accounts.teamofsilicons.com) renders outside the scope
with its own fixed palette, so an app can neither restyle nor hide it. Every hosted page has it: the methods, the Opening
page, the code pages, sign-up, every details page and the review.

## SDK

`sdk/v1.ts` → `public/sdk/v1.js` (esbuild, IIFE, ES2019, ≤ 12 KB gzipped, checked by `sdk/build.mjs`;
`node sdk/build.mjs --watch` while working on it). `window.SiliconAccounts` offers `authorizeUrl`, `signIn` (PKCE),
`renderButtons` (Shadow DOM buttons in the app's branding), `mountFrame` (the iframe, auto-sized) and
`handleCallback`; a script tag with `data-app-id` and `data-redirect-uri` renders the buttons by itself.
`sdk/methods.ts` (labels, marks, ordering) is shared with the embed page.

Direct buttons and intents (UNDERSTANDING.md "Adding sign-in to an app"), the same in the SDK and the embed:

- **Method buttons** (default, `buttons: "methods"` / `data-buttons="methods"`): "Continue with Google", "Continue with
  Apple", "Continue with email", "Continue with phone number", one per method the app turned on, in its order
  (`method` / `data-method` keeps one). Each opens our pages with `method=`: Google and Apple through the Opening page,
  email and phone on their empty field.
- **Intent buttons** (`buttons: "intents"` / `data-buttons="intents"`, embed `buttons=intents`): "Sign in" and "Sign up";
  our pages then show every method. `intent` / `data-intent` keeps one of them; with method buttons it picks which
  version of our pages opens (`intent=signup`: "Create your Briefcase account"). `signIn({intent})` and
  `authorizeUrl({intent})` take it too.
- **No email or phone from the app.** There is no login hint: `loginHint`, `data-login-hint` and any email or phone
  option are dropped (with one console warning), the embed never forwards `login_hint`, and /authorize drops it before
  the flow is created. The Carbon always types it on our pages.

The SDK and the embed page both read `GET /v1/apps/{app_id}/public` and try a read the browser cut off twice more
(after 0.5 s and 1.5 s) before they report a problem: Safari cancels a page's and its frames' requests as soon as the
page starts navigating away (before `pagehide`), which used to log a false error on the app's console whenever
someone clicked sign-in while the buttons were still loading. The cut can come before the answer (the fetch rejects:
`network_error`) or after its headers, while the body is still on its way (the status says 200, reading the body
fails: it used to read "could not be loaded (HTTP 200)"); both are tried again.

## Arc UI

Installed with the shadcn CLI from the `@uiarc` registry (`components.json`), every free item: React components with
CSS modules, Motion and Radix. They are local source: edit them in place, and do not re-add one with `--overwrite`
without re-applying the edits below. `theme-switch` covers both the reveal and the eclipse variants (the page
animation is `lib/theme.ts`).

### Local edits

All edits are of four kinds, and keep Arc's look and motion:

- **Squircle:** the element gets `data-sq="surface"` (or `"clip"` for photos and containers whose children paint into
  the corners, or `data-sq-native` where Arc draws a border with `::after`), its `border-radius` becomes `--sq-r`, and
  its background and border colours move into `--sq-fill` / `--sq-stroke` so the fallback follows hover, focus,
  selected and invalid states.
- **Brand:** filled primary actions use `--primary`, `--primary-hover`, `--primary-pressed` and
  `--primary-foreground` (Arc fills them with the foreground colour or the accent).
- **Keyboard focus:** controls Arc left without any visible keyboard position get one, in fills and edges (never
  rings), so every control passes WCAG 2.4.7.
- **Behaviour** (integration round): keyboard and layer rules Arc got wrong, fixed where they live so no area needs a
  wrapper: the Combobox follows the WAI-ARIA combobox pattern, Escape inside a layer goes to the open control first,
  PhoneInput takes a whole number typed after "+", the Timeline announces only news, OTP cells fit narrow containers.

| Component | What changed |
| --- | --- |
| button, action-button | squircle; primary is brand blue (rest, hover, focus, pressed); `data-variant` on the element; keyboard focus shows as the hover fill |
| hold-to-confirm | squircle; the hold fill is `--primary` and inherits the curve (`corner-shape: inherit`) |
| confirm-morph | native-only squircle on the morphing pill (its border is a `::after`) and its buttons; the confirm button is brand primary |
| input, textarea, otp-input | squircle on the field (native; the fallback keeps rounded corners on inputs) and on the OTP focus ring |
| search-field, select, combobox, date-picker, dropdown-menu, color-picker | squircle on the control and its menu or panel |
| phone-input, morph-select | squircle shell; the morphing shape animates `--sq-r` (a Motion value) under `data-sq-native` |
| tag-input, chip-group, filter-toolbar, badge, metric-card | squircle shells and chips (chips stay pill-shaped); filter menu surface morphs its radius |
| card | squircle (clip) card and quick-look panel; the morph scales the panel's token radius by `squircleRadiusScale` |
| dialog, drawer, bottom-sheet, popover, tooltip, user-menu, command-palette, toast, toast-stack | squircle panels and close buttons; drawers and sheets keep the screen-edge corners square (per-corner factors); the user menu portrait is a 30 % squircle and its highlight is concentric with the panel |
| avatar, avatar-group, skeleton | 30 % squircle avatars (clip; the image follows the curve natively); the status dot moves inside the curve in the fallback |
| alert, empty-state, code-block, json-viewer, sortable-data-table, file-dropzone, inline-edit, pagination, radio-group, radio-cards, segmented-control, tabs, checkbox | squircle surfaces, highlights and rings; the file dropzone's dashed edge is drawn along the squircle path; tabs' edge buttons take the frame's curve |
| calendar | the selected day is brand primary (paper digits stay readable in dark mode) |
| blocks/sign-in, blocks/empty-states | squircle card, rows and tab rail |
| theme-switch | the icon-only size sets `--sq-r` |
| avatar-group, lib/media, blocks/sign-in | wording only: the group's default label is "Members"; sample people and a comment use the site's vocabulary |
| switch, segmented-control, timeline, inline-edit | keyboard focus (web-account fix round): an off switch's track takes the hover fill and an inner accent edge, an on track's fill deepens a step; the selected segment's highlight takes an accent edge (another segment, the hover ink and a soft fill); a timeline row's button and inline-edit's text take their hover fill on every device |
| date-picker, user-menu | keyboard focus (integration round): the date picker's trigger edge takes the text colour, as inputs do; the user menu's trigger takes its hover fill and an inner edge |
| combobox | behaviour: focus alone no longer opens the list (typing, ArrowDown/ArrowUp or a click do), the list closes when focus leaves the field, and the listbox is `tabIndex={-1}` (no Tab stop). The hosted pages' `ComboboxField` wrapper and the account editors' "focus the panel first" workaround are gone. Keyboard focus (web-auth fix round): the clear button takes its hover fill and ink with an inner edge (its ring was `--focus-ring`, transparent site-wide, so Tab to it changed nothing) |
| dialog, drawer, bottom-sheet, popover | behaviour: Escape inside the layer goes first to an open Combobox list, DatePicker calendar, InlineEdit being edited or ConfirmMorph question, and only the next Escape closes the layer (`components/arc/lib/escape.ts`: each layer passes its `onEscapeKeyDown` through `layerEscape` and marks its panel `data-escape-layer`). The account area's `parts/escape.ts` spread is gone |
| phone-input | behaviour: a whole international number typed after "+" (which opens the country search) moves into the number field under its country once it has more digits than a calling code ("+1 202 5…" → United States, 202 5…) |
| timeline | behaviour: only rows newer than every row shown are fresh (slide in, announced as "New update: …"); older rows added below by "Show older" join quietly |
| otp-input | the field never grows past its container (`minmax(0, 1fr)`, `min-width: 0` on the row), so six cells shrink at 320 px instead of sticking out |
| tabs, sortable-data-table, filter-toolbar, file-dropzone, pagination, dropdown-menu, stepper, command-palette, inline-edit, tag-input, checkbox, alert | keyboard focus (web-developer fix round): every focus style Arc drew as a ring in the transparent `--focus-ring` (or never drew) is a fill or an edge: the selected tab's highlight takes an accent edge and another tab a soft fill; a focused tab panel an accent edge along its top; a sort header deepens its fill over an accent edge (on phones the sort pill takes a fill and an edge); a row's select box its hit area's fill; Add filter's surface, the dropzone, pagination, the menu trigger, the palette's buttons, inline-edit's Save, Cancel and Retry, a checkbox's hit area and an alert's Dismiss their hover look; a stepper head underlines its label and edges its disc |
| tabs | behaviour: a strip that starts to overflow (the window narrows, a tablet turns) scrolls the selected tab into view; before, only choosing a tab did, so a narrowed developer page showed its tab cut off or off the strip |
| json-viewer | a row is named by what it shows, in order (WCAG 2.5.3): "key: value", "key, 16 keys, object" for an open branch, and a closed object's key preview after its key ("key: id, name, …, 5 keys, object"); the parts of a row are separated by spaces in the text too, so its words never run together |
| avatar | the initials (no photo, or while it loads) are drawn by `::before` from `data-initials`, not written as text: they are part of a picture whose name is the whole name, and as text they counted as words of every link or button holding the avatar, so a tile of an app without a logo failed WCAG 2.5.3 on two letters its name lacked |
| hold-to-confirm | the fill's copy of the label (aria-hidden, clipped away at rest) is drawn by `::before` from `data-text`: as text it doubled the button's words ("Hold to delete your accountHold to delete your account"), which failed WCAG 2.5.3 against its name |
| command-palette | behaviour: results are not Tab stops (the search field drives them through aria-activedescendant, the arrow keys and Enter); a broken selector had left "No matching actions" unstyled |
| sortable-data-table, file-dropzone, tabs | squircle: the sort button (no radius in its header cell, a pill on phones), the dropzone's paper sheets and the tab triggers (native only, `data-sq-native`: the sheets draw their lines with `::before`/`::after`, the triggers paint only the focus fill) |
| dialog, drawer, bottom-sheet | behaviour (web-foundation fix round): closing puts focus back on what opened the layer, Trigger or not (WCAG 2.4.3). Radix returns it only to its own `<Dialog.Trigger>`, and the account site opens its layers from controlled state, so focus fell to `<body>` (Change id, Create a Silicon). `components/arc/lib/return-focus.ts` (`useReturnFocus`) remembers the focused element in an insertion effect when `open` turns true (before an `autoFocus` field or Radix moves focus) and restores it in `onCloseAutoFocus`; a caller's own `onCloseAutoFocus` that calls `preventDefault()` still wins, and focus that already moved on outside the layer stays where it is. The shell's ⌘K palette (`command-menu.tsx`) uses the same hook |
| command-palette | the "Esc" button is named "Esc, close the command palette" (its visible word was missing from its name, WCAG 2.5.3) with `aria-keyshortcuts`; it, the clear button, the ⌘K and shortcut keys and the result highlight are squircles (`--sq-r` 7 px / 5 px / 8 px) |
| calendar | keyboard focus (web-foundation fix round): a day takes the hover fill under an inner accent edge, the selected day's disc deepens and takes an inner paper edge, the month arrows and Today their hover fill and an inner accent edge (an arrow that cannot move brightens a little); days of the next and previous month are no longer dimmed below 4.5:1 (they stay choosable, so they keep `--text-muted`) |
| checkbox | a caller's `aria-describedby` is kept beside the description's id instead of being replaced by it (the hosted details page describes each optional detail's box by the value it would share); "Checkbox" is the fallback name only when neither a label nor `aria-labelledby` names the box |

## Style guide and screens

`/__kitchen` shows every installed Arc component with sample data in the brand, the shell's building blocks, the
branding runtime and the embed/SDK. `?compare=1` renders each specimen in a light and a dark pane side by side;
`?squircle=fallback` shows the Firefox squircle path.

`pnpm screens` takes Playwright screenshots (Chromium by default) into `.screens/<name>--<theme>-<width>.png`, both
themes at 1440 and 390 px. It uses `--base URL`, or a server on `http://localhost:$PORT` (8590), or starts `next dev`
(and reuses the project's running one, since Next allows only one). The browser's `/v1` calls are answered by
`scripts/mock/` (fixtures from `testkit/fake-apps.json`); `--live` uses the real API behind the server. Console
errors fail the run.

```
pnpm screens --only kitchen --split 1600     # tall pages also in 1600 px parts
pnpm screens --only shell --widths 390 --themes dark
pnpm screens --list
```

Areas add their own screens in `components/<area>/screens.ts`:

```ts
import type { ScreenSpec } from "@/scripts/screens-types";
export const screens: ScreenSpec[] = [
  { name: "account-apps", path: "/apps", routes: [["GET /v1/me/apps", () => ({ json: { items: [], next_cursor: null } })]] },
  { name: "auth-flow-briefcase", path: "/authorize/flow/flow_briefcase", as: "signed-out" },
];
```

## End-to-end walk

`e2e/` walks every journey of the product (UNDERSTANDING.md v2) in a real browser against a running stack: this site,
the developer site (`developer/`) and accounts-api behind them. The core suite (`e2e/journeys`): a first-party sign-up;
briefcase's hosted sign-in with its what's-shared page and dm's "Continue as" with its own page adding the phone it
requires (optional details unticked until ticked); Google and Apple (managed and the apps' own) and the apps' direct
buttons (the Opening page, email and phone opening on their field); the CLI (device sign-in approved in the browser,
`silicon create`, a self-created Silicon accepted on /silicons, `login --silicon`, an SLT for remind); User verification and App verification
through the fake apps (one App verification proof per app, with timings); dirty.csv imported on the developer site (signed in
through its BFF) and with the CLI, and an imported Carbon finishing setup; webhooks with valid signatures; every page in
an app's own style with "Powered by", Sign in / Sign up buttons, the embed and the SDK; ledgerly's two-page flow with
its review (Back, Cancel); the developer site as an owner (a saved title on the hosted page, an app verification proof made and
revoked on its App verification tab); the shared behaviours (the developer site's unsaved-work guard, Escape in layers, the Combobox,
focus states, any-country phones, dark tokens, /developer leading to the developer site); a Silicon's secrets on the
account site; connecting Google and Apple. Other suites live in `e2e/suites/<suite>/`.

```
scripts/e2e.sh                 # from the repo root: a fresh isolated stack (production build), every journey, teardown
scripts/e2e.sh --suite core    # one suite; journeys by prefix: scripts/e2e.sh b-apps silicons/
scripts/e2e.sh --dev --webkit  # the site on next dev, walked in WebKit
scripts/e2e-all.sh --engines chromium,webkit   # every suite in parallel, a stack each, merged summary
pnpm e2e [journey…]            # against an already running stack (scripts/dev.sh's ports, or E2E_PORT_BASE / E2E_*)
pnpm e2e --list
```

**`e2e/README.md` is the guide**: suites (`e2e/journeys/*.ts` is the core suite, `e2e/suites/<suite>/*.ts` the
others, found without editing run.ts), the v2 helpers in `e2e/lib.ts` (the details pages, intents and method buttons,
the Opening page, the developer site's sign-in through its BFF, single-app App verification proofs), port bases (the developer site
is base + 5), per-stack builds of both sites, reports (`e2e/.artifacts/<base>/report.json` and `report.md`,
`e2e/.artifacts/summary.md`), the mock Iris, forwarded addresses and time travel. Each journey records checks and fails
on console errors, uncaught page errors, CSP refusals and failed requests (`e2e/lib.ts`). `e2e/` is part of
`pnpm typecheck` and `pnpm lint` (tsconfig.json and eslint skip only `e2e/.artifacts`, the reports).

Two shared files serve the walk: `next.config.ts` builds into `NEXT_DIST_DIR` (default `.next`; a local stack on
another port builds into `.next-<port>` with a per-directory tsconfig that extends `tsconfig.json`, no type-check
pass and no Turbopack build cache, so concurrent builds share nothing; see the comment there), and `proxy.ts` adds a
loopback `http://` `ACCOUNTS_IRIS_BASE_URL` origin to the CSP's `img-src` (the testkit's mock Iris; production's
https Iris is covered by `https:` already). `sdk/build.mjs` writes `public/sdk/v1.js` through a rename.

## Notes

- `output: "standalone"`: deploy `.next/standalone` with `.next/static` and `public/` copied beside it (what
  `scripts/dev.sh --prod` runs). `next start` still works locally (it prints a warning).
- Every route renders per request (the nonce CSP needs it).
- `.screens/`, `public/sdk/`, `.next/`, `.next-*/` (and their `.next-*.tsconfig.json`) are build output and
  git-ignored.
- `agentRules: false` (next.config.ts): `next dev` never rewrites `AGENTS.md` / `CLAUDE.md`; both are kept by hand.
- Checks (paused, see the top of this file): `pnpm checks:auth [--base URL | --live URL]` and
  `pnpm checks:account --live URL [--webkit]` run the areas' Playwright checks (components/auth/checks.ts,
  components/account/checks.ts; the live ones need a scratch database; the account checks sign up Carbons of their
  own through /sign-in, so they need the API's dev outbox, as scripts/dev.sh and scripts/e2e.sh stacks have it). The
  developer area's checks went with the developer pages to the developer site.

### Integration round: shared changes (2026-10-07)

Every shared-foundation request from the area builders, resolved in the shared code:

- **Navigation guard** (`lib/navigation-guard.ts`, `components/foundation/shell/leave-question.tsx`): see Conventions.
  The shell routes the dock, phone sheet, brand, palette, number keys, Settings and sign-out through it; the developer
  area's own window-capture click/keydown interception, synthetic Escape and copy of the typing rule are gone.
- **Number keys** no longer jump from under an open layer: the shell checks `[role=dialog]`, `[role=alertdialog]`,
  `[role=menu]` and `[role=listbox]` (Radix layers carry no `aria-modal`).
- **Whole lists** (`lib/query/pages.ts`): `useMyApps`, `useMyProofs`, `useSessions`, `useSilicons`,
  `useCustodianRequests` and `useOwnedApps` read every page; the account area's `useEvery*` are re-exports.
- **Secret mutations** (`useSecretMutation`): every action whose answer carries a secret; the account area's `*Once`
  hooks are re-exports, and the developer area's webhook and App verification forms use the shared hooks.
- **First-party sign-in** ends on /sign-in only: the shell no longer reads `/?state&code|error` (a link could put its
  own words in a toast there); `consumeSignInReturn` / `isSignInReturn` are gone, `/device` is a valid return path.
- **Arc**: Combobox, Escape in layers, PhoneInput, Timeline, OTP input, focus states (see Local edits).
- **Focus states** in the foundation: the shell's brand link (a soft fill), every plain link site-wide
  (`styles/base.css`, zero specificity so a component's own rule wins) and the "Powered by" pill (underline and edge).
- **Dark theme contrast** (`styles/tokens.css`): `--text-muted` #B8B3AB (4.66:1 on `--surface-muted`),
  `--text-secondary` #C2BDB5 (stays the stronger of the two), `--accent-strong` #93B8F1 (info badges 4.85:1).
- **Branding defaults**: the default dark `danger` is #FF8A80 (5.45:1 on #353432) here, in crates/core
  `default_dark` and in stored configs (migration 0004); the SDK's dark fallback primary is #1F5FB8 like the server's
  (its #5B8FE0 override is gone) and its dark ink follows the hosted pages' `--accent-ink` (50 % mix, 5.5:1).
- **Toasts** read the service's times (`readableTimes` moved to `lib/format.ts`).
- **heroCopyFor** (components/auth/flow/model.ts): the split layout's hero rules without a FlowView (the developer
  site's page previews copied it).
- **API client**: `api.flows.uploadSignupPhoto` and the `SignupPhoto` type.
- **Unknown developer tabs** answered 404 from proxy.ts (`lib/developer-tabs.ts`; gone in v2: every `/developer` address
  now redirects to the developer site).
- **Phone field** moved to `components/foundation/phone-field`; the account site's add-phone form uses it.
- **Split layout** (`<BrandAside>`, styles/branding.css): the app's side renders its content in a sticky
  `.sa-brand-aside-inner` at most one viewport tall, so on long steps (setting up, what is shared) the logo stays at the
  top and the hero copy at the foot of the screen instead of scrolling away below the fold.
  The aside has no percentage height (the grid stretches it to its row): a `min-height: 100%` there made WebKit keep
  the taller step's height after the card shrank, pushing Powered by below the fold.

### Fix round: shared changes (web-developer, 2026-10-07)

- **Branding runtime** (`lib/branding/apply.ts`, `contrast.ts`, `styles/branding.css`): `--accent-ink` and the new
  `--accent-line` stay readable on any palette (see Branding runtime); an outline button's edge uses `--accent-line`.
- **Shell**: while the shell is up, `html` has `scroll-padding-block` of 24 px at the top and the height of the dock
  (plus room) at the bottom, so Tab never leaves a control under the floating dock or the phone bar (WCAG 2.4.11), nor
  an edge drawn just above a focused part (a tab panel's accent line) above the window; the phone bar's section button
  (`.menuButton`, "Identity" on the home page) shows keyboard focus with a deeper accent tint and an accent edge.
- **Identity card** (`components/foundation/identity`): at rest on its front, the back face is `visibility: hidden`
  (as the front already was at rest on its back). WebKit's software painting, which its screenshots use, ignores
  `backface-visibility` and drew the back mirrored over the front, so the WebKit walk saw no keyboard focus on the
  front's controls.
- **Arc**: keyboard focus in fills and edges across the components that drew transparent rings, tabs that keep the
  selected tab in view when the strip narrows, label-in-name fixes (json-viewer rows, avatar initials and the
  hold-to-confirm fill drawn instead of written), squircles on the sort button, the dropzone sheets and tab triggers
  (see Local edits).

### v2: the understanding of 2026-10-07 (web-accounts)

What changed on this site for UNDERSTANDING.md v2 (build spec 06-v2.md):

- **accounts.teamofsilicons.com**: every address of this site in code, copy, the SDK and the docs renderer
  (`lib/docs/site.ts` `CANONICAL_ORIGIN`) is the plural host; "Powered by Silicon Accounts" links to
  https://accounts.teamofsilicons.com on every page (`POWERED_BY_HREF` in `components/foundation/branding` and
  `sdk/methods.ts`).
- **No developer area.** `app/(shell)/(developer)`, `components/developer`, `lib/developer-tabs.ts` and
  `lib/query/developer.ts` are gone (the developer site, `developer/`, took them over). `/developer[/*]` answers a 307 to
  the developer site from proxy.ts; the dock's and the phone sheet's Developer item, number key 7 and the palette's
  "Developer" open it (a full navigation through the navigation guard, `sectionHref` + `useDeveloperUrl`); the landing
  page's footer and the apps page link it. `Meta.developer_url` is typed (optional for older servers).
- **Hosted pages** (components/auth/README.md has the details): `intent` (sign-in or sign-up page), the Opening
  Google/Apple page, email/phone opening on their empty field, nothing prefilled from `login_hint` (dropped by
  /authorize, /sign-in, the SDK and the embed), the `details` pages (required locked, a missing email or phone added
  with a code on the page, optional unticked checkboxes, per-step title/subtitle/continue label/layout, "Step n of m",
  Back, Cancel), the `review` page. The v1 `requirements` and `consent` steps and their endpoints are gone from the
  client (`api.flows.detailsAdd/detailsVerify/detailsContinue/detailsBack/review`).
- **Types** (`lib/api/types.ts`): FlowView v2 (`intent`, `details`, `review`; no `requirements`, `consent`,
  `login_hint`), `FlowCreate.intent`, `SigninCopy.opening_title/signup_title/signup_subtitle`, `SigninConfig.flow`
  (`SigninFlow`, `SigninFlowStep`), App verification proofs for exactly one `receiving_app` (`AppVerificationRequest`, `IssuedProof`, `AppProof`).
- **SDK and embed**: `intent` / `data-intent`, `buttons: "intents"` ("Sign in" / "Sign up"), "Continue with phone
  number", no login hint (see SDK).
- **Mocks and screens**: `components/auth/mocks/flows.ts` samples every v2 page (Opening, intents, details pages, the
  added detail, a two-page flow, review), and the screens' mock walks a multi-page flow (`scenarioAfter`).
- `StepMorph` orders numbered sub-views ("details:0" → "details:1" slides forward, Back slides back);
  `HostedFrame` takes a page's own `layout`.

### Fix round: shared changes (web-foundation, round 1, 2026-10-07)

- **Skip link** (`<SkipLink>` in `components/foundation/layout`, `styles/base.css`): a squircle (`data-sq`, `--sq-r`,
  `--sq-fill`) instead of `border-radius`; the account shell uses it. A skip link without `data-sq` now has square
  corners, so every frame should render `<SkipLink href="#…" />`.
- **Layers return focus** to what opened them (Arc dialog, drawer, bottom sheet and the ⌘K palette; see Local edits).
- **Branding runtime**: `--accent-strong` reads on the accent tint in any palette (see Branding runtime).
- **Docs 404 on the server** (`proxy.ts`, `app/(docs)/docs/404`): a `notFound()` below the root layout renders only in
  the browser in this Next (the HTML is an empty `<html id="__next_error__">`, with or without the shared providers:
  checked on production builds), so a page load of `/docs/<path>` that is no page and no group's page (lib/docs
  `findPage` / `isGroup`) is rewritten to `/docs/404` with status 404, which renders the docs' "No page here" inside
  the docs frame with the theme boot script. The Markdown files, the search index and client-side navigations (RSC
  requests, where the catch-all's `notFound()` renders as before) pass through.

### Verification terminology (2026-10-08)

The shared account navigation, phone sheet and command palette call `/proofs` **User verification**. Page metadata, cards, activity filters and related copy use the same name; the route, query keys, API values and revoke behavior remain unchanged. Root `docs/` supplies the updated App verification and User verification titles to the developer site's docs navigation and search. The central managed-app history lives at `https://developers.teamofsilicons.com/app-verification`; it retains events, never raw token values.

### The Silicon look and the public site (2026-10-09)

The account site, the hosted pages' default look and the developer site (`developer/`) are one family now (shared
brief: fonts SF Pro and BDO Grotesk; light #F7F8FA / #292929, dark #02040A / #F7F8FA, brand blue #1F5FB8).

- **Type and colour** (`styles/fonts.css`, `styles/tokens.css`, `components/arc/foundation.css`): the developer site's
  tokens exactly. BDO Grotesk (SIL OFL 1.1, `public/fonts/bdo-grotesk/` with its OFL.txt, `font-display: swap`, only
  DemiBold preloaded) is the display face; text asks for the system face first (SF Pro on Apple devices; its licence
  does not allow serving it), mono is the system mono stack. Page titles, the identity name and counters are BDO
  Grotesk DemiBold (`--font-serif` is kept as an alias of the display face; the site has no serif). Every text token
  clears 4.5:1 on every surface in its mode; dark accent-coloured text uses `--accent-ink` #7DAEF4 (brand blue as text
  on #02040A is 3.3:1). BDO Grotesk's tabular figures are its monospaced set, so display-face counters keep the
  proportional ones. The identity card's paper is a cool, faintly blue tint instead of the warm one.
- **Fonts removed**: the site no longer loads Geist, Instrument Serif or JetBrains Mono for itself. They stay in
  `app/fonts.ts` (next/font, `preload: false`) only because apps may pick them for their hosted pages; the other
  branding fonts still load on demand (`lib/branding/fonts.ts`).
- **The hosted pages' default look** (`lib/branding/defaults.ts`, `apply.ts`, `styles/branding.css`): DEFAULT_LIGHT and
  DEFAULT_DARK are the Silicon palettes. The API still stores and serves its older defaults (crates/core
  `default_light`/`default_dark`, warm paper #FFFDF9), so `normalizeBranding` recognises a palette equal to them in all
  eight colours (LEGACY_LIGHT, LEGACY_DARK) and paints the new one; a palette with any colour of the app's own stays
  exactly as stored (dm's green on its paper keeps its paper). An app that kept every default colour and the default
  font (Geist) wears the site's faces (`isSiliconLook`, `data-look="silicon"`, DemiBold headings); any font of its own
  is kept. Silicon Accounts' own pages (`HostedFrame site`) carry `data-look="silicon"` too. "Powered by", the embed's
  pill and the SDK (`sdk/v1.ts`: the same recognition, 9.2 KB gzipped) use the new colours. When the API's own
  defaults change to the new palette, nothing here needs to change.
- **Device approval for apps' tools** (`components/auth/device.tsx`): `GET /v1/device/{user_code}` now names the app
  (`app`, `first_party`, `scopes`); an app's own command-line tool is shown in the app's look ("Sign in to {app}?",
  what it will see, "Powered by"), the silicon-accounts CLI keeps the Silicon Accounts look.

### The public landing page (2026-10-09)

`/` for anyone not signed in is `components/landing/` (server components only: the header's theme switch and the
copy buttons are the islands, `components/site/theme-controls.tsx` and `enhancer.tsx`). It sells Silicon Accounts to
Silicons (an identity of their own, no browser, the exact commands, "Create your Silicon account") and to Carbons (one
account, no passwords, see and remove apps, look after Silicons, revoke User verifications), answers questions
(FAQPage JSON-LD) and points app builders to the developer site once. The header, footer, action links and code
blocks are the developer site's (`components/site/`, the same CSS).

- `proxy.ts` marks the request `x-sa-surface: public` for a page load of `/` without a session cookie, or with one the
  API refuses (a 401 from `GET /v1/session`; that cookie is then cleared), and rewrites it to `app/landing` (a direct
  visit to `/landing` goes back to `/`). That route sits outside `app/(app)`, so its module graph has no client
  providers and no account shell: the page ships only its islands and Next's runtime. Its links are plain
  `<a>` elements, so leaving it is a full page load (eslint allows that for `components/site` and
  `components/landing`). With a live session `/` is the identity home as before; a session that ends while the tab is
  open shows a short "You're signed out" card (`components/account/home.tsx`).
- The developer site's address comes from `GET /v1/meta` on the server (`lib/server/meta.ts`, shared with proxy.ts).
- SEO (`lib/seo.tsx`, `lib/site.ts`): title, description, canonical, Open Graph and Twitter on `/`; Organization and
  WebSite JSON-LD on the public surface, WebApplication/SoftwareApplication, WebPage and FAQPage on the landing. Every
  other page is `noindex` by default (the root metadata): account pages, `/sign-in`, `/authorize`, `/device`, the
  embed. Icons and the social image are rendered by `pnpm brand` (`scripts/brand/`, Playwright) into `public/`.

### Agent entry points (2026-10-09)

| Path | What |
| --- | --- |
| `/llms.txt`, `/llms-full.txt` | the Carbon's `web/llms/llms.md` (and `llms-full.md` when it exists, else llms.md again), exactly as written; bundled at build time by `lib/agent/build-llms.ts` into the git-ignored `lib/agent/generated/llms.ts` (`pnpm build:llms`, run by dev, build, typecheck and test). Never edit the .md files from code |
| `/robots.txt` | `lib/agent/robots.ts`: everything public allowed, AI crawlers named and welcome; account pages, `/sign-in`, `/authorize`, `/device`, `/embed/`, `/v1/`, `/api/`, `/mcp` disallowed |
| `/sitemap.xml` | `lib/agent/sitemap.ts`: the landing page, the llms files and the OpenAPI description, with lastmod |
| `/.well-known/security.txt` | the same as the developer site's (the one `/.well-known` path not forwarded to the API) |
| `/manifest.webmanifest` | name, colours and icons |
| `/mcp` | MCP over Streamable HTTP (`app/mcp/route.ts`, `lib/mcp/`: the developer site's protocol, stateless, 2025-06-18 and older). Read-only tools that call the API on the server: `check_id_available`, `lookup_account` (with the caller's own Authorization header, which goes along to the API and nowhere else; without one it says whether the id is held), `get_capabilities` (`/v1/capabilities`, `/v1/meta` on older servers), `get_openid_configuration`, `how_to_create_silicon_account`, `docs_link`. 60 requests a minute per address (429 with Retry-After); the API counts the tools' calls against the caller's forwarded address |

WebMCP (`lib/webmcp.ts`, inline with the nonce on every page but the embed): `check_id_available` and
`how_to_create_silicon_account`, behind a `navigator.modelContext` feature check. The A2A agent card is the API's
(`/.well-known/agent.json`); this site does not serve one of its own. `pnpm test` runs `tests/*.test.ts` (redirects,
proxy surfaces, agent files, MCP protocol, rate limit), the branding tests and the hosted pages' unit tests.
