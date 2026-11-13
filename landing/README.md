# Landing framework

How Silicon apps get their landing pages: one bar for quality, one feel across apps,
and no two pages that are copies of each other.

It is being built by designing one page, Silicon Accounts, from scratch, and writing
down every decision as it's made. What survives that page and would hold for *any* app
becomes the framework. What only holds for Accounts stays in `apps/accounts/`.

This folder is app-agnostic on purpose. It lives in `silicon-accounts` for now and is
meant to be lifted out whole.

## Read in this order

| File | What it holds |
| --- | --- |
| `playbook.md` | **Start here.** The framework in plain words: given this content, use this design, built like this, checked like this. One entry per section. |
| `principles.md` | The beliefs. Few, sharp, each with a reason. Everything else follows from them. |
| `foundations.md` | Type, grid, rhythm, colour use, imagery, motion for landing pages, on Silicon UI's base. |
| `narrative.md` | The jobs a page has to do, in order, and the rules for copy. |
| `patterns/` | Approved sections, one file each. Only sections that survived a real page. |
| `rubric.md` | The checklist a page must pass before it ships. |
| `decisions.md` | Every framework-level decision, dated, with its reason. |
| `brief-template.md` | What an app has to fill in before any design starts. |
| `research/` | What we've learned from outside (e.g. how other companies structure their nav). |
| `apps/<app>/` | That app's brief, its own decisions and its round-by-round log. |

The Claude skill at `.claude/skills/landing-page/` loads all of this and runs the loop below.

## Ground rules

- **Silicon UI is the base.** Geist for display, Hanken Grotesk for text, Silicon UI's
  neutral greys, lucide icons, the spacing and radius tokens. Pages explore
  composition, scale, rhythm, imagery, motion and story on top of that. A new font or
  colour is a decision, and it gets logged.
- **No reference to any existing landing page.** Facts come from the app's
  `understanding/UNDERSTANDING.md` (or equivalent) and from Anil. The old page is not
  input, visual or verbal.
- **Outside references are allowed for structure only.** Anil may share them (layout,
  spacing, layering), but we don't copy their fonts, colours or content.
- **Figma first.** We decide in Figma (file: *Silicon — Landing framework*). Code comes
  after the design is signed off.
- **Nothing is decided until it's written down.** A round doesn't close with an
  undocumented decision.

## The loop

Every round, for every app:

1. **Brief.** One line: what this round decides.
2. **Explore.** 2–3 genuinely different options in Figma. Never three tweaks of one idea.
3. **React.** Anil keeps, kills or merges.
4. **Capture.**
   - Log the decision and the reason.
   - Sort it: would it hold for any Silicon app? Then it goes into `decisions.md`, and from
     there into a principle, foundation or pattern. If not, it goes into
     `apps/<app>/decisions.md`.
   - If it corrected a mistake, add a line to `rubric.md` so the mistake can't come back.
   - Add the round to `apps/<app>/log.md` with its Figma node ids, and save screenshots
     of every option in `apps/<app>/rounds/`. Once a round is decided, delete the losing
     options from Figma; the screenshots and the log are the history.
5. **Critique.** Score the page against `rubric.md`. The weakest item becomes the next
   round's brief.

## Figma file layout

- `Foundations`: type specimen, grids at 1440 / 1024 / 390, rhythm, colour use, imagery, motion notes
- `Patterns`: approved sections as components with their variants
- `<App> — Explorations`: the current design and its parts, plus the open round's options
- `<App> — Page`: the chosen page at 1440 and 390

## Status

Accounts R6: one nav (the TOS nav, with Developers), no app bar. See `apps/accounts/log.md`. Research lives in `research/`.
