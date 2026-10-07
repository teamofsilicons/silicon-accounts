---
title: Import existing users
description: Bring every user of an existing app into Silicon Accounts from a CSV or JSON file — check it with a dry run, import it, and read what happened to every row.
kind: instructive
order: 18
related:
  - learn/imports.md
  - learn/accounts.md
  - start/sign-in-config.md
  - reference/api.md
  - reference/limits.md
---

# Import existing users

You'll upload your app's existing users as CSV or JSON, check the file with a dry run that
writes nothing, run the import, and read the outcome of every row. Each row lands in your
app's user base: it is matched to the Carbon who already has that email or phone, or it
becomes a new Carbon account that its owner finishes the first time they sign in to your app.
Nobody gets an email or SMS.

```sh
printf '%s' "$APP_SECRET" | accounts app use legacy-crm --secret-stdin

accounts app import users.csv --default-country US --dry-run --wait   # every decision, nothing written
accounts app import users.csv --default-country US --wait             # the real import
accounts app import rows <job-id> --outcome error                     # the rows to fix
```

The examples on this page import into an app called `legacy-crm`. Replace it with your own
`app_id`. This is the file they use, `users.csv`:

```csv
external_id,email,phone,display_name,username,dob,timezone
crm-101,kofi@example.com,+14155550161,Kofi Mensah,kofi,1990-12-10,Africa/Accra
crm-102,Lena.Fischer@Example.com,,Lena Fischer,lena,09/12/1986,Europe/Berlin
crm-103,,(415) 555-0163,Ravi Kumar,,1991-06-23,asia/kolkata
crm-104,not-an-email,,Nobody,,,
crm-105,KOFI@example.com,,Kofi again,,,
crm-106,priya@example.com,,Priya from the CRM,,,
crm-107,tomas@example.com,,Tomás Silva,priya,1969-12-28,Mars/Olympus
```

The dry run reports this (progress goes to stderr, the result to stdout):

```text
queued: 0/7 rows (0%)
completed: 7/7 rows (100%)
Import 01a11440-1ce8-70a3-beeb-58e994801a5e: completed (7/7 rows).
created   4
matched   1
updated   0
skipped   1
errors    1
warnings  4

First errors:
  row 4: invalid_email: 'not-an-email' is not a valid email address: it has no '@'. It was left out.; missing_identifier: The row has no valid email or phone number left (see the warnings above), so it can't be matched to an account or create one.
```

and `accounts app import rows 01a11440-1ce8-70a3-beeb-58e994801a5e` shows every row:

```text
ROW  OUTCOME  ACCOUNT       MESSAGES
1    created  c:kofi        info identifiers_not_attached: The new account carries only kofi@example.com: the Carbon proves it when they finish setting up the account, so only its owner can claim it. +14155550161 stays in this app's imported data until the Carbon adds and verifies it themselves.
2    created  c:lena        warning invalid_dob: '09/12/1986' is ambiguous: it could be day/month or month/day; use YYYY-MM-DD. It was left out; a new account gets the default date of birth (2008-10-07).
3    created  c:ravi-kumar
4    error                  warning invalid_email: 'not-an-email' is not a valid email address: it has no '@'. It was left out.; error missing_identifier: The row has no valid email or phone number left (see the warnings above), so it can't be matched to an account or create one.
5    skipped                info duplicate_in_file: Row 5 repeats the email kofi@example.com from row 1, so it was skipped; only row 1 was imported.
6    matched
7    created  c:priya-2     warning invalid_timezone: 'Mars/Olympus' is not an IANA timezone; use a tz identifier like Asia/Kolkata, America/New_York or UTC. It was left out; a new account gets UTC.; warning id_conflict: Wanted c:priya, assigned c:priya-2: c:priya is already taken by another account.
```

Reading it row by row:

| row | what happened | why |
|---:|---|---|
| 1 | new account `c:kofi` | Nobody has `kofi@example.com`. The account carries only that email; the phone stays in your imported data (see [one address per new account](../learn/imports.md#why-a-new-account-carries-one-address)). |
| 2 | new account `c:lena`, default date of birth | `09/12/1986` reads as 9 December or 12 September, so it is left out rather than guessed. The email is stored lowercased: `lena.fischer@example.com`. |
| 3 | new account `c:ravi-kumar` | The local number becomes `+14155550163` with `--default-country US`; `asia/kolkata` becomes `Asia/Kolkata`; no username, so the id comes from the display name. |
| 4 | error, nothing imported | The only identifier is not an email address. |
| 5 | skipped | Same email as row 1 (emails are compared lowercased). Only the first row with an address counts. |
| 6 | matched | Priya already has a Silicon Accounts account with `priya@example.com`. She joins your user base; her own name, id and details stay hers. |
| 7 | new account `c:priya-2` | The wanted id `c:priya` is taken, so the next free one is assigned and the row says so. An unknown timezone falls back to UTC. |

A dry run makes every one of these decisions and writes nothing. The real import makes the
same ones (an id can differ if someone takes it in between).

## Before you start

- **Credentials.** Imports are run with the app's own credentials (`app_id` and app secret,
  from Silicon Apps) or by the Carbon who owns the app, signed in. Over HTTP the credentials
  are `Authorization: Basic base64(app_id:app_secret)`, which is what `curl -u` sends. With
  the CLI, `accounts app use legacy-crm --secret-stdin` stores the secret (mode 0600); run
  `accounts app use legacy-crm` without a secret to act as the owner through your own session.
- **Where.** The CLI talks to `https://accounts.teamofsilicons.com` unless `--url` or
  `ACCOUNTS_URL` says otherwise. The curl examples assume:

  ```sh
  export ACCOUNTS_URL=https://accounts.teamofsilicons.com   # not deployed yet; a local stack: http://localhost:8590
  export APP_ID=legacy-crm
  export APP_SECRET=sa_app_…        # from Silicon Apps; never commit it
  ```

- **One dry run first.** It writes nothing and tells you exactly what the real import will do.
  It counts like an import toward your budgets (60 requests per hour, 2,000,000 rows per 24
  hours), so dry-run the whole file once rather than piece by piece.

On [developer.teamofsilicons.com](https://developer.teamofsilicons.com) the same flow is the app's
**Import** tab (`/apps/{app_id}/import`): pick the file, read the dry-run report, then import it
for real.

## 1. Prepare the file

### The columns

These are the only columns an import accepts. An app's user base has the columns Silicon
Accounts gives it, and nothing else, so there is nowhere to keep any other column.

| column | holds | rules |
|---|---|---|
| `external_id` | your own id for this Carbon | At most 255 characters, no control characters. Unique within your app. Text or a number. |
| `email` | an email address | Trimmed, lowercased, validated. |
| `emails` | more email addresses | A JSON array, or text separated by `;`. With `email`, at most 10 in total per row; the 11th onward is dropped with a warning. |
| `phone` | a phone number | Stored in E.164 (`+14155550163`). A number without `+` or `00` needs `default_country`. |
| `phones` | more phone numbers | A JSON array, or text separated by `;`. With `phone`, at most 10 per row. |
| `display_name` (or `name`) | the Carbon's name | Runs of spaces, tabs and newlines become one space; cut to 100 characters with a warning. Without it, the name comes from the email (`kofi@example.com` → "Kofi") or the phone ("Carbon 0161"). |
| `username` | the id they should get | `kofi` or `c:kofi`. When it is taken, reserved or invalid, a free id close to it is assigned and the row says what and why. |
| `dob` | date of birth | `YYYY-MM-DD`, also `YYYY/MM/DD`, and `DD/MM/YYYY` or `MM/DD/YYYY` when only one reading is possible. On or after 1900-01-01 and before today. Anything else is left out, and a new account gets the default: exactly 18 years ago. |
| `timezone` | an IANA timezone | `Asia/Kolkata`, `America/New_York`, `UTC` (any letter case). Offsets like `GMT+5:30` and Windows names are left out, and a new account gets `UTC`. |
| `pfp_url` | a profile photo | An `https` URL. Plain `http`, and photos uploaded to Silicon Accounts by an account, are left out; a new account gets the default Carbon photo. |
| `email_verified` | `true`/`false` | Kept in your imported data only. Imported addresses are never trusted as verified: the Carbon proves the address when they sign in. |

Every row needs at least one **usable email or phone number**. A row without one is an error,
because there is nothing to match it with and nothing its owner could sign in with.

**Put the address Carbons sign in with first.** A new account carries exactly one address: the
first valid email of the row (`email`, then `emails`), or, when the row has no valid email, the
first valid phone. That is the address the Carbon must use to finish the account. Your other
addresses for them stay in your imported data until they add and verify them themselves.

### Rules for every file

- Column names are case-insensitive (`Email` is `email`) and surrounding spaces are ignored.
  `name` is the same column as `display_name`; a file with both is refused, like any column
  given twice.
- Every value is trimmed. Blank cells, `null` and empty lists count as "not given".
- A file with any other column is refused as a whole with `unknown_columns`, which lists them
  and the allowed ones. Remove them, or send `ignore_unknown_columns=true` to import the rest:
  each row that had a value in an ignored column gets an `unknown_columns` warning. Only the
  names of ignored columns are kept, never their values.
- One file holds at most 100,000 rows and 50 MB. Split bigger exports (see
  [Big imports](#big-imports)).

### CSV

- UTF-8 with a header line. A UTF-8 byte order mark (Excel's "CSV UTF-8") is stripped.
- `Content-Type: text/csv` (also `application/csv`, `text/comma-separated-values`,
  `application/vnd.ms-excel`). Options go in the query string.
- Quoted cells may hold commas, quotes (`""`) and newlines; a quoted newline does not start a
  new row.
- Rows are read flexibly: cells past the header are ignored (warning `extra_fields`), missing
  trailing cells read as empty (warning `missing_fields`), and a line of only whitespace is
  skipped.

### JSON

`Content-Type: application/json` with a body of this shape:

```json
{
  "rows": [
    {"external_id": "u-100", "email": "maya@example.com", "display_name": "Maya Patel", "username": "maya", "timezone": "Asia/Kolkata"},
    {"external_id": "u-101", "phone": "(415) 555-0142", "name": "Sam Ortiz"},
    {"external_id": "u-102", "emails": ["li@example.com", "li.work@example.com"], "dob": "1988-04-02"}
  ],
  "options": {"default_country": "US", "dry_run": true}
}
```

- `rows` is required and must be an array of objects; `options` is optional. Any other key in
  the body is refused, so a misspelt option can't be silently ignored.
- Options may also be query parameters. The same option given in both places with different
  values is refused (`validation_failed`): a dry run must never turn into a real import by
  accident.
- The CLI and the developer platform's Import tab also accept a file that is just the array (`[{…}, {…}]`) and wrap
  it for you; the HTTP API needs `{"rows": […]}`.

## 2. Check it with a dry run

```sh
accounts app import users.csv --default-country US --dry-run --wait
```

or over HTTP:

```sh
curl -s -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: text/csv' \
  --data-binary @users.csv \
  "$ACCOUNTS_URL/v1/apps/$APP_ID/imports?default_country=US&dry_run=true"
```

A dry run is a normal job with `"dry_run": true`: it reads every row, matches, picks ids and
reports the same outcomes and messages the real import would, and writes no account, no
membership and nothing a Carbon could see. Two things differ in its report:

- `account_uuid` is always `null`, and matched rows don't name the account (`id` is `null`
  too). A dry run must not work as a way to look up who owns an email address.
- The ids shown for new accounts are the ones free at that moment.

Dry runs count toward the hourly request limit and the daily row budget like real imports.

## 3. Import it

```sh
curl -s -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: text/csv' \
  -H 'Idempotency-Key: crm-import-1' \
  --data-binary @users.csv \
  "$ACCOUNTS_URL/v1/apps/$APP_ID/imports?default_country=US"
```

The request only reads and checks the file; the rows are processed in the background. It
answers `202 Accepted` with the job:

```json
{
  "job": {
    "app_id": "legacy-crm",
    "counts": {"created": 0, "error": 0, "matched": 0, "skipped": 0, "updated": 0, "warnings": 0},
    "created_at": "2026-10-07T02:45:26.833Z",
    "created_by": "app",
    "dry_run": false,
    "error": null,
    "finished_at": null,
    "format": "csv",
    "id": "01a11440-64b1-73a5-ae75-ebe9dbfa28d6",
    "options": {"default_country": "US", "dry_run": false, "ignore_unknown_columns": false, "update_existing": false},
    "processed_rows": 0,
    "started_at": null,
    "status": "queued",
    "total_rows": 7
  }
}
```

Poll the job until `status` is `completed` or `failed`:

```sh
curl -s -u "$APP_ID:$APP_SECRET" "$ACCOUNTS_URL/v1/apps/$APP_ID/imports/01a11440-64b1-73a5-ae75-ebe9dbfa28d6"
```

```json
{
  "job": {
    "app_id": "legacy-crm",
    "counts": {"created": 4, "error": 1, "matched": 1, "skipped": 1, "updated": 0, "warnings": 4},
    "created_at": "2026-10-07T02:45:26.833Z",
    "created_by": "app",
    "dry_run": false,
    "error": null,
    "finished_at": "2026-10-07T02:45:26.863Z",
    "format": "csv",
    "id": "01a11440-64b1-73a5-ae75-ebe9dbfa28d6",
    "options": {"default_country": "US", "dry_run": false, "ignore_unknown_columns": false, "update_existing": false},
    "processed_rows": 7,
    "started_at": "2026-10-07T02:45:26.842Z",
    "status": "completed",
    "total_rows": 7
  }
}
```

| job field | meaning |
|---|---|
| `status` | `queued` (waiting for the worker), `running`, `completed`, or `failed` (the whole job stopped; `error` says why and which rows were done). |
| `total_rows`, `processed_rows` | Rows in the file, and rows with an outcome so far. |
| `counts` | Rows per outcome (`created`, `matched`, `updated`, `skipped`, `error`) and the number of warning messages over all rows. |
| `created_by` | `app` (the app's credentials) or the uuid of the owner who ran it. |
| `options`, `dry_run`, `format` | What the job runs with. |

`accounts app import status <job-id> --wait` follows a job from the CLI, and
`accounts app import list` (or `GET /v1/apps/{app_id}/imports`, newest first) lists them.

**Send an `Idempotency-Key` with every import.** If the connection drops before you see the
`202`, send the same request again with the same key: you get the original answer back
(header `Idempotent-Replayed: true`) instead of a second job. The replay is the answer as it
was first given (`"status": "queued"`); read the job to see where it is now. A key is
remembered for 24 hours, and reusing it for a different file or different options is refused
with `409 idempotency_key_reused`. The CLI sends a random key on every run; pass
`--idempotency-key` to retry an upload safely.

## 4. Read what happened to each row

```sh
curl -s -u "$APP_ID:$APP_SECRET" \
  "$ACCOUNTS_URL/v1/apps/$APP_ID/imports/01a11440-64b1-73a5-ae75-ebe9dbfa28d6/rows?code=id_conflict"
```

```json
{
  "items": [
    {
      "account_uuid": "gYJ",
      "id": "c:priya-2",
      "input": {
        "display_name": "Tomás Silva",
        "dob": "1969-12-28",
        "email": "tomas@example.com",
        "external_id": "crm-107",
        "phone": "",
        "timezone": "Mars/Olympus",
        "username": "priya"
      },
      "messages": [
        {
          "code": "invalid_timezone",
          "field": "timezone",
          "level": "warning",
          "message": "'Mars/Olympus' is not an IANA timezone; use a tz identifier like Asia/Kolkata, America/New_York or UTC. It was left out; a new account gets UTC."
        },
        {
          "code": "id_conflict",
          "field": "username",
          "level": "warning",
          "message": "Wanted c:priya, assigned c:priya-2: c:priya is already taken by another account."
        }
      ],
      "outcome": "created",
      "row_number": 7
    }
  ],
  "next_cursor": null
}
```

Rows come back in file order. Filter them with any of:

| query | values |
|---|---|
| `outcome` | `pending`, `created`, `matched`, `updated`, `skipped`, `error` |
| `level` | `error`, `warning`, `info` (rows with at least one message of that level) |
| `code` | a message code such as `id_conflict` or `missing_identifier` |
| `limit`, `cursor` | 50 rows per page by default, at most 200; pass `next_cursor` back as `cursor` until it is `null` |

| row field | meaning |
|---|---|
| `row_number` | 1-based data row; the CSV header doesn't count, and a quoted newline doesn't start a row. |
| `outcome` | What happened (table below). `pending` while the job hasn't reached the row. |
| `account_uuid` | The account the row is now linked to. **Store it** with your record: the uuid never changes, while the `c:id` can. The membership id is `{app_id}:{account_uuid}` (`legacy-crm:gYJ`). |
| `id` | The account's current `c:id` when the row was processed (assigned for new accounts). |
| `messages` | `{level, code, message, field?}` in the order they arose. |
| `input` | The row as you sent it (only import columns), plus `_ignored_columns`, `_ignored_count` and `_extra_cells` when the row had them. |

From the CLI: `accounts app import rows <job-id> --outcome error` (the CLI and the Rust client
filter by `outcome`; use the HTTP API for `level` and `code`).

### Fix the errors and import again

Correct the rows that failed and import the file again, whole or only those rows. Importing a
row twice is safe: a row that was already imported matches the account it created, so nothing
is duplicated. Re-importing the example file after its first import:

```text
ROW  OUTCOME  ACCOUNT       MESSAGES
1    matched  c:kofi
2    matched  c:lena        warning invalid_dob: '09/12/1986' is ambiguous: it could be day/month or month/day; use YYYY-MM-DD. It was left out; a new account gets the default date of birth (2008-10-07).
3    matched  c:ravi-kumar
4    error                  warning invalid_email: 'not-an-email' is not a valid email address: it has no '@'. It was left out.; error missing_identifier: The row has no valid email or phone number left (see the warnings above), so it can't be matched to an account or create one.
5    skipped                info duplicate_in_file: Row 5 repeats the email kofi@example.com from row 1, so it was skipped; only row 1 was imported.
6    matched  c:priya
7    matched  c:priya-2     warning invalid_timezone: 'Mars/Olympus' is not an IANA timezone; use a tz identifier like Asia/Kolkata, America/New_York or UTC. It was left out; a new account gets UTC.
```

A second import never changes what you stored the first time unless you ask for it with
`update_existing=true` (outcome `updated`): then your imported details and your `external_id`
for that account are replaced by the new row. The account's own data is never changed by an
import.

## 5. Your imported users sign in

Nothing reaches your users when you import them. When you are ready, tell them yourself and
send them to your normal sign-in (hosted pages, the iframe or the snippet; see
[Add sign-in to your app](add-sign-in.md)). Then, for a new (unfinished) account:

1. They sign in with **the address the account carries**: a 6-digit code sent to it, or Google
   or Apple when that is their Google or Apple account's email (if your app offers them).
   Proving the address is what lets them claim the account.
2. Instead of a new sign-up they see **Finish setting up your account**: "Legacy CRM added you
   to Silicon Accounts. Check the details it gave us, then continue." Every field is filled
   from your row: display name, `c:id`, timezone, date of birth and photo (your values win
   over the name Google or Apple suggests). They can change any of them, then press
   **Finish setup**. If they first sign in to another app with that address, they finish the
   same account there, and the page still names your app ("Legacy CRM added you to Silicon
   Accounts. Check the details it gave us, then continue to Briefcase."; the flow's
   `signup.imported_by`).
3. They continue, and the account is theirs: status `active`, the proven address verified, the
   **same uuid** your import reported. Your app receives that uuid in the token response, and
   their membership turns from `imported` to `active`.

What the flow returned for row 1 in the walkthrough above (`signup` in the hosted flow):

```json
{
  "display_name": "Kofi Mensah",
  "dob": "1990-12-10",
  "email": "kofi@example.com",
  "expires_at": "2026-10-09T02:45:33.952Z",
  "finishing_import": true,
  "id": "c:kofi",
  "imported_by": { "app_id": "legacy-crm", "name": "Legacy CRM" },
  "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=p1y",
  "phone": null,
  "provider": null,
  "provider_pfp_url": null,
  "timezone": "Africa/Accra"
}
```

and the account your app got back after the code exchange:

```json
{"uuid": "p1y", "membership_id": "legacy-crm:p1y", "kind": "carbon", "id": "c:kofi", "display_name": "Kofi Mensah", "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=p1y", "email": "kofi@example.com", "email_verified": true, "updated_at": "2026-10-07T02:45:33.959Z", "version": 2}
```

Things to know:

- A Carbon who signs in with **another** address (one that stayed in your imported data, like
  Kofi's phone) has not proven the imported one, so they start a separate new account. With
  `allow_signup: false` that sign-up is refused (`signup_not_allowed`). Finishing an imported
  account is always allowed, even with `allow_signup: false`.
- Imported Carbons finish in a browser, through an app's sign-in or the account site. The
  CLI's code sign-in (`accounts login --email`) only signs in accounts that are already
  active, and says so.
- If someone finishes their account through another app first, they are already active; your
  membership stays `imported` until they sign in to your app, then turns `active`.
- When they finish, every address the import attached that they didn't prove is removed from
  the account. Unproven addresses never sign anyone in.

Follow the progress in your user base:

```sh
accounts app users --status imported        # members from your import that haven't signed in to your app yet
accounts app show                           # includes: users  10 (1 active in 30 days, 7 imported and unclaimed)
```

`GET /v1/apps/{app_id}` has the same numbers in `stats`: `users` (live members),
`active_last_30d` and `imported_unclaimed` (imported accounts nobody has finished yet).

## Options

| option | CLI flag | default | effect |
|---|---|---|---|
| `default_country` | `--default-country US` | none | ISO 3166 two-letter code used for phone numbers written without a country code. Without it, such numbers are left out with `invalid_phone`. |
| `dry_run` | `--dry-run` | `false` | Decide and report every row, write nothing. |
| `update_existing` | `--update-existing` | `false` | For rows matching an account that is already a member of your app: replace your imported details and `external_id` for it (outcome `updated`). Never changes the account's own data. |
| `ignore_unknown_columns` | `--ignore-unknown-columns` | `false` | Import a file that has columns outside the list; their values are dropped and each affected row gets a warning. |

Flags take `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). Unknown options are refused
with `invalid_query` (query string) or `validation_failed` (JSON body), never ignored.

## Row outcomes

| outcome | meaning |
|---|---|
| `created` | No account has any of the row's addresses: a new Carbon account was created (status `unclaimed`), carrying the row's first email (or first phone), unverified, and joined your user base as `imported`. |
| `matched` | Exactly one account has the row's addresses. It joins your user base as `imported` (a member that is already `active` stays `active`). Your details for it are stored only if you had none; otherwise they are kept. |
| `updated` | Matched an account that was already a member, with `update_existing`: your details and `external_id` for it were replaced. |
| `skipped` | Not imported, on purpose: a duplicate of an earlier row, or an account that removed your app's access. |
| `error` | Not imported: the row can't be used as it is. The `error` message says what to fix. |
| `pending` | Only while the job runs: not reached yet. |

Only addresses that identify someone count when matching: a verified address on an account,
or the address an earlier import (yours or another app's) gave an account nobody has finished
yet. The Carbon is the same, so both imports point to the same unfinished account.

## Row messages

Every message has a stable `code`. Errors stop the row; warnings say what was dropped or
changed while the row went on; info explains a decision.

| code | level | outcome | when | what to do |
|---|---|---|---|---|
| `missing_identifier` | error | error | No usable email or phone in the row (none given, or all invalid; the warnings before it say why). | Add a valid email or phone. |
| `ambiguous_match` | error | error | The row's addresses belong to two or more different accounts, e.g. "the email a@example.com → account 1; the phone +1… → account 2". Accounts are not named. | Split it into one row per Carbon, or remove the address that belongs to someone else. |
| `external_id_conflict` | error | error | The `external_id` belongs to another member of your app, or an earlier row of this file used it for someone else. External ids are unique per app. | Fix the duplicate in your data. |
| `invalid_external_id` | error | error | The `external_id` is longer than 255 characters or contains control characters. | Shorten or clean it. |
| `import_conflict` | error | error | Rare: a concurrent change claimed the row's address or id four times in a row, or no free id was found. | Import the row again (give it a distinct `username`). |
| `duplicate_in_file` | info | skipped | An address of this row appeared in an earlier row, or the row matches the same account as an earlier row through another address. The message names the earlier row; only that one was imported. | Merge the rows if they are one Carbon. |
| `access_removed` | warning | skipped | The Carbon removed your app's access. An import never adds it back. | Nothing: they return to your user base when they sign in to your app again. |
| `id_conflict` | warning | created | The `username` is taken by another account, reserved after an id change, or taken by an earlier row: "Wanted c:priya, assigned c:priya-2: c:priya is already taken by another account." | Nothing; tell the Carbon their id, or let them change it when they finish. |
| `invalid_username` | warning | created | The `username` is not a valid handle (3–30 of `a-z 0-9 - _`), or is a Silicon id (`si:…`). Another id is assigned. | Fix it if the id matters. |
| `reserved_username` | warning | created | The `username` is a reserved word (`admin`, `support`, `root`, …). Another id is assigned. | Pick another username. |
| `identifiers_not_attached` | info | created | The new account carries only the row's first address; the others stay in your imported data. | Nothing; the Carbon can add them later. |
| `external_id_differs` | warning | matched | The account is already your member with another `external_id`; yours was kept. | Import with `update_existing=true` to replace it. |
| `invalid_email` | warning | any | An email is not valid ("it has no '@'", "'x' is not allowed in the domain", …). It was left out. At most 5 such messages per row, then one "…and N more". | Fix the address. |
| `invalid_phone` | warning | any | A phone number is not valid, or has no country code and no `default_country` (the message says which country it was read with). It was left out. | Write it as `+<country code>…`, or set `default_country`. |
| `too_many_emails`, `too_many_phones` | warning | any | More than 10 emails (or phones) in the row; the last ones were left out. An account holds at most 10 of each. | Keep the 10 that matter. |
| `invalid_dob` | warning | any | Not a date, not a real calendar date, ambiguous (`04/05/1990`), before 1900-01-01, or not in the past. Left out; a new account gets the date 18 years ago. | Use `YYYY-MM-DD`. |
| `invalid_timezone` | warning | any | Not an IANA timezone. Left out; a new account gets `UTC`. | Use a name like `Europe/Berlin`. |
| `invalid_pfp_url` | warning | any | Not an `https` URL, or a photo an account uploaded to Silicon Accounts. Left out; a new account gets the default photo. | Use an `https` URL of your own. |
| `display_name_truncated` | warning | any | Longer than 100 characters; cut to the first 100. | Shorten it. |
| `invalid_value` | warning | any | A column holds a list or an object where text is expected (or `email_verified` isn't true/false). Ignored. | Send text. |
| `unknown_columns` | warning | any | With `ignore_unknown_columns`: the row had values in columns that were dropped. | Nothing. |
| `extra_fields` | warning | any | CSV: the row has more cells than the header; the extra cells were ignored. | Check the row's quoting. |
| `missing_fields` | warning | any | CSV: the row has fewer cells than the header; the missing ones read as empty. | Check the row. |

Quoted values in messages are cut to 80 characters and no message is longer than 2,000
characters, so one bad cell can't make a report unreadable.

## Big imports

| limit | value | when you hit it |
|---|---|---|
| Rows per request | 100,000 | `422 too_many_rows`; split the file. |
| Body per request | 50 MB | `413 payload_too_large`; split the file. |
| Requests per app | 60 per hour, dry runs and refused files included | `429 rate_limited` with `Retry-After` and `details.limit` |
| Rows per app | 2,000,000 per 24 hours, dry runs included | `429 rate_limited` with `Retry-After`, `details.limit_rows`, `details.remaining_rows` and `details.import_rows` (a refused import costs nothing) |
| Bodies read at once | 2 per server | A request waits up to 30 seconds for a slot, then `503 imports_busy` with `Retry-After: 15`; retry with the same `Idempotency-Key`. |

How a big job runs:

- Rows are processed in file order, 500 per database transaction. Jobs of one app run one
  after another; a second file waits in `queued`.
- If the server restarts during a job, another worker resumes it after the last committed
  chunk. A job whose worker stops more than twice is marked `failed` rather than retried
  forever; its `error` says so. Rows that already have an outcome were imported; submit the
  file again to import the rest (rows already imported match their accounts).
- An internal error on one chunk is retried twice; after that the job fails with "Silicon
  Accounts hit an internal error while importing rows 1001–1500 … Rows before 1001 were
  imported; re-submit the file".
- Speed: in a local test on a laptop, a 100,000-row file of new Carbons (10 MB) was processed
  in 58 seconds, and a dry run of the same file once it had been imported (every row matched)
  took about half a minute from upload to report.

For a large migration: split the export into files of at most 100,000 rows, dry-run each, then
import them one after another with one idempotency key per file. Don't send many small files:
each request counts toward the 60 per hour.

## When the whole request is refused

These answers come back before a job exists: nothing was imported. Errors have the shape
`{"error": {"code", "message", "hint", "details"?}}`.

| status | code | why | fix |
|---|---|---|---|
| 400 | `invalid_content_type` | The body is not `text/csv` (or another CSV type) or `application/json`. | Set the `Content-Type`. |
| 400 | `invalid_query` | A query parameter is not an option, or has a bad value (`dry_run=maybe`, `default_country=USA`). | Use `default_country`, `ignore_unknown_columns`, `dry_run`, `update_existing`. |
| 400 | `invalid_json` | The JSON body doesn't parse. | Send valid UTF-8 JSON. |
| 413 | `payload_too_large` | More than 50 MB. | Split the file. |
| 422 | `unknown_columns` | Columns outside the list (`details.unknown_columns`, `details.allowed_columns`). | Remove them, or `ignore_unknown_columns=true`. |
| 422 | `duplicate_columns` | The same column twice (case-insensitive; `name` = `display_name`), in the CSV header or in one JSON row. | Keep one; put more addresses in `emails` / `phones`. |
| 422 | `no_identifier_columns` | A CSV without an `email`, `emails`, `phone` or `phones` column. | Add one. |
| 422 | `empty_import` | No rows: an empty body, a header without data, or `"rows": []`. | Send at least one row. |
| 422 | `too_many_rows` | More than 100,000 rows. | Split the file. |
| 422 | `invalid_csv` | The CSV can't be read, or isn't UTF-8 (the message gives the row and line). | Save it as "CSV UTF-8". |
| 422 | `too_many_columns` | More than 200 columns (CSV header, one JSON row, or distinct names in a JSON body). | Send only the import columns. |
| 422 | `value_too_large` | A value over 8 KB, or a column name over 200 bytes (`details.row`, `details.column`). | Fix that row. |
| 422 | `too_many_items` | A JSON list with more than 50 items. | One Carbon per row. |
| 422 | `validation_failed` | The JSON body's shape or options are wrong: `rows` missing or not an array, a row that isn't an object, an unknown option, or an option given twice with different values (`details.fields`). | Fix the fields listed. |
| 409 | `idempotency_key_reused` | The key was used for a different request. | Use a new key for a new file. |
| 429 | `rate_limited` | Hourly requests or daily rows used up. | Wait `Retry-After` seconds. |
| 503 | `imports_busy` | The server is reading two other imports. | Retry after 15 seconds with the same key. |
| 401 | `invalid_app_credentials`, `unauthenticated` | Wrong secret, or no credentials. | Send the app's current secret, or sign in as its owner. |
| 403 | `app_mismatch`, `not_app_owner`, `app_disabled` | Another app's credentials, a Carbon who doesn't own the app, or a disabled app. | Use this app's credentials or its owner's session. |
| 404 | `import_not_found` | No such job for this app (when reading a job or its rows). | Take the id from the `202` or from the job list. |

## From code

TypeScript (Node 18 or later, no dependencies):

```ts
const base = process.env.ACCOUNTS_URL ?? "https://accounts.teamofsilicons.com";
const appId = process.env.APP_ID!;
const auth = "Basic " + Buffer.from(`${appId}:${process.env.APP_SECRET}`).toString("base64");

async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: auth,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`${json.error.code}: ${json.error.message} ${json.error.hint ?? ""}`);
  return json;
}

const rows = [
  { external_id: "u-100", email: "maya@example.com", display_name: "Maya Patel", username: "maya", timezone: "Asia/Kolkata" },
  { external_id: "u-101", phone: "(415) 555-0142", name: "Sam Ortiz" },
  { external_id: "u-102", emails: ["li@example.com", "li.work@example.com"], dob: "1988-04-02" },
];

// Start the job (a retry with the same key gets the same job back).
const { job } = await call("POST", `/v1/apps/${appId}/imports`,
  { rows, options: { default_country: "US", dry_run: true } }, "users-batch-1-dry");

// Poll until it finishes.
let current = job;
while (current.status === "queued" || current.status === "running") {
  await new Promise((r) => setTimeout(r, 1000));
  ({ job: current } = await call("GET", `/v1/apps/${appId}/imports/${job.id}`));
}
console.log(current.status, current.counts);

// Every row, in file order.
let cursor: string | null = null;
do {
  const page = await call("GET", `/v1/apps/${appId}/imports/${job.id}/rows?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
  for (const row of page.items) {
    console.log(row.row_number, row.outcome, row.id ?? "", row.messages.map((m: any) => `${m.level} ${m.code}`).join(", "));
  }
  cursor = page.next_cursor;
} while (cursor);
```

It prints:

```text
completed {
  created: 3,
  error: 0,
  matched: 0,
  skipped: 0,
  updated: 0,
  warnings: 0
}
1 created c:maya
2 created c:sam-ortiz
3 created c:li1 info identifiers_not_attached
```

(`li` is too short for an id, which needs 3 characters, so `c:li1` was suggested instead.)

Rust, with the [`silicon-accounts-client`](../reference/rust-client.md) package:

```rust
use std::time::Duration;

use silicon_accounts_client::{AccountsClient, ImportInput, ImportOptions, ImportRowsQuery};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = AccountsClient::new(std::env::var("ACCOUNTS_URL")?)?;
    let app = client.as_app(std::env::var("APP_ID")?, std::env::var("APP_SECRET")?);
    let csv = std::fs::read("users.csv")?;

    // 1. Dry run: every decision, nothing written.
    let options = ImportOptions { default_country: Some("US".into()), dry_run: true, ..Default::default() };
    let job = app.start_import(&ImportInput::Csv(csv.clone().into()), &options, None).await?;
    let job = app.wait_for_import(&job.id, Duration::from_secs(1)).await?;
    println!("dry run {}: {} created, {} matched, {} errors", job.status, job.counts.created, job.counts.matched, job.counts.error);
    let errors = app
        .import_rows(&job.id, &ImportRowsQuery { outcome: Some("error".into()), ..Default::default() })
        .await?;
    for row in &errors.items {
        for m in &row.messages {
            println!("  row {}: {} {}: {}", row.row_number, m.level, m.code, m.message);
        }
    }

    // 2. The real import; the key makes a retried upload return the same job.
    let options = ImportOptions { dry_run: false, ..options };
    let job = app.start_import(&ImportInput::Csv(csv.into()), &options, Some("crm-import-1")).await?;
    let job = app.wait_for_import(&job.id, Duration::from_secs(1)).await?;
    println!("import {}: {} created, {} matched", job.status, job.counts.created, job.counts.matched);
    Ok(())
}
```

`ImportInput::Json(Vec<serde_json::Value>)` sends JSON rows as they are (so the service
reports unknown columns itself), and `ImportInput::Rows(Vec<ImportRow>)` sends typed rows.

## Why it works this way

The rules above protect the Carbons you import as much as your app. The short version:

- **An email or phone belongs to exactly one account**, so a row either is that account or is
  a new one, and two accounts in one row is an error rather than a guess.
- **A new account carries one address**, so only the Carbon who proves it can claim it.
- **Your import never changes an account's own data**, because the account belongs to the
  Carbon, not to any app.
- **A dry run never names accounts**, so imports can't be used to find out who has an address.

[How imports work](../learn/imports.md) explains each decision and what it costs.
