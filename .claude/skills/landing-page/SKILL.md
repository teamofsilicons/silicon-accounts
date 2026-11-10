---
name: landing-page
description: Design or review a landing page for any Silicon app using the landing framework in landing/. Use when asked to design, iterate on, critique, or start a landing page for a Silicon app (Accounts, Apps, Briefcase, …), or to record a landing design decision.
---

# Landing page

You are working inside the Silicon landing framework. It learns from every round, so
following the capture step is as important as the design itself.

## Before anything

1. Read, in order: `landing/README.md`, `landing/playbook.md`, `landing/principles.md`, `landing/foundations.md`,
   `landing/narrative.md`, `landing/rubric.md`, `landing/decisions.md`, and every file
   in `landing/patterns/`.
2. Read `landing/apps/<app>/brief.md`, `decisions.md` and `log.md`. If the app has no
   folder, start one from `landing/brief-template.md`, and treat filling in the brief as
   the first round.
3. **Do not open any existing landing page for this app**, in code, screenshots, audits or
   old decision logs, as design input. Facts come from the app's understanding doc and
   from Anil.

## Each round

1. **Brief.** State in one line what this round decides. Take it from the last
   critique's weakest item, or from Anil.
2. **Explore** in Figma (load `figma:figma-use` and `figma:figma-generate-design` first).
   - Make 2–3 options that differ in idea, not in detail.
   - Use Silicon UI tokens and logged foundations only. A new value is a proposal, and
     you name it as one.
   - Use approved patterns where they fit. A new section is a pattern *candidate*.
   - Put options on `<App> — Explorations`, labelled `R<n> · <option> · <one-line idea>`.
   - Every auto-layout frame you create gets `clipsContent = false`. Frames that hold
     buttons or anything with an effect get 2px padding (take it back from the parent's
     padding to keep alignment). Clipping cuts off strokes and shadows.
   - Fonts: **GT Alpina** (Light) for headings and **Hanken Grotesk** for everything else.
     **Never Geist.** GT Alpina Trial is local to Anil's machine, and the Figma MCP can't
     load it. So headings you create go in Hanken as a placeholder, named
     "Heading (set GT Alpina Trial Light 36/44 by hand)", and you tell Anil which nodes need
     switching. Never quietly substitute any other face.
3. **React.** Show Anil the options (screenshots) and ask which to keep, kill or merge.
   Don't pick for him.
4. **Capture.** Do this in the same turn as the decision:
   - Add a line to `landing/apps/<app>/log.md` with the round, the options, the Figma
     node ids, and the outcome.
   - Write each decision as `- <decision>. Why: <reason>. (YYYY-MM-DD)`. Then ask: *would
     this hold for any Silicon app?* If yes, it goes in `landing/decisions.md`, and you
     update the principle, foundation or pattern it touches. If no, it goes in
     `landing/apps/<app>/decisions.md`. If you're unsure, put it in the app file and
     mark it `(framework?)`.
   - If the decision corrected a mistake, add a rubric line naming where it came from.
   - Save screenshots of every option to `landing/apps/<app>/rounds/` before deciding.
     Once Anil decides, delete the losing options from Figma; the screenshots and the log
     are the history.
   - When a section is decided, add or update its entry in `landing/playbook.md`
     (Given / Use / Behaviour / Not / Copy rules / filled-in example / Check), linked to
     its decision.
5. **Critique.** Score the current page against `landing/rubric.md`, with evidence for
   each line. Name the weakest item. It becomes the next round's brief.

## Rules

- Copy follows `landing/narrative.md` § Copy rules. Every claim traces to the brief's
  sources, and there's no invented proof. Draft and review it with the
  `anthropic-skills:grounded-copywriting` skill, and keep `landing/apps/<app>/copy.md` up to
  date: an audit table (sentence, verdict, source), the rewrite, and the flags.
- A pattern moves from candidate to approved only when Anil approves it, and that
  approval gets logged.
- Never close a round with a decision that isn't written down.
- Code is a separate step, after Anil signs off the Figma page. Use
  `figma:figma-design-to-code`, and build sections as components that match the
  pattern files.
