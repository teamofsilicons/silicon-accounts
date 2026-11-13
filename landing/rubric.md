# Rubric

A page ships only when every item passes. Each critique records pass / fail plus the
evidence (a screenshot, a node id, a measured value), not just a tick.

Every time a round fixes a mistake, add a line here so the mistake can't come back. Note
where each line came from.

## Clarity
- [ ] **5-second test.** Someone seeing only the first view can say what this is, who it's
      for, and what to do next. _(seed)_
- [ ] **One primary action per viewport.** Secondary actions read as secondary. _(seed)_

## Layers
- [ ] **Two layers.** The hero has a base layer (backdrop) and a content layer (text plus
      illustration). _(from R2: all three directions were killed for lacking this)_
- [ ] **No per-app colour.** Brand blue is the only hue, on every app: backdrop, eyebrow, primary button. _(from R7, R8)_
- [ ] **Tellable apart.** Put two app pages side by side; you can tell which is which without reading the heading. _(from R7)_
- [ ] **No duplicate destinations.** Each destination appears once in the nav. Audience paths live in the page. _(from R6)_
- [ ] **No invented logos.** An app without a logo shows its name as text. _(from R5)_
- [ ] **TOS nav untouched.** The top tier matches www-tos exactly. _(from R5)_
- [ ] **Text sits on paper.** The backdrop's clear zone covers the writing column, so text
      holds 4.5:1 or better. _(from R3)_

## Story
- [ ] **One job per section.** Every section maps to one job in `narrative.md`, and no job
      appears twice. _(seed)_
- [ ] **Grounded copy.** Every claim traces to a source in the brief. No invented proof. _(seed)_
- [ ] **Copy audited.** `apps/<app>/copy.md` has a sentence-by-sentence audit with sources.
      There are no absence claims, and control isn't overstated. _(from R10: "you choose
      what each one gets" and "sign in your way" overstated the source)_

## System
- [ ] **Grid.** The nav and hero use the foundations grid and spacings (96 / 576 / 96, 128
      inset, 40 rhythm). _(from R2: no layout system)_
- [ ] **Calm type.** The hero heading is no bigger than the foundations step. _(from R2)_
- [ ] **No one-off values.** Type, colour, spacing and radius are Silicon UI tokens or
      logged foundations. _(seed)_
- [ ] **Patterns, not snowflakes.** Each section is an approved pattern or is marked as a
      candidate for one. _(seed)_

## Craft
- [ ] **Edges are visible at 1×.** Check borders and rings at 1× and 4×. An inside gradient
      stroke close to the fill colour reads as no border at all. _(from R8: Anil spotted
      buttons with no visible border)_

- [ ] **Nothing clipped.** Frames holding buttons, cards or anything with an effect have
      clip content off and 2px room. Check edges at 4×. _(from R8: Anil fixed buttons cut
      by clipping in the hero CTA)_

- [ ] **Snippets look like the product.** Product UI vignettes use Silicon UI components
      (ink primary, radius 6, no marketing gloss). _(from R10: Anil caught website
      buttons inside product snippets)_

- [ ] **Two faces only.** GT Alpina for headings, Hanken Grotesk for everything else. No
      Geist. _(from R10)_

- [ ] **No monotony.** Two adjacent sections don't share the same surface treatment. Mix
      the Columns backdrop with solid blue, ink and tint blocks. _(from R11)_

## Reach
- [ ] **390 works.** No horizontal scroll; the hero's primary action is visible without
      scrolling. _(seed)_
- [ ] **Contrast.** Text is at least 4.5:1, large display text at least 3:1. _(seed)_
- [ ] **Reduced motion.** Every animation has a still equivalent. _(seed)_
- [ ] **Light and dark.** Both themes are checked. _(seed)_
