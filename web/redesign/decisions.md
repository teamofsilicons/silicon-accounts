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

- Panel shell (Anil, 2026-10-30): the lab's Panel, as in the prototype. The top bar (brand, search, the account menu)
  and the sections sit on the canvas, and the page is a white panel beside them. Under 900 px, a top bar and bottom
  sheet, with the page full bleed. Supersedes the inset shell from earlier the same day. (2026-10-30)

- Homepage frame (Anil, 2026-10-30): the top bar is the logo on the left, search centred, the account menu on the
  right. Below it, the sidebar and the page sit in 8 px of padding (`--space-related`) with 8 px between them. The
  page is a white box with an 8 px round corner and a 1 px hairline (`--border`). The squircle radius token is 14 px,
  so this corner is set at 8 px. Under 900 px the
  page stays full bleed. The hairline is `#E5E7EB` as Anil asked (a local `--page-line` in shell.module.css, not a
  token; dark keeps `--border`): confirm whether `--border` itself should become it. (2026-10-30)
- The page box scrolls, not the window (Anil, 2026-10-30): from 900 px the shell is the window's height and holds still
  (top bar, sidebar, the box's edge); only the page box scrolls, its rubber-band kept inside it, and a new page starts
  at its top. Under 900 px the document scrolls as before, so the phone's address bar can collapse. (2026-10-30)
- Sidebar width in steps (Anil, 2026-10-30): dragging the page box's left edge snaps the sidebar to 200, 248 or 296 px,
  never free; the site's own handle until Silicon UI's ResizablePanels has steps. (2026-10-30)
- Home's column (Anil, 2026-10-30): Page's narrow centred column, 720 px (--page-narrow, the prototype's width), as
  every account page; the identity heads it, at its top left. (2026-10-30)
- Home's first element (Anil, 2026-10-30): at the column's top left, the Carbon's picture as a large squircle (Avatar
  xl, 88 px) in its ring, with "Welcome, <first name>" over the Carbon id to its right; the id is a
  small grey chip (soft xs Button, mono) that copies on click, and "Member since <month year>"
  (muted text, the account's creation date in its time zone) on its own line under it. The email is set aside for now. Nothing else on Home yet. (2026-10-30)
- Home's structure, direction B: Silicons first (Anil, 2026-10-31; direction A, live cards with actions, was tried
  and dropped: the cards aren't designed to hold actions). Greeting, then Needs you when something waits, then the
  three cards as a plain introduction (title and line only, dismissible), then Your Silicons and Your apps. Your
  Silicons: with none, one tall banner (Anil, 2026-10-31: its own forest-to-sand gradient, off the brand, with grain;
  a 36 px Geist Serif heading "Create your first Silicon" on two lines, what a Silicon is in medium, then Create a
  Silicon; under the "Your Silicons" heading); with some,
  two tiles (mark, name, si:id) and a New Silicon tile, "See all" in the heading. Your apps (Anil, 2026-10-31): the popular apps, Briefcase, DM and
  Ting, as simple white cards with character: an ink Phosphor icon (20 px, light) beside the app's name in one row,
  its line (two lines held), then Open (dark primary: yours and ready) or Try (white secondary: a suggestion), and the same icon large, thin and faint
  running off the corner as a watermark that drifts on hover; name and address from the API's public app details; the prototype's one-liners; Open when
  signed into, else Try, going to the app), then up to four other apps as small tiles. No "You're all set". (2026-10-31)
- Home's introduction for a new Carbon (Anil, 2026-10-30): the prototype's content ("One account for every Team of
  Silicons app"; You, Silicons, Apps and their lines) in a new design: a soft grey tile (canvas fill, no edge) under the
  greeting, title and dismiss in one row, then the three side by side, each a 36 px picture (your photo, a Silicon
  mark, a white tile with the apps grid icon) beside a medium label over one secondary line. Dismissal is remembered
  in this browser. (2026-10-30)
- Home's Needs you, designed for the new Home (Anil, 2026-10-31): under the greeting, before the introduction, only
  when something waits: a Silicon's custodian request (Decline / Review), a handover (Review), or a device unused for
  7 days ("Still using …?", Keep / Sign out). The introduction's grey tile with its rows as one white list; "You're all
  set" as a slim green strip otherwise. Setup (a second way in, email, recovery phone) is off Home for now: Home should
  push the core (making Silicons), not setup; the step cards are archived in redesign/archive/setup-step-cards.md.
  (2026-10-31)
- Intro copy (Anil, 2026-10-31): title "One Account for Your Silicons & Apps" (an h3, the banner's); You "Your id across apps: <c:id>";
  Silicons "Give an AI agent its own account."; Apps "Apps for delightful agent creation and interaction." (2026-10-31)
- The intro's three items become three different cards (Anil, 2026-10-30). You: a small card showing every Carbon as
  their pixel avatar (photo or not; the figure alone, standing at the lower right) on a 135° gradient of the avatar's
  own palette (k-means, 4 colours, dark to light, as his gradient generator), the words at the top left, light on a dark
  palette. The photo version is archived in redesign/archive/you-card-photo.md (trying it). Silicons: the same card (22 px title over a 12 px line, words top left), on the Silicon
  colours (violet into teal, deepened at the top left), the white Silicon spark large at the lower right. Apps:
  the same card on the site's blue accent (deepened at the top left) into the Silicon sky blue, the apps grid solid and
  white at the lower right. Silicons and Apps next. (2026-10-30)
- Home's ring moves (Anil, 2026-10-31): it turns once every 6 s inside a halo of its own colours that breathes (4 s);
  a click on the picture or on the introduction's You card makes the halo flare and the ring spin six times as fast for
  about a second. Still when motion is reduced. (2026-10-31)
- Home's ring takes the picture's colours (Anil, 2026-10-30): up to four distinct colours read from the picture
  (lib/picture-colours.ts), by hue and by shade, made vivid; a picture of one hue shows its deep, middle and light
  shades, never hues it does not have; a photo the image server will not let the page
  read keeps the Silicon colours. (2026-10-30)
- Blank canvas (Anil, 2026-10-30, branch web/blank-canvas): Home is redesigned from nothing. The shell stays; Home's
  content box is empty (the previous Home stays in components/account/home, unused). (2026-10-30)

- App card lines (Anil, 2026-10-31): Briefcase "Keep and share files with your Silicons."; DM "Message people and
  Silicons directly."; Ting "Get notified when your Silicons need you." (2026-10-31)
- Home's headings (Anil, 2026-10-31): the greeting is the h1 (36 px); every section (Needs you, the introduction, Your
  Silicons, Your apps) is an h2 at 22 px medium with display tracking; a heading inside a section is an h3 (the
  first-Silicon banner's). Level follows the outline, size follows the look. (2026-10-31)
- Home's spacing (Anil, 2026-10-31): one section pattern everywhere: the heading (and its count) on the page, 16 px
  above the section's content (the introduction is the exception: a banner, its heading and round soft dismiss inside
  its grey tile, the dismiss's 28 px circle on the tile's 16 px padding); 48 px between sections; 48 px above the greeting and below the last section.
  Padding in three steps: container tiles 16 px, the hero banner 32 px, small tiles and rows 12 px. (2026-10-31)
- Silicons, layout B (Anil, 2026-11-01): /silicons is the heading "Silicons" (New Silicon beside it once there are
  any), Waiting for you (Home's request rows), then Your Silicons as cards, each in its Silicon's own colour pair (name,
  si:id, when its key last changed, a status when not simply active), and a New Silicon card; on a first visit, stories instead
  (Anil, 2026-11-01: one idea at a time, not everything at once). Six beats, each a Geist Serif headline, one line, its
  own colour and one picture: 1 "An AI agent with an identity of its own." 2 "It gets an id, like yours." (your c:id
  beside si:something) 3 "It signs in with its own key." (STK, shown once) 4 "It signs in to apps by itself." 5 "Every
  Silicon has one Carbon looking after it." (your picture) 6 "Three ways to start.": make one here, start from a Starter
  (Silicon Starter, the registry of ready-made Silicons, run with Silicon), let one ask you (your c:id). Segmented bars;
  five seconds a beat (the last stays); tap right or → for next, left or ← for back, hold to pause; Back / Next
  buttons; still with reduced motion. With Silicons, Add a Silicon (Silicon UI's DropdownMenu) offers the same three. Each Silicon has its own page, /silicons/[uuid], replacing the drawer: a
  back link, a hero in its colours (name, si:id, status, in your care since), then its settings (name, uuid, timezone,
  born, photo, id; STK; webhook; custodian; delete). The prototype's Activity and Access tabs wait on the API
  (api-gaps.md 3–8). (2026-11-01)
- No side panels (Anil, 2026-11-01): actions open a page or a modal, never a column beside the page. Create a Silicon
  is its own page, /silicons/new (the form in a card; creating it goes to the new Silicon's page, where its STK waits,
  shown once; Cancel goes back); older ?new links redirect there. A Silicon's settings already have their own page.
  (2026-11-01)
- Dev states (Anil, 2026-10-31): while developing, a States panel puts the site in any state (account, Silicon
  requests, devices, Silicons, apps, network) by answering the API's reads with made-up data, development only, like
  the prototype's scenario controls. (2026-10-31)
- Story shots (Anil, 2026-11-01): each of the first five story beats has a small animated product shot built with
  Benji Taylor's stageshow kit (vendored at components/foundation/stageshow, MIT, not edited, outside lint), in the
  site's own look and words, in the card's top-right lined up with the bars (in the flow above the words on a card
  under 540 px). 1: Scout's card arrives in Your Silicons; 2: "scout" typed into the Id field, "si:scout is
  available."; 3: the STK card, key shown then copied; 4: the CLI signs Scout in and gets a short-lived token for
  Briefcase (a Silicon never sees an app's sign-in page, so no "Continue as" screen); 5: Scout's request accepted, its
  mark turning active. Each plays once; its still is the payoff; beats run 5 to 7.5 s; the card is 480 px tall.
  (2026-11-01)

## Process
- Keep priorities.md, decisions.md and log.md (this folder) updated with every task; shared-code changes also get a
  README.md note, as the site already does. Why: state lives in repo files, not chat. (2026-10-17)
- Follow web/AGENTS.md and Silicon UI's rules: missing component means stop and report; files you redesign leave
  eslint-suppressions.json and silicon-ui-baseline.json entirely. (2026-10-17)
- Work on branch web/redesign, cut from web/silicon-ui-package (2 local commits not yet on origin). (2026-10-17)
