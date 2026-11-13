# Design words

The words to use when asking for design changes, what each means, and what the v7 prototype calls it. Name the
element, then the property, then where the target look is: "On Security, make the **cards** look like the prototype's:
white **fill**, a **hairline border**, the **title inside the card header**."

## Where things are (layout)

| Word | What it is | In this site |
|---|---|---|
| **Shell** | The frame around every page: top bar, sidebar, page area | `foundation/shell` |
| **Top bar** | The strip across the top: brand, search, account menu | |
| **Sidebar** / **nav** | The list of sections on the left; each line is a **nav item** | Home, Silicons, … |
| **Canvas** | The background behind everything | Prototype: warm grey `#F2F1EE` |
| **Page panel** | A raised surface the page sits on, apart from the canvas | Prototype's white rounded box; the site dropped it (flat shell) |
| **Column** | The strip the page's content runs down; **narrow** (≈720–760 px) or **wide** | |
| **Aside** / **side column** | A second column beside the main one | Home's "Your details" |
| **Side panel** | A side column that an action opens | A Silicon's details |
| **Dialog** / **modal** | A box over the page that must be answered or closed | Review a request |
| **Drawer** / **sheet** | A panel that slides in from an edge (a **bottom sheet** on phones) | |
| **Header** | The top of a page or a card: title, a line of description, actions | |

## Building blocks (elements)

| Word | What it is | Prototype name |
|---|---|---|
| **Card** | A bordered box that groups related content | `scard`, `ocard` |
| **Card header** | The card's top row: its title (and count or action) inside the card | `.hd` |
| **Row** / **list row** | One line inside a card: something at the start, title, detail, an action or chevron at the end | `srow` |
| **Key–value row** | A row with a label column on the left and the value on the right | `srow .k / .v` |
| **Chevron** | The small `›` at a row's end meaning "opens something" | `.chev` |
| **Icon tile** | A small rounded square holding an icon, often softly tinted | `.tile` |
| **Avatar** | A picture or initials for a person; **Silicon avatar** = gradient rounded square with a spark | `.av`, `.si` |
| **App mark** | An app's icon: a dark rounded square | `.am` |
| **Ring** | A coloured outline around an avatar | `.ring` |
| **Avatar stack** | Overlapping small avatars ("You + 2") | `.stack` |
| **Badge** / **pill** | A small rounded label for a status ("Active", "Handing over") | `.pill` |
| **Count** | A small number badge (on a nav item or card header) | `.cnt` |
| **Chip** | A small rounded button used as a filter; dark when selected | `.chips` |
| **Button**: **primary** / **secondary** / **ghost** / **danger** | Filled dark / white with border / no border / red | `.btn.pri`, `.btn`, `.btn.ghost`, `.btn.danger` |
| **Icon button** | A button that is only an icon | `.iconbtn` |
| **Link** | Text that goes somewhere ("See all") | `.link` |
| **Field** / **input** | A box to type into; its **label** above, **help text** below | `.field`, `.lab`, `.help` |
| **Switch** / **toggle** | On/off control | `.sw` |
| **Tabs** | A row of labels switching what's below, with an underline on the current one | `.tabs` |
| **Handle** | Your id in a small grey chip; tap copies | `.handle` |
| **Key box** | A dark box showing a secret once | `.keybox` |
| **Danger zone** | A red-edged card for destructive actions | `.dz` |
| **Attention strip** | A tinted box that needs you | `.attn` |
| **Empty state** | What shows when there's nothing yet: dashed box, icon, a line, an action | `.empty` |
| **Toast** | A short message that pops up at the bottom and leaves | `.toast` |
| **Menu** / **dropdown** | A list that opens from a button | `.menu` |
| **Skeleton** | Grey placeholder shapes while loading | |

## How things look (properties)

| Word | Means | Example ask |
|---|---|---|
| **Fill** / **background** | The colour inside an element | "white fill, not grey" |
| **Border** / **stroke** / **hairline** | The line around an element; a hairline is 1 px and faint | "hairline border on cards" |
| **Divider** | A line between rows | "dividers between rows" |
| **Radius** / **corners** | How round the corners are (prototype: 8, 10, 14, 18 px) | "cards at 14 px radius" |
| **Shadow** / **elevation** | The soft shade that lifts an element | "no shadow", "the tiny shadow under buttons" |
| **Padding** | Space inside an element, between its edge and content | "more padding in rows" |
| **Gap** / **spacing** | Space between elements | "smaller gap between cards" |
| **Density** | How tightly things are packed overall | "denser rows, like the prototype" |
| **Size** / **height** | e.g. buttons 36 px, small buttons 30 px | "small buttons in rows" |
| **Type scale** | The set of text sizes: page title, card title, body, detail | "card titles at 16 px" |
| **Weight** | How bold text is (400 regular, 500 medium, 600 semibold) | "titles medium, not bold" |
| **Muted** / **secondary text** | Grey text for less important lines | "descriptions muted" |
| **Tint** / **soft colour** | A pale version of a colour as a fill (green fill, green text) | "status pills tinted" |
| **Accent** | The one highlight colour for links and focus | Prototype: blue; site: ink (decided) |
| **Alignment** | What lines up with what | "row titles align with the card title" |
| **State** | How it looks on **hover**, **pressed**, **focus**, **selected** / **active**, **disabled**, **loading** | "selected nav item is a white raised pill" |

## Motion

**Transition** (a change animated over time), **duration** (how long), **easing** (how it speeds up and slows down),
**stagger** (items moving one after another), **fade**, **slide**, **scale**.

## How to ask

- Say which **page**, which **element**, which **property**, and the **target**: "On Silicons, the Silicon cards: white
  fill, hairline border, 14 px radius, like the prototype's Silicons page."
- Say how close to go: **match exactly** (same sizes, colours and spacing) or **in the spirit of** (same idea, our
  tokens).
- Say what to keep: "keep no beige", "keep the flat shell".
- A screenshot with a circle around the part, plus one of these words, is the clearest of all.
