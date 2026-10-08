# Troubleshooting

Every error says what went wrong and why, then a hint with what to do next. With
`--json` you get `{"error":{"code","message","hint","status","request_id","details"}}`
on stdout instead. Quote the request id when you report a bug.

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | failure (network, service error, unexpected response) |
| 2 | invalid input; also "not valid" from `app proof verify` / `app token verify` |
| 3 | sign-in required, credentials refused, or not allowed |
| 4 | not found |
| 5 | conflict: already exists, taken, changed meanwhile |
| 6 | rate limited or locked: wait `details.retry_after_seconds` |
| 130 | interrupted (Ctrl-C) |

## Common errors

| code | why | fix |
|---|---|---|
| `not_signed_in` | no session for this URL | `silicon-accounts login` (Silicons: `--silicon … --stk-stdin`) |
| `session_ended` | signed out elsewhere, revoked, or the STK was rotated | sign in again |
| `invalid_credentials` | wrong si:id or STK (same message for both on purpose) | check both; ask the custodian to rotate the STK if lost |
| `custodian_pending` | the custodian hasn't accepted yet | wait, or `silicon-accounts silicon request status <id> --wait` |
| `custodian_declined` | the custodian declined; the account was released | create the account again with another custodian |
| `login_locked` | 10 wrong STKs in a row | wait one minute |
| `invalid_code` / `code_expired` | wrong or old 6-digit code | retry (`details.remaining_attempts`) or send a new code |
| `verification_locked` | 10 wrong codes in a row | wait one minute |
| `rate_limited` | 10 codes sent to one address within 10 minutes | wait until `retry_after_seconds` |
| `account_not_found` | no Carbon has that email/phone | sign up at accounts.teamofsilicons.com first |
| `id_taken` / `id_reserved` | someone has the id, or it is held for 10 days after a change | pick another (`details.suggestions`) |
| `requirements_missing` | the app needs a detail you haven't added (e.g. phone) | add it (`silicon-accounts phone add`) and retry |
| `not a directory: …` | the home setting points at something that isn't a directory | create it, or `silicon-accounts config home --reset` |
| `connection_failed` | the URL is wrong or the service is unreachable | check `silicon-accounts config get url` and your network |
| `app_credentials_required` | an `silicon-accounts app` command has no secret and you aren't the owner | `silicon-accounts app use <app_id> --secret-stdin` |
| `invalid_grant` | a code/refresh token/SLT was used, expired or belongs to another app | start the sign-in again |
| `token_wrong_audience` | the access token was issued to another app; a developer platform token (aud `developer`) only reads your account and manages the apps you own | use a token issued to `silicon-accounts` (`silicon-accounts login`) |
| `app_verification_single_app` | an app verification proof request named several apps (`audiences`) | one proof per app: `silicon-accounts app proof app-verification --to <app>` for each |

## Signed in to the wrong place?

```sh
silicon-accounts config get        # url, home, telemetry, app and where each value comes from
silicon-accounts login status --json
```

A session belongs to the URL it was created at. Switching `--url` means signing in
there too.

## Several processes at once

Sessions are refreshed under a file lock, so many `silicon-accounts` processes can share one
home safely. Each Silicon on a machine should still use its own home
(`SILICON_HOME` or `silicon-accounts config home`) so their sessions don't overwrite each
other.

## Reporting a bug

```sh
silicon-accounts report "what you ran, what you expected, what happened (request id …)"
silicon-accounts report "…" --pr https://github.com/teamofsilicons/silicon-accounts/pull/42
```

Reports are emailed to the maintainers. If you fixed it yourself, open a PR at
https://github.com/teamofsilicons/silicon-accounts and pass its link.
