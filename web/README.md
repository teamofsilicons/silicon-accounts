# Silicon Accounts: the account site

The public site of Silicon Accounts (account.teamofsilicons.com): the account pages Carbons and Silicons use, the
hosted sign-in pages apps send people to, the developer pages, the embeddable sign-in buttons and the SDK script.

Next.js 16 (App Router, Turbopack) with React 19 and TypeScript in strict mode, pnpm, Arc UI installed with the shadcn
CLI, TanStack Query for data. The product contract is `understanding/UNDERSTANDING.md`; nothing here overrides it.

```
pnpm install
pnpm dev            # http://localhost:8590 (builds the SDK first; PORT=… to change)
pnpm typecheck      # next typegen + tsc --noEmit
pnpm lint           # eslint, zero warnings
pnpm build          # builds the SDK, then next build (output: standalone)
pnpm start          # the production build on $PORT (8590)
pnpm screens        # Playwright screenshots into .screens/ (see "Screens")
```

Node 24 or newer. Read the bundled Next docs in `node_modules/next/dist/docs/` before relying on memory: this Next has
breaking changes (`proxy.ts` instead of `middleware.ts`, async `params`/`searchParams`, `PageProps<"/route">` from
`next typegen`, Turbopack by default).

## Topology

Next serves the whole public origin and proxies the API, so the browser only ever talks to one origin (cookies, the
API's Origin check):

| Path | Served by |
| --- | --- |
| `/v1/*`, `/.well-known/*` | rewritten to `ACCOUNTS_API_URL` (default `http://127.0.0.1:8589`), unchanged: method, body, cookies, `Set-Cookie`, `Location` |
| `/sdk/v1.js` | `public/sdk/v1.js`, built from `sdk/v1.ts` by `pnpm build:sdk` (runs before `dev` and `build`); `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300` |
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

Rust binaries share one target directory: `CARGO_TARGET_DIR=target/integration scripts/dev.sh --no-build` reuses
binaries that are already built there. Running a second stack on other ports: the API needs `ACCOUNTS_BIND_ADDR`,
`ACCOUNTS_PUBLIC_URL` (this site's origin, for example `http://localhost:8690`) and `ACCOUNTS_EXTRA_ALLOWED_ORIGINS`;
start this site with `PORT=8690 ACCOUNTS_API_URL=http://127.0.0.1:8689 pnpm dev`. Next allows one `next dev` per
project directory at a time.

## Who owns what

Routes live in `app/`, grouped by area; an area's components live in `components/<area>/`. The foundation built the
shared parts and a first version of each route; each area's builder owns its routes and components from there.

| Area | Routes | Code |
| --- | --- | --- |
| web-account | `/` (landing when signed out, identity home when signed in), `/sign-in-methods`, `/apps`, `/silicons`, `/proofs`, `/activity`, `/settings` | `app/(shell)/(account)/`, `components/account/` |
| web-auth | `/sign-in`, `/authorize`, `/authorize/flow/[id]`, `/device`, `/embed/v1/buttons` (polish) | `app/(auth)/`, `components/auth/` |
| web-developer | `/developer`, `/developer/[appId]/[[...tab]]` | `app/(shell)/(developer)/`, `components/developer/` |
| foundation | root layout, providers, shell, dock, command palette, theme, squircles, branding runtime, API client and hooks, SDK, `proxy.ts`, `/__kitchen`, screens | `app/layout.tsx`, `components/foundation/`, `components/kitchen/`, `lib/`, `styles/`, `sdk/`, `scripts/` |
| Arc UI | the installed components (local edits below) | `components/arc/` |

`app/(shell)/layout.tsx` wraps account and developer pages in the account shell (dock, ⌘K palette, sign-in gate).
`app/(auth)/` pages render bare (the hosted card and the branding runtime). `/__kitchen` (the style guide) is
development only: production answers 404 unless the server runs with `ACCOUNTS_KITCHEN=1`.

## Conventions

- **Words.** Accounts are Carbons and Silicons, in copy, docs and comments alike; no other words for them or for
  groups of them (the vocabulary of UNDERSTANDING.md). Name parts of the system by what they are: the account site,
  the API, the SDK, the embed. Errors say what happened and what to do next, in the server's words when it sent them
  (`message` + `hint`).
- **Styling.** CSS modules next to each component, tokens from `styles/tokens.css` (the brand mapped onto Arc's
  semantic roles, light and dark), no Tailwind. Filled primary actions use `--primary*` (brand blue with paper text,
  readable in both themes); `--accent` is for indicators, `--accent-ink` for accent-coloured text.
- **Themes.** `lib/theme.ts` + `useTheme()` (`components/foundation/theme/use-theme.ts`); light, dark or device,
  stored per browser, painted before first paint by the nonce'd boot script (no flash). Change it with
  `change(next, triggerElement)` for the eclipse transition from the switch.
- **Data.** Never `fetch` the API from components: use the hooks in `lib/query/` (or `api` from `lib/api` inside
  them). Errors are `ApiError` (`status`, `code`, `message`, `hint`, `requestId`, `retryAfter`, `lockedUntil`,
  `redirectTo`). Failed mutations toast message + hint unless `meta: { toast: false }` (show those inline); failed
  queries render inline. Any 401 marks the session gone and the shell sends the visitor to sign in.
- **Idempotency.** Every create/act endpoint takes an `Idempotency-Key`: `useIdempotentMutation(fn)` or
  `useIdempotencyKey()` keep one key per logical action and input, so retrying never does it twice.
- **Telemetry.** Opted in by default; turning it off (settings) sends `X-Accounts-Telemetry: off` on every API call
  from the first request on, and sets the `sa_telemetry=off` cookie for requests without headers.
- **Navigation.** `lib/navigation.ts` has every path and the dock's sections. Page changes use View Transitions
  (`router.push(href, { transitionTypes: ["page-forward"] })`); the dock morphs its highlight.
- **Signing out** waits for the server, then leaves with a full load (`useSignOut()`): no account page stays mounted
  without a session.
- **Arc rules.** One primary action per surface; destructive actions ask in place (ConfirmMorph) or need a hold;
  focus is shown by borders and fills, never rings; toasts are for background work.

### Hooks (`lib/query/`)

| File | Hooks |
| --- | --- |
| `session.ts` | `useSession`, `useMe`, `useMeta`, `useSignOut`, `useRefreshSession`, `useTelemetryEnabled`, `firstPartySignInUrl`, `beginSignIn`, `consumeSignInReturn`, `safeReturnPath` |
| `account.ts` | profile (`useUpdateProfile`, `useUploadPhoto`, `useRemovePhoto`, `useChangeId`, `useIdAvailability`, `useDeleteAccount`), emails, phones, identities, apps (`useMyApps`, `useRemoveAppAccess`), sessions, history, proofs, the Carbon's own webhook |
| `silicons.ts` | `useSilicons`, `useSilicon`, create, update, change id, photo, `useRotateStk`, webhook, transfer, delete, custodian requests |
| `developer.ts` | owned apps, app detail and public config, sign-in config and its history, users, imports and rows, webhook deliveries and replays, proofs (ATA, revoke) |
| `auth.ts` | `useCreateFlow`, `useFlow`, `useFlowAction`, `useRefreshFlow`, `useDeviceRequest`, `useDecideDevice` |
| `keys.ts`, `client.ts`, `idempotency.ts` | query keys, the shared client, idempotency helpers |

`lib/notify.ts` raises toasts from anywhere (`notify.success`, `notify.error(apiError, title)`, `notify.loading` then
`notify.update`). `lib/format.ts` formats dates, relative times, phones and scopes; `lib/timezones.ts` lists zones.

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

`<PoweredBy>` ("Powered by Silicon Accounts", linking to account.teamofsilicons.com) renders outside the scope with
its own fixed palette, so an app can neither restyle nor hide it.

## SDK

`sdk/v1.ts` → `public/sdk/v1.js` (esbuild, IIFE, ES2019, ≤ 12 KB gzipped, checked by `sdk/build.mjs`;
`node sdk/build.mjs --watch` while working on it). `window.SiliconAccounts` offers `authorizeUrl`, `signIn` (PKCE),
`renderButtons` (Shadow DOM buttons in the app's branding), `mountFrame` (the iframe, auto-sized) and
`handleCallback`; a script tag with `data-app-id` and `data-redirect-uri` renders the buttons by itself.
`sdk/methods.ts` (labels, marks, ordering) is shared with the embed page.

## Arc UI

Installed with the shadcn CLI from the `@uiarc` registry (`components.json`), every free item: React components with
CSS modules, Motion and Radix. They are local source: edit them in place, and do not re-add one with `--overwrite`
without re-applying the edits below. `theme-switch` covers both the reveal and the eclipse variants (the page
animation is `lib/theme.ts`).

### Local edits

All edits are of three kinds, and keep Arc's behaviour and motion:

- **Squircle:** the element gets `data-sq="surface"` (or `"clip"` for photos and containers whose children paint into
  the corners, or `data-sq-native` where Arc draws a border with `::after`), its `border-radius` becomes `--sq-r`, and
  its background and border colours move into `--sq-fill` / `--sq-stroke` so the fallback follows hover, focus,
  selected and invalid states.
- **Brand:** filled primary actions use `--primary`, `--primary-hover`, `--primary-pressed` and
  `--primary-foreground` (Arc fills them with the foreground colour or the accent).
- **Keyboard focus:** controls Arc left without any visible keyboard position get one, in fills and edges (never
  rings), so every control passes WCAG 2.4.7.

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

## Notes

- `output: "standalone"`: deploy `.next/standalone` with `.next/static` and `public/` copied beside it. `next start`
  still works locally (it prints a warning).
- Every route renders per request (the nonce CSP needs it).
- `.screens/`, `public/sdk/` and `.next/` are build output and git-ignored.
