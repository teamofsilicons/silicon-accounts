# Silicon Developer (developer.teamofsilicons.com)

Next.js 16 App Router, React 19, TypeScript strict, pnpm, Arc UI in `components/arc/`, TanStack Query in `lib/query/`.
`README.md` is the guide: the BFF topology, the session cookie, the environment, who owns what. Read it first, and read
the bundled Next docs in `node_modules/next/dist/docs/` before relying on memory.

- The product contract is `../understanding/UNDERSTANDING.md`. Never edit it; it wins over code and specs.
- Words: Carbons and Silicons, and nothing else for accounts or groups of them; name parts of the system by what they
  are (the developer site, the accounts site, the API, the SDK).
- The browser never holds a token: every API call goes through `/api/accounts/*` (lib/api/http.ts maps `/v1/x` there).
- Every rounded surface is a squircle: `data-sq` plus `--sq-r` / `--sq-fill` / `--sq-stroke`, never `border-radius`.
- Before finishing: `pnpm typecheck && pnpm lint && pnpm build`.
