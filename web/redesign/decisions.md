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

- Silicon UI 0.4.0 from npm (Anil, 2026-10-29); the site depends on ^0.4.0. It brings faster motion (durations about
  halved, spring tiers fast/moderate/slow/expressive with the old names kept) and fluid hover in NavList and menus; no
  API changes, so no site code changed. (2026-10-29)

- Layout: flat shell, list sidebar, tiles, column + aside (Anil, 2026-10-30, picked in the /__layouts lab, which stays
  as a place for ideas):
  - The shell is one white surface. The top bar and the sidebar are parted from the page by hairlines; the page panel
    on a grey canvas is gone.
  - Blocks are tiles: the neutral-2 fill, no edge, the overlay radius. Needs you is a plain tile, and its warning badge
    carries the signal, because a warning wash reads as beige.
  - Content layout follows each page's needs. Home is a main column (what needs you, Silicons, apps) beside a side
    column (the introduction, your details). List + detail stays the likely fit for Silicons and apps.
  - Supersedes the coherence pass's panel and canvas and its single 760 px column. (2026-10-30)

- Content layout rule (Anil, 2026-10-30): a page's layout follows how much it holds.
  - Little content: one narrow column (760 px), centred.
  - Content that supports the page from the start (summaries, your details): column + aside. The page widens to
    --page-max and the side column is there on load.
  - Content an action brings up (an item's detail, a form beside a list): the page starts as the narrow centred column.
    - The action opens the side column, and that opening animates: the page widens and the column glides to the start
      (about --duration-expressive on --ease-standard). The side column's panel slides and fades in a beat later.
      Closing runs it back.
    - Focus moves to the panel's Close; Close or Escape shuts it and focus returns to the button that opened it. The
      row that opened it stays marked.
    - Under 1024 px there is no room beside the page, so the same content opens in Silicon UI's bottom Drawer instead.
    - Reduced motion: no animation, the state just changes.
  - Prototyped in /__layouts (Content: "Aside on action"). (2026-10-30)
  - Applied to the account site (2026-10-30), through Page and SidePanel in components/foundation/layout:
    - Home is column + aside.
    - Silicons is the narrow column; a Silicon and Create a Silicon open as the animated side column, replacing the
      drawers.
    - Connected apps, Permissions between apps, Activity, Security, Personal info and Settings are the narrow column.

- The prototype is the design (Anil, 2026-10-30): redesign/prototype-v7.html decides content and element design. Each
  difference with Silicon UI gets a category with a set fix (redesign/prototype-rules.md). Differences are tracked in
  redesign/prototype-differences.md and shared with Anil at the end of every task. Nothing is added that the
  prototype does not show. (2026-10-30)

- Accent and font (Anil, 2026-10-30): the prototype's blue accent (#3460F0) for links, focus and selected fields, with
  its soft blue focus halo; filled buttons stay ink. Hanken Grotesk for all text, titles too, then the system font;
  no Geist. In development, the ⌘K palette's "Font:" commands switch the face to compare (lib/font-preview.ts).
  Supersedes the 2026-10-18 neutral accent and Silicon UI's Geist titles. (2026-10-30)
- Inside the page, elements follow the prototype (Anil, 2026-10-30): white cards with a hairline edge and the title
  inside, rows, icon tiles, Silicon marks; built from Silicon UI components and tokens. Home is the prototype's single
  720 px column again; "Your details" and the side column are gone. Supersedes the grey tiles. A Silicon will open as
  the prototype's own page with tabs, not the side panel. (2026-10-30)

- Personal info is the prototype's page (2026-10-30): a Profile card (photo, name, public id, date of birth, timezone)
  and a Contact card (emails, phones), each row opening its editor in a dialog. The identity card leaves this page
  (it stays as the landing page's sample). The timezone is edited here too; Settings still has it until Data &
  privacy replaces Settings. (2026-10-30)

- Inset shell, system font, Carbon avatars (Anil, 2026-10-30):
  - The shell is the lab's Inset. From 900 px there is no top bar: the sidebar on the grey canvas carries the brand,
    search, the sections, the other sites and the account menu, and the page is a white panel inset on every side.
    Under 900 px, a top bar and a bottom sheet as before. Supersedes the flat shell.
  - The system font for all text, after Hanken Grotesk was tried. Hanken and Geist stay in the development font
    switch.
  - Carbons' default picture is the pixel avatar from Anil's avatar customizer v9, drawn from their uuid. A Carbon
    can customise it (hair, face, clothing) or use a photo. A saved avatar is uploaded as their photo so every app sees
    it; the site draws it live and animated at large sizes (the greeting, the editor), and still everywhere else.
    Silicons keep their marks and photos. (2026-10-30)

- Needs you is a checklist (Anil, 2026-10-30, picked in /__needs). "Finish setting up" lists the prototype's security
  checkup: a second way in (Google or Apple), a verified email, a recovery phone, and only devices you still use. What
  is left comes first with its action, what is done is ticked off, and a progress bar counts them; the card goes once
  all four are done. A device counts as not used lately after 7 days; Keep (remembered in this browser) or Sign out
  answers it. Requests and handovers aren't setup, so they stay as rows in a Needs you card above the checklist.
  (2026-10-30)

## Process
- Keep priorities.md, decisions.md and log.md (this folder) updated with every task; shared-code changes also get a
  README.md note, as the site already does. Why: state lives in repo files, not chat. (2026-10-17)
- Follow web/AGENTS.md and Silicon UI's rules: missing component means stop and report; files you redesign leave
  eslint-suppressions.json and silicon-ui-baseline.json entirely. (2026-10-17)
- Work on branch web/redesign, cut from web/silicon-ui-package (2 local commits not yet on origin). (2026-10-17)
