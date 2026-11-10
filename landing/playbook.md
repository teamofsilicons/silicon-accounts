# Playbook: given this content, use this design

The framework in plain words. For each section of a landing page, it covers:

- what you'll have in hand (the content)
- the shape of that content
- the design you use for it
- how it's built and how it behaves
- how to check it

The playbook is written from what we've actually decided on Accounts. Each entry links
back to its decision, so it never says more than we've agreed.

**How to use it:** start from the content, never from a layout.
1. Name the section's **job** (`narrative.md`).
2. Look at the **shape** of the content you have for it. How many items? Is there an order?
   Is there a real product screen behind each item?
3. Find the entry whose "Given" matches that shape, and build what it says.
4. If no entry matches, it's a new pattern candidate. Explore it in a round, then add it here.

---

## The page, as a whole

**Given** a Silicon app with one primary audience and an understanding doc.

**Use**
- Layout: one two-column page.
  - 96 side margins, two 576 columns, 96 gutter (at 1440).
  - The TOS nav on top, unchanged from www-tos except two R6/R8 changes: Developers
    replaces Docs, and it uses our buttons.
  - Sections in the "control first" order: hero → how it works → what you get → second
    audience → developer handoff → close.
- Type and colour:
  - Two faces: **GT Alpina Light** for headings and **Hanken Grotesk** for everything else.
  - One hue: **brand blue #1F5CB1**, only on the backdrop, the eyebrow and the primary button.
- Snippets of the product use **Silicon UI**, never the website's buttons.

**Because:**
- Anil wants every app to read as one company (R6, R7).
- Colour belongs to the brand, not the app (R7).
- The product is the proof (R1).

---

## Hero

**Given**
- the app's name
- one sentence of what it is, from the understanding doc
- the one primary action
- one illustration made for this app (Anil supplies it)

**Use a layered split hero.**
- **Base layer:** the "Silicon backdrop" shader in brand blue (Accounts: the Columns style;
  Grain is kept too). Colour builds up toward the right, and the writing column stays on
  paper (the clear zone). There's a very faint accent in the top-left so the nav and the
  hero don't blend.
- **Content layer.**
  - Left column, 128 from the top, 40 between blocks:
    - eyebrow: the app's name as text, never an invented logo (Hanken SemiBold 16,
      uppercase, brand blue)
    - heading (GT Alpina Light 36/44)
    - lede (Hanken 16/24, up to 520 wide)
    - primary and secondary buttons (Small, brand blue and white)
  - Right column: the illustration, its top aligned with the eyebrow.

**Not:** big type carrying the page, a flat background, or a per-app colour (R2, R7).

**Copy rules**
- The heading is the app's promise in the doc's own words.
- The lede adds the one or two facts that make the promise true.
- Say exactly what the user controls. Don't say "you choose" when the app chooses (R10 copy audit).

**Accounts, filled in**
- **Eyebrow:** Silicon Accounts
- **Heading:** One account for every app you sign into. You see what each one gets.
- **Lede:** Silicon Accounts is the personal account you carry into every app that signs in
  with it. The first time an app asks for your details, you see exactly what it wants.
  You can remove its access whenever you want.
- **Buttons:** Create your account · Sign in
- **Illustration:** Anil's ID card

**Check:**
- two layers
- text on paper at 4.5:1 or better
- nothing clipped
- heading in GT Alpina
- every claim in `copy.md` has a source

---

## How it works

**Given**
- **two to four moments that happen in order**
- each one sentence long and sourced
- each with a **real product screen** that shows it

The moments together tell the visitor what they get to do.

**Use a step list beside one sticky stage.**
- **Left column (576):**
  - section header: eyebrow, heading, lede
  - numbered step list below it (number in Hanken Medium 14, title in Hanken Medium 20)
  - only the active step shows its sentence and sits on a soft grey pill; the number
    turns brand blue
- **Right column (576 × 560):**
  - a stage on the brand blue Columns backdrop (radius 20)
  - one Silicon UI snippet at a time, centred: the active step's screen
- **Section:** paper, 120 padding top and bottom, 64 between the header and the content.

**Behaviour**
- In code, the stage sticks while the visitor scrolls, and each step takes over the stage
  as its scroll range arrives (about 240ms, ease-standard; a crossfade under reduced
  motion). Clicking a step jumps to it.
- On mobile there's no sticky: each step stacks with its own snippet.
- In Figma it's a component with one version per step, wired to change on click.

**Not**
- Three equal cards (R10·A): every step looks equally important, and the screens get small.
- One long band (R10·C): it reads as a diagram, not a product.
- Use the equal-cards layout instead when the moments **aren't** in order.

**Copy rules**
- The heading names the outcome in the user's words.
- Each step is one sourced sentence.
- Name the step for what the user does ("Sign in"), not for a feeling.
- If the app decides something (which sign-in methods, which details are required), say so.

**Snippet rules**
- Each snippet is a believable moment of the real product, built from Silicon UI
  components: ink primary button, radius 6, ink checkboxes, round avatars, card radius 8
  with the showcase shadow.
- Sample names (Briefcase, DM, `c:you`) are illustrative, never claims of real usage.

**Accounts, filled in**
- **Eyebrow:** How it works
- **Heading:** See what every app gets, and take it back.
- **Lede:** Sign in with what the app offers, check what it's asking for, and remove its
  access whenever you want.
- **Steps:**

| # | Step | Sentence | Snippet |
|---|---|---|---|
| 01 | Sign in | With a code sent to your email or phone, or with Google or Apple. The app decides which of these it offers. | Sign-in methods: four Silicon UI secondary buttons |
| 02 | See what's shared | The first time you sign into an app, and whenever it asks for more, you see exactly what it will get. Optional details stay unticked until you tick them. | Consent card: required details ticked, optional unticked, "Continue as c:you" |
| 03 | Take it back | Every app you've signed into is listed in your account. Remove an app's access whenever you want. | Your apps: three rows, each with a danger "Remove access" |

**Check:**
- the steps really are in order
- each snippet is Silicon UI
- the heading is GT Alpina
- only one step is open at a time
- `copy.md` audit done

---

## What you get

**Given:** **two to four facts with no order between them**, each one sourced, each with a
real screen that proves it. Together they're the substance behind the hero's promise.

**Use a bento of solid tiles.**
- **Header:** the same as every section (eyebrow, heading, lede), left aligned.
- **Grid** (gap 32):
  - Row 1: one wide tile (768) for the biggest fact, and a narrow tile (fills the rest).
  - Row 2: one full-width tile, laid out horizontally (text left, snippet right).
- **Each tile:**
  - radius 20, padding 32
  - fact title (Hanken Medium 20) and one sourced sentence (16/24)
  - the white Silicon UI snippet below the text, or beside it on the full-width row
- **Surfaces are solid, never the Columns texture.** Use one of each: brand blue
  #1F5CB1, ink #141414 and light tint #E6EEF9. Put the strongest colour on the biggest fact.

**Not:**
- Equal cards (R11·B): fine, but flat. All three facts look the same.
- Zigzag rows (R11·C): too long for three short facts.
- A textured backdrop on the tiles: it repeats the hero and the stages, and Anil called
  that "boring uniformity".

**Copy rules**
- The fact title is the fact itself ("Up to 10 emails and phone numbers"), not a slogan.
  When the spec is ambiguous, pick the wording that's true under every reading.
- One sentence of proof each.
- Don't repeat anything another section already covers: app access is section 2, and
  Silicons are section 4.

**Accounts, filled in**

| Tile | Surface | Title | Sentence | Snippet |
|---|---|---|---|---|
| Wide | Brand blue | Up to 10 emails and phone numbers | Any of them signs you in. Each one is verified before it's added, and one is your primary. | Ways to sign in (Primary badges, Add email / Add phone) |
| Narrow | Ink | An ID you can change | Your c:id is the name people see and type. Change it, and your old one stays reserved for you for 10 days. | Your ID (c:id input, Available, Change ID) |
| Full row | Light tint | See who acts for you | When an app acts for you at another app, it shows up in your account, and you can revoke it. | Acting for you (Revoke) |

**Check:**
- facts really are unordered
- three different surfaces
- text contrast on blue and ink is 4.5:1 or better
- snippets are Silicon UI
- no fact repeats another section
- any limit in a headline is worded so it's true under every reading of the spec

---

## Not written yet

These get an entry once we've designed them on Accounts:

- The second audience (Silicons)
- Developer handoff
- Closing and footer

Until then, the "Given" line for each is the job in `narrative.md`.
