# Silicon UI: Date picker clipped inside a dialog

Drafts for review. Nothing is filed or pushed yet. The fix is on the local branch `fix/date-picker-in-dialogs` in
`~/Documents/silicon-ui-date-picker-fix` (a worktree of the Silicon UI repo, from `origin/main` 1a187db). It isn't
committed yet.

## 1. Bug report (Silicon UI's *Bug report* form)

**Component or block id:** `date-picker`

**What happened?**
Inside a Dialog, opening a Date picker shows only the top of its calendar; the rest is cut off at the dialog's edge.
The calendar is positioned inside the field (`position: absolute` under `.anchor`), so any ancestor that clips its
overflow cuts it: Dialog's content (`overflow: auto`), Drawer, Bottom sheet, or any scrolling box. Popover, Select and
the menus don't have this problem, because they portal through Radix.

**Steps to reproduce**
1. Put a `DatePicker` inside a `DialogContent` with little or nothing below it.
2. Open the dialog, then open the date picker.
3. The calendar is clipped at the dialog's bottom edge; the days below the first row can't be reached.

**Framework:** Next.js 16, React 19 (Silicon Accounts)
**How did you install it?** npm, `@teamofsilicons/silicon-ui@0.4.0`
**Browser and OS:** Chrome, macOS
**Theme:** light

**Anything else?**
Time picker (`.menu`) and Date range picker (`.panel`) are also positioned inside their field and are probably
affected the same way; worth checking with the same fix.

## 2. Pull request

**Title:** Date picker: open the calendar above any container

**Body:**

Fixes #<bug number>.

The Date picker's calendar was positioned inside the field, so a Dialog, Drawer or any scrolling box clipped it. It now
uses Radix Popover's `Anchor`, `Portal` and `Content`, as Popover does: portaled to the page, placed below the field or
flipped above it when there is no room, and kept inside the screen (`collisionPadding` 10).

The trigger, its keyboard handling and the motion are unchanged. These behaviours were carried over from the old code:

- Opening moves focus to the day with the tab stop. This now runs in `onOpenAutoFocus`, once the portaled calendar
  exists.
- A click outside closes the calendar. "Inside" now means the field or the calendar, since the calendar is portaled.
- Tabbing past the field or the calendar closes it.
- Escape closes the calendar. Inside a Dialog it closes only the calendar: the content carries `ESCAPE_LAYER_ATTRIBUTE`,
  and Radix's layer stack handles Escape.
- The description fades while the calendar is open (`.field[data-open]`), the calendar grows from the side it opens on
  (`--radix-popover-content-transform-origin`), and on phone widths it matches the field
  (`--radix-popover-trigger-width`).

No API changes. CHANGELOG has a Fixed entry for 2026-10-30.

**Checked:**
- `npm run check`: typecheck, lint, registry and tokens pass.
- `npm run check:component date-picker`: all required checks pass. Its two warnings, raw `<button>` and undocumented
  props, were there before this change.
- In Silicon Accounts, with the built package in a Dialog:
  - the calendar opens in full, flipped above the field;
  - focus lands on the selected day, ArrowRight and Enter pick the next day, and focus returns to the field;
  - Escape closes the calendar but not the dialog;
  - a click on the dialog outside the calendar closes the calendar but not the dialog;
  - a second click on the field closes it.

**Not checked:** Storybook, dark theme, phone width, reduced motion.

## 3. After it ships

The Personal info date of birth dialog switches from the interim inline Calendar (`DobCalendarForm` in
`components/account/identity/identity.tsx`) back to `DobForm` (a year list and the Date picker).
