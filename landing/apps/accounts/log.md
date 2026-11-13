# Log (Silicon Accounts landing)

One block per round, newest at the bottom.

```
## R<n> — <what this round decided> (YYYY-MM-DD)
- Options: <A · idea (node id)>, <B · …>, <C · …>
- Outcome: <kept / killed / merged, and why>
- Captured: <decision lines, principles, patterns, rubric lines touched>
- Next: <weakest rubric item → next brief>
```

## R0 — Setup (2026-10-18)
- Scaffolded `landing/`: README, principles, foundations, narrative, patterns/_template,
  rubric (seeded), decisions, brief-template; `apps/accounts/` brief (draft), decisions,
  log; skill at `.claude/skills/landing-page/SKILL.md`.
- Figma: not yet created. The Figma MCP needs authorising first, and then Geist and
  Hanken Grotesk have to be confirmed loadable.
- Next: R1, where Anil answers the brief's open questions.

## R1 — Brief (2026-10-18)
- Q1 answered: Carbons first. Primary action is creating a personal account.
- Q2 answered: Silicons and developers get their own paths further down the same page.
- Captured: `apps/accounts/decisions.md` (Carbons first), `brief.md` actions. Treated as
  app-only. Whether every Silicon app has one primary audience with the others below it
  is a candidate principle, to revisit after a second app.
- Developer path answered: a short handoff to developers.teamofsilicons.com, not a pitch.
- Q3 answered: most arrive directly, by typed URL or a link from another Silicon site.
- Q4 answered: no outside proof yet; the page proves itself with real screens, flows
  and commands.
- Outcome: brief confirmed, R1 closed.
- Next: R2, direction. Three distinct directions for the hero and first scroll. Needs
  Figma connected.

## R2 — Direction: hero + first scroll (2026-10-18, waiting on Anil)
- Figma file: `ooAWMTw6mF4QHxciuY3Le3` ("Silicon — Landing framework", team anil's projects).
  Pages: Accounts — Explorations `0:1`, Foundations `1:2`, Patterns `1:3`, Accounts — Page `1:4`.
- Built in the file: the "Silicon UI" variable collection (`VariableCollectionId:1:5`):
  neutral scale, semantic light tokens, `dark-block/*`. Working parts (not patterns yet):
  Button set `2:6` (Primary / Secondary / Inverse) and Site header `2:7`.
- Options (all 1440, same header and the same Silicon/developer paths):
  - **A · The handle** `3:3`: pure type. `c:you` at 192px is the hero (**proposal**: above
    Silicon UI's 72px top step). Centred headline, then four plain figures (1 · 10 + 10 ·
    Off · Out).
  - **B · The consent moment** `4:10`: split hero. Promise on the left; the real "what's
    shared" screen on the right (required details ticked, optional ones unticked). The
    first scroll is three product screens: ways in, your apps, many emails.
  - **C · Two kinds of account** `5:30`: an inset dark block with the Carbon →
    custodian → Silicon link as a diagram, plus a CLI line. The first scroll is a
    two-column ledger. Tests whether Silicons belong above the fold, which R1 placed
    further down.
- Copy is drawn only from UNDERSTANDING.md. Sample values: `c:you`, `si:head_of_growth`
  (the doc's own example), the app names Briefcase and DM, example emails and a phone number.
- Outcome: **all three killed** (Anil, 2026-10-18): "not that good". They had no layering
  (no background, no illustration) and no layout system, so the type carried the page.
  Each frame carries a red "Killed in R2" note.
- Captured: the layering principle, the grid / nav / hero foundations, and rubric lines
  for layers, grid and calm type.
- Next: R3, the nav and hero only, built on a structure reference (`K2lQmg8oytDHWkVvqO2b68`
  node `3:49`).

## R3 — Nav + hero on layers (2026-10-18, waiting on Anil)
- Shader: "Silicon backdrop" fill, id `e3bc63b2-2b00-4ce9-b910-53fba8103087`, version
  `fdccc14a…`. Styles: soft field / pixel grid / grain light; app hue; clear zone.
- Parts: Site nav v2 `8:54`; Button set `2:6` gains **Size=Small** (`7:32`, `7:34`, `7:36`).
  The Small variants' label binding was missing at first and has been fixed.
- Options share the nav, grid, copy and an empty illustration slot. Only the base layer differs:
  - **A · Soft field, blue** `8:65`. Screenshot `rounds/r3-a-soft-field-blue.png`
  - **B · Pixel grid, teal** `8:93`. Screenshot `rounds/r3-b-pixel-grid-teal.png`
  - **C · Grain light, violet** `8:121`, intensity raised after the first render. Screenshot
    `rounds/r3-c-grain-light-violet.png`
- The hues are proposals. Choosing the Accounts hue is part of this round.
- Nav links "For Silicons", "Developers", "Docs" are proposals, drawn from the brief's paths.
- Contrast: the writing column sits on paper (#FCFCFC). Heading in ink, lede #585858
  (~7:1), proof line #666666 (~5.5:1).
- Outcome: **all three kept** as framework styles (Anil, 2026-10-18). The Accounts hue is
  still open.

## R4 — Two-tier nav, a shared system (2026-10-18, waiting on Anil)
- Research: `landing/research/nav-structures.md`. The structure is Anil's pick (two tiers).
- Components:
  - Global bar set `10:95`: Quiet `10:65`, Dark `10:75`, One surface `10:85`
  - Local bar `10:96`, with Site name and Hue dot properties
  - "Site nav v2" `8:54` is kept as history
- Options, each over a copy of R3·A's hero:
  - **A · Quiet stack** `10:107` (`rounds/r4-a-quiet-stack.png`)
  - **B · Dark strip** `10:143` (`rounds/r4-b-dark-strip.png`)
  - **C · One surface + hue dot** `10:179` (`rounds/r4-c-one-surface-hue-dot.png`). The
    dot puts the hue in the nav, against the R3 principle. Flagged.
- Main-site instances: `11:129` (A), `11:152` (B), `11:175` (C) (`rounds/r4-main-site-quiet.png`).
- Products menu, open: `11:198` (`rounds/r4-products-menu.png`). One-liners are condensed
  from www-tos `products.ts`. Accounts / Apps / Developers come from UNDERSTANDING.md.
- Open questions for Anil:
  1. Should Sign in go through Accounts or IAM? (Today the main site uses `iam.`.)
  2. Honeycomb or Apps for app discovery? Both are in Foundations for now.
  3. MCPort needs a one-line description.
  4. On the main site, the local bar's name repeats the lockup ("Team of Silicons"). Drop
     it, or name the local tier differently?
  5. Is the briefing 25 or 30 minutes? The docs disagree.
- Outcome: **reworked** (Anil, 2026-10-18). Invert it so the TOS nav is the big top tier,
  exactly as www-tos has it, with the app's menu below. No invented logos. The app bar is
  blue. Buttons adopt the Lattice design. Questions 1–5 are still open (with R5's
  structure, Q4 no longer applies).

## R5 — TOS nav on top, app bar below, Lattice buttons (2026-10-18, waiting on Anil)
- TOS nav component `15:196`, rebuilt from `www-tos/src/styles.css` and `nav.tsx`. The logo
  comes from `public/tos.svg`; the site serves `tos.png`, so the proportions may differ
  slightly. The GitHub glyph is a lucide stand-in for Phosphor's `GithubLogo`.
- App bar set `15:241`: Blue `15:229`, Tint `15:235`. 48 tall, "Silicon Accounts" as text,
  links For Silicons · Developers · Docs. No CTA, since the TOS nav already has one.
- Button set `2:6` restyled after Lattice: radius 12, 10% hairline, drop shadow, white bevel.
  Every instance has updated.
- Options, over a copy of R3·A's hero:
  - **A · Blue app bar** `15:242` (`rounds/r5-a-tos-nav-blue-app-bar.png`)
  - **B · Tinted app bar** `15:296` (`rounds/r5-b-tos-nav-tint-app-bar.png`)
- Noticed:
  - The hero's 96 margin doesn't line up with the navs' 80 inset. Should the hero move to 80?
  - The TOS nav's "Create account" and the hero's "Create your account" are the same
    action twice in the first view.
  - The TOS nav uses #FFFDF9 (warm), while the page is #FCFCFC.
- Outcome: **app bar dropped** (Anil, 2026-10-18). See R6.

## R6 — One nav: TOS nav only, Developers replaces Docs (2026-10-18, waiting on Anil)
- Research: three links, two places.
  - Main nav Docs → docs.teamofsilicons.com (the Stemcell docs, a Docmost wiki).
  - Accounts' Developers → developers.teamofsilicons.com (the developer portal).
  - Accounts' Docs → developers.teamofsilicons.com/docs/accounts. The portal already
    serves the Apps and Accounts docs (`developer/README.md`).
- Anil: drop the sub nav. "For Silicons" belongs in the page. Developers and the Docs
  links serve one purpose.
- Built:
  - TOS nav (proposed) `18:274`: Products ▾ · Starter · Developers · Writings.
  - R6 frame `18:320`: TOS nav and R3·A's hero, with "Silicon Accounts" as a blue eyebrow
    (`rounds/r6-tos-nav-only.png`).
- Kept as history: app bar set `15:241` and R5 frames `15:242`, `15:296`.
- R6 · B `19:308`: the same frame with the grain light backdrop. It was first in Accounts
  blue; then **Anil: "change to violet"**, so the hue is now violet (0.45, 0.32, 0.92) and the
  eyebrow is violet to match (`rounds/r6-b-grain-light.png`). R6 · A is renamed "soft field
  backdrop". The eyebrow is now uppercase Hanken Medium, Anil's edit in Figma.
- **Anil changed the R6·A heading in Figma** to GT Alpina Trial Light (36 / 44, −3%),
  which is the reference's serif. It departs from Geist. Is this a decision for the
  framework? It's not logged as one yet.
  - The Figma MCP can't load GT Alpina Trial (a local trial font), so R6·B's heading stays
    GT Alpina **Regular** as cloned. Its weight and leading need a manual fix.
- Open:
  1. www-tos needs the same nav change.
  2. Where do the Stemcell docs (docs.teamofsilicons.com) appear from the developer site?
  3. The eyebrow is my call. Confirm it.
  4. The hero margin is 96 but the nav inset is 80. Still unaligned.
  5. Sign in through Accounts or IAM? Honeycomb or Apps? MCPort's description? The
     briefing length? All still open.
- Outcome: **R6·B chosen, in brand blue** (Anil, 2026-10-18): grain light, #1F5CB1.
  `19:308` is renamed "… — chosen". Anil has since placed an illustration in it: an ID card
  with a pixel avatar, "Chief of Staff — Silicon".

## R7 — Telling apps apart without colour (2026-10-18, waiting on Anil)
- Brand blue grain is constant. Each candidate is built for Accounts, DM and Briefcase, so
  the test is whether the apps can be told apart side by side.
- **A · Generative fingerprint**: the same shader with a per-app seed and scale. Frames
  `32:343`, `32:413`, `32:484` (`rounds/r7-a-fingerprint.png`).
- **B · Pixel glyph** (logo-like proposal): a 3×3 mark from the TOS logo's squares with
  the rotated centre square. Small beside the eyebrow, large and faint in the backdrop.
  Frames `32:556`, `32:637`, `32:721` (`rounds/r7-b-pixel-glyph.png`).
- **C · Signature motif**: Accounts rings, DM message pills, Briefcase stacked sheets, in
  blue at low contrast in the right half. Frames `32:810`, `32:885`, `32:964`
  (`rounds/r7-c-motif.png`).
- Copy for DM and Briefcase is condensed from www-tos `products.ts`.
- Caveats:
  - The DM and Briefcase frames still show the Accounts ID-card illustration, carried over
    when the frame was cloned. It's a stand-in.
  - Their headings are in Geist because the MCP can't load GT Alpina Trial.
  - In B, the large glyph sits mostly behind the illustration.
- First read:
  - A's difference is subtle.
  - B is consistent but tiny unless it shows in the backdrop.
  - C differs most and tells you what each app does.
- Still open: GT Alpina as the framework heading face; the hero (96) vs nav (80)
  alignment; the R4 questions (IAM vs Accounts sign-in, and so on).
- Outcome: **none chosen** (Anil, 2026-10-18): "none, actually find what others do".
  Research is in `landing/research/product-distinction.md`.

## Clean-up (2026-10-18)
- At Anil's request, the earlier proposals were removed from the explorations page: R2–R7
  frames, labels, the products menu, and the unused working parts (Site header, Site nav
  v2, Global bar, Local bar, App bar). **Node ids in the rounds above no longer exist.**
  The screenshots in `rounds/` are the record.
- Kept:
  - **Accounts — current (R6·B)** `19:308`, now at 0,0
  - Button set `2:6`
  - TOS nav (www-tos) `15:196`
  - TOS nav (proposed) `18:274`
  - Anil's "Frame 1" `9:365`, untouched
- Next: write down the illustration style, so every app's hero object is drawn the same way
  (research/product-distinction.md, patterns 2 and 3).

## R8 — Buttons in brand blue, after vibrant.design (2026-10-18)
- Read the "Explore Moodboards" button's computed styles in the browser: radius 10, 32 tall,
  0/14 padding, Inter Medium 14, a layered `::before` (gradient fill, gloss, gradient
  border, ring plus inner shade plus two drops). Also read "Surprise me" for the secondary.
- Restyled Button set `2:6`: Primary in brand blue, Secondary white. Inverse takes the
  shape only. Screenshots: `rounds/r8-button-set.png`, `rounds/r8-blue-buttons.png`.
- Resetting the hero buttons' overrides (to drop the old surface fill) also reset a
  **hidden** Primary button Anil had added (`35:1465`). Its label is now "Create your
  account". If it had a different label, it needs setting again.
- Seen in the frame, not changed by me (Anil's edits):
  - the frame was renamed "Accounts"
  - the illustration (`9:405`) and its slot are hidden
  - the proof line and the frame label were removed
- **Fix (Anil: "no border?"):** the first pass put the border in a 1px inside gradient
  stroke, plus a ring drawn as a drop shadow with spread. Neither read at 1×. Now there's a
  crisp 1px **outside** stroke (#17468C on primary, ink at 9% on secondary), plus inner
  lit-top and dark-bottom rims. Checked at 4× (`rounds/r8-buttons-border-4x.png`). Added a
  rubric line.
- **States (Anil: "also the effects (hover and click)"):** read the source's stylesheet:
  - `.t-surface-primary:hover` mixes white 6% into both gradient stops
  - `.t-surface-secondary/outline:hover` mixes black 4%
  - `:active` sets `::before` to scale 0.99
  - transitions are 150ms `cubic-bezier(.215,.61,.355,1)`
  Added State=Default/Hover/Pressed (12 new variants) and hover and press prototype
  reactions (`rounds/r8-button-states.png`). Pressed's 0.99 scale is code-only. The focus
  ring and the Inverse hover are still to do.
- **Nav buttons:** TOS nav (proposed) `18:274` now uses Button instances (Sign in `47:36`,
  Create account `47:38`), gap 8. The GitHub ghost icon is unchanged. The shipping
  reference `15:196` is untouched (`rounds/r8-nav-buttons.png`). www-tos now differs in two
  places: Developers instead of Docs, and these buttons.
- **Clipping (Anil's fix):** Anil set the hero `Actions` row (`19:318`) to clip off with 2px
  padding, because the buttons showed cut. I applied the same to:
  - the nav's `site-nav-actions`: clip off, padding 2; the nav padding goes 12/80 → 10/78
    so the bar stays 56 and aligned
  - `site-nav-left`
  - the Button set frame
  - the hero `Heading group`
  Added the rule to the foundations (Craft), the rubric and the skill.
- **Top-left accent:** added group `49:40` in the hero: a grain shader layer under a
  radial-fade mask. The first pass (intensity 0.55) barely showed; it's tuned to
  intensity 1, scale 220, and a mask of 1 → 0.5 → 0
  (`rounds/r8-top-left-accent.png`). The eyebrow and heading stay on paper.

## R9 — Columns backdrop, after the Lattice hero (2026-10-19, waiting on Anil)
- Studied the Lattice hero image (`K2lQmg8oytDHWkVvqO2b68` `135:357`): vertical columns of
  stacked short cells whose colour steps light → deep, heaviest at the right edge, with
  faint columns in the top-left.
- Added a **Columns** style to the "Silicon backdrop" shader. It took three versions:
  - `ef6c3191`: first pass, blocky with white gaps
  - `4364ef17`: smooth runs, horizontal build-up
  - `3bac68b8`: per-cell jitter
  It uses brand blue tints only.
- Trial frame `72:39` "Accounts — Columns backdrop (trial)", next to the current grain frame
  `19:308`. Its top-left accent also uses Columns.
  - Screenshots: `rounds/r9-columns-backdrop.png`; side by side with grain:
    `rounds/r9-grain-vs-columns.png`.
- Note: the radial mask's curved edge shows slightly through the top-left columns.
- Outcome: **both kept for now; continue developing on Columns** (Anil, 2026-10-19).
  The hero is done.

## R10 — Section 2 "How it works for you" (2026-10-19, waiting on Anil)
- Story arc agreed: Control first (narrative.md).
- Section 2 builds on the Columns hero frame (`72:39`) and sits below it at x 1640.
- New vignette components, each a real product moment from UNDERSTANDING.md:
  - "Sign in your way" `84:72`: the four methods
  - "See what's shared" `84:84`: required details ticked, optional ones unticked, "Continue as c:you"
  - "Take it back" `84:113`: your apps, with "Remove access"
- Copy: eyebrow "How it works"; heading "You decide what every app gets."; three steps with
  one line each, all sourced from the brief's proof table.
- Options:
  - **A · Three steps, each on its own stage** `86:77`. Equal weight; a faint columns
    stage behind each vignette, with a caption below (`rounds/r10-a-three-stages.png`).
  - **B · Steps list beside one big stage** `86:167`. The list sits on the left with step
    2 active; one big columns stage on the right shows the active step. Built to be
    driven by scroll or click (`rounds/r10-b-list-and-stage.png`).
  - **C · One flow across a band** `86:219`. A centred header, then a full-bleed columns
    band with the three moments joined by arrows, and captions below
    (`rounds/r10-c-flow-band.png`).
- Section rhythm (**proposal**): 120 top and bottom, 64 between the header and the content,
  16 inside the header.
- Caveat: section headings are in Geist 32, standing in for the hero's GT Alpina Trial
  Light 36. The MCP can't load GT Alpina, so these need restyling by hand, or a text
  style Anil creates that I can apply.
- Outcome: _pending_
- **Snippets switched to Silicon UI** (Anil: "we're using silicon-ui for that"). Built
  "Silicon UI · Button" `87:247` (Primary/Secondary/Danger × xs/sm/md), "· Checkbox"
  `87:252` and "· Avatar" `87:253` from `silicon-ui-package/registry` CSS. Rebuilt the three
  vignettes with them: card radius 8 with the showcase shadow, ink primary "Continue as
  c:you", ink checkboxes, round avatars, Danger xs "Remove access". All three options
  updated through the instances; screenshots refreshed.
- **Copy pass (grounded-copywriting, Anil's experiment):** audited 12 sentences in the
  hero and section 2 (`apps/accounts/copy.md`). 6 were kept and 6 fixed:
  - "you choose / you decide what each app gets" overstated it: required details aren't
    a choice
  - "sign in your way" overstated it: the app picks the methods
  - "each app shows you … first" was inaccurate: we show the screen, the first time and
    when the app asks for more
  Applied the fixes to the hero ledes (`19:308`, `72:39`) and all three section 2 options.
  - **The hero heading still needs Anil to type** "One account for every app you sign
    into. You see what each one gets." (GT Alpina can't be edited from here.)
  - Open: there's no sourced problem statement for a problem-first opener.
- Outcome: **B · Steps list beside one big stage** (Anil, 2026-10-19). A and C are removed
  from Figma; their screenshots stay in `rounds/`. Behaviour: the section is about three
  viewports tall. The stage sticks while you scroll, each step becomes active in turn and
  the stage swaps to its snippet. Clicking a step jumps to it.
- **States + prototype:**
  - Section 2 is now the component set "Section · How it works" `93:322`, with variants
    Step=1 `93:116`, Step=2 `93:115` and Step=3 `93:139`. Each has its own active row
    (muted pill, blue number, body copy) and the matching Silicon UI snippet on the stage.
  - Clicking a step row changes to that variant: smart animate, 240ms,
    cubic-bezier(.22,1,.36,1).
  - Prototype frame `93:329`, "Prototype · Accounts (hero + how it works)", is a copy of the
    Columns hero plus a Step=1 instance, set as the page's flow start
    (`rounds/r10-b-step-states.png`).
  - Scroll-driven switching is code-only (patterns/how-it-works-stage.md).
- Noticed: the heading "See what every app gets, and take it back." wraps to an orphan
  "back." in the 576 column at 32px. Options are a shorter grounded line ("See what apps
  get, and take it back.") or the heading at 28.
- **Fonts (Anil: "don't use geist, only hanken grotesk, and gt alpina"):** switched all 21
  Geist texts (outside instances) to Hanken Grotesk; none remain. The three section 2
  headings (`93:121`, `86:172`, `93:144`, one per Step variant) are Hanken 32/40
  placeholders named "Heading (set GT Alpina Trial Light 36/44 by hand)". The MCP can't
  load GT Alpina Trial. Rules updated in decisions, foundations, rubric and the skill.

## R11 — Section 3 "What you get" (2026-10-19, waiting on Anil)
- Content shape: **three unordered facts**, each with a product screen. By the playbook,
  that points to an equal or grid layout, not a step list.
- New Silicon UI snippets: "Ways in" `105:219` (emails and phone with a Primary badge,
  Add email / Add phone), "Your ID" `105:243` (c:id input, Available, 10-day note, Change
  ID), "Acting for you" `105:253` (User verification rows with Revoke).
- Options, below section 2 at x 1640:
  - **A · Bento** `106:226`: a wide and a narrow tile, then one full-width row; tiles on
    faint columns (`rounds/r11-a-bento.png`).
  - **B · Three equal cards** `106:302`: snippet on a stage, fact below
    (`rounds/r11-b-three-cards.png`).
  - **C · Zigzag rows** `106:377`: one fact per row, sides alternating
    (`rounds/r11-c-zigzag.png`).
- Copy audit: `copy.md` § Section 3. Flag: "up to 10 emails **or** 10 phone numbers" in the
  source. I wrote "10 emails and 10 phone numbers"; this needs confirming.
- Headings are Hanken placeholders, to be set in GT Alpina by hand.
- Outcome: **A · Bento** (Anil, 2026-10-20), with **solid tiles** instead of columns
  backgrounds: "there's a boring uniformity in everything with the same pattern and same
  colors". Tiles: brand blue #1F5CB1 (white text, body 84%), ink #141414 (paper text, body
  72%), light tint #E6EEF9 (ink text, #3D4A5C body) (`rounds/r11-a-bento-solid.png`).
  B and C were removed from Figma.
- **Limit wording:** Anil reads "up to 10 emails or 10 phone numbers" as 10 in total. The
  tile `106:235` now says "Up to 10 emails and phone numbers", which is true under either
  reading. A copy rule was added to narrative.md. The spec itself should say "in total".

## R12 — The Columns hero, as drawn (2026-10-30)
- Anil: the signed-out page is the Columns backdrop trial (`72:39`), the frame itself, not a simplified reading of it.
- Heading is the frame's line: "You choose what each one gets."
- Heading face is GT Alpina Trial Light, which is installed on this machine (`local()`). It is not a file in the repo.
- Nav is the frame's: Products, Starter, Developers, Writings, GitHub, Sign in, Create account. Products does not open a menu; the frame only draws the chevron.
- Buttons are the frame's brand blue (`#1F5CB1` / `#3070C4`), not the account site's accent.
- The columns are the frame's WebGPU shader (Silicon backdrop, style 3), not a CSS grid. The canvas is empty where WebGPU is unavailable.
- `landing.module.css` is in `siliconUi.ignore`. Those measures and colours are the frame's; they are not Silicon UI tokens.

## R13 — How it works, under the hero (2026-10-30)
- Anil: cook the next section. That is `93:322`, the step list and sticky stage already under the Columns hero in prototype `93:329`.
- The page scrolls one viewport per step. The stage sticks, and the open step follows the scroll. Clicking a step jumps to it.
- Copy, vignettes, and the stage shader are the frame's (Columns, clear centred, intensity 0.85). The heading is GT Alpina Trial Light at the frame's 32/40.
