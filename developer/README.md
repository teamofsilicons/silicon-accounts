# Silicon Developer: developers.teamofsilicons.com

The developer platform: one place where developers maintain everything they build with us. Each of our services keeps
its own backend; this site is one frontend on top of them. It combines Silicon Apps publishing with Silicon Accounts: everything about creating
and setting up an app's authentication (its sign-in methods, Google and Apple, the details it asks for, its flows and
pages, redirect URIs and allowed origins, its user base and imports, its webhook and deliveries, its app verifications, and the
snippets to embed sign-in). The same app workspace also creates apps, saves seven setup steps, uploads and validates packages, manages releases and authors, and publishes through Silicon Apps. Each service retains its own backend. The portal contains no store catalog; discovery and installation live at apps.teamofsilicons.com.

Next.js 16 (App Router, Turbopack) with React 19 and TypeScript in strict mode, pnpm, Arc UI, TanStack Query. The
product contract is `../understanding/UNDERSTANDING.md` (never edited here); nothing in this app overrides it. Runtime-independent from the rest of this repository: documentation sources are bundled at build time.

```
pnpm install
pnpm dev            # http://localhost:8600 (PORT=… to change)
pnpm typecheck      # next typegen + tsc --noEmit
pnpm lint           # eslint, zero warnings
pnpm build          # next build (output: standalone)
pnpm start          # the production build on $PORT (8600)
pnpm test           # unit tests: sealing, return paths, both proxy allowlists, flows, agent files, rate limits
pnpm exec playwright install chromium
pnpm test:e2e       # portal, publishing, docs, home page, agent files and JSON API (E2E_PORT, default 8620)
pnpm test:production-routing # after pnpm build: standalone routing with Caddy HTTPS headers
```

Node 24 or newer. Read the bundled Next docs in `node_modules/next/dist/docs/` before relying on memory (`proxy.ts`
instead of `middleware.ts`, async `params`, `PageProps`/`LayoutProps` from `next typegen`).

## Topology: a BFF

The shared docs use the `silicon-accounts` CLI and first-party Accounts app ID. Verification receiver suggestions exclude that internal app.

The browser only ever talks to this site. The Next server holds the Carbon's Silicon Accounts tokens and calls the
Silicon Accounts and Apps APIs, server to server:

| Path | What it does |
| --- | --- |
| `/auth/sign-in?return_to=/apps/x` | Starts a sign-in: a fresh `state` and PKCE verifier are sealed into a 10-minute httpOnly cookie (`sa_dev_signin`, up to three at once for three tabs), and the browser goes to the hosted sign-in on the accounts site as the first-party app `developer`: `{ACCOUNTS_PUBLIC_URL}/authorize?app_id=developer&redirect_uri={DEVELOPER_PUBLIC_URL}/auth/callback&state&code_challenge&code_challenge_method=S256` (`prompt=login\|select_account` passes through). |
| `/auth/callback` | The state must be one this browser started; the code is exchanged server side (`POST /v1/oauth/token`, `client_id=developer`, no secret, the PKCE verifier), and the tokens are sealed into the session cookie. Failures land on `/sign-in?error=<code>` with fixed words per code (the address's `error_description` is never shown). |
| `/auth/sign-out` (POST) | Revokes the refresh token (`/v1/oauth/revoke`, `client_id=developer`) and clears the cookie. The account site's own sign-in is untouched. |
| `/auth/session` | `{"signed_in": bool}` from the sealed cookie alone (no API call). The pages ask it before `/api/accounts/me`, so a signed-out visit never logs a 401. |
| `/api/accounts/*` | The proxy: `{ACCOUNTS_API_URL}/v1/*` with `Authorization: Bearer <access token>`. Public reads (`meta`, `apps/{id}/public`, `.well-known/openid-configuration`, `.well-known/jwks.json`) go without a token. Account reads: `me`, `me/owned-apps`, `me/app-verifications`. Everything under `apps/{app_id}/…` (the owner routes). Anything else answers 404 `not_proxied`. |
| `/api/apps/*` | Restricted publishing proxy to `{APPS_API_URL}/v1/*`, using the same server-held `aud=developer` access token. Own-app listing requires `mine=true`. Store reviews, install receipts, package resolution, reports and platform registration are not proxied. Media paths use this proxy too, preserving private visibility checks. A 401 from Silicon Apps is never relayed as signed out on its own (see "Silicon Apps refusing the token" below). |
| everything else | the pages |

**Session cookie** (`sa_dev_session`, `__Host-sa_dev_session` over https): httpOnly, SameSite=Lax, Secure over https,
sealed with AES-256-GCM under a key derived (HKDF-SHA256) from `DEVELOPER_SESSION_SECRET`, the cookie's purpose bound
in as additional data (`lib/server/seal.ts`). It holds the access token (aud=developer, 30 minutes), the refresh token
(rotates on every use, 900 days), their expiry times and the account's uuid. The browser never sees a token.

**Refresh** (`lib/server/session.ts`): the proxy refreshes when the access token has under a minute left, and once more
when the API answers 401 `invalid_token`. Refresh tokens rotate and a reused one revokes the whole sign-in, so refreshing
is single-flight per refresh token in the process, and the result is remembered for a minute: requests the browser sent
with the old cookie before the new one arrived get the same new tokens instead of presenting the used refresh token.
A refused refresh (`invalid_grant`) clears the cookie and answers 401 `signed_out`.

**CSRF**: every state-changing request (`POST/PUT/PATCH/DELETE` to `/api/accounts/*`, `/api/apps/*` and `/auth/sign-out`) must carry an
`Origin` of this site (`DEVELOPER_PUBLIC_URL`, `DEVELOPER_EXTRA_ORIGINS`, and in development the same port on
`localhost`/`127.0.0.1`) and, when the browser sends it, `Sec-Fetch-Site: same-origin`; otherwise 403
`cross_site_request`.

**Signed out**: the browser's API client treats a 401 as a sign of "signed out" only for `signed_out`, `token_revoked`,
`account_deleted`, `unauthenticated` and `invalid_token` (`lib/query/client.ts`); other 401s, such as
`token_wrong_audience` from an endpoint that refuses the developer platform's token, show where they happen. Such a 401
never sends anyone away on its own word: the page asks again who is signed in (`/auth/session`, then `/v1/me`,
`markSignedOut` in `lib/query/session.ts`), and only when that says signed out does the shell send the visitor to
`/sign-in?return_to=…`. The sign-in page sends a visitor back only when the same question says signed in, so the two
can never pass a Carbon back and forth.

**Silicon Apps refusing the token** (`lib/server/apps-refusal.ts`): Silicon Apps checks the developer token on its own
(its JWKS, the issuer it trusts, a live check at Silicon Accounts), so it can refuse a token Silicon Accounts still
accepts: an Apps API set up for another Accounts service (a local stack whose Apps upstream belongs to another stack),
a key it has not fetched yet. On a 401 from Apps the proxy asks Silicon Accounts (`GET /v1/session` with the same
token): ended there, the cookie is cleared and the browser hears 401 `signed_out`; expired there, one refresh and one
retry; fine there, the browser hears 502 `apps_rejected_sign_in` (Apps' own code and words in `details`), and the apps
workspace says "Publishing details could not be loaded" with the reason while the apps from Silicon Accounts stay. No
refresh token is spent on a refusal. Before this, an Apps 401 `invalid_token` read as signed out: the shell went to
/sign-in, the sign-in page found the session fine and went back to /apps, and the two looped.

The server checks the developer audience itself (06-v2 §2): a token with `aud=developer` acts for its Carbon only on
`GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps`, `GET /v1/me/app-verifications` and the app management routes under `/v1/apps/{app_id}/…`.

**Pages' headers** (`proxy.ts`, pages only; the route handlers set their own): a nonce CSP (`script-src 'self'
'nonce-…' 'strict-dynamic'`, `connect-src 'self' <accounts site>` for the Embed tab's live SDK, `img-src 'self' https:
data: blob: <accounts site> <local mock Iris>`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, nosniff, a strict
referrer policy, HSTS in production. An address under an app that names no tab answers the not-found page with a 404.

## Environment

`skipProxyUrlNormalize` keeps the exact standalone listener origin in internal rewrites. Otherwise Next normalizes `127.0.0.1` to `localhost`; behind HTTPS termination it can then attempt an external TLS request to the plain HTTP listener. Rewrite and legacy-alias targets use the raw request URL so Next reduces them to internal, relative paths. `pnpm test:production-routing` boots the actual standalone server bound to `127.0.0.1` and verifies missing docs/app routes, legacy redirects, valid docs, CSP, and HSTS both directly and with Caddy's public Host/forwarded-HTTPS headers. It generates an ephemeral session secret and stops its own server afterward.

Read at request time (`lib/server/config.ts`), never baked into the build:

| Variable | Default | What |
| --- | --- | --- |
| `APPS_API_URL` | dev: `http://127.0.0.1:4310`; prod: `https://apps.teamofsilicons.com` | Silicon Apps upstream, server to server. It must trust the same Silicon Accounts as `ACCOUNTS_API_URL` (its `APPS_ACCOUNTS_URL` is that service's public URL), or it refuses this site's tokens and the pages say so. `scripts/dev.sh` sets it per stack (base + 6). |
| `ACCOUNTS_API_URL` | `http://127.0.0.1:8589` | The Silicon Accounts API, server to server. |
| `ACCOUNTS_PUBLIC_URL` | dev `http://localhost:8590`, prod `https://accounts.teamofsilicons.com` | The accounts site: hosted sign-in, the SDK. |
| `DEVELOPER_PUBLIC_URL` (or `ACCOUNTS_DEVELOPER_URL`) | dev `http://localhost:$PORT` (8600), prod `https://developers.teamofsilicons.com` | This site's origin; the redirect URI is exactly `{it}/auth/callback`, as the API's `ACCOUNTS_DEVELOPER_URL` says. |
| `DEVELOPER_SESSION_SECRET` | dev: a public development secret (with a warning) | Seals the cookies; at least 32 characters. Production refuses to run without it. |
| `DEVELOPER_EXTRA_ORIGINS` | | More origins the same-origin guard accepts (comma separated). |
| `ACCOUNTS_IRIS_BASE_URL` | | A loopback mock Iris joins the CSP's `img-src` (local stacks). |
| `PORT`, `NEXT_DIST_DIR` | `8600`, `.next` | Port; a build directory per local stack (`.next-<port>`), as in `web/`. |

## Local stack

`scripts/dev.sh` (repository root) starts this site next to the account site when `developer/package.json` exists:
port 8600 on the default stack, else `ACCOUNTS_PORT + 5`, with `ACCOUNTS_API_URL`, `ACCOUNTS_PUBLIC_URL`,
`DEVELOPER_PUBLIC_URL`/`ACCOUNTS_DEVELOPER_URL`, a per-stack `DEVELOPER_SESSION_SECRET`, `NEXT_DIST_DIR` and
`APPS_API_URL` = `http://127.0.0.1:<ACCOUNTS_PORT + 6>` (8596 next to the default stack), so a stack never sends its
tokens to an Apps API that trusts another stack. What answers there (`--apps=MODE`): by default the testkit's stand-in
Silicon Apps API (`testkit/src/mock-silicon-apps.ts`: no apps, creates none, so the apps workspace loads and nothing
leaves the machine); with `--apps=on` the sibling `silicon-apps` checkout's real Apps API (`apps-server`, built with
`CARGO_TARGET_DIR=target/integration cargo build -p silicon-apps-server`), trusting the stack's accounts site and
sharing a local `ACCOUNTS_INTERNAL_TOKEN` with accounts-api, so creating apps and publishing work end to end; with
`--apps=off` (or an `APPS_API_URL` of your own) nothing is started. For example:

```
ACCOUNTS_PORT=8740 ACCOUNTS_API_PORT=8739 MOCK_OIDC_PORT=8741 MOCK_MESSAGING_PORT=8742 FAKE_APPS_PORT=8743 \
  MOCK_IRIS_PORT=8744 DEVELOPER_PORT=8745 APPS_API_PORT=4610 ACCOUNTS_DB_NAME=accounts_8740 \
  CARGO_TARGET_DIR=target/integration scripts/dev.sh --apps=on
```

By hand, against a running stack:

```
PORT=8600 ACCOUNTS_API_URL=http://127.0.0.1:8589 ACCOUNTS_PUBLIC_URL=http://localhost:8590 pnpm -C developer dev
```

The API must know this site: `ACCOUNTS_DEVELOPER_URL=http://localhost:8600` on accounts-api (the default in
development), or the hosted sign-in refuses the redirect URI. Signing in uses the dev outbox's codes like any local
sign-in. `pnpm seal-dev-session` (development only) seals a token pair you already have into a session cookie, for
checking pages with curl or a browser without the hosted sign-in.

## Who owns what

| Area | Routes | Code |
| --- | --- | --- |
| BFF | `/auth/*`, `/api/accounts/*` | `app/auth/`, `app/api/`, `lib/server/` (config, seal, session) |
| Shell | every signed-in page: the top bar (brand, Apps, Docs, ⌘K, theme, account menu), the sign-in gate, page transitions | `app/(shell)/layout.tsx`, `components/foundation/shell/` |
| Sign-in | `/sign-in` (the front door and where failed sign-ins land) | `app/sign-in/`, `components/sign-in/` |
| Public home page | `/` for anyone not signed in (a signed-in browser is sent on to `/apps` by `proxy.ts`, from the sealed cookie alone) | `app/(public)/page.tsx`, `components/home/`, `components/site/` |
| Apps home | `/apps` (owned and authored apps; “New app” registers it through Apps and shows the secret once) | `components/developer/home/` |
| An app | `/apps/[appId]/[[...tab]]`: Overview, Publishing, Releases, Authors, History, Sign-in, Details, Flows, Pages, Users, Import, Webhooks, App verification, Embed | `components/developer/app/` (scope, tab frame), `components/developer/tabs/`, `lib/app-tabs.ts` |
| Verification history | `/app-verification` | `components/developer/verification/` |
| Invitations and preferences | `/invitations`, `/settings` | `components/publishing/`, native shell pages |
| Unified docs | public `/docs`, `/docs/apps/**`, `/docs/accounts/**`, `/docs/search` | `components/docs/`, `lib/docs/`, `app/(public)/docs/` |
| Agent files | `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap.xml`, `/.well-known/agent.json`, `/.well-known/security.txt`, `/openapi.json`, `/manifest.webmanifest` | `app/<file>/route.ts`, `lib/agent/`, `llms/` (the Carbon's own text) |
| Status | public `/status` and its JSON twin `/status.json` | `app/(public)/status/`, `app/status.json/`, `components/status/`, `lib/status.ts` |
| Public JSON API | `/api/docs`, `/api/docs/search`, `/api/docs/pages`, `/api/docs/pages/{product}/{path}` | `app/api/docs/`, `lib/docs/api.ts`, `lib/server/rate-limit.ts` |
| Copied from `web/` and adapted | Arc UI, the foundation (layout, branding runtime, squircles, theme, providers), the API client and hooks | `components/arc/`, `components/foundation/`, `lib/` |

The copied parts started as `web/`'s and are now this app's own: change them here, with the same rules (squircles,
tokens, Carbons/Silicons vocabulary, errors in the server's words). `lib/api/http.ts` maps the API's paths onto the BFF
(`/v1/x` → `/api/accounts/x`), so `lib/api/endpoints.ts` keeps the API's own paths.

## Unified documentation

`/docs` is public and combines Silicon Apps and Silicon Accounts in the public site's frame (server-rendered HTML; see "The public site" below). The documentation engine was copied from `web/` and adapted here: the repository's `docs/` maps to `/docs/accounts`, `docs-apps/` maps to `/docs/apps`, and `lib/docs/landing.md` is the common landing page. Existing page bodies and heading anchors are preserved. Each product has its own navigation, related pages, and previous/next sequence; one search covers both and labels every result by product. Docs keyboard search owns ⌘K/Ctrl-K and `/`, while the portal's command palette remains available elsewhere. Theme switching and the docs menu stay available on small screens.

`pnpm build:docs` bundles all content and emits the original Markdown into `public/docs/<product>/…`; `pnpm dev`, `pnpm typecheck`, and `pnpm build` run it first. `pnpm build:docs --check` validates front matter, page links and anchors. Override source directories with `ACCOUNTS_DOCS_DIR` and `APPS_DOCS_DIR`. `pnpm build:docs --watch` updates the bundle while authoring. The standalone deployment needs generated `public/` and `.next/static` beside its server, as the deployment installer already supplies; it never needs source Markdown at runtime.

`/docs.md` and `/docs/index.md` export the common landing page. `/docs/accounts/index.md`, `/docs/apps/index.md`, and every namespaced `*.md` export their exact source. `/llms.txt` and `/llms-full.txt` are the Carbon's own `llms/llms.md` and `llms/llms-full.md`, bundled by `pnpm build:docs` and served exactly as written (never edit them here); a build without one falls back to the generated index or full text, which use `DEVELOPER_PUBLIC_URL` (or the canonical production origin), never the Accounts service origin. Public docs override the private portal's no-index metadata and declare canonical developer URLs. Unknown docs addresses are checked before streaming and return a real 404.

See `lib/docs/README.md` for the Markdown authoring format. Accounts' former docs routes and the Apps store's former docs routes redirect to this portal; those redirects live in their respective apps.

## The public site

`/`, `/docs/**` and the agent files are for anyone, people, crawlers and Silicons, and stay as close to HTML as possible:

- **Server-rendered, plain links.** The pages are React Server Components; their links are plain `<a>` elements (a public
  page is a full document: no client router state, nothing prefetched). The only client code is three small islands:
  the theme switch and the footer's theme choice (`components/site/theme-controls.tsx`), the docs search
  (`components/docs/docs-search.tsx`, a native `<dialog>`; its trigger is a link to the server-rendered `/docs/search`,
  so search works without script; Tab and Shift+Tab cycle inside it while it is open, and its Esc button is named
  "Esc: close the search"), and one behaviour island (`components/site/enhancer.tsx`: copy buttons, "Show all lines",
  "On this page" marking, keeping the sidebar's current page in view). The header's menu below 900 px is a native
  popover whose close button carries `autofocus`, so opening it moves focus into it and Escape gives focus back to the
  menu button; the footer's theme choice shows keyboard focus as an accent edge. The portal's providers, query client, motion library and Radix layers load only under `app/(shell)` and
  `/sign-in`.
- **One look, two modes.** `styles/tokens.css` (light: `#F7F8FA` / `#292929`; dark: `#02040A` / `#F7F8FA`; brand blue
  `#1F5FB8` for buttons and fills; every text token measured at 4.5:1 or more), BDO Grotesk self-hosted from
  `public/fonts/bdo-grotesk/` (`styles/fonts.css`, SIL OFL 1.1) for display and as the text face where the system has no
  SF Pro. Light, dark or the system's, nothing else. `app/fonts.ts` keeps three Google faces only for apps' branded
  sign-in previews (never preloaded).
- **Search and answer engines.** `lib/seo.tsx` gives every public page its title, description, canonical, Open Graph
  and Twitter card (`public/og.png`, 1200 by 630) and its JSON-LD: Organization and WebSite (with a SearchAction on
  `/docs/search`) everywhere, TechArticle and BreadcrumbList on docs pages (dateModified is the source file's last
  commit, recorded by `pnpm build:docs`), FAQPage and WebPage on the home page. `node scripts/brand/render.mjs`
  re-renders the social image and the icons from `scripts/brand/`.
- **For Silicons.** `/api/docs/search?q=&product=apps|accounts&kind=start|learn|reference|overview&limit=`,
  `/api/docs/pages?product=&kind=` and `/api/docs/pages/{product}/{path}` answer JSON with errors as
  `{"error": {"code", "message", "hint"}}`, described by `/openapi.json` (which links the Accounts and Apps APIs'
  own descriptions). `/.well-known/agent.json` is the A2A card: its skills are those three reads, and it links the
  rest. The site runs no MCP server: `/mcp` is a plain 404.
- **Rate limits** (`lib/site.ts`, `lib/server/rate-limit.ts`): 120 requests a minute to the docs API per client
  address (the first `X-Forwarded-For` entry, which Caddy sets), in this process's memory; every answer carries
  `RateLimit-*` headers and a refused one is 429 with `Retry-After`.
- **Status** (`lib/status.ts`): `/status` (server-rendered, no script of its own) and `/status.json` say whether Silicon
  Accounts (`/readyz` and `/v1/meta` on `https://accounts.teamofsilicons.com`), Silicon Apps (`/health` on
  `https://apps.teamofsilicons.com`) and this site (`/openapi.json` at `DEVELOPER_PUBLIC_URL`) are up, with response
  time, version (this site's is `package.json`'s) and check time. Each check is a GET from this server with a 3 second
  limit; one round is kept for 30 seconds in this process (on `globalThis`, shared by the page and the JSON route). No
  SLA and no incident history are published yet, and the page says so. Linked from the footer, the sitemap, robots.txt,
  the agent card and openapi.json.
- **robots.txt** opens everything public to every crawler, names the answer-engine and agent crawlers, and keeps out `/api/`, `/auth/`,
  the portal's pages, `/sign-in` and the search results. **sitemap.xml** lists the home page, every docs page and
  group, and the two llms files, with `lastmod`.

## The app's tabs

- **Publishing** (`components/publishing/`): seven freely traversable setup steps. Autosaves flush before the portal navigates; a failed save blocks links and tabs. Browser Back/Forward keeps a failed draft in memory and offers a return action. Reloading or closing still requires the browser’s unsaved-work warning. Secrets remain component-local and are never written to storage. Releases, author administration, invitations and history share the same app and shell.
- **Shared identity**: the Apps API validates the first-party developer token’s signature, issuer, expiry and live Accounts token family on every call, then enforces its UUID author/admin policy. The browser never receives or reuses a token directly.

- **Tabs switch in the browser** (`app/app-scope.tsx`, `app/tab-page.tsx`): a switch only pushes the new address, each
  tab is its own chunk, preloaded once the app is on screen; Back and Forward move between tabs.
- **One draft** (`lib/editor.ts`) of the app's sign-in setup is shared by the editor tabs, in three save groups
  (`lib/config.ts`), each saved alone with `expected_version` and one Idempotency-Key per change set:
  - `signin` (Sign-in tab): methods and order, Google and Apple (one click or bring your own, the exact callback URL to
    paste, secrets write-only), redirect URIs, allowed origins, allowed email domains, sign up, remember the browser;
  - `flow` (Details and Flows tabs): `required_fields`, `optional_fields` and `flow`. Ticking a detail asks for it as
    required (the developer switches it to optional); the draft flow follows the details (`reconcileFlow`: a new
    detail joins the last page, a removed one leaves its page, an emptied page is dropped, nothing left = the default
    flow), so the group always saves a valid document;
  - `pages` (Pages tab): the branding variables and every page's words (`copy`: sign-in and sign-up titles and
    subtitles, the Opening page's title with `{provider}` and `{app}`, terms, privacy, support email).
  A 409 or a newer version read while editing is merged leaf by leaf (non-overlapping changes rebase; overlapping ones
  wait for "Save mine on top" or "Discard mine"), 422 field errors land next to their fields, and the server's rules are
  mirrored in the browser (`lib/validate.ts`, flows included: 1 to 8 pages, unique ids, every requested detail on
  exactly one page, short plain titles, subtitles and continue labels). Leaving with unsaved changes asks first.
- **Flows** (`tabs/flows.tsx`): the journey from the button to the app, one card per page (details as chips: drag one
  onto another page or before another chip, or use its menu; reorder pages by their handle or the arrow keys; title,
  subtitle, continue label, layout, id), a review page on or off, inline validation and a live preview.
- **Pages** (`tabs/pages.tsx`, `tabs/hosted-preview.tsx`, `lib/preview-pages.ts`): a live preview of every page a
  Carbon can meet with the draft's methods (sign-in and sign-up versions of the method choice, Opening Google and/or
  Apple, the email and/or phone code page, setting up an account, each flow page, review, the embed buttons on the app's
  own site), light or dark, desktop or phone, painted with the draft through the same branding runtime as the hosted
  pages, "Powered by Silicon Accounts" on every page. Each page says what the hosted page says, word for word
  (`web/components/auth/steps/*.tsx` and `flow-page.tsx`'s footer): change the preview when those words change. Leaving
  the Image background drops an image URL the server would refuse (`backgroundStyleEdits`), so a hidden field never
  blocks saving.
- **App verification** (`tabs/app_verification.tsx`, keeping `/apps/{id}/app-verification` compatible): create a verification for one receiving app (`{receiving_app}`). Its verification and refresh tokens are shown once, kept only in component state, and never stored in the query cache or browser storage. The per-app list labels the wire kinds `app_verification` and `user_verification` as App verification and User verification.
- **Account verification requests** (Sign-in tab, `parts/account-verification-request.tsx`): a reason-only form requests manual review to use an app's own sign-in domain, such as `login.yourapp.com`. GET/POST `/v1/apps/{id}/account-verification-request` use the existing protected Accounts BFF and server-held first-party session; Accounts checks the caller manages the context app. Reasons are trimmed and limited to 5,000 Unicode characters. Failed submissions keep the draft and the same idempotency key for a retry. One pending request belongs to the signed-in account across its apps, so another context shows the original reason and app instead of creating a second request. The receipt shows the retained status and submission date, with an estimated response of up to 48 hours. A submission queues the server's fixed team notifications; the UI does not claim email delivery, approval, or domain provisioning. This action is independent of saving sign-in configuration.
- **Central App verification** (`/app-verification`, `components/developer/verification/`): retained app verifications across apps the signed-in developer currently manages, with issuing-app and status filters and global cursor pagination. Each record opens separately paginated issuance, refresh and revocation history. `GET /v1/me/app-verifications` and `GET /v1/apps/{id}/proofs/{proof_id}/history` use the sealed session through the BFF. Existing app-owner/accepted-author authorization is enforced by Accounts; this grants no broader authority. Active describes the verification refresh lifetime, separate from the latest access token expiry. Expired credentials are removed, but history remains; historical token expiry is marked recorded, derived from historical metadata, or unavailable. Raw tokens and hashes are never returned by these read endpoints. Revocation uses the existing per-app DELETE and refreshes both lists and history.
- **Embed** (`tabs/embed.tsx`): the hosted link (with `intent` and `method`), the iframe, the SDK (one button per method
  or Sign in and Sign up), direct buttons for the app's own site, the server calls, OIDC discovery, and a live preview
  that runs the accounts site's real `/sdk/v1.js`. Apps never pass a Carbon's email or phone.

## Notes

- `output: "standalone"`: deploy `.next/standalone` with `.next/static` copied beside it (what `scripts/dev.sh --prod`
  runs). Every route renders per request (the nonce CSP needs it). A production server refuses to start without
  `DEVELOPER_SESSION_SECRET` (`instrumentation.ts`).
- Refreshing is single-flight per process. Several instances behind a load balancer can refresh the same session at
  once, which Silicon Accounts treats as refresh token reuse (it ends the sign-in): run one instance, or route a browser
  to the same instance, until the API tolerates a short reuse window.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` are the gates; the browser walks are `web/e2e`'s
  developer-site, developer-branding and ux-audit suites (`scripts/e2e.sh --suite developer-site`;
  `developer-site-apps-workspace` has the stack's stand-in Silicon Apps API accept and then refuse the token).
- The branding runtime (`lib/branding/`, `styles/branding.css`, `components/foundation/branding/`) follows the account
  site's own (`web/lib/branding/`): the same Silicon look as the defaults (`DEFAULT_LIGHT`, `DEFAULT_DARK`, which the
  API gives new apps too), the older warm defaults recognised and previewed in the new look (`LEGACY_LIGHT`,
  `LEGACY_DARK`), the site's faces for an app that kept the Silicon look (`data-look="silicon"`). The Pages tab's colour
  fields show the palette the hosted pages paint, so saving the Pages tab of an app that kept the warm defaults stores
  the new ones.
- Arc's local edits here (beyond `web/README.md`'s list): layers opened from plain state (no Radix Trigger: the dialogs,
  drawers and the ⌘K palette) return focus to what opened them (`components/arc/lib/return-focus.ts`); radio cards,
  the colour picker, accordions, chip groups, code blocks and copy fields show keyboard focus in fills and edges; the
  palette's Esc button is named "Esc: close the command palette"; badge tints are opaque (every tone 4.5:1 at 11 px).
