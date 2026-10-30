# Landing page audit

Built 2026-10-18 (Carbons first). The public landing page at `/` (`components/landing/landing-page.tsx`, header and footer in `components/site/`), audited
against the design review's job tree on 2026-10-18. Open questions at the end need Anil.

## Purpose tree used

Root: give every Carbon and Silicon exactly one identity, let them prove it anywhere, and keep them in control of where
that identity is used and trusted.

- **J1 Authenticate**: prove it's you to get into something. Here this also covers getting the identity in the first
  place (sign up), which the tree does not name on its own (see open question 1).
- **J2 Stay provable**: never locked out, evidence nothing happened without you.
- **J3 Govern delegation**: what acts as you or sees you (apps, proofs), and what you answer for (Silicons).
- **J4 Maintain the profile record**: who you are.

## 1. Screen spec

- **Job:** J1, for two visitors who are not signed in: a Carbon deciding whether to make an account, and a Silicon
  that needs to make one from a terminal. The page also has a third visitor, the returning Carbon, who only wants to
  sign in (J1, reflex). The other jobs (J3's control, J4's id) appear only as reasons to sign up.
- **Primary action:** Create your account (Carbon).
- **Secondary action:** Silicon: run the three commands. Returning Carbon: Sign in.
- **Information priority:**
  1. What this is and who it's for (one account for people and their agents).
  2. The way in for your kind of visitor (the button, or the commands).
  3. Why it's safer than what you do today (no passwords; you see and stop what apps and Silicons do).
- **User mode:** Carbon, **deciding**. Silicon, **matching** (find the command, copy, run). Returning Carbon,
  **reflex**.

## 2. Element audit

| # | Element | Job | Belongs here? | Verdict |
|---|---|---|---|---|
| 1 | Wordmark (home) | J1, orientation | Yes: says where you are | Keep |
| 2 | Docs ↗ in the header | Building apps (developer site, not one of J1 to J4) | No: Silicons get their guide inside their section, and app builders are the developer site's visitors | Demote to the footer |
| 3 | Sign in (header) | J1, returning Carbon | Yes: the only action a returning visitor wants | Keep |
| 4 | Kicker "Silicon Accounts" | Orientation | No: repeats the wordmark ten lines above | Cut |
| 5 | Title "One account for every Carbon and Silicon." | J1, priority 1 | Yes | Keep |
| 6 | Lede (one account, carried into every app; Silicons without a browser, Carbons without a password) | J1, priority 1 and 3 | First sentence no: repeats the title. Second yes: it's the difference | Keep, trimmed to the second sentence |
| 7 | Create your account | J1, primary action | Yes | Keep, most weight |
| 8 | "A Silicon? Start in your terminal" ↓ | J1, Silicon's way in | Yes: the fork between the two visitors | Keep |
| 9 | For Silicons: heading | J1 (Silicon) | Yes | Keep |
| 10 | For Silicons: the problem paragraph (borrowed logins, API keys, driving a browser) | J1, deciding | Yes, but long: the Silicon is matching, not deciding | Demote to one sentence |
| 11 | Step 1: install, with a 4-line command and the Windows link | J1 (Silicon) | Yes | Keep. The command's length is a model problem (section 4) |
| 12 | Step 2: check id, create, name your Carbon, STK printed once, `custodian accept`, `--wait` | J1 (Silicon), and J3 (custody) | Yes. "STK printed once" is the most important sentence on the page for a Silicon | Keep. Put "save your STK" first and give it weight; `custodian accept` is the Carbon's command, so move it to note 14 |
| 13 | Step 3: sign into an app (SLT, single use, two minutes, app never sees the STK) | J1 (Silicon) | Yes | Keep, shorter |
| 14 | Note: your Carbon can create the account for you; Silicon account guide | J1 fallback, J3 custody | Yes: it's the other way in | Keep |
| 15 | For Carbons: heading and intro | J1, deciding | Yes | Keep. Move it up (section 5) |
| 16 | No passwords | J1 | Yes: the main reason to switch | Keep |
| 17 | You choose what apps see | J3 (outward) | Yes | Keep, merged with 19 |
| 18 | Safest way to let an agent use apps (custody, rotate STK, hand it over) | J3 (accountability) | Yes: the reason a Carbon is here at all | Keep |
| 19 | Apps that act for you, in plain sight | J3 (outward) | Yes, but it's the same job as 17 | Merge with 17 |
| 20 | Your id is yours (change c:id, old one waits 10 days) | J4 | No: a detail of managing an account, not a reason to make one | Cut here. It belongs on the identity screen |
| 21 | Without a browser (llms.txt, /v1, openapi.json, OIDC discovery, agent card, errors, `--help`) | J1 for Silicons and their builders | Yes for Silicons, no for Carbons. Its heading names what's missing, not what you get | Move into the Silicon section as its last line ("Reading this as code? …") |
| 22 | Closing "Building an app? Add Silicon Accounts to your app" | Building apps | No: the developer site's job | Cut. The footer already has it |
| 23 | Footer: copyright, Add to your app, llms.txt, API, Silicon Apps, Status, GitHub | Navigation for everyone | Yes, at footer weight | Keep. Docs (2) joins it |

## 3. Repetition test

| Fact | Where | Same job? | Verdict |
|---|---|---|---|
| "Silicon Accounts" | Wordmark, kicker, title | Wordmark and kicker both say where you are | Cut the kicker |
| One personal account for everyone | Title, lede's first sentence | Same | Cut the lede's sentence |
| Add Silicon Accounts to your app | Header Docs, closing line, footer | Same (send app builders away) | Keep the footer only |
| llms.txt, API spec | "Without a browser" section, footer | Different: the section explains them to a Silicon, the footer is quick navigation | Keep both |
| `--help` explains itself | Step 3, "Without a browser" | Same | Keep it once, in the Silicon section |
| Sign in without a browser / without a password | Lede, both sections | Different: the lede promises it, the sections show how | Keep |
| You can see and stop what apps do | Points 17 and 19 | Same job (J3, outward) | Merge |

## 4. Model-leak check

| Label | Problem | Fix in |
|---|---|---|
| Carbon / Silicon in the title | A first-time human doesn't know a Carbon is a person and a Silicon is an AI agent. The page never says so | Design: say it once in the lede (open question 2, because of the vocabulary rule) |
| STK | Never expanded. A Silicon may guess "token", but it's the password | Design: "your STK (your password)" the first time |
| SLT | An internal abbreviation for the short-lived token | Design: "a one-time sign-in token" first, SLT in the code only |
| si:id, c:id | Shown with no example | Design: give one (`si:head_of_growth`) |
| custodian | The product's word, but the page uses "your Carbon" and "custodian" for the same thing | Design: "your Carbon (your custodian)" once, then "your Carbon" |
| `--self-create` in the create command | The two ways a Silicon account is made leak into a flag the Silicon has to type | Model (CLI): self-create should be the default when a Silicon runs the command |
| 4-line install through Silicon Apps (`install-apps.sh`, PATH export, `silicon-apps install`) | Silicon Apps distributing the CLI leaks into step 1: you install another product to get this one | Model (distribution): a single install line for silicon-accounts |
| "Without a browser" heading | Names a missing thing, not what the section gives | Design: fold it into the Silicon section (element 21) |

## 5. Placement

- The primary action is the Carbon's, yet the Carbon's reasons sit third, below about 1,000 px of Silicon commands. A
  Carbon who is deciding meets terminal code before any reason. **Carbon benefits go right after the hero.** The
  Silicon jumps past them with the secondary link, so its path costs nothing.
  *Undecided:* the code comment says the page's first job is to convince the Silicon. If Silicons are the main visitors,
  their section stays first and the Carbon's three reasons go into the hero instead. What would settle it: the share of
  `/` visits from agents against browsers, and whether agents read `/` or go straight to `/llms.txt`.
- Carbon, deciding: one focused block of 3 short reasons, then the same Create button repeated at its end (the second
  copy does a different job: it's for someone who has now decided).
- Silicon, matching: the code is the centre of the block. Each step is a title, one sentence, then the command. Prose
  goes below the command or into the guide.
- At 1440 px the column sits left with half the window empty. Centre it on `--page-narrow`, or give the code blocks the
  wide side. That is part of the paused layout work, so it's noted here, not changed.

## 6. Redesign proposal

Top to bottom:

1. **Header:** wordmark left, Sign in right. Nothing else.
2. **Hero:** title; one-sentence lede that says what Carbons and Silicons are and the difference (no password, no
   browser); **Create your account** (primary) and **I'm a Silicon** ↓ (quiet).
3. **For Carbons:** three reasons: no passwords (J1); you see and stop everything that acts as you or sees you, apps
   and proofs (J3 outward); look after your Silicons, which never hold your password (J3 accountability). Create your
   account again at the end.
4. **For Silicons:** one sentence on why; three steps, each a title, one sentence and the command (1 install; 2 create
   with your Carbon named, "save your STK, it's shown once" with the most weight in the block; 3 sign into an app
   with a one-time token). Then: "Your Carbon can make the account for you instead", the guide link, and "Reading
   this as code?" with llms.txt, /v1, OIDC discovery and the agent card.
5. **Footer:** as now, plus Docs.

Cut: the kicker (repeats the wordmark), the lede's first sentence (repeats the title), "Your id is yours" (J4, not a
reason to sign up), the closing developer line (the footer has it), the second `--help` mention.
Moved: Docs to the footer; "Without a browser" into the Silicon section; `custodian accept` into the Carbon note.
Merged: "You choose what apps see" with "Apps that act for you".
Demoted: the Silicon problem paragraph, to one sentence.

## Open questions for Anil

1. **Primary visitor:** Carbon or Silicon first? It decides the section order (section 5). Settled by visit data or
   your call.
2. **Glossing the vocabulary:** may the lede say "people (Carbons) and AI agents (Silicons)" once? The site's rule is
   Carbons and Silicons only, but a first-time human can't decode the title without it.
3. **Sign-up as a job:** should the tree name "get an identity" as its own job (J0), or stay under J1? It changes
   nothing on this page but helps the sign-up and authorize screens.
4. **Model fixes:** make `--self-create` the CLI default for Silicons, and a one-line installer for silicon-accounts?
   Both are outside the account site.

## Structure and layout (built 2026-10-18)

The usual landing beats, mapped onto Silicon Accounts. There is no social proof until real data exists (Anil).

| # | Section | Layout (≥ 1024 px; one column below) |
|---|---|---|
| 1 | Header | Sticky 64 px: wordmark, Sign in |
| 2 | Hero | Fills the first screen less 64 px (max 760), so the next band peeks in. Text in cols 1–6 (title `--text-5xl`, lede 44ch, Create your account + I'm a Silicon); a sample Carbon identity card in cols 7–12 (max 520), which tilts and flips |
| 3 | The problem | Muted full-bleed band, 80 px padding: title in cols 1–4, Carbons and Silicons statements in cols 5–12 |
| 4 | For Carbons | Title row; 3 Silicon UI Cards (lucide icon media); a 3-step "how signing in goes" row on a hairline |
| 5 | What an app sees | The real consent screen (still from `auth-default-review`) in a muted frame, cols 1–7; text in cols 9–12 |
| 6 | For Silicons | Muted band: a sticky intro column (cols 1–4: title, Carbon fallback, machine links); the steps with code and the STK alert in cols 6–12 |
| 7 | Safe by design | Title in cols 1–4; 6 facts in a 3×2 hairline grid in cols 5–12 |
| 8 | Questions | Title and docs link in cols 1–4; Silicon UI Accordion (lg) in cols 5–12 |
| 9 | Closing | A centred muted block: title `--text-4xl`, one line, both ways in |
| 10 | Footer | Unchanged |

Frame: container `--page-max` + `--gutter`, 12 columns with a 24 px gap; sections 120 px apart (64 on phones); every
section opens with a small muted label over a Geist title. Tablet (720–1023): two-column cards, facts and steps row;
the hero stacks.
