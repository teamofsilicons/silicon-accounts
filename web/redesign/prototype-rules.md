# The prototype is the design

[prototype-v7.html](prototype-v7.html) (the lead designer's Silicon Accounts Prototype v7, 2026-10-28) decides what the
account site shows and how its elements look: content, copy, element design, spacing, states. Silicon UI decides how
things are built. Where the two disagree, the difference gets a category below, and the category decides the fix.
Nothing is added that the prototype does not show; a gap is a question for Anil, not a reason to invent.

Open the prototype in a browser; its **States** button (bottom right) switches sample situations (a busy account, a new
account, …). States change the data shown, not the design. Compare a page against the state that matches the data on
screen.

## Categories and fixes

Steps 1 to 5 follow Silicon UI's own ladder (`docs/new-components.md` in teamofsilicons/silicon-ui); stop at the first
that fits.

| # | Category | How to tell | Fix | Who |
|---|---|---|---|---|
| 1 | **Exists** | Silicon UI has it under another name | Use it. If it then looks different, go on to 3 or 4 | Claude |
| 2 | **Composition** | Existing parts arranged a certain way: a card with a header, a row, an icon tile, a ring | Build it in the site exactly as the prototype draws it, from Silicon UI parts and tokens. No library change | Claude |
| 3 | **Token** | Only the look differs: colour, radius, shadow, size, font size | If the token exists, set it in `styles/tokens.css`. If not, request the token (a small library change) | Claude; a new token is a request |
| 4 | **Variant** | Same component and job, different look, size or one extra part, and no token covers it | Component request (variant). Until it ships, Silicon UI as it is, and the difference stays open | Request → Anil approves |
| 5 | **Missing** | A different job or structure Silicon UI has nothing for | Component request (new). Stop that element until it ships; do not build a workaround | Request → Anil approves |
| 6 | **Brand decision** | The prototype's look conflicts with a decision Anil made (no beige, ink accent, Silicon UI fonts, flat shell, tiles) | The decision stands until Anil changes it; listed so he can | Anil |
| 7 | **Behaviour** | How it works differs (keyboard, focus, what a click does), not how it looks | Silicon UI's behaviour stays (it carries the accessibility work) unless Anil decides otherwise | Anil |
| 8 | **Data** | It needs something the API does not have | Leave it out; list it in [api-gaps.md](api-gaps.md) | API developers |

## Component requests

Silicon UI takes requests as GitHub issues in `teamofsilicons/silicon-ui`, on its *Component request* form (name, kind,
the need, why steps 1–3 do not fit, other uses, behaviour, references). Labels track them: requested → approved →
in-design → experimental → stable, or declined (with the step that answers it). Anil approves plans. Claude can draft
and file them with `gh`, but files each one only after Anil says yes to it.

## Differences

Every difference between the site and the prototype is in [prototype-differences.md](prototype-differences.md) with its
category, fix and status. At the end of every task, the differences it leaves or finds are listed to Anil, not only
written down.
