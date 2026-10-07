# Importing an app's existing users

An app that already has accounts can bring all of them along. Each imported row is
matched to the Carbon account that already has its email or phone; when there is
none, a new Carbon account is created as `unclaimed`. The person finishes setting it up
(with everything prefilled) the first time they sign in. Importing never sends an
email or SMS.

## Run an import

```sh
accounts app import users.csv --default-country US --dry-run --wait   # check first
accounts app import users.csv --default-country US --wait
```

`--wait` shows progress, the outcome counts and the first errors. Without it the job
id is printed; follow it with `accounts app import status <job> --wait` and inspect
rows with `accounts app import rows <job> --outcome error` (or by message:
`--level warning`, `--code id_conflict`). Both `--wait` forms exit 1 when the whole job
failed, so a script can tell.

Use `--dry-run` first: it validates every row and reports exactly what would happen
("would create", "would match"…), without writing anything. Re-running the same upload with the same
`--idempotency-key` never creates a second job.

## Columns

These are the only columns accepted (the user base has fixed columns):

| column | notes |
|---|---|
| `external_id` | your id for the account; must be unique within your app |
| `email`, `emails` | `emails` may be a list or `;`-separated |
| `phone`, `phones` | E.164, or local with `--default-country` |
| `display_name` (or `name`) | falls back to the email or phone |
| `username` | wanted handle (`john` or `c:john`) |
| `dob` | `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY` (when unambiguous), `YYYY/MM/DD` |
| `timezone` | IANA name; invalid → UTC with a warning |
| `pfp_url` | https only, and not a photo uploaded to Silicon Accounts (→ default photo, with a warning) |
| `email_verified` | informational; imported emails are never trusted as verified |

Any other column makes the import fail with `unknown_columns` (listing them), unless
you pass `--ignore-unknown-columns`, which imports anyway and warns on affected rows.
CSV needs a header row; JSON is a list of objects (or `{"rows":[…]}`). At most
100,000 rows or 50 MB per import.

A file over 50 MB is refused before it is uploaded: exit 2 with `payload_too_large`,
its size and the limit. Split it into files of at most 50 MB and 100,000 rows each (every
CSV part starting with the header row) and import them one after another. Why the CLI
checks first: the service refuses an oversized body as soon as it sees its size, usually
before the upload has finished, so a client that kept uploading could see a reset
connection instead of the reason. For JSON the limit applies to the rows as they are sent
(re-encoded without the file's indentation), so the CLI checks the encoded body.

## Row outcomes

| outcome | meaning |
|---|---|
| `created` | new unclaimed Carbon account |
| `matched` | an existing account has this email/phone; it joins your user base as `imported` |
| `updated` | matched, and `--update-existing` refreshed your imported profile for it |
| `skipped` | e.g. `duplicate_in_file`: an earlier row has the same email/phone |
| `error` | e.g. `missing_identifier` (no valid email or phone), `ambiguous_match` (email and phone belong to two accounts), `external_id_conflict` |

Warnings explain every adjustment, for example
`id_conflict: wanted c:john, assigned c:john-2` when the username was taken, or an
invalid phone that was dropped while the row went on with its email.

Why matching works this way: an email or phone belongs to exactly one account, so an
imported row either is that account or is a new one. Your import never overwrites an
account's own data; `--update-existing` only changes what your app stored for it.

## After the import

Imported accounts show as `imported` in `accounts app users --status imported` until
they sign into your app, when they become `active`. An unclaimed account is finished
by its owner the first time they sign in with one of the imported emails or phones.
