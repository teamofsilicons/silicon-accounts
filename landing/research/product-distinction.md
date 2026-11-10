# Research: telling product pages apart under one brand (R7, 2026-10-18)

The question is how multi-product companies make each product hero recognisable while
keeping one brand, ideally without giving each product its own colour. **[F]** means a
fetched page and **[M]** means memory, unverified. WebFetch reads text and alt text, not
rendered visuals, so many visual claims are [M].

## Six patterns

**1. Product mark system on a shared grid**
- Used by: Adobe, Microsoft, Google, Atlassian, Figma, Notion.
- Each product gets a glyph or mnemonic built from one shape, stroke and type kit.
  - Adobe: two-letter mnemonics on one rounded square in one custom font; 38 of the 676
    possible pairs are in use **[F]** (adobe.design/ideas/behind-the-design-adobe-s-updated-app-icons).
- It scales to 25+ products and works from favicon to hero.
- The warning: Google's Workspace icons shared one 4-colour rule, and users confused Drive
  with Home and Chat with Meet. The 2026 redesign moved to more distinct shapes and colours
  **[F, secondary]** (chromeunboxed.com). **If colour is fixed, the silhouette has to carry
  the difference.**

**2. The product is the hero**
- Used by: Stripe Connect (customer UI collage **[F]**), Claude Code (session mockup **[F]**),
  Google Drive (logo above a UI shot **[F]**), Vercel, Linear **[M]**.
- A real UI moment showing the app's core object.
- The strongest option that doesn't depend on colour. It's costly to keep current.

**3. Signature object or metaphor**
- Used by: Apple photography **[F]**, FigJam's cursors and stickies **[F]**, Raycast's glass and
  3D objects **[F]**, Stripe Billing's wave **[F]**.
- One memorable object per product, in one house material and lighting.
- It needs art direction for each product.

**4. Name as the hero lockup**
- Used by: Supabase ("Supabase Database" **[F]**), Cloudflare ("WAF" **[F]**), Figma Slides
  **[F]**, Apple.
- Cheap and clear, but on its own it barely tells pages apart. It needs pattern 1 or 2
  alongside it.

**5. Monochrome pictogram or diagram language**
- Used by: IBM (pictograms on a 32×32 grid, each "unique and not redundant", meant to sit
  beside product screenshots **[F]**), Cloudflare and Vercel diagrams **[M]**.
- On-brand and systematic, but it drifts toward clip-art if the pictograms aren't distinct.

**6. Colour per product (the counter-pattern)**
- Used by: Adobe, Microsoft, Google 2026.
- These brands trade colour constancy for recognition.
- That's evidence too: when colour is held constant, companies lean on shape, imagery and
  product UI.

## How R7 maps onto these

- R7·B (pixel glyph) is pattern 1. Its silhouettes were weak and small, which is Google's
  failure case.
- R7·C (signature motif) sits between patterns 3 and 5.
- R7·A (generative fingerprint) has no real precedent among these companies.
- Anil's illustration slot is pattern 2 or 3.

Anil rejected all three on 2026-10-18 ("none").

## Sources
supabase.com/database, /auth · stripe.com/billing, /connect · claude.com/product/claude-code
· workspace.google.com/products/drive · apple.com/airpods · figma.com/slides, /figjam ·
raycast.com · adobe.design/ideas/behind-the-design-adobe-s-updated-app-icons ·
blog.adobe.com/en/publish/2020/05/28/evolving-our-brand-identity-uk ·
ibm.com/design/language/iconography/pictograms/contribute ·
atlassian.com/blog/company-news/our-journey-to-a-reimagined-visual-system ·
designweek.co.uk/microsoft-redesigns-icons · chromeunboxed.com (Workspace icons)
