# Differences from the prototype

Every place the account site differs from [prototype-v7.html](prototype-v7.html), sorted by the categories in
[prototype-rules.md](prototype-rules.md). Status: **open** (not worked on), **asking** (waiting on Anil),
**requested** (a Silicon UI issue is filed), **kept** (Anil decided to keep the difference), **done**.

First pass 2026-10-30, by comparing the prototype's pages (busy and new-account states) with the live site. A category
marked "check" is a first guess, to be confirmed against Silicon UI's code before acting on it.

## Brand decisions (6): Anil decides

| What | Prototype | Site | Status |
|---|---|---|---|
| Canvas colour | Warm grey `#F2F1EE` | Neutral; no beige (2026-10-18) | asking |
| Accent | Blue `#3460F0` (links such as "See all", focus) | Blue (2026-10-30) | done |
| Font | BDO Grotesk, then Hanken Grotesk | The system font (2026-10-30); a palette switch to compare | kept (Anil) |
| Page panel | White rounded panel on the canvas, top bar above | Inset: the panel on the canvas, no top bar; brand, search and account in the sidebar (2026-10-30) | kept (Anil) |
| Blocks | White cards, hairline border, title inside | Cards on Home (2026-10-30); other pages still old | open |

## Made up, not in the prototype: remove

| What | Status |
|---|---|
| Home's "Your details" block and Home's side column | done (removed 2026-10-30) |

## Composition (2): build exactly as drawn

| What | Prototype | Site | Status |
|---|---|---|---|
| Card | White, 1 px `--line` border, 14 px radius; header 18/20 px padding, 16 px medium title, count or action at the end | Done on Home; other pages next | open |
| Row | 56–66 px; icon tile or avatar, title over a muted line, actions or a chevron at the end; hairline between rows | Done on Home; other pages use SettingsRow without icon tiles | open |
| Icon tile | 32/40 px rounded square, soft tint by meaning (need, good, Silicon, danger) | Done on Home (grey; tints come with the pages that use them) | open |
| Avatar ring | Conic gradient ring around your own avatar | Done on Home | done |
| Handle | Mono id in a small grey chip with a copy button | Chip only (tighter padding); tap copies, no separate copy control (Anil, 2026-10-30) | kept (Anil) |
| Empty state | Dashed border box, 52 px icon tile, title, line, action | Silicon UI EmptyState in a tile | open |
| Danger zone | Red-edged card with a red header | Settings' delete block | open |
| Key box | Dark box, 18 px mono secret, copy | SecretReveal | open (check) |
| Introduction | Full-width card under Needs you, three items side by side | Done | done |
| Top bar | Help and app-switcher icon buttons | Not built | asking (wanted now?) |

## Token (3) or variant (4): check Silicon UI, then token or request

| What | Prototype | Site | Category | Status |
|---|---|---|---|---|
| Button | 36 px, 10 px radius, white with border and a tiny shadow; primary dark; small 30 px | Silicon UI Button | 3 or 4 (check) | open |
| Badge / pill | 22 px, fully round, soft tinted fill with coloured text | Silicon UI Badge | 3 or 4 (check) | open |
| Nav item, current | White raised pill with a hairline ring and tiny shadow, medium weight | Grey fill (NavList) | 3 or 4 (check) | open |
| Nav count | Soft orange pill (purple for Silicons) | Warning Badge | 2 or 3 (check) | open |
| Silicon avatar | Gradient rounded square (30%) with a spark | SiliconMark on Home (parts/silicon-mark.tsx, colours in tokens); the Silicons page still shows photos | 2 | asking (photos or marks everywhere?) |
| App mark | Dark rounded square with the app's icon | AppMark | 2 (check) | open |
| Person avatar | Initials on a hue-tinted circle | A Carbon's pixel avatar (Anil's avatar customizer) or their photo | kept (Anil) | done |
| Type scale | Page title 26 px, card title 16 px, body 14 px, detail 13 px | 2xl, base and sm tokens | 3 | open |
| Field | 42 px, 10 px radius, accent focus ring | Silicon UI Input; focus without a ring (2026-10-17) | 3, 7 | open |
| Dialog | 18 px radius, 480 px, 22/24 px padding | Silicon UI Dialog | 3 (check) | open |
| Toast | Dark, 14 px radius | ToastStack | 3 (check) | open |
| Tabs | Underline on the current tab | Silicon UI Tabs | 1 or 4 (check) | open |
| Filter chips | Dark fill when on | ChipGroup | 3 (check) | open |

## Home, after the 2026-10-30 rebuild

| What | Prototype | Site | Category | Status |
|---|---|---|---|---|
| Needs you count | Solid orange circle, white number | Silicon UI Badge, warning (soft fill with an edge) | 4 | open |
| Status pills | Soft fill, no edge | Silicon UI Badge has an edge | 4 | open |
| Small buttons | 30 px | Silicon UI Button sm is 36 px (xs is 24 px) | 4 | open |
| Detail text | 13 px | 14 px (`--text-sm`; Silicon UI has no 13 px step) | 3 | open |
| Page title | 26 px | 28 px (`--text-2xl`) | 3 | open |
| Avatars | 40 px (lg), 32 px (md) | Greeting uses Silicon UI lg (48) so the photo balances the title + handle (Anil, 2026-10-30); elsewhere still md 36 | 3 or 4 | kept (Anil) |
| Spark | Two filled sparks | Lucide's single filled Sparkle | 2 | open |
| Review | Opens the request's own page | Opens the request deck in a dialog (the page comes with Silicons) | 2 | open |
| Devices not used lately | "Still using …? Keep / Sign out" in Needs you | In the checklist's devices step (7 days); Keep is remembered in this browser only (no API to keep a session) | 2, 8 | done |
| Offline | An orange bar: "You're offline. Showing what was loaded at …" with Try again | Not built yet (shell-wide) | 2 | open |
| Loading | Shimmer bars in the page's shape | SkeletonBlock pulse in the page's shape | 3 | open |

## Personal info, after the 2026-10-30 rebuild

| What | Prototype | Site | Category | Status |
|---|---|---|---|---|
| Whole row clickable | The row is the button, chevron at its end | The whole row is a link to `?edit=<field>` that opens the dialog | 2 | done |
| Photo dialog | Colour swatches for your initial, then Upload a photo | The avatar editor (hair, face, clothing) and "Or use a photo" (Anil, 2026-10-30) | kept (Anil) | done |
| Date of birth | A date field, and "Remove date of birth" | Year list and Silicon UI's Calendar inline (the Date picker once fixed); no Remove: the API needs a date | 8 | open (Remove) |
| DatePicker in a dialog | — | Silicon UI bug: its calendar is clipped by a dialog. Fix drafted (redesign/requests/silicon-ui-date-picker.md); until it ships, the dialog shows Silicon UI's Calendar inline with a year list | Silicon UI bug | asking (file the bug and PR?) |
| Timezone | A short list of zones | Searchable list of every zone | 1 | kept (Silicon UI Combobox) |
| Email and phone dialogs | A plain list (Make primary, Remove as links), then the add field and Send code | Security's list card inside the dialog (ghost Make primary, Remove asks in place, Add opens the field) | 2 | open (rebuild with Security) |
| Public id dialog | "You can change it N more times today" | No count: the API doesn't say how many changes are left | 8 | open |
| Primary marker | Grey pill | Silicon UI Badge, neutral (with an edge) | 4 | open |
| Identity card | Not on this page | Removed from Personal info (it stays on the landing page's sample) | done | done |
| Boxes and rows | `.scard`, `.srow` | Built from the prototype's own CSS in identity.module.css (no shared card part); 12.5 px labels are 12 px, 13 px row padding is 12 px | 2, 3 | done |

## Needs you as a checklist (2026-10-30)

| What | Prototype | Site | Category | Status |
|---|---|---|---|---|
| Home's Needs you | One card of rows: requests, recovery phone, stale devices | Requests in a Needs you card; setup in a "Finish setting up" checklist (the prototype's Security checkup) with a progress bar | Anil's pick | kept (Anil) |

## Behaviour (7): Silicon UI stays unless Anil decides

| What | Prototype | Site | Status |
|---|---|---|---|
| Search | A text field in the top bar; results drop below it | A button opening the ⌘K palette | asking |

## Data (8): in api-gaps.md

Silicon sparkline and last sign-in, "You + 2" on app tiles, Notifications, Data download, wrong keys tried, a
Silicon's activity, automation, cloud services, per-field sharing.
