# Silicon UI: CommandPalette's Esc button name and its options' keyboard focus

Filed 2026-11-12 as https://github.com/teamofsilicons/silicon-ui/issues/30. Found by the account site's overlays audit (e2e ux-audit-overlays, 2026-11-12),
on both the account site's ⌘K menu and the developer site's.

## Bug report (Silicon UI's *Bug report* form)

**Component:** `command-palette` (`CommandPalette`)

**1. The Esc button's name doesn't contain its visible word (WCAG 2.5.3 Label in Name, axe
`label-content-name-mismatch`, serious).** The button shows "Esc" but is named `aria-label="Close command palette"`, so
someone using voice control who says "click Esc" gets nothing.
Fix: include the visible word, e.g. `aria-label="Esc, close command palette"`, or drop the aria-label and add the
words visually hidden after "Esc".

**2. The options are Tab stops with no visible focus (WCAG 2.4.7 Focus Visible).** Each result is a `<button
role="option">`, and Tab moves onto it, but nothing changes on screen (the audit compares pixels before and after each
Tab). In a listbox the options are reached with the arrow keys while focus stays in the search field
(`aria-activedescendant`), and Tab leaves the list. Fix either: options `tabIndex={-1}` (arrows only), or a
`:focus-visible` ring on `.item`.

**3. Its quiet text uses `--text-muted`** (the Esc key, group headings, each option's description). On the account
site that token is #8E8E8E, 3.27:1 on white, which is under 4.5:1. That's the site's token, not the component's, and is
being decided on the site (redesign/priorities.md). Listed so the component's defaults are checked too.

**Implemented locally 2026-11-12:** the Esc button's name includes "Esc"; options leave the Tab sequence while
arrow keys and Enter continue to work; quiet text uses `--text-secondary` for adequate contrast with the library's
default surfaces. The account site's 0.4.0 pnpm patch carries the fix until release. The four `shell-palette` screen
checks verify the keyboard behavior and focus return at 1440/390 px in light/dark. The GitHub issue remains open.
