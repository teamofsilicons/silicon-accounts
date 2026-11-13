# Silicon UI: Input has no prefix or status slot

Draft for review. Nothing is filed yet.

## Component request (Silicon UI's *Component request* form)

**Component:** `input`

**What's missing?**
A fixed prefix inside the field (for ids: `si:` or `c:`, also units like `https://` or `@`) and a trailing status icon
(checking, available, taken). `InputProps` is the native input's props plus `label`, `description` and `error`, so
there is nowhere to put either.

**Where it's needed:** the account site's id fields: Create a Silicon (`/silicons/new`) and every "change id" dialog.

**What the site does meanwhile:**
- Create a Silicon shows the whole id as the Input's value (`si:scout`) and strips a typed prefix. Its status is the
  Input's own `description` or `error`.
- `components/account/parts/id-field.tsx` (the change-id dialogs) still lays a prefix and an icon over the Input with
  its own CSS. That breaks the "never restyle a component" rule, and it goes once Input has the slots.

**Suggested API:** `prefix?: ReactNode`, `suffix?: ReactNode` (or `status?: "checking" | "success" | "danger"`),
both inside the field's border, with the text padded to match.
