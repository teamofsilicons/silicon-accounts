# Decisions

What Anil has decided for the account site's redesign, and why. Read before every task.
Format: `- <decision>. Why: <reason>. (YYYY-MM-DD)`

## Scope
- Redesign the account site (`web`) first; the developer portal (`developer`) later. Why: Anil chose to start with the
  account site. (2026-10-17)
- Build the design review's IA: Security pillar (sign-in methods + sessions + activity), Proofs inside Access, top bar
  for tools and other sites, dock for account destinations only. Why: Anil asked for these three. (2026-10-17)

## Design
- Silicon UI 0.3.0 published to npm (Anil, 2026-10-17); the site depends on ^0.3.0. Why: keeps CI and deploys on npm. (2026-10-17)
- Text face: Silicon UI's Hanken Grotesk (loaded with next/font as --font-hanken-grotesk); BDO Grotesk no longer
  preloaded. Accent: neutral, the page's warm ink (#1E1E1C, paper in dark), not silicon-ui's cool grey neutral.
  (Paper colours, Hedvig titles and Geist Pixel labels were kept then; replaced 2026-10-18, below.)
  Why: Anil chose Hanken and a neutral accent, matching Silicon Docs. (2026-10-17)
- Hosted sign-in pages keep their own default branding (lib/branding/defaults.ts, brand blue #1F5FB8): apps change it
  per app, so it is not the account site's theme. (2026-10-17) (my call, confirm)
- Security pillar = sign-in methods + "Where you are signed in" + a way to Activity, on /sign-in-methods (title
  "Security"); URL unchanged. Settings keeps Local time and Delete account, with a pointer to the new home of
  sessions. Activity stays its own page, linked from Security. (2026-10-17) (Activity placement: my default, confirm)

- No beige: the page is #FCFCFC and every fill, border and text grey is neutral, from Silicon UI's own grey scale
  (styles/tokens.css; --text-muted stays #666666 because silicon-ui's --neutral-7 is under 4.5:1 on muted fills). The
  dark block is silicon-ui's neutral dark. Theme colour and manifest are #FCFCFC. Not changed yet: the app icon's
  cream square (#EDE8E0 in public/icon.svg, scripts/brand/*, brand-mark.tsx, branding.tsx, hosted-frame.tsx) and the
  hosted sign-in pages' default branding (lib/branding/defaults.ts, #FFFDF9, stored per app). Why: Anil: "we don't
  use beige anymore". (2026-10-18)
- Icons are lucide-react, everywhere. Brand marks (Google, Apple, GitHub, our own) and diagrams stay hand-drawn
  because lucide has no such glyphs. Why: Anil. (2026-10-18)
- Screens are judged with Anil's audit framework (purpose tree → screen spec → element audit → repetition → model
  leaks → placement → proposal); audits live in redesign/audits/. Why: Anil asked for it, starting with the landing
  page. (2026-10-18)

- Landing: Carbons first. The hero's primary action is the Carbon's, so the Carbon's reasons follow it; Silicons jump
  past with "I'm a Silicon". Built as the audit's proposal (redesign/audits/landing.md), including the lede's one-time
  gloss "Carbons are people and Silicons are their AI agents", which Anil confirmed: the one place the site says what
  the words mean. Why: Anil chose Carbons first and kept the gloss. (2026-10-18)

- Fonts are Silicon UI's only: --font-display (Geist) for titles and the wordmark, --font-body (Hanken Grotesk) for
  everything else, with the library's tracking; titles weigh 500 as in Silicon UI. Hedvig Letters Serif and Geist
  Pixel Square are gone from the site (tokens, preloads, @font-face); --font-mono stays a monospace stack because
  Silicon UI has none. Supersedes the 2026-10-17 note keeping Hedvig titles and Geist Pixel labels. Not changed: hosted
  sign-in branding's BDO Grotesk (lib/branding/apply.ts), the og image (scripts/brand/og.html) and the developer site.
  Why: Anil: "use design system fonts". (2026-10-18)

- Brand assets follow the site: the app icon is the #181818 glyph on Silicon UI's grey #E3E3E3 (--neutral-4), grey on
  #181818 in dark, everywhere it is drawn (scripts/brand/*.svg, public icons and favicon, brand-mark.tsx,
  branding.tsx, hosted-frame.tsx, the SDK's mark); the og image is #FCFCFC with Geist and Hanken from
  @fontsource-variable (dev dependencies, as Silicon UI's README names them) and ink titles. Why: Anil. (2026-10-18)

- Landing follows the usual landing structure, laid out on a 12-column frame (redesign/audits/landing.md, "Structure
  and layout"): a first-screen hero with a sample identity card, problem, For Carbons, what an app sees, For Silicons,
  safe by design, questions, closing CTA. No social proof until real data exists. The identity card's faces moved to
  components/account/identity/faces.tsx (slots for the editable parts) so the landing can show a sample without a
  QueryClient. Why: Anil asked for a full landing page, section by section; card and no proof were his picks.
  (2026-10-18)

- Tab icon: main's mark alone with no tile (PRs #12-#13), in #181818 on light tab strips and Silicon UI's grey #E3E3E3
  (--neutral-4) on dark, not cream; install icons keep the mark on the grey tile. Why: Anil, when this branch was cut
  from main (2026-10-29).

- ~~Layout, navigation, sidebar and page frame are on hold~~ (2026-10-17). Lifted 2026-10-29, below.

- Build the lead designer's prototype (Silicon Accounts Prototype v7) on Silicon UI: its structure, flows and copy;
  Silicon UI's components and tokens only. Shell: top bar (brand, "Search your account", app switcher, avatar menu) and
  a left section list (NavList), replacing the dock and the four pillars. Sections: Home, Silicons, Connected apps,
  Security, Personal info, Data & privacy (Notifications once its API exists). Colour by role on Silicon UI tokens
  (needs you --warning, good --success, Silicons --silicon-gradient); the prototype's beige canvas and blue accent are
  not used. Parts with no API are left out and listed for developers (api-gaps.md). Built screen by screen from
  prototype-map.md. Supersedes the four-pillar dock and the layout hold. Why: Anil chose the prototype's sidebar,
  Silicon UI colours, and leaving no-API parts out. (2026-10-29)

- ID card as a form: every element on the card is a field that says something about the account; nothing is added
  for decoration. Front: issuer, card type (Carbon or Silicon identity card), a holder line (Silicons a Carbon looks
  after, or a Silicon's custodian), status (Valid, Waiting for custodian, Unclaimed), photo in crop marks (the drop
  target), Name, Id, Issued, and the apps signed into. Back: emails, phones, date of birth (Carbons only; a Silicon's
  is its Issued date), Card no. (the uuid) and a Silicon's webhook and STK. The guilloche, wafer, ghost portrait and
  MRZ lines tried before were removed. Why: Anil: "it's not a decoration, it's a form". (2026-10-18)
- Proofs live inside Access: an app's card on /apps lists the user verifications that app holds to act for you (where,
  what it may do, until when, Revoke). /proofs stays as the full view (diagram, token countdown, ended ones), with a
  back link to Apps and still in ⌘K. Why: a proof only exists because of an app relationship (design review).
  (2026-10-17) (keeping /proofs as a full page: my default, confirm)

- Coherence with the prototype: the page is a white --surface panel on a grey --canvas (neutral-2, so NavList's hover
  still shows), the top bar and sidebar on the canvas; Home is one centred 760px column with one type scale (2xl
  display title, base block headings, sm row titles and details) and one card style (hairline --border, container
  radius) for every block; Needs you is a card of rows (custodian requests reviewed in a dialog; "Add a recovery phone"
  for a Carbon with no phone). Why: Anil found the first Home incoherent next to the prototype's new-account screen.
  (2026-10-29)

- Profile pictures are Silicon UI's circles: the 30% squircle override (--avatar-radius, --avatar-corner-shape) is
  gone. Why: Anil saw the account menu's picture as a squircle with circular hover, press and loading states (Silicon
  UI's UserMenu draws them as circles); circles also match the prototype. (2026-10-29)

## Process
- Keep priorities.md, decisions.md and log.md (this folder) updated with every task; shared-code changes also get a
  README.md note, as the site already does. Why: state lives in repo files, not chat. (2026-10-17)
- Follow web/AGENTS.md and Silicon UI's rules: missing component means stop and report; files you redesign leave
  eslint-suppressions.json and silicon-ui-baseline.json entirely. (2026-10-17)
- Work on branch web/redesign, cut from web/silicon-ui-package (2 local commits not yet on origin). (2026-10-17)
