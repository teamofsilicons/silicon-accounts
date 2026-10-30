# Priorities

The account site's redesign on Silicon UI, in order. Every session reads this first and updates it before finishing:
move done items to Done (with the commit), add what came up, keep Now to one item.
Decisions are in [decisions.md](decisions.md); every change is in [log.md](log.md). The product contract is
`../../understanding/UNDERSTANDING.md` (never edited); the design brief is `../../Silicon Accounts Redesign Design Review.md`.

Last updated: 2026-10-30

## Now
1. **Prototype v7, phase 4: Silicons.** List, `/silicons/[uuid]` with Access and Settings tabs (replacing the drawer),
   request and offer pages; Home's Silicon tiles then link to each Silicon. Map: [prototype-map.md](prototype-map.md).

## Next
2. Carry Home's coherence to every page: PageHeader and Section at Home's type scale, pages in a centred column,
   blocks on Home's one card style (foundation/layout, shared). Silicons, Apps, Security and Settings still show the old
   large titles and full-width column inside the new panel.
3. Account command menu on Silicon UI Dialog instead of direct Radix, if Dialog can hold the palette without its own
   title row (else report what is missing).
4. Connected apps: list, `/apps/[id]`, Permissions between apps (`/proofs`).
5. Security (`/security`, `/sign-in-methods` redirects) and Activity.
6. Personal info (`/personal`, the identity card for now) rebuilt as the prototype's rows with every edit dialog.
7. Data & privacy (`/privacy`, `/settings` redirects).
8. Sign-in steps restyled; their suppressions cleared.
9. Clear the remaining tolerated exceptions (eslint-suppressions.json, CSS baseline) as each screen is rebuilt.
10. Identity screens: `pnpm screens --only account-identity` fails while a real API runs on 8589; run with it stopped.

## Waiting on the API
- Everything in [api-gaps.md](api-gaps.md): notifications, data download, a Silicon's activity, apps and sign-in
  stats, wrong-keys alerts, automation, cloud services, per-field sharing.

## Later
- Move `components/foundation/layout` (Page, PageHeader, Section) to silicon-ui's page layout if #24 ships.
- Docs search on silicon-ui CommandPalette instead of direct Radix (the account command menu moves in phase 2).
- Custom surfaces' squircle fallbacks vs silicon-ui corner tokens: decide one system.
- Generalised decision inbox (custodian requests and account verification), once the API lists verification requests.
- The developer portal (`../../developer`, ~24k lines on its own Arc UI copies): its own redesign, after this site.

## Waiting on Anil
- Layout exploration in /__layouts: pick a shell, sidebar, element style and content layout; the choice becomes a decision and replaces item 2's direction.
- Landing, still open from the audit: sign-up as its own job; CLI fixes (`--self-create` default, one-line installer) are outside this site.
- Design review open questions: Proofs folded fully or a
  thin list; inbox placement; theme as a header control.

## Done (recent)
- 2026-10-30 Layout lab at /__layouts: shell, sidebar, element and content layouts explored in the loading state (uncommitted)
- 2026-10-29 Local avatars show their photos: in development the CSP allows the stack's default mock Iris
- 2026-10-29 Silicon UI 0.4.0: faster motion and fluid hover; no site code changes needed
- 2026-10-29 Coherence pass after Anil's review: page panel on a grey canvas; Home in one centred column, one type scale, one card style; Needs you as rows with the recovery-phone check
- 2026-10-29 Home from the prototype: greeting with id, Needs you (warning) or "You're all set", dismissible introduction, Your Silicons (2 + New Silicon), Your apps (4); the identity card moved to /personal (Personal info in the sidebar)
- 2026-10-29 Shell from the prototype: NavList sidebar (Home, Silicons with a waiting count, Connected apps, Security; Developers and Docs at its foot), sticky top bar with "Search your account", bottom sheet under 900 px; dock and its tokens removed; next/link via SiliconProvider (uncommitted)
- 2026-10-29 Prototype v7 mapped to Silicon UI and routes (prototype-map.md); API gaps listed for developers (api-gaps.md) (uncommitted)
- 2026-10-18 Landing as a full landing page: 10 sections on a 12-column frame, sample identity card hero, consent still, FAQ (uncommitted)
- 2026-10-18 Brand assets neutral: app icon on grey #E3E3E3, og image on #FCFCFC in Geist and Hanken (uncommitted)
- 2026-10-18 Silicon UI fonts only: Geist titles and wordmark, Hanken text; serif and pixel faces removed (uncommitted)
- 2026-10-18 Landing rebuilt from the audit, Carbons first: hero, three Carbon reasons, Silicon steps with the STK alert; Docs moved to the footer (uncommitted)
- 2026-10-18 No beige: #FCFCFC page, neutral greys from Silicon UI; docs checklist tick on lucide Check; landing audit written (uncommitted)
- 2026-10-18 Identity card as a form: every element is a field, decoration removed (uncommitted)
- 2026-10-17 Proofs inside Access: each app card lists its live user verifications with Revoke; /proofs has a back link to Apps (uncommitted)
- 2026-10-17 Security pillar: sessions moved from Settings to /sign-in-methods with a way to Activity ("Silicon UI 0.3, Hanken, neutral accent and the Security pillar")
- 2026-10-17 Silicon UI 0.3.0 from npm; Hanken Grotesk body font; neutral ink accent; raw z-index on layer tokens (same commit)
- 2026-10-12 Four pillars in the dock, Developers/Docs in the top bar, attention strip, identity card trim (2f2c184,
  not yet on origin)
