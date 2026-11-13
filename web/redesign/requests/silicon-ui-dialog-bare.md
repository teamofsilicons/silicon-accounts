# Silicon UI: Dialog can't hold a command palette (no way to hide its title row)

Filed 2026-11-12 as https://github.com/teamofsilicons/silicon-ui/issues/31.

## Component request (Silicon UI's *Component request* form)

**Component:** `dialog` (`DialogContent`)

**What's missing?**
A way to open `DialogContent` without its visible header. Today it always draws the title, the optional description
and the close button above its body, and `title` is required. A command palette (Silicon UI's own `CommandPalette`)
is its own header: the search field sits at the top, Escape closes it, and a second title row and an X above the
field are extra chrome the prototype doesn't show.

**Where it's needed:** the account site's ⌘K menu (`components/foundation/shell/command-menu.tsx`) and the docs search
(`components/docs/docs-search.tsx`). Both put `CommandPalette` in a modal layer, so they import `@radix-ui/react-dialog`
directly to get a dialog with no header. That's the last direct Radix use in the site.

**Implemented locally 2026-11-12:** `DialogContent` now accepts `hideHeader` and `placement="top"`. The title and
optional description stay available to assistive technology; the visible header, close button and body padding are
removed. The account command menu now uses this shared Dialog through the site's 0.4.0 pnpm patch. The standard
Personal info name dialog still passes all four desktop/phone and light/dark screen checks. The GitHub issue remains
open until the deferred release.
The account site's docs search moved onto it too (2026-11-12); that page is only reachable through the developer
site now, whose own docs search keeps direct Radix until its vendored Silicon UI has `hideHeader`.

**Suggested API:**

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent title="Search and jump" hideHeader /* title stays for screen readers; no visible header, no X */ placement="top">
    <CommandPalette … />
  </DialogContent>
</Dialog>
```

- `hideHeader` (or `titleHidden`): the title is rendered visually hidden, so the dialog keeps its accessible name; the
  description and the close button aren't drawn; the body has no top padding.
- `placement="top"` (optional): the panel sits near the top of the viewport, as palettes usually do, instead of
  centred. Without it, centred is fine.
- Everything else as today: the overlay, the entrance motion, Escape layering, focus return.

Or a `CommandDialog` that wraps `CommandPalette` in this kind of dialog.
