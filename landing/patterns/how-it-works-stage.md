# How it works: step list + sticky stage

**Status:** candidate (R10, 2026-10-19). Anil picked it for Accounts.
**Narrative job:** "How it works for you". The control story in three moments.

## Use it when
The story is a sequence of 2–4 moments, each with a real product screen to show.

## Don't use it when
The moments aren't sequential, or there's no product UI to show. Use a grid of equal
steps instead (R10·A, in `apps/accounts/rounds/`).

## Anatomy
- Section: paper, padding 120 / 96, gap 64.
- **Left column (576):**
  - section header: eyebrow (Hanken SemiBold 16, uppercase, brand blue), heading
    (display), lede (Hanken 16/24)
  - step list: number (Geist Medium 14) and title (Geist Medium 20)
  - the active step gets a surface-muted pill (radius 12, padding 20) and shows its body copy
- **Right column (576):** the stage. 576 × 560, radius 20, Columns backdrop at about 0.85
  intensity, with one Silicon UI product snippet centred.

## Behaviour (to build in code)
- The section is about one viewport per step tall. The stage is `position: sticky` and
  vertically centred.
- As each step's scroll range enters, that step becomes active. The previous snippet fades
  or slides out and the next one comes in: about 240ms, ease-standard. Under reduced
  motion it's a crossfade with no movement.
- Clicking a step scrolls to its range. Steps are buttons, and `aria-current` marks the active one.
- On mobile (390): no sticky. Each step stacks its own snippet under its text.

## Where it lives
- Figma: component set "Section · How it works" `93:322` (Step=1/2/3), with click-through in prototype `93:329`
- First used on: Accounts, R10
