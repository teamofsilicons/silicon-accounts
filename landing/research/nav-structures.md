# Research: nav structures (R4, 2026-10-18)

Used for structure only. We don't copy any company's look.

## Our offering

Sources: `teamofsilicons/www-tos/src/lib/products.ts`, `src/components/nav.tsx`,
`tos-updated-understanding.md`, `landing page.md`, `silicon-accounts/understanding/UNDERSTANDING.md`.

- **The service.** A team of silicons: AI employees that start as apprentices, learn from
  a company's best people and take on recurring work.
  - Buyers are CEOs, founders, COOs and functional leaders.
  - It starts with a Briefing call (30 min in `landing page.md`, 25 on the sales page:
    an open discrepancy).
- **About 25 apps on `*.teamofsilicons.com`.** The main nav's existing groups:
  - Foundations: IAM, Honeycomb
  - Build and run Silicons: Stemcell, Silicon CLI, Omni, Starter
  - Communicate: DM, Ring, Peek, Ting
  - Work: Commit, Remind, Briefcase
  - Reach the world: MCPort, Extend, Hook, Waveform
  - Observe: Space Station
- **The main site nav today:** Products ▾ · Starter · Docs · Writings · GitHub · Sign in ·
  Create account. Sign in and Create account both go to `iam.`.
- **Gaps:**
  - Accounts, Apps and Developers aren't in the nav.
  - Sign in goes to IAM, not Accounts.
  - Honeycomb and Apps both claim app discovery.
  - MCPort has no description.
  - Glass and Interface aren't listed.

## How similar companies structure it (15 checked live)

| Pattern | Who | Fits when |
|---|---|---|
| Umbrella nav + grouped Products menu | Stripe, Vercel, Cloudflare, Clerk, WorkOS, Supabase (top tier) | One platform, many modules, one buyer |
| Two tiers: global bar + local product strip | Microsoft, Supabase, Cloudflare developers | Products share an account and get cross-sold |
| Product-first nav + small parent mark | Atlassian product pages, Google Workspace, Vercel → v0, Anthropic's two domains, 37signals | Products have their own brand and buyer |
| App launcher / account switcher (signed in) | Google, Atlassian, Anthropic's "Log in" dropdown, Linear's "Open app" | One account across many apps |

Details worth reusing:
- Products menus are grouped by capability (Vercel: Agent Stack / Core Platform / Tools)
  or by audience (Atlassian's tabs; Google's For all / business / developers; Notion's
  "Notion for").
- Off-site products are marked ↗ in the parent menu (Vercel).
- A featured tile sits inside the menu (Atlassian "Powered by Rovo", the www-tos "All products" card).
- Pricing and the primary CTA live on the product or local tier. The global tier keeps
  only sign-in.
- A sign-in dropdown routes visitors to the right app (Anthropic: Claude.ai or Console).

Sources: atlassian.com, about.google/products, workspace.google.com, microsoft.com,
vercel.com, v0.app, supabase.com, cloudflare.com, developers.cloudflare.com, stripe.com,
anthropic.com, claude.com, 37signals.com, hey.com, basecamp.com, linear.app, notion.com,
clerk.com, workos.com, raycast.com.
