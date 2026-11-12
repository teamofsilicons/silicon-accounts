# Priorities

The account site's redesign on Silicon UI, in order. Every session reads this first and updates it before finishing:
move done items to Done (with the commit), add what came up, keep Now to one item.
Decisions are in [decisions.md](decisions.md); every change is in [log.md](log.md). The product contract is
`../../understanding/UNDERSTANDING.md` (never edited); the design brief is `../../Silicon Accounts Redesign Design Review.md`.

Last updated: 2026-11-10

## Now
1. **Silicons on the prototype** (2026-11-12, uncommitted): /silicons, /silicons/[uuid] (Access, Settings) and /silicons/requests/[id] rebuilt; review with Anil; e2e journeys for the older pages updated 2026-11-12.
## Next
1a. Redesign Your Silicons and Your apps on Home on the chosen type set (Anil, 2026-11-08); the introduction banner is Anil's to redesign.
2. **Prototype v7, phase 4: Silicons.** List, `/silicons/[uuid]` with Access and Settings tabs (replacing the drawer),
   request and offer pages; Home's Silicon tiles then link to each Silicon. Map: [prototype-map.md](prototype-map.md).
3. Finish moving pages to tiles. Page, Section, Surface and SettingsGroup follow the rule and Home's type scale now,
   but some pages still draw their own outlined cards: Security's lists, Connected apps' cards, Silicon tiles, the
   identity card and the empty states. Connected apps is the next likely aside on action (an app's detail beside the
   list).
4. Account command menu on Silicon UI Dialog instead of direct Radix, if Dialog can hold the palette without its own
   title row (else report what is missing).
5. Connected apps redesigned (2026-11-11, uncommitted): `/apps` and `/apps/[id]` built on the prototype; review with
   Anil; rewrite the e2e suites written for the old cards (account-site/apps.ts, imports/k-consent.ts,
   account-site/scope.ts); Permissions between apps (`/proofs`) redesigned on the same rows (2026-11-12).
6. Security redesigned on Home's rules (2026-11-10, uncommitted): review with Anil (its email and phone list restyled
   too); update the e2e suites written for the old page; then `/security` (`/sign-in-methods` redirects)
   and Activity.
7. Personal info (`/personal`, the identity card for now) rebuilt as the prototype's rows with every edit dialog.
8. Data & privacy (`/privacy`, `/settings` redirects).
9. Sign-in steps restyled; their suppressions cleared.
10. Clear the remaining tolerated exceptions (eslint-suppressions.json, CSS baseline) as each screen is rebuilt.
11. Identity screens: `pnpm screens --only account-identity` fails while a real API runs on 8589; run with it stopped.

## Waiting on the API
- Everything in [api-gaps.md](api-gaps.md): notifications, data download, a Silicon's activity, apps and sign-in
  stats, wrong-keys alerts, automation, cloud services, per-field sharing.

## Later
- Publish Silicon UI and update this site's package dependency when Anil resumes the release. Deferred at his request (2026-11-08). The prepared upstream patches are `silicon-ui-select-0.4.1.patch` and `silicon-ui-issues-28-29.patch`; the site uses the tested pnpm patch for 0.4.0 in the meantime.
- Add a Silicon's chevron: Silicon UI's DropdownMenuTrigger draws it at stroke 1.8 (about 1.13 px at 15 px) with no prop, while our icons are at 2. Anil wants 2 everywhere; choose between our own Button trigger via `asChild` (loses the flip on open) or a Silicon UI request for a chevron stroke option (2026-11-07).
- Make a Silicon's optional webhook URL easy to find now it's out of the create wizard; it lives in the Silicon page's settings (decisions.md, 2026-11-07).
- Move `components/foundation/layout` (Page, PageHeader, Section) to silicon-ui's page layout if #24 ships.
- Docs search on silicon-ui CommandPalette instead of direct Radix (the account command menu moves in phase 2).
- Custom surfaces' squircle fallbacks vs silicon-ui corner tokens: decide one system.
- Generalised decision inbox (custodian requests and account verification), once the API lists verification requests.
- The developer portal (`../../developer`, ~24k lines on its own Arc UI copies): its own redesign, after this site.

- **Activity, parked until orgs** (Anil, 2026-11-12: "not yet ready, we'll get back to this with the complete context of the orgs"). Direction: combine the current design (the kind's icon) with B · Who leads from /__activity, because in an org an admin may make changes for a user, so a row must say who acted. One idea to draw then: the kind's icon and the actor's photo together. Playground: /__activity (components/kitchen/activity/).

## Waiting on Anil
- Confirm the Super Visuals licence: Home's introduction now shows BG 110, 102 and 127 (picture cards, 2026-11-11). Say whether to file the Silicon UI IntroBanner request (redesign/requests/silicon-ui-intro-banner.md) (2026-11-10).
- Review the compact experiment (branch `compact`; dev panel → Look → Density to compare) and say what to keep, and whether Home gets more air (2026-11-10).
- File the Silicon UI settings list request (redesign/requests/silicon-ui-settings-list.md, a draft); Personal info's rows move onto it once it ships (2026-11-09).
- Settle the typography in the dev panel's type lab and Edit text, then Copy CSS into styles/tokens.css and the pages' CSS; Silicon UI rules that need a change become tokens or requests (2026-11-09).
- Two Silicon UI sizes sit outside its steps: 21 px on /apps and /activity, 12.96 px in Home's app mark initials; check them in Edit text (2026-11-09).
- Needs you: Sign out on an unused device as primary instead of secondary? Bring the setup steps (recovery phone, email, sign-in provider) back as rows? (2026-11-08)
- Silicon UI request: a tone for Progress, so Needs you's bar can turn amber and red with its time left (2026-11-08).
- The first-visit story headlines are display (36) now; check them on /silicons (2026-11-09).
- Home rebuilt to the prototype: review it, then the other pages follow. Open in prototype-differences.md: canvas and page panel, Silicon photos or marks, when a device counts as not used lately, search as a field or the palette, help and app switcher.
- Landing, still open from the audit: sign-up as its own job; CLI fixes (`--self-create` default, one-line installer) are outside this site.
- Design review open questions: Proofs folded fully or a
  thin list; inbox placement; theme as a header control.

## Done (recent)
- 2026-11-10 PhoneInput country picker no longer clips inside the Security dialog and matches the field radius and corner shape; local patch and upstream artifact refreshed (uncommitted)
- 2026-11-10 PhoneInput audit: unsupported and overlong numbers preserved with validation, restricted default and form/accessibility fixes; local Silicon UI package patch refreshed (uncommitted)
- 2026-11-10 Silicon UI #28 PhoneInput spacing and #29 quiet Dialog close fixed in source and the account site's patched package; release deferred (uncommitted)
- 2026-11-09 Personal info on the page bar and Silicon UI Cards; a settings list request drafted for Silicon UI (uncommitted, web/radix-type)
- 2026-11-09 Radix undone: Silicon UI's typography in Hanken everywhere with our colours, no [data-silicon-ui] wrapper; the type lab and Edit text in the dev panel replace the type sets and the font lab (uncommitted, web/radix-type)
- 2026-11-09 Radix Themes' scale and light Slate in Inter made the site's system in styles/tokens.css (uncommitted, web/radix-type)
- 2026-11-09 Needs you: the device's age under its question, neutral count (uncommitted, web/home-type-needs)
- 2026-11-09 Linear as a fourth dev type set (uncommitted, web/home-type-needs)
- 2026-11-08 Font lab adds body size, weight, letter spacing and line height controls, saved with its existing settings and included in Copy CSS (uncommitted, web/home-type-needs)
- 2026-11-08 Select option highlight aligned in the account site's installed Silicon UI package; Font lab can link display and body fonts (uncommitted, web/home-type-needs)
- 2026-11-08 Four type sizes; Needs you as the countdown list (uncommitted, web/home-type-needs)
- 2026-11-06 Eight-role type scale and a dev type inspector (uncommitted)
- 2026-11-01 Home round two: the introduction as one bordered banner ("One Account for Your Silicons & Apps", round soft dismiss), the ring's spin, breathing halo and click glow, Your apps as simple white cards with Phosphor watermarks, dark Open and new lines (this commit)
- 2026-10-31 Home from a blank canvas: shell, greeting, Needs you, the introduction's cards, Your Silicons and Your apps, dev states panel (44e0dd0)
- 2026-10-30 Needs you lab (/__needs); Home's Needs you as the picked checklist with requests above it (uncommitted)
- 2026-10-30 Inset shell; system font; Carbon pixel avatars by default with an editor in Personal info (save uploads it as the photo) (uncommitted)
- 2026-10-30 Personal info to the prototype: Profile and Contact boxes from its own CSS, whole rows opening their editors by address (uncommitted)
- 2026-10-30 Home to the prototype's element design (cards, rows, icon tiles, Silicon marks, ring, introduction, tiles) in its states; blue accent; Hanken everywhere with a dev font switch; the prototype rules (uncommitted)
- 2026-10-30 Content layout rule on every account page: Page's narrow centred column, aside (Home) and an action's animated side column (SidePanel: a Silicon, Create a Silicon); page and section titles at Home's scale; Surface and SettingsGroup as tiles (uncommitted)
- 2026-10-30 Content layout rule written and prototyped: "Aside on action" in /__layouts (the column glides aside as the side column opens; a bottom drawer under 1024 px) (uncommitted)
- 2026-10-30 Flat shell, tiles, column + aside from the layout lab: the live shell has no panel, and Home's blocks are tiles in a main and a side column with Your details (uncommitted)
- 2026-10-30 Layout lab at /__layouts: shell, sidebar, element and content layouts explored in the loading state (17709c2)
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
