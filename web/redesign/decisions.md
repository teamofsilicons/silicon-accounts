# Decisions

What Anil has decided for the account site's redesign, and why. Read before every task.
Format: `- <decision>. Why: <reason>. (YYYY-MM-DD)`

## Scope
- Redesign the account site (`web`) first; the developer portal (`developer`) later. Why: Anil chose to start with the
  account site. (2026-10-17)
- Build the design review's IA: Security pillar (sign-in methods + sessions + activity), Proofs inside Access, top bar
  for tools and other sites, dock for account destinations only. Why: Anil asked for these three. (2026-10-17)

## Design

- **Tabs have a 2px frame (2026-11-13).** Anil chose `/__tabs` version A: 2px around the tabs instead of 4px, the keyboard ring inside the tab, corners concentric; tab widths, height and the 4px between them unchanged. Why: the 4px frame made the strip heavy beside the page's controls. In Silicon UI's Tabs through the local patch, filed as teamofsilicons/silicon-ui#32.
- **The account command menu uses Silicon UI Dialog with a hidden accessible title and top placement (2026-11-12).** The palette draws the visible surface, while Dialog owns the modal layer and focus return. Why: Silicon UI #31 supplies the missing headerless mode, so the account menu no longer needs a direct Radix layer.

- **Security on Home's rules, in the prototype's order (Anil, 2026-11-10).** The pinned page bar (as Connected apps);
  Checkup (a recovery phone when there is none, a device not used lately: Keep or Sign Out; hidden when nothing needs
  you), Silicon keys (when each key was made, Change on the Silicon's page), Your sign-in (Google, Apple, Email code,
  Text code; Edit opens the email or phone list in a dialog), Devices (this device marked, Sign Out on the others, Sign
  Out of All Other Devices), then one row to Activity. Every section is Home's boxed list. The old page
  (sign-in-methods.tsx) is no longer routed; its parts are reused.
- **Text greys in even steps, ladder C (Anil, 2026-11-10, from /__text).** OpenAI's text went 4 → 40 in lightness
  (#0D0D0D → #5D5D5D), too big a jump; compared with Refactoring UI's palette (15, 24, 34), the text greys now step
  about 12 apart: --foreground #1B1B1B (10), a new --text-soft #353535 (22) for the line under a name (an app's
  description or address), --text-secondary #505050 (34) for facts and quiet links, --text-muted #8E8E8E (59) for ids.
  Muted stays under 4.5:1 for now. On Home, --text-soft is the app cards' lines and Needs you's line under a title.
- **Home has no apps list and, for now, no account cards (Anil, 2026-11-12).** Connected apps lists the apps, so Your
  apps left Home. Cards to Connected Apps, Security and Personal Info (each with one live fact) were tried and parked
  in /__account until Anil comes back to them (priorities.md, Later). Home's identity block is the "Your profile"
  region. The entry below is history.
- **The hosted sign-in pages are on the type roles (Anil, 2026-11-13).** Every text uses a role and its tracking, as
  the account site does: the step title display (h1 when compact), descriptions small in --text-soft, labels label,
  notes and errors hint in --text-secondary. styles/branding.css declares the roles again on .sa-brand so they take each
  app's fonts. Silicon Accounts' own sign-in has no "Powered by"; a heading that names the app hides the header's name.
- **Every Silicon has a pixel avatar (Anil, 2026-11-12).** From his mosaic generator's Silicons tab (eight forms,
  fifteen palettes; lib/silicon-avatar.ts), drawn from the Silicon's uuid so it never changes; its Carbon will be able
  to change it later (the API keeps no look yet). SiliconMark draws it everywhere a Silicon shows (on a light wash of
  its palette; the gradient-and-spark mark stays as SiliconSparkMark). Home's Your Silicons are cards with the avatar in a 3:2 art area over a
  short strip with the name and si:id (2026-11-13; first 60/40), blended by a wash of the avatar's palette (A of four in
  /__silicon-cards; Anil asked for the background to blend or wash with the Silicon's colours on 2026-11-13); The Silicons page uses the same cards (2026-11-13), with a badge beside the name only for Handing over or Waiting for
  a custodian (Active shows none). Home has no New Silicon card (2026-11-13); it shows the first three. Two a row on a
  phone. Save Avatar uploads a transparent animated GIF with the editable settings in its comment; its first frame is the still picture. An older opaque PNG is recognised by its mosaic cells and its gradient background is removed in the browser, so it keeps the same card artwork without changing the stored photo. The card samples the saved creature's actual colours for its wash; a new GIF uses its first frame. Ordinary photos still fill the art (2026-11-13).
- **Silicon avatars keep the Alive motion (Anil, 2026-11-13).** Shimmer, glances, blinks and a twinkling halo; never up
  and down. The other styles (colour wave, sparkle, watcher, glow, on hover) stay in /__silicon-motion.
- **The sidebar's sections in title case (Anil, 2026-11-12):** Home, Silicons, Connected Apps, Security, Personal Info,
  Data & Privacy (lib/navigation.ts SECTIONS, so the phone sheet, the ⌘K menu and the phone bar's title follow). The
  pages' own titles stay as they are.
- **Home's apps are one grid, for now (Anil, 2026-11-10).** Yours + Try (a separate Try an app section, as Adobe,
  Microsoft 365 and Atlassian do) was tried and taken out: apps sit together in Your apps, the ones you sign into first
  (most recent first, Open), then Briefcase, DM or Ting not used yet ("Not signed in yet", Try), up to six, every one
  the same tile + footer card. Which apps show there is still open: Anil is thinking of a different logic. App icons
  are Anil's (public/icons), 40px with a light hairline. The card: 8px all round; its height comes from a minimum (the top at least 112px, the
  words at its top and room below), not padding, so every app card is one height. The name and its line sit beside
  the icon (the line below the icon was tried and taken back; both in /__cards); in "Signed in 2 weeks ago" the time
  is in the text colour, since it is the information.
- **Home's app cards are tile + footer (Anil, 2026-11-11).** Icon, name and description on top; a footer with when you
  last signed in and Open or Try. For apps you use, the description stands in for what's new in the app (unread
  messages, notifications) until the apps give a count; the account API has none.

- **Home's empty sections are hidden, for now (Anil, 2026-11-11).** With no Silicons, Your Silicons doesn't show (no
  first-Silicon banner); with no app signed in to, Your apps doesn't show (no Try suggestions). The introduction above
  presents both until the account has them.
- **Home's introduction shows only while it's useful (Anil, 2026-11-11).** It hides once the account has a Silicon and
  has signed in to an app (the two things it introduces), as well as when dismissed. The dismissal is still this
  browser's; keeping it on the account needs a place on the server.

- **The content column is 896px (Anil, 2026-11-11, branch compact).** `--page-narrow` went from the prototype's 720px
  to 800px, 960px, then 896px (Tailwind's max-w-4xl, 56 × 16): every narrow page widens, and Home's three-card rows
  get about 291px a card (two a row, 442px).

- **Home's introduction is the picture cards (Anil, 2026-11-11).** Picked in /__banner: no background or box, the h3
  "One Account for Your Silicons & Apps" with a quiet dismiss, three cards of one design in Home's column (about 230px
  each), each a 16:9 Super Visuals picture (BG 110, 102, 127; nothing on the picture) over its title and one line, the
  same words as before. It replaces the gradient cards (kept as HomeCardsView for the lab). The pictures' licence is
  still to confirm before this ships.

- **Button labels in title case (Anil, 2026-11-11).** Every button's label is in title case, as Apple does ("Sign Out",
  "Create a Silicon", "Go to Your Account"): each word capitalised except articles, short conjunctions and short
  prepositions in the middle (a, an, the, and, or, to, of, in, on, for, with…), unless they're part of the verb ("Sign
  In", "Hand Over"); ids and acronyms as they are (c:anil, ID, UUID). Only button labels (Button, ButtonLink, the
  actions of status pages and error cards); headings, fields, menus and body text stay in sentence case.

- **The introduction banner is a template, proposed to Silicon UI (Anil, 2026-11-10).** Every TOS app shows a new
  person a banner, so it belongs in Silicon UI, named by its template (how it's laid out) and not by its picture:
  `checklist`, `cards`, `panel`, `spotlight`; any picture fits any template, with `tone` light or dark. Kept simple: one
  action (the next step's), done steps struck through in their own colour, one line when all are done, always
  dismissible. Prototype: `/__banner` (`components/kitchen/banner/intro-banner.tsx`); request draft:
  `redesign/requests/silicon-ui-intro-banner.md`. Home keeps its current banner until a template is chosen.

- **Lines between rows are straight (Anil, 2026-11-10).** A divider is never the edge (border or shadow) of a rounded
  element, because it bends with the corners. A rounded row (for a hover or selected fill) draws its line as its own
  1px element, or hides the line beside it while filled; an unrounded row or its container may use a border.

- **Compact, uniform across TOS (Anil, 2026-11-10; branch `compact`, an experiment).** TOS's apps share one
  interface, and the ecosystem's apps (the Interface app especially) are control panels, so the interface is designed
  for compactness; home still feels like home, which means simple. Simple is few kinds of things, always the same, not
  extra space. The sidebar showed the feeling but is not the source of truth. Decided so far:
  - text keeps a 16 base (Linear's 13–14 was too small);
  - controls one step shorter (32 / 36 / 40), the larger spacing steps one step down (sections 32 apart on Home, was
    48), the title roles one step down (page titles 22, sections 18, items 16);
  - Home keeps a bit more air in the end, but first it shows the shared spacing, to see what it changes;
  - the dev panel's Density switch compares it with the comfortable scale before.
  Still to decide: whether this moves into Silicon UI (its control heights and spacing are what make it uniform across
  apps), rows over cards, quieter buttons, wider layouts, and how this updates the v7 prototype as the design.
- Typography to compare (Anil, 2026-11-08): OpenAI's platform and Raphael Salaja's site, read from their computed styles,
  as dev type sets (lib/type-sets.ts). OpenAI: page title 36/590, section 20/600/32, item 16/500, body 16/400/24, rows
  14/400/20 at -0.16px, badge 12/600; canvas #F3F3F3, white surfaces, text #0D0D0D and #5D5D5D, borders
  rgba(13,13,13,.12). Its face, OpenAI Sans, can't be bundled, so Inter stands in. Raphael: Inter (cv01, ss03), all 14/400,
  hierarchy by colour (#21201C, #63635E) on warm #FDFDFC. Home's order stays: the banner is for new accounts only and
  may be the loudest; Anil redesigns it. Your Silicons and Your apps get redesigned once a set is picked. (2026-11-08)
- Needs you's device row (Anil, 2026-11-09): its age is a second line under the question, "Last active 9 days ago",
  instead of sitting in the time column, which is kept for deadlines; the count badge is neutral, since a count is not a
  warning. The row title stays h3 and the buttons stay as Silicon UI ships them.
- One whole system instead of our mix (Anil, 2026-11-09, branch web/radix-type): Radix Themes' type scale and Radix
  Colors' light Slate, in Inter, tried as a Radix type set and then made the site's own in styles/tokens.css (replacing
  the four sizes of 2026-11-08, our greys and the system font; Inter is preloaded; Home's `.silicon-ui-fonts` is gone). Page title step 7 (28/36, 700), sections step 5 (20/28,
  700), item titles and labels step 2 medium (14/20, 500), body step 2 (14/20), meta step 1 (12/16); text Slate 12 or 11
  only; fills Slate 3-5, borders Slate 6-8, white surfaces. Bold only for page and section titles. The size steps
  (--text-*) move onto the same four sizes (base 14, as Radix's step 2), so the shell's wordmark, sidebar links and
  Silicon UI components land on the scale too: every line on Home is 28, 20, 14 or 12.
- Linear as a fourth type set (Anil, 2026-11-09), from linear.app's CSS variables: Inter (cv01, ss03), weights 510 and
  590, titles 17/20/24/32 at 590 (-.012em, -.022em from 32), text 15/1.6 at -.011em, UI 13/1.5, meta 12. Mapped as
  display 32, h1 24, h2 20, h3 15/590, body 15, small 13, label 13/510, caption 12. linear.app is dark only, so the
  colours stay ours. The dev panel's type set row now has its label above it, so the four options fit.
- Radix undone; Silicon UI's typography everywhere (Anil, 2026-11-09, web/radix-type): four sizes weren't enough. The site
  now uses Silicon UI's type tokens as they ship (sizes 12 to 72 in nine steps, tracking -.03em and -.01em, line heights
  1.1 and 1.4) in Hanken Grotesk for text and titles, with our colours back (#FCFCFC, Silicon UI's greys, the blue
  accent; the Slate greys are gone). The eight roles are rebuilt on those tokens and declared once on :root: display 36,
  h1 28, h2 22 at the title weight (600), h3 18 medium, body 16 (Anil: the earlier 16 base), label and small 14, caption 12. The `[data-silicon-ui]`
  wrapper is gone, so /silicons, /silicons/new, /apps and the page bar share the site's look, and every page title is the
  h1 role (28). Inter is no longer preloaded.
- Typography is tried in the interface, not in sets (Anil, 2026-11-09): the type sets (Ours, OpenAI, Raphael, Linear)
  and the ⌘K font preview are removed. The dev panel's type lab sets Silicon UI's type tokens for the whole interface
  (faces, the nine sizes, tracking, line heights, weights; no colours), and Edit text changes one kind of text, colour
  included, by clicking it: the edit belongs to the CSS rule that styles the text, so it reaches every text that rule
  styles. Silicon UI's own rules can be tried there but move into code only as a token or a request to Silicon UI.
- Personal info on Silicon UI (Anil, 2026-11-09): the page bar like Silicons and Connected apps, then a Silicon UI Card
  per group (Profile, Contact). Silicon UI has no settings row, so the prototype's rows stay ours (label 14 secondary,
  value 14, chevron, the whole row opens its editor), inset in the Card with a hover fill, until a settings list ships;
  the request is drafted in redesign/requests/silicon-ui-settings-list.md, not filed.
- Fonts (Anil, 2026-11-08): Silicon UI's display face is Hanken Grotesk too, not Geist, inside `[data-silicon-ui]`; Home
  sets its text in Silicon UI's face through `.silicon-ui-fonts` (styles/tokens.css), which changes only the faces, not
  the rest of the look. Ids stay in the system monospace. (2026-11-08)
- Four type sizes and nothing else (Anil, 2026-11-08, direction 3 of four explored): 32 (h1, Home's greeting, display),
  20 (h2: sections, banners, the page bar's title), 16 (h3: an item's title in a row, tile or card; body) and 14
  (small, caption, label). It replaces the eight roles of 2026-11-06, whose 25 and 20 between 14 and 39 made every
  section shout. The roles are re-declared inside `[data-silicon-ui]` so they take that scope's family. Silicon UI's own
  components keep their sizes (a Card's title stays 18, its status 12). (2026-11-08)
- Needs you is a countdown list (Anil, 2026-11-08, direction C of four): one white list; a request shows how much of its
  14 days is gone (Silicon UI Progress) and its time left on the title's line, grey over 7 days, amber 3 to 7, red under
  3 ("Ends today" under a day); soonest first, the unused device last. Every row's actions share one column so the
  times line up. At most one strong button per row: Review primary; Decline and Keep ghost; Sign out and Try again
  secondary. The bar is the product's accent in every row because Progress has no tone. (2026-11-08)
- Connected apps uses the page bar and Silicon UI as it ships, like /silicons (Anil, 2026-11-07): Card per app, its parts in their slots; the page bar moved to `components/account/parts/` for every account page. (2026-11-07)
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
- Form hierarchy (Anil, 2026-11-01, tried on Create a Silicon): one column of plain Silicon UI fields, one left
  edge, in groups that read as groups: who it is (Name, then the id, its status in the Input's own description or
  error), then More options under a small heading 48 px below (timezone, webhook, own STK), then the primary action
  first and Cancel. No card, no mark beside a field, no Accordion (it is for supporting information, and its panel
  padding breaks a form's right edge). The first try (a mark beside the name, an Accordion) was dropped. If it holds,
  Security and Personal info follow. (2026-11-01)
- Type scale (Anil, 2026-11-06, replacing the five roles of 2026-11-01): eight roles in styles/tokens.css: display
  49/1.1/700/-.02em, h1 39/1.15/700/-.02em, h2 25/1.25/600/-.01em, h3 20/1.3/600, body 16/1.5/400, small 14/1.45/400,
  caption 12/1.4/500/.02em, label 14/1.2/500. Each is a `font` shorthand plus a `-tracking` token. Silicon UI's steps
  from --text-lg up are remapped onto the scale so its components follow without a patch. Display: Home's greeting,
  story headlines. h1: page titles. h2: sections. h3: groups and card titles. Under 640 px display drops to h1.
- Type inspector (Anil, 2026-11-06): a dev-only hover readout of a text's role and font, on from the dev states panel or
  ⌥I. Clicks are swallowed while it's on, because the dev server points at the live API.

## Process
- PhoneInput country picker (2026-11-10): while open, its surface uses fixed viewport positioning tied to the field's anchor, so scrollable dialogs do not crop the options; scroll and resize keep it attached. Its corners use `--radius-control` and `--corner-shape`, matching the closed field, and opening on a selected country aligns a complete option at the top. The Security dialog keeps its own scrolling. Applied in Silicon UI source and the account site's deferred-release package patch.
- PhoneInput audit (2026-11-10): when the picker cannot represent an international number, it keeps the raw draft visible, reports an empty value with `unsupported` status, and blocks native form submission until corrected. Extra digits stay visible with `too-long` status and browser validation; parsing and display never silently truncate. Country restrictions choose a country from their list. The invisible width measure and visible flag/code share their gap and starting inset. These changes are in Silicon UI source and the account site's existing local package patch, pending the deferred release.
- Silicon UI #28/#29 (2026-11-10): PhoneInput's hidden width measure gets the same flag/code gap as the visible row, and its trigger reserves a 16 px chevron plus token spacing even when `--space-block` is compact. Dialog's close uses the xs icon button size with a transparent resting background and no border; hover, press and keyboard focus reveal its muted fill. Both are in the shared source and the account site's existing pnpm package patch; publish and upgrade with the deferred Silicon UI release.
- Font lab (Anil, 2026-11-08): "Use same font for display and body" starts off. When on, the heading face drives both, the Text selector shows it but cannot be changed, and the saved separate text choice returns when turned off. Body size, weight, letter spacing and line height remain independently adjustable with either font choice. The shared Select's option highlight is corrected in Silicon UI source and patched into the account site. Anil deferred the npm release and package upgrade; the site keeps its tested pnpm patch for 0.4.0 until he resumes that work.
- Keep priorities.md, decisions.md and log.md (this folder) updated with every task; shared-code changes also get a
  README.md note, as the site already does. Why: state lives in repo files, not chat. (2026-10-17)
- Follow web/AGENTS.md and Silicon UI's rules: missing component means stop and report; files you redesign leave
  eslint-suppressions.json and silicon-ui-baseline.json entirely. (2026-10-17)
- Work on branch web/redesign, cut from web/silicon-ui-package (2 local commits not yet on origin). (2026-10-17)
- Silicon UI as it ships (Anil, 2026-11-06): the components looked unlike Silicon UI because styles/tokens.css overrides
  its fonts, sizes, tracking and colours. /silicons/new now restores them inside [data-silicon-ui] as a trial: a 480 px
  centred column, sticky breadcrumbs, form text 16 and helper text 14. It doesn't use the eight-role scale. Rolling it out
  means deleting the overrides from tokens.css, which replaces the scale and the blue accent across the site.
- Sky bands (Anil, 2026-11-07, a trial on web/create-silicon-card): Create a Silicon's timezone step paints the world with each
  offset's current sky, one band per offset, over every IANA zone. Previous and next buttons step through the bands and pick each one's best known city;
  the Combobox still reaches all zones. An available id shows in success green through scoped tokens.
- For the Silicon UI drafts: Input has no success state; MultiStepForm isn't in 0.4; compact Stepper can't drop its caption; Combobox has no error prop; Card clips its contents.
- Webhook URL out of the create wizard (Anil, 2026-11-07): it left Create a Silicon to keep the flow short. It stays a real
  feature: creating without one is fine, and you add one if you want after. A Silicon's own page already has a Webhook block in
  its settings (WebhookBlock, silicon-drawer.tsx), so that's the place today; whether the interface should offer it anywhere
  more visible is open. The API still takes `webhook_url` at creation, and revealCreated still shows a signing secret if one
  comes back.
- Sky bands clicks go by place (Anil, 2026-11-07): a hidden 1° overlay, never drawn, holds the zone for each land cell: the
  country there, then that country's zone with that spot's offset, so Gujarat is Kolkata and southern Africa is Johannesburg.
  Zones in a country with the same clock all year read as the best known. Steps still go by band. Crowded Europe is rough at
  1°, to revisit. The boundary offsets are from 2012, so a few recent changes rely on the nearest-zone fallback; Russia always
  does. Create a Silicon defaults to the browser's time zone, then the Carbon's.
- 2026-11-10 (Anil): Silicon UI text goes on the product scale. A dialog's title is h2 (18/600, display tracking); field hints and errors are small (14/400), one size up from 12/400, which the scale has no role for. Done in the local Silicon UI patch with button and hint tracking at their own size; the request for upstream is §3 of requests/silicon-ui-phone-input-dialog-close.md.
- 2026-11-10 (Anil, copy B): the phone dialog with no number yet is titled "Add a phone number" with "Once it's verified, you can sign in with a code texted to it."; the field's hint is "The code has 6 digits and works for 10 minutes." (no longer repeating the description); the phone field's way out is "Enter the Country Code Yourself" (sign-up too); the button stays Send Code (not OTP: everything else says code). With numbers, the dialog keeps "Text code" and its list description; email is unchanged.
- 2026-11-10 (Anil): the email and phone dialogs use the /__dialog hierarchy: typed text and the calling code are body (16/400, one number), a field's hint is the new ninth role, hint (12/400, --text-muted), and the field's switches (Enter the Country Code Yourself, Use a Different Number) are underlined caption links (Button's link variant, xs). Set on ContactList with Silicon UI's --field-text-size and --field-hint-size; other forms keep 14 until decided.
- 2026-11-10 (Anil: "yes, all of them"): the dialog hierarchy is site-wide. tokens.css sets --field-text-size (body, 16) and --field-hint-size (hint, 12) on :root, so every Silicon UI field (Input, Textarea, PhoneInput, Select, Combobox, DatePicker, MultiSelect, TimePicker, PasswordField, TagInput) types at 16 with 12/400 hints. Create a Silicon's step-up of every Silicon UI size (labels and buttons at 16) is gone. Personal info's phone editor with no number uses copy B and drops its extra Close.
- 2026-11-11 (Anil, Public id audit, all six): the id prefix is Silicon UI Input's new prefix slot (local patch), the typed id's size, so c:anil reads as one id; the live status is the field's hint (12/400, a problem its error) in place of a rest hint ("Your old id stays reserved for you for 10 days, so you can take it back."), so no empty line is held; the order is the id (description "Your id is c:anil. Others find you by it."), the field, then a hint-role note ("Apps you have signed into are told. They know you by an internal id that never changes."); the uuid is no longer shown in it; inline mono is .93em of its line (--mono-inline-scale); free ids are Silicon UI secondary xs buttons.
- 2026-11-11 (Anil): a Carbon's c:id is called CarbonID in all copy (not "Public id", not "id"): Personal info's row and dialog, the change form and field, Home, the Silicons intro, Activity, the command menu, the error toast and sign-up. A Silicon's si:id still says "id" until decided (SiliconID?).

## Dialog rules (Anil, 2026-11-11; from the CarbonID dialog, applied to every Personal info dialog)

Every dialog follows these. The first three are set in CSS, so a new dialog gets them without asking: the variables
on `[role="dialog"]` in `styles/tokens.css` and the `[role="dialog"] strong` rule in `styles/base.css`.

1. **Header:** the title is h2. The description under it is small, 14/400, in `--text-soft`.
2. **Under a field:** the hint, the live status and any note are small, 14/400, in `--text-secondary`. A status takes
   the hint's place; no empty line is ever held for one. A note starts with a bold "Note:" (label, 14/500).
3. **Values named in copy** (a CarbonID, an email, a name, a date) are `<strong>`: 14/500 in `--foreground`.
4. **Copy:** the description says what the thing is for or who sees it, naming the current value; the hint says what
   happens next. Nothing is said twice (description, hint and rows each carry their own fact). The title isn't
   repeated as the field's label. No internal details (uuids, webhooks) unless the reader can act on them. Active
   voice, plain words, and the product's names (CarbonID).
5. **Typing:** what you type is body, 16/400. A fixed prefix ("c:", "+91") is part of the value: the same size.
6. **Actions:** at the end, Cancel (ghost) then the primary action, both at the default size, title case. One way out
   per state: the close button and Cancel on a form; a list with no form gets Close. Switches under a field ("Enter
   the Country Code Yourself") are Button's link variant at sm (14/500).
7. **Width:** a dialog fits its content (`--dialog-width`, as the date of birth dialog does for its calendar).
8. **Check it:** with Edit text on (⌥I) every text names a role; nothing reads "Off scale".
- 2026-11-11 (Anil: "design the connected apps screen"): Connected apps as the prototype draws it, on the account pages'
  rows (parts/rows.tsx, now shared with Security). /apps is one list (each app's mark, name and "Signed in 2 weeks ago",
  linking to its page), then Permissions between apps (with its active count), then "Access removed" only when there
  are any. /apps/[id]: Connected apps above the name with Open, where it lives and since when, Who uses it, What it can
  see about you (Name, photo and CarbonID marked Always, then each shared detail with its value), Also acts for you (Stop,
  asked first), and Remove (asked first, following the dialog rules; your Silicons keep their own access). The
  membership id, the sessions count's own line, the With access / Access removed switch and the in-card remove are gone.
- 2026-11-12 (Anil): Permissions between apps (/proofs) as the prototype draws it: Connected apps above the title, one
  line on what a permission is, an Active list (both apps' marks, "Briefcase in Commit", what it may do and when it
  ends, Stop asked first in a dialog) and an Ended list when there are any (faded marks, why and when). The rows are
  apps/proof-rows.tsx, shared with an app's page ("Also acts for you"). The issuing → receiving diagram, the token
  countdown ring, the Active / Ended switch and the facts grid are gone. "Revoke" is "Stop" in the words.
- 2026-11-12 (Anil: "the pages and nested pages of silicons"), as the prototype draws them, on the account pages' rows:
  /silicons is Waiting for you, then the Silicons as tiles (Home's: mark, name, si:id, a status and "Key changed 3 days
  ago" or who it is being handed to; the whole tile opens it). /silicons/[uuid]: Silicons above its name, its mark,
  si:id, status and since when, then the tabs Access (Secret key with Change; Webhook with Set, Change, Remove) and
  Settings (About: name, id, timezone, photo, looked after by with Hand Over or Cancel Handover; then Delete). Every
  change is a dialog on the dialog rules; the hold-to-confirm buttons and the inline editors are gone. A request has its
  own page, /silicons/requests/[id] (who asks drawn with arrows to you, Accept and Decline explained side by side, the
  days left); Review opens it. The old drawer (silicon-drawer.tsx) is removed.
- 2026-11-12: Personal info's groups are the account pages' sections (parts/rows.tsx: an h2 over a boxed list), like Security, Connected apps and Silicons, so its headings run h1 → h2; its rows keep the label, value and chevron.
- 2026-11-12 (Anil): Activity as the prototype draws it: Security above the title, "What you, your Silicons and your
  apps did, newest first." with the timezone, the prototype's five filters, then a section per day on the account
  pages' rows (what happened, its detail line, the time; an app's mark, else the kind's icon). The filters group the
  API's kinds: Security = sign-ins and security, Personal info = CarbonID changes, Apps = app access and permissions,
  Silicons = custodian. Rows no longer open into a details table.
- 2026-11-13 (Anil): Activity is a sidebar section, directly below Security. Its page has the same filters and feed;
  as a top-level section it has no Security breadcrumb. The Security page's link to Activity remains.

## 2026-11-12: Deleting an account will be recoverable for 30 days

Anil: "we'll add the recovery feature". The delete page tells people they have 30 days to change their mind (sign in
before the last day and the account comes back as it was), so the account site will show it as a fact, without a
"needs the API" label. Today DELETE /v1/me is immediate and final, so this waits on the API and on UNDERSTANDING.md
saying so (api-gaps.md #11). Until then the real page must not promise recovery. Open for the API: whether apps are
told on the day of deletion or after the 30 days, and whether emails, Google or Apple links and the CarbonID stay held
for the 30 days (the design assumes they do). Designs: /__delete (D to H).

## 2026-11-12: Delete your account is a page, from /__delete design H

Anil chose H ("Yes, build H"). /privacy/delete (components/account/privacy/delete-page.tsx) holds the checks before
deleting (every Silicon: Hand Over, Delete, or Cancel Handover while one waits; requests waiting for you, which
deleting turns down), what you'll lose access to, and Delete Account, off until no Silicon is in your care. Data &
privacy keeps one Delete account row that links to it. Copy is Anil's choice of A throughout, B for "What you'll lose
access to". The 30-day recovery card and "Kept for you for 30 days" are in the code behind RECOVERY_DAYS, null until the
API keeps deleted accounts; until then the page says the CarbonID is held for 10 days and the dialog says it can't be
undone.

## 2026-11-12: Data & privacy's Delete account is a quiet row (/__delete-entry A)

Anil kept A after trying B: one row in the page's own list look, only the bin (on a light red tile) and the title red,
"Remove your account and everything in it", opening /privacy/delete. It says nothing about Silicons; that is the delete
page's job ("this is about deleting the account"). Not kept: the red-outlined danger box, a heading with a button (B), a
footer link (C), a row with a Delete… button (D), and opening in place (ExpandableCard).

## 2026-11-12: Sign-in and sign-up pages on the prototype

Anil's answers: one "Email or phone" field (not the Email | Phone switch), sign-up asks only for the name and the
CarbonID, and the prototype's layout and words go to every app's pages in the app's own colours, logo and layout
("Powered by Silicon Accounts" stays). Sign-in: "or get a code", "Send Me a Code", the no-passwords note; with no
subtitle of its own an app's page says "New here? Signing in makes your account." Code: "We sent a 6-digit code to
{address}. It works for 10 minutes.", Continue, "Use a Different Email" beside Resend. Sign-up: the photo in a ring,
"Welcome to {app}", "This is how people and Silicons will see you in every app.", Your name, Your CarbonID (live check),
Create Account; "Not You?" kept. After deleting an account: /goodbye, "Your account is deleted".

## 2026-11-12: muted text clears 4.5:1 (overlays audit)

- `--text-muted` is #6B6B6B (was the #8E8E8E trial): the lightest grey that clears 4.5:1 on white (5.3), the shell's
  grey (5.0) and `--surface-muted` (4.7). Anil chose it over #666666 and over keeping the trial.
- The top bar's Search label and ⌘K take muted too (they were lighter than muted, 2026-10-30), so all three of the
  bar's quiet words ("Accounts", "Search", ⌘K) pass.
- The account site stays light only (lib/theme.ts); the audit now expects light for a dark-preferring visitor.
