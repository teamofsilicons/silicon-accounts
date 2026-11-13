# Silicon Accounts — copy (grounded)

Written with the grounded-copywriting method Anil shared on 2026-10-19:
- every claim traces to a source
- problem → solution has no "there's no way to do this today" middle beat
- technical claims get flagged rather than asserted

Sources are `understanding/UNDERSTANDING.md` (§ section, line) and Anil's answers in
`brief.md`.

## Audit of the current copy

| # | Where | Current | Verdict | Why |
|---|---|---|---|---|
| 1 | Hero heading | "One account for every app you sign into." | ✅ keep | § intro: "a single personal account that they carry into every app they sign into" |
| 2 | Hero heading | "You choose what each one gets." | ⚠️ overstated | § What's shared (L138–139): **required** details must be given to sign in. You only choose the *optional* ones. |
| 3 | Hero lede | "Silicon Accounts is the personal account you carry into every app that signs in with it." | ✅ keep | § intro |
| 4 | Hero lede | "Each app shows you what it's asking for first" | ⚠️ inaccurate | L136: *we* show the screen, not the app, and only "the first time … and again whenever the app asks for more". Not before every sign-in. |
| 5 | Hero lede | "and you can take its access back whenever you want." | ✅ keep | L262: "remove an app's access" |
| 6 | §2 heading | "You decide what every app gets." | ⚠️ overstated | Same as #2 |
| 7 | §2 lede | "Sign in your way, …" | ⚠️ overstated | L111: "Each app decides which of these it wants". The app picks the methods, not you. |
| 8 | §2 step 1 title | "Sign in your way" | ⚠️ overstated | Same as #7. It also contradicts its own body copy ("Whichever the app offers"). |
| 9 | §2 step 1 body | "A code to your email or phone, or Google or Apple. Whichever the app offers." | ✅ keep | § Signing in › Carbons; L111 |
| 10 | §2 step 2 body | "Before an app gets anything, you see what it's asking for." | ⚠️ loose | L136: true the first time and whenever the app asks for more. "Anything" also covers the uuid and tokens the app gets regardless (§ Tokens), and we don't show those. |
| 11 | §2 step 2 body | "Optional details stay unticked until you tick them." | ✅ keep | § What's shared: "It's unticked until they do." |
| 12 | §2 step 3 | "Every app you've signed into is listed in your account. Remove its access whenever you want." | ✅ keep | L262 |

No problem → solution beats yet: the copy is benefit-led, so the middle-beat rule isn't
triggered.

There's also **no sourced problem statement** in the brief. We could write one ("you
make a new account for every app"), but it isn't in UNDERSTANDING.md or Anil's answers, so
it can't go in yet. → **Needs Anil:** if a problem-first opener is wanted, what is the
real, sourced pain?

## Rewrite

### Hero
- **Eyebrow:** Silicon Accounts
- **Heading:** One account for every app you sign into. You see what each one gets.
  _(#1 kept; #2 fixed. "See" is fully sourced. Alternative: "…and you pick the optional
  details each one gets." It's more precise but longer.)_
  → **Anil types this one.** The heading is GT Alpina Trial, which the MCP can't edit.
- **Lede:** Silicon Accounts is the personal account you carry into every app that signs
  in with it. The first time an app asks for your details, you see exactly what it
  wants. You can remove its access whenever you want.
  _(#3 kept; #4 fixed to L136; #5 kept.)_

### Section 2 — How it works
- **Eyebrow:** How it works
- **Heading:** See what every app gets, and take it back.
- **Lede:** Sign in with what the app offers, check what it's asking for, and remove its
  access whenever you want.
- **01 · Sign in**: With a code sent to your email or phone, or with Google or Apple. The
  app decides which of these it offers. _(L111, § Signing in)_
- **02 · See what's shared**: The first time you sign into an app, and whenever it asks
  for more, you see exactly what it will get. Optional details stay unticked until you
  tick them. _(L136–139)_
- **03 · Take it back**: Every app you've signed into is listed in your account. Remove
  an app's access whenever you want. _(L262)_

### Flags (need confirmation before shipping)
- "whenever you want" (removing access): the account site lists it (L262), but nothing
  says it's instant or that the app loses tokens straight away. The copy doesn't claim
  "instantly", and it shouldn't.
- Snippet sample data (Briefcase, DM, Commit, `c:you`) is illustrative, not a claim of
  real usage.

## Section 3 — What you get (R11)

The content is three facts with no order between them, each with a real screen. Silicons
are left out on purpose: they're section 4, and each section does one job. App access is
left out too, because section 2 already covers it.

| # | Copy | Source | Note |
|---|---|---|---|
| Eyebrow | Your account | — | |
| Heading | Every way you sign in, on one account. | § Carbon account: any email or phone signs in to the same account | |
| Lede | Keep your emails and phone numbers on one account, change the ID people see, and check every app that acts for you. | § Carbon account; § Identifiers; L248 | |
| 1 title | Up to 10 emails and phone numbers | § Carbon account: "up to 10 emails or 10 phone numbers" | Anil reads it as **10 in total** (2026-10-20, "total ig"). This wording is true under either reading. Still worth confirming with whoever owns the spec, and having the spec say "in total" outright. |
| 1 body | Any of them signs you in. Each one is verified before it's added, and one is your primary. | § Carbon account; L68 | Google and Apple emails skip the extra step (L68), so "verified" still holds |
| 2 title | An ID you can change | § Identifiers | |
| 2 body | Your c:id is the name people see and type. Change it, and your old one stays reserved for you for 10 days. | § Identifiers: "the ID people see and type… old ID stays reserved for 10 days… previous owner can reclaim" | |
| 3 title | See who acts for you | L236, L248 | |
| 3 body | When an app acts for you at another app, it shows up in your account, and you can revoke it. | L236: User verification; L248: "see every User verification proof issued on their behalf… and revoke it" | Plain words for "User verification proof" |

Snippet sample values: you@example.com, you@work.example, +91 98765 43210, c:you,
Briefcase/DM/Commit. All illustrative. The "Available" check is the c:id availability
endpoint (§ Identifiers).
