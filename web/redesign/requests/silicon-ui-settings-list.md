# Silicon UI: no settings list (rows of label, value and an action)

Draft for review. Nothing is filed yet.

## Component request (Silicon UI's *Component request* form)

**Component:** new, e.g. `settings-list` (`SettingsList`, `SettingsRow`)

**What's missing?**
A titled group of rows, each showing one setting: a label, its current value and a way to change it. It's the most
common shape on an account page, and nothing in Silicon UI draws it. `Card` holds a title and free content, but has no
rows; `NavList` is navigation; `SortableDataTable` is data, not settings; `InlineEdit` edits in place, where these rows
open an editor (a dialog).

**Where it's needed:** the account site's Personal info (`/personal`: Profile and Contact), and the same rows on
Security, Settings and a Silicon's own page (`/silicons/[uuid]`). The prototype (`redesign/prototype-v7.html`, `.scard`
and `.srow`) draws them as a bordered box with its title inside, then rows of: a 150 px label column, the value, and a
chevron; the whole row opens the editor.

**What the site does meanwhile:** Personal info puts each group in a `Card` (its title is the group's) and draws the
rows itself (`components/account/identity/identity.tsx`, `Row`), as links styled with tokens and the type roles. Those
rows go once this ships.

**Suggested API:**

```tsx
<SettingsList title="Profile" description?>
  <SettingsRow
    label="Name"
    value="Anil"                // ReactNode: text, mono text, an Avatar, a muted "Not added"
    detail?="c:old stays reserved until Nov 19"   // a line under the value
    end?={<Badge>Primary</Badge>}
    href?="/personal?edit=name" // the whole row is a link (Next's Link through SiliconProvider), with a chevron
    onSelect?={() => …}         // or the whole row is a button
    action?={<Button size="sm" variant="ghost">Edit</Button>}  // or an explicit action instead of the whole row
  />
</SettingsList>
```

**Behaviour to include:**
- Hover and pressed fills on a whole-row action; a focus ring on the row; `aria-describedby` from the value.
- A row with an empty label continues the one above it (several emails under one "Email").
- Under ~560 px the label sits above the value.
- Rows separated by hairlines; the group's border and radius match `Card`.
