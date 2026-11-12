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
| Content column | 720 px | 896 px (2026-11-11, Anil, branch compact; 800 and 960 tried): every narrow page wider | decided |
| Font | BDO Grotesk, then Hanken Grotesk | The system font (2026-10-30); a palette switch to compare | kept (Anil) |
| Page panel | White rounded panel on the canvas, 18 px radius, uneven inset (8 / 12 px) | White box, 8 px corner, 8 px inset, 1 px `#E5E7EB` (Anil, 2026-10-30) | kept (Anil) |
| Sidebar icons and labels | — | Icons 18 px over NavList's fixed 16 px, labels `--text-base` (16 px) over its 14 px (sidebar.module.css; NavList has no size option); grey hover, not blue (Anil, 2026-10-30) | kept (Anil) |
| Sidebar width | Fixed | Steps 200 / 248 / 296 px by a handle on the page box's left edge (a grip on hover, no line), remembered per browser; the site's own handle, as ResizablePanels has no steps (sidebar-resize.tsx; Anil, 2026-10-30) | kept (Anil) |
| Sidebar foot | Developers, Help, Privacy · Terms as muted text links, stacked | Developers and Docs as soft xs ButtonLink chips in a row, no arrow (Anil, 2026-10-30) | kept (Anil) |
| Account photo | — | 36 px in a 44 px circle, over UserMenu's fixed 32 in 40 (Anil, 2026-10-30) | kept (Anil) |
| Home identity | Greeting row: ringed round photo, "Welcome back, <first>", id chip with a copy button | At the column's top left: 88 px squircle picture in one ring wrapper (border = 4 px band in the picture's colours, turning; padding = 3 px gap; Avatar hairline and fill removed); to its right "Welcome, <first>" 36 px, the id as a soft xs chip that copies on click, and "Member since <month year>" (not in the prototype) 14 px muted (Anil, 2026-10-30) | kept (Anil) |
| Home introduction | A dismissible card with a soft Silicon gradient; three columns, picture over label over line | A dismissible grey tile of three 140 px gradient cards (You: the pixel avatar on its own palette; Silicons: the spark; Apps: the grid), 22 px title over a 12 px line, no actions (Anil, 2026-10-31) | kept (Anil) |
| Home Silicons and apps | Your Silicons: 2 tiles + New Silicon; Your apps: 4 tiles with who uses each | As drawn, plus a "Create your first Silicon" banner when there are none (its own forest-to-sand gradient and grain, off the brand palette, with local colours; Geist Serif heading, the site's only serif). Your apps leads with the popular apps (Briefcase, DM, Ting) as simple white cards (an ink Phosphor icon beside the name and again as a faint watermark: the site's only use of Phosphor) with Try or Open (the site's secondary button), then other apps as small tiles; no "You + N" (no API for it) (Anil, 2026-10-31) | kept (Anil) |
| Search trigger | A 40 px white pill field (up to 560 px, hairline, shadow), placeholder at the start, no shortcut key | Soft Button 400 px, label at the start and ⌘K at the end, by reaching into Button's label spans (it centres them, with no option) (Anil, 2026-10-30) | kept (Anil) |
| Top bar | 64 px; the mark (11 px square and circle) and "Team of Silicons **Accounts**" | 56 px: 8 px on top, then a 48 px row (Anil, 2026-10-30); the prototype's mark and name, name hidden under 900 px (the prototype: 820 px) | kept (Anil) |
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
| Type scale | Page title 26 px, card title 16 px, body 14 px, detail 13 px | Silicon UI's typography (2026-11-09), compact on branch compact (2026-11-10): display 28, h1 22, h2 18, h3 16, body 16, small 14; Silicon UI components keep fixed weights (500, 400), which the type lab's weights don't reach. Inside Silicon UI: controls and labels 14/1.4/500 (label says 1.2), typed text 400 (label says 500), hints 12/1.4/400 (caption says 500, .02em; now 14/400 small in the local patch, 2026-11-10), component text 14 (body says 16) | 3 | open |
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
| Search | A text field in the top bar; results drop below it | A button opening the ⌘K palette in Silicon UI's headerless Dialog (#31 implemented locally) | asking |

## Data (8): in api-gaps.md

Silicon sparkline and last sign-in, "You + 2" on app tiles, Notifications, Data download, wrong keys tried, a
Silicon's activity, automation, cloud services, per-field sharing.

## Silicons (2026-11-01)

| What | Prototype | Site | Status |
| --- | --- | --- | --- |
| Silicons list | Page head, Waiting for you, two-column Silicon tiles (mark, name, status, last sign-in) | Three columns of cards in each Silicon's colour pair (name, si:id, key last changed, status); a New Silicon card; the first-Silicon banner when empty. No last sign-in (no API) | kept (Anil) |
| A Silicon | Breadcrumb, header (mark, name, id, status), stats, tabs Activity / Access / Settings | Back link, a hero in its colours, then the settings on one page; no stats or Activity / Access tabs (no API: api-gaps.md 3–8) | open |
| Silicons, first visit | An empty state ("No Silicons yet", one line, New Silicon) | Six stories (one idea each, segmented bars, auto-advance, tap or arrows, the last holds three ways to start: create here, Silicon Starter, let one ask you); the site's own component (Silicon UI has no stories); Silicon Starter is not in the prototype (Anil, 2026-11-01) | kept (Anil) |
| Create a Silicon | A New Silicon dialog with Name alone (the Silicon's mark beside it, the id as a hint) | A page; Name, then the id field (the API needs one), then the API's timezone, webhook and own STK under More options; no mark beside the field (Silicon UI's Input has no slot for it or a prefix: requests/silicon-ui-input-prefix.md) | kept (Anil) |

## Security (2026-11-10)

- ~~**Change on a Silicon key** goes to the Silicon's page.~~ Fixed 2026-11-12: Change asks on Security (the shared
  ChangeKeyDialog, `silicons/change-key.tsx`) and the new key shows above Silicon keys until it is stored. The prototype
  shows the new key in a dialog; here it is the same reveal card as on the Silicon's page.
- ~~**Email code / Text code** have an Edit button.~~ Fixed 2026-11-12: the whole row opens the list (a link to
  `?edit=email|phone`, as Personal info's rows), a chevron at its end.
- **Devices** show when each was last active and its IP; the prototype shows a place ("Kolkata, India"), which the API
  doesn't give. Category: API gap.
- **Sign Out of All Other Devices** signs each session out one by one; the API has no single call. Category: API gap.
- **The phone field's arrow overlapped the calling code** and **the dialog's close button was a bordered square**: both
  are Silicon UI's (PhoneInput, Dialog). Category: Silicon UI; filed as
  teamofsilicons/silicon-ui#28 (PhoneInput) and #29 (Dialog close), fixed in source and the account site's local package
  patch on 2026-11-10. The upstream release is pending. The dialog title is h2 (18/600) and field hints and errors are small (14/400) since 2026-11-10, in the local patch only (request §3 in requests/silicon-ui-phone-input-dialog-close.md).
- **The PhoneInput country list was cropped by the Security dialog and had a different corner shape and radius from the field.** Category: Silicon UI; fixed in shared source and the account site's local package patch on 2026-11-10. The list now floats beyond the dialog's scroll boundary and uses the control's corner tokens. The upstream release is pending.

## Connected apps (2026-11-11)

- **Who uses it lists only you.** The prototype also lists your Silicons that use the app. Category: API gap (no call
  says which of your Silicons an app knows).
- **What it can see has no switches.** The prototype lets you stop sharing an optional detail. Category: API gap (scopes
  can't be changed from the account site); each detail shows its value instead.
- **The list's line is when it signed you in** ("Signed in 2 weeks ago"), where the prototype says who uses it ("You,
  Scout"). Category: API gap, as above.
- **Apps whose access you removed are listed** under "Access removed", which the prototype doesn't show. Category:
  kept from the site (the API returns them; they can be signed in to again).
- **The "Making an app?" footnote** is the site's, not the prototype's. Category: kept from the site.

## Permissions between apps (2026-11-12)

- **Ended permissions show the date and the reason in words** ("You stopped it", "Ended when Briefcase's access was
  removed"), where the prototype shows its reason and when. Same content; the wording is the site's.
- **The line under the title adds** "Stop one and the other app's next check fails at once." Category: kept from the
  site (what stopping does, from the contract).

## Silicons (2026-11-12)

- **No stats, Activity tab, Apps it may use, Automation or Cloud services** on a Silicon's page, and no sign-in sparkline
  on its tile. Category: API gap (no call gives a Silicon's last sign-in, its apps, its sign-in counts or its activity;
  api-gaps.md).
- **A tile's line is when its key last changed**, where the prototype shows when it last signed in. Category: API gap.
- **Access also has the Webhook**, which the prototype doesn't show. Category: kept from the site.
- **About also has Timezone and Photo.** Category: kept from the site (the API has them).
- **The id row is "Id"** until a Silicon's id has a name (CarbonID's counterpart is undecided).

## Activity (2026-11-12)

- **A name, photo, date of birth or timezone change shows under Security, not Personal info.** Category: API (the
  history files them under its security kind; only CarbonID changes have a kind of their own).
- **Rows show the actor's mark only for apps**; changes you made show the kind's icon, not your photo. Category: kept
  simple until the history says who acted.

## Data & privacy and Delete your account (2026-11-12)

- **Delete account opens a page of its own** (/privacy/delete) instead of the prototype's askDeleteAccount dialog.
  Category: Anil's design (/__delete H): Before you delete (each Silicon handed over or deleted right there, requests
  waiting for you), What you'll lose access to, then where the checks stand beside Delete Account; the dialog only asks
  for the CarbonID.
- **The 30 days to change your mind isn't shown yet.** Category: API (#11). The design has it; the page hides it with
  RECOVERY_DAYS null and says the CarbonID is held for 10 days, which is true today.
- **Download your data isn't built.** Category: API (#2).
- **No red danger zone.** Data & privacy's Delete account is a plain row with only its bin and title red, and the delete
  page's box is the page's grey, not the prototype's red .dz. Category: Anil's design (/__delete-entry A).

## Sign-in and sign-up (2026-11-12)

- **"Powered by Silicon Accounts" instead of "One account for every Team of Silicons app"** under the card. Category:
  kept (it links apps' visitors to us; the README requires it on every app's page).
- **The app's logo and name above the title**, not the prototype's large mark beside it. Category: branding (apps
  choose their logo and whether the name shows).
- **No "Paste code" button** on the code step: pasting into the code works, and a button needs the clipboard
  permission. Category: kept simple.
- **"Not You?" on the sign-up**, which the prototype's welcome doesn't draw. Category: safety (the verified address is
  someone's).
- **The first-party title says "Silicon Accounts"**, the prototype "Team of Silicons". Category: product name as the
  site uses it.
