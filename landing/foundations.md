# Foundations

What a landing page is built from. The base is Silicon UI and is not restated here. This
file records only how landing pages *use* that base, plus any extension Anil has signed
off on (each extension links to its decision).

## Base (from Silicon UI, unchanged)

| Area | Source |
| --- | --- |
| Display face | **GT Alpina Light** for headings (R10; Geist is not used on landing pages) |
| Text face | Hanken Grotesk (`--font-body`) |
| Mono | `--font-mono` |
| Colour | Silicon UI neutral scale; `--background`, `--surface*`, `--text-*`, `--border*`, `--accent*` |
| Spacing | `--space-1` … `--space-24` |
| Radius | Silicon UI radius scale (`--radius-panel`, `--radius-surface`, `--radius-pill`, …) |
| Icons | lucide. Brand marks are hand-drawn |

Light and dark both come from the same tokens. A landing page doesn't hardcode either one.

## Landing extensions

Values get written here only once they've been chosen on a real page. Each one names the
round it came from. Empty sections haven't been decided yet.

### Nav (R6; replaces R5)
- **The TOS nav only**, 56 tall. The measures are as in www-tos (`styles.css` `.site-nav*`):
  - container max 1400, 60 inline padding (80 from the edge at 1440)
  - background #FFFDF9
  - TOS logo 24 tall, gap 40, pill links (32 tall, 0 14 padding, Hanken 14, #181818)
  - actions gap 8: GitHub ghost, then Button Small Secondary "Sign in" and Primary "Create account" (R8)
- Links (proposal): Products ▾ · Starter · **Developers** · Writings. Developers replaces Docs.
  Figma `18:274`. The shipping version without the change is `15:196`.
- No app bar. The product name is a hero eyebrow: Hanken SemiBold 16, uppercase, brand blue, 16 above the heading.

### Grid (R3, 1440)
- 96 margin · 576 column · 96 gutter · 576 column · 96 margin.
- Left column = writing. Right column = illustration.
- _1024 and 390 to come in a later round._

### Hero (R3)
- 700 tall. Base layer bleeds the full width under the content.
- Writing column: 128 top inset, 40 between heading, lede, actions and proof line.
- The illustration's top aligns with the heading's top (y = 128). The illustration slot is 576 × 444.

### Type scale (display)
- Hero and section headings: **GT Alpina Light 36/44, −3%** (R10). Hero heading set by Anil.
- Everything else: **Hanken Grotesk**. Eyebrow: SemiBold 16, uppercase, −2%, brand blue.
  Step title: Medium 20/130%. Step number: Medium 14. Body: Regular 16/24.
- No Geist anywhere on a landing page (R10).
- Lede: Hanken 16 / 24, text-secondary, at most 520 wide.
- Proof line: Hanken 14, text-muted.
- Don't make the hero type monumental. R2's 72–192px headings were rejected.

### Buttons (R8; after vibrant.design "Explore Moodboards", in brand blue)
- Radius 10. Size=Small is 32 tall: padding 6/14, Hanken Medium 14/20, 6 gap for an icon.
  Size=Default is 40 tall: padding 9/18, 16/22.
- **Primary (brand blue):**
  - Fill: vertical #3070C4 → #1F5CB1, plus a white gloss (12% at the top, gone by halfway).
  - Border: a **1px outside stroke, #17468C**. This is the crisp ring; the source uses
    `box-shadow: 0 0 0 1px`.
  - Inner rims: a lit top edge (inner shadow 0 1 0, #A9C6F5 at 55%) and a darker bottom
    edge (inner 0 −1 0, #184A92 at 50%). These stand in for the source's gradient border.
  - Also an inner bottom shade (0 −3 6 −3, #08206E at 18%), and drops of 0 1 1 (#10369F
    at 12%) and 0 2 4 (#10369F at 16%).
  - Text white.
- **Secondary:** white → #F7F7F8; a 1px outside stroke in ink at 9%; an inner bottom rim
  (0 −1 0) at 6%; drops of 0 1 1 at 3% and 0 2 4 at 4%; ink text.
- Source values were read from the live page's computed styles (`::before` layers) on
  2026-10-18. Theirs: #3F80FF → #2867F2, ring #1A4BC2. Ours keeps the same steps, shifted to
  brand blue.
- **States** (from the source's CSS, `.t-surface*`):
  - **Hover**: the primary lightens 6% toward white (#3C79C8 → #2C66B6). The secondary
    darkens 4% toward black (#F5F5F5 → #EDEDEE). Border, rims and shadows don't change.
  - **Pressed**: the hover colours, plus the button surface scales to **0.99**. In code
    that's `scale` on the `::before` surface, so the label and the layout don't move.
    Figma can't show a 0.99 scale without reflowing, so the Pressed variant shows the
    hover colours and the scale is code-only.
  - **Motion**: 150ms, `cubic-bezier(.215,.61,.355,1)` (ease-out cubic), on the surface
    colours and scale. With `prefers-reduced-motion`, there's no scale.
  - **Focus**: a 3px ring at 50% (the source uses its `ring` colour). Not designed yet.
  - Inverse has no hover change yet.
  - Figma: State=Default / Hover / Pressed on Button set `2:6`. The prototype goes Default
    →(while hovering) Hover →(while pressing) Pressed, as a 150ms smart animate.
- The TOS nav uses these buttons too (Small): Sign in is Secondary, Create account is Primary, 8 apart (R8).

### Product snippets use Silicon UI, not the website (R10)
- Anything that shows the product (sign-in screens, consent lists, app lists, CLI) is
  built from **Silicon UI** (`silicon-ui-package/registry`), the library the apps
  themselves use. It is not built from the landing page's own buttons.
  - Button: radius 6 (squircle); heights 24 / 36 / 44; Primary is ink (`--primary` =
    foreground), Secondary is white with `--border`, Danger is white with `--danger` text;
    no shadow at rest.
  - Checkbox: 18px, radius 2, `--border-strong`; checked is `--control-on` ink.
  - Avatar: round, 1px `--border`, `--surface-muted`.
  - Card: radius 8, 1px `--border`, white, `--shadow-showcase` when shown as a product shot.
- Figma: "Silicon UI · Button" `87:247`, "Silicon UI · Checkbox" `87:252`,
  "Silicon UI · Avatar" `87:253`.
- The landing page's chrome (hero CTA, nav) keeps the website buttons (brand blue,
  after vibrant.design). The two button sets never mix inside one snippet.

### Craft: effects need room (R8)
- Any frame that holds something with an outside stroke, shadow or effect (every button)
  has **clip content off** and **2px padding** on all sides. That gives the 1px outside
  ring and the soft drops room. Clipping cuts them off.
- To keep alignment, take the 2px back from the parent's padding, e.g. the nav's 12/80
  becomes 10/78 around its actions.
- From Anil's fix to the hero CTA row (`Actions`: clip off, padding 2).

### Section rhythm
_Vertical spacing between sections and inside them; how density changes down the page._

### Colour use (R7)
- Brand blue #1F5CB1 is the only hue. It appears in the backdrop, the product-name eyebrow
  and the primary button (R8). Everything else is Silicon UI neutral (grey text, paper,
  white secondary buttons).
- No per-app colour.
- **Solid blocks (R11):** brand blue #1F5CB1 · ink #141414 · light tint #E6EEF9, for
  tiles and bands. Use them so not every surface is the Columns texture.
  - On blue: white title, white body at 84%.
  - On ink: #FCFCFC title, body at 72%.
  - On tint: ink title, #3D4A5C body.
  - White Silicon UI snippets sit on all three.

### Imagery
- **Base layer:** brand blue, Grain light style (R7) — the "Silicon backdrop" Figma fill shader (id `e3bc63b2-2b00-4ce9-b910-53fba8103087`,
  team anil's projects). Its controls:
  - Style: Soft field / Pixel grid / Grain light
  - App hue, paper colour, intensity
  - Clear zone: X, Y, radius and softness, which keeps the writing column on paper
  - Field scale, pixel size, grain, seed
  The same shader serves every app; only the hue and parameters change.
  - **Columns** style (R9, after the Lattice hero background): vertical columns
    (Pixel/column size ≈ 84) of short stacked cells (0.28 × the column width, ≈ 24). Colour
    builds up away from the clear zone; each column has its own energy; the colour drifts
    slowly down each column, with a small per-cell jitter. It's quantised into 18 bands
    over a tint ramp: paper → 28% tint → brand blue → 72% deep blue. Trial settings:
    intensity 1.1, clear zone 18/62, radius 60, softness 70, scale 340, seed 9. The
    top-left accent uses the same style at intensity 0.75.
- **Top-left accent (R8):** a second, minimal grain layer in the hero's top-left corner.
  It marks where the nav ends and the hero begins, which otherwise blend. It's the same
  shader, in brand blue:
  - intensity 1, scale 220, seed 12, clear zone pushed off-canvas
  - masked by a radial fade centred on the hero's top-left corner (1000 × 400: alpha 1 →
    0.5 at 40% → 0)
  - it sits between the base layer and the content, and stays clear of the eyebrow and heading
  Figma: group "Top-left accent (minimal)" in the hero.
- **Illustration:** one artifact per app, supplied by Anil, placed in the right column.
- _The code port of the shader (canvas or CSS) comes at build time._

### Motion
_What moves, why, how long it takes, and the reduced-motion behaviour._
