# Decisions (framework)

Decisions that hold for every Silicon app's landing page. App-only decisions go in
`apps/<app>/decisions.md`.

Format: `- <decision>. Why: <reason>. (YYYY-MM-DD)`. If a later decision replaces one,
mark the old line `(replaced YYYY-MM-DD, below)` rather than deleting it.

## Process
- One framework for every app's landing page, built by designing Silicon Accounts from
  scratch and keeping what generalises. Why: Anil wants the same quality and consistency
  across apps, without designing each page alone. (2026-10-18)
- No reference to any current landing page, visual or verbal. Facts come from the app's
  understanding doc and Anil. Why: Anil wants refreshing designs from scratch. (2026-10-18)
- Figma first; code after sign-off. Why: Anil's choice. (2026-10-18)
- The framework lives in `silicon-accounts/landing/` for now, written app-agnostic.
  Why: Anil's choice; it can be lifted out later. (2026-10-18)
- Learning happens through four things: this log, a Claude skill, a rubric and a pattern
  library. Why: Anil chose all four. (2026-10-18)

## Base
- Silicon UI is the base: Geist display, Hanken Grotesk text, neutral greys, lucide
  icons, its spacing and radius tokens. Landing pages explore composition, scale, rhythm,
  imagery, motion and story on top of it. Why: Anil's choice. (2026-10-18)

## Layout and layers (R3)
- Every hero is layered: a base layer (an abstract background that gives personality and
  keeps content readable) under a content layer (text plus a supporting illustration).
  Why: Anil, after rejecting R2: "a good design is about layering". (2026-10-18)
- A fixed nav and hero layout with set padding and two balanced columns. The measures
  are in foundations.md (taken from the structure of a reference Anil supplied).
  Why: Anil: "we have a certain layout, with padding, and a balanced content structure".
  (2026-10-18)
- One hue per app, used only in the background layer. Text, buttons and cards stay Silicon
  UI neutral. Why: Anil's choice; it makes apps distinct while keeping them consistent.
  (2026-10-18)
- Backgrounds are Figma shaders: one shared "Silicon backdrop" fill, tuned per app. Why:
  Anil's choice. (2026-10-18)
- Hero type is calm (36px heading, 16/24 lede). The personality comes from the layers,
  not the type size. Why: R2's large-type directions were rejected. (2026-10-18)
- Anil may supply outside references, for structure only. The current landing page is
  still not a reference. Why: Anil shared one for R3. (2026-10-18)

## Navigation (R4)
- All three backdrop styles (soft field, pixel grid, grain light) stay as framework options.
  Each app picks one. Why: Anil kept them all after R3. (2026-10-18)
- The nav is one shared system across every Silicon site: the main site and every app's
  landing page. Why: Anil wants the apps connected to the main Silicon website. (2026-10-18)
- The nav has two tiers: a global Silicon bar (the same everywhere) above each site's local
  bar. Why: Anil chose it over umbrella-only, standalone, and one-bar-with-shared-ends,
  after research on 15 companies (research/nav-structures.md). (2026-10-18)
  (Tier sizes and styling replaced 2026-10-18 by R5, below.)

## Navigation (R5)
- The tiers are inverted. The **TOS nav** is the big top tier and is the main site's nav
  exactly as www-tos ships it: 56 tall, the TOS logo, Products ▾ · Starter · Docs ·
  Writings, GitHub · Sign in · Create account, on #FFFDF9. The app's own menu is a
  smaller bar below it. Why: Anil: "tos navigation bar should be bigger, maybe just pick
  the exact design from www-tos nav bar design, and then below that the app's menu".
  (2026-10-18)
- Apps without a logo show their name as plain text, e.g. "Silicon Accounts". Never
  invent a logo. Why: Anil. (2026-10-18)
- The app bar gets its own colour (blue for Accounts). Why: Anil: "let's give that a
  different color, maybe blue". This updates the R3 rule "hue only in the base layer":
  the app hue may also colour the app bar. (2026-10-18)
- Buttons follow the Lattice reference's construction: radius 12, a 1px ink hairline at
  10%, a soft drop shadow, and a white inner bevel on filled buttons. Colour stays
  Silicon UI ink. Why: Anil asked to adopt the reference's button design. (2026-10-18)


## Navigation (R6)
- No app bar. App landing pages use the TOS nav only. Why: Anil: "we don't need the sub
  nav bar". This replaces R5's app bar. (2026-10-18)
- Audience paths (for example "For Silicons") live in the page, not the nav. Why: Anil:
  "for silicons is for silicons, doesn't have to be visible in the sub nav". (2026-10-18)
- One entry for developers: **Developers** in the TOS nav replaces **Docs** and goes to
  developers.teamofsilicons.com, which already hosts the developer portal and the Apps and
  Accounts docs (`developer/README.md`, `/docs`). Why: Anil: Developers and both Docs links
  serve one purpose, so reduce the confusion. (2026-10-18)
  Needs: the same change in www-tos's nav, and a home for the Stemcell docs
  (docs.teamofsilicons.com) reachable from the developer site.
- The product's name sits in the hero as a small eyebrow in the app hue ("Silicon
  Accounts"), since there's no app bar to carry it. Why: my call, to confirm. (2026-10-18)

## Colour and app distinction (R7)
- Accounts uses the grain light backdrop in **brand blue #1F5CB1** (the www-tos accent).
  Why: Anil: "blue with grain, our brand blue". (2026-10-18)
- **Per-app hue is retired.** Colour belongs to the brand: brand blue is the only hue, in
  the backdrop and the product-name eyebrow, on every app. Why: Anil: per-app hue "would
  dilute the overall brand identity", and choosing a family of app colours (where close
  colours imply association) is work we don't want to focus on now. This replaces the
  R3/R5/R6 hue decisions. App colours are parked, not rejected. (2026-10-18)
- **Brand constants** across every app: the TOS nav, brand blue grain backdrop, heading
  and text faces, Lattice buttons, the two-column grid, the layers, the eyebrow style.
  (2026-10-18)
- Apps are told apart by something other than colour. Candidates are in R7; Anil to pick.
  The illustration is per app regardless. (2026-10-18)

## Process (R7 clean-up)
- The Figma explorations page holds only the current design and the parts it uses.
  Superseded options are deleted from Figma. Their history lives in
  `apps/<app>/rounds/` (screenshots) and `apps/<app>/log.md`. Why: Anil asked to remove the
  earlier proposed screens. This replaces "killed options stay in Figma". (2026-10-18)

## Buttons (R8)
- Buttons follow vibrant.design's "Explore Moodboards" button, in brand blue. The primary
  button is brand blue, no longer ink. Why: Anil: "design our buttons like 'explore
  moodboards' from vibrant.design but using our brand blue". This replaces the R5 Lattice
  construction and widens where brand blue appears. (2026-10-18)
- Button hover and press follow the same source: hover lightens the primary 6% and
  darkens the secondary 4%; press scales the surface to 0.99; 150ms ease-out cubic.
  Why: Anil asked for the reference's hover and click effects. (2026-10-18)
- The TOS nav's Sign in and Create account use the Button set (Small Secondary and
  Primary) instead of www-tos's pills. Why: Anil: "also use the buttons in nav". This
  changes the "exact www-tos" nav, so www-tos needs the same change. (2026-10-18)
- Containers of shadowed or stroked elements don't clip content, and they leave 2px of
  room. Why: Anil fixed the hero CTA where buttons showed cut. "if they have shadows, and
  you use 'clip content' the shadows or effects will be clipped". (2026-10-18)
- The hero gets a very minimal grain accent in its top-left corner, so the nav and the
  hero's left side don't blend. Why: Anil: "the nav and the hero left are blending, we
  should add very minimal accent there as well, mostly on the top left but very
  minimal". (2026-10-18)

## Page story (R10)
- The page follows the "control first" arc in narrative.md: hero → how it works for you →
  what you get → the second audience → developer handoff → closing. Why: Anil picked it
  from three arcs. (2026-10-19) (framework? to be confirmed on a second app)
- Product snippets (interface vignettes) are built from Silicon UI components, the
  product's real UI, and not from the website's buttons. Why: Anil: "the interface
  snippets we add, they don't use the website design... we're using silicon-ui for
  that". (2026-10-19)
- Landing copy is written and reviewed with the grounded-copywriting method: sourced
  claims only; problem then solution with no middle beat; technical claims flagged. Each
  app keeps `copy.md` with a sentence-level audit. Why: Anil asked to try this framework
  for writing the content. (2026-10-19)
- "How it works" sections use a step list beside one sticky stage. The active step
  follows scroll (or a click) and the stage shows that step's product snippet. Why: Anil
  picked R10·B. (2026-10-19) (framework? the pattern fits any app with a three-moment story)

## Type (R10)
- Landing pages use **two faces only**: **GT Alpina** (Light) for display headings and
  **Hanken Grotesk** for everything else (eyebrows, step titles, numbers, body, UI). **No
  Geist.** Why: Anil: "don't use geist, only hanken grotesk, and gt alpina". This
  replaces the Geist display face from the Silicon UI base. Product snippets follow
  Silicon UI, which is Hanken-only in them too. (2026-10-19)
  Flag: the Figma file uses **GT Alpina Trial**, a trial font. The site needs a licensed
  GT Alpina webfont before launch.
- The framework is also written as a playbook (`playbook.md`): for each section,
  given this content, use this design. Each entry is filled in with the Accounts example
  and updated as sections are decided. Why: Anil: "can we also verbalize the framework...
  given this is the content, this is the design we use". (2026-10-19)

## Variety (R11)
- Not every section uses the same surface. Section surfaces rotate between the Columns
  backdrop (hero, stages) and **solid brand blocks**: brand blue #1F5CB1, ink #141414,
  light tint #E6EEF9. Text on blue and ink is paper at 72–100%. Why: Anil: "there's a
  boring uniformity in everything with the same pattern and same colors, use some solid
  color for the bento boxes". (2026-10-20)
- Unordered facts with a screen each use a **bento**. Why: Anil picked R11·A. (2026-10-20)
