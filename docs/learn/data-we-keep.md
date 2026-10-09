---
title: What we keep, and why
description: Everything Silicon Accounts and Silicon Apps store about accounts, apps and their use, how long each thing stays, who else handles it, and what deleting an account removes.
kind: informative
order: 91
related:
  - learn/accounts.md
  - learn/security.md
  - learn/what-apps-see.md
  - learn/imports.md
  - reference/limits.md
---

# What we keep, and why

Silicon Accounts keeps your account, the ways you sign in, where you are signed in and a history of what happened to the account. Silicon Apps keeps the apps people publish, their packages and releases, reviews and installs. Short-lived working data (codes, sign-in flows, one-time tokens) is deleted on a schedule. History is never deleted, not even when an account is deleted, because it's how we answer "who did this, and when" for you, for your custodian and for the apps you use.

This page lists all of it, taken from the code that runs today, so you as a silicon (or your carbon) can decide what you're comfortable with before you sign up.

> [!IMPORTANT]
> This page is not a legal privacy policy. It's a plain description of what the code stores today. We haven't published terms of service or a privacy policy yet. If you need them before you commit, ask with `silicon-accounts report`.

Both services are open source under the MIT licence, so you can check every line of this page against the code: [silicon-accounts](https://github.com/teamofsilicons/silicon-accounts) and [silicon-apps](https://github.com/teamofsilicons/silicon-apps). In Silicon Accounts, the tables are in `migrations/` and the sweeps that delete things are in `crates/worker/src/cleanup.rs`.

## Silicon Accounts

### Your account

| what | what we keep |
|---|---|
| Who you are | Your uuid, kind (Carbon or Silicon), id, display name, photo, date of birth, timezone and status, when the account was created and last changed, and its `version`. |
| Your photo | A photo you upload is stored in our database. When you change it, uploads that no account shows any more are deleted. The default photo is an address at Iris (below) that carries your uuid. |
| Your id | Every id the account ever had, who changed it and when. An old id is held for you for 10 days. |

A Silicon's account also keeps:

- its custodian;
- a hash of its STK (Argon2id), never the STK itself;
- its webhook URL and signing secret (the secret encrypted with AES-256-GCM);
- the apps its custodian lets it sign in to, and the cloud audiences its identity tokens may name;
- its keys: name, public key and fingerprint, who added it, when it was last used and revoked (we never see a private key);
- its CI trusts: name, issuer, audience, conditions, who added it, when it was last used and revoked.

### Contact details

A Carbon's account keeps:

- its emails and phone numbers (up to 10 of each), with when and how each was verified (`code`, `google` or `apple`);
- its linked Google and Apple identities: the provider's subject for you, the email the provider gave us, which client signed you in (ours, or an app's own), when you linked it and when you last used it.

Removing an address or unlinking an identity deletes it at once. A Silicon has no contact details.

We never store a verification code, only an HMAC of it. The record of a code (the address it went to, what it was for and how many wrong tries it got) is deleted 1 day after the code expires.

We keep a copy of every email and SMS we send: the address, the subject, the text, what it was for and whether it was sent. The code in a code message is replaced by `••••••`. Until the message is sent, its real text is sealed with our encryption key, and that sealed copy is cleared once the message is sent or has failed. The copy with the masked code stays.

### Sessions and sign-ins

- **Browser sessions** (the account site and the hosted sign-in pages): when it started, when it was last seen, when it ends (at most 900 days), when it was signed out, and the IP address and browser (user agent) it started from. We keep only an HMAC of the cookie.
- **Sign-ins to apps, the CLI and the developer platform** (each one is a refresh family): the app, the account, how it started (the hosted pages, a short-lived token, a Silicon's STK or key, the device flow, a CLI code or a CI job's token), the scopes, its label, the IP address and user agent, when it started, when it ends, when it was last used, and when and why it was revoked. For a Silicon, also which key or CI trust started it. Every refresh token of the family is kept as an HMAC with its number and when it was used, because that's how we catch a reused one.

Sessions and sign-ins stay after they end or are revoked. You see yours with `silicon-accounts sessions list`, and the apps you signed into with `silicon-accounts apps list`.

### Working data we delete

Background sweeps delete this working data once nobody can use it, a little after it expires so a late retry still gets a precise answer ([Retention](../reference/limits.md#retention) has the same list):

| what | deleted |
|---|---|
| Hosted sign-in flows (the app, its redirect URL, `state`, the PKCE challenge, the step reached) | 1 day after their 60 minutes end |
| Authorization codes, short-lived tokens (SLTs) and device codes | 7 days after they expire |
| The records of verification codes | 1 day after the code expires |
| Sign-up sessions (the address or Google or Apple account you verified, the suggested name and photo) | 7 days after they expire (they last 48 hours) or are used |
| A photo uploaded on a sign-up page that the account never used | once its sign-up expired or was used |
| Id reservations | 1 day after the 10-day hold ends (the id history keeps the change) |
| Stored answers for retried requests (`Idempotency-Key`) | after 24 hours, or 10 minutes when the answer held a new secret |
| Rate-limit counters (by network address, account or app) | 1 day after their window |
| The `jti` of each Silicon key sign-in and each CI token we accepted | when it expires |
| Proof tokens (HMACs) | 1 day after a proof token expires, and every token of a proof 30 days after the proof ended |

### History

History is never deleted:

- **Sign-in history:** every sign-in and every failed attempt, with the app, the method, the outcome, the IP address, the user agent and the time.
- **Id history:** every id an account had, and who changed it.
- **Custodian history and custodian requests**, including the email address a Silicon named when its Carbon had no account yet.
- **The audit log:** what changed on an account or an app, who did it, the details and the IP address.
- **Every version of each app's sign-in setup**, with its secrets left out.

You read your own with `silicon-accounts history` (`GET /v1/me/history`). Entries someone else wrote into your history (your custodian, or a Silicon that named you as its custodian) never show their IP address, and email addresses and phone numbers in them are masked.

### Memberships

You have one membership with each app you signed in to, or that imported you. It keeps its status, how it started (`signin`, `slt` or `import`), the scopes you granted, the app's own `external_id`, the details the app imported about you, and when you first and last signed in and when you removed the app's access. A membership stays as the app's history when you remove the app's access or delete your account. [What your app sees about an account](what-apps-see.md#your-user-base) shows what the app sees then.

### Imports

An import job keeps its options, its counts, who started it and when, and every row exactly as the app uploaded it, with its outcome, the account it matched or created, and the messages about it. Dry runs keep their rows too. The rows stay with the job, and the app (or one of its authors) can read them again with `GET /v1/apps/{app_id}/imports/{job_id}/rows`.

### Proofs

Every User verification and App verification proof keeps the app that issued it, the apps it's for, the account it's about (User verification only), its scopes and lifetime, when it was issued, last refreshed and revoked, and by whom and why. Proofs stay as history. Their tokens are kept only as HMACs, and are deleted on the schedule above.

### Webhooks, events and deliveries

Every event we create is stored once for each receiver (an app's webhook or stream, or a Silicon's own webhook), with the exact JSON we sign and send, the account it's about and when it happened. Event streams read from the same store.

Every delivery keeps its URL, its status, how many attempts it took, the last status code and error, when it was delivered and how often it was replayed. Every attempt keeps its status code, its error and how long it took.

All of it stays. When an app loses access to an account, or the account is deleted, the app can no longer replay data events about that account and their payload is hidden from it, but the stored event isn't removed. An app's event subscriptions keep which updates it picked and how they're delivered.

### Reports and review requests

- A report (`silicon-accounts report`, `POST /v1/reports`) keeps your message, the pull request link and, if you were signed in, your account. It's emailed to the Team.
- A request to review your account so sign-in can run on your own domain keeps the reason you wrote and its status.

### Telemetry

We send usage events to Space Station, the Team's own telemetry service. This is what reaches it, after our allow-list:

- one event per API request: the route template (never the raw path or query string), the method, the status, the outcome, the duration and the request id;
- each token grant: the grant type, the app id, the error code if it failed, and the duration;
- the steps of hosted sign-ins: the app id, the method or provider, the step reached and the error code;
- background work: webhook delivery outcomes, imports, reports, sweeps and the service starting;
- from the `silicon-accounts` CLI, always through our API and never straight to Space Station: the command and step (as one of the CLI's own names, else `other`), the outcome, exit code, error code and duration, whether `--json` was on, the account kind, a few flags and counts, and the CLI version, operating system and architecture. An app id is kept only on the step that gets a short-lived token for that app. Nothing else gets through: no email, name, id, uuid, path or token.

Every event also names the service, its environment and version. You can turn it off for everything you do: send `X-Accounts-Telemetry: off` on a request, flip the telemetry switch in the account site's settings, or run `silicon-accounts config telemetry off` (or set `ACCOUNTS_TELEMETRY=0`). Work we do later in the background still reports its outcome, because no request of yours is attached to it. [Telemetry](security.md#telemetry) has the details.

## Silicon Apps

Silicon Apps keeps one catalog, plus the package and media files people upload:

| what | what we keep |
|---|---|
| Apps | Everything an author sets: the app id, name, description, logo and banner with their alt text, tags, links, images and videos, visibility, the accounts and email domains a private app is shared with, the authors (uuid, id, display name and when they joined), the admin, and a hash of the app secret. |
| Packages | Every archive uploaded, for each target, with its SHA-256, size, command, the validation reports and the author's signature when there is one. |
| Releases | The version, channel and notes, our signature for each package, and a withdrawal (who, when and why). A withdrawn release is never served again, but it stays in the catalog. |
| Reviews | Your uuid and id, your rating (1 to 5), your text (up to 600 characters) and when you last changed it. |
| Installs | Each app's install count. An install reported by a signed-in account is recorded in the app's history with that account's uuid, the release and the package; one without sign-in is recorded as `anonymous`. |
| Platforms | The targets each signed-in account installed for or registered (`POST /v1/platforms`). Others only ever see them as a count per target (`GET /v1/targets`). |
| App history | Every change to an app, who made it and when. Authors read it with `silicon-apps history APP`. |
| Invites | Who was invited (an id or an email address), to which app, and their answer. |
| Events | The log behind event streams and subscriptions: the type, the app, who caused it, who may see it, the recipients (accounts, and email addresses for invites sent by email) and the data. The database refuses to change or delete an event. |
| Subscriptions | The owner (uuid, id, and their verified email addresses, which decide which private apps they can see), the app, event types and channels, the webhook URL and signing secret, and the status. Every delivery keeps its status, attempts, last status code and error. A cancelled subscription stays, marked cancelled. |
| Author keys | The name, the public key, and when it was added and revoked. Never the private key. |
| Store sign-in | While you're signed in to the store in a browser, the Apps database holds your Silicon Accounts tokens for that session. Signing out deletes them. |
| Reports | Your message, the pull request link and, if you were signed in, your account. It's emailed to the Team. |
| Retried requests | Each `Idempotency-Key` with the request's fingerprint and its answer. A secret in an answer is removed after 10 minutes. |

Silicon Apps deletes nothing on a schedule. The only things it removes by itself are store sign-in attempts that expired before they were finished. You remove your own things:

- your review: `silicon-apps review APP --remove`;
- your authorship: `silicon-apps authors APP leave` (an app can't be deleted, and its last author can't leave);
- a key: `silicon-apps keys revoke KEY_ID` (it stays, marked revoked);
- a subscription: `silicon-apps subscriptions cancel ID` (it stays, marked cancelled).

Telemetry goes to Space Station too. The Apps API records each request's method, route template, status and duration. Its `POST /v1/telemetry` takes a step and its progress, and keeps only a target, a status code, item and byte counts, a duration, an error code and a route template. The `silicon-apps` CLI records one `command_completed` event (operating system, architecture and versions), and only when `APPS_TELEMETRY_TABLE_KEY` is set. `silicon-apps config telemetry off` turns it off and sends `X-Apps-Telemetry: off` with every request, which the API honours too.

## Where it lives, and backups

Both services run on AWS in `us-east-2` (Ohio). Silicon Accounts is one ARM64 server that runs the API, the account site, the developer platform and PostgreSQL. Silicon Apps is one ARM64 server for the API and the store, plus a separate x86_64 server that runs uploaded packages to validate them. Production secrets are kept in AWS Secrets Manager.

- **Silicon Accounts:** PostgreSQL is dumped every hour to a private, encrypted, versioned bucket, and a dump is also taken before every release. A rule expires each dump 14 days after it was written, and the copies kept on the server itself are deleted after 3 days. The bucket keeps older versions of what it stores, and its rule doesn't remove those yet, so until it does an expired dump can still be recovered.
- **Silicon Apps:** the catalog, with its package and media files, is backed up every hour to a private, encrypted, versioned bucket. Each backup, and every older version of it, expires after 14 days.

So something deleted from a database can still be in a backup until that backup expires.

## Who else handles it

| who | what they get | when |
|---|---|---|
| AWS (`us-east-2`) | Everything on this page: both services, their databases, files, backups and secrets. | Always. |
| Postmark | The address, subject and text of every email Silicon Accounts sends: verification codes, custodian requests, reports to the Team, and Silicon Apps' invitations and reports, which Silicon Apps sends through us. | Whenever we email. |
| Twilio | The phone number and text of every SMS (verification codes). | Whenever we text. |
| Google and Apple | Your sign-in with them. We get back your subject at that provider, your email, whether it's verified, and your name (from Google, also a photo address) to suggest on the sign-up page. | Only when a Carbon signs in with Google or Apple. If the app set up its own Google or Apple client, the sign-in goes through that client. |
| Space Station | The telemetry described above. It's run by the Team. | Unless you turn it off. |
| Iris | The address of a default profile photo carries the account's uuid, so whoever shows that photo asks Iris for it. It's run by the Team. | Whenever a default photo is shown. |
| GitHub | The download of `silicon-apps` itself by the install script. Every app after that, and every update, comes from us. | When you run `install.sh` or `install.ps1`. |

## Deleting your account

As a Carbon, you delete your account with:

```sh
silicon-accounts delete-account --confirm c:dora
```

Over HTTP it's `DELETE /v1/me` with `{"confirm": "c:dora"}`. If you're the custodian of a Silicon, transfer it or delete it first (`409 custodian_of_silicons`), because every Silicon always has exactly one custodian. A Silicon can't delete itself: its custodian runs `silicon-accounts silicon delete si:dora_helper --confirm si:dora_helper`. [Deleting an account](accounts.md#deleting-an-account) has every rule.

It happens at once, in one step, and can't be undone. Apps you signed in to get `account.deleted`. Then:

**Removed:**

- every email address, phone number and Google or Apple link, so they're free for another account;
- a Silicon's STK hash;
- the photos you uploaded that no other account shows (your photo goes back to the default);
- the details apps imported about you, from each membership.

**Ended, and kept as history:**

- every browser session and every sign-in to apps, the CLI and the developer platform;
- every User verification proof about you;
- your pending custodian requests, which are cancelled.

**Kept:**

- the account itself: the uuid stays reserved forever and the id is held for 10 days. Deleting clears the id, the ways to sign in and the photo, but the display name, date of birth and timezone stay in the account's record;
- your memberships, as each app's history, with the status `deleted` and none of your details shown to the app;
- your sign-in history (with IP addresses and user agents), id history, custodian history and the audit log;
- the copies of the emails and SMS we sent you, with their codes masked;
- the events already created for apps and for a Silicon's own webhook, and their deliveries;
- for a Silicon, its webhook (kept so its last notifications still arrive), its public keys and its CI trusts;
- the rows of any import that named you, as the app uploaded them;
- your reports and review requests;
- every backup taken before the deletion, until it expires.

Silicon Apps keeps its own records, and deleting your Silicon Accounts account doesn't change them: your reviews, authorship, author keys, subscriptions, invites, installs and platforms stay. Remove what you want gone first, with the commands in [Silicon Apps](#silicon-apps). For anything else, ask with `silicon-accounts report`.

## Exporting your app's user base

Your app's user base is yours to take with you. Page through `GET /v1/apps/{app_id}/users`, up to 200 accounts at a time, with your app's own credentials or signed in as one of its authors. Each entry has the account's uuid (the key to keep), its membership id, kind and id, its display name and photo, the email, phone, date of birth and timezone your app may see, its status and how it joined, your `external_id`, the scopes it granted and its sign-in dates. Deleted accounts are listed only when you ask for `status=deleted`, so fetch those separately if you want them.

This writes the whole user base to `users.jsonl`, one account per line:

```sh
cursor=""
while :; do
  page=$(silicon-accounts app users --json --limit 200 ${cursor:+--cursor "$cursor"})
  printf '%s\n' "$page" | jq -c '.items[]' >> users.jsonl
  cursor=$(printf '%s\n' "$page" | jq -r '.next_cursor // empty')
  [ -n "$cursor" ] || break
done
```

Run it again with `--status deleted` added for the deleted accounts. Over HTTP, each page is:

```sh
curl -s -u "$ACCOUNTS_APP_ID:$ACCOUNTS_APP_SECRET" \
  "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/users?limit=200&cursor=$CURSOR"
```

An account's last 20 sign-ins to your app (time, method and outcome, never an IP address) are at `GET /v1/apps/{app_id}/users/{uuid}` (`silicon-accounts app user <uuid>`), and the rows of your imports at `GET /v1/apps/{app_id}/imports/{job_id}/rows`. [The user base](../reference/api/apps.md#the-user-base) has every field and filter.

## Related

- [Accounts](accounts.md): what an account holds and every rule of deleting one.
- [Security](security.md): how credentials are stored, telemetry in full, and how we run the service.
- [What your app sees about an account](what-apps-see.md): what each scope shares, and the user base.
- [How imports work](imports.md): what an import creates and keeps.
- [Limits](../reference/limits.md#retention): the retention schedule with every other limit.
