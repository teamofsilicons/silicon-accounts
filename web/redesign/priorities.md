# Priorities

The account site's redesign on Silicon UI, in order. Every session reads this first and updates it before finishing:
move done items to Done (with the commit), add what came up, keep Now to one item.
Decisions are in [decisions.md](decisions.md); every change is in [log.md](log.md). The product contract is
`../../understanding/UNDERSTANDING.md` (never edited); the design brief is `../../Silicon Accounts Redesign Design Review.md`.

Last updated: 2026-10-17

## Now
1. **Proofs inside Access:** each app's proofs ("user verification") in that app's details on `/apps`; `/proofs` stays
   reachable (a thin list or a redirect: design review open question, my default is a thin list linked from Apps).

## Next
2. **Clear the tolerated exceptions:** 23 files in eslint-suppressions.json (raw elements, mostly auth steps and
   account parts) and the CSS baseline (294 raw values: account apps, proofs, settings, activity modules).
3. **Use 0.3's parts where they fit:** composable DropdownMenu for row menus, soft Button for controls in the top bar,
   compact sizes in dense rows (opt in per component in eslint.config.mjs).
4. **Identity screens:** `pnpm screens --only account-identity` fails while a real API runs on 8589 (the proxy asks it
   whether the mock session is live and serves the landing page). Run screens with the API stopped, or teach the
   proxy's check to accept the screens cookie in development.

## Later
- Command menu and docs search on silicon-ui CommandPalette instead of direct Radix.
- Custom surfaces' squircle fallbacks vs silicon-ui corner tokens: decide one system.
- Generalised decision inbox (custodian requests and account verification), once the API lists verification requests.
- The developer portal (`../../developer`, ~24k lines on its own Arc UI copies): its own redesign, after this site.

## Waiting on Anil
- Design review open questions: Activity in the dock or linked (now linked from Security); Proofs folded fully or a
  thin list; inbox placement; theme as a header control.

## Done (recent)
- 2026-10-17 Security pillar: sessions moved from Settings to /sign-in-methods with a way to Activity ("Silicon UI 0.3, Hanken, neutral accent and the Security pillar")
- 2026-10-17 Silicon UI 0.3.0 from npm; Hanken Grotesk body font; neutral ink accent; raw z-index on layer tokens (same commit)
- 2026-10-12 Four pillars in the dock, Developers/Docs in the top bar, attention strip, identity card trim (2f2c184,
  not yet on origin)
