# Silicon Developer (developers.teamofsilicons.com)

Next.js 16 App Router, React 19, TypeScript strict, pnpm, Silicon UI from https://ui.teamofsilicons.com in `components/silicon-ui/`, TanStack Query in `lib/query/`.
`README.md` is the guide: the BFF topology, the session cookie, the environment, who owns what. Read it first, and read
the bundled Next docs in `node_modules/next/dist/docs/` before relying on memory.

- The product contract is `../understanding/UNDERSTANDING.md`. Never edit it; it wins over code and specs.
- Words: Carbons and Silicons, and nothing else for accounts or groups of them; name parts of the system by what they
  are (the developer site, the accounts site, the API, the SDK).
- The browser never holds an Accounts token: account calls go through `/api/accounts/*`, Apps calls through `/api/apps/*`, and Cells calls through `/api/cells/*`. Preserve each BFF allowlist, CSRF checks, sealed-session refresh and streaming behavior.
- Custom application surfaces use squircle fallbacks; Silicon UI components use their registry corner tokens. For custom surfaces: `data-sq` plus `--sq-r` / `--sq-fill` / `--sq-stroke`, never `border-radius`.
- Before finishing: `pnpm typecheck && pnpm lint && pnpm build`.

## Silicon Cells

Cells management is implemented in `components/cells/`, `lib/cells/`, and
`app/api/cells/`. Its backend, Rust client, CLI, browser package, specification
and feature guides live in the separate `silicon-cells` repository. Read that
repository’s `AGENTS.md`, `docs/README.md` and `docs/release-0.1.0.md` when changing
this integration; do not build a second Cells dashboard.

Use the installed Silicon UI components. Compiled `.wasm` uploads preserve the
original bytes and validate `wasm32-wasip1`/WASI Preview 1, `_start`, the 1 MiB
bundle limit and `cells.function.v1`; they do not compile uploaded source.
Maintain JavaScript/TypeScript editing, versioning, invocation and rollback.

The 29 October 2026 production upload/invoke acceptance passed in the user’s main
Chrome, and its disposable cell was ordinarily deleted. That specific `c:saket`
UI exception does not authorize using Carbon tokens through CLI/API. Follow the
shared default `si:saket-agents` identity rules for other authorized app work.
Do not extract cookies or browser profiles to substitute for sign-in.

The public documentation builder currently includes Accounts and Apps. Do not
claim `/docs/cells` is published until the Cells collection is integrated and
verified in the deployed portal; repository guides and CLI-bundled docs exist.
