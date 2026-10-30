# Silicon Accounts  Redesign Design Review

## Purpose & the job tree

Root purpose: give every Carbon and Silicon exactly one identity, let them prove it anywhere, and keep them in control of where that identity is used and trusted. Everything else is one of four jobs:

1. **Authenticate (J1)** — prove it's you, right now, to get into something (Silicon Accounts itself or a third-party app).
2. **Stay provable / trustworthy (J2)** — keep enough verified ways in that you're never locked out, and keep evidence nothing happened without you.
3. **Govern delegation outward (J3)** — control what's allowed to act as you or see you (apps, proofs), *and*, separately, what you're accountable for (Silicons) — two different relationships wearing one label today.
4. **Maintain the profile record (J4)** — the actual content of who you are.

Most of today's usability questions resolve by asking which job an element serves, and whether its screen serves only that job.

## Screen inventory against the job tree

| Screen | Job(s) it serves | Fit verdict |
| --- | --- | --- |
| Identity (`/`) | J4, plus acts as the cross-job dashboard | Clean core, but overloaded — glance panel pulls in J2/J3 status too |
| Sign-in methods | J2 | Clean — correctly treated as keys, not contact info |
| Apps | J3 (outward, coarse) | Clean |
| Proofs | J3 (outward, fine-grained) | Questionable as a standalone concept — every proof is subordinate to an app relationship that already lives on Apps |
| Silicons | J3 (accountability) | Split — bundles a decision inbox, ongoing management, and creation in one screen |
| Activity | J2 (evidence trail) | Clean as a log, but undecided whether it needs a persistent top-level slot vs. a link from Identity |
| Settings → Appearance | None of the four jobs | Doesn't belong at this visual weight |
| Settings → Privacy | J2 (meta-trust) | Keep, but minor |
| Settings → Sessions | J2 | Underweighted — one of the strongest J2 items, buried |
| Settings → Delete account | J4 (destruction) | Correctly last, correctly gated |
| Sign-in / Authorize / Device / Embed | J1 | Clean — each is a distinct trust-recognition moment |

## Element-level critique

Each item below names the current element, the job it actually serves (not the job it looks like it serves), and the verdict.

**Identity card — front face**

- uuid shown at equal visual weight as display name/id — serves J1/J3 infrastructure (apps and support reference it), almost never what you came to glance at. **Demote** to the back face or a "copy for support" affordance.
- Timezone + live clock, shown prominently — serves neither J4 nor J1/J3; its only real consumer is formatting *Activity* timestamps correctly (J2-adjacent utility). **Demote off the front**; it's infrastructure, not identity.
- Stamps row (apps you've signed into) — also appears as a count in the Glance panel and in full on the Apps page. **Keep all three**: each is a different job (ambient recognition, navigation trigger, actual governance), not three copies of the same fact.

**Identity card — back face**

- Emails/phones shown read-only + "Add or remove →" link to Sign-in methods — a legitimate preview of J2 data on the J4 object, with editing living in exactly one place. **Keep as-is.**
- Timezone repeated here, identical value, no edit control (the editor lives on the front) — this is the one true duplicate: same field, same resolution, no new purpose. **Cut the back-face repeat.**
- Date of birth — for a Silicon, the code states it's literally "the day its account was created," a human concept wedged onto a shared schema column. **Relabel per account kind** ("Created" for Silicons) so the UI doesn't paper over a modeling choice with a confusing label.

**Apps vs. Proofs**

- Two sibling nav items serving the same job (J3-outward) at different grain, but a proof only ever exists because of an app relationship that already lives on Apps. **Candidate to fold Proofs into an app's detail view** rather than keep it as a concept a user has to learn independently.

**Silicons**

- Three different purposes share one URL: approving/declining a custodian request (urgent, external-initiated, J3-decision), managing an existing Silicon (ongoing J3-governance), and creating a new Silicon (J4-creation). **Split**: requests belong in a shared decision-inbox pattern (see note below), the page itself shrinks to management + create.

**The custodian-request pattern**

- Custodian requests already surface in two places (Identity's Glance panel and the Silicons page) with no shared "inbox" concept behind them. The product's own docs mention a second, unrelated "needs your decision" flow (manual account verification). **Flag now**: generalize into one inbox pattern before a third instance makes the inconsistency permanent.

**Settings**

- Appearance (theme) — serves none of the four jobs; it's a preference for this site's chrome, not the account. **Demote** from a full Section to a small header-level control.
- Privacy (telemetry) — a narrow but legitimate meta-trust disclosure. **Keep**, lower visual weight.
- Sessions ("where you are signed in") — one of the strongest J2 items in the app, currently the third item in a generic Settings scroll. **Promote** to parity with Apps / Sign-in methods.
- Delete account — correctly last, correctly gated by the custodian constraint. **No change.**

## Proposed information architecture

&#91;embedded content: proposed IA · 4 pillars + 1 foundation band\]

Four pillars replace six flat nav items: Identity trimmed to recognition fields, Security merges sign-in methods + sessions + activity, Access keeps Apps with Proofs folded in as detail, and Custodianship keeps only ongoing Silicon management once requests move to a shared decision inbox.

## Navigation: top bar vs. bottom dock

Today the top bar isn't actually a second navigation — it's brand (home link) + the ⌘K search trigger, no destination links. The real wayfinding system is the bottom dock, which already reshapes itself responsively (a floating pill-dock from 640px up, a compact bar + bottom sheet on phones).

The real seam: the dock's `SECTIONS` list holds 8 entries — Identity, Sign-in, Apps, Silicons, Proofs, Activity, *and* Developer, Docs. The first six are "manage my account" and never leave the site; the last two are full navigations to a different product (the developer portal). Same visual weight, same number-key shortcuts, but a different kind of destination.

**The rule:** decide by job, not by screen position. "Where can I go within my account" is one wayfinding system (the dock). "Tools that apply no matter where I am" — search, account/sign-out, theme, and *leaving the product* — are utilities, which is what the top bar is already partly for.

| Bar | Owns |
| --- | --- |
| Top | Brand, global search, Developer/Docs (exit links), account menu |
| Bottom dock | The closed set of account destinations only — nothing in it leaves the site |

**Concrete fix:** move Developer and Docs out of `SECTIONS`'s dock list into the top bar, marked as leaving (the ↗ arrow treatment already exists in the dock code, it's just in the wrong bar). This mirrors how Google's own global top bar (search, app-switcher, avatar) stays identical across every property while each product's internal nav is the only place its own destinations live. Settings already gets this treatment (excluded from `SECTIONS`, reached via the dock's trailing cluster) — this just applies the same instinct consistently.

## Reference apps

myaccount.google.com is the primary interaction-design reference; the rest cover specific pieces.

| App | Borrow this | Why it applies here |
| --- | --- | --- |
| myaccount.google.com (primary) | Glance-first home, one wayfinding system that reshapes per breakpoint, a unified Security tab | Matches the proposed Identity trim and the Security pillar merge (sign-in methods + sessions + activity) |
| Clerk | Brandable hosted sign-in, one-click-to-deep config | Matches Silicon Accounts' own stated thesis: "as simple as Supabase, as deep as WorkOS or Okta" |
| WorkOS | Enterprise config depth without the dashboard collapsing | Reference for scaling the developer portal as App config grows |
| Stytch | Passwordless, OTP-first flow UX | Matches email/phone + code as the primary sign-in method |
| GitHub → Settings → Applications | Per-app access list with individual revoke | Direct analog to the Apps screen |
| GitHub CLI device flow | Code-matching approval screen | Direct analog to the `/device` screen |

## Open questions

- [ ] Does Activity deserve a persistent top-level nav slot, or just a "see full history" link from Identity?
- [ ] Should Proofs fully fold into Apps' detail view, or stay a thin separate list linked from there?
- [ ] Where does the generalized custodian-request / account-verification-request "inbox" pattern live — a new top-level Inbox, or still per-feature banners?
- [ ] Does a Silicon's "date of birth" get relabeled/split from a Carbon's at the schema level, or only in UI copy?
- [ ] Settings demotion — does theme move to a lightweight header control, or stay a settings row, just lower-weighted?
