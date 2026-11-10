# Silicon UI: no introduction banner (the first few things to do, for a new person)

Draft for review. Nothing is filed yet.

## Component request (Silicon UI's *Component request* form)

**Component:** new, `intro-banner` (`IntroBanner`)

**What's missing?**
A banner an app shows a new person on its home: a title, the three to five things to do first, the next one's
action, and a way to dismiss it. Every TOS app needs one, and each would otherwise draw its own, so the ecosystem's
first impression would differ from app to app. Nothing in Silicon UI covers it:

- `Alert` is a message, with no steps;
- `Stepper` shows steps but no actions, and is for a flow you're inside;
- `Card` has a title and content, but its `action` sits in its footer, so a dismiss button can't go in its header.

**Where it's needed:** the account site's Home, for a new Carbon (today `components/account/home-cards.tsx`), and the
home of every TOS app. A working prototype is in the account site's kitchen: `/__banner`, its code in
`components/kitchen/banner/intro-banner.tsx`.

**Identified by template, not by picture.** A template is how the banner is laid out; any picture goes with any
template:

| Template | Layout | Use when |
|---|---|---|
| `checklist` | Steps as rows on the surface; the picture fades in from the end side | Quiet: the page has other things to read |
| `cards` | A picture band with the title; a card per step overlaps its lower edge, each with one line | Each step needs a sentence of why |
| `panel` | The picture fills the banner; a frosted panel holds the title and the rows | The app's first visit, with some character |
| `spotlight` | Only the next step, large, on the picture, with dots for progress | One thing at a time; the boldest |

**Suggested API:**

```tsx
<IntroBanner
  template="checklist"            // "checklist" | "cards" | "panel" | "spotlight"
  title="Welcome, Anil"
  description="Three things to make it yours"
  steps={[
    { id: "photo", icon: <Camera />, title: "Add your photo", description: "Apps and Silicons show it beside your name.", action: "Add photo", done: true },
    { id: "silicon", icon: <Sparkle />, title: "Create your first Silicon", description: "…", action: "Create a Silicon" },
    { id: "app", icon: <LayoutGrid />, title: "Try an app", description: "…", action: "Browse apps" },
  ]}
  art={{ src: "/banner/meadow.webp", tone: "light", focus: "right bottom" }}   // optional
  doneTitle="You're set up."
  onDismiss={() => …}
/>
```

A step's action would take `href` (a link, through `SiliconProvider`'s link) or `onSelect`; the prototype only draws
the button.

**Behaviour to include (kept simple on purpose):**

- One action at a time: only the next step has a button, primary. Done steps tick and are struck through in their own
  colour; later steps wait, with no button.
- Done steps come from the app's own data, not from clicks in the banner.
- When every step is done: one line (`doneTitle`) until dismissed.
- Dismiss: a ghost icon button in the top end corner, always; the app remembers it for the person, not the browser.
- 3 to 5 steps (Shopify's guidance: more than five and people drop off).
- The picture is optional and decorative (`aria-hidden`). It sits on its own layer under the content, so squircle
  fallbacks that paint the surface's `::before` keep it. `tone` ("light" | "dark") sets the scrim and the words'
  colour where words sit on the picture (`cards`' band, `spotlight`); the banner's buttons keep their own tokens.
- Under ~640 px: `checklist`'s picture moves under the rows; `cards` stack; the next row's button goes under its
  title; `spotlight`'s scrim runs from the bottom.
- Lines between rows are straight: rows are never rounded, so a divider never bends with a corner.

**Pictures:** the prototype uses six from the Super Visuals backgrounds library (BG 126, 127, 110, 102, 139, 024),
cropped and compressed to about 10–250 KB each. Whether Silicon UI ships a set of pictures, or each app brings its own,
is a question for the request; the licence of the library needs confirming first.
