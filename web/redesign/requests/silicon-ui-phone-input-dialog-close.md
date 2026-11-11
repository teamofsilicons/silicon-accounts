# Silicon UI: PhoneInput's arrow overlaps the calling code; Dialog's close button (filed 2026-11-10: teamofsilicons/silicon-ui#28, #29)

Found on the account site's Security page (2026-11-10), in the "Text code" and "Email code" dialogs. Silicon UI 0.4.0.

Status (2026-11-10): both fixes are implemented in Silicon UI source and in the account site's local 0.4.0 package patch. The upstream changes are saved in `../silicon-ui-issues-28-29.patch`; publishing and upgrading the package remain deferred at Anil's request. Keep the GitHub issues open until a release ships.

PhoneInput audit follow-up (2026-11-10): unsupported international numbers and extra digits now remain visible instead of being rewritten or cut off; an unsupported draft emits an empty value and browser forms reject it. Restricted country lists choose an allowed default, disabled fields do not submit their hidden value, and validation refers only to visible text. The saved upstream patch and local package patch include these fixes.

Picker follow-up (2026-11-10): the country list was cropped by the account site's scrollable Security dialog, and its fixed 22 px round corners did not match the phone field's control tokens. The shared picker now escapes the scroll clip, follows the field on scroll and resize, and uses its radius and corner shape. The opening scroll shows complete option rows. This is implemented locally in both patches; the release remains deferred.

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

## 3. Dialog title, field hints and inherited tracking (not filed yet)

Found 2026-11-10 in the same Text code dialog with the type inspector. Applied in the account site's local 0.4.0 package
patch only (the Silicon UI source wasn't at hand, so `../silicon-ui-issues-28-29.patch` doesn't include it).

- Dialog's title is 18/500 on the body face and tracking, between a heading and a label. The account site's scale
  (Anil, 2026-11-10) makes it a heading: `--font-display`, 600, `--tracking-display`.
- Field hints and errors are 12/400, which no role on the scale has. They're now `--text-sm` (14/400) in Input,
  Textarea, OtpInput, PhoneInput, MoneyInput, NumberField, PasswordField, PasswordStrength, TagInput, Select, Combobox,
  DatePicker, MultiSelect, TimePicker and ColorPicker.
- An `em` letter-spacing set on a parent is inherited as pixels, so a 12px hint under a 14px field or a 14px button
  label under a 16px body gets the parent's tracking. Button, Dialog's description and the hints above now set
  `letter-spacing: var(--tracking-body)` themselves.
- Ask: the same in Silicon UI, or a token for the dialog title's weight and the hint size, so a product can set them.

## 4. Button: a `link` variant (not filed yet)

Asked 2026-11-10 (Anil: "any reason for this to be a button and not a link?"). The phone field's "Country Not in the
List?" and the code step's "Use a Different Number" change the field in place, so they are buttons; Silicon UI's only
quiet button is ghost, a box on hover, which reads as a control rather than a word. Added in the local 0.4.0 patch:

- `variant="link"` on Button (and so ButtonLink): no box, height or padding (the size keeps its font size),
  `--text-secondary`, the label underlined 1px at 3px below in `--border-strong`; on hover, focus and press the text and
  the line take `--foreground`.
- `--button-link-underline` sets the resting line's colour; `transparent` shows it on hover only.
- Compared in /__links: ghost (now), underlined, underline on hover.
- Ask: the same variant in Silicon UI.

## 5. Field size variables (not filed yet)

Asked 2026-11-10 (Anil: the Text code dialog "doesn't have hierarchy"; nearly everything under the title was 14px).
Added in the local 0.4.0 patch, defaults unchanged:

- `--field-text-size` (default `--text-sm`): the typed text in Input, Textarea and PhoneInput. 16 makes the content
  the largest text after the title, and stops iOS Safari zooming into a field under 16px.
- `--field-hint-size` (default `--text-sm` since §3): hints and errors in the 15 form components from §3.
- Compared in /__dialog (typed text 16, hints 12/400).
- PhoneInput's calling code is the start of the number (Anil: "country code is an extension of the mobile number"): the
  closed field's flag and code take `--field-text-size` and weight 400 (were 14/500); the country search too; in the
  list, a country's code is the name's size (was 12), still muted.
- Ask: the same variables in Silicon UI, or typed text at 16 by default.

## 6. Field variables everywhere, and labels' tracking (not filed yet)

2026-11-10, local patch: `--field-text-size` also sets the value text of Select, Combobox, DatePicker, MultiSelect,
TimePicker, PasswordField and TagInput (and TagInput's placeholder). Every field's label sets
`letter-spacing: var(--tracking-body)` itself, as §3 did for hints and Button (it inherited a 16px parent's tracking).

## 7. Dialog width (not filed yet)

2026-11-10: DialogContent is always 440px, and Calendar is at most 328px, so a dialog holding a calendar leaves a 78px
gap at its right. Local patch: `width: min(…, var(--dialog-width, 440px))`. Ask: a `size` prop or the same variable.

## 8. Input: prefix and suffix slots (not filed yet; see also requests/silicon-ui-input-prefix.md)

2026-11-11, local patch: `prefix` and `suffix` (ReactNode) on Input. With either, the bordered box is a wrapper around a
bare input, the prefix in line with the typed text at its size in `--text-secondary` with no gap, the suffix after it;
hover, focus, invalid and disabled styles move to the box. Used by the account site's id field ("c:", "si:").
