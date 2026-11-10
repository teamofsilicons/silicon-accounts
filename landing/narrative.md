# Narrative

The jobs a landing page does, in the order a visitor needs them done, and the rules for
the words.

## Story arc

Agreed on Accounts (Anil, 2026-10-19, "Control first"). Each section does one job:

1. **Hero.** What this is, who it's for, the one action.
2. **How it works for you.** The control story in three moments. For Accounts: sign in
   your way → see what an app asks for → take it back.
3. **What you get.** The substance behind the promise. For Accounts: one account, many
   ways in (emails, phones, c:id), one place to manage.
4. **The second audience.** For Accounts, that's Silicons: their own account, a custodian,
   sign-in from the CLI.
5. **Developer handoff.** One short block that sends developers to developers.teamofsilicons.com.
6. **Closing.** The primary action again, then the footer.

(framework?) The shape is promise → how it works → substance → other audiences →
handoff → close. Check it against a second app before calling it general.

## Copy rules

These hold from day one, because they're about truth, not taste.

- **Every claim traces to a source.** That means the app's understanding doc, something
  Anil said, or something a visitor can check in the product. The brief lists the
  sources. A claim without a source is cut.
- **No invented proof.** No made-up customers, numbers, quotes or benchmarks. If proof
  doesn't exist yet, the page goes without it.
- **Problem → fix, directly.** We don't add a middle beat that claims "there's no way to do
  this today".
- **The product's own words.** Use the glossary terms (Carbon, Silicon, custodian, …)
  the way the understanding doc defines them. Gloss a term once, where it first appears,
  and only if the visitor needs it.

- **Problem, then solution: two beats, never three.** If the copy opens on a problem, it
  must be a plain, sourced fact. Then say what the product does. Never add a middle beat
  that claims the gap ("there's no way to…", "nobody…"), not even welded on as a clause.
  The specificity of the solution shows what was missing. _(R10, grounded-copywriting)_
- **Watch the tells** where invented claims hide:
  - numbers nobody gave you
  - intent attributed to others
  - absence claims
  - invented backstory
  - technical, legal or security claims that "sound probably true"
  - assumed implementation details ("no setup", "instantly")
  Cut them, swap in the sourced fact, or flag them for Anil. _(R10)_
- **Don't overstate control.** Say exactly what the user decides and what the app decides.
  On Accounts, "you choose what each app gets" was wrong: required details aren't a
  choice, and the app picks the sign-in methods. _(R10)_
- **Every page keeps a copy file** (`apps/<app>/copy.md`). It audits each sentence against
  its source, with a verdict and a reason, then gives the rewrite and the open flags.
  _(R10)_

- **Ambiguous source → the wording that's true under every reading.** For example "up to
  10 emails or 10 phone numbers" became "Up to 10 emails and phone numbers". Flag the
  ambiguity so the spec gets fixed. _(R11)_

More rules get added here as rounds produce them, each linked to its decision.
