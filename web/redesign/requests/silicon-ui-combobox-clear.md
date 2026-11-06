# Silicon UI: Combobox's clear icon renders smaller than its chevron

Draft for review. Nothing is filed yet, and the fix hasn't been made or tried in the Silicon UI repo.

## 1. Bug report (Silicon UI's *Bug report* form)

**Component or block id:** `combobox`

**What happened?**
With a value selected, the clear × is visibly smaller and thinner than the chevron beside it, though both are set to the
same size, stroke and colour (Lucide, `size={16}`, `strokeWidth={1.75}`, `--text-muted`).

`.clear` is a 22 px button with `box-sizing: border-box` and no padding reset, so it keeps the browser's default
`padding: 1px 6px`. That leaves 10 px of content width, and the 16 px icon shrinks to fit:

| | Chevron | Clear × |
| --- | --- | --- |
| Icon box | 16 × 16 | 10 × 16 |
| Width of the drawn shape | 8 px | 5 px |
| Stroke, scaled from 1.75 in the 24 unit viewBox | about 1.2 px | about 0.7 px |

**Steps to reproduce**
1. Render a `Combobox` with `options` and a selected `value`, in a page without a CSS reset for `button` padding.
2. Inspect `.clear svg`: its computed width is 10 px, not 16.
3. Compare the × with the chevron: it is about 60% of the chevron's scale.

**Framework:** Next.js 16, React 19 (Silicon Accounts)
**How did you install it?** npm, `@teamofsilicons/silicon-ui@0.4.0` (byte-identical to the npm package)
**Browser and OS:** Chromium (the Claude desktop app's browser pane), macOS
**Theme:** light

**Anything else?**
A page with a global `button { padding: 0 }` reset would hide this, so it may not show where that reset exists. Other
components' small icon buttons haven't been checked for the same missing reset.

## 2. Pull request

**Title:** Combobox: clear icon at its full size

**Body:**

Fixes #<bug number>.

The clear button kept the browser's default padding, which left its 16 px icon 10 px of width, so the × drew smaller and
thinner than the chevron. It now resets its padding.

```diff
-.clear { display: grid; width: 22px; height: 22px; flex: 0 0 auto; place-items: center; border: 0; border-radius: var(--radius-control); ...
+.clear { display: grid; width: 22px; height: 22px; flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: var(--radius-control); ...
```

**To check before opening it:** the icon's computed size is 16 × 16; the × and chevron match in light and dark; hover and
keyboard focus on the clear button still look right.

## 3. After it ships

Update `@teamofsilicons/silicon-ui` in the account site and look at the Timezone field on `/silicons/new`. No site code
needs changing: the site doesn't work around this.
