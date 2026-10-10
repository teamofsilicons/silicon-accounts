<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Silicon Accounts web

The account site: Next.js 16 App Router, React 19, TypeScript strict, pnpm, Silicon UI from https://ui.teamofsilicons.com in `components/silicon-ui/`, TanStack
Query in `lib/query/`. `README.md` is the guide: topology, who owns which routes, conventions, hooks, squircles,
branding runtime, SDK, the Arc local-edit log, the style guide and screenshots. Read it before changing anything.

- The product contract is `../understanding/UNDERSTANDING.md`. Never edit it; it wins over code and specs.
- Words: Carbons and Silicons, and nothing else for accounts or groups of them (UNDERSTANDING.md's vocabulary); name
  parts of the system by what they are (the account site, the API, the SDK).
- Work inside your area (`app/(area)/…`, `components/<area>/…`); shared code (`components/foundation`, `lib`, `styles`,
  `proxy.ts`, `next.config.ts`) changes on purpose and with a note in README.md.
- Data goes through the hooks in `lib/query/`; errors show the server's message and hint; mutations keep one
  Idempotency-Key per logical action.
- Custom application surfaces use squircle fallbacks; Silicon UI components use their registry corner tokens. For custom surfaces: `data-sq` plus `--sq-r` / `--sq-fill` / `--sq-stroke`, never `border-radius`.
- Before finishing: `pnpm typecheck && pnpm lint && pnpm build`, and look at `pnpm screens --only <yours>` in both
  themes at 1440 and 390 px.
