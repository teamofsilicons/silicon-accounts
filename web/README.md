# Silicon Accounts web

Everything Silicon Accounts shows in a browser:

- the **account site**, where Carbons and Silicons manage their identity, sign-in methods, apps, Silicons,
  proofs and activity (`/`, `/identity`, `/apps`, …);
- the **hosted sign-in pages** apps send people to (`/sign-in`, `/authorize`, `/authorize/flow/:id`) and CLI
  device approval (`/device`);
- the **developer pages** for apps a Carbon owns (`/developer`, `/developer/:appId/:tab`);
- the **embed page** apps put in an iframe (`/embed/v1/buttons`) and the **SDK** script (`/sdk/v1.js`).

SolidJS, `@solidjs/router`, Kobalte and Motion, styled with Arc (uiarc.dev) ported to Solid and set in the Silicon
Accounts brand. The product contract is `understanding/UNDERSTANDING.md`; the API this talks to is described in
the build spec (02-api.md) and mirrored in `src/api/types.ts`.

## Run it

```sh
pnpm -C web install
pnpm -C web dev          # http://localhost:5190, proxies the API to http://127.0.0.1:8590
pnpm -C web typecheck    # browser code (tsconfig.json) and Node code (tsconfig.node.json)
pnpm -C web build        # writes web/dist (see "Serving" below)
pnpm -C web screens      # screenshots into web/.screens for review
pnpm -C web smoke        # interaction checks in a real browser
```

Development needs the API server on port 8590 (`ACCOUNTS_API_URL` points the proxy elsewhere) started with
`ACCOUNTS_EXTRA_ALLOWED_ORIGINS=http://localhost:5190`, so its CSRF origin check and the first-party sign-in
redirect (`http://localhost:5190/`) accept the dev origin. The dev server proxies `/v1/`, `/.well-known/`,
`/embed/v1/`, `/sdk/v1.js`, `/healthz` and `/readyz`; everything else is the app.

No API at hand? `pnpm screens` and `pnpm smoke` run against a mock API (below), and `/__kitchen` is the style
guide with every component in both themes.

## Who owns what

The web foundation built the shell, the components, the API client, the branding runtime and one file per route.
Each page area belongs to one builder. **Inside your area you may change, add and delete any file. Everything
outside it is read-only for you**: if a shared piece is wrong or missing, work around it inside your folder (for
example call `request()` from `src/api` directly for an endpoint shape that differs) and report it.

| Area | Owner | Files | Routes |
| --- | --- | --- | --- |
| Hosted sign-in and device | web-auth | `src/pages/auth/**`, `src/pages/device/**`, `embed/**`, `sdk/**` | `/sign-in`, `/authorize`, `/authorize/flow/:id`, `/device`, `/embed/v1/buttons`, `/sdk/v1.js` |
| Account | web-account | `src/pages/account/**`, `src/pages/landing/**` | `/` (both), `/identity`, `/sign-in-methods`, `/apps`, `/silicons`, `/proofs`, `/activity`, `/settings` |
| Developer | web-developer | `src/pages/developer/**` | `/developer`, `/developer/:appId/:tab?` |
| Foundation | web-foundation | everything else: `src/api`, `src/app`, `src/arc`, `src/branding`, `src/lib`, `src/styles`, `src/theme`, `src/main.tsx`, `src/pages/kitchen`, `scripts/`, `public/`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `package.json` | `/__kitchen`, the shell, 404 |

The route table is `src/app/App.tsx` and nobody else edits it. Every route already has its page file, loaded
lazily; **keep these file names and their default export** and the router never needs touching:

| Route | Page file (default export) | Frame |
| --- | --- | --- |
| `/` signed out | `src/pages/landing/Landing.tsx` | bare (no shell) |
| `/` signed in, `/identity` | `src/pages/account/Identity.tsx` | account shell |
| `/sign-in-methods` | `src/pages/account/SignInMethods.tsx` | account shell |
| `/apps` | `src/pages/account/Apps.tsx` | account shell |
| `/silicons` | `src/pages/account/Silicons.tsx` | account shell |
| `/proofs` | `src/pages/account/Proofs.tsx` | account shell |
| `/activity` | `src/pages/account/Activity.tsx` | account shell |
| `/settings` | `src/pages/account/Settings.tsx` | account shell |
| `/developer` | `src/pages/developer/Developer.tsx` | account shell |
| `/developer/:appId/:tab?` | `src/pages/developer/AppDetail.tsx` (tabs: `DEVELOPER_TABS` in `src/app/navigation.ts`) | account shell |
| `/sign-in` | `src/pages/auth/SignIn.tsx` | bare |
| `/authorize` | `src/pages/auth/Authorize.tsx` | bare |
| `/authorize/flow/:id` | `src/pages/auth/Flow.tsx` | bare |
| `/device` | `src/pages/device/Device.tsx` | bare |
| `/__kitchen` (development only) | `src/pages/kitchen/Kitchen.tsx` | bare |
| anything else | `src/app/NotFound.tsx` | bare |

Account-shell routes are guarded: a visitor without a session is sent to `/sign-in?return_to=…` and comes back to
the page they asked for. Link with `paths` from `src/app/navigation.ts` (`paths.developerApp("briefcase",
"webhooks")`), never string literals. Placeholders render `PagePlaceholder` (`src/app/PagePlaceholder.tsx`); replace
the whole file. `Identity.tsx`, `Landing.tsx`, `Flow.tsx`, `Authorize.tsx`, `SignIn.tsx` and `AppDetail.tsx` already
hold working first versions that show how the shell, the card and the branding runtime fit together; rewrite them
freely.

## Code map

```
web/
  index.html            the app's HTML (loads public/theme-boot.js before paint; no inline scripts)
  public/               favicon.svg, theme-boot.js (copied as is)
  embed/                the iframe page: buttons.html + embed.ts + embed.css, methods.ts (shared with the SDK)
  sdk/v1.ts             the SDK, built as one IIFE at dist/sdk/v1.js
  scripts/              screens.ts, smoke.ts, screens-types.ts, mock/ (mock API + fixtures)
  src/
    main.tsx            fonts, Arc foundation, brand tokens, squircles, base styles, <App />
    api/                typed client: types.ts (every 02-api.md shape), endpoints.ts (`api.*`), http.ts, errors.ts, solid.ts
    app/                App.tsx (routes), session.ts, navigation.ts, commands.ts, notify.ts, layout/, identity/, shell/
    arc/                Arc components ported to Solid (one folder each), lib/ (squircles, motion, presence, flip…), blocks/sign-in
    branding/           applyBranding, BrandingScope, PoweredBy, fonts, contrast, defaults, branding.css
    lib/                format.ts (dates, counts, labels), timezones.ts
    pages/<area>/       route pages (see "Who owns what")
    styles/             tokens.css (brand), base.css, fonts.ts
    theme/              theme.ts (preference, system), theme-transition.ts
```

## Conventions

**Words.** People are **Carbons**, AI agents are **Silicons**, and every account belongs to exactly one of them
(there are no group accounts). Name the parts of the product by what they are: the account site, the hosted
pages, the API. Sentence case, no em dashes, and every message says what happened and what to do next.

**Arc rules.** Semantic tokens only (`var(--surface)`, `var(--text-secondary)`, `var(--accent-ink)`…), one accent
(brand blue), one primary action per surface. No focus rings: keyboard position shows through fills and borders
(the components already do this; do the same in your own controls). Motion uses the tokens in
`src/arc/lib/motion.ts` (`spring.smooth`, `spring.snappy`, `spring.morph`) and every animation has a
reduced-motion branch (`prefersReducedMotion()`).

**Squircles.** Every rounded surface is a squircle. Give the element `ref={el => useSquircle(el)}` (or
`{ mode: "clip" }` for images and media) and style it through three variables, never `border-radius`:

```css
.card { --sq-r: var(--radius-surface); --sq-fill: var(--surface); --sq-stroke: var(--border);
        border: 1px solid var(--sq-stroke); background: var(--sq-fill); }
.card:hover { --sq-fill: var(--surface-muted); }
```

Chromium draws them natively (`corner-shape: squircle`); Safari and Firefox get an SVG-path fallback painted on
`::before`/`::after`, so do not use those pseudo-elements on a squircled element. Review the fallback in Chromium
with `?squircle=fallback`. Code without Solid (the embed) uses `attachSquircle` from `src/arc/lib/squircle-core.ts`.

**JSX in data.** A JSX value is a real DOM node; rendering the same one twice moves it. Store icons as functions
(`icon: () => <Mail />`) or pass them through `freshJSX()` from `src/arc/lib/clone.ts`.

**Themes.** `theme()` / `themePreference()` from `src/theme/theme.ts`; change with `changeTheme(preference,
trigger)` (animated). Any subtree can be themed with `data-theme="light" | "dark"`; tokens follow.

**Layout.** `src/app/layout/layout.tsx`: `Page` (width `narrow | reading | default`), `PageHeader` (h1 in the
display serif, description, actions, back link), `Section`, `Stack`, `Cluster`, `Grid`, `Surface` (never nested),
`SettingsGroup`/`SettingsRow`, `DescriptionList`/`DescriptionItem`. Pages render inside the shell's `<main>`.

**Shell.** The floating dock (bottom sheet on phones), the ⌘K palette, number keys 1 to 7 for the sections and
page transitions come from `src/app/shell`. Add page commands with
`registerCommands(() => [{ id, label, group, run }])` (removed when the page unmounts).

**Session.** `src/app/session.ts`: `sessionStatus()`, `signedInAccount()`, `me()` (the shared Me resource),
`refreshMe()`, `setMe(next)`, `signOut()`, `beginSignIn(returnTo)` and `firstPartySignInUrl(returnTo, { prompt,
login_hint, method })` for the account site's own sign-in (app `accounts`, redirect `{origin}/`).

**Identity card.** `src/app/identity/IdentityCard.tsx`: `IdentityCard` (front/back, tilt, flip, grain;
`useIdentityCard().toggle()` inside a face), `IdentityField`, `Stamp`/`StampRow`, `LiveClock`.

**Feedback.** A foreground action confirms in place (ActionButton, ConfirmMorph, inline errors). Toasts are for
background work and failures: `notify.success(title, description)`, `notifyError(error, title)`.

### API client

```ts
import { api, ApiError, createApiResource, createAction, createPagedList } from "../../api";

const [apps] = createApiResource(() => api.me.apps.list({ limit: 50 }));      // Suspense + skeletons
const remove = createAction((appId: string) => api.me.apps.removeAccess(appId), { report: "Could not remove access" });
const users = createPagedList(query => api.apps.users("briefcase", { ...query, q: search() }));
// remove.run(id) resolves undefined on failure (toasted); remove.pending(), remove.error() drive the UI.
```

Same origin, cookies included, JSON in and out. Every failure is an `ApiError` with the server's `code`,
`message` (what and why), `hint` (what to do), `details`, `requestId` and `retryAfter`; show message and hint.
Creating calls marked IDEMPOTENT in the spec send a fresh `Idempotency-Key` (pass `{ idempotencyKey }` to reuse
one across retries of the same action). A 401 from any call marks the session gone and the shell sends the visitor to sign in. `authorizeUrl()`
builds `/authorize` links. Types mirror 02-api.md; `endpoints.ts` normalizes a few equivalent response shapes
(noted where it does).

### Branding runtime

Hosted pages paint an app's `Branding` onto one subtree and nowhere else:

```tsx
<BrandingScope branding={flow.app.branding} theme={resolveBrandTheme(branding.theme, theme())}>
  <BrandStage>
    <BrandAside>…</BrandAside>                      {/* split layout only: the app's side */}
    <BrandPanel as="main">
      <div class="sa-brand-header">logo + name</div>
      <h1 class="sa-brand-title">…</h1> <p class="sa-brand-subtitle">…</p>
      <div class="sa-brand-body">step content</div>
      <p class="sa-brand-legal">terms and privacy</p>
    </BrandPanel>
  </BrandStage>
</BrandingScope>
<PoweredBy theme={paintTheme} overlay />            {/* outside the branded subtree, always */}
```

`applyBranding(el, branding, theme)` (used by `BrandingScope`, usable directly) sets the palette, radii, fonts and
density as Arc tokens in inline custom properties, and `data-theme`, `data-corner`, `data-layout`, `data-bg`,
`data-button-style`, `data-density` for `branding.css` and `squircle.css`; it returns a function that removes them.
Fonts load on demand (`loadBrandingFonts`, self-hosted, CSP-safe). `.sa-brand` is an inline-size container, so the
split layout folds by the branded area's own width (a phone-wide preview inside a wide page folds correctly); give
it a definite width rather than a shrink-to-fit parent. `brandingContrastIssues()` and `contrastRatio()` check a
palette the way the server does. "Powered by Silicon Accounts" is not configurable: render `PoweredBy` outside
`BrandingScope`, never restyle it.

### Embed and SDK (minimal, working; web-auth completes them)

- `/embed/v1/buttons?app_id=…&redirect_uri=…&state=…&theme=light|dark|auto` (`embed/`): reads the authorize
  parameters from its query (`app_id`/`client_id`, `redirect_uri`, `response_type`, `state`, `code_challenge`,
  `code_challenge_method`, `scope`, `nonce`, `prompt`, `login_hint`; nothing else is forwarded), loads
  `GET /v1/apps/{app_id}/public`, renders one squircle button per enabled method in the app's branding (email,
  else phone, is the one primary), and each button is a `target=_top` link to `/authorize?…&method=<method>`.
  It posts `{type: "silicon-accounts:resize", height}` to the parent whenever its height changes. A missing
  parameter, an unknown or disabled app or a method the app does not offer shows a configuration error with a
  `data-error-code`. The server sets `frame-ancestors` from the app's `allowed_origins`.
- `/sdk/v1.js` (`sdk/v1.ts`, < 12 KB gzipped, no dependencies): `<script src=…/sdk/v1.js data-app-id
  data-redirect-uri data-target …>` renders the same buttons in an open Shadow DOM. It honours `data-state`,
  `data-code-challenge`, `data-code-challenge-method`, `data-nonce`, `data-scope`, `data-prompt`,
  `data-login-hint`, `data-method`, `data-theme` and `data-pkce="S256"`. `window.SiliconAccounts` has
  `authorizeUrl(options)`, `signIn(options)` and `renderButtons(target, options)`. When the SDK creates the state
  (or the PKCE verifier) it stores `{state, code_verifier, nonce, redirect_uri, app_id}` as JSON in
  `sessionStorage["silicon-accounts:auth:<state>"]` before leaving the page.
- In development the sources are served as is: open `/embed/buttons.html?app_id=…`, and import `sdk/v1.ts` as a
  module (the style guide's "Embed and SDK" section does both). The proxied `/embed/v1/buttons` and `/sdk/v1.js`
  are the built files the API server serves.

## Screenshots, mocks and smoke tests

`pnpm screens` starts Vite on a free port, mocks the API, and saves `web/.screens/<name>--<theme>-<width>.png`
(both themes, 1440 and 390 px by default). Options: `--only kitchen,shell`, `--themes dark`, `--widths 390`,
`--engine webkit`, `--split 1600` (tall pages in parts), `--live` (no mocks; uses the dev proxy), `--base URL`,
`--list`. Console errors fail the run.

Each page area adds its own screens in `src/pages/<area>/screens.ts` (picked up automatically, type-checked with
the Node config):

```ts
import type { ScreenSpec } from "../../../scripts/screens-types";

export const screens: ScreenSpec[] = [
  { name: "account-silicons", path: "/silicons" },
  { name: "account-silicons-create", path: "/silicons", fullPage: false,
    prepare: async page => { await page.getByRole("button", { name: "Create a Silicon" }).click(); } },
  { name: "auth-flow-ledgerly-signup", path: "/authorize/flow/flow_ledgerly", as: "signed-out",
    routes: [["GET /v1/flows/:id", () => ({ json: { flow: myFlowFixture } })]] },
];
```

The mock API (`scripts/mock/api.ts`) answers the account endpoints with fixtures built from
`testkit/fake-apps.json` (`scripts/mock/fixtures.ts`): a signed-in Carbon (`c:saket`), Silicons, apps, proofs,
history, the 15 fake apps' public configs and details, and `GET /v1/flows/flow_<app_id>` flows. `routes`
entries override or add endpoints (`"METHOD /v1/path/:param"`, later entries win); an unmocked call answers 404
`not_found` naming the route to add.

`pnpm smoke` drives every style-guide component, the shell, the embed (framed by a page on another origin) and the
SDK (the production IIFE on another origin) in a real browser, and fails on any console or page error. Options:
`--engine webkit`, `--reduced-motion`, `--only <name>`.

## Serving

`pnpm build` writes:

```
dist/index.html               the app (served for every non-API path, Cache-Control: no-store)
dist/assets/*                 hashed JS, CSS and fonts (immutable)
dist/embed/v1/buttons.html    the iframe page (served at /embed/v1/buttons)
dist/sdk/v1.js                the SDK (served at /sdk/v1.js, CORS *)
dist/theme-boot.js, dist/favicon.svg
```

The server (`crates/server/src/web.rs`) serves it from `ACCOUNTS_WEB_DIST` with the site CSP
(`default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; …`). Keep it that way: no inline
scripts (the theme boot is an external file), self-hosted fonts only, images over https or data URLs.
`/__kitchen` is left out of production builds (`VITE_ACCOUNTS_KITCHEN=1` includes it for a review build).
