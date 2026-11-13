# Nav

> **R6:** a single tier. The TOS nav only, with Developers in place of Docs, and no app
> bar. See foundations.md § Nav (R6). Everything below is R4/R5 history.

## (History) Two-tier nav

**Status:** candidate (R5, 2026-10-18). R4's thin global bar was inverted in R5: the TOS nav is the top tier and the app bar sits below. The app bar tone (Blue or Tint) is pending.

> R5 supersedes the R4 anatomy below. See foundations.md § Nav (R5) for current measures. R4 text is kept as history.
**Narrative job:** orientation. Tells the visitor which company and which site they're on,
lets them reach any product, and gives them one action.

## Use it when
Always, on every Silicon site: the main site and every app's landing page.

## Don't use it when
Inside signed-in app shells. Those get the app launcher pattern (to come).

## Anatomy
1. **Global bar**: 40 tall, identical everywhere.
   - Left: the "Team of Silicons" lockup (→ teamofsilicons.com).
   - Then: **Products ▾** · Docs · Writings.
   - Right: **Sign in** (proposal: through Accounts). Signed in, it becomes the avatar plus c:id.
   - Text is Hanken 14, the lockup Geist Medium 15. Padding 32 on the sides.
2. **Local bar**: 64 tall, one per site.
   - Site zone (280, fixed): the site name in Geist Medium 20.
   - The site's own links, centred: Hanken 16, gap 24.
   - Action zone (280, fixed, right-aligned): one primary button in Size=Small.
3. **Products menu**: opens under the global bar, shared by every site.
   - A featured tile for the service (Book a briefing).
   - Six groups in a 3 × 2 grid, each item a name plus a one-line description from `products.ts`.

## Variants (R4 treatments, pending Anil's pick)
- **Quiet stack**: global bar on surface-muted, local bar on paper.
- **Dark strip**: global bar on dark-block, local bar on paper.
- **One surface**: both on paper, split by a hairline. Optional app hue dot (proposal:
  it puts the hue in the nav).

## Instances
- Accounts: For Silicons · Developers · Docs | Create account
- Main site: How it works · Pricing · Customers | Book a briefing. The site name repeats
  the lockup here, which is an open question.

## Do / don't
- Do keep the global bar identical across sites. It's the company's constant.
- Do keep one CTA, on the local bar only.
- Don't put Pricing or CTAs on the global bar.

## Where it lives
- Figma `ooAWMTw6mF4QHxciuY3Le3`:
  - Global bar set `10:95` (Quiet `10:65`, Dark `10:75`, One surface `10:85`)
  - Local bar `10:96`
  - Products menu frame `11:198`
- Code: none yet.
- First used on: Accounts, R4.
