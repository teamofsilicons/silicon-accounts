# Silicon UI: PhoneInput's arrow overlaps the calling code; Dialog's close button (filed 2026-11-10: teamofsilicons/silicon-ui#28, #29)

Found on the account site's Security page (2026-11-10), in the "Text code" and "Email code" dialogs. Silicon UI 0.4.0.

## 1. PhoneInput: the country arrow sits on top of the calling code

The country part is sized from a hidden copy (`.measure`), but the copy leaves out the 8px gap the visible part has
between the flag and the code (`.layer { gap: var(--space-related) }`). The visible part is 8px wider than the room it
gets, so the chevron (`right: var(--space-group)`) lands on "+91".

- Measured with India (+91): the code ends at 601px and the chevron starts at 597px (4px overlap) with
  `--space-block: 32px`; 14px of overlap with `--space-block: 24px`, since the trigger's right padding is
  `--space-block` and our compact density sets it to 24.
- Ask: give `.measure` the same gap as `.layer` (or measure the layer itself), and reserve the chevron's room from its
  own size instead of `--space-block`, so a product that tightens its spacing scale doesn't move the arrow.

## 2. Dialog: the close button

`DialogContent`'s close is a 24px square with a 1px border and a half-transparent grey fill, in the dialog's top
corner. Beside a title and the page's outlined buttons it reads as a stray control.

- Ask: a quieter close (a ghost icon button, no border, the same size as other icon buttons), or a prop to style it
  as one of Button's variants.
