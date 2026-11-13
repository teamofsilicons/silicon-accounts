# Tabs: a thinner frame around the tabs

Filed as teamofsilicons/silicon-ui#32 (2026-11-13, Anil's OK). The account site carries the change in its 0.4.0 pnpm patch until a release has it.

## Issue

Found in Silicon UI 0.4.0.

**What happens:** `TabsList` puts 4px of padding around its tabs inside the strip's border. Next to the page's other controls the strip reads heavy: with two short tabs, the grey frame takes as much space as a tab's own padding, and the strip is 42px high beside 32px buttons.

**Ask:** 2px around the tabs (the strip becomes 38px high), with the two things that thinner frame needs:

- **The keyboard ring inside the tab.** 2px is too thin to hold the outline outside a tab; it's drawn inside, as the scroll buttons already do (`--focus-outline-offset: -3px`).
- **Corners that stay concentric.** The tab, its selection (which inherits the tab's radius) and the hover fill take the strip's radius less 2px instead of less 4px.

The 4px gap between tabs, the tabs' minimum width, height and side padding stay as they are, so the selection never touches its neighbour.

```diff
-.list { … gap: var(--space-tight); padding: var(--space-tight); }
+.list { … gap: var(--space-tight); padding: var(--space-hair); }
-.trigger { … border-radius: calc(var(--radius-control) - var(--space-tight)); … }
+.trigger { … border-radius: calc(var(--radius-control) - var(--space-hair)); … }
+/* The frame around the tabs is 2px, too thin to hold the keyboard ring outside a tab, so the ring is drawn inside it. */
+.trigger:focus-visible { --focus-outline-offset: -3px; }
-.hover { z-index: -1; border-radius: calc(var(--radius-control) - var(--space-tight)); … }
+.hover { z-index: -1; border-radius: calc(var(--radius-control) - var(--space-hair)); … }
```

Checked in the account site with this change: the strip is 38px high, the selection sits 2px from the strip's edge with concentric corners, and the keyboard ring on a focused tab shows whole inside it.
