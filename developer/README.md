# Silicon Developer: developers.teamofsilicons.com

The developer platform: one place where developers maintain everything they build with us. Each of our services keeps
its own backend; this site is one frontend on top of them. It combines Silicon Apps publishing with Silicon Accounts: everything about creating
and setting up an app's authentication (its sign-in methods, Google and Apple, the details it asks for, its flows and
pages, redirect URIs and allowed origins, its user base and imports, its webhook and deliveries, its app verifications, and the
snippets to embed sign-in). The same app workspace also creates apps, saves seven setup steps, uploads and validates packages, manages releases and authors, and publishes through Silicon Apps. Each service retains its own backend. The portal contains no store catalog; discovery and installation live at apps.teamofsilicons.com.

Next.js 16 (App Router, Turbopack) with React 19 and TypeScript in strict mode, pnpm, Arc UI, TanStack Query. The
product contract is `../understanding/UNDERSTANDING.md` (never edited here); nothing in this app overrides it. Built to
move to its own repository later: it imports nothing from the rest of this repository.

```
pnpm install
pnpm dev            # http://localhost:8600 (PORT=… to change)
pnpm typecheck      # next typegen + tsc --noEmit
pnpm lint           # eslint, zero warnings
pnpm build          # next build (output: standalone)
pnpm start          # the production build on $PORT (8600)
pnpm test           # unit tests: sealing, return paths, both proxy allowlists, flows
pnpm exec playwright install chromium
pnpm test:e2e       # common portal and publishing behavior, mocked service contracts
```

Node 24 or newer. Read the bundled Next docs in `node_modules/next/dist/docs/` before relying on memory (`proxy.ts`
instead of `middleware.ts`, async `params`, `PageProps`/`LayoutProps` from `next typegen`).

## Topology: a BFF

The browser only ever talks to this site. The Next server holds the Carbon's Silicon Accounts tokens and calls the
Silicon Accounts and Apps APIs, server to server:

| Path | What it does |
| --- | --- |
| `/auth/sign-in?return_to=/apps/x` | Starts a sign-in: a fresh `state` and PKCE verifier are sealed into a 10-minute httpOnly cookie (`sa_dev_signin`, up to three at once for three tabs), and the browser goes to the hosted sign-in on the accounts site as the first-party app `developer`: `{ACCOUNTS_PUBLIC_URL}/authorize?app_id=developer&redirect_uri={DEVELOPER_PUBLIC_URL}/auth/callback&state&code_challenge&code_challenge_method=S256` (`prompt=login\|select_account` passes through). |
| `/auth/callback` | The state must be one this browser started; the code is exchanged server side (`POST /v1/oauth/token`, `client_id=developer`, no secret, the PKCE verifier), and the tokens are sealed into the session cookie. Failures land on `/sign-in?error=<code>` with fixed words per code (the address's `error_description` is never shown). |
| `/auth/sign-out` (POST) | Revokes the refresh token (`/v1/oauth/revoke`, `client_id=developer`) and clears the cookie. The account site's own sign-in is untouched. |
| `/auth/session` | `{"signed_in": bool}` from the sealed cookie alone (no API call). The pages ask it before `/api/accounts/me`, so a signed-out visit never logs a 401. |
| `/api/accounts/*` | The proxy: `{ACCOUNTS_API_URL}/v1/*` with `Authorization: Bearer <access token>`. Public reads (`meta`, `apps/{id}/public`, `.well-known/openid-configuration`, `.well-known/jwks.json`) go without a token. Account reads: `me`, `me/owned-apps`, `me/app-verifications`. Everything under `apps/{app_id}/…` (the owner routes). Anything else answers 404 `not_proxied`. |
| `/api/apps/*` | Restricted publishing proxy to `{APPS_API_URL}/v1/*`, using the same server-held `aud=developer` access token. Own-app listing requires `mine=true`. Store reviews, install receipts, package resolution, reports and platform registration are not proxied. Media paths use this proxy too, preserving private visibility checks. |
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

**Signed out**: the browser's API client treats a 401 as "signed out" only for `signed_out`, `token_revoked`,
`account_deleted`, `unauthenticated` and `invalid_token` (`lib/query/client.ts`); other 401s, such as
`token_wrong_audience` from an endpoint that refuses the developer platform's token, show where they happen. The shell
then sends the visitor to `/sign-in?return_to=…`.

The server checks the developer audience itself (06-v2 §2): a token with `aud=developer` acts for its Carbon only on
`GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps`, `GET /v1/me/app-verifications` and the app management routes under `/v1/apps/{app_id}/…`.

**Pages' headers** (`proxy.ts`, pages only; the route handlers set their own): a nonce CSP (`script-src 'self'
'nonce-…' 'strict-dynamic'`, `connect-src 'self' <accounts site>` for the Embed tab's live SDK, `img-src 'self' https:
data: blob: <accounts site> <local mock Iris>`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, nosniff, a strict
referrer policy, HSTS in production. An address under an app that names no tab answers the not-found page with a 404.

## Environment

Read at request time (`lib/server/config.ts`), never baked into the build:

| Variable | Default | What |
| --- | --- | --- |
| `APPS_API_URL` | dev: `http://127.0.0.1:4310`; prod: `https://apps.teamofsilicons.com` | Silicon Apps upstream, server to server. |
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
`DEVELOPER_PUBLIC_URL`/`ACCOUNTS_DEVELOPER_URL`, a per-stack `DEVELOPER_SESSION_SECRET` and `NEXT_DIST_DIR`. By hand,
against a running stack:

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
| Apps home | `/` (owned and authored apps; “New app” registers it through Apps and shows the secret once) | `components/developer/home/` |
| An app | `/apps/[appId]/[[...tab]]`: Overview, Publishing, Releases, Authors, History, Sign-in, Details, Flows, Pages, Users, Import, Webhooks, App verification, Embed | `components/developer/app/` (scope, tab frame), `components/developer/tabs/`, `lib/app-tabs.ts` |
| Verification history | `/app-verification` | `components/developer/verification/` |
| Invitations, docs and preferences | `/invitations`, public `/docs`, `/settings` | `components/publishing/`, native shell pages |
| Copied from `web/` and adapted | Arc UI, the foundation (layout, branding runtime, squircles, theme, providers), the API client and hooks | `components/arc/`, `components/foundation/`, `lib/` |

The copied parts started as `web/`'s and are now this app's own: change them here, with the same rules (squircles,
tokens, Carbons/Silicons vocabulary, errors in the server's words). `lib/api/http.ts` maps the API's paths onto the BFF
(`/v1/x` → `/api/accounts/x`), so `lib/api/endpoints.ts` keeps the API's own paths.

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
- **App verification** (`tabs/ata.tsx`, keeping `/apps/{id}/ata` compatible): create a verification for one receiving app (`{receiving_app}`). Its verification and refresh tokens are shown once, kept only in component state, and never stored in the query cache or browser storage. The per-app list labels the wire kinds `ata` and `obo` as App verification and User verification.
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
  developer-site, developer-branding and ux-audit suites (`scripts/e2e.sh --suite developer-site`).
- Arc's local edits here (beyond `web/README.md`'s list): layers opened from plain state (no Radix Trigger: the dialogs,
  drawers and the ⌘K palette) return focus to what opened them (`components/arc/lib/return-focus.ts`); radio cards,
  the colour picker, accordions, chip groups, code blocks and copy fields show keyboard focus in fills and edges; the
  palette's Esc button is named "Esc: close the command palette"; badge tints are opaque (every tone 4.5:1 at 11 px).
