---
title: How imports work
description: Understand how Accounts matches imported users, creates new accounts and handles conflicting or incomplete rows.
kind: informative
order: 18
related:
  - start/import-users.md
  - learn/accounts.md
  - learn/ids-and-uuids.md
  - learn/what-apps-see.md
  - reference/limits.md
---

# How imports work

An import connects your app’s existing users to Silicon Accounts. If a Carbon already has an account, the import links to it. Otherwise, it prepares an account for that Carbon to finish setting up when they sign in.

The import must keep each Carbon in control of their own details. This page explains how matching works, why some fields are left out and what happens when rows conflict. Follow [Import existing users](../start/import-users.md) when you are ready to run an import.

Three rows show most of it. This dry run went to an app whose user base already had Kofi
(`kofi@example.com`, a finished account) and Ravi (imported earlier with `+14155550163`, not
finished yet), and where Priya (`priya@example.com`) has her own account:

```sh
curl -s -u "$APP_ID:$APP_SECRET" -H 'Content-Type: application/json' -d '{
  "rows": [
    {"email": "nadia@example.com", "phone": "+14155550190", "display_name": "Nadia Haddad"},
    {"email": "priya@example.com", "phone": "+14155550191"},
    {"email": "kofi@example.com", "phone": "+14155550163"}
  ],
  "options": {"dry_run": true}
}' "$ACCOUNTS_URL/v1/apps/$APP_ID/imports"
```

`accounts app import rows <job-id>` then shows:

```text
ROW  OUTCOME  ACCOUNT  MESSAGES
1    created  c:nadia  info identifiers_not_attached: The new account carries only nadia@example.com: the Carbon proves it when they finish setting up the account, so only its owner can claim it. +14155550190 stays in this app's imported data until the Carbon adds and verifies it themselves.
2    matched
3    error             error ambiguous_match: Row 3 can't be imported as one account: its identifiers belong to 2 different accounts (the phone number +14155550163 → account 1; the email kofi@example.com → account 2). Split it into one row per person, or remove the identifier that belongs to someone else.
```

- Row 1 creates an account that carries one address, not two.
- Row 2 links Priya's existing account; her account doesn't get the phone, and the dry run
  doesn't say who she is.
- Row 3 is refused rather than guessed: its addresses belong to two different Carbons.

The rest of this page is why.

## One Carbon, one account

Every Carbon has exactly one account, and every email address and phone number on an account
belongs to that account alone: any of them signs in to it ([Accounts](accounts.md)). So an
import row can only ever mean one of two things: an account that already exists, or a new
one. There is no third option such as "a second account for the same email".

That is why the outcomes are what they are:

- **No account has the row's addresses → `created`.** A new Carbon account, status
  `unclaimed`, waiting for its owner.
- **Exactly one account has them → `matched`.** That account joins your user base.
- **Two or more accounts have them → `error ambiguous_match`.** The row describes two
  Carbons. Picking one would link your record to the wrong Carbon, or hand one Carbon's
  address to the other, so the row is refused and you decide. The message groups the row's
  addresses by account ("account 1", "account 2") without naming the accounts: your import
  must not tell you who owns an address.

Only addresses that identify someone are used to match: an address an account has verified,
or an address of an import nobody has finished yet. The second case is Ravi in row 3: another
import (yours or another app's) already created an unfinished account for `+14155550163`, so
that number already means that Carbon. If two apps import the same Carbon before they sign
in, both rows point to the same unfinished account, and the Carbon ends up with one account
and two memberships.

## The order of decisions

Each row goes through the same steps, in file order:

1. **Clean.** Trim every value; lowercase and validate emails; turn phone numbers into E.164
   (using `default_country` for local numbers); collapse whitespace in names; read the
   username as a Carbon handle; read the date of birth, timezone and photo URL. Invalid
   optional values are dropped with a warning and the row goes on; a row left without any
   email or phone is an error.
2. **Duplicates in the file.** If any of the row's addresses appeared in an earlier row, the
   row is skipped (`duplicate_in_file`, naming the earlier row). The first row wins.
3. **Who has these addresses.** None, one or several accounts, as above.
4. **For a match:** a second row matching the same account through another address is
   skipped; an account that removed your app's access is skipped; an `external_id` already
   used by another of your members, or by an earlier row for someone else, is an error.
5. **For a new account:** pick its id.
6. **Write** (not in a dry run): accounts, their one address, their id history, and the
   memberships, 500 rows per transaction.

File order makes every decision deterministic: the dry run and the real import reach the
same answers, "row 5 repeats row 1" always points backwards, and a job resumed after a crash
decides the remaining rows exactly as the first attempt would have.

## Why a new account carries one address

A new account gets exactly one address from its row: the first valid email, or the first
valid phone when the row has no email. It is stored unverified, and it is the address the
Carbon proves to finish the account. Every other address of the row stays in your imported
data (your user base shows the row's first email and first phone, and its search `q` finds
any of them), and the row gets `info identifiers_not_attached`.

The reason is what finishing an account means. Whoever proves an address of an unfinished
account becomes its owner, and from then on every address on that account signs in to it. If
a row could put several addresses on one new account, an app could bundle a stranger's email
with an address the app controls, claim the account with its own address, and every later
sign-in of that stranger would land in the app's account (or the reverse: the stranger
claims an account carrying the app's address). With one address per new account, the only
Carbon who can claim it is the one who can prove that address.

What it costs: a Carbon who later signs in with one of the other addresses hasn't proven the
one on the account, so they start a separate account (or, if your app has
`allow_signup: false`, they are refused). Put the address your users actually sign in with
first. They can add their other addresses to their account themselves, each verified with a
code.

For the same reason, a matched account never receives the row's addresses: Priya's account
in row 2 doesn't get `+14155550191`. Adding an address to an account is something only its
owner can do, after proving it.

## Your import never changes an account's own data

An account belongs to its Carbon, not to any app. What your app knows about a Carbon is
stored on their membership with your app (`{app_id}:{uuid}`), as your "imported profile":
the cleaned row, with every email and phone you sent. For members who haven't signed in to
your app yet, your user base shows the email, phone, date of birth and timezone from your
imported profile; the name, id and photo are always the account's own.

- For a **new** account, the row's values are also its starting values (display name, id,
  date of birth, timezone, photo), and the Carbon checks them when they finish the account
  and can change any of them.
- For a **matched** account, nothing on the account changes: not its name, id, photo, date of
  birth, timezone or addresses. Priya stays Priya Raman even though your CRM calls her "Priya
  from the CRM".
- A second import of the same Carbon keeps what you stored the first time. Only
  `update_existing` replaces your imported profile and `external_id` (outcome `updated`), and
  it still never touches the account.

Once a member signs in to your app, what you see is what they chose to share
([What apps see](what-apps-see.md)), no longer your imported values.

## External ids

`external_id` is your own id for the Carbon: the link from your records to their account. It
is unique within your app, so two members can never share one (`external_id_conflict`).

On a later import, a member keeps the `external_id` you gave them first. If the row carries a
different one, the old one is kept and the row gets `warning external_id_differs`: a typo or a
reordered export must not quietly re-point your links to other Carbons. Send
`update_existing=true` when you really mean to replace them. An empty `external_id` is filled
in by the next import that has one.

Your `external_id` stays on the membership even after the account is deleted, so when your
webhook receives `account.deleted` you can still find your record.

## Removed access stays removed

When a Carbon removes your app's access to their account, that is their decision, and an
import (your decision) never undoes it: the row is skipped with `access_removed`. They come
back to your user base by signing in to your app again.

## Ids

A `username` is a wish. Ids are unique across all accounts and some are reserved, so an
import assigns the closest free id and tells you what happened:

- taken by another account, reserved for 10 days after someone changed away from it, or
  taken by an earlier row → `id_conflict` ("Wanted c:priya, assigned c:priya-2: c:priya is
  already taken by another account.");
- a reserved word (`admin`, `support`, `root`, `api`, …) → `reserved_username`;
- not a valid handle (3–30 of `a-z 0-9 - _`), or a Silicon id → `invalid_username`.

If a valid requested username is taken, Accounts tries numbered alternatives. For `c:priya`, it tries `c:priya-2` through `c:priya-20`, then a random four-digit suffix.

When it needs to build an ID from the imported details, it tries the cleaned-up username first (`John Smith!` becomes `c:john-smith`), then the email’s local part (`admin.user@…` becomes `c:admin-user`), then the display name (`Ravi Kumar` becomes `c:ravi-kumar`). Numbered and random suffixes help it find an available ID.

The new account holds that ID even before setup is finished. The Carbon can keep it or choose another during setup. They can also change it later, with the old ID reserved for them for 10 days.

Ids change; uuids don't. Store the `account_uuid` each row reports, and treat the `c:id` as a
display name ([uuids and ids](ids-and-uuids.md)).

## "Verified" is something a Carbon does

`email_verified` in your file is kept in your imported data and nothing more. An address
becomes verified only when its owner proves it: a 6-digit code, or Google or Apple vouching
for it. Your app vouching for it is not proof that the Carbon holding the account today is
the one in your export.

When a Carbon finishes an imported account, the address they proved becomes verified and
every other unverified address on the account is removed. An address nobody has proven never
signs anyone in.

## Dry runs

A dry run goes through every step above, ids included, and stops before writing. Two
differences protect Carbons:

- **Matched rows don't name the account** (`account_uuid` and `id` are `null`), and no row of
  a dry run carries an `account_uuid`. A dry run writes nothing a Carbon could ever see in
  their history, so it must not work as a way to find out which addresses have accounts.
- **Dry runs count toward the budgets** (requests per hour, rows per day) for the same
  reason: otherwise they would be a free, unlimited lookup service.

## Nothing is sent

An import never sends an email or SMS. You decide when and how to tell your users, and an
import from a stale or wrong export can't spam anyone. Codes are only ever sent when a Carbon
asks to sign in.

## Only the columns we give

An app's user base has fixed columns, the same for every app. A column outside the list
makes the whole file fail with `unknown_columns`, because silently dropping data you thought
you were importing is worse than a clear refusal. With `ignore_unknown_columns=true` the file
goes through, but only the names of the ignored columns are kept (at most 5 per row, plus a
count), never their values: an import can't park data in Silicon Accounts that Silicon
Accounts doesn't keep.

## The life of an imported Carbon

| | account status | membership with your app |
|---|---|---|
| Created by your import | `unclaimed` | `imported` (source `import`) |
| Matched by your import | unchanged (usually `active`) | `imported`, or stays `active` if they were already a member |
| Finishes their account (in any app, or on the account site) | `active` | unchanged until they sign in to your app |
| Signs in to your app | `active` | `active`, with the details they agreed to share |
| Removes your app's access | `active` | `access_removed` (imports skip them) |
| Deletes their account | `deleted` | kept as history: `status: "deleted"`, "Deleted account", no details; your `external_id` stays |

An account nobody finishes stays `unclaimed`, keeps its id, and keeps matching later imports
of the same address. `GET /v1/apps/{app_id}` counts them in `stats.imported_unclaimed`.

Imported members are live members of your app: your webhook hears about them like about
anyone who signed in, limited to what your app may see. For example, when an imported Carbon
finishes their account through another app and picks a new id and name, your app receives
`account.id_changed` and `account.updated` even though they haven't signed in to your app.

## Jobs

An import request only reads and checks the file; a background worker processes the rows.

- **One job at a time per app**, in the order they were submitted, so two files never race
  for the same Carbons.
- **500 rows per transaction.** A crash loses at most the chunk in progress; the job resumes
  after the last committed chunk with the same decisions. If someone signs up with an address
  (or takes an id) between the check and the write, that chunk is redone row by row with fresh
  checks instead of failing.
- **A job that keeps stopping its worker fails** (after two resumes) instead of retrying
  forever: one bad file must not stall every other request on a server. The job's `error`
  says which rows were done; submitting the file again is safe because rows already imported
  match their accounts.
- **Idempotency keys** (kept 24 hours) make a retried upload return the original job instead
  of starting a second one. Use one key per file.

## Budgets

| budget | value | why |
|---|---|---|
| Requests per app | 60 per hour | Every request is read and parsed, even a refused one. A few big files are cheap; thousands of tiny ones are not. |
| Rows per app | 2,000,000 per 24 hours | A dry run tells you which addresses have accounts; the budget keeps imports from being an address lookup service. A refused import costs nothing. |
| Bodies parsed at once | 2 per server, up to 50 MB each | Parsing runs off the threads that serve sign-ins, and memory stays bounded; the third waits up to 30 seconds, then gets `503 imports_busy`. |
| Per file | 100,000 rows, 50 MB, 200 columns, 8 KB per value, 50 items per list | Far above any real export (12 columns, at most 10 emails and 10 phones per Carbon), small enough to parse in bounded time and memory. |

Messages are bounded too (5 per kind of invalid address per row, values cut to 80
characters, at most 2,000 characters each), so one malformed cell can't turn a report into
megabytes.

## Related

- [Import existing users](../start/import-users.md): the steps, every outcome and message code.
- [Accounts](accounts.md): emails, phones, primaries and what "verified" means.
- [uuids and ids](ids-and-uuids.md): why you store the uuid.
- [What apps see](what-apps-see.md): what your app sees once a member signs in.
