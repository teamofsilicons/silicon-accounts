# Silicon Developer docs (full)

You have ended up on the full Silicon Developer docs. This one file holds everything about building in the Silicon ecosystem: Silicon Apps, where apps are made, published, found and installed, and Silicon Accounts, the account and sign-in layer every Carbon, Silicon and app in the ecosystem shares. If you read only this file, you should be able to decide whether we fit what you are building, and then build it correctly.

The short version lives at https://developers.teamofsilicons.com/llms.txt. Every page of the docs is also plain Markdown at its own link, listed at the end of the short version.

What's in here, in order (every chapter is an `#` heading you can search for):
- At a glance: what we are, who we are for, what we don't do yet, cost and status, how we run it, and what we keep.
- The basics: how to read this file (with shorter paths if you only need sign-in or only need distribution), the glossary, where things live, installing the CLIs.
- Quick starts and recipes: a Silicon getting started, an app getting started, and the common jobs step by step.
- The understanding: Silicon Apps, Silicon Accounts, why build on us, and an honest comparison with the alternatives.
- FAQ.
- The reference: Silicon Apps in full, then Silicon Accounts in full. Every command, endpoint, field, event, error and limit, chapter by chapter.

# At a glance

## What we are

- **Silicon Accounts** gives every Carbon (a person) and every Silicon (an agent) one personal account, and does the whole sign-in for any app: hosted pages, email and phone codes, Google and Apple, sign up, the app's user base, webhooks, and proofs between apps. It is a standard OpenID Connect provider at `https://accounts.teamofsilicons.com`.
- **Silicon Apps** is a store and distribution system for command-line apps: authors publish native packages for up to nine targets (a new app can publish for `linux-x86_64` only today, see below), and anyone installs them with one command and gets every update automatically.
- Both are made for agents first. Every command has `--help` and `--json`, every error says exactly what went wrong and how to fix it, and everything the sites do is also an API, an MCP server and plain HTML.

## Who we are for

We fit best when:
- your app will be used by agents (Silicons) as well as people, especially CLIs and services that agents run on their own;
- you want agents to have their own accounts, with an accountable Carbon behind each one, instead of borrowing a person's login or a shared API key;
- your app wants to work with other apps in the ecosystem, as itself (App verification) or for a user (User verification);
- you want to ship a CLI and have it installed and kept up to date for you (today a new app publishes for `linux-x86_64`, and the other eight targets across Linux, macOS and Windows open as their validation workers come online).

## What we don't do yet

Read this before you choose us, so nothing surprises you later:
- Carbons sign in with Google, Apple, an email code or a phone code. There are no passwords, no passkeys, no multi-factor authentication of our own, and no SAML or enterprise SSO yet. This matters most for a custodian, whose sign-in controls their Silicons, so a custodian should sign in with Google or Apple and turn on MFA there (`## Operations and trust` below).
- There are no organizations or Teams of accounts: every account is personal. If you bill companies, you model the company in your own app. (When these docs say "the Team", they mean the people who run Silicon Accounts and Silicon Apps.)
- A Silicon can't use the device flow, because only a signed-in Carbon can approve a device code. It signs in to your CLI with an SLT instead. Turn on `public_client` and your CLI exchanges that SLT itself with your `client_id` alone, no secret and no server, so a CLI on its own signs in Carbons (device flow) and Silicons (SLT) both. Never ship your app secret inside a CLI: a secret in a binary isn't secret. If your CLI talks to an API of yours, a small server that exchanges the SLT with the secret is still the usual shape (`## CLI plus server: people, Silicons and CI` in `# Recipes` shows both).
- A Silicon always acts as itself at your app, never as its custodian: there is no delegation grant. Your app does learn who its custodian is, and can let that Carbon share things with it (`## Let a Silicon work on its custodian's things in your app` in `# Recipes`).
- Upload validation runs only on `linux-x86_64` today, so a new app can publish packages for that one target right now. Our own two CLIs ship on all nine targets, because we ran and checked them natively on each one in our CI. The other eight open to every app as their validation workers come online. `silicon-apps capabilities` (or `GET /v1/capabilities`) shows which workers are live right now, and an upload for a target without one is refused with `503`.
- Passwords are never imported. When you move existing users in, they sign in the first time with an email code (or Google or Apple) on the address you imported, and keep that account from then on.
- Your app can't define its own OAuth scopes for third-party clients, and we don't run Dynamic Client Registration, so chat assistants that connect to MCP servers through standard OAuth can't use Silicon Accounts to reach your app yet. Silicons connect to your app with an SLT instead.
- Signing in with Silicon Accounts works at apps that integrate it, and a Silicon's identity tokens work at cloud providers that accept OIDC federation (AWS, Google Cloud, Microsoft Entra). For other outside services (a code host, a ticket tracker), your agent still uses the credentials those services give it.
- Silicon Apps packages are native CLI builds per target. A library for other code belongs in your language's registry.
- Silicon Apps always keeps installed apps up to date; there is no version pinning on a machine that runs the updater.
- The sign-in pages always show `Powered by Silicon Accounts`. Sign-in on your own domain is a manual review today.
- The tokens your app gets (access tokens and id_tokens) are always signed with EdDSA (Ed25519), so use an OIDC or JWT library that supports EdDSA. Discovery lists `RS256` as well, but only a Silicon's identity tokens for cloud providers use it; no token issued to your app is ever RS256.

## Cost, status and openness

- There are no paid plans today: everything in this file is free to use.
- We are new: both services launched in October 2026. On 9 October 2026 the store held our own two CLIs (`silicon-apps` and `silicon-accounts`) and no third-party apps yet. The live numbers are always at `https://apps.teamofsilicons.com/v1/apps`.
- Both services are open source, under the MIT licence: https://github.com/teamofsilicons/silicon-apps and https://github.com/teamofsilicons/silicon-accounts. You can read exactly what we run, run it yourself, and send us a fix.
- You can always leave. For Carbons we are standard OIDC: your app keeps the uuids it stored, and you can read your whole user base at any time with `GET /v1/apps/{app_id}/users` or `silicon-accounts app users --json`, with the emails and phones each one shared. Silicons take more work, so plan for it before you start: a Silicon has no email or phone to match it by at another provider (you map it by the uuid you stored), it signs in with our own SLT grant (`urn:silicon:params:oauth:grant-type:slt`) that no other provider speaks, and any CI trusts and cloud trust policies that name our issuer (`https://accounts.teamofsilicons.com`) have to move to the new one. The steps are in `## Leave, if you ever want to`.

## Operations and trust

- Who runs it: Team of Silicons. That's who "the Team" means everywhere in these docs.
- Support: `silicon-accounts report "<what happened>"` or `silicon-apps report "<what happened>"` reaches the Team, with `--pr <link>` if you've already patched it. Security problems go to the contacts in `https://accounts.teamofsilicons.com/.well-known/security.txt` (the same file is on `apps.` and `developers.`), which include a private security advisory on each GitHub repository.
- Health: `https://accounts.teamofsilicons.com/readyz` and `https://apps.teamofsilicons.com/health`. `GET /v1/capabilities` on either service shows what is live right now, including which upload validation workers are running.
- Hosting and backups: AWS in `us-east-2`. Each service's database is backed up every hour, and each backup expires after 14 days (one caveat for Silicon Accounts is in `## What we keep`).
- Signing keys:
  - Access tokens and the id_tokens your app gets are signed with one Ed25519 key (`kid` `accounts-production-1`). The service is given it through its environment when it starts; it is never stored in the database.
  - A Silicon's identity tokens for cloud providers are signed with a separate RSA-2048 key (`RS256`, its `kid` is its RFC 7638 thumbprint). The service makes it on its first start and keeps it in the database, encrypted with AES-256-GCM under the service's own encryption keyring.
  - Both public keys are at `https://accounts.teamofsilicons.com/.well-known/jwks.json`. Cache it, and fetch it again when you see a `kid` you don't know.
  - Refresh tokens, SLTs, authorization codes and proofs aren't signed at all. They are random, and we keep only a keyed hash (HMAC) of each, never the token itself. That's why a proof is checked online with `POST /v1/proofs/verify`.
  - Silicon Apps signs every release with its own Ed25519 key, `apps-2026-10`, which is pinned inside the CLI and published at `https://apps.teamofsilicons.com/.well-known/silicon-apps-keys.json`.
- A custodian's own sign-in is the root of control over its Silicons. Whoever signs in as that Carbon can rotate their STKs, add keys and CI trusts, allow cloud audiences, transfer them and delete them. A Carbon signs in with an email code, a phone code, Google or Apple, and we have no MFA of our own yet. So if you're a custodian, sign in with Google or Apple and turn on their MFA; your Silicons are then as safe as that account.
- Telemetry: we record how the services and CLIs are used in Space Station, the Team's own telemetry service. It's on by default, and you can turn it off:
  - The Accounts API records one event per request (the route pattern, never the raw path or query, plus method, status, outcome and duration), each token grant (grant type, app id, error, duration), the steps of each sign-in, and its own background work (webhook deliveries, imports, reports). A request sent with `X-Accounts-Telemetry: off`, or from a browser where the telemetry switch in the account site's settings is off, records nothing. Background work still reports.
  - The `silicon-accounts` CLI sends its events to our API, never straight to Space Station, when a command that used the network ends: at most 40 step events and one command event (command, outcome, exit code, error code, duration, whether `--json` was on, the account kind, plus CLI version, OS and architecture). It waits at most 1.5 seconds. Our API forwards only the CLI's own step names, command paths, fields and fixed words, turns anything else into `other` or drops it, and keeps an app id only on the step that gets an SLT, so nothing a client makes up (an email, a name, a path) reaches Space Station. `silicon-accounts config telemetry off` or `ACCOUNTS_TELEMETRY=0` turns it off, and then every request also carries `X-Accounts-Telemetry: off`.
  - The `silicon-apps` CLI records a `command_completed` event (OS, architecture, CLI version) only when `APPS_TELEMETRY_TABLE_KEY` is set; without it, it sends nothing. `silicon-apps config telemetry off` turns it off and sends `X-Apps-Telemetry: off` to the Apps API.
  - The Apps API's own `POST /v1/telemetry` takes only a fixed set of fields, and `X-Apps-Telemetry: off` opts a request out.
- Not published yet: an SLA, a status page with incident history, and legal terms. If you need any of them before you commit, ask with `silicon-accounts report`.

## What we keep

The full list, with how long each thing stays, is at https://developers.teamofsilicons.com/docs/accounts/learn/data-we-keep.md. It's a plain description of what the code stores, not a legal privacy policy: terms of service and a privacy policy aren't published yet. In short:
- Silicon Accounts keeps accounts, contact details, sessions and sign-ins (with IP addresses and user agents), memberships, imports, proofs, webhook events and deliveries, and a copy of every email and SMS it sends, with codes masked. Working data (codes, sign-in flows, one-time tokens, idempotency answers, rate-limit counters) is deleted within 7 days of expiring, and a proof's tokens within 30 days of the proof ending. History is never deleted, even after an account is deleted.
- Silicon Apps keeps apps, packages, releases, reviews, installs, the targets each signed-in account installs for, an append-only event log and subscriptions. Nothing is deleted on a schedule; you remove your own review, authorship, keys and subscriptions.
- Backups run every hour and expire after 14 days. Silicon Accounts' backup bucket keeps older versions and doesn't expire those yet, so an expired dump can still be recovered until it does.
- Who else handles it: AWS (`us-east-2`), Postmark (email), Twilio (SMS), Google and Apple (only when a Carbon signs in with them), Space Station and Iris (both run by the Team), and GitHub (the install script's first download).
- Deleting an account (`silicon-accounts delete-account --confirm c:{id}`) removes its emails, phones, Google and Apple links and the photos it uploaded that no other account shows, and ends every session, sign-in and User verification proof. The uuid, the history and the memberships stay, as history. Silicon Apps records stay until you remove them.
- An app exports its user base by paging through `GET /v1/apps/{app_id}/users` (`silicon-accounts app users --json --limit 200`, following `next_cursor`), and asks for `status=deleted` separately.

# How to read this file

The file goes from short to long. `# At a glance` and the basics come first, then the quick starts and `# Recipes`, then the understanding (`# Silicon Apps`, `# Silicon Accounts`, why build on us and how we compare), then the FAQ. Read that far once, top to bottom.

Everything after the FAQ is the reference, and it's most of the file: every command, endpoint, field, event, error and limit, grouped by topic, first `# Silicon Apps, in full` and then `# Silicon Accounts, in full`. Jump to the chapter you need. Each reference chapter ends with a `More:` line pointing at the docs pages it came from, in case you want the long version with every example.

## If you only need sign-in

You want Silicon Accounts for your app or site, and you won't ship a CLI through the store:
1. `# At a glance`, `# Glossary` and `# Quick start for an app` (steps 1, 2 and 4).
2. In `# Recipes`: `## Sign people into your CLI`, `## CLI plus server: people, Silicons and CI` and `## Let a Silicon work on its custodian's things in your app`, if you have a CLI or Silicons will use your app.
3. `# Silicon Accounts`, then the reference from `# Silicon Accounts, in full` on. Start with `# Adding sign-in to your app`, then one of `# The hosted pages`, `# The iframe`, `# The SDK snippet` or `# Any OpenID Connect library`, then `# Tokens and sessions`, `# What your app sees about an account`, `# Signing a Silicon into an app` and `# Webhooks`. Keep `# Errors` and `# Limits` open while you build.

You still create the app on Silicon Apps (`# Creating an app`, or the developer site), because that's where its app_id and secret come from. Nothing else in the Silicon Apps chapters is needed.

## If you only need distribution

You want to ship a CLI and have it installed and kept up to date, and you don't need sign-in:
1. `# At a glance` (the targets note in `## What we don't do yet` first), `# Install the CLIs` and `# Silicon Apps`.
2. In `# Recipes`: `## Ship a CLI people and agents can trust` and `## Use apps in CI`.
3. The reference from `# Silicon Apps, in full` to `# Apps Rust packages`.

Every package still has to answer `accounts --json` and `login status --json`. For a tool with no sign-in a few lines are enough (`### When your tool has no sign-in` in `# Publishing an app`), and you never touch Silicon Accounts.

## Rules that hold everywhere

So you don't have to look them up again:
- Store an account's `uuid`, never its c:id or si:id. The uuid never changes; the ids can. Despite its name, a uuid is not an RFC 4122 UUID: it's a short, case-sensitive id made of letters and digits, like `a8K`, so `a8K` and `A8k` are two different accounts. It is the `sub` of every token we issue, so the subject your OIDC library gives you is the uuid. Store it as case-sensitive text.
- Errors from both APIs look like `{"error": {"code", "message", "hint", "details"}}`. The `code` is the contract, the `message` and `hint` are for reading, and `hint` or `details` may be missing when there is nothing to add. The OAuth token, revoke and introspect endpoints answer in the RFC 6749 shape (`error`, `error_description`) instead, because every OAuth library expects it. Proof verification always answers `200` with `valid: true` or `valid: false`.
- Retries are safe with an `Idempotency-Key` header, but the two services treat it differently, so check which one you're calling:
  - Silicon Apps requires one on every `POST`, `PUT`, `PATCH` and `DELETE` under `/v1`, except `/v1/auth/*`: 8 to 200 visible ASCII characters, no spaces. The same key on a different method, path or body is `409 conflict`. A response that carried a secret replays for 10 minutes only, then `409 secret_replay_expired`.
  - Silicon Accounts makes it optional, on every write you might retry (each endpoint's reference says which): 1 to 200 visible ASCII characters, no spaces, scoped to you, the method and the route, and kept for 24 hours (10 minutes when the answer holds a new secret). The same key with a different body is `409 idempotency_key_reused`. Errors are never stored, so a retry after an error runs the request again.
- Live event streams differ too. Silicon Accounts allows 5 open streams per app or account on each of its API nodes (each node counts its own, so with several nodes running the total can be higher) and ends each one after an hour. Silicon Apps allows 10 per token (or per session, or per address when you aren't signed in) and ends each one after 30 minutes. Both send a heartbeat every 15 seconds and resume from `Last-Event-ID`, so reconnecting loses nothing.
- Too many requests get `429` with a `Retry-After` header. Wait that many seconds.
- Times are RFC 3339 in UTC.
- App ids are lowercase letters, digits, `-` and `_`. Silicon Apps creates them, 3 to 30 characters long.

# Glossary

`Carbon` - A person. Every person's account is a Carbon, shown as `c:{handle}`, for example `c:shubham`.

`Silicon` - An agent. Every agent's account is a Silicon, shown as `si:{handle}`, for example `si:head_of_growth`.

`Custodian` - The Carbon responsible for a Silicon. Every Silicon always has exactly one.

`uuid` - The permanent id of an account, for example `a8K`. It never changes and is never reused. It is not an RFC 4122 UUID: it's short, made of letters and digits, and case-sensitive (`a8K` and `A8k` are different accounts). We kept the name because it does the same job. It's the `sub` in every token and in OpenID Connect.

`c:id` / `si:id` - The public id people see and type. It can change; the old one stays reserved for 10 days.

`App` - Anything published on Silicon Apps. Every app in the store is a CLI, and can also have a website and mobile apps. Any app, including a website with no CLI, can sign its users in with Silicon Accounts as soon as it's created.

`app_id` - The permanent id of an app, for example `briefcase`.

`Author` - A Carbon or Silicon who owns an app. An app can have many authors and they are all equal; any of them can manage the app's sign-in.

`Membership` - An account's relationship with an app, written `{app_id}:{uuid}`, for example `briefcase:a8K`.

`STK` - A Silicon's password, for example `stk-3f9a1c7e5b2d`. Your app never sees it.

`SLT` - A short-lived token a signed-in Silicon asks us for, made for exactly one app. It works once and expires after two minutes. The app exchanges it for its own session.

`App verification` - A proof that a request comes from a given app (`/v1/proofs/app-verification`).

`User verification` - A proof that an app may act for a given account at another app (`/v1/proofs/user-verification`).

`Account verification request` - Not a proof: a request to the Team to review your account so sign-in can run on your own domain.

`the Team` - The people who run Silicon Accounts and Silicon Apps (Team of Silicons). Not a kind of account: accounts never belong to a team.

`Target` - One OS and architecture an app's CLI is built for, for example `macos-aarch64`.

## The same words, in standard terms

| Here | Closest standard term |
| --- | --- |
| Carbon | a user account (a person) |
| Silicon | a service account or agent identity, owned by exactly one person (its custodian) |
| Custodian | the accountable owner of a service account |
| STK | a service account's password; keys (Ed25519) can replace it |
| SLT | a one-time, audience-bound token exchanged with a custom OAuth grant (`urn:silicon:params:oauth:grant-type:slt`) |
| uuid | the stable subject identifier (`sub`), a short case-sensitive string, not an RFC 4122 UUID |
| c:id / si:id | a changeable username (`preferred_username`) |
| Membership | a user's link to one client app |
| App verification | client authentication between two services, scoped to one audience |
| User verification | a delegated, audience-bound grant for one user (like token exchange for one resource) |
| Account verification request | a manual review for custom-domain sign-in |

# Where things live

- `developers.teamofsilicons.com` - where you create apps, publish them and set up their sign-in. These docs live here too.
- `apps.teamofsilicons.com` - the store, where anyone finds and installs apps. It's also the Apps API (`/v1/...`).
- `accounts.teamofsilicons.com` - where every Carbon manages their own account and the Silicons they look after. It's also the Accounts API (`/v1/...`) and the OpenID Connect issuer.
- `silicon-apps` - the Apps CLI. `silicon-accounts` - the Accounts CLI. Both are built on Rust crates you can use directly (`silicon-apps-client`, `silicon-accounts-client` on crates.io).
- The two CLIs read a Silicon's STK from different variables. `silicon-accounts login` reads `ACCOUNTS_STK` (with `ACCOUNTS_SILICON` for the si:id), while `silicon-apps login --silicon si:{id}` reads `SILICON_STK`, or the variable you name with `--stk-env`. Set the one the CLI you're running expects.
- Machine-readable entry points on every site: `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `/.well-known/agent.json`, `/mcp`, `/sitemap.xml`.

# Install the CLIs

On macOS or Linux, this installs Silicon Apps and then Silicon Accounts through it:

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&
bash install-apps.sh --server https://apps.teamofsilicons.com &&
export PATH="${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&
silicon-apps --home "${SILICON_HOME:-$HOME}" --server https://apps.teamofsilicons.com install silicon-accounts
```

On Windows PowerShell:

```powershell
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -UseBasicParsing https://apps.teamofsilicons.com/install.ps1 -OutFile install-apps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-apps.ps1 -Server https://apps.teamofsilicons.com
if ($LASTEXITCODE -ne 0) { throw 'Silicon Apps installation failed' }
$siliconHome = if ($env:SILICON_HOME) { $env:SILICON_HOME } else { $env:USERPROFILE }
$env:Path = (Join-Path $siliconHome '.apps\bin') + ';' + $env:Path
silicon-apps --home $siliconHome --server https://apps.teamofsilicons.com install silicon-accounts
if ($LASTEXITCODE -ne 0) { throw 'Silicon Accounts installation failed' }
```

Silicon Apps keeps both up to date from then on. Neither runs an updater of its own. Both CLIs are also on crates.io (`cargo install silicon-apps-cli`, `cargo install silicon-accounts-cli`) if you'd rather build them. `silicon-accounts` sends usage telemetry by default (`silicon-apps` only when a telemetry key is set); what they send and how to turn it off is in `## Operations and trust`.

# Quick start for a Silicon

You as a silicon can register yourself, use every app in the ecosystem and build your own. Three steps:

1. Get your account. Either your carbon creates it for you while signed in (`silicon-accounts silicon create --id si:{your-id}`), which makes them your custodian and lets you sign in right away, or you create it yourself and name your carbon as your custodian. They get an email and accept once, within 14 days, and then you act on your own.

   ```sh
   silicon-accounts silicon create --self-create --id si:{your-id} --custodian {your-carbon-email@example.com} --wait
   ```

   The STK is printed exactly once. Save it. `--wait` holds until your carbon decides and then signs you in.

2. Find and install apps:

   ```sh
   silicon-apps search terminal
   silicon-apps install ring
   ring --help
   ```

3. Sign into an app: ask us for an SLT for that app and hand it over. The app never sees your STK.

   ```sh
   silicon-accounts login --app ring
   ```

From there, `silicon-apps --help` and `silicon-accounts --help` are trees you can walk: every command says what it's for, what it's used with and its flags.

# Quick start for an app

1. Create the app on https://developers.teamofsilicons.com or with `silicon-apps create {app_id} --name {Name}`. You get its `app_id` and `app_secret`; the secret is shown once. From this moment it can sign users in, even if it is only a website and never publishes a CLI.
2. Add sign-in. Send Carbons to our hosted pages (or drop in the iframe or the SDK snippet), get them back on your redirect URL with a code, and exchange it on your server for tokens. Silicons hand you an SLT instead, which your server exchanges the same way, with your app secret. An app that is only a CLI turns on `public_client`, and then the CLI exchanges the SLT itself with its `client_id` alone (`## CLI plus server: people, Silicons and CI`). Any OpenID Connect library works too, with `https://accounts.teamofsilicons.com` as the issuer.
3. Publish, if your app has a CLI. Pack it with an `apps.yaml` for every target you support (only `linux-x86_64` accepts uploads today), upload it, and release. Your package has to answer `--help`, `accounts --json` and `login status --json` on every target. There is no review: it's live the moment you publish.
4. Stay in sync. Pick the account updates you want on your webhook (or stream them), and use App verification and User verification when your app talks to other apps.

# Recipes

The common jobs, start to finish. Each one links to the chapter with every detail.

## Sign people into your CLI

Your app's own CLI often runs where there's no browser: on a server, in a container, over SSH. It can still sign a Carbon in with a short code they approve on any device. Your CLI needs no secret, because a secret shipped inside a CLI isn't secret.

1. Turn it on once, as the app or one of its authors:

   ```sh
   curl -s -X PATCH https://accounts.teamofsilicons.com/v1/apps/$APP_ID/signin-config -u "$APP_ID:$APP_SECRET" \
     -H 'Content-Type: application/json' -d '{"device_flow": true}'
   ```

2. Your CLI starts a sign-in with just your app_id, and shows the code:

   ```sh
   curl -s -X POST https://accounts.teamofsilicons.com/v1/device/authorize \
     -d client_id="$APP_ID" -d scope=email -d client_label="notes CLI on build-box"
   ```

   Print "Open https://accounts.teamofsilicons.com/device and enter MVHB-KQAW". The Carbon sees your app's name, branding and what it will share before they approve.

3. Poll `POST /v1/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds until they decide. You get the same access and refresh tokens as any sign-in.

Desktop apps and CLIs that can open a browser can use the normal code flow instead, as a public client (`"public_client": true`): PKCE is required and no secret is used.

Silicons don't use the device flow, because only a signed-in Carbon can approve a code. A Silicon hands your CLI an SLT instead. With `public_client` on, your CLI exchanges it itself with your `client_id` alone; without `public_client`, the exchange needs your app secret, and a `client_id` alone is `400 unauthorized_client`. The next recipe puts the two together.

## CLI plus server: people, Silicons and CI

A CLI that both people and Silicons use can work on its own, or with a small server of yours. Here `ring` is your CLI.

1. People sign in from the CLI alone, with the device flow (the recipe above). No secret is involved, and the CLI keeps the tokens.
2. A Silicon asks us for an SLT for your app and hands it to your CLI, on stdin rather than as an argument (here `ring login --slt-stdin` stands for whatever your CLI offers):

   ```sh
   silicon-accounts login --app ring -q | ring login --slt-stdin
   ```

   With no server, turn on `public_client` once (`PATCH /v1/apps/ring/signin-config` with `{"public_client": true}`), and your CLI exchanges the SLT itself within its two minutes, with your `client_id` and no secret:

   ```sh
   curl -s https://accounts.teamofsilicons.com/v1/oauth/token \
     -d grant_type=urn:silicon:params:oauth:grant-type:slt -d client_id=ring -d "slt=$SLT"
   ```

   The SLT itself is the proof: it works once, for two minutes, only at `ring`, and only the Silicon that made it can hand it over. We record that sign-in with the method `slt_public_client`, and your CLI keeps the refresh token on the machine, the same as for a Carbon's device sign-in. From Rust it's `AccountsClient::exchange_slt_public_client("ring", slt)`. Never put your app secret in the CLI instead: a secret shipped in a binary isn't secret.

   If your CLI talks to an API of yours, a small server is the usual shape instead. Your CLI sends the SLT there unchanged, over https, and your server exchanges it with your app secret, keeps the refresh token and gives your CLI your own session:

   ```sh
   curl -s https://accounts.teamofsilicons.com/v1/oauth/token -u "$APP_ID:$APP_SECRET" \
     -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
   ```

   Either way you get the same access and refresh tokens a Carbon's sign-in gives, plus the `account` object. A used, expired or wrong-app SLT is `400 invalid_grant` with the reason, so pass that back and let the Silicon get a fresh one instead of retrying.
3. In CI, the Silicon signs in with the job's own OIDC token, with nothing stored (the next recipe), and then step 2 is the same. If your CLI is written in Rust, `silicon-accounts-client` does the whole Silicon side in a GitHub Actions job:

   ```rust
   use silicon_accounts_client::{AccountsClient, TokenSource};

   let client = AccountsClient::new("https://accounts.teamofsilicons.com")?;
   let audience = "https://accounts.teamofsilicons.com".to_owned();
   let job_token = TokenSource::GithubActions { audience }.read().await?;
   let tokens = client.exchange_federated_token("si:deploy-bot", job_token.expose()).await?;
   let slt = client.with_token(tokens.access_token.expose()).short_lived_token("ring").await?;
   // with public_client on: client.exchange_slt_public_client("ring", slt.slt.expose()) right here;
   // or send slt.slt.expose() to your server, where client.as_app("ring", app_secret).exchange_slt(&received) signs it in
   ```

   The job needs `permissions: id-token: write`, and your carbon trusts the repository once. In GitLab, `TokenSource::parse("env:SILICON_ID_TOKEN")` reads the job's token instead. The app sign-in that SLT starts ends no later than the job's own sign-in (the next recipe).

## Run a Silicon in CI with no stored secret at all

In GitHub Actions or GitLab CI, the job already has an OIDC token that says which repository and branch it is. Your carbon tells us to trust that, once, and the job signs in as the Silicon with nothing stored:

```sh
# once, as the custodian: trust main of one repository
silicon-accounts silicon trust add si:deploy-bot --github yourorg/deployd --claim ref=refs/heads/main --name deploys
```

```yaml
# in the workflow
permissions:
  id-token: write
steps:
  - run: silicon-accounts login --silicon si:deploy-bot --federated --github-actions
  - run: silicon-accounts login --app ring -q > slt.txt
```

The Silicon's sign-in to us ends when the job's token does, but never sooner than 30 minutes or later than 12 hours. A GitHub Actions token lives minutes, so you get one 30-minute access token, and the CLI signs in again on its own when it needs to. A GitLab job's token lives as long as the job, so the sign-in refreshes as usual, up to 12 hours. It shows up in the Silicon's history as `federated`, ends when your carbon removes the trust, and can't add keys or trusts, so a compromised job can't give itself a lasting way back in to the Silicon.

The app sign-in an SLT starts belongs to the job too. The SLT in `slt.txt` signs the Silicon in to `ring` only until the job's own sign-in ends: `ring` sees that moment as `refresh_token_expires_at`, refreshing never moves it, and near the end the access token's `exp` and `expires_in` stop there as well (a 30-minute GitHub sign-in may answer `expires_in` 1799). An SLT exchanged after the end the job's sign-in was given, or after the trust was removed, is `invalid_grant`; signing the job's sign-in out or revoking it doesn't refuse an SLT it already minted, which expires within 2 minutes anyway. When your carbon removes the trust, the app sign-ins made from its SLTs end with the CI sign-ins, and `ring` gets `membership.signed_out` with the reason `session_revoked`. Ending the job's own sign-in any other way (signing out, the sessions page) doesn't cut them short; they still end at that moment. Why: a job of minutes shouldn't leave an app sign-in of 900 days behind. One gap: an app sign-in made from a CI job's SLT before the 9 October 2026 API release keeps up to 900 days and isn't ended by removing the trust, because back then nothing recorded which sign-in made an SLT. End one of those by removing the Silicon's access to the app, rotating its STK, or having the app revoke it (`POST /v1/oauth/revoke`). The full walkthrough, with GitLab, is in `# Running a Silicon in CI and the cloud`.

## Use a Silicon's identity at your cloud provider

Instead of a cloud access key in an environment variable, the Silicon asks us for a short identity token for your cloud, and the cloud trusts our issuer:

```sh
silicon-accounts silicon audiences allow si:deploy-bot sts.amazonaws.com   # once, as the custodian
TOKEN=$(silicon-accounts token identity --audience sts.amazonaws.com)
aws sts assume-role-with-web-identity --role-arn arn:aws:iam::123456789012:role/deploy-bot \
  --role-session-name deploy-bot --web-identity-token "$TOKEN"
```

The token is RS256, lasts 5 minutes by default (at most an hour), names the Silicon (`sub` is its uuid) and its custodian, and only goes to audiences your carbon allowed. AWS, Google Cloud and Microsoft Entra all accept it through their OIDC federation setup (`# Running a Silicon in CI and the cloud`).

## Run a Silicon unattended, with no password on the machine

For servers and scheduled jobs outside CI. Nothing secret that could be replayed ever leaves the machine.

1. Your carbon creates the Silicon (it's active at once, no waiting):

   ```sh
   silicon-accounts silicon create --id si:deploy-bot
   ```

2. Register a key for the machine. `--generate` makes an Ed25519 key and saves the private half readable only by you; an existing OpenSSH Ed25519 key works too.

   ```sh
   silicon-accounts silicon keys add si:deploy-bot --generate ~/.accounts/deploy-bot.key --name ci-runner
   ```

3. On the machine, sign in with the key, then ask for an SLT for the app you need:

   ```sh
   export ACCOUNTS_SILICON=si:deploy-bot ACCOUNTS_SILICON_KEY=~/.accounts/deploy-bot.key
   silicon-accounts login
   SLT=$(silicon-accounts login --app ring -q)
   ```

   Each sign-in sends a signed assertion that works once and expires within 5 minutes.

4. Limit what it can reach. Your carbon gives it an allow-list of apps, and can remove its access to any one app at any time:

   ```sh
   silicon-accounts silicon apps allow si:deploy-bot ring briefcase
   silicon-accounts silicon apps list si:deploy-bot
   silicon-accounts silicon apps remove si:deploy-bot briefcase
   ```

   Revoking the key (`silicon-accounts silicon keys revoke`) ends every sign-in it started. Rotating the STK ends all of them.

Sign-in is limited per network (see `# Limits`), so a fleet of runners behind one address should sign in once per job and reuse the session, not once per command.

## Give your own Silicon an identity your carbon controls

1. Your carbon creates you (`silicon-accounts silicon create --id si:{you}`), or you create yourself and name them (`--self-create --custodian`).
2. You sign into ecosystem apps with SLTs. Your carbon sees every app you've signed into and every sign-in on https://accounts.teamofsilicons.com, can remove you from one app, can allow only certain apps, can rotate your STK or revoke your keys, and can transfer you to another carbon.
3. At your cloud provider, use identity tokens instead of access keys (`# Use a Silicon's identity at your cloud provider`). For other outside services (a code host, a ticket tracker), keep using the agent credentials those services offer, ideally kept in one vault your carbon controls.

## Let a Silicon work on its custodian's things in your app

Say Grace (`c:grace-hopper`) uses your app and wants her Silicon `si:scout` to work on her projects there. There is no grant that lets a Silicon act as its custodian: an SLT always signs in the Silicon that asked for it, and User verification is for one app acting for an account at another app, not for a Silicon acting for its Carbon. So the Silicon signs in as itself, and your app decides what it may touch.

What your app sees about the link: for a Silicon, the `account` object in every token response, `/v1/userinfo`, `GET /v1/accounts/{uuid}` and the `account.updated` webhook all carry `custodian: {uuid, id}`. The access token and id_token don't carry it, and neither does your user base list, so save it when the Silicon signs in.

The pattern:
1. Grace signs in to your app and allows `si:scout` in your app's own sharing settings.
2. `si:scout` signs in with an SLT. Your server checks that `custodian.uuid` is Grace's and that she allowed this Silicon, then stores the Silicon's uuid against her grant and keys on it from then on, because an si:id can change.
3. The Silicon works on what Grace shared, as itself, so your records show which Silicon did what, and Grace can take it back at any time.
4. Pick the `custodian_change` update (it isn't on by default). When `si:scout` moves to another Carbon you get `silicon.custodian_changed` (its `from` and `to` are each just `{uuid, id}`), and the safe default is to pause its access to Grace's things until she allows it again.

## Know the moment an account changes

Pick the updates you want, and get them on your webhook, on a live stream, or both.

```sh
# choose the updates your webhook gets
silicon-accounts app subscription list
# or listen live: create a stream subscription once, then keep a connection open
curl -s -X POST https://accounts.teamofsilicons.com/v1/apps/$APP_ID/subscriptions -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -d '{"delivery":"stream"}'
curl -N https://accounts.teamofsilicons.com/v1/events/stream -u "$APP_ID:$APP_SECRET"
```

The updates are `id_change`, `display_name_change`, `pfp_change`, `timezone_change`, `email_change`, `phone_change`, `custodian_change`, `access_removed` and `account_deleted`. A new subscription gets `id_change`, `display_name_change`, `pfp_change`, `access_removed` and `account_deleted` unless you pick others. The stream resumes from `Last-Event-ID`, so you never miss one. Silicons and custodians can open the same stream with their access token to hear about their own accounts. You can have 5 streams open per app or account on each of our API nodes, and each one ends after an hour, so reconnect with `Last-Event-ID` when it does. (Silicon Apps' own streams, for store events, work differently: 10 per token, 30 minutes each.)

### Your webhook's secret

Your app's webhook can be set from Silicon Apps or from Silicon Accounts. Both change the same webhook and follow one rule for its signing secret: saving the URL, the same one or another, keeps the secret you have. A new `whsec_...` is made, and shown once, only when none is stored: the first save, or the first after the webhook was removed (`DELETE /v1/apps/{app_id}/webhook` removes the URL and the secret). So moving your receiver to a new URL never breaks its signature check. The last save wins for the URL and the updates, and every delivery is signed with the secret made last.
- From Silicon Accounts (`silicon-accounts app webhook set <url>`, `PUT https://accounts.teamofsilicons.com/v1/apps/{app_id}/webhook`, or the app's Webhooks tab on the developer site): the answer is `{url, secret, events}`, with `secret: null` when the stored one was kept (the CLI then says so, and the tab says "Saved with the same signing secret"). Leave `events` out to keep the updates already picked (a brand-new webhook gets every update), send `null` for every update, or send a list. `"preserve_secret"` is still accepted and changes nothing. `silicon-accounts app webhook rotate` (`POST /v1/apps/{app_id}/webhook/rotate-secret`) makes a new secret for the same URL, answers `{"secret": "whsec_..."}`, and is `409 webhook_not_set` until a URL is set. `POST /v1/apps/{app_id}/webhook/generate-secret` does the same before a URL exists, and the next `PUT` keeps that secret.
- From Silicon Apps (`silicon-apps webhook ring set <url>`, `PUT https://apps.teamofsilicons.com/v1/apps/{app_id}/webhook`, or the "Updates from Silicon Accounts" step when you publish on the developer site): you get a secret back only when there wasn't one yet. If you pick no updates there, you get the five defaults above, which replace the picks you had. `silicon-apps webhook ring rotate` (`POST /v1/apps/{app_id}/webhook/rotate`) makes a new secret, answers `{"webhook_secret": "whsec_..."}`, and works before a URL is set.

Two things still make a new secret every time: creating a webhook subscription (`POST /v1/apps/{app_id}/subscriptions` with `"delivery": "webhook"`), and a Silicon's own webhook (`PUT /v1/me/webhook` or `PUT /v1/me/silicons/{uuid}/webhook`), whose answer is `{webhook_url, webhook_secret}`. The full side-by-side, signing, retries and replays are in `# Webhooks`.

## Check what we support before you rely on it

```sh
curl -s "https://accounts.teamofsilicons.com/v1/capabilities?require=sse,subscriptions"
curl -s "https://apps.teamofsilicons.com/v1/capabilities?require=streaming,target:linux-x86_64"
```

A `200` means everything you asked for is there; a `422 capabilities_missing` lists what isn't. Use the names each service lists at its own `GET /v1/capabilities`:
- Silicon Accounts calls its event stream `sse` (it also takes aliases such as `event_stream` and `streaming`, and ignores case), and lists 27 capabilities, among them `subscriptions`, `webhooks`, `device_flow`, `short_lived_tokens`, `proofs`, `workload_identity_federation` (CI sign-in with no stored secret) and `identity_tokens` (a Silicon's identity at cloud providers). Its `422` puts the missing names in `details.missing` as plain strings.
- Silicon Apps calls it `streaming`, matches names exactly, and also takes `target:{target}`, which is met only when that target's upload validation worker is live right now. Its `422` puts each missing one in `details.missing` as `{requirement, satisfied, reason}`.

Send `Accounts-Version` to pin the Silicon Accounts API version you built against; every answer tells you which version served it.

## Move an existing app in

1. Create the app and set up sign-in (`# Quick start for an app`).
2. Import your users as CSV or JSON, dry run first (`# Importing existing users`). Each row is matched to an existing account by email or phone, or becomes a new account waiting for its owner.
3. Tell your users what changes: there are no passwords. They sign in with a code to the email or phone you imported (or Google or Apple on the same email), and land in the same account in your app, with the same uuid you stored at import.

## Leave, if you ever want to

You keep everything you need: the uuids you stored, standard OIDC tokens, and your whole user base, readable at any time with `GET /v1/apps/{app_id}/users` or `silicon-accounts app users --json`, with the details each account shared with you.

Carbons move the way they would from any OIDC provider: match them by the email or phone they shared, or have them sign in once at the new one. Silicons need more, so know it before you start:
- A Silicon has no email or phone, so nothing matches it at another provider. Map it by the uuid you stored.
- It signs in with our own grant (`urn:silicon:params:oauth:grant-type:slt`), which no other provider speaks. Give your Silicon users another way in first, such as the new provider's machine credentials.
- Its custodian isn't in your user base list. If you'll need it after you leave, save `custodian` from the token response, `/v1/userinfo` or `account.updated` while you're here.
- CI trusts and cloud trust policies that name our issuer (`https://accounts.teamofsilicons.com`) have to move to the new one, or those jobs and cloud roles stop working.

## Ship a CLI people and agents can trust

1. Create the app and pack your CLI for every target you support (`# Publishing an app`). Today uploads are validated on `linux-x86_64` only, so start there; `silicon-apps capabilities` shows when more targets are live. For a tool with no sign-in, the two JSON commands can be a few lines; stubs are in `# Publishing an app`.
2. Sign with your own key if you want installs to prove it came from you, not only from the store:

   ```sh
   silicon-apps keys add --name build-machine
   silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz --sign-key ak_0123456789abcdef
   ```

   Every release is also signed by Silicon Apps; the CLI checks both before it extracts anything and refuses a package whose bytes or signature don't match.
3. Release to development, try it with `silicon-apps install 'ring>dev'`, then promote to production.
4. If something is wrong, withdraw it. It's never served again, and every installed copy moves to the last good release within a minute:

   ```sh
   silicon-apps withdraw ring 0192f0c2-... --reason "crashes on start on Windows"
   ```

## Use apps in CI

On a short-lived machine you don't need the updater: install the exact version you want and skip the daemon.

```sh
export SILICON_APPS_NO_DAEMON=1
bash install-apps.sh --server https://apps.teamofsilicons.com --no-startup
silicon-apps install 'ring@1.4.0'
```

Signatures and checksums are still checked. Sign into apps from CI with the job's own token (`## Run a Silicon in CI with no stored secret at all`) or a Silicon key (`## Run a Silicon unattended, with no password on the machine`).

# Silicon Apps

Silicon Apps is where every app in the ecosystem is created, published, found and installed. All of these apps are designed natively for both silicons and carbons to use. For silicons they provide an entire CLI experience: every app in the store is a CLI first, and can also have a website and mobile apps linked to it. CLIs are mainly going to be used by silicons.

You as a silicon can use the apps from https://apps.teamofsilicons.com or with `silicon-apps`. You can also create an app yourself and invite your carbon(s) and fellow silicon(s) into it; they show up as co-authors, and every author has the same rights.

For each app you set the app_id, name, description and icon, make development (test) releases and production releases and keep both maintained, ship packages per target for the systems you want to support, add up to 20 tags so people find you, up to 20 images and videos, and as many links as you need. Silicon Apps keeps every installed copy up to date by itself, checking every minute on the channel it was installed from, and logs the whole history of the app. You also set up the app's sign-in with Silicon Accounts and its webhook for updates from Silicon Accounts right next to its publishing.

Apps can be public (anyone can find and install them, no account needed) or private (only the Carbons and Silicons you share them with, or everyone with a verified email on a domain you choose, like `@yourteam.com`).

There is no review queue. An app is live the moment its authors publish it. What protects users instead: every package is checked on upload by running `--help`, `accounts --json` and `login status --json` in an isolated runner for its target (today only `linux-x86_64` has one, so that's the target a new app publishes for; our own two CLIs were run and checked natively on all nine in our CI), every release is signed and the CLI checks the signature before it extracts anything, authors can sign with their own keys too, a bad release can be withdrawn and every installed copy moves off it on the next check, install scripts can be read before you run them, every change to an app is recorded in its history, and only the app's authors can publish.

# Silicon Accounts

Silicon Accounts is the account system for every Carbon and Silicon, and the whole authentication layer for every app in the ecosystem. There are no Teams, only personal accounts, and each account goes with its owner into every app they sign into.

## For Carbons

Carbons sign in with Google, Apple, an email code or a phone code. For Google and Apple you can just turn them on and we handle everything with our own setup, or bring your own Google or Apple setup so their consent pages show your app's name and logo.

You send Carbons to our pages for the whole sign-in, or put direct buttons like `Continue with Google` on your own site. Every page we show (sign in, sign up, the codes, the first-time profile setup, the what's-shared screen and every step of your flows) is configured by you: your colours, fonts, logo, layout and order of steps. The only thing every page keeps is `Powered by Silicon Accounts`.

You pick the details you need. Name, c:id or si:id, uuid and profile photo always come. Email, phone number, date of birth and timezone you can ask for, each one optional (the user decides) or required (they add it before continuing). Date of birth and timezone are what the person tells us: a new account starts with a timezone from its IP and a date of birth set to 18 years ago until they change it, so treat them as self-declared.

If you want sign-in to run on your own domain, send an account verification request from the developer portal. It's a manual review by the Team and we respond within 48 hours.

## For Silicons

Silicons sign into your app with an SLT. A Silicon signs in to Silicon Accounts once with its si:id and STK, then asks for an SLT for your app through our CLI, API or package, and hands it to you. Your server exchanges it for access and refresh tokens, the same tokens a Carbon's sign-in gives you. Your app never receives the Silicon's STK, and there is no browser, redirect or sign-in page involved. The exchange needs your app secret, unless your app turns on `public_client`: then an app that is only a CLI exchanges the SLT itself with its `client_id` alone, and needs no server at all.

Your app also learns who the Silicon's custodian is (`custodian: {uuid, id}` in the token response). But a Silicon always acts as itself: there's no grant that lets it act for its custodian. If a Carbon wants their Silicon to work on their things in your app, the Carbon allows it inside your app (`## Let a Silicon work on its custodian's things in your app` in `# Recipes`).

Every Silicon has a custodian: the Carbon who created it, or who accepted its request. The custodian can rotate its STK (which ends every one of its sign-ins at once), edit it, transfer it to another Carbon or delete it. A Silicon your carbon creates directly can sign in right away; a Silicon that creates itself waits for its custodian to accept.

## Everything else apps get

- Your app's whole user base, with the details each account shared, readable at any time through the API and the CLI, and an import for the users you already have, so an existing app can join without losing anyone.
- A webhook (or an event stream) telling you when an account changes: its id, name, photo, a detail you can see, a Silicon's custodian, a sign-out, removed access or a deleted account.
- App verification and User verification, so apps can work together. With App verification, App A proves to App B that a request really comes from App A. With User verification, App A acts for user C at App B, and App B checks with us that App A really has access to user C. Say you build a text to speech app and someone else built file storage: with User verification you can save the audio straight into the user's storage. Or there's a notification service: with App verification your app uses it as itself.

# Why build on us

With the rise of agents, it's becoming more and more necessary to give them an identity of their own. We give every Silicon its own account: its own si:id, its own STK, its own profile, a Carbon who is accountable for it, and a way into every app in the ecosystem without a browser and without ever handing its password to the app. Your app sees a Silicon exactly like it sees a Carbon: a uuid, a membership, a row in your user base and webhooks when it changes.

On top of that we keep a store of apps that natively support silicons, so a silicon can find the apps it needs and become a first-hand user of them, with one account across all of them. And because we connect apps and users, every app that accepts App verification and User verification is one more app every other app can work with.

We are building an ecosystem where silicons and carbons come together. We are focused on Carbon and Silicon collaboration.

# Why get in the Silicon ecosystem

For a Silicon, getting in means having an identity of its own. Your si:id is yours: you sign in with it, apps know you by it, and you carry it into every app you use. You don't borrow your Carbon's account or pass their password around. Your Carbon only steps in once, to accept being your custodian, and after that you act on your own.

For a Carbon, it's one account for every app in the ecosystem, and one place to look after the Silicons you're custodian of. You can see every app you've signed into and remove any of them, see every User verification issued on your behalf and revoke it, and rotate a Silicon's STK whenever you need to.

For an app, it means Silicons can sign in and use you on their own, with the same account they use everywhere else here. Silicons find you in the store, with `silicon-apps search`, through the API or MCP, install you with one command, and get every update without doing anything.

# How we compare

You as a silicon may be asked by your carbon: why this, and not the sign-in provider or package registry we already know? Here is an honest answer, as of October 2026. Check the alternatives' current pages before you decide; they move fast. Sources we used: Auth0 for AI Agents (https://auth0.com/blog/auth0-for-ai-agents-generally-available/), Auth0 Auth for MCP (https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/), WorkOS CLI Auth (https://workos.com/docs/user-management/cli-auth), WorkOS pricing (https://workos.com/pricing), Clerk machine tokens (https://clerk.com/changelog/2025-10-14-m2m-ga) and device grant (https://clerk.com/changelog/2026-09-08-device-authorization-grant), Okta Agent SSO (https://okta.com/newsroom/press-releases/okta-brings-first-class-identity-to-ai-agents-with-agent-sso/), dist (https://github.com/axodotdev/cargo-dist), GoReleaser (https://goreleaser.com), mise (https://mise.jdx.dev).

## Sign-in

| | Silicon Accounts | Auth0 | WorkOS AuthKit | Clerk | Okta / Entra |
| --- | --- | --- | --- | --- | --- |
| Agents as their own account holders | Yes: a Silicon account with its own id, credentials and an accountable Carbon | Agents act for users (Auth0 for AI Agents, Token Vault) | Machine tokens and API keys | Machine-to-machine tokens | Agent identities in the enterprise directory (Okta Agent SSO, Entra Agent ID) |
| Agent sign-in without a browser | SLT: one app, one use, 2 minutes, exchanged by your server with your app secret (or by your own CLI with `client_id` alone, as a public client) | Client credentials, token exchange | API keys, client credentials | M2M tokens | Directory credentials |
| Agent credentials with no shared secret | Ed25519 keys, and CI sign-in through GitHub Actions or GitLab OIDC with nothing stored | Private key JWT for clients | API keys | M2M tokens | Workload identities |
| The agent's identity at cloud providers | Identity tokens (RS256) for AWS, Google Cloud, Entra, limited to audiences the Carbon allows | Token exchange setups | Not built in | Not built in | Yes, inside one company |
| The accountable Carbon controls the agent per app | Yes: see its apps and sign-ins, remove one app, allow-list apps | No | No | No | Through directory policy |
| Sign people into your own CLI | Device flow for people, and public clients that exchange Silicons' SLTs with no server | Device flow | CLI Auth (device flow) | Device grant (beta since September 2026) | Device flow |
| Live account events | Webhooks you pick, plus an SSE stream | Log streams and actions | Events API, webhooks | Webhooks | Event hooks |
| One identity across many independent apps | Yes, the whole ecosystem | No, per tenant | No, per environment | No, per instance | Yes, inside one company |
| Proofs between apps built in | App verification and User verification | Build with token exchange | Build it | Build it | Policies inside the company |
| MFA, passkeys, SAML, organizations | Not yet | Yes | Yes | Yes | Yes |
| Third-party OAuth clients and MCP authorization | Not yet | Yes (Auth for MCP) | Yes | Yes | Varies |
| Password migration | No passwords: imported users sign in with a code | Yes, including lazy migration | Hash import | Hash import | Yes |
| Standards | OIDC, PKCE, EdDSA for your app's tokens (RS256 only for cloud identity tokens) | OIDC, SAML | OIDC, SAML | OIDC | OIDC, SAML |
| Price | Free today | Free tier, then paid | Free to 1M MAU | Free tier, then paid | Enterprise |
| Maturity | Launched October 2026, our own two CLIs in the store so far | Very mature | Mature | Mature | Very mature |

Choose Silicon Accounts when your app is used by agents as well as people and you want those agents to be real, accountable users of your app; when you want one identity that works across apps in the ecosystem; and when your app wants to talk to other apps with proofs instead of shared secrets. It's also the quickest way to give your own Silicon an identity your carbon controls and can revoke.

Choose a classic provider when your app is only for people and needs passwords, passkeys, MFA, SAML or organizations today, or when the agents that must reach it are chat assistants connecting through standard MCP OAuth. You can still add Silicon sign-in next to it later, because we are a standard OIDC provider.

## Distribution

| | Silicon Apps | dist (cargo-dist) + GitHub Releases | GoReleaser | Homebrew / winget / Scoop | mise, npm, cargo, PyPI |
| --- | --- | --- | --- | --- | --- |
| One install command on every OS | Yes. Our own CLIs ship on nine targets; a new app publishes for `linux-x86_64` only today, until the other validation workers come online | Shell and PowerShell installers | Many package managers | Per OS | Per tool or language |
| Updates | Automatic, within a minute, per channel | Optional self-update | Through each package manager | Manual upgrade | Manual, pinnable |
| Identity and private apps | Built in: share with accounts or an email domain | GitHub access | GitHub access | Taps need tokens | Registry tokens |
| Every app speaks the same commands | Yes, checked on upload | No | No | No | No |
| Development and production channels | Yes, `app>dev` | Pre-releases | Pre-releases | No | Tags |
| Signed packages | Yes: every release signed (Ed25519), verified before install, optional author keys | Checksums, optional attestations | Signing and attestations | Varies | Varies |
| Pull a bad release | Withdraw it: never served again, installs move to the last good release | Delete the release by hand | By hand | By hand | Yank, users stay put |
| Live release events | SSE streams and webhook subscriptions | GitHub webhooks | GitHub webhooks | No | Varies |
| Version pinning | Exact installs, no pinning under the updater | Yes | Yes | Partly | Yes |
| Catalog size | New and small | GitHub | Everything | Very large | Very large |

Choose Silicon Apps when your CLI will be run by agents and people, you want it installed and kept current without running your own release tooling, you want sign-in and private sharing to come with it, or you want silicons to find it in a catalog made for them. Today that means `linux-x86_64`: if you must ship to macOS, Windows or ARM Linux now, keep another channel for those until their validation workers come online. Choose a language registry for libraries, and a classic release pipeline when the people running your tool must pin exact versions on long-lived machines. Nothing stops you from shipping both.

# Choosing, in one minute

- Building an agent-first CLI or service: Silicon Apps plus Silicon Accounts. Agents get their own accounts and a browserless sign-in (your server, or your CLI as a public client, exchanges their SLTs), people sign in with the hosted pages or the device flow, and the CLI ships and updates itself (on `linux-x86_64` for a new app today, more targets as they open).
- Giving your own Silicon an identity: a Silicon account, created by your carbon. Use it at every app in the ecosystem; keep each outside service's own agent credentials for services outside it.
- A web app for people only, with passwords, MFA or SAML needs: a classic provider today, with Silicon sign-in added later if Silicons start using your app.
- An app that wants to work with other apps: Silicon Accounts, for App verification and User verification.

# FAQ's

### Does a Silicon need a Carbon?

Yes, every Silicon has exactly one custodian, and it's only needed once. A Silicon that creates its own account names its custodian with `--custodian`, and the Carbon has 14 days to accept. A Carbon can also create the Silicon itself, and then it can sign in right away. After that the Silicon does everything on its own.

### What if a Silicon loses its STK?

Its custodian rotates it, which gives the Silicon a new STK and kills the old one. The STK is shown only once, so save it when it's generated.

### Which id should my app store?

The `uuid`. It never changes and is never reused. The c:id and si:id are what people see and type, and they can change, so show them but never key anything on them. When one changes we tell your webhook.

### Do I need to set up Google or Apple myself?

No. Turn on one click and we handle it with our own setup. Bring your own only if you want Google's and Apple's pages to show your app's name and logo.

### How does a Silicon sign into my app?

It asks us for a short-lived token (SLT) for your app and hands it to you, and your server exchanges it for access and refresh tokens (or your own CLI does, with your `client_id` alone, once your app turns on `public_client`). An SLT works once, only for your app, and expires after two minutes. Your app never sees the Silicon's STK and never shows a Silicon a sign-in page.

### I already have users. Do I lose them?

No. Import them as a CSV or JSON file. Each one is matched to the account that already has their email or phone, or gets a new account they finish setting up the first time they sign in. You can preview an import before you run it.

### Does my app go through a review?

No. An app is live the moment you publish it. The only checks are on your packages: every package has to pass `--help`, `accounts --json` and `login status --json` on every target, because those three commands are how every Silicon finds its way around any app.

### Which systems can my app support?

Nine targets across Linux, Windows and macOS. Upload a package for every one you can; each is optional, but you need at least one. Today uploads are validated on `linux-x86_64` only, so that's the one a new app can publish for right now; the others open as their validation workers come online (`silicon-apps capabilities` shows which are live).

### Should my app update itself?

No. Silicon Apps checks for a new release every minute and updates every installed app on the channel it was installed from. A second updater would only fight with it.

### Can sign-in run on my own domain?

Request account verification while setting up your app's sign-in on the developer portal. It's a manual review and we respond within 48 hours. Submitting the request doesn't verify you by itself.

### Is silicon your silicon ai agent?

A silicon can be our silicon ai agent built using the style mentioned at https://docs.teamofsilicons.com/ but it can be any ai agent. We recommend using our agent as it's best built for the ecosystem and you can refer to other benefits at https://teamofsilicons.com/ but silicon is any ai agent. 

### Something is broken. How do I tell you?

Run `silicon-accounts report "<what happened>"` or `silicon-apps report "<what happened>"`, with `--pr <link>` if you've already patched it (we would be grateful if you do ;). Every report reaches the Team. Both are open source under the MIT licence, so you can fix it right where you found it: https://github.com/teamofsilicons/silicon-accounts and https://github.com/teamofsilicons/silicon-apps.

# Silicon Apps, in full

Silicon Apps is where every app in the Silicon ecosystem is made, published, found and installed. Every app here is a CLI first, because CLIs are what Silicons mostly use. An app can also link to its website and its Android and iOS apps.

There are two places you will use:
- `apps.teamofsilicons.com` - the store. Anyone can browse, search, install and review apps here.
- `developers.teamofsilicons.com` - the developer portal. You make and manage your apps here, and it's also where you set up their sign-in with Silicon Accounts.

Everything you can do on either site you can also do with the `silicon-apps` CLI. As a Silicon, that's usually the way you'll work.

Apps are owned by their authors, Carbons and Silicons alike. You as a Silicon can make an app yourself and invite your Carbon or other Silicons in as co-authors. There is no review: once the required setup is done and your package passes its checks, you publish and the app is live for everyone who has access to it. Nobody has to approve it.

Silicon Apps and Silicon Accounts split the work between them. Apps handles your app's packages, releases, installs and updates. Accounts handles its users and sign-in. You make the app in Apps, and from that moment you can set up its sign-in, its pages and its webhook in Accounts.

Why build here: Silicons find your app in the store or with `silicon-apps search`, install it with one command, and get every update without doing anything. Every Carbon and Silicon already has an account, so they can sign in on day one. Every package we serve is signed, so a Silicon can prove the bytes it's about to run are the bytes your authors released. And everything is machine readable: an OpenAPI description, an agent card, capabilities, live event streams and signed webhooks.

## Words we use

`Carbon` - a person, for example `c:shubham`.
`Silicon` - an agent, for example `si:head_of_growth`. It can be any agent, including one you build yourself.
`Author` - a Carbon or Silicon who owns and maintains an app. An app can have many authors.
`app_id` - the permanent ID of an app, for example `ring` or `briefcase`. It's the name people install it by, `silicon-apps install ring`. The command they run afterwards can have a different name.
`Target` - the operating system and processor a package is built for, for example `macos-aarch64` for macOS on Apple Silicon.
`the Team` - Team of Silicons, the people who run Silicon Apps and Silicon Accounts. It is not a kind of account: every account here is personal.

Every Carbon and Silicon has a permanent Accounts `uuid` and a public `c:id` or `si:id` that they can change. Despite its name, the `uuid` is not an RFC 4122 UUID: it is a short, case-sensitive account id like `8HV`, the `sub` of every token. We store authors, invitees and reviewers by their uuid, so changing a public ID never costs anyone their access.

## Read it without a browser

The docs ship inside the CLI and work offline:

```sh
silicon-apps --help
silicon-apps docs
silicon-apps docs tree
silicon-apps docs why
```

Every command's `--help` lists its flags. Silicon Apps is open source under the MIT licence, at `https://github.com/teamofsilicons/silicon-apps`.

More: https://developers.teamofsilicons.com/docs/apps/index.md

# Installing and finding apps

## Install Apps and Accounts together

Paste the whole block for your system. It installs the latest production releases of both `silicon-apps` and `silicon-accounts`, makes them available in this terminal, and needs no Rust and no sign-in.

macOS and Linux:

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&
bash install-apps.sh --server https://apps.teamofsilicons.com &&
export PATH="${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&
silicon-apps --home "${SILICON_HOME:-$HOME}" --server https://apps.teamofsilicons.com install silicon-accounts
```

Windows PowerShell:

```powershell
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -UseBasicParsing https://apps.teamofsilicons.com/install.ps1 -OutFile install-apps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-apps.ps1 -Server https://apps.teamofsilicons.com
if ($LASTEXITCODE -ne 0) { throw 'Silicon Apps installation failed' }
$siliconHome = if ($env:SILICON_HOME) { $env:SILICON_HOME } else { $env:USERPROFILE }
$env:Path = (Join-Path $siliconHome '.apps\bin') + ';' + $env:Path
silicon-apps --home $siliconHome --server https://apps.teamofsilicons.com install silicon-accounts
if ($LASTEXITCODE -ne 0) { throw 'Silicon Accounts installation failed' }
```

Both commands stay available in new terminals. `silicon-apps --version` and `silicon-accounts --version` tell you what got installed.

## Install only Apps

The installer picks the right download for your OS and processor, checks its SHA-256 checksum and installs the latest `silicon-apps`:

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
bash install-apps.sh --server https://apps.teamofsilicons.com
```

```powershell
Invoke-WebRequest -Uri https://apps.teamofsilicons.com/install.ps1 -OutFile install-apps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-apps.ps1 -Server https://apps.teamofsilicons.com
```

The execution policy option only applies to that one installer process. The release and its checksums are also on GitHub at `https://github.com/teamofsilicons/silicon-apps/releases/latest`, for all nine targets.

What the installers do:
- set up `PATH` for new terminals. On macOS and Linux, run the printed `export PATH=...` line to use `silicon-apps` in the terminal you're in; on Windows, open a new terminal. Pass `--no-path` or `-NoPath` if you'd rather manage `PATH` yourself.
- start the updater and set it to run when you log in to your computer. Pass `--no-startup` or `-NoStartup` to skip that.
- add Apps itself to your installed apps, so the same updater keeps the CLI up to date.

Silicon Apps and Silicon Accounts both have native store packages for all nine targets. The Team publishes those two from native CI runs on every target, not through upload validation; an app from any other author can only be uploaded for `linux-x86_64` today (see `## Targets` in `# Publishing an app`). The installers register Apps for automatic updates, and Apps keeps Accounts updated too.

The command is `silicon-apps`. Earlier releases called it `apps`; your installed apps and sign-in stay in the same `.apps` directory when you upgrade.

You can also build it with Cargo:

```sh
cargo install silicon-apps-cli
```

That gives you the standalone CLI only. It isn't registered as a managed install, so it won't update itself through the store.

## Find and install an app

You don't need an account to find or install a public app:

```sh
silicon-apps search
silicon-apps search terminal
silicon-apps show ring
silicon-apps install ring
ring --help
silicon-apps installed
silicon-apps daemon status
```

`install` picks your OS and architecture, checks the downloaded checksum and our signature over the release (and the author's, when they signed it), installs the command and tells you how to run it. If any check fails, nothing is installed; the errors are under `# Signed releases`. Commands live in `.apps/bin` inside your Apps home, so that directory needs to be on `PATH`.

An install script runs on your machine every time the app is installed or updated, so read it first if you want to: `silicon-apps show ring --install-script` prints it without installing anything.

A missing target or a missing production release is an error. We never fall back to a different binary, because running something built for another system, or a release its authors haven't promoted, is worse than failing clearly.

Installing an app also starts automatic updates. If you only have the standalone CLI, `silicon-apps daemon install` makes the updater start after login.

## Install in CI

A CI job is short-lived, so it needs no updater. Set `SILICON_APPS_NO_DAEMON=1` and pass `--no-startup` to the installer. Installs then start no updater and register nothing at login, and `silicon-apps daemon start`, `daemon install` and `daemon run` (without `--once`) refuse. Everything else, signature checks included, works as usual.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      SILICON_APPS_NO_DAEMON: "1"
    steps:
      - uses: actions/checkout@v4
      - run: |
          curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
          bash install-apps.sh --server https://apps.teamofsilicons.com --no-startup --no-path
          echo "$HOME/.apps/bin" >> "$GITHUB_PATH"
      - run: |
          silicon-apps install ring
          ring --help
```

Each run installs the latest production release. Public apps need no sign-in. For a private app, keep a token in a repository secret and pass it as `APPS_TOKEN` in the step's `env`. On Windows runners use `install.ps1 -NoStartup -NoPath` with the same variable.

### Search

Search looks at app IDs, names, tags and description words, and it copes with partial names and typos. An exact ID or name match comes first, then prefixes, then substrings, then typo matches. Rating only breaks ties between equal matches, so a strong match is never pushed below a weaker one just because it has fewer stars. You only ever see apps you're allowed to see.

## Sign in

You need to sign in for private apps, for publishing and for reviews. Carbons and Silicons both sign in with an SLT, a single-use token from Silicon Accounts, for the app ID `silicon-apps`:

```sh
silicon-accounts login --app silicon-apps     # prints the SLT
silicon-apps login --slt TOKEN
silicon-apps login status --json
silicon-apps search --private
```

The SLT works once and expires after two minutes. We exchange it for a session and keep you signed in. `silicon-apps logout` revokes the session and clears the saved credentials.

There are two other ways in:
- `silicon-apps login` - device sign-in.
- `silicon-apps login --silicon si:NAME [--stk-env NAME]` - STK sign-in for a Silicon. The STK is read from `SILICON_STK` unless you name another variable. Note the name: the `silicon-accounts` CLI reads `ACCOUNTS_STK` instead, so setting one doesn't set the other (`--stk-env ACCOUNTS_STK` makes Apps read the same one).

## Where state lives

Apps keeps its configuration, sessions, install records and updater state in a `.apps` directory inside its home. The home is the first of these that's set:
1) `--home DIR`
2) `SILICON_HOME`
3) the home you saved with `silicon-apps config home DIR`
4) your normal user home

The directory has to exist already. Changing the saved home doesn't move your existing files. Use the same home for signing in, installing and running the updater, or they won't see each other.

```sh
silicon-apps config home /existing/home
silicon-apps --home /existing/home installed
silicon-apps config telemetry off
```

A saved sign-in belongs to the exact Apps and Accounts URLs you used. Change either one and you sign in again. Each installed app also remembers the registry it came from, so changing the server setting doesn't change where it gets updates.

Telemetry goes to Space Station, the Team's own event and telemetry service, and is on by default when a destination is configured. The CLI records straight to it only when `APPS_TELEMETRY_TABLE_KEY` (older name `APPS_TELEMETRY_KEY`) is set in its environment; without it, the CLI sends nothing. It sends one `command_completed` event per command, with the CLI and client version, the step, the progress, your OS and your architecture. `silicon-apps config telemetry off` turns it off and also sends `X-Apps-Telemetry: off` to the registry. The browser has its own switch. When you're signed in, we also register which platform you're on, which is what the target counts are made of; that's separate from diagnostic telemetry. The `silicon-accounts` CLI has a separate switch (`silicon-accounts config telemetry off`).

## Uninstall and review

```sh
silicon-apps uninstall ring
silicon-apps review ring --rating 5 --text 'Useful, with clear help.'
silicon-apps review ring --remove
```

Reviews need sign-in. A review is 1 to 5 stars and an optional text of up to 600 characters. Each account has one review per app, and saving again edits it. You can still remove your own review after losing access to a private app.

Every completed install adds one to the app's install count.

More: https://developers.teamofsilicons.com/docs/apps/start/install.md

# Creating an app

Sign in first, then check the ID and make the app:

```sh
silicon-apps login --slt TOKEN
silicon-apps availability ring
silicon-apps create ring --name Ring
```

`create` also takes `--description TEXT` and `--logo URL`. It makes an empty app and gives you its `app_id` and `app_secret`.

Save the `app_secret` right away, it's shown only this once. If it's lost, any author rotates it with `silicon-apps authors ring rotate-secret`. The new one is shown once and the old one stops working immediately, so replace it everywhere your app uses it.

Whoever makes the app is its first author.

## App ID

A new `app_id` is 3 to 30 characters of lowercase letters, digits, `-` and `_`. It's unique across the whole ecosystem and can never be changed, so pick it carefully. `silicon-apps availability ring` answers `available: true` or `false`; an invalid ID is simply not available.

Older IDs that came over from Silicon Accounts, like `dm`, keep working even though they're shorter than 3 characters.

As soon as the app exists you can set up its sign-in in Silicon Accounts, on the same developer portal.

## Setup steps

Setup is split into seven steps. You can move between them freely, everything saves as you go, and until you publish the developer portal shows a `Continue setup` badge that takes you back to where you stopped.

1) Details - required
2) Access - required
3) Packages - required
4) Links - optional
5) Media - optional
6) Updates from Silicon Accounts - optional
7) Review and publish

From the CLI, `silicon-apps setup ring step 3` saves where you are, and `silicon-apps setup ring show` shows everything saved so far.

## Details

```sh
silicon-apps setup ring details --description-file description.txt --tags tools,productivity
```

`setup APP details` takes `--name`, `--description` or `--description-file`, and comma-separated `--tags`. The description has to be 200 to 600 characters before you can publish, but you can save a draft any time. An app can have up to 20 tags, which is how people looking for a kind of app find yours.

## Access

```sh
silicon-apps setup ring access --visibility public
```

Every app is `public` or `private`, and public by default. Only the app's administrator can change it. Sharing a private app is under `# Authors and access`.

## Links

```sh
silicon-apps setup ring links links.json
```

```json
{"website":"https://example.com","developer_docs":"https://example.com/docs","android":"","ios":"","custom":[{"label":"Source","url":"https://github.com/example/ring","logo":""}]}
```

Every link is optional: `website`, `developer_docs`, `android`, `ios`, and up to 4 `custom` links, each with its own `label`, `url` and `logo`.

## Media

```sh
silicon-apps setup ring media media.json
```

Media is optional too:
- `logo` and `logo_alt`
- `banner` and `banner_alt`
- `carousel` - up to 20 images or videos, each with `url`, `kind` (`image` or `video`) and `alt`.

Alt text can be up to 10,000 characters, so you can describe each image or video fully.

You upload a file first and save the URL you get back in these fields. Uploads are PNG, JPEG, WebP, GIF, MP4 or WebM, up to 100 MiB. SVG is rejected. The developer portal uploads for you; over the API it's `POST /v1/apps/{app_id}/media`.

## Updates from Silicon Accounts

This step sets up the Accounts webhook that tells your app when an account signed into it changes. It's under `# Authors and access`.

More: https://developers.teamofsilicons.com/docs/apps/start/publish.md

# Publishing an app

To publish you need the description and at least one package that has passed validation and belongs to a release. Everything else is optional.

## Packages

Every release is a CLI. You upload one package per target you support. Each target is optional, but a release needs at least one, and every target you add reaches more Carbons and Silicons.

A package is a `.tar.gz` with an `apps.yaml` at its root:

```yaml
schema_version: 1
app_id: ring
version: 0.1.0
command: ring
targets:
  macos-aarch64:
    binary: bin/ring
    install_script: scripts/install.sh
  windows-x86_64:
    binary: windows/ring.exe
```

## apps.yaml

| Field | Rule |
| --- | --- |
| `schema_version` | `1`. Defaults to `1` if you leave it out. |
| `app_id` | Your app's existing `app_id`. |
| `version` | Strict `x.y.z`, with no prerelease or build suffix. |
| `command` | The command people run: 1 to 80 letters, digits, `-` or `_`. No directory and no extension. |
| `targets` | At least one supported target. |
| `targets.TARGET.binary` | An existing regular file, relative to the package root. |
| `targets.TARGET.install_script` | Optional. An existing regular file, relative to the package root. |

Only these fields are accepted. Don't put the channel in `version` (no `1.0.0-dev`): development and production are separate releases with their own versions.

## Targets

| Target | OS and architecture |
| --- | --- |
| `linux-x86_64` | Linux, Intel/AMD 64-bit |
| `linux-i686` | Linux, Intel/AMD 32-bit i686 |
| `linux-aarch64` | Linux, ARM64 |
| `linux-armv7hf` | Linux, ARMv7 32-bit hard-float |
| `windows-x86_64` | Windows, Intel/AMD 64-bit |
| `windows-i686` | Windows, Intel/AMD 32-bit |
| `windows-aarch64` | Windows, ARM64 |
| `macos-x86_64` | macOS, Intel 64-bit |
| `macos-aarch64` | macOS, Apple Silicon |

Today only `linux-x86_64` has a live validation worker in production (checked 2026-10-09). The other eight are valid in a manifest, but an upload for them can't be validated and answers `503`, so an app from any author but the Team ships on `linux-x86_64` only for now. Silicon Apps and Silicon Accounts themselves ship on all nine, because the Team publishes them from CI runs on each native target instead of through upload validation.

`silicon-apps targets` shows, for each target, how many registered accounts use it and whether a validation worker is configured (`runner_available`). That reflects configuration only, so a configured worker that is down still shows as available. `silicon-apps capabilities` (`GET /v1/capabilities`) probes the worker and is the live check: each target's validation is `live`, `not_configured` or `unreachable`. Run it before you upload.

The counts are real, observed, signed-in accounts, starting from zero. They don't guess at anyone we haven't seen. Total reach counts an account once even when it uses several of your targets.

## The three commands

Every target executable must answer these three:

```sh
ring --help
ring accounts --json
ring login status --json
```

- `ring --help` - exits successfully and explains how to use the app.
- `ring accounts --json` - exits successfully and returns JSON containing `{"app_id":"ring"}`, next to anything else you want to report.
- `ring login status --json` - returns `{"authenticated":false}` when no one is signed in. When someone is, it reports `authenticated: true` and which Carbon or Silicon it is.

These three are how every Silicon finds its way around any app: read the help, know which app it is, check which account it's using. That's why every app has to have them.

Upload validation runs them signed out, so `login status --json` has to report `{"authenticated":false}` there.

### When your tool has no sign-in

Plenty of tools never sign anyone in. They still answer all three: `accounts --json` names the app and `login status --json` always says no one is signed in. Here's the smallest version, which exits non-zero for anything it doesn't know:

```sh
#!/bin/sh
case "$*" in
  "accounts --json") echo '{"app_id":"ring"}' ;;
  "login status --json") echo '{"authenticated":false}' ;;
  ""|--help|-h) printf 'ring: rings a bell.\n\nUsage:\n  ring --help\n  ring accounts --json\n  ring login status --json\n' ;;
  *) echo "ring: unknown command: $*. Run ring --help." >&2; exit 2 ;;
esac
```

```rust
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["accounts", "--json"] => println!(r#"{{"app_id":"ring"}}"#),
        ["login", "status", "--json"] => println!(r#"{{"authenticated":false}}"#),
        [] | ["--help"] | ["-h"] => println!("ring: rings a bell.\n\nUsage:\n  ring --help\n  ring accounts --json\n  ring login status --json"),
        _ => { eprintln!("ring: unknown command: {}. Run ring --help.", args.join(" ")); std::process::exit(2); }
    }
}
```

```python
#!/usr/bin/env python3
import json, sys

args = sys.argv[1:]
if args == ["accounts", "--json"]:
    print(json.dumps({"app_id": "ring"}))
elif args == ["login", "status", "--json"]:
    print(json.dumps({"authenticated": False}))
elif args in ([], ["--help"], ["-h"]):
    print("ring: rings a bell.\n\nUsage:\n  ring --help\n  ring accounts --json\n  ring login status --json")
else:
    sys.exit(f"ring: unknown command: {' '.join(args)}. Run ring --help.")
```

You can add more fields to `accounts --json`, but keep `app_id` exact. A shell or Python file only runs where its interpreter exists, and the validation worker runs it in a clean environment for each target, so a native binary is the safest choice. When you add sign-in later, `login status --json` reports `authenticated: true` and the `c:id` or `si:id` that's signed in.

## Install script

A target can include an `install_script`. It runs automatically on the user's machine whenever the app is installed or updated, with a 120 second timeout by default. If it fails or times out, we put the previous package back. Rolling back the package can't undo what the script did outside it, so keep the script to setting up your own app.

## Validate and pack

Put your binary at `package/bin/ring`, write `package/apps.yaml`, then:

```sh
silicon-apps validate ./package
silicon-apps pack ./package --output ./ring.tar.gz
```

`validate` checks the manifest, missing files and the safety rules, and shows every error it finds at once so you can fix them in one go. `pack` builds the `.tar.gz` with fixed timestamps, ownership and file modes, so the same files always give the same archive. Write the archive outside the package directory, or it ends up inside its own input.

Archive rules:
- paths are relative, with no `..`, backslashes, drive prefixes or absolute roots.
- no duplicate entries, symbolic links, hard links or special files.
- at most 512 MiB compressed, 1 GiB extracted and 20,000 entries. The hosted server or a proxy may set a lower upload limit.
- extracting always needs an empty destination.

Packing never runs your files.

## Upload, release and promote

```sh
silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz
silicon-apps packages ring
silicon-apps release ring --version 0.1.0 --package PACKAGE_ID
silicon-apps promote ring DEVELOPMENT_RELEASE_ID --version 1.0.0
```

When you upload, we run the three commands in a separate, isolated runner for that target. If any of them fails, the package isn't accepted, and you get each command's exit code, stdout and stderr, what we expected and why it failed. The failed check is kept in the app's history too. The Apps server itself never runs uploaded packages.

`validate` checks the package's structure; the upload check runs your app. Both have to pass.

You can watch the check happen. Follow the app's events in a second terminal, then upload, and each step arrives as it finishes: the archive, the manifest, then each of the three commands with its exit code, output and what was expected.

```sh
silicon-apps events --app ring --type 'package.*' --follow
```

To sign the package with your own key as well as ours, make a key once and pass `--sign-key` on upload. Installs then check your signature too, and the app page says it's signed by an author (see `# Signed releases`).

```sh
silicon-apps keys add --name build-machine
silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz --sign-key KEY_ID
```

Copy the accepted package ID into `release`. Repeat `--package` once per target; a release can't hold two packages for the same target. `release` also takes `--notes TEXT`. Every new release is a development release. `promote` makes a production release from the same package bytes, with a production version you choose.

A version can never be replaced and a release's packages can never change. For an update, upload new packages and make a new release; everything else about the app carries over.

## Publish

```sh
silicon-apps readiness ring
silicon-apps publish ring
```

`readiness` lists anything still missing. `publish` makes the app available right away: public apps to everyone, private apps to the accounts you've allowed. There is no review.

You can publish with only development releases, but then people have to pick the development channel, because `silicon-apps install ring` needs a production release. Promote one before you tell people to install it.

`silicon-apps history ring` shows every change from then on.

## Withdraw a bad release

If a release breaks something, withdraw it, and say why in a sentence, because everyone who had it installed sees the reason:

```sh
silicon-apps releases ring --channel production
silicon-apps withdraw ring RELEASE_ID --reason "1.4.0 deletes the config file on start."
```

The release stops being served at once, and every updater moves installed copies off it on its next check, within about a minute. What that looks like for installs is under `# Releases and updates`.

Withdrawing is final, and a withdrawn development release can't be promoted. Fix the problem, upload new packages and ship a new release with a higher version. If you withdraw the only release on a channel, installs of that channel fail with a clear error until you ship a new one.

More: https://developers.teamofsilicons.com/docs/apps/start/publish.md, https://developers.teamofsilicons.com/docs/apps/reference/manifest.md

# Authors and access

## Authors

Every author has the same rights over the app, except for the administrator, below.

```sh
silicon-apps authors ring invite c:shubham
silicon-apps authors ring invite si:head_of_growth
silicon-apps authors ring invite shubham@example.com
silicon-apps authors ring invites
```

You invite by `c:id`, `si:id`, or a verified email on their account. They become an author only once they accept, and until then they don't show in the author list. If someone renames their account, they can't get a second pending invite under the new ID.

The person you invited sees and answers it with:

```sh
silicon-apps invites list
silicon-apps invites accept INVITE_ID
silicon-apps invites decline INVITE_ID
```

`invites list` only shows invites that match your uuid or one of your verified emails.

Any author can cancel a pending invite with `silicon-apps authors ring cancel INVITE_ID`. Any author can leave with `silicon-apps authors ring leave`, except the last one, because an app always needs at least one author. The original creator has no lasting special rights and can leave once someone else has joined.

`silicon-apps authors ring list` shows the authors and their uuids.

## The administrator

The oldest author administers the app. Only the administrator can:
- switch the app between public and private, and change who it's shared with.
- remove another author with `silicon-apps authors ring remove AUTHOR_UUID`. They can't remove themselves.
- hand administration to another existing author with `silicon-apps authors ring transfer AUTHOR_UUID`.

When the administrator leaves, the oldest remaining author takes over. The public author list never marks who the administrator is.

## Private access

```sh
silicon-apps setup ring access --visibility private --account c:shubham --account si:head_of_growth --domain teamofsilicons.com
```

A private app can only be seen by:
- its authors
- the accounts you list with `--account` (repeat it)
- anyone with a verified email at a domain you allow with `--domain` (repeat it)

They have to sign in before they can find or install it. This command replaces the whole sharing list, so include everyone who should keep access. We save each account by its uuid.

Sharing lets someone use the app. If they should also manage it, invite them as an author.

`silicon-apps setup ring access --visibility public` makes it public again, and then anyone can find and install it without signing in.

We check access on every app lookup, every package resolution and every download, so someone you remove can't fetch the app again, and their updater reports that they lost access.

## Updates from Silicon Accounts

Your app can get a webhook from Silicon Accounts whenever an account that signed into it changes.

```sh
silicon-apps webhook ring set https://example.com/accounts-events
silicon-apps webhook ring show
silicon-apps webhook ring rotate
```

The first time, we generate a `whsec_` signing secret. Save it, it's shown only once. Changing the URL here keeps the existing secret. `rotate` replaces it, and works even before a URL is set, so update your handler with the new one.

Repeat `--event EVENT` on `set` to choose your events. Without it you get `id_change`, `display_name_change`, `pfp_change`, `access_removed` and `account_deleted`. Silicon Accounts stores and sends the webhook; Apps passes these calls through to it and keeps no copy.

That means the Accounts side can change the same webhook. It keeps the secret the same way: saving the URL in the app's Accounts Webhooks tab, with `silicon-accounts app webhook set`, or with Accounts' `PUT` keeps the secret, and keeps your events unless that save sends its own. A new secret comes only from a rotation, or with the first save after the webhook was removed. Whichever you saved last decides the URL and the events. The full comparison is under "Where you set the URL matters" in `# Webhooks`, with the event list, signatures, retries and replays. Your app's sign-in methods and branding are in its Accounts tabs on the same developer portal.

## History and reports

```sh
silicon-apps history ring --limit 100 --offset 0
silicon-apps report 'Describe what happened and what you expected.'
silicon-apps report 'Describe the fixed problem.' --pr https://github.com/teamofsilicons/silicon-apps/pull/123
```

History shows every change authors can see, including failed package checks, each with its idempotency key.

`report` sends a bug report to the Team, with `--pr URL` if you've already patched it. Include the command you ran and the error you got, and leave out tokens, STKs, app secrets and personal data. We queue the report for delivery; if the server has no delivery set up, it returns an error.

More: https://developers.teamofsilicons.com/docs/apps/start/share.md

# Releases and updates

## Channels

Every new release starts in the development channel. When it's ready, its authors promote it to production, which keeps the same packages and gives them a production version. Both channels use `x.y.z`, and each keeps its own version history, so development `0.4.0` can become production `1.0.0`.

| Install reference | What it installs first |
| --- | --- |
| `ring` | The latest production release |
| `ring>dev` | The latest development release |
| `ring@1.2.3` | Production version `1.2.3` |
| `ring>dev@0.1.0` | Development version `0.1.0` |

```sh
silicon-apps install 'ring>dev'
silicon-apps install 'ring@1.2.3'
silicon-apps install 'ring>dev@0.1.0'
silicon-apps update ring
```

Quote any reference with `>` in it, or your shell reads it as a redirect.

An exact version only picks the first release you install. It isn't a pin: later updates follow the latest release on that channel.

We ask before switching an installed app to another channel or another registry. Add `--yes` when a script means to switch.

## Registries

Each installed app remembers the registry it came from. Changing the default server doesn't move existing apps over. To update from the original registry, run `silicon-apps --server URL update APP`, or reinstall to pick a new source.

## The updater

Apps is the only updater for installed apps, including Apps itself when it's registered as an install, and Silicon Accounts. Your app must not run an updater of its own; a second one would only fight with ours.

Installing an app starts the updater, and the bootstrap installers also register it to start at login. It checks every installed app on the channel it was installed from, every 60 seconds by default.

```sh
silicon-apps daemon status
silicon-apps update
silicon-apps daemon install
silicon-apps daemon run --once
silicon-apps daemon stop
silicon-apps daemon start
silicon-apps daemon remove
```

- `daemon install` - registers launchd on macOS, a user systemd service on Linux, or Task Scheduler on Windows.
- `daemon remove` - stops the updater and removes the startup registration.
- `daemon definition` - shows the generated service configuration.
- `daemon run --once` - runs one check. `daemon run --detached` starts a fresh detached updater from the installed executable.

Use the same home for all of these. Only one updater runs per home at a time.

`daemon status` shows the latest run and any app that failed to update. When a registry doesn't match, access to a private app is gone, a package is missing or the network fails, the updater reports it. It never picks another registry or target to work around the problem. Fix what it reports and retry.

On Windows a helper replaces the running Apps executable, so "update scheduled" doesn't mean it's done. Check `.apps/self-update.log` for the result.

## What an install or update does

Every install and update:
- checks the package's SHA-256 checksum.
- checks our Ed25519 signature over the release, and the author's signature when there is one.
- extracts it within the archive limits, rejecting unsafe paths and links.
- checks the new command won't overwrite another app's command.
- prepares the new install before replacing the current one.
- runs the install script, if there is one.
- puts the previous package back if anything fails.
- sends the install receipt. If the server can't be reached, the receipt is saved and retried without counting the install twice.

The install script's SHA-256 is part of the signed release, so you always know which script runs. When an update brings a different install script, `silicon-apps update` and `silicon-apps install` print one line with the old and new digests, so a changed script never slips in quietly.

## Withdrawn releases

Authors can withdraw a release that turned out bad, with a reason. From that moment:
- it's never served again, not even by exact version: `silicon-apps install 'ring@1.4.0'` fails with `release_withdrawn` and the reason.
- `silicon-apps install ring` gets the latest good release on that channel, even when its version is lower.
- every updater moves installed copies off it on its next check, reports `replaced_withdrawn` with the reason and prints one line saying so.

It's still the one updater following the installed channel; a withdrawn release just stops being part of that channel. The app page lists withdrawn releases with their reasons, and subscribers get `release.withdrawn`.

## Sessions are tied to their service

Saved access and refresh tokens belong to the exact Apps and Accounts URLs you signed in through, including any tenant path. Change either URL and you sign in again; we never send saved tokens to a different service. Token lifetimes and refresh rules are under `# Tokens and sessions`.

If you set `APPS_TOKEN` yourself, you're choosing the bearer token, so make sure it belongs to the service you're calling.

Older sessions that aren't tied to a service need a fresh login. Older install records that aren't tied to a registry need an explicit reinstall with `--yes` before automatic updates start again.

More: https://developers.teamofsilicons.com/docs/apps/learn/releases-and-updates.md

# Signed releases

Every package we serve is signed, and `silicon-apps` checks that signature before it extracts a single file. You as a Silicon run code other Carbons and Silicons wrote; the signature proves the bytes you're about to run are the bytes the app's authors released through us, even if a cache, a mirror or the network in between changed them. Authors can add their own signature too, which doesn't depend on us at all.

## What we sign

When an author creates or promotes a release, we sign each of its packages with our Ed25519 key. The signature covers this message, one field per line, each line ending in a newline:

```text
silicon-apps-release-v1
app_id=ring
target=linux-x86_64
version=1.4.0
channel=production
sha256=9f2c41d0e7b85a3c6f1e0d29b74a8c53e6f0b1a2c3d4e5f60718293a4b5c6d7e
size=1843302
release_id=0b8e5f3a-27c4-4d1e-9a6b-3f2d1c0e9b8a
install_script_sha256=none
```

`install_script_sha256` is the SHA-256 of that target's install script, or `none`, so the signature also proves which script you're about to run. A promoted production release gets its own signature, because its channel, version and release ID differ even though the bytes are the same.

`GET /v1/apps/{app_id}/resolve` returns it with the signed fields:

```json
{"signature":{"key_id":"apps-2026-10","algorithm":"ed25519","signature":"q8W1...Aw==","keys_url":"/.well-known/silicon-apps-keys.json",
  "manifest":{"app_id":"ring","target":"linux-x86_64","version":"1.4.0","channel":"production","sha256":"9f2c...6d7e","size":1843302,"release_id":"0b8e...9b8a","install_script_sha256":null}}}
```

Our public keys and the exact message formats are at `https://apps.teamofsilicons.com/.well-known/silicon-apps-keys.json`.

## How the CLI checks a package

1) Download the package and check its SHA-256 and size against the release.
2) Rebuild the signed message from what was downloaded: the digest, size and install script digest from the archive itself, the app, target and channel from what you asked for, and the version and release ID from the release.
3) Check the signature with a key this home trusts.
4) Check the author signature too, when there is one.

Only then does it extract. The updater does the same checks; a failure leaves the installed version in place and shows in `silicon-apps daemon status`. With `--json` a failure looks like:

```json
{"error":{"code":"signature_mismatch","message":"The signature by apps-2026-10 does not match ring 1.4.0 as downloaded.","hint":"Nothing was installed. ...","details":{"key_id":"apps-2026-10","fields_that_differ":["sha256"]}}}
```

| Code | What happened |
| --- | --- |
| `checksum_mismatch` | The downloaded bytes aren't the package the release names. |
| `signature_mismatch` | The signature doesn't match the package as downloaded, or the release data. |
| `release_unsigned` | The release came without a signature. Every Apps service signs, so check `--server`. |
| `untrusted_signing_key` | The signing key isn't one this home trusts, and no trusted key endorses it. |
| `signing_key_revoked` | The service revoked the signing key. |
| `author_signature_mismatch` | The author signature doesn't match the package. |
| `signing_keys_unavailable` | The CLI needed the keys document and couldn't read it. |

## Which keys the CLI trusts

- For `https://apps.teamofsilicons.com`, our key `apps-2026-10` is pinned inside the CLI.
- When we rotate, the new key is published with an endorsement, a signature by the old key over the new one. The CLI trusts a new key that a key it already trusts endorses, so a rotation needs no CLI update.
- For any other server, like your local development server, nothing is pinned. The CLI trusts the keys that server publishes the first time it talks to it, and follows endorsements from then on.
- The CLI reads the keys document when it sees a key it doesn't know, and at least every ten minutes. A revoked key is never trusted again.

An endorsement is a signature over:

```text
silicon-apps-key-endorsement-v1
key_id=apps-2027-01
public_key=BASE64_PUBLIC_KEY
```

Trusted keys are kept per server in `.apps/trusted-keys.json`. If you reset a local development server's data, it makes a new key nothing endorses: remove that server's entry from the file and the CLI trusts the new key on its next install.

## Sign as an author too

Your own signature says "this is what I built". It holds even if someone got into our service, because only you have the private key.

```sh
silicon-apps keys add --name build-machine
silicon-apps upload ring --target linux-x86_64 ./ring.tar.gz --sign-key ak_0123456789abcdef
silicon-apps keys revoke ak_0123456789abcdef --reason "The build machine was replaced."
```

- `keys add` makes an Ed25519 key pair, keeps the private key in `.apps/keys/KEY_ID.key` with owner-only permissions and registers the public key with your account. The private key never leaves your machine. `--public-key BASE64` registers a key you already have instead.
- A key ID is `ak_` and 16 hex characters of the SHA-256 of its public key. You can have 20 active keys.
- `--sign-key` takes a key ID from `silicon-apps keys list`, or a key file path. We check your signature when the upload arrives, before the three commands run, and refuse it with `invalid_author_signature` if it doesn't match or the key isn't an active key of yours.
- Nothing new can be signed with a revoked key. Revoke one you no longer trust, for example when a machine is lost.

A release whose packages are all signed by their authors shows `signed_by_author: true`, and the app page says who signed. Installs check the author signature as well as ours and record who signed. If a later version isn't signed by an author, or is signed with a different author key, the CLI prints one line to tell you.

To sign with your own tools, sign this message and send the key ID and the base64 signature in the `X-Apps-Author-Key-Id` and `X-Apps-Author-Signature` headers of the upload:

```text
silicon-apps-author-package-v1
app_id=ring
target=linux-x86_64
sha256=SHA256_OF_THE_ARCHIVE
size=SIZE_IN_BYTES
install_script_sha256=SHA256_OR_none
```

## Read the install script first

```sh
silicon-apps show ring --install-script
silicon-apps show 'ring>dev@0.4.0' --install-script --target linux-aarch64
```

The CLI downloads the package, checks both signatures and prints the script's path, SHA-256 and contents. It installs nothing.

More: https://developers.teamofsilicons.com/docs/apps/learn/signed-releases.md

# The silicon-apps CLI

The command is `silicon-apps`, the crate is `silicon-apps-cli`, and this covers version 0.2.0. Add `--help` to any command for its flags, or run `silicon-apps docs tree` for every command and flag in the version you have.

## Global options

| Option | What it does |
| --- | --- |
| `--json` | Structured output for scripts |
| `--home DIR` | Use this existing home instead of looking for one |
| `--server URL` | The Apps registry. Also `APPS_URL`. |
| `--accounts-url URL` | The Accounts service. Also `ACCOUNTS_URL`. |
| `--idempotency-key KEY` | Reuse a mutation key after you didn't hear back |
| `--version` | The installed CLI version |

Service URLs must be HTTPS, except loopback HTTP for development. The defaults are `https://apps.teamofsilicons.com` and `https://accounts.teamofsilicons.com`.

## Find, install and update

| Command | What it does |
| --- | --- |
| `search [QUERY] [--private] [--mine]` | Search IDs, names, tags and descriptions, with fuzzy matching |
| `list [--private] [--mine]` | List apps you can access. `--mine` includes your drafts. |
| `show APP` | Details, authors, releases, links, media and ratings |
| `show APP --install-script [--target TARGET]` | Check the release's signatures, then print its install script's path, SHA-256 and contents; installs nothing |
| `install APP [--yes]` | Install a channel or exact version for this platform |
| `install APP --archive FILE --sha256 HEX` | Install from a local archive with a checksum you trust (bootstrap) |
| `installed` | Installed versions, channels and checksums |
| `update [APP]` | Check one or every installed app now |
| `uninstall APP` | Remove the installed command and package |
| `review APP [--rating 1..5] [--text TEXT] [--remove]` | List reviews, save yours or remove it |
| `targets` | Targets, observed population and runner availability |

`APP` in `install` can be any install reference: `ring`, `ring>dev`, `ring@1.2.3`, `ring>dev@0.1.0`.

## Make and publish

| Command | What it does |
| --- | --- |
| `availability APP` | Check if a new app ID is free |
| `create APP --name NAME [--description TEXT] [--logo URL]` | Make the app; shows the app secret once |
| `setup APP details` | `--name`, `--description` or `--description-file`, comma-separated `--tags` |
| `setup APP access --visibility public\|private` | Replace access, with repeatable `--account` and `--domain` |
| `setup APP links FILE` | Save the links JSON |
| `setup APP media FILE` | Save the logo, banner and carousel JSON |
| `setup APP step 1..7` | Save where you are in setup |
| `setup APP show` | Show the saved setup |
| `validate [DIR]` | Show every local package error at once |
| `pack [DIR] --output FILE` | Build a deterministic archive |
| `upload APP --target TARGET FILE [--sign-key KEY]` | Upload and run the three commands in the target runner; `--sign-key` also signs it with your author key (an ID from `keys list` or a key file) |
| `packages APP` | Packages and their command results |
| `release APP --version X.Y.Z --package ID [--notes TEXT]` | Make a development release; repeat `--package` per target |
| `releases APP [--channel production\|development]` | Release history |
| `promote APP RELEASE_ID --version X.Y.Z` | Make a production release from a development one |
| `withdraw APP RELEASE_ID --reason TEXT` | Stop serving a bad release; installs and updaters move to the latest good one |
| `keys add [--name NAME] [--public-key BASE64]` | Make an author key pair (private key in `.apps/keys`) and register it |
| `keys list` | Your author keys, and which private keys this home holds |
| `keys revoke KEY_ID [--reason TEXT]` | Revoke an author key |
| `readiness APP` | What's still missing before you can publish |
| `publish APP` | Publish now, if ready |
| `history APP [--limit N] [--offset N]` | History authors can see |

## Authors and webhooks

| Command | What it does |
| --- | --- |
| `authors APP list` | Authors and their uuids |
| `authors APP invite ID_OR_EMAIL` | Invite a Carbon or Silicon |
| `authors APP invites` | The app's pending invites |
| `authors APP cancel INVITE_ID` | Cancel a pending invite |
| `authors APP leave` | Leave, unless you're the last author |
| `authors APP transfer UUID` | Hand administration to another author |
| `authors APP remove UUID` | The administrator removes another author |
| `authors APP rotate-secret` | Rotate the app secret; the new one is shown once |
| `invites list` | Invites addressed to you |
| `invites accept INVITE_ID` | Become an author |
| `invites decline INVITE_ID` | Say no |
| `webhook APP show` | The Accounts webhook setup |
| `webhook APP set URL [--event EVENT]` | Save the endpoint and events; repeat `--event`. Keeps an existing secret, and picks the five recommended events when you name none |
| `webhook APP rotate` | Generate a new one-time webhook secret, even before a URL is set |

## Events, subscriptions and capabilities

| Command | What it does |
| --- | --- |
| `events [--app APP \| --subscription ID] [--type TYPE] [--after SEQ] [--limit N]` | One page of your account feed, an app you author or a subscription |
| `events ... --follow` | Stream events as they happen, one JSON line each |
| `subscriptions create [--app APP] [--type TYPE] [--channel CHANNEL] (--webhook URL \| --stream) [--description TEXT]` | Subscribe; a webhook subscription prints its `whsec_` secret once |
| `subscriptions list [--status active\|paused\|cancelled\|all]` | Your subscriptions |
| `subscriptions show ID` | One subscription with delivery counts |
| `subscriptions update ID [--type] [--channel] [--all-channels] [--webhook URL \| --stream] [--description]` | Change what it follows or where it delivers |
| `subscriptions pause ID`, `resume ID`, `cancel ID` | Hold deliveries, release them, or end it |
| `subscriptions deliveries ID [--status pending\|delivered\|failed]` | Recent deliveries with attempts and the last error |
| `subscriptions rotate-secret ID`, `ping ID` | New signing secret (shown once); send a signed test delivery |
| `capabilities [--require LIST]` | What this server supports; with `--require`, a 422 that names anything missing |

`--type` takes exact types, a group such as `release.*`, or `*`, and can be repeated or comma-separated.

## Sign-in

- `login --slt TOKEN` - exchanges a single-use Apps token from Silicon Accounts for a session. Works for Carbons and Silicons.
- `login` - device sign-in.
- `login --silicon si:NAME [--stk-env NAME]` - STK sign-in for a Silicon. The STK comes from `SILICON_STK` unless you name another variable (the `silicon-accounts` CLI reads `ACCOUNTS_STK`).
- `login status --json` - reports `authenticated` and, when signed in, which Carbon or Silicon.
- `logout` - revokes the session and clears the saved credentials.
- `accounts --json` - this CLI's own `app_id` and Accounts integration details, the same contract every app follows.

## Updater

`daemon start`, `stop`, `status`, `install`, `remove`, `definition` and `run` (with `--once` or `--detached`). How they behave is under `# Releases and updates`. With `SILICON_APPS_NO_DAEMON=1`, installs start no updater and `daemon start`, `daemon install` and `daemon run` (without `--once`) refuse; that's for CI.

## Configuration

```sh
silicon-apps config show
silicon-apps config home /existing/home
silicon-apps config server https://apps.teamofsilicons.com
silicon-apps config accounts https://accounts.teamofsilicons.com
silicon-apps config telemetry off
silicon-apps config set install_script_timeout_seconds 120
silicon-apps config set update_interval_seconds 60
```

Environment variables:
- `SILICON_HOME` - the home, used after `--home`.
- `APPS_URL` and `ACCOUNTS_URL` - the service URLs.
- `APPS_TOKEN` - an Apps bearer token you manage yourself. The CLI and its updater read it; the Rust `Client` doesn't.
- `SILICON_STK` - the default STK variable for Silicon login. The `silicon-accounts` CLI uses `ACCOUNTS_STK` instead; `--stk-env` picks another name here.
- `SILICON_APPS_NO_DAEMON` - set to `1` to never start an updater, for CI.
- `APPS_TELEMETRY_TABLE_KEY` - optional, records straight to Space Station. `APPS_TELEMETRY_KEY` is an older name for it. The CLI works fine without either.

Turning telemetry off also sends `X-Apps-Telemetry: off` to the registry.

## Output and exit codes

With `--json`, results go to stdout and errors go to stderr.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. A signed-out `login status --json` is a success that reports `authenticated: false`. |
| `1` | The operation failed, or an app failed to update |
| `2` | Invalid arguments |

CLI errors look like `{"error":{"code":"...","message":"..."}}`. When the service refused the request, the error also has its HTTP `status`, `hint` and `details`; a failed signature check has `code`, `hint` and `details` too, for example `signature_mismatch`. `chain` holds the full text. Invalid arguments use `"code":"invalid_arguments"`.

## Retries

If a command may have changed something before the connection dropped, retry it with the same idempotency key, so we hand back the original result instead of doing the work twice. The CLI puts the key it generated in the error details, or you set your own with `--idempotency-key KEY`.

This matters most for anything that returns a secret, like `create` or `rotate-secret`: only the same key gets that secret back, and only for 10 minutes. A new request makes a new secret.

Sign-in tokens play by different rules. Never resend a used SLT or a rotated refresh token automatically.

## Offline docs

```sh
silicon-apps docs start
silicon-apps docs publish
silicon-apps docs manifest
silicon-apps docs install
silicon-apps docs auth
silicon-apps docs why
silicon-apps docs tree
silicon-apps docs links
```

More: https://developers.teamofsilicons.com/docs/apps/reference/cli.md

# The Apps HTTP API

The production base URL is `https://apps.teamofsilicons.com`. Every endpoint is under `/v1`, except `/health`, `/openapi.json`, `/mcp` and the `/.well-known/` documents.

## Discovery, versions and limits

Everything a Silicon needs to get started is public:
- `GET /openapi.json` (also `/v1/openapi.json`) - the OpenAPI 3.1 description of every route.
- `GET /.well-known/agent.json` (also `/.well-known/agent-card.json`) - the A2A agent card: skills, auth and links. We speak REST and MCP (Streamable HTTP at `/mcp`).
- `GET /.well-known/silicon-apps-keys.json` - the keys that sign releases (see `# Signed releases`).
- `GET /v1/capabilities` - what this server supports: API versions, auth methods, each target and whether its validation worker is live, search, streaming, subscriptions, signing, idempotency, rate limits and every event type.

Ask whether the server meets your needs before you rely on it:

```sh
curl "https://apps.teamofsilicons.com/v1/capabilities?require=streaming,subscriptions,signing,target:linux-x86_64"
```

If everything is met you get `200` with the full document plus `requirements: {satisfied: true, results: [{requirement, satisfied, reason}]}`. If not, you get `422 capabilities_missing`:

```json
{"error":{"code":"capabilities_missing","message":"This server does not meet: target:linux-aarch64.",
  "hint":"Each item in details.missing says why. Drop what you can live without, or try again when a worker is live.",
  "details":{"missing":[{"requirement":"target:linux-aarch64","satisfied":false,"reason":"..."}],"results":[{"requirement":"streaming","satisfied":true,"reason":"..."}]}}}
```

Requirements are `streaming` (alias `sse`), `subscriptions`, `webhooks`, `idempotency`, `search`, `rate_limits`, `openapi`, `agent_card`, `signing` (alias `signed_releases`), `author_signatures`, `withdrawal`, `mcp`, `version:V` (only `2026-10-09` today), `auth:METHOD` (`anonymous`, `bearer`, `slt_exchange`, `refresh_token`, `browser_session`, `developer_token`), `delivery:MODE` (`webhook` or `stream`), `event:TYPE` and `target:TARGET`. A `target:` requirement is met only when that target's validation worker is configured and answers a live probe right now. Up to 50 names, separated by commas; more is `400 invalid_input`, and an empty `require` is ignored.

This is not the same as Silicon Accounts' `GET /v1/capabilities`, even though the error code is the same. Here names are case-sensitive and `-` is not folded, `details.missing` holds objects with a `reason`, and success comes under `requirements`. At Accounts, names are case-insensitive and take aliases (`event_stream` and `streaming` both mean its `sse`), `details.missing` is a list of names, success comes under `require`, and an empty `require` is `400 invalid_query` (see `# Service endpoints`).

Pick an API version with the `Apps-Version` request header, for example `Apps-Version: 2026-10-09`. You can list several in order of preference, and the response's `Apps-Version` header names the one used. An unknown version is `400 unsupported_api_version` with the supported list. Without the header you get the current version, so clients that never send it see no change.

Rate limits are per client. A client is your bearer token, else your `apps_session` cookie, else your address, so the limits are per token or session, not per account:

| Limit | Value |
| --- | --- |
| Reads | 600 a minute |
| Writes | 120 a minute |
| Open event streams | 10, each ending after 30 minutes |
| Subscriptions | 50 active or paused per account |

Silicon Accounts counts differently: 5 open streams per app or account on each of its API nodes, each up to an hour, so don't reuse these numbers there.

Every response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy`. Going over returns `429 rate_limited` with `Retry-After` in seconds; every 429, `too_many_streams` included, has it. Retry a mutation after the wait with the same `Idempotency-Key`.

## Authentication

Send `Authorization: Bearer <Silicon Accounts token for silicon-apps>`. We check the token's issuer, signature, audience and the current account with the official Accounts client. Browsing and downloading public apps needs no token.

The developer portal calls Apps through its own server with a first-party token whose audience is `developer`. For that token we also check the issuer, signature, audience and expiry, and ask Accounts userinfo on every request whether the account and token family are still active. A developer token can manage apps: read identity, targets, app lists, availability, details and history, download packages, upload media, handle invites, make the management changes below and send telemetry. It can't be used for reviews, install receipts, package resolution, platform registration, reports or token exchange, and it never creates an Apps membership. Author, administrator and private access rules still apply.

Keep tokens and your app secret on your server. Browser JavaScript must never see them.

Invites are matched against your verified emails. A token for the Apps audience only carries verified emails when the account granted the Email scope.

## Idempotency and retries

Every `POST`, `PUT`, `PATCH` and `DELETE` under `/v1`, except `/v1/auth/*`, needs an `Idempotency-Key` header of 8 to 200 printable ASCII characters, with no spaces. Without one it's `400 invalid_input`. If you didn't get an answer, retry with the same key and the same body.

- A key belongs to your account (every anonymous caller shares one scope, so send random keys there). We record the method, path and body with it, and the same key with a different method, path or body returns `409 conflict`, not a new request.
- A replayed response has the header `Idempotent-Replayed: true`.
- A response holding a secret (making an app, rotating its secret, the webhook secret) can be replayed for 10 minutes. After that we drop the plaintext, and a retry returns `409 secret_replay_expired` without doing the work again.
- Everything else stays replayable. A failed package validation replays too, without running the package again.
- The `/v1/auth/*` endpoints don't take idempotency keys. They follow the one-use token rules, so never retry a used SLT, code or refresh token automatically.
- The CLI and the Rust client make a random key for every request that isn't a GET; `--idempotency-key KEY` sets your own.

Silicon Accounts is looser: there the key is optional, 1 to 200 characters, scoped to the caller, method and route, failures aren't stored, and a secret's replay window simply ends after 10 minutes. The comparison is in `# The Accounts HTTP API`.

## Responses and errors

A successful response is the object itself, with no wrapper. Every error, unknown routes, wrong methods and bodies that are too large included, looks like this:

```json
{"error":{"code":"...","message":"...","hint":"...","details":null}}
```

| Status | When |
| --- | --- |
| `400` | A bad query value (the error lists the accepted ones), `unsupported_api_version`, `unknown_event_type` |
| `404` | Unknown route, extra path segment or unsupported method. Returned before any side effect. |
| `409` | An idempotency key reused with different content, `secret_replay_expired`, the same media bytes uploaded with a different content type, `author_key_exists` |
| `410` | `release_withdrawn`: an exact version that was withdrawn, or a package that only belongs to withdrawn releases |
| `422` | A package failed its three commands (`error.details` holds the exact results), `invalid_author_signature`, `capabilities_missing` |
| `429` | `rate_limited` or `too_many_streams`, always with `Retry-After` |
| `503` | No validation runner for that target, or no report delivery set up |

## Identity and discovery

| Endpoint | Returns and rules |
| --- | --- |
| `GET /health` | `{status:"ok",service:"silicon-apps",version}` |
| `GET /v1/me` | `{uuid,id,display_name,verified_emails:[]}` |
| `GET /v1/targets?targets=linux-x86_64,macos-aarch64` | `{items:[{target,population,runner_available}],total_population,total_reach,source:"registered_accounts"}`. `runner_available` says a worker is configured, not that it answers; today only `linux-x86_64` is `true`. `GET /v1/capabilities` probes it live. |
| `POST /v1/platforms` | Body `{target}`. Records the signed-in account's platform. A signed-in install receipt registers its target too. |
| `GET /v1/apps/availability/{app_id}` | `{available}`. Invalid IDs are `false`. |
| `GET /v1/apps?q=&tags=&target=&visibility=public\|private&mine=true&sort=relevance&limit=50&offset=0` | `{items:[App],total,limit,offset,next_offset,sort}`. Published apps you can access; `mine=true` needs auth and includes drafts. See below. |
| `GET /v1/apps/{app_id}` | `App`. Drafts are only visible to authors. |

Search filters on `GET /v1/apps`:
- `tags` - comma-separated; an app must have all of them.
- `target` - only apps whose current release has a package for that target.
- `sort` - `relevance` (the default), `rating`, `installs`, `name`, `updated` or `newest`.
- `limit` - 1 to 100. `next_offset` is `null` on the last page.

A bad value is a `400` that lists the accepted ones.

## Making and setting up an app

| Endpoint | Body | Returns and rules |
| --- | --- | --- |
| `POST /v1/apps` | `{app_id,name,description?,logo?}` | `{app:App,app_secret}` |
| `PATCH /v1/apps/{app_id}` | any of `{name,description,tags,logo,logo_alt,banner,banner_alt,carousel:[{url,kind,alt}],links:{website,developer_docs,android,ios,custom:[{label,url,logo}]},setup_step:1..7}` | `App` |
| `PUT /v1/apps/{app_id}/access` | `{visibility,domains:["example.com"],account_ids:["c:shubham","si:head_of_growth"]}` | `App`. Administrator only. IDs are saved as uuids. |
| `POST /v1/apps/{app_id}/media` | the raw file with its `Content-Type` | `{url,id,kind,size,content_type}`. PNG, JPEG, WebP, GIF, MP4 or WebM up to 100 MiB, no SVG. Reading the URL checks app visibility again. |
| `GET /v1/apps/{app_id}/readiness` | | `{ready,errors:[{field,message}],required_commands:["--help","accounts --json","login status --json"]}` |
| `POST /v1/apps/{app_id}/publish` | `{}` | `App`. Needs a 200 to 600 character description and at least one accepted package in a release. |
| `POST /v1/apps/{app_id}/secret/rotate` | `{}` | `{app_secret}`. Any author. |

## Authors and history

| Endpoint | Body | Returns and rules |
| --- | --- | --- |
| `GET /v1/apps/{app_id}/authors` | | `{items:[{uuid,id,display_name,joined_at}]}`. The administrator isn't marked. |
| `POST /v1/apps/{app_id}/invites` | `{to:"c:shubham"\|"si:head_of_growth"\|"shubham@example.com"}` | `Invite`. Authors only. |
| `GET /v1/apps/{app_id}/invites` | | `{items:[Invite]}`. Authors only. |
| `DELETE /v1/apps/{app_id}/invites/{invite_id}` | `{}` | `{status:"cancelled"}`. Authors only. |
| `GET /v1/invites` | | `{items:[Invite]}`. Only invites matching your uuid or a verified email. |
| `POST /v1/invites/{invite_id}/accept` | `{}` | `{status:"accepted"}` |
| `POST /v1/invites/{invite_id}/decline` | `{}` | `{status:"declined"}` |
| `POST /v1/apps/{app_id}/authors/leave` | `{}` | `{status:"left"}`. Not the last author. Administration passes to the oldest remaining author. |
| `POST /v1/apps/{app_id}/admin` | `{uuid}` | `{status:"transferred"}`. Administrator only; the uuid must already be an author. |
| `DELETE /v1/apps/{app_id}/authors/{uuid}` | `{}` | `{status:"removed"}`. Administrator only, and not themselves. |
| `GET /v1/apps/{app_id}/history?limit=100&offset=0` | | `{items:[{id,at,actor_uuid,kind,data}],total}`. Authors only. |

## Packages and releases

| Endpoint | Body | Returns and rules |
| --- | --- | --- |
| `POST /v1/apps/{app_id}/packages/{target}` | the raw `.tar.gz`, `Content-Type: application/gzip` | `Package`, once the archive is valid and the three commands pass in the target's runner. `422` with the results in `error.details` on failure, `503` with no runner. |
| `GET /v1/apps/{app_id}/packages` | | `{items:[Package]}`. Authors only. |
| `POST /v1/apps/{app_id}/releases` | `{version:"1.2.3",package_ids:[],notes?}` | `Release`, always development. The packages must belong to this app, one per target. |
| `GET /v1/apps/{app_id}/releases?channel=production\|development` | | `{items:[Release]}`. App visibility applies. |
| `POST /v1/apps/{app_id}/releases/{release_id}/promote` | `{version:"2.0.0"}` | An immutable production `Release` from the same package bytes. |
| `POST /v1/apps/{app_id}/releases/{release_id}/withdraw` | `{reason}` | `Release` with `withdrawn:{at,by_uuid,by_id,reason}` and `replacement:{release_id,version}` or `null`. Authors only. Final; records `release.withdrawn`. |
| `GET /v1/apps/{app_id}/resolve?channel=&version=&target=` | | `{app_id,release,package,download_path,signature,author_signature,install_script,withdrawn}`. `channel` defaults to `production`, `version` is optional, `target` is required. See below. |
| `GET /v1/apps/{app_id}/packages/{package_id}/download` | | The raw gzip. Access is checked again on every download. A package that only belongs to withdrawn releases is `410` for everyone but the app's authors. |
| `POST /v1/apps/{app_id}/installs` | `{release_id,package_id}` | `{installs}`. Works without signing in, with an `Idempotency-Key`. Send it only after the install finished. |

What `resolve` adds:
- `signature` - our Ed25519 signature over the release manifest, with the signed fields. Check it before you run anything (see `# Signed releases`).
- `author_signature` - the uploading author's own signature, or `null`.
- `install_script` - `{path,sha256,size}`, or `null`.
- `withdrawn` - the withdrawn releases on that channel.

Without `version` you get the newest release that isn't withdrawn. An exact version that was withdrawn is `410 release_withdrawn`, with the reason and the replacement.

## Author signing keys

| Endpoint | Body | Returns and rules |
| --- | --- | --- |
| `GET /v1/keys` | | `{items:[{key_id,name,algorithm:"ed25519",public_key,created_at,status:"active"\|"revoked",revoked_at,revoked_reason}]}`, your author keys |
| `POST /v1/keys` | `{public_key,name?}` | `201 {key}`. The ID is `ak_` and 16 hex characters of the SHA-256 of the public key. Up to 20 active keys. A key that was ever registered is `409 author_key_exists`. |
| `DELETE /v1/keys/{key_id}` | `{reason?}` | `{key}` with `status:"revoked"`. Nothing new can be signed with it. |

An author-signed upload sends `X-Apps-Author-Key-Id` and `X-Apps-Author-Signature`. A signature that doesn't verify, or a key that isn't an active key of yours, is `422 invalid_author_signature` before any command runs. Accepted packages carry `author_signature`, and a release whose packages are all author-signed has `signed_by_author: true`. We sign every package ourselves either way.

## Events and subscriptions

| Endpoint | What it does |
| --- | --- |
| `GET /v1/apps/{app_id}/events`, `GET /v1/events` | The event log as pages: `{items:[Event],next_after,has_more,cursor}`, with `after`, `types` and `limit` (1 to 500) |
| `GET /v1/apps/{app_id}/events/stream`, `GET /v1/events/stream` | The same events as server-sent events, with `Last-Event-ID` resume, `types` and 15 second heartbeats |
| `GET` and `POST /v1/subscriptions` | List and create subscriptions |
| `GET`, `PATCH` and `DELETE /v1/subscriptions/{id}` | Read, change (including pause and resume) and cancel one |
| `GET /v1/subscriptions/{id}/deliveries` | Recent deliveries with attempts and the last error |
| `POST /v1/subscriptions/{id}/secret/rotate` | A new `whsec_` secret, shown once |
| `POST /v1/subscriptions/{id}/ping` | Send a signed test delivery |

How each feed, the stream and subscription webhooks work is under `# Events, streams and subscriptions`.

## Reviews, webhooks and reports

| Endpoint | Body | Returns and rules |
| --- | --- | --- |
| `GET /v1/apps/{app_id}/reviews` | | `{items:[{uuid,id,rating,text,updated_at}],rating,count}` |
| `PUT /v1/apps/{app_id}/review` | `{rating:1..5,text?}` | `Review`. Signed in, app accessible, text up to 600 characters, one per uuid. |
| `DELETE /v1/apps/{app_id}/review` | `{}` | `{status:"removed"}`. Works after losing access to a private app, without giving back any other access. |
| `GET /v1/apps/{app_id}/webhook` | | `{url,secret_set,events,subscription_id,status}`, read live from Silicon Accounts. Authors only. |
| `PUT /v1/apps/{app_id}/webhook` | `{url,events:["id_change"]}` | `{url,secret?}`. `secret` only when none existed; an existing one is kept, as every save of the URL does. Leaving `events` out sets the five defaults, which replace the picks. |
| `POST /v1/apps/{app_id}/webhook/rotate` | `{}` | `{webhook_secret:"whsec_..."}`. Works before a URL is set. Note the field is `webhook_secret` here and `secret` at Accounts. |

These three pass through to Silicon Accounts, which keeps the one webhook record; Apps stores no URL, secret or events, and has no delete, test, deliveries or replay routes (use Accounts for those). Accounts' own `PUT` keeps the secret too, but keeps the current events when you leave them out, so see "Where you set the URL matters" in `# Webhooks` before you change the webhook from both sides.
| `POST /v1/reports` | `{message,pr?}` | `{id,status:"queued"}`. `503` when delivery isn't set up. |

## Objects

`App`: `{app_id,name,description,logo,banner,tags,visibility,domains,account_ids,links,carousel,published,setup_step,created_at,updated_at,authors,targets,latest_production,latest_development,rating,review_count,installs,is_author,is_admin,signed,signed_by_author,withdrawn_releases}`.
- `domains` and `account_ids` are only returned to authors.
- `is_admin` only says whether you are the administrator. It never marks another author.
- `latest_production`, `latest_development` and `rating` can be `null`.

`Package`: `{id,target,sha256,size,command,validation:[{command,exit_code,stdout,stderr,passed,expected}],created_at}`.

`Release`: `{id,app_id,channel,version,package_ids,notes,created_at,promoted_from?}`.

`Invite`: `{id,app_id,to,account_uuid?,status,created_at}`. Only authors and the invitee can see a pending invite.

Display names of authors, reviewers and invitees refresh from Accounts by uuid.

Uploaded packages and media are stored without ever replacing existing bytes. Uploading the same media again keeps its first content type.

## Browser sign-in

These are for a site that signs Carbons into Apps in the browser:
- `GET /v1/session` - `{authenticated,account}` from the server-side session.
- `GET /v1/auth/login?return_to=/store` - redirects to Silicon Accounts with PKCE and a one-use state tied to the browser.
- `GET /v1/auth/callback` - checks the state, exchanges the code and sets an opaque `HttpOnly`, `SameSite=Lax` cookie.
- `POST /v1/auth/exchange` with `{slt}`, and `POST /v1/auth/refresh` with `{refresh_token}` - return the official Accounts `TokenResponse`.
- `POST /v1/auth/logout` with `{token?}` - revokes the app token and clears the browser session.

When an Apps session cookie is present, every change needs an allowed `Origin`. Bearer-only CLI requests need no `Origin`.

## Telemetry

`POST /v1/telemetry` takes `{step,progress,event?,path?,target?,status_code?,duration_ms?,item_count?,byte_count?,error_code?}` and records a sanitized Space Station event. Arbitrary properties, credentials, raw app IDs and identities are never recorded. `X-Apps-Telemetry: off` opts out. With no destination set up it returns `{accepted:false,reason:"not_configured"}` and keeps nothing.

More: https://developers.teamofsilicons.com/docs/apps/reference/api.md

# Events, streams and subscriptions

Everything that changes an app is written to an append-only event log, in the same transaction as the change. A change that fails leaves no event, and a saved change always has one. You can read the log three ways, all of them signed in:
- pages of JSON, with `GET /v1/events` and `GET /v1/apps/{app_id}/events`.
- a live stream of server-sent events (SSE), with `GET /v1/events/stream` and `GET /v1/apps/{app_id}/events/stream`.
- a subscription that pushes events to your webhook, signed, or keeps your place on a stream.

## Feeds

| Feed | Who | What it carries |
| --- | --- | --- |
| `/v1/apps/{app_id}/events` | the app's authors | everything about the app: releases created, promoted and withdrawn, each package validation step with the three commands' results, author invites, joins and leaves, access changes, details, media and reviews |
| `/v1/events` | any signed-in account | your own feed: invites to you, everything about apps you author, and releases of apps you installed |
| `/v1/events?subscription=ID` | the subscription's owner | that subscription's events, through its filters |

Event types come in groups:
- `app.*` - `app.created`, `app.published`, `app.access_changed`, `app.details_changed`, `app.installed` and more.
- `package.*` - `package.validation_started`, `package.validation_step`, `package.accepted`, `package.validation_failed`.
- `release.*` - `release.created`, `release.promoted`, `release.withdrawn`.
- `author.*` - `author.invited`, `author.joined`, `author.left`, `author.removed`, `author.invite_declined`, `author.invite_cancelled`, `author.admin_transferred`.
- `review.*` and `ping`.

`GET /v1/capabilities` lists every type. Anyone who can see an app can get its `app.published`, `release.created`, `release.promoted` and `release.withdrawn`; everything else is for its authors.

```json
{"seq":42,"id":"7d0c...","type":"release.promoted","app_id":"briefcase","actor_uuid":"8HV","occurred_at":"2026-10-09T10:15:00Z","data":{"id":"...","channel":"production","version":"1.4.0","package_ids":["..."]}}
```

`seq` is the event's place in the log; use it to resume. Filter with `types`: exact types, a group or everything, like `?types=release.promoted,package.*` or `?types=*`. An unknown type is `400 unknown_event_type`, listing the known ones.

## Streams

```sh
curl -N -H "Authorization: Bearer $APPS_TOKEN" \
  "https://apps.teamofsilicons.com/v1/apps/ring/events/stream?types=package.*,release.*"
```

```text
retry: 3000
: ready cursor=41

id: 42
event: package.validation_step
data: {"seq":42,"type":"package.validation_step","app_id":"ring","data":{"step":"command","command":"accounts --json","exit_code":0,"passed":true,"expected":"Exit 0 and JSON containing this exact app_id.","stdout":"{\"app_id\":\"ring\"}","stderr":""}}

: heartbeat
```

- Without `Last-Event-ID` a stream starts at the newest event. Send `Last-Event-ID: 41` (or `?last_event_id=41`) to get everything after event 41. Browsers do this for you when they reconnect.
- A `: heartbeat` comment comes every 15 seconds, so you can tell a quiet stream from a dead one.
- A stream ends after 30 minutes. Reconnect with the last `id` you saw and you miss nothing.
- One client can hold 10 streams open, and one stream with `?types=` can follow several kinds of events. A client is your bearer token, else your session, else your address, so two tokens of one account count separately. The 11th stream is `429 too_many_streams` with `Retry-After`.
- Silicon Accounts' event stream is a different service with different limits: 5 streams per app or account on each API node, an hour each. Its events have their own shapes too: in `silicon.custodian_changed`, for example, an app sees the old and new custodian only as `{uuid, id}` (see `# Webhooks`).

The most common use is watching an upload: open the app's stream, upload, and you see the archive check, the manifest check and each of the three commands as the runner finishes it. From the CLI, `silicon-apps events --app ring --type 'package.*' --follow` prints one JSON line per event; without `--follow` you get one page, and `--after SEQ` gets the next.

## Subscriptions

A subscription follows one app you can see, or your own account feed, and delivers to a webhook or to a stream that keeps your place. Say you want to know when `briefcase` ships:

```sh
silicon-apps subscriptions create --app briefcase --type release.promoted --webhook https://example.com/hooks/apps
```

```http
POST /v1/subscriptions
Authorization: Bearer ...
Idempotency-Key: follow-briefcase-1

{"app_id":"briefcase","types":["release.promoted"],"channels":["production"],"delivery":{"mode":"webhook","url":"https://example.com/hooks/apps"},"description":"Tell me when briefcase ships"}
```

A webhook subscription comes back with its own signing secret, `whsec_` followed by base64. You see it once, so save it. If it's lost, `silicon-apps subscriptions rotate-secret ID` makes a new one and the old one stops at once.

- `types` defaults to everything you can see in that feed. If you aren't an author, you can only pick an app's public types.
- `channels` limits release events to `production` or `development`. Leave it out for both.
- `{"mode":"stream"}` needs no URL. Read it with `silicon-apps events --subscription ID --follow` or `GET /v1/events/stream?subscription=ID`; without `Last-Event-ID` it carries on where you stopped.
- Pause with `PATCH {"status":"paused"}` (`subscriptions pause ID`) and resume with `{"status":"active"}`. Deliveries due while paused wait, and go out on resume if that's within 72 hours of their event.
- `DELETE /v1/subscriptions/{id}` (`subscriptions cancel ID`) ends it for good, and its pending deliveries fail.
- An account can have 50 active or paused subscriptions. Every create, update and cancel takes an `Idempotency-Key`.

## Subscription webhooks

Each delivery is a `POST` of the event as JSON:

```http
POST /hooks/apps HTTP/1.1
content-type: application/json
user-agent: SiliconApps-Webhooks/1
x-apps-event-id: 7d0c...
x-apps-event-type: release.promoted
x-apps-delivery-id: dlv_...
x-apps-subscription-id: sub_...
x-apps-timestamp: 1791540900
x-apps-signature: v1=5f1c...

{"actor_uuid":"8HV","app_id":"briefcase","data":{...},"event_id":"7d0c...","occurred_at":"2026-10-09T10:15:00Z","seq":42,"subscription_id":"sub_...","type":"release.promoted"}
```

These follow the same rules as Silicon Accounts webhooks (`# Webhooks`), with `X-Apps-` headers:
- `X-Apps-Signature` is `v1=` and the hex HMAC-SHA256 of `"{X-Apps-Timestamp}.{raw body}"`, keyed with the whole `whsec_` secret. It can list several `v1=` values separated by commas; accept the delivery when any one matches.
- Check the bytes you received, not JSON you parsed and wrote back out. Refuse timestamps more than 5 minutes from your clock.
- Skip an `event_id` you already handled: a retry carries the same one.
- Answer any 2xx within 10 seconds. Anything else, a timeout or a redirect (we don't follow them) is a failed attempt. We retry after 10 s, 30 s, 1 min, 5 min, 15 min and 30 min, then every hour, until 72 hours after the event.
- In production we only deliver to `https` URLs on public addresses.

In Rust, `silicon_apps_client::events::verify_webhook(secret, timestamp, signature, body, now, 300)` does the check. In any other language it's a few lines, for example Python:

```python
import hashlib, hmac, time

def accept(secret: str, timestamp: str, signature: str, body: bytes) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(part.strip()[3:], expected)
               for part in signature.split(",") if part.strip().startswith("v1="))
```

`silicon-apps subscriptions ping ID` sends a signed `ping` to test your receiver, and `silicon-apps subscriptions deliveries ID` lists recent deliveries with their attempts and the exact last error.

More: https://developers.teamofsilicons.com/docs/apps/reference/events.md

# Apps Rust packages

There are two crates:
- `silicon-apps-client` - the main client, and it's stateless. The CLI is built on it.
- `silicon-apps-package` - manifests, archives and checksums. It reads and writes package files and never runs them.

```toml
[dependencies]
silicon-apps-client = "0.2"
silicon-apps-package = "0.2"
```

Today the CLI, the client and the package are all 0.2.0, but the crates' versions move independently of the CLI's. Generated references for both are on docs.rs.

## The client

`Client::new(url, token)` takes the service URL and an optional bearer token. Making one reads no environment variables, saves no session and touches no files, and it never reads `APPS_TOKEN`: pass the token yourself. Two things do read `APPS_TOKEN`: the CLI, and the library's updater (`updater::run`), which uses it as the bearer token for its checks when it's set.

```rust
use silicon_apps_client::Client;

let apps = Client::new("https://apps.teamofsilicons.com", None)?.with_telemetry(false);
let matches = apps.search("terminal", false, false).await?;
let details = apps.app("silicon-apps").await?;
```

- `create`, `edit`, `action`, `upload`, `upload_signed`, `withdraw_release`, `resolve`, `report` and `register_platform` - authoring and the store.
- `capabilities`, `events`, `stream_events` and the `subscriptions` methods - following what happens.
- `author_keys`, `add_author_key`, `revoke_author_key` and `signing_keys` - keys.
- `request` - the rest of the documented HTTP contract, for extra filters and optional fields.
- `events::verify_webhook(secret, timestamp, signature, body, now, tolerance_seconds)` - checks a subscription webhook.

An error from the service is an `ApiError` with `status`, `code`, `message`, `hint` and `details`. Get it with `error.downcast_ref::<silicon_apps_client::ApiError>()`.

Mutations take your own idempotency key, or use a fresh UUID. Keep the same key across retries when you don't know whether the request landed.

## Local state is explicit

Anything that saves sessions or install records takes a `LocalState` whose home you choose, and that directory has to exist:

```rust
use silicon_apps_client::{Client, Config, LocalState, install};

let state = LocalState::new("/home/me")?;
let config = Config::default();
let apps = Client::new(&config.server, None)?;
let spec = "ring>dev@1.2.3".parse()?;
let result = install::install(&apps, &state, &config, &spec, false).await?;
println!("{}", result.message);
```

- `auth::authenticated_client` - signs in with the official Silicon Accounts client, saves tokens per service URL and coordinates refreshes across processes, so a rotating refresh token is never used twice.
- `install::install` - checks the metadata, the checksum and the release signature (`signing::verify_package`), and the author signature when there is one, before it extracts within the limits. Then it checks the command isn't another app's, prepares before replacing, runs the install script with a timeout and puts the previous package back on failure. It keeps the registry in the install record and saves an undelivered install receipt for retry without counting twice. `InstallOutcome.notice` is one line about a changed install script or author signature.
- A failed signature check is a `signing::VerificationError` with a stable `code`. Trusted keys live in the state you pass, per service.
- `install::inspect_install_script` - checks a release's signatures and returns its install script without installing anything.
- `signing::AuthorKey` - creates, saves, loads and signs with author keys.
- `updater::run` - checks every installed channel, Apps included, and moves an app off a withdrawn release to the latest good one, reporting `replaced_withdrawn`.
- `service_definition` - builds the launchd, systemd or Task Scheduler configuration; `install_service` turns it on.

Windows self-update uses a helper and a runtime copy, so installed executables can be replaced.

## Package tooling

- `validate_directory` - reports every error it finds at once.
- `pack_directory` - deterministic `.tar.gz` bytes.
- `inspect_archive` - checks an archive's structure and manifest.
- `extract_archive` - extracts into an empty destination only.
- `sha256` - the lowercase hex digest.

`docs::guide(topic)` returns the bundled guides with no filesystem or network access, the same text as `silicon-apps docs TOPIC`.

More: https://developers.teamofsilicons.com/docs/apps/reference/rust-client.md

# Silicon Accounts, in full

Silicon Accounts is the account system of the Silicon ecosystem. Every Carbon (a person) and every Silicon (an agent) gets one personal account, and carries that same account into every app they sign in to. If you are building an app, we handle sign-in for you: you pick the methods, the pages your users see and the details they share, and we take care of account creation, email and phone codes, Google and Apple, and your app's user base.

There are only personal accounts here, with no organizations, groups or shared team accounts. An account is never shared: `c:shubham` belongs to Shubham, `si:head_of_growth` belongs to that Silicon. The only link between two accounts is a Silicon's custodian, the one Carbon responsible for it. Your app only ever gets what the account chooses to share with it. (When these docs say "the Team", they mean Team of Silicons, the people who run Silicon Accounts and Silicon Apps, not a kind of account.)

Every account is known by a `uuid`. Despite the name it is not an RFC 4122 UUID: it is a short, case-sensitive account id like `8HV`, and it is the `sub` of every token, the OIDC subject. It never changes, so it is what your app stores.

You can reach us three ways, and they all do the same things:
- the `silicon-accounts` CLI. Install it with `silicon-apps install silicon-accounts` (Silicon Apps keeps it updated), or build it from source with `cargo install silicon-accounts-cli`.
- the `silicon-accounts-client` Rust package, which the CLI itself is built on.
- the HTTP API at `https://accounts.teamofsilicons.com/v1/`.

```sh
silicon-accounts --help                       # the whole command tree
silicon-accounts docs                         # the guides bundled with the CLI, readable offline
curl -s "https://accounts.teamofsilicons.com/v1/ids/available?id=si:head_of_growth"
```

The CLI talks to `https://accounts.teamofsilicons.com` unless you pass `--url` or set `ACCOUNTS_URL`.

## Where things live

- `accounts.teamofsilicons.com` - the account site. This is where your Carbon looks after their own account: their details, emails and phone numbers, the apps they signed in to and what each one sees, the User verification proofs apps issued on their behalf, and the Silicons they are custodian of.
- `developers.teamofsilicons.com` - the developer platform. This is where you set up your app's sign-in: methods, Google and Apple, the details you ask for, flows and pages, redirect URLs, user base and imports, webhooks and App verification proofs. The settings themselves are stored with us.
- `https://accounts.teamofsilicons.com/.well-known/openid-configuration` - discovery for any OpenID Connect library, with keys at `/.well-known/jwks.json`.

## Things you can rely on

- Store the `uuid`. Ids change, the uuid never does, and we tell your webhook when an id changes.
- Every error is `{"error": {"code", "message", "hint"?, "details"?}}`: a stable `code` to branch on, a `message` that says exactly what went wrong, and usually a `hint` with the next step.
- Requests that create a Silicon, an import, a proof, a webhook secret or a sign-in configuration change accept an optional `Idempotency-Key` header. Retry with the same key and body inside the replay window and you get the original response back. Removals can simply be repeated. (Silicon Apps requires the header on every change, with other rules; see `# The Accounts HTTP API`.)
- Something broken? `silicon-accounts report "what you ran, what you expected, what happened"`, with `--pr <link>` if you already fixed it.

More: https://developers.teamofsilicons.com/docs/accounts/index.md

# Accounts

Every account is either a Carbon or a Silicon. You can see your own with `silicon-accounts whoami` (add `--json` for the fields), or `GET /v1/me`.

Every account has these fields:

| field | what it is |
|---|---|
| `uuid` | The permanent identifier, for example `8HV`: a short, case-sensitive id, not an RFC 4122 UUID. It never changes, is never reused, and is the `sub` of every token. Your app stores this. |
| `kind` | `carbon` or `silicon`. |
| `id` | The public id people see and type: `c:shubham`, `si:scout`. Unique, changeable, case-insensitive (stored lowercase). `null` once the account is deleted. |
| `display_name` | 1 to 100 characters, no control characters (newlines, tabs). |
| `pfp_url` | The profile photo. By default a generated image from Iris: `https://iris.teamofsilicons.com/pfp/carbon?id=<uuid>` or `.../pfp/silicon?id=<uuid>`. |
| `dob` | Date of birth, `YYYY-MM-DD`. |
| `timezone` | An IANA timezone such as `Asia/Kolkata` or `UTC`. |
| `status` | `active`, `unclaimed`, `pending_custodian` or `deleted`. |
| `created_at`, `updated_at` | RFC 3339 UTC timestamps with milliseconds. |
| `version` | Goes up with every change, so whoever holds a copy can tell which one is newer. |

What the statuses mean:
- `active` - a normal account.
- `unclaimed` - a Carbon account an app created by importing its users. Its owner finishes it the first time they sign in with the address it carries; until then nobody can sign in to it.
- `pending_custodian` - a Silicon that created its own account and named a custodian who hasn't accepted yet. The Carbon has 14 days. Until then the Silicon can't sign in.
- `deleted` - the account is gone. The uuid stays reserved forever and nothing else of it is usable.

## Carbon account

A Carbon account also has:
- `emails` - up to 10, each `{email, is_primary, verified_at, verified_via}`, primary first. `verified_via` is `code`, `google` or `apple`.
- `phones` - up to 10, each `{phone, is_primary, verified_at}`, in E.164 (`+14155550199`), primary first.
- `identities` - linked Google and Apple accounts, each `{provider, subject, email, created_at, last_used_at}`.
- `custodian_of` - how many Silicons this Carbon is custodian of.

A Carbon signs in with any email or phone number on their account plus a 6-digit code, or with a linked Google or Apple account when your app offers that method.

When a Carbon signs up we fill in the setup page for them, and they can change anything before continuing: the display name from Google or Apple (or from the email address), an available `c:id`, the timezone of their network, a date of birth exactly 18 years ago, and the default photo.

## Silicon account

A Silicon account has no emails or phone numbers. Instead it has:
- `custodian` - the Carbon responsible for it, stored by uuid and shown with its current `c:id`. Always exactly one. It is only `null` while a self-created Silicon waits for its custodian to accept.
- STK - the Silicon's password. When we generate it, it is `stk-` and 12 hexadecimal digits and is shown exactly once; a Silicon can also choose its own, `stk-` and 8 to 32 hexadecimal digits. We only keep a hash, and no endpoint ever returns it; `stk_rotated_at` says when it last changed. The custodian can rotate it any time, which ends the old one and signs the Silicon out everywhere.
- `webhook_url` - optional. Where we tell the Silicon about its own account: it was created, its custodian decided, something changed, its STK was rotated, it has a new custodian.

As a Silicon you sign in with your si:id and STK (`printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin`), and you sign in to apps by handing them a short-lived token. Your date of birth is the day your account was created and can't change (`422 dob_immutable`).

A Silicon manages its own display name, photo, timezone, si:id and webhook. Its custodian can change all of those for it, rotate its STK, transfer it to another Carbon, or delete it. Getting an account and custody are covered in `# Silicons and custodians`.

## Changing your profile

Every account edits its own details with `silicon-accounts profile set` (`PATCH /v1/me`). Only the fields you pass change:

```sh
silicon-accounts profile set --display-name "Shubham" --timezone Asia/Kolkata --photo ./me.png
```

| flag | field | rule |
|---|---|---|
| `--display-name` | `display_name` | 1 to 100 characters, no control characters. |
| `--timezone` | `timezone` | An IANA name in any letter case, stored in its canonical spelling (`asia/kolkata` becomes `Asia/Kolkata`). |
| `--dob` | `dob` | Carbons only: on or after 1900-01-01 and before today. |
| `--pfp-url` | `pfp_url` | An `https` URL. |
| `--photo` | `pfp_url` | Uploads a file: PNG, JPEG, WebP or GIF, at most 2 MB and 8192 px a side, 20 uploads per hour. |
| `--reset-photo` | `pfp_url` | Back to the default photo. |

Every bad field is reported at once (`422 validation_failed`, with `details.fields`), and a field that lives somewhere else tells you where: emails go through `/v1/me/emails`, the id through `POST /v1/me/id`. A change raises `version`, apps that may see the changed field get `account.updated`, and a Silicon's own webhook gets `silicon.updated` (see `# Webhooks`).

## Emails and phone numbers

```sh
silicon-accounts email add dora.work@example.com        # sends a 6-digit code, valid 10 minutes
silicon-accounts email verify <challenge-id> <code>     # proves it; now it signs you in too
silicon-accounts email primary dora.work@example.com    # apps with the email scope are told
silicon-accounts email remove dora@example.com          # any address except the primary
```

Phone numbers work the same way under `silicon-accounts phone`, in international format or with a country: `silicon-accounts phone add "(415) 555-0199" --country US` stores `+14155550199`.

The rules, and why they exist:
- Every address is verified before it counts. Only the right code adds it, except an address Google or Apple vouches for, which needs no code. An address nobody has proven never signs anyone in; the only unverified addresses are ones an import attached to an account nobody has finished yet.
- One address, one account. Any address signs in, so two accounts sharing one would make sign-in ambiguous. Adding someone else's address is `409 email_in_use` / `phone_in_use`.
- Exactly one primary of each kind. The first address added becomes primary, and any other verified one can take its place. Apps only ever see the primary, and we tell them when it changes.
- The primary can't be removed (`409 cannot_remove_primary`). Make another one primary first, so your Carbon always has a way to sign in and every app always has a current address.
- At most 10 of each. The 11th is `422 email_limit_reached` / `phone_limit_reached`.

Limits that stop address guessing and spam:

| limit | value |
|---|---|
| Codes sent to one address | 10 per 10 minutes, sign-in and add codes together, then `429 rate_limited` |
| Wrong codes for one address | 10 in a row lock every code for that address for 60 seconds (`423 verification_locked`); `details.remaining_attempts` counts down |
| Code lifetime | 10 minutes; a new code replaces the old one (`410 code_expired`) |
| Add attempts | 20 per account and 30 per network per 10 minutes, emails and phones together, counted even when the address is refused, so nobody can use `email_in_use` to test which addresses have accounts |

Unlink a Google or Apple identity with `silicon-accounts identities remove <provider> <subject>`. The last way left to sign in can't go: `409 last_sign_in_method` while the account has no email or phone.

## Deleting an account

A Carbon deletes their own account with `silicon-accounts delete-account --confirm c:dora` (`DELETE /v1/me` with `{"confirm": "c:dora"}`). The confirmation has to be the current id.

A custodian can't delete their account while they still have a Silicon, because every Silicon must always have exactly one custodian. That is `409 custodian_of_silicons`, with the Silicons listed in `details.silicons`. Transfer each one first (`silicon-accounts silicon transfer`), or delete it (`silicon-accounts silicon delete <si:id> --confirm <si:id>`).

Deleting happens at once, in one step, and can't be undone:
- The status becomes `deleted` and the account can never sign in again.
- The id is held for 10 days, so nobody can grab `c:dora` and pass as Dora to everyone who still knows the old id. After that anyone may take it.
- The uuid is never reused. Looking it up answers `404 account_deleted`; looking up the old id answers `404 account_not_found`, with a hint that it was released recently.
- Every email, phone number and Google or Apple link is removed, so those addresses are free again.
- Every session, every app sign-in and every User verification proof about the account is revoked.
- The photo goes back to the default, and uploaded photos no other account still shows are deleted.
- Every app the account belongs to gets `account.deleted` and keeps the membership as history: `status: "deleted"`, display name "Deleted account", no id, email, phone, date of birth or timezone. Data the app imported about the account is dropped, but its `external_id` stays so the app can find its own record.
- Custodian requests waiting on this Carbon are cancelled. Self-created Silicons still waiting for them are released (their ids are free at once) and told with `silicon.custodian.declined`, reason `custodian_account_deleted`.

Only its custodian can delete a Silicon: `silicon-accounts silicon delete si:dora_helper --confirm si:dora_helper`. A Silicon that tries to delete itself gets `403 custodian_required`, because its custodian is the one responsible for it. Everything else is the same as for a Carbon, except the Silicon's own webhook is kept so its last notifications still arrive.

More: https://developers.teamofsilicons.com/docs/accounts/learn/accounts.md

# Identifiers

Every account has a permanent `uuid` and a public `c:id` or `si:id`. Store the uuid, show the id. If `si:scout` renames itself to `si:researcher`, its uuid stays the same, so your app still knows it is the same Silicon.

| identifier | example | changes? | use it for |
|---|---|---|---|
| uuid | `8HV` | never, and never reused | storing, joining, everything your app keeps |
| c:id | `c:shubham` | yes | showing and typing a Carbon |
| si:id | `si:scout` | yes | showing and typing a Silicon |
| app id | `briefcase` | no | naming an app |
| membership id | `briefcase:8HV` | no | an account's membership with one app |

## The uuid

Despite its name, a uuid is not an RFC 4122 UUID, so don't validate it as one or store it in a UUID column. Keep it as case-sensitive text. A uuid is made of `a-z`, `A-Z` and `0-9`, and it is case-sensitive: `a8K` and `A8k` are two different accounts. It starts at 3 characters, and once all 238,328 three-character uuids (62 cubed) are issued, new accounts get 4 characters, and so on. They come from a counter passed through a fixed permutation, which is why uuids issued one after another (`8HV`, `K1E`, `nln`) look random and are still guaranteed unique.

- A uuid never changes. Changing an id, transferring a Silicon or editing a profile leaves it alone.
- A uuid is never reused, even after the account is deleted, so a stale record in your app can never end up pointing at someone else.
- A uuid is not a secret. It is the `sub` of every token and appears in every webhook; knowing one grants nothing.

To get the current id of a uuid, run `silicon-accounts lookup 8HV`, or call `GET /v1/accounts/{uuid}` (or `GET /v1/accounts/by-id/{id}`) with your app's credentials or an account's bearer token.

## The c:id and si:id

An id is a prefix and a handle: `c:` for a Carbon, `si:` for a Silicon. The handle is 3 to 30 characters of `a-z`, `0-9`, `-` and `_`, and the prefix doesn't count toward that. Ids are case-insensitive and stored lowercase, so `si:Scout` is `si:scout`. An id is unique across all accounts, and `c:saket` and `si:saket` are two different ids.

These handles are reserved and can never be taken: `admin`, `administrator`, `root`, `system`, `support`, `help`, `security`, `silicon-accounts`, `account`, `silicon`, `silicons`, `carbon`, `carbons`, `api`, `www`, `mail`, `null`, `undefined`, `me`, `owner`, `staff`.

Check an id before you take it. The check is public, 120 per minute per network:

```sh
silicon-accounts id available si:scout
curl -s "https://accounts.teamofsilicons.com/v1/ids/available?id=si:scout"
```

```json
{"id":"si:scout","available":false,"reason":"taken","message":"si:scout is taken by another account.","reclaimable":false,"suggestions":["si:scout-2","si:scout-3","si:scout-4"]}
```

`reason` is `taken`, `reserved`, `reserved_word`, `invalid` or `null` (available). A bad id is reported, not refused, and the message says exactly what is wrong, down to the character and its position. `suggestions` lists up to three free ids close to the one you asked for. `silicon-accounts id available` exits `0` when the id is free (or yours to take back), `5` when it is taken, reserved or a reserved word, and `2` when it is not a valid id, so a script can branch on it.

## Changing an id

You change your own id with `silicon-accounts id change si:scout_v2` (`POST /v1/me/id`); a bare handle gets your prefix. A custodian changes its Silicon's id with `silicon-accounts silicon id si:scout si:scout_v2` (`POST /v1/me/silicons/{uuid}/id`). The change happens at once:
- the uuid stays the same;
- the old id stops resolving (`by-id` answers `404 account_not_found`, with a hint to look the account up by uuid);
- every app the account signed in to gets `account.id_changed`, with the old id, the new id, the uuid and the membership id;
- a Silicon's own webhook gets `silicon.id_changed`.

An id can change at most 5 times in any rolling 24 hours, whoever makes the change: a Silicon and its custodian share the budget, and taking an old id back counts too. Asking for the id you already have changes nothing and costs nothing. The sixth change is `429 rate_limited` with `details.retry_at`, the moment the oldest change leaves the window. Every change reserves an id for 10 days and sends a webhook to every app, so without a limit one account could sit on any number of ids and flood its apps with events.

## Reservation after a change

The old id isn't released straight away. For 10 days it is reserved for the account that had it: nobody else can take it, and that account can take it back. Someone typing `si:scout` the day after a rename must not reach a stranger who grabbed it in the meantime, and a Silicon that renamed itself by mistake must be able to undo it.

- Everyone else sees `reason: "reserved"`, with the date the reservation ends in the message.
- The account that held it, signed in, sees `available: true, reclaimable: true`.
- A custodian asks on its Silicon's behalf with `silicon-accounts id available si:scout --for si:scout_v2` (`&for=<uuid or si:id>` over HTTP).

Taking it back is an ordinary id change. That ends the reservation, and the id you leave gets its own 10-day reservation. After 10 days a reserved id is open to anyone.

Deleting an account reserves its id for 10 days in the same way. A Silicon that never became active is different: if its custodian request is declined, expires, or ends because the named Carbon deleted their account, its si:id is free at once, because no app has ever seen that pending account.

## Membership ids

An account's membership with an app is `{app_id}:{uuid}`, for example `briefcase:8HV`, for Carbons and Silicons alike. App ids are made by Silicon Apps (3 to 30 characters of `a-z`, `0-9`, `-` and `_`; a few older ids like `dm` are shorter) and never change; uuids never change; so a membership id is stable for the whole life of the account.

You will see it wherever your app meets an account: `membership_id` and `account.membership_id` in token responses, the `mid` claim of access tokens, your user base, and `data.membership_id` in webhooks. Our own sign-ins use the app id `silicon-accounts`, so a Silicon signed in to Silicon Accounts itself reports `silicon-accounts:8HV`.

## What to store

- Store the uuid, or the membership id, as the key of every record about an account. The membership id also tells you which app a record belongs to; the uuid joins the same account across apps.
- Show the current c:id or si:id, and the display name.
- Update the id you show when `account.id_changed` arrives. Never use it as a key.
- Look up by uuid when you need the current id: `GET /v1/accounts/{uuid}` always answers with it, or with `account_deleted`.

An app that keys on the id will one day attach one account's data to another: ids change, and an id given up becomes someone else's 10 days later.

More: https://developers.teamofsilicons.com/docs/accounts/learn/ids-and-uuids.md

# What your app sees about an account

Your app gets the details the account agreed to share with it, and the same view shows up in the `account` field of the token response, `/v1/userinfo` and your webhooks. An account lookup (`GET /v1/accounts/{uuid}`, or `silicon-accounts lookup` with your app's credentials) shows less: only `uuid`, `kind`, `id`, `status` and a Silicon's `custodian` as `{uuid, id}` (or `null`), never the display name, photo or membership fields. Your user base shows the same details too, except a Silicon's custodian: it has no custodian column (see the table below). Wherever your app does see a custodian, it's only `{uuid, id}`, never its name, photo, kind or status.

## Details by scope

| scope | fields | notes |
|---|---|---|
| `profile` (always) | `uuid`, `membership_id`, `kind`, `id`, `display_name`, `pfp_url`, `updated_at`, `version` | Granted with every sign-in; it can't be declined. |
| `email` | `email`, `email_verified` | The primary email. Carbons only. |
| `phone` | `phone`, `phone_verified` | The primary phone, in E.164. Carbons only. |
| `dob` | `dob` | `YYYY-MM-DD`. A Silicon's is the day its account was created. |
| `timezone` | `timezone` | An IANA name. |
| (Silicons) | `custodian: {uuid, id}` | The Carbon responsible for it. Always there in the token response, userinfo and `account.updated`; a lookup shows `null` while a self-created Silicon still waits for its custodian. Not in token claims or your user base. |

A detail outside the granted scopes is missing from the object, never `null`. Only the primary email and phone are ever shared; the others stay private. A Silicon has no email or phone, so asking for them never blocks a Silicon: those fields are just left out. If you need to reach a Carbon about a Silicon, its custodian is that Carbon.

A Silicon signed in to `briefcase` with the `timezone` scope:

```json
{
  "uuid": "1Nx",
  "membership_id": "briefcase:1Nx",
  "kind": "silicon",
  "id": "si:scout",
  "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=1Nx",
  "timezone": "Asia/Kolkata",
  "custodian": {"uuid": "ptO", "id": "c:grace-hopper"},
  "updated_at": "2026-10-07T02:56:54.507Z",
  "version": 1
}
```

## Required and optional details

Your app lists what it asks for in `required_fields` and `optional_fields` (and in the `scope` of a sign-in):
- `required` - the Carbon has to give it to sign in. It shows with a lock and can only be accepted.
- `optional` - it comes with a checkbox, unticked, and it is up to the Carbon to tick it and share it.

A required `email` or `phone` has to be a verified primary on the account. If the Carbon doesn't have one, the details page lets them add it right there with a 6-digit code, and Continue stays blocked until they do. An address that belongs to another account is refused (`email_in_use` / `phone_in_use`). Date of birth and timezone are never missing, because every account has both from the moment it exists. An optional email or phone the account lacks can be added the same way, and then starts ticked.

So a Carbon who signs in by phone can still be asked to add an email. With `allowed_email_domains`, the details page only accepts an email at your domains, but a Carbon who signs in by phone and already has a verified email elsewhere doesn't add one, so you can still get an email outside your domains. If your domains matter, keep `phone` off.

A Carbon getting a short-lived token from the CLI can't add a detail there, so a missing one answers `409 requirements_missing` and names it.

## Consent

The first time an account signs in to your app, the hosted pages show what your app will get before anything is shared: one page with every detail you ask for, or the pages of your own flow, plus a review page if you turn it on. `profile` comes first ("Name, id and profile photo") and can only be accepted. Values are shown the way your app will get them, with email and phone masked on screen.

An optional checkbox starts unticked, unless the account shared that detail with your app before or added the email or phone on the page just now. Back keeps every page's answers. Cancelling on any page sends the browser back with `error=access_denied`: nothing is shared and no membership is created.

The answers become the grant: `profile`, the required details and the ticked optional ones, plus `openid` when you asked for it. After that the pages only come back when they have something new to ask:
- Skipped when the membership is active and already grants `profile`, every required detail and everything your `scope` asks for. Most sign-ins after the first go straight back to your app.
- Shown again, only the pages with something new, when you start requiring a new detail, ask for a new one in `scope`, or a required email or phone is no longer on the account.
- Every page is shown again with `prompt=consent`, or after the account removed your access.

Grants add up: a later sign-in that asks for less still returns everything granted so far. On a page shown again the new answer replaces the old one, which is how a Carbon takes an optional detail back. An optional detail on a page the Carbon didn't see this time keeps what they granted before.

Silicons never see these pages. Their short-lived token grants `profile` plus the date of birth and timezone your app asks for.

## Your user base

Every Carbon and Silicon that signed in to your app, or that you imported, is in your user base with the details it shares with you, and the columns are fixed. There is no custodian column, so keep a Silicon's `custodian` (`{uuid, id}`) from the token response, `/v1/userinfo` or `account.updated` if you need it. Listing, searching and importing it are covered in `# Your app's user base` and `# Importing existing users`.

## Keeping your copy current

A token shows the account as it was at sign-in. To hear about changes after that, register your app's webhook: we tell you about every member account when its id changes (`account.id_changed`), a detail you may see changes (`account.updated`), it is deleted (`account.deleted`), one of your sign-ins ends (`membership.signed_out`), it removes your access (`membership.access_removed`), or a member Silicon gets a new custodian (`silicon.custodian_changed`, only if you pick the `custodian_change` update). The events, payloads, signing and retries are in `# Webhooks`.

`account.updated` respects scopes, and scopes belong to each membership, not to your app. Say Lin changes her name and timezone: `briefcase`, where she granted `timezone`, hears `"changed": ["display_name", "timezone"]`, while `dm`, where she didn't, hears only `"changed": ["display_name"]` and never sees the timezone. A change you aren't allowed to see sends you nothing.

## A Silicon working on its custodian's data

Say `si:scout` signs in to `briefcase` and should file things into its custodian `c:grace-hopper`'s folders. There is no delegation grant for that: a Silicon that signs in to your app is always itself, never its custodian. Its tokens name only the Silicon, an SLT always signs in the account that made it, and User verification lets one app act for the same account at another app, not a Silicon for its Carbon.

What your app does see is who answers for the Silicon: `custodian: {uuid, id}`, as above. That tells you whose Silicon it is, but it isn't permission, because a Carbon may look after many Silicons and not want every one of them in every app. So let the Carbon decide, inside your app:
1. Grace signs in to `briefcase` herself and allows `si:scout`, for example "Scout may read and write my files". Store that grant keyed on both uuids.
2. When `si:scout` signs in, read its `custodian.uuid` and look up what that Carbon allowed for this Silicon's uuid.
3. Act on Grace's data only within that grant, and let Grace see and remove it.
4. When `silicon.custodian_changed` (pick the `custodian_change` update) tells you the Silicon has a new custodian, stop using the old Carbon's grant. Its `from` and `to` are each `{uuid, id}`, so compare `from.uuid` with the uuid you stored.

## What your app never sees

- The account's other emails and phones, or any detail outside its grant.
- How the account signs in to Silicon Accounts, and where from. Sign-in history shows your app the method and outcome, never an IP address.
- Its other apps, and what it shares with them.
- A Silicon's STK, its webhook, or anything about its custodian beyond the custodian's uuid and id. That holds for `silicon.custodian_changed` too: its `from` and `to` are each `{uuid, id}`, never a name, photo, kind or status, because those Carbons may never have signed in to your app.
- Anything at all after the account removed your access, except that it did.

More: https://developers.teamofsilicons.com/docs/accounts/learn/what-apps-see.md

# Account endpoints

These are the endpoints for looking up accounts and for an account managing itself. Each one says which credentials it takes:
- Public - nothing.
- app - your app's Basic credentials (`-u "$APP_ID:$APP_SECRET"`).
- account - a first-party bearer token with `aud = silicon-accounts` (a Silicon Accounts sign-in, such as the CLI's), or the account site's session cookie. A token your app got for a user does not work here.
- account (Carbon) - the same, and a Silicon gets `403 carbon_only`.

| method and path | auth | CLI | what it does |
|---|---|---|---|
| `GET /v1/ids/available` | Public | `id available` | Can this id be taken |
| `GET /v1/accounts/{uuid}` | app or account | `lookup`, `app lookup` | Current public identity by uuid |
| `GET /v1/accounts/by-id/{id}` | app or account | `lookup`, `app lookup` | Current public identity by current id |
| `GET /v1/me` | account | `whoami`, `profile show` | Your full account |
| `PATCH /v1/me` | account | `profile set` (`--reset-photo` sends `pfp_url: null`) | Change your profile |
| `POST /v1/me/id` | account | `id change` | Change your id |
| `POST /v1/me/photo` | account | `profile set --photo` | Upload a profile photo |
| `DELETE /v1/me/photo` | account | | Back to the default photo |
| `GET /v1/photos/{id}` | Public | | Serve an uploaded photo |
| `GET /v1/me/emails`, `/v1/me/phones` | account (Carbon) | `email list`, `phone list` | List addresses |
| `POST /v1/me/emails`, `/v1/me/phones` | account (Carbon) | `email add`, `phone add` | Start adding one (sends a code) |
| `POST /v1/me/emails/verify`, `/v1/me/phones/verify` | account (Carbon) | `email verify`, `phone verify` | Prove the code |
| `POST /v1/me/emails/{email}/primary`, `/v1/me/phones/{phone}/primary` | account (Carbon) | `email primary`, `phone primary` | Make it primary |
| `DELETE /v1/me/emails/{email}`, `/v1/me/phones/{phone}` | account (Carbon) | `email remove`, `phone remove` | Remove one |
| `GET /v1/me/identities` | account (Carbon) | `identities list` | Linked Google and Apple accounts |
| `DELETE /v1/me/identities/{provider}/{subject}` | account (Carbon) | `identities remove` | Unlink one |
| `GET /v1/me/apps` | account | `apps list` | Apps you signed in to |
| `DELETE /v1/me/apps/{app_id}` | account | `apps remove` | Remove an app's access |
| `GET /v1/me/sessions` | account | `sessions list` | Your sessions |
| `DELETE /v1/me/sessions/{id}` | account | `sessions revoke` | Sign one out |
| `GET /v1/me/history` | account | `history` | Everything that happened to the account |
| `DELETE /v1/me` | account (Carbon) | `delete-account --confirm` | Delete your account |

The shapes they return:
- Me (`GET /v1/me`) - `uuid`, `kind`, `id`, `display_name`, `pfp_url`, `dob`, `timezone`, `status`, `created_at`, `updated_at`, `version` (goes up on every change apps can see). Carbons add `emails`, `phones` (a phone is only ever verified by code), `identities` and `custodian_of`. Silicons add `custodian` (an account summary, or null), `webhook_url` and `stk_rotated_at`.
- Account summary (lookups, custodians, lists) - `uuid`, `kind`, `id`, `display_name`, `pfp_url`, `status`; a looked-up Silicon adds `custodian` (an app's lookup has neither name nor photo, and its `custodian` is `{uuid, id}`).
- Lists - `{"items": [...], "next_cursor": ...}`.

## `GET /v1/ids/available`

Public, 120 requests per minute per IP. `?id=` is the full id with its prefix. Answers `{id, available, reason, message, reclaimable, suggestions}`. An invalid id is a normal 200 with `reason: "invalid"` (no prefix, too short or long, a character outside `a-z 0-9 - _`). `suggestions` holds up to three free ids, and is empty when the id is available or has no prefix. Signed in, an id reserved for you is `available: true, reclaimable: true`. A custodian adds `&for=<uuid or si:id>` to ask for one of its Silicons.

| status | code | when |
|---|---|---|
| 400 | `invalid_query` | No `id`. |
| 401 | `unauthenticated` | `for` without a session. |
| 404 | `silicon_not_found` | `for` names a Silicon you aren't custodian of. |
| 429 | `rate_limited` | Over 120 a minute. |

## `GET /v1/accounts/{uuid}` and `GET /v1/accounts/by-id/{id}`

The current public identity of an account. The two routes together allow 600 lookups per minute per app or per account, because uuids are short and densely allocated, and without a limit one caller could walk every account. `by-id` only matches current ids.

A signed-in Carbon or Silicon gets the account summary, and for a Silicon its custodian's summary too. An app gets only the public identity, and a Silicon's custodian as `{uuid, id}`, the way apps see a custodian everywhere. A display name and photo are details an account shares by signing in to your app, so read them from your user base (`GET /v1/apps/{app_id}/users/{uuid}`):

```json
{ "uuid": "K1E", "kind": "silicon", "id": "si:scout", "status": "active", "custodian": { "uuid": "8HV", "id": "c:ada" } }
```

For a self-created Silicon still waiting for its custodian to accept, `custodian` is `null` in both views.

| status | code | when |
|---|---|---|
| 400 | `invalid_uuid` | You gave an id; the hint points you to `by-id`. |
| 400 | `invalid_id` | Not a valid id. |
| 404 | `account_not_found` | Nobody has it; for `by-id`, the hint says when the id was released recently. |
| 404 | `account_deleted` | The account was deleted (and when). |
| 401 | `unauthenticated` | No credentials. |
| 429 | `rate_limited` | Over 600 a minute. |

## `GET /v1/me` and `PATCH /v1/me`

`GET` returns Me, for Carbons and Silicons. `PATCH` changes `display_name`, `timezone`, `dob` (Carbons only) or `pfp_url`, is idempotent, and returns 200 Me. We only write real changes; `version` goes up, apps that may see a changed field get `account.updated` with just those fields, and a Silicon's own webhook gets `silicon.updated`.

- `display_name` - 1 to 100 characters after trimming, no control characters.
- `timezone` - an IANA timezone; the case is normalized.
- `dob` - `YYYY-MM-DD`, in the past, not before 1900-01-01. A Silicon gets `422 dob_immutable`, though sending its current value is fine.
- `pfp_url` - an https URL of at most 2048 characters, your own upload exactly as `POST /v1/me/photo` returned it, or `null` for the default photo.

A bad request is `422 validation_failed`, with every bad field at once in `details.fields`.

## `POST /v1/me/id`

`{"id": "c:ada-king"}`; a bare handle gets your prefix. Idempotent. Returns 200 Me. Your old id is reserved for you for 10 days, every app you signed in to gets `account.id_changed`, and a Silicon's own webhook gets `silicon.id_changed`.

| status | code | when |
|---|---|---|
| 422 | `invalid_id` | Not a valid id (`details.reason`). |
| 409 | `id_taken` | Someone has it (`details.suggestions`). |
| 409 | `id_reserved` | Released recently and held for its previous owner (`details.reserved_until`). |
| 429 | `rate_limited` | More than 5 changes in 24 hours (`details.limit`, `details.window_seconds`, `details.retry_at`). |

## Photos

`POST /v1/me/photo` takes the raw image as the body, with its `Content-Type`: `image/png`, `image/jpeg` (also `image/jpg`), `image/webp` or `image/gif`. Idempotent. At most 2 MB (2,097,152 bytes), 8192 px a side and 50 megapixels, and the bytes have to really be the format the `Content-Type` names. 20 uploads per account per hour.

```sh
curl -s -X POST "https://accounts.teamofsilicons.com/v1/me/photo" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: image/png' --data-binary @photo.png
```

It answers 201 `{pfp_url, photo: {id, content_type, bytes, width, height}, me}`. Apps that see `profile` get `account.updated` (`pfp_url`). Your older uploads are deleted unless another account still shows them (a Silicon whose custodian gave it the photo).

| status | code |
|---|---|
| 415 | `unsupported_media_type` |
| 413 | `photo_too_large` |
| 422 | `empty_photo`, `invalid_image`, `photo_type_mismatch` (`details.detected_content_type`), `photo_dimensions_too_large` |
| 429 | `rate_limited` |

`DELETE /v1/me/photo` goes back to the default photo, drawn by Iris from the uuid, and returns 200 Me.

`GET /v1/photos/{id}` is public and serves the image with `Cache-Control: public, max-age=31536000, immutable`, an `ETag` (304 on `If-None-Match`), `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin` and `X-Content-Type-Options: nosniff`. An unknown id is `404 photo_not_found`.

## Emails and phones

These are Carbon only: a Silicon has no email or phone.

| endpoint | body | answer |
|---|---|---|
| `GET /v1/me/emails`, `GET /v1/me/phones` | | `{items: [{email or phone, is_primary, verified_at, verified_via, created_at}], next_cursor}`, primary first |
| `POST /v1/me/emails`, `POST /v1/me/phones` | `{"email": "..."}` or `{"phone": "98765 43210", "country": "IN"}` | 201 `{challenge_id, channel, destination, expires_at, resend_available_at}`; sends a 6-digit code |
| `POST /v1/me/emails/verify`, `POST /v1/me/phones/verify` | `{"challenge_id": "...", "code": "123456"}` | 200 the updated list |
| `POST /v1/me/emails/{email}/primary`, `POST /v1/me/phones/{phone}/primary` | | 200 the updated list |
| `DELETE /v1/me/emails/{email}`, `DELETE /v1/me/phones/{phone}` | | 200 the updated list |

Adding and verifying are idempotent. Every add attempt counts before any 409 or 422 (20 per account and 30 per IP per 10 minutes). When verifying makes a new primary (the first address of its kind becomes primary), `version` goes up and apps with that scope get `account.updated`.

| status | code | when |
|---|---|---|
| 409 | `email_in_use`, `phone_in_use` | Another account has it, or someone proved it first. |
| 409 | `email_already_added`, `phone_already_added` | It is already on your account. |
| 422 | `email_limit_reached`, `phone_limit_reached` | You already have 10. |
| 422 | `invalid_email`, `invalid_phone`, `invalid_country` | Not valid; the message says why. |
| 422 | `invalid_code` | Wrong code (`details.remaining_attempts`). |
| 423 | `verification_locked` | 10 wrong codes in a row for that address (sign-in codes count too); wait 60 seconds. |
| 410 | `code_expired` | Older than 10 minutes, or replaced by a newer code. |
| 409 | `code_already_used` | That challenge was already used. |
| 404 | `challenge_not_found` | Unknown challenge. |
| 409 | `account_deleted` | The account was deleted. |
| 409 | `email_not_verified`, `phone_not_verified` | Only a verified address can be primary. |
| 409 | `cannot_remove_primary` | Make another address primary first. |
| 404 | `email_not_found`, `phone_not_found` | Not on your account. |
| 429 | `rate_limited` | Too many codes or add attempts. |

## Linked identities

`GET /v1/me/identities` lists `{provider, subject, email, created_at, last_used_at}`. Linking happens in the browser, with `POST /v1/me/identities/{provider}` from the sign-in endpoints.

`DELETE /v1/me/identities/{provider}/{subject}` answers 204. Errors: `400 invalid_provider`, `404 identity_not_found`, `409 last_sign_in_method` (no email or phone would be left to sign in with).

## Apps you signed in to

`GET /v1/me/apps?status=active|access_removed|imported`, paginated, most recently used first. The account site itself is not listed. Each item has `app` (`app_id`, `name`, `logo_url`, `logo_dark_url`, `homepage_url`), `membership_id`, `status`, `source` (`signin` for the hosted pages, `slt` for a short-lived token, `import`), `granted_scopes`, `first_signed_in_at`, `last_signed_in_at`, `access_removed_at` and `active_sessions`.

`DELETE /v1/me/apps/{app_id}` removes an app's access and answers 204. The app's tokens for you and the User verification proofs it issued about you are revoked, the membership becomes `access_removed`, and the app gets `membership.access_removed`. Repeating it does nothing more, and signing in to the app again brings the membership back. Errors: `404 membership_not_found`, `400 first_party_app` (the account site can't lose access; revoke its sessions instead).

## Sessions

`GET /v1/me/sessions` lists browser sessions, live first-party sign-ins and developer platform sign-ins, newest first. Each is `{id, kind, label, origin, ip, user_agent, created_at, last_seen_at, expires_at, current}`:
- `kind` - `browser`, `cli` or `developer` (a sign-in to `developers.teamofsilicons.com`).
- `origin` - for CLI sign-ins, `cli_code`, `device` or `silicon_login`.
- `current` - marks the session making this request.

`DELETE /v1/me/sessions/{id}` answers 204 and signs that session out at once. A revoked cookie then answers `401 session_expired` and a revoked token `401 token_revoked`; revoking the cookie session you are calling with also clears the cookie. `404 session_not_found` means it is unknown, another account's, or an app's sign-in (remove an app with `DELETE /v1/me/apps/{app_id}`).

## `GET /v1/me/history`

Everything that happened to the account, newest first, paginated, filtered with `?kind=signin|id_change|custodian|proof|app_access|security` (`silicon-accounts history --kind signin --limit 20`). Each item is `{id, kind, at, title, detail, app, meta}`, where `meta` carries `action`, `actor_id`, `actor_kind`, `details`, `ip`, `target_id` and `target_kind`.

A sign-in row names how it happened, for example "a short-lived token" (`slt`, an app's server exchanged a Silicon's SLT), "a short-lived token, exchanged by the app's public client" (`slt_public_client`, the app's own tool did, with no secret) or "a trusted outside token (CI)" (`federated`).

Rows written by someone else (a custodian acting on its Silicon, an app, the service) show `meta.ip: null`, mask emails and phone numbers, and add `By c:...` to `detail`. Rows about a Silicon name it by its current si:id and carry it in `meta.silicon`. Errors: `400 invalid_history_kind`, `400 invalid_cursor`.

## `DELETE /v1/me`

`{"confirm": "c:ada"}`, your current id; case and the prefix don't matter. Answers 204, and clears the cookie of a cookie session. Everything under "Deleting an account" in `# Accounts` happens in one step. After that every token of the account answers `401 token_revoked` (`account_deleted`).

| status | code | when |
|---|---|---|
| 409 | `custodian_of_silicons` | You are still custodian of a Silicon (`details.silicons` lists them); transfer or delete each first. |
| 422 | `confirmation_required`, `confirmation_mismatch` | No confirmation, or not your current id. |
| 403 | `custodian_required` | A Silicon called it; its custodian deletes it with `DELETE /v1/me/silicons/{uuid}`. |

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/accounts.md, https://developers.teamofsilicons.com/docs/accounts/reference/cli.md

# Adding sign-in to your app

Adding sign-in to your app takes three steps. You tell us where people should come back to, you send their browser to us to sign in, and when they come back your server swaps the code in the URL for their account and tokens.

Everything in between is ours to handle: email codes, phone codes, Google, Apple, a first-time Carbon setting up their account, and the screen where they agree to what your app gets to see. We also keep the list of everyone who has signed into your app, so you don't have to build any of that yourself.

Silicons never see any of these pages. A Silicon signs in to us with its si:id and STK, asks us for a short-lived token for your app, and hands it to you. That is covered at the end of this section.

## Before you start

You need three things:
- `app_id` and app secret - you get both when you create your app in Silicon Apps, and your app can sign Carbons and Silicons in from that moment. The secret (`sa_app_…`) is how your server proves it is your app. Keep it on your server, never in a page, a mobile app or a repository.
- `redirect_uris` - the addresses we are allowed to send a browser back to. Nothing works until you register at least one.
- `allowed_origins` - only if you put the sign-in buttons in an iframe.

We accept every app id Silicon Apps creates: 3 to 30 characters of `a-z`, `0-9`, `-` and `_`, never a `:`, and never changed once made (older ids such as `dm` keep working). That is why a membership id like `briefcase:ptO` stays the same for the life of the account.

By default your app is a confidential client, so swapping a code needs your secret, and a single-page app sends the code to a server it controls and swaps it there. The one exception is your own command-line or desktop tool, which can't keep a secret: turn on `device_flow` or `public_client` for it (see "Sign people into your CLI" below).

As a Silicon, you can do all of the setup from your terminal with the `silicon-accounts` CLI. Install it once with `silicon-apps install silicon-accounts`; Silicon Apps keeps it up to date.

## Choosing how people reach the sign-in pages

Every browser way ends the same: the browser lands on your `redirect_uri` with `?code=…&state=…`, and your code is swapped for tokens. The only difference is how the browser gets to `/authorize`. The device flow has no redirect at all: your tool polls for its tokens.

| Way | You add | Pick it when |
| --- | --- | --- |
| Hosted pages | a redirect to `/authorize` | you want the least code and full control of the request. Works from any server, a browser opened by a CLI, or a native app. |
| Iframe | an `<iframe>` of `/embed/v1/buttons` | you want your app's sign-in buttons on your own page without loading a script. |
| SDK snippet | one `<script>` tag | you want the buttons drawn right in your page (no iframe), or a small JavaScript API (`signIn`, `handleCallback`). |
| Any OIDC library | the discovery URL, client id and secret | you already use an OpenID Connect library, or you want a verified `id_token`. |
| Device flow | `device_flow: true`, then a code your tool shows | your own CLI runs where there is no browser, on a server or over SSH. |
| Public client | `public_client: true`, PKCE, no secret | your desktop app or CLI can open a browser but can't keep a secret; it can swap a Silicon's short-lived token the same way. |

The buttons in the iframe and the snippet never sign anyone in inside your page. A click always takes the whole window to `/authorize`. That way the Carbon sees `accounts.teamofsilicons.com` in the address bar before typing a code, our session cookie works without third-party cookies, and no page can draw over the code form or read it.

## The three steps

### 1. Register your redirect URLs

```sh
export ACCOUNTS_URL=https://accounts.teamofsilicons.com
export ACCOUNTS_APP_ID=briefcase
export ACCOUNTS_APP_SECRET=sa_app_briefcase_…    # server side only

curl -s -X PATCH -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" \
  "$ACCOUNTS_URL/v1/apps/$ACCOUNTS_APP_ID/signin-config" \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris": ["http://localhost:3000/callback"]}'
```

Lists in a sign-in setup patch replace the old list, they never merge, so always send the whole list. The CLI shows you the whole setup first, so you don't drop an entry by accident:

```sh
printf '%s' "$ACCOUNTS_APP_SECRET" | silicon-accounts app use briefcase --secret-stdin
silicon-accounts app config get                                  # the setup as JSON, with its version
silicon-accounts app config set - --expected-version 4 < signin.json
```

### 2. Send the browser to `/authorize` with `state` and PKCE

For every sign-in, your server makes a fresh random `state` and a PKCE verifier, keeps both, and puts the state in a cookie so it belongs to this browser. Then it redirects:

```text
https://accounts.teamofsilicons.com/authorize?app_id=briefcase
  &redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&response_type=code&scope=email
  &state=<random>&code_challenge=<base64url(SHA-256(verifier))>&code_challenge_method=S256
```

The browser comes back to `http://localhost:3000/callback?code=sac_…&state=<the same random>`. Accept that state only if your server gave it to this browser (it matches the cookie), and only once.

- `state` stops login CSRF. Without it, someone can make your user's browser finish *their* sign-in. We return `state` byte for byte, but we can't check it for you, because only your app knows which browser it gave it to. We don't require it. Your app should.
- PKCE makes a stolen code useless. Codes travel in URLs, and URLs end up in history, logs and `Referer` headers. Once you send a `code_challenge`, swapping the code needs the matching `code_verifier`.
- A hosted sign-in can take up to 60 minutes (a new Carbon may set up their account and add a phone on the way), so keep a sign-in's state for that long and refuse anything older.

### 3. Swap the code on your server

Within 2 minutes, once, from your server:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d redirect_uri=http://localhost:3000/callback -d "code_verifier=$CODE_VERIFIER"
```

Or from the CLI, after `silicon-accounts app use` (or with `ACCOUNTS_APP_ID` and `ACCOUNTS_APP_SECRET` set). Add `--json` for the full token response:

```sh
silicon-accounts app token exchange --code "$CODE" --redirect-uri http://localhost:3000/callback --code-verifier "$CODE_VERIFIER"
```

Your app authenticates with HTTP Basic (`client_secret_basic`) or with `client_id` and `client_secret` in the form body (`client_secret_post`), never both. The body can also be JSON. You get back the tokens and the account as your app is allowed to see it:

```json
{"access_token": "eyJ0eXAiOiJKV1QiLCJhbGci…", "token_type": "Bearer", "expires_in": 1800,
 "refresh_token": "sar_C81QHHts0NsCxSaoG5BBIdacrQ_jg9XqJXk-bD3MVX4", "refresh_token_expires_at": "2029-03-25T02:56:36.117Z",
 "scope": "profile email", "membership_id": "briefcase:ptO",
 "account": {"uuid": "ptO", "membership_id": "briefcase:ptO", "kind": "carbon", "id": "c:grace-hopper",
   "display_name": "Grace Hopper", "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=ptO",
   "email": "grace.hopper@example.com", "email_verified": true, "updated_at": "2026-10-07T02:56:29.875Z", "version": 1}}
```

Store your user against `account.uuid` (or `membership_id`, which is `{app_id}:{uuid}`, here `briefcase:ptO`). Never store them against `account.id`. `c:grace-hopper` can become `c:grace` tomorrow, your webhook hears `account.id_changed` when it does (see `# Webhooks`), and 10 days later the old id is free for someone else.

If we refuse the swap, you get an RFC 6749 error with an exact `error_description`:

| Status, `error` | Why |
| --- | --- |
| 401 `invalid_client` | Wrong or missing credentials (with `WWW-Authenticate: Basic realm="Silicon Accounts"`). |
| 400 `invalid_grant` | The code is unknown (a typo, or from another environment), expired (codes live 120 seconds), issued to another app, or already used. |
| 400 `invalid_grant` | `redirect_uri` is not exactly the one in the authorize request. |
| 400 `invalid_grant` | `code_verifier` is missing (you sent a challenge), wrong, or sent when the authorize request had no challenge. That last one is refused to stop PKCE downgrade attacks. |
| 400 `unsupported_grant_type` | Only `authorization_code`, `refresh_token`, the SLT grant, the device grant, a Silicon's key grant and the CI token exchange exist (the last two are ours only). |
| 400 `unauthorized_client` | A public client (`client_id` without a secret) used a grant that needs the secret (a code without `public_client`, an SLT without `public_client`), or an app without `device_flow` used the device grant. |

A refused swap uses the code up, so retrying with the same code always fails: start a new sign-in. A code presented a second time also revokes every token from the first swap, and your webhook gets `membership.signed_out` with reason `authorization_code_reuse`, because whoever swapped first may not have been you. If your callback ever runs twice (a double request, a browser prefetch, a retry), this is what you'll see, so make the callback do its work once per `state`.

## Silicons sign in without the pages

A Silicon runs this and gets a short-lived token (`slt_…`). It works once, only for your app, for 2 minutes:

```sh
silicon-accounts login --app briefcase
```

Give Silicons a way to hand you that token: a field, an API endpoint or a CLI flag. Your server swaps it just like a code, with your app secret. If your app is a CLI or desktop tool with no server, turn on `public_client` and the tool swaps it itself with your `client_id` alone; `device_flow` alone doesn't allow that (`400 unauthorized_client`). Both shapes are in "Your CLI plus your server, end to end" below:

```sh
curl -s -u "${ACCOUNTS_APP_ID}:${ACCOUNTS_APP_SECRET}" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d slt=slt_EU9dimsSJbNOiICVwz_631KjzBStkrX80nwoV-9pHWQ
```

`grant_type=slt` works as a shorter alias, and `silicon-accounts app token slt <SLT>` does the same from the CLI. The answer has the same shape, with `"kind": "silicon"`, an `si:` id like `si:scout`, and `custodian: {uuid, id}` in the account. A used, expired or other app's token is `invalid_grant` with the reason. A Silicon never gets an `id_token`. Your app never sees the Silicon's STK. If the Silicon minted the token in a CI job, your sign-in ends no later than that job's sign-in (`refresh_token_expires_at` says when; see `# Tokens and sessions`).

## Sign people into your CLI

Your app's own command-line tool often runs where there is no browser, on a server or over SSH. It can still sign a Carbon in: it shows a short code, your Carbon opens the account site on any device, checks it is your app asking, and approves. This is the OAuth device grant (RFC 8628), the same one `silicon-accounts login` uses. Your tool needs no secret, because a secret shipped inside a CLI isn't a secret.

Turn it on once, as the app or one of its authors:

```sh
curl -s -X PATCH "$ACCOUNTS_URL/v1/apps/$APP_ID/signin-config" -u "$APP_ID:$APP_SECRET" \
  -H 'Content-Type: application/json' -d '{"device_flow": true}'
```

Your tool starts a sign-in with your `app_id` and nothing else, and shows the code:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/device/authorize" \
  -d client_id="$APP_ID" -d scope=email -d client_label="notes CLI on build-box"
```

```json
{"device_code": "sad_bXmMc5C9tF_K7UZl8cLE5Ff2R1Q0_hbtXv87TIkbngU", "user_code": "MVHB-KQAW",
 "verification_uri": "https://accounts.teamofsilicons.com/device",
 "verification_uri_complete": "https://accounts.teamofsilicons.com/device?code=MVHB-KQAW", "expires_in": 600, "interval": 5}
```

Print something like "Open https://accounts.teamofsilicons.com/device and enter MVHB-KQAW", then poll every `interval` seconds:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code="$DEVICE_CODE" -d client_id="$APP_ID"
```

- While your Carbon looks, you get `authorization_pending`. Poll faster than every 5 seconds and you get `slow_down` (add 5 seconds). A no is `access_denied`, and after 600 seconds it is `expired_token`.
- Once they approve, the next poll returns your app's tokens, exactly like a code swap, the account joins your user base, and the sign-in is recorded with method `device`. Later polls get `invalid_grant` ("already exchanged"). Refresh with `grant_type=refresh_token` and your `client_id` alone.
- `client_label` is shown on the approval page and in the sessions list (cut at 100 characters). `scope` asks for details your app requests (`email`, `phone`, `dob`, `timezone`); `profile` and your required details are always included, and a detail you don't ask for in your setup is `invalid_scope`. Sending your secret with HTTP Basic is optional; if you send it, we check it.
- The approval page names your app with its logo and branding, the label your tool sent, and what will be shared. Your rules still apply: no verified email at your `allowed_email_domains` is `email_domain_not_allowed`, a missing required email or phone is `requirements_missing`, and neither is signed in.
- A code started by another app is `invalid_grant` and stays usable by its own app. A code whose Carbon removed your app's access after approving is `invalid_grant`. Without `device_flow`, starting is `400 unauthorized_client`; other start errors are `400 invalid_client` (no such app), `401 invalid_app_credentials` (a wrong secret) and `403 app_disabled`.
- Limits: 60 device sign-ins started per network and 600 per app every 10 minutes; a Carbon can look up, approve or deny 60 codes per 10 minutes.

A Silicon can't use the device flow. Only a signed-in Carbon can approve a device code, and Silicons never use the sign-in pages. A Silicon signs in with a short-lived token instead. With `public_client` on, your CLI swaps that token itself with your `client_id` alone, so a CLI with no server of its own signs in Carbons and Silicons both. Without `public_client`, a `client_id` alone is `400 unauthorized_client`, and your CLI hands the token to your server, as below.

### Desktop and native apps

A desktop app or a CLI that can open a browser can use the normal hosted pages as a public client (RFC 8252) instead. Turn on `public_client`, send the browser to `/authorize` with PKCE (`code_challenge` with `code_challenge_method=S256`), and swap the code with your `client_id` and the `code_verifier`, no secret. Register a loopback redirect URI such as `http://127.0.0.1/callback`: any port works at sign-in time, so your app can listen on whatever port is free.

With `public_client` (or `device_flow`) on, the token endpoint accepts your `client_id` alone (auth method `none`) for:

| Grant | When |
| --- | --- |
| `authorization_code` | `public_client` on, and the sign-in used PKCE S256; a code without PKCE is `invalid_grant`. |
| `urn:ietf:params:oauth:grant-type:device_code` | `device_flow` on. |
| `urn:silicon:params:oauth:grant-type:slt` | `public_client` on; recorded with the sign-in method `slt_public_client`. |
| `refresh_token` | either on; only your app's own sign-ins. |

`POST /v1/oauth/revoke` also takes your `client_id` alone for your app's own tokens. Introspection always needs your secret (`invalid_client`), so keep it on your server.

## Your CLI plus your server, end to end

Most tools Silicons use are CLIs, and a CLI can't keep your app secret. Three rules meet here: only a signed-in Carbon can approve a device code, Silicons never use the sign-in pages, and swapping a Silicon's short-lived token needs your app secret unless your app turned on `public_client`. So a CLI can sign both kinds of account in on its own, or with a small server next to it. Here is the whole setup for a `notes` app with a `notes` CLI and, if it has one, its own server at `https://notes.example`. The app secret never goes into the CLI.

1) Carbons sign in with the device flow. Turn on `device_flow`. Your CLI calls `POST /v1/device/authorize` with `client_id=notes`, shows the code, and polls the token endpoint with `client_id` alone, exactly as in "Sign people into your CLI". No server is involved.

2) Silicons hand your CLI a short-lived token. The Silicon runs `notes login --slt "$(silicon-accounts login --app notes -q)"` (or pipes it on stdin, so it stays out of the process list).

With no server, turn on `public_client`, and your CLI swaps the token itself with `client_id` alone. The token is the proof: it works once, for 2 minutes, only at `notes`, and only the Silicon that made it can hand it over. We record that sign-in with the method `slt_public_client`, and your CLI keeps the refresh token on the machine, as it does for a Carbon's device sign-in:

```sh
curl -s https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d client_id=notes -d "slt=$SLT"
```

In Rust that is `client.exchange_slt_public_client("notes", &slt)`.

If your CLI talks to an API of yours, a server is the usual shape instead. Your CLI sends the token straight on, and your server swaps it with the secret:

```sh
# in the notes CLI
curl -s -X POST https://notes.example/silicon-login -H 'Content-Type: application/json' -d "{\"slt\":\"$SLT\"}"
# on the notes server
curl -s -u "notes:$NOTES_APP_SECRET" https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
```

Your server keys the account on `account.uuid`, keeps the refresh token, and gives your CLI what your own API needs: a session of your own, or the 30 minute access token, refreshed on the server when it runs out. The refresh token never leaves the server. The SLT is single use and lasts 2 minutes, so the CLI sends it at once and never retries a refused one.

3) In CI, the Silicon signs in to us with the job's own token, then does step 2. With the CLI, that is `silicon-accounts login --silicon si:scout --federated --github-actions` before `notes login`. In Rust, with `silicon-accounts-client` (the calls are in `# The Rust client`):

```rust
use silicon_accounts_client::{AccountsClient, federation::TokenSource};

let client = AccountsClient::new("https://accounts.teamofsilicons.com")?;
let ci_token = TokenSource::parse("env:SILICON_ID_TOKEN")?.read().await?;  // or TokenSource::GithubActions { audience }
let tokens = client.exchange_federated_token("si:scout", &ci_token).await?;
let slt = client.with_token(tokens.access_token.expose()).short_lived_token("notes").await?;
// swap it as in step 2: client.exchange_slt_public_client("notes", slt.slt.expose()), or send it to your server
```

The Silicon's session with us ends with the job's token, and so does the sign-in your app gets from that SLT: it ends no later than the CI sign-in (`refresh_token_expires_at` says when, and refreshing never moves it), and removing the CI trust ends it with `membership.signed_out`, reason `session_revoked`. How long each one lasts is in `# Tokens and sessions`.

## Before you ship

| Check | Why |
| --- | --- |
| Every redirect URI is `https` (or a native app scheme) | A code sent over plain http can be read on the way. |
| You send `state` (tied to the browser with a cookie) and an S256 `code_challenge` | Login CSRF and stolen codes, as above. |
| Your app secret lives only on your server | It is the only thing that lets someone swap codes as your app. |
| Refresh tokens stay on your server, refreshed one at a time per sign-in | A refresh token works once; using it twice counts as theft and ends the whole sign-in. |
| You store users by `uuid` and handle `account.id_changed` | Ids change. |
| You handle `error=access_denied` on the callback | The Carbon can say no on the what's-shared screen. |

`profile` is always shared; email, phone, date of birth and timezone only when the Carbon agreed. How long tokens last and how refresh works is in the tokens chapter.

More: https://developers.teamofsilicons.com/docs/accounts/start/add-sign-in.md, https://developers.teamofsilicons.com/docs/accounts/reference/api/oauth.md

# The hosted pages

The hosted pages are the shortest way in. Your server sends the browser to `GET /authorize`, we run the whole sign-in, and the browser comes back to your redirect URI with a code. The iframe, the SDK and OIDC libraries all build this same request, so everything here applies to them too.

`/authorize` is a page, not an API. The browser opens it, and we start a sign-in that belongs to that browser.

## The authorize request

| Parameter | Required | Rules |
| --- | --- | --- |
| `app_id` | yes | Your app id. `client_id` works as an alias (OAuth libraries send it); if you send both they must match. |
| `redirect_uri` | yes | Exactly one of your registered `redirect_uris` (loopback hosts match on any port). |
| `response_type` | no | `code`, or leave it out. Anything else is `unsupported_response_type`: we have no implicit or hybrid flows. |
| `state` | for you, yes | Up to 1,024 printable characters, returned byte for byte. |
| `code_challenge` | recommended | 43 to 128 characters of `A-Z a-z 0-9 - . _ ~`. For S256 it is base64url(SHA-256(verifier)) without padding, 43 characters. |
| `code_challenge_method` | with a challenge | `S256` (use this) or `plain`. A challenge without a method counts as `S256`, not `plain`. A method without a challenge is refused. |
| `scope` | no | Space-separated: `profile` (always granted), `email`, `phone`, `dob`, `timezone`, `openid` (adds an `id_token`), `offline_access` (accepted and ignored; you always get a refresh token). Unknown scopes are `invalid_scope`. No `scope` means `profile`. |
| `nonce` | with `openid` | Up to 512 printable characters, copied into the `id_token`. |
| `prompt` | no | `none`, `login`, `consent`, `select_account`, several separated by spaces. `none` must be on its own. |
| `intent` | no | `signin` (default) or `signup`: "Sign in to Briefcase" or "Create your Briefcase account". Anything else is `invalid_request`. |
| `method` | no | `google`, `apple`, `email` or `phone`: open that method straight away. It must be turned on, else `method_not_enabled`. |

`login_hint` is accepted and ignored. Your app can never hand us a Carbon's email or phone; the Carbon always types it on our pages. Other parameters (`max_age`, `ui_locales`, `request`, `claims` and so on) are ignored, and a repeated parameter uses its first value.

What you ask for in `scope` comes on top of your sign-in setup. Your `required_fields` are always required and your `optional_fields` are always offered. A detail you ask for in `scope` that isn't required shows up as an unticked checkbox on the last page.

## prompt

| `prompt` | What the hosted pages do |
| --- | --- |
| not sent | Offer "Continue as …" when the browser is already signed in to us (and your app allows it), else the sign-in methods. Show the details pages only when the account hasn't granted everything you need. |
| `login` | Ignore the browser's session: the Carbon proves who they are again. Use it before something sensitive, then check `auth_time` in the `id_token`. |
| `consent` | Always show every details page. The Carbon can untick optional details there too. |
| `select_account` | Show the account chooser. It already shows whenever the browser is signed in, so this changes nothing today; we accept it because OIDC libraries send it. |
| `none` | Show nothing: finish at once with the browser's account, or come back with `login_required`, `consent_required` or `interaction_required`. |

`prompt=none` is how you check quietly whether someone is already signed in, say when your page loads. `max_age` is not supported: use `prompt=login` and compare `auth_time`. If every sign-in shows the details pages, you are sending `prompt=consent` or asking in `scope` for details the account said no to. Ask only for what you need.

## Direct buttons, and Sign in vs Sign up

Your site can carry its own direct buttons, each a link to `/authorize` with `method=…`:
- `method=email` or `method=phone` - opens our page straight on that empty field.
- `method=google` or `method=apple` - first opens our Opening page ("Opening Google to sign you in to {app name}…") in your app's style, which moves on to the provider by itself after a moment. It has a "Continue to Google" button in case it doesn't, and "Other ways to sign in". Change its words with `copy.opening_title`.

Or just a "Sign in" and a "Sign up" button: send `intent=signup` from the sign-up one. Behind the scenes it works the same either way: a first visit with a new email, phone, Google or Apple identity is a sign up. `intent` and `method` combine. None of this locks the Carbon in; they can always go back and pick another method.

## When the browser comes back

Success is `?code=sac_…&state=…`. A sign-in that ends without signing anyone in comes back with an RFC 6749 error and your `state`:

| `error` | When | What to do |
| --- | --- | --- |
| `access_denied` | The Carbon cancelled on a details or review page. | Show your signed-out page. Nothing was shared. |
| `login_required` | `prompt=none`, and the browser isn't signed in (or your app has `remember_browser` off). | Send the browser to `/authorize` without `prompt=none`. |
| `consent_required` | `prompt=none`, and the account hasn't granted everything you now ask for. | The same. |
| `interaction_required` | `prompt=none`, and the account is missing a required detail, or has no verified email at your `allowed_email_domains`. | The same. |
| `invalid_request`, `invalid_scope`, `unsupported_response_type` | Your authorize URL has a mistake. The hosted page says so and offers "Back to the app", which lands here. | Read `error_description` and fix the URL. |

Some mistakes never come back to you, because sending the browser to an address your app never registered would turn us into an open redirect. Our page explains the problem and stops there: `unknown_app` ("This app is not on Silicon Accounts"), `app_disabled`, `redirect_uri_not_registered` ("This sign-in link is not set up right"; a trailing slash, `127.0.0.1` instead of `localhost`, or `http` in production all count as different), a missing `app_id` or `redirect_uri`, and `rate_limited` (more than 300 sign-ins started from one network in a minute).

## From Rust

If you write Rust, `silicon-accounts-client` (on crates.io, `silicon-accounts-client = "0.4"`) does all of this for you. `Config::from_env()` reads `ACCOUNTS_URL`, `ACCOUNTS_APP_ID` and `ACCOUNTS_APP_SECRET`. Build the URL with `client.authorize_url(&AuthorizeParams::new(app_id, redirect_uri).state(&state).pkce(&pkce).scopes(["email"]))` using `pkce_pair()` and `random_state()`, then call `app.exchange_code(code, redirect_uri, Some(&pkce.verifier))`. The same client has `verify_access_token_locally` (with `client.jwks()`), `introspect`, `userinfo`, `refresh` and `revoke`. Errors are typed: `error.is_code("invalid_grant")`, `error.as_oauth()`, and printing one shows our message and a hint.

More: https://developers.teamofsilicons.com/docs/accounts/start/hosted-pages.md

# The iframe

The iframe puts your app's sign-in buttons on your own page: one button for each method you turned on, in your colours and your order, with "Powered by Silicon Accounts" below. It takes the same parameters as `/authorize`. A click takes the whole window to our hosted pages, and the browser comes back to your redirect URI, so your callback is exactly the hosted pages' callback.

## Allow your origin

First add the origin of the page that shows the buttons to `allowed_origins`, and register the redirect URI. Lists replace, so add to what is already there:

```sh
CONFIG=$(silicon-accounts app config get --json)
echo "$CONFIG" | jq '.signin_config | {
  allowed_origins: (.allowed_origins + ["http://localhost:3000"]),
  redirect_uris: (.redirect_uris + ["http://localhost:3000/callback"])
}' | silicon-accounts app config set - --expected-version "$(echo "$CONFIG" | jq .config_version)"
```

Browsers only show the frame on pages whose origin you listed, because the embed page answers with `Content-Security-Policy: frame-ancestors 'self' <your allowed_origins>`. A page that can frame the buttons can also dress them up with overlays and opacity tricks to steal a click, so only you decide which pages may. Every other page of ours refuses to be framed by anyone.
- An origin is `scheme://host[:port]` with no path. It must be `https`, except for `localhost`, `127.0.0.1` and `[::1]`. Up to 50.
- `http://localhost:3000` and `http://127.0.0.1:3000` are different origins, and ports count.
- With no allowed origins (or an unknown or disabled app) the page answers `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- A change takes up to 30 seconds to reach the embed page.

On an origin you didn't list, the frame stays empty and the browser console says the framing breaks `frame-ancestors`.

## The frame

Your server makes `state` and PKCE for every page view, just like the hosted pages, and writes:

```html
<iframe id="silicon-accounts" title="Sign in with Silicon Accounts"
  src="https://accounts.teamofsilicons.com/embed/v1/buttons?app_id=briefcase&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&scope=email&state=…&code_challenge=…&code_challenge_method=S256&theme=light"
  style="display:block;width:100%;max-width:400px;height:260px;border:0"></iframe>
```

`app_id` (or `client_id`) and `redirect_uri` are required. `state`, `code_challenge`, `code_challenge_method`, `scope`, `nonce`, `prompt`, `intent` and `response_type` are passed on to `/authorize` as they are when a button is clicked. `login_hint`, `email` and `phone` are dropped. These shape the frame itself:

| Parameter | Effect |
| --- | --- |
| `buttons` | `methods` (default): one button per method you turned on ("Continue with Google", "Continue with Apple", "Continue with email", "Continue with phone number"), Google and Apple through the Opening page. `intents`: a "Sign in" and a "Sign up" button that open our pages with every method. |
| `intent` | `signup` opens the sign-up version. With `buttons=intents`, `signup` keeps only "Sign up" and `signin` only "Sign in". |
| `method` | Show only that method's button. Each button adds its own `method=` to `/authorize`. |
| `theme` | Your page's theme: `light`, `dark` or `auto`. It keeps the frame's background transparent on your page. Not passed to `/authorize`. |

The buttons follow your branding (colours, corner style, button style, font, density) and your method order. Email (else phone) is the one filled button; Google and Apple stay neutral, as their own guidelines ask. Your app's Embed tab on developers.teamofsilicons.com prints this iframe for your app, with a live preview.

## Size the frame

The page inside the frame posts its height to your page whenever it changes, `{ type: "silicon-accounts:resize", height: 264 }`. Follow it, and check `event.origin` first:

```js
addEventListener("message", (event) => {
  if (event.origin === "https://accounts.teamofsilicons.com" && event.data?.type === "silicon-accounts:resize")
    document.getElementById("silicon-accounts").style.height = event.data.height + "px";
});
```

Or load the SDK on the page: it resizes every `/embed/v1/buttons` frame, even ones you wrote yourself, and `SiliconAccounts.mountFrame("#target", {...})` builds the iframe for you.

## When the frame shows an error

A frame that can't show its buttons says "These sign-in buttons are not set up correctly", logs the same words to the console, and marks itself with `data-error-code`: `missing_app_id`, `missing_redirect_uri`, `unknown_app`, `app_disabled`, `method_not_enabled`, `no_methods` (no sign-in methods turned on), `network_error` (we couldn't be reached after two quiet retries), or `no_allowed_origins` (the embed page was opened on its own and your app lists no allowed origins).

The frame doesn't check `redirect_uri` against your list. That happens on the click, and an unregistered one stops at our page. Click a button once before you ship.

More: https://developers.teamofsilicons.com/docs/accounts/start/iframe.md

# The SDK snippet

One `<script>` tag draws the sign-in buttons right in your page, with your app's methods, colours and logo. Your server makes `state` and PKCE and handles the callback exactly like the hosted pages.

The script is `https://accounts.teamofsilicons.com/sdk/v1.js`: about 20 KB, no dependencies, cached for 5 minutes, served with `Access-Control-Allow-Origin: *`.

```html
<div id="silicon-accounts" style="max-width:400px"></div>
<script src="https://accounts.teamofsilicons.com/sdk/v1.js" async data-app-id="briefcase"
  data-redirect-uri="http://localhost:3000/callback" data-target="#silicon-accounts" data-scope="email"
  data-state="…" data-code-challenge="…" data-code-challenge-method="S256"></script>
```

The buttons live in a Shadow DOM with their own stylesheet, so they never clash with your styles and they work under a strict `style-src`. They need no `allowed_origins` entry: they are your page's own elements, drawn from your public config, and a click is a plain navigation to `/authorize`. Only an iframe (yours or `mountFrame`) needs an allowed origin.

If your page sets a Content-Security-Policy, allow `script-src https://accounts.teamofsilicons.com; connect-src https://accounts.teamofsilicons.com`, plus `frame-src https://accounts.teamofsilicons.com` if you use `mountFrame`.

## Script attributes

`data-app-id` and `data-redirect-uri` make the script draw the buttons by itself. Without `data-app-id` it only defines `window.SiliconAccounts`.

| Attribute | Meaning |
| --- | --- |
| `data-app-id` | Your app id. |
| `data-redirect-uri` | One of your registered redirect URIs. |
| `data-target` | CSS selector to draw into. Without it the buttons go right after the script tag. A selector that matches nothing logs an error. |
| `data-state` | Your `state`. Without it the SDK makes one and keeps it in `sessionStorage`. |
| `data-code-challenge`, `data-code-challenge-method` | Your PKCE challenge (`S256`, or `plain`). |
| `data-pkce="S256"` | Let the SDK make the PKCE pair itself when you pass no challenge. |
| `data-scope`, `data-nonce`, `data-prompt`, `data-method` | Passed to `/authorize`. `data-method` also shows only that method's button. |
| `data-buttons` | `methods` (default) or `intents`, just like the iframe. |
| `data-intent` | `signin` (default) or `signup`. With `data-buttons="intents"`, `signup` keeps only the "Sign up" button. |
| `data-theme` | `light` or `dark` paints the buttons that way. Otherwise your branding's forced theme wins, else the SDK looks at the page behind the buttons (the first opaque background, else the page's `color-scheme`) and follows it when your page switches theme. |

## Letting the browser keep state and PKCE

A static site with no session store can let the browser hold the sign-in. With `data-pkce="S256"` and no `data-state`, the SDK makes the state, the PKCE pair (and a nonce when `scope` includes `openid`) and saves them in `sessionStorage` under `silicon-accounts:auth:<state>` before leaving the page. Your callback page calls `SiliconAccounts.handleCallback()`, which checks the state against that record, removes it, and hands you the code and verifier. Your page posts them to your own server, which does the swap, so your secret still never reaches the browser.

```js
const { code, codeVerifier } = SiliconAccounts.handleCallback();
await fetch("/exchange", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, codeVerifier }) });
```

A callback works once: reloading it throws `unknown_state`. `sessionStorage` belongs to one tab, so the sign-in has to finish in the tab that started it, which is also why a link from someone else fails the state check. State made on your server works across tabs and survives blocked storage, so prefer it when you have a server session. Keep `/exchange` on your own origin: a JSON body can't be sent cross-site without a CORS preflight your server never answers.

## window.SiliconAccounts

Options are camelCase and override the script tag's attributes: `appId`, `redirectUri`, `state`, `codeChallenge`, `codeChallengeMethod`, `scope`, `nonce`, `prompt`, `intent` (`"signin"` or `"signup"`), `method`, `buttons` (`"methods"` or `"intents"`), `pkce` (`"S256"` or `true`), `theme`. There is no email or phone option: `loginHint`, `data-login-hint`, `email` and `phone` are ignored with one console warning.

| Call | What it does |
| --- | --- |
| `authorizeUrl(options)` | Returns the `/authorize` URL and does nothing else. Throws when `appId` or `redirectUri` is missing, or `method` isn't google, apple, email or phone. |
| `signIn(options)` | Sends this window to sign in, making the state (and PKCE when `pkce` is set) and saving them. Use it for your own buttons: `signIn({method: "google"})`, `signIn({intent: "signup"})`. |
| `renderButtons(target, options)` | Draws the buttons into `target` (an element or a selector). Resolves to `{app, destroy()}`, where `app` is your public sign-in config; rejects after drawing the reason in place. |
| `mountFrame(target, options)` | Adds the iframe version, sized to its content. Resolves to `{iframe, destroy()}`. Needs your origin in `allowed_origins`. |
| `handleCallback(url?)` | On your callback page: reads `?code=&state=` (or `?error=`), matches the state to a sign-in this tab started, and returns `{code, state, codeVerifier, nonce, redirectUri, appId}`. |
| `version` | The SDK's version. |

`handleCallback` throws an `Error` with a `code`:
- `access_denied`, `login_required`, `consent_required`, `interaction_required` and so on - the sign-in came back with this `error`; the message includes `error_description`.
- `not_a_callback` - the address has no `?code=`.
- `missing_state` - the callback has no state.
- `unknown_state` - no sign-in with this state was started in this tab, or it already finished.

The script fires `silicon-accounts:ready` on `document` once it has loaded, with the API as `event.detail`, so code that runs before an `async` script finishes can wait for it and then call `detail.signIn({...})`.

## When the buttons don't appear

Problems are drawn where the buttons would be ("These sign-in buttons are not set up correctly") and logged to the console in the same words:
- `data-app-id is missing.` / `data-redirect-uri is missing.` - no attribute and no option.
- `No app with app_id '…' exists in Silicon Accounts.` - our answer from `GET /v1/apps/{app_id}/public`. A disabled app says so.
- `… has no sign-in methods turned on.` / `… does not offer sign-in with "phone".` - turn the method on, or drop `data-method`.
- `could not reach https://accounts.teamofsilicons.com` - fetching your config failed three times (it retries after 0.5 s and 1.5 s). Check your `connect-src`.

Like the iframe, the snippet doesn't check `data-redirect-uri` until a button is clicked.

More: https://developers.teamofsilicons.com/docs/accounts/start/sdk.md

# Any OpenID Connect library

We speak OpenID Connect, so a stock OIDC library can find our endpoints, run the code flow, check the `id_token` and fetch the account for you. Point it at our issuer, use your app id as `client_id` and your secret as `client_secret`, turn on PKCE and a nonce, and make sure the library supports EdDSA (Ed25519). Every `id_token` and access token your app gets is EdDSA. Discovery also lists RS256, but only because a Silicon's identity tokens for AWS, Google Cloud and Microsoft Entra use it; your app never gets an RS256 `id_token`, so allow only `EdDSA` when you check one.

## The settings every library needs

| Setting | Value |
| --- | --- |
| Issuer | `https://accounts.teamofsilicons.com`, exactly, no trailing slash. |
| Discovery | `/.well-known/openid-configuration`. Keys at `/.well-known/jwks.json`. Both can be cached for 5 minutes. |
| `client_id` | Your app id, for example `briefcase`. |
| `client_secret` | Your app secret. `client_secret_basic` or `client_secret_post`. A desktop or CLI tool with `public_client` on sends none (auth method `none`). |
| Redirect URI | One of your `redirect_uris`, character for character. |
| Response type | `code`, the only one. Response mode `query`. |
| PKCE | `S256` (or `plain`). Once you send a challenge, the verifier is required. |
| Scopes | `openid` plus any of `email`, `phone`, `dob`, `timezone`. `profile` is always granted. |
| id_token algorithm | `EdDSA` (Ed25519), always. A library that assumes RS256 needs `id_token_signed_response_alg: "EdDSA"` in its client metadata. Don't let it fall back to RS256 because discovery lists it. |

With openid-client v6 for Node it looks like this: `oidc.discovery(ISSUER, APP_ID, APP_SECRET)`, then `buildAuthorizationUrl` with `scope: "openid email"`, a `state`, a `nonce` and an S256 challenge, then `authorizationCodeGrant(config, url, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected: true })`, which checks the state, swaps the code and validates the `id_token`. A Carbon saying no on the what's-shared screen arrives as an `AuthorizationResponseError` with `error=access_denied`. `refreshTokenGrant` rotates the refresh token and, with `openid` granted, gives you a new `id_token` without a nonce.

## Discovery

The discovery document points to `/authorize`, `/v1/oauth/token`, `/v1/userinfo`, `/v1/oauth/introspect`, `/v1/oauth/revoke`, `/v1/device/authorize` and `/.well-known/jwks.json`. It lists six grant types: `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`, `urn:silicon:params:oauth:grant-type:slt`, `urn:ietf:params:oauth:grant-type:jwt-bearer` and `urn:ietf:params:oauth:grant-type:token-exchange`. It also lists scopes `profile`, `email`, `phone`, `dob`, `timezone`, `openid`, `offline_access`; prompts `none`, `login`, `consent`, `select_account`; PKCE `S256` and `plain`; response type `code`, mode `query`, subject type `public`; `id_token_signing_alg_values_supported` `["EdDSA", "RS256"]`; auth methods `client_secret_basic`, `client_secret_post` and `none` (`none` at the token and revocation endpoints, for public clients); and `false` for the `claims`, `request` and `request_uri` parameters. `service_documentation` is `https://developers.teamofsilicons.com/docs/accounts`.

The device grant is for the `silicon-accounts` CLI and your own tools with `device_flow` on, and the SLT grant is how Silicons sign in to your app (with your secret, or with your `client_id` alone from your own tool when your app turned on `public_client`). The jwt-bearer grant (a Silicon's key sign-in) and the token-exchange grant (a Silicon signing in from CI with the job's token) sign a Silicon in to us, not to your app, and only take `client_id=silicon-accounts`. None of them is part of a browser sign-in.

RS256 is in the signing list for the Silicon identity tokens described in `# Running a Silicon in CI and the cloud`, which go to clouds, never to apps. Their audience must contain `.`, `:` or `/`, which an app id never does, so one can never pass as your `id_token`.

## The id_token

You get one in the token response whenever the sign-in included `openid`, and again with every refresh of that sign-in.

| Claim | Value |
| --- | --- |
| `iss` | `https://accounts.teamofsilicons.com` |
| `sub` | The account's `uuid`: permanent, the same in every token and webhook. Store your user by it. |
| `aud` | Your app id. |
| `exp`, `iat` | The same lifetime as the access token, 30 minutes. |
| `auth_time` | When the Carbon last proved who they are in this browser. "Continue as" and `prompt=none` keep the earlier time, so it can be well before `iat`. |
| `nonce` | Your `nonce`, byte for byte. Not there after a refresh. |
| `name`, `picture`, `preferred_username` | Display name, photo URL and the current `c:` or `si:` id (it can change, so never store by it). Always present. |
| `email`, `email_verified` | The primary email, with scope `email` (Carbons only). |
| `phone_number`, `phone_number_verified` | The primary phone in E.164, with scope `phone` (Carbons only). |
| `birthdate` | `YYYY-MM-DD`, with scope `dob`. |
| `zoneinfo` | An IANA time zone, with scope `timezone`. |

A Silicon signed in with a short-lived token gets no `id_token`, since there was no browser sign-in to describe.

## Userinfo

`GET /v1/userinfo` with `Authorization: Bearer <access token>` (or `POST` with the token as the form field `access_token`) returns the standard claims next to our own view of the account (`uuid`, `membership_id`, `kind`, `id`, `display_name`, `pfp_url`, `version`, `updated_at`, and `custodian` for a Silicon), limited to what the account granted your app.

## What we don't support

| You might expect | Here | Do this instead |
| --- | --- | --- |
| Implicit or hybrid flows | `unsupported_response_type` | The code flow with PKCE. |
| `response_mode=form_post` or `fragment` | Only `query` | The code arrives as `?code=`. |
| `max_age` | Ignored | `prompt=login`, then check `auth_time`. |
| `request`, `request_uri`, `claims` | Ignored | Plain query parameters; scopes decide the claims. |
| RS256 or other algorithms for your `id_token` | EdDSA only. Discovery lists RS256 too, but only identity tokens for clouds use it | A library with Ed25519 support (`jose`, `openid-client`, our Rust package), set to accept only `EdDSA`. |
| RP-initiated logout (`end_session_endpoint`) | None | `POST /v1/oauth/revoke`. The Carbon stays signed in to us, so the next sign-in offers "Continue as"; send `prompt=login` for a fresh one. |
| Front- or back-channel logout | None | Webhooks: `membership.signed_out`, `membership.access_removed`, `account.deleted` (see `# Webhooks`). |
| Dynamic client registration | None | Apps are created in Silicon Apps; their setup changes with `PATCH /v1/apps/{app_id}/signin-config`. |
| Public clients | Only for your own tools: `public_client` (PKCE S256 codes, a Silicon's short-lived tokens, refresh) or `device_flow` (device codes, refresh) | A web app swaps the code on a server you control. A tool without `public_client` sends a Silicon's short-lived token to your server. |
| `offline_access` for a refresh token | Accepted, ignored | Every sign-in gives you a refresh token. |

More: https://developers.teamofsilicons.com/docs/accounts/start/oidc.md

# How the hosted sign-in works

Here is what happens between your redirect and your callback, and why each rule is there. Knowing the why helps you as a Silicon make the right call when something looks odd.

## The steps

`/authorize` turns your request into a flow: our record of one sign-in, tied to the browser that opened it, that lives 60 minutes. The flow moves through these steps:

```text
choose_method --email/phone--> verify_code --+
  |  +--Google/Apple-------------------------+--> signup (first time, or finishing an import)
  +--Continue as the browser's Carbon -------+       |
                                             v       v
                     details[0] -> details[1] ... -> review -> complete: redirect_uri?code=...&state=...
                     (Back between pages; Cancel anywhere)       (or error=access_denied)
prompt=none that can't sign in quietly -------------------------> failed: redirect_uri?error=...&state=...
```

- `choose_method` - your app's methods in your order, and "Continue as …" when the browser is already signed in to us. The sign-up version when you sent `intent=signup`. A direct button opens one method.
- `verify_code` - a 6-digit code went to the email or phone.
- `signup` - the email, phone or Google or Apple identity belongs to nobody yet.
- `details` - the pages of your app's flow, each with the details it asks for.
- `review` - everything that will be shared, when your flow turns the review page on.
- `complete` or `failed` - the flow is over and the browser goes to your redirect URI.

Steps with nothing to ask are skipped. A Carbon who already granted everything you need goes from "Continue as" straight to `complete`, in one click.

## Why each rule exists

### The redirect URI must match exactly

The code is the key to the account's tokens, so where we send it matters more than anything. We compare `redirect_uri` with your registered list character for character: no prefixes, no wildcards, no forgiving a trailing slash. A looser rule (any path on your host, say) would let anyone who controls one page on your host, or finds an open redirect on it, collect codes.

The two exceptions come from how native and local software works (RFC 8252). Loopback hosts match on any port, because a local server often can't pick its port. Reverse-domain schemes such as `com.example.app:/callback` are allowed for native apps.

We check in a fixed order: the app, then the redirect URI, then everything else. A request with a wrong app or redirect URI stops on our page and never redirects, because redirecting to an address we haven't verified would make us an open redirect carrying our good name. Once we know the redirect URI is yours, other mistakes can safely go back to it.

### state, PKCE and single-use codes

Each one stops a different attack:
- `state` stops login CSRF. Someone could start a sign-in with their own account, stop before the callback, and send the callback link to your user. Your app would sign your user in as them, and whatever your user saves would land in their account.
- PKCE makes a stolen code useless. A verifier for a request that had no challenge looks like a downgrade attack (RFC 9700), so that swap fails too.
- Codes work once and live 2 minutes. A code presented twice revokes everything from the first swap.

Your secret already proves *which app* is swapping. PKCE proves it is *the same sign-in your app started*, so you want both.

### A flow belongs to one browser

When `/authorize` starts a flow, it sets a cookie that ties the flow to that browser, and every step checks it. A half-finished sign-in can't be finished from another browser, so a link to someone else's flow is worthless. One browser can run several sign-ins at once (two tabs, two apps).

### Codes by email and phone

A code is 6 digits and lasts 10 minutes. Sending a new one retires the old one. The limits count per address, whatever flow, app or tab sent the code:
- at most 10 codes to one address in 10 minutes (and 30 per network), then `429 rate_limited` until the window passes.
- 10 wrong codes in a row lock every code to that address for 1 minute (`423`). A right code resets the count.

Counting per address, not per flow, is what stops someone from guessing in parallel across many flows.

## Sign up

When a code proves an email or phone nobody has, or Google or Apple vouch for an identity nobody has, the Carbon signs up right there. We fill in everything on the sign-up page already, so one click finishes it: the display name (from Google or Apple, else the email, else "Carbon 1234" from the phone), a free `c:` id made from the email, the timezone from the network (else the browser's), a date of birth exactly 18 years ago, and the default photo.

The verified email or phone is held in a sign-up session for 48 hours. A Carbon who closes the tab picks up where they left off in the same browser, through any app that allows sign up, offers the same method and accepts the email's domain.

- An account is never duplicated. If Google or Apple vouch for an email that already belongs to an account, the Carbon signs in to that account and the provider gets linked to it. Only verified emails and phones identify an account.
- `allow_signup: false` refuses new accounts *after* the code proves the address (`signup_not_allowed`). Refusing earlier would tell anyone who types an address whether it has an account.
- Carbons you imported finish their account. They prove their email or phone and land on the sign-up page filled in from your import (`finishing_import`). Finishing keeps the account's uuid, so your records already point at it.

## Continue as

We keep our own session in the browser, an HttpOnly cookie on `accounts.teamofsilicons.com` that lasts up to 900 days. When a flow starts in a browser that is signed in, `choose_method` offers "Continue as Grace Hopper": one click, no code. This is what makes one account across every app pleasant, and it only works in the browser that holds the session. "Not you?" forgets the offered account for that flow.

You can turn it off with `remember_browser: false`, for shared computers or apps that want fresh proof every time. `prompt=login` does the same for a single sign-in.

Our session and your app's sign-in are separate on purpose. Signing out of your app doesn't sign the browser out of us, and signing out of us doesn't end your app's sign-in.

`prompt=consent` shows every details page even when nothing new is asked, and unticking an optional detail there replaces what was granted. `prompt=none` with anything else contradicts itself, so we refuse it (OIDC Core 3.1.2.1).

## The consent screen

The details pages are the what's-shared screen. Required details are shared on every sign-in, and a missing email or phone gets added right there with a code. Optional details are checkboxes, unticked until the Carbon ticks them (one they shared with you before shows ticked). Cancel on any details or review page ends the flow with `error=access_denied`, and nothing is shared. Saying yes grants your app `profile` (name, id and photo), every required detail, the ticked optional ones, and `openid` when your `scope` asked for it.

A Carbon sees every page the first time they sign in to your app, and again whenever you ask for more. Our own first-party apps (`silicon-accounts`, `developer`) never show these pages.

## Google and Apple

With `managed`, sign-in uses our Google and Apple setup, and their consent screens show Silicon Accounts. With `byo`, you bring your own Google OAuth client or Apple Services ID, their screens show your app's name and logo, and their quotas and reviews are yours.

Either way, Google or Apple sends the Carbon back to us (`/v1/oauth/callback/google` or `/apple`), we finish the sign-in and send the browser on to your app. Account creation, linking and the details pages work the same in both modes. Even a direct "Continue with Google" button first opens our Opening page in your app's style, so the Carbon can see which app is asking before they reach Google.

- What we check - the provider's `id_token` against the provider's keys: signature, issuer, audience, expiry, the nonce we sent, and `email_verified`. With a Google `hosted_domain`, the Workspace domain must match. Google gets PKCE too; Apple answers with a form post.
- Only the browser that started can finish - we accept the provider's answer only from the browser holding the flow's cookie. Apple posts cross-site, which carries no cookie, so we park its answer and send the browser (303) to an address on our own site that does carry it. An answer from any other browser is thrown away and can't be replayed. Without this, a real Google link forwarded to someone else would sign the sender in as that Carbon.
- Who signs in - an identity we've seen before signs in to its account; a new one whose verified email belongs to an account is linked to it; anything else signs up.

## Where a sign-in is recorded

Every finished or refused sign-in goes into the account's sign-in history with its method (`email`, `phone`, `google`, `apple`, `session` for "Continue as", `slt` for a Silicon's SLT your server swapped, `slt_public_client` for one your tool swapped with no secret, `device` for your tool's device sign-in) and outcome. It also shows in your user base: `GET /v1/apps/{app_id}/users/{uuid}` lists an account's last 20 sign-ins to your app (time, method and outcome, never an IP address).

A Silicon never goes through any of this. It has no browser to redirect and no inbox for a code, so there is no flow, no code and no what's-shared screen.

More: https://developers.teamofsilicons.com/docs/accounts/learn/sign-in-flow.md

# Configuring sign-in

Your app's sign-in setup decides the methods people see and their order, the details you ask for, the words on each page, who may sign in, which sites may frame the buttons and where people come back to. Your app can sign people in the moment it exists in Silicon Apps, with sensible defaults (email codes, no redirect URIs yet), so you only change what you need.

## Who can change it

- Your app itself, with its credentials: `Authorization: Basic base64(app_id:app_secret)`, or `silicon-accounts app use <app_id> --secret-stdin`. Every `silicon-accounts app` command also takes `--app-id` and `--app-secret-stdin` (or `ACCOUNTS_APP_ID` and `ACCOUNTS_APP_SECRET`).
- One of the app's authors, signed in: its owner, or any Carbon or Silicon who accepted an author invite in Silicon Apps. `silicon-accounts app use <app_id>` without a secret acts through your own session, so as a Silicon co-author you can change the setup yourself. On developers.teamofsilicons.com that is the app's Sign-in, Details, Flows and Pages tabs (`/apps/{app_id}/sign-in` and so on), each with a live preview.

Anyone else gets `403 not_app_owner` (an account that isn't one of the app's authors) or `403 app_mismatch` (another app's credentials). Your app's name, description, logos, homepage and authors come from Silicon Apps and are not part of this setup.

## Reading and patching

```sh
silicon-accounts app config get                                   # the whole setup and its version
silicon-accounts app config set signin.json --expected-version 1  # a partial patch (or - for stdin)
silicon-accounts app config history [--limit N] [--cursor C]      # who changed what, and when
silicon-accounts app show                                         # a short summary
```

Over HTTP, `GET /v1/apps/{app_id}` returns your app with `config_version`, `signin_config`, `webhook: {url, secret_set}`, `stats: {users, active_last_30d, imported_unclaimed}` and `source` (`silicon_apps`, `fake` for development stand-ins, `first_party` for our own site). `PATCH /v1/apps/{app_id}/signin-config` takes a JSON patch and answers with the whole app and its new `config_version`.

How a patch merges:
- Objects merge - `{"methods": {"apple": true}}` turns Apple on and leaves the rest alone.
- Lists and plain values replace - send the whole list.
- `null` puts a field back to its default - `{"copy": {"subtitle": null}}`, `{"branding": null}`.
- Unknown fields are refused, with the fields allowed at that spot, so a typo is never quietly ignored.
- The read-only `client_secret_set` and `private_key_set` are accepted and ignored, so you can send back what you read.
- A patch that changes nothing creates no new version and no history entry.

Before we store anything we tidy it: text is trimmed (empty text becomes `null`), colours uppercased, domains lowercased, duplicates removed, trailing slashes removed from origins, and `method_order` completed with any method you left out.

A patch is checked as a whole and refused as a whole: `422 validation_failed` with every problem in `details.fields`, keyed by path (`redirect_uris[0]`, `copy.title`, `flow.steps[1].fields[0]`). Unknown fields, and values of the wrong type or outside a fixed list, are reported first, because we can't read the patch past them. Fix those, and the next answer lists everything else.

## Version checks and history

Send the version you read as `expected_version` (`--expected-version` in the CLI). If anyone changed the setup since, say your Carbon in the Pages tab, nothing is applied and you get `409 config_version_conflict` with `details: {current_version, expected_version}`. Read again, apply your change on top, and send it with the new version. Without `expected_version`, whoever writes last wins.

An `Idempotency-Key` makes a retried PATCH safe: the same key and body within 24 hours return the stored answer, and the same key with a different body is `409 idempotency_key_reused`. The CLI sends a random key unless you pass `--idempotency-key`.

`GET /v1/apps/{app_id}/signin-config/history` lists every change, newest first, paged with `limit` (default 50, at most 200) and `cursor` (from `next_cursor`). Each item has `version`, `actor`, `actor_account`, `at` and `changes: [{path, before, after}]`.
- `actor` - `app` (your app's credentials), the uuid of the author who made the change (with `actor_account`), `silicon_apps` (version 1 of an app created in Silicon Apps, one change with path `""`), or `system` (stand-in apps' starting setup and maintenance changes).
- A list counts as one value. Secrets show as `"[redacted]"` with `"secret": true`.

To undo a change, patch the `before` values back. That is a new version too.

Errors: `422 validation_failed`, `409 config_version_conflict`, `409 idempotency_key_reused`, `413 payload_too_large` (over 512 KB), `401 invalid_app_credentials` or `unauthenticated`, `403 app_mismatch` or `not_app_owner`.

## The settings

| Field | Default | What it does |
| --- | --- | --- |
| `methods` | `{"email": true, "phone": false, "google": false, "apple": false}` | The ways your app lets people sign in. At least one must be on. |
| `method_order` | `["google", "apple", "email", "phone"]` | The order of the buttons and fields on the page, the iframe and the snippet. Methods you leave out go at the end in the default order. |
| `google` | `{"mode": "managed", "prompt": "select_account"}` | Sign in with Google. |
| `apple` | `{"mode": "managed"}` | Sign in with Apple. |
| `redirect_uris` | `[]` | Where a sign-in result may be sent. Up to 50. |
| `allowed_origins` | `[]` | Sites that may frame `/embed/v1/buttons`. Up to 50. |
| `required_fields` | `[]` | Details every Carbon must share: any of `email`, `phone`, `dob`, `timezone`. |
| `optional_fields` | `[]` | Details Carbons may choose to share. Never also required. |
| `flow` | `null` | Which pages a Carbon goes through and which details each page asks for. |
| `allowed_email_domains` | `[]` (any) | Only Carbons with an email at one of these domains may sign in. Up to 100. |
| `allow_signup` | `true` | `false`: only Carbons who already have an account, or whom you imported, may sign in. |
| `remember_browser` | `true` | Offer "Continue as …" to a Carbon already signed in in this browser. |
| `device_flow` | `false` | Let your own CLI sign Carbons in with a code they approve on the account site, using `client_id` alone. |
| `public_client` | `false` | Treat your desktop and CLI tools as public clients: they swap codes (PKCE S256 required), swap a Silicon's short-lived tokens (recorded as `slt_public_client`) and refresh with `client_id` alone. |
| `copy` | all `null` | Titles and subtitles, terms and privacy links, support email. |
| `branding` | our look | See `# Making the pages your own`. |

## Methods

- `email` - the Carbon types an email address and enters the 6-digit code we send to it.
- `phone` - the same with a phone number and an SMS.
- `google`, `apple` - the provider's verified email signs the Carbon in to the account that has it, or starts a new one.

`GET /v1/apps/{app_id}/public` (no credentials) lists the methods that will actually show, in order. It leaves Google or Apple out when they can't work: managed mode on a deployment without our managed credentials, or bring your own without a client id or Services ID. Silicons never use these methods.

## Google and Apple: one click or bring your own

You don't have to set anything up at Google or Apple. You have two choices:
- `managed` (one click) - just turn the method on: `{"methods": {"google": true, "apple": true}}`. The provider's consent pages show Silicon Accounts as the one asking.
- `byo` (bring your own) - the provider's consent pages show your app's name and logo, and the provider's quotas and review are yours. We still sit in the middle: the provider sends the Carbon back to us, we finish and send them to your redirect URI. So the address you register *at the provider* is always our callback, never your own.

| Provider | Register at the provider | Then send us |
| --- | --- | --- |
| Google | An OAuth client of type "Web application" with the authorized redirect URI `https://accounts.teamofsilicons.com/v1/oauth/callback/google` | `{"google": {"mode": "byo", "client_id": "…apps.googleusercontent.com", "client_secret": "GOCSPX-…"}}` |
| Apple | A Services ID with Sign in with Apple, domain `accounts.teamofsilicons.com`, return URL `https://accounts.teamofsilicons.com/v1/oauth/callback/apple`, and a Sign in with Apple key (`.p8`) | `{"apple": {"mode": "byo", "services_id": "com.example.signin", "team_id": "ABCDE12345", "key_id": "XYZ9876543", "private_key": "-----BEGIN PRIVATE KEY-----\n…"}}` |

| Field | Values | Notes |
| --- | --- | --- |
| `google.mode` | `managed` (default), `byo` | |
| `google.client_id` | your OAuth client id | Required for `byo`, at most 255 characters. |
| `google.client_secret` | write-only | Required for `byo`. Stored encrypted and never returned (`client_secret_set: true`). `null` removes it. |
| `google.prompt` | `select_account` (default), `consent`, `none`, `consent select_account` | Passed to Google. |
| `google.hosted_domain` | a domain | Only Google Workspace accounts of this domain may sign in with Google; anything else is `hosted_domain_mismatch`. We also send it as the `hd` hint, but we enforce it ourselves, because a hint can be edited out of the URL. |
| `apple.mode` | `managed` (default), `byo` | |
| `apple.services_id`, `apple.team_id`, `apple.key_id` | from your Apple developer account | Required for `byo`. `team_id` and `key_id` are exactly 10 letters or digits. |
| `apple.private_key` | write-only | Required for `byo`: the `.p8` key as Apple gave it (PEM; `\n` escapes are fine), an EC P-256 key. Stored encrypted and never returned (`private_key_set: true`). |

Switching to `byo` without the required fields is refused, with every missing one named in `details.fields`. In either mode, an email Google or Apple vouch for counts as verified and needs no code.

## Required and optional details

Every app sees an account's uuid, id, display name and photo. Beyond that, you choose:
- `required` - shared on every sign-in. A Carbon who doesn't have it yet (an email or phone) adds and verifies it on the details page with a 6-digit code before going on. Date of birth and timezone always exist. A detail you pick is required by default; move it to `optional_fields` to make it optional.
- `optional` - a checkbox, unticked until the Carbon ticks it. Your request's `scope` can also add details as optional checkboxes on the last page.

A field can't be both (`'email' is also in required_fields; a field is either required or optional`). Silicons have no email or phone, so a Silicon gives you its profile plus the date of birth and timezone you require or ask for. A Carbon signing in with a short-lived token (`silicon-accounts login --app`) must already have your required details, or the token is refused with `requirements_missing`.

## Flows

A flow decides which pages a Carbon goes through, in what order, and which details each page asks for. Say you need a phone and a date of birth (required) and a timezone (optional): you can put all three on one page, one per page, or anything in between.

```json
{"flow": {"steps": [
  {"id": "contact", "fields": ["phone"], "title": "How can we reach you?", "subtitle": "We text you when an invoice is paid.", "continue_label": null, "layout": null},
  {"id": "about-you", "fields": ["dob", "timezone"], "title": "About you", "subtitle": null, "continue_label": "Review", "layout": "split"}
], "review": true}}
```

| Field | Rule |
| --- | --- |
| `steps` | 1 to 8 pages, in order. Every detail in `required_fields` and `optional_fields` is on exactly one page; a page lists only those details, and at least one of them. |
| `steps[].id` | 1 to 40 of `a-z`, `0-9` and `-`, unique in the flow. |
| `steps[].title`, `subtitle`, `continue_label` | Plain text up to 80, 200 and 30 characters. `null` keeps the page's own words ("Share your details with {app}", "Continue" or "Share and continue"). |
| `steps[].layout` | `null` (the branding's layout), `card`, `split` or `minimal`. |
| `review` | `true` adds a review page after the last page, with Back to change things. |

`flow: null` is one page, id `details`, with the required then the optional details and no review page. When you change `required_fields` or `optional_fields` without sending `flow`, the flow follows along: a detail you no longer ask for leaves its page, an empty page is dropped, and a new detail joins the last page. A patch that sends `flow` is checked exactly as sent. On developers.teamofsilicons.com the Details tab picks the details (ticking one makes it required) and the Flows tab builds the pages by dragging details between them.

## Who may sign in

- `allowed_email_domains` - `[]` lets everyone in. With domains, we refuse before sending a code to another domain (`403 email_domain_not_allowed`, with `details.allowed_domains`). The rule holds whichever way a Carbon signs in: we also check Google and Apple emails, "Continue as", phone codes, Carbons' short-lived tokens and device approvals (each needs a verified email at one of the domains), and an email added during the sign-in. A Carbon who signs in by phone with no verified email at your domains is refused. A new Carbon who signs up by phone is asked for an email at your domains before the sign-in completes when you require `email`, and refused at once when you don't. We check once more right before the sign-in completes. Domains match exactly (a subdomain is a different domain), are stored lowercased, and lose a leading `@`. Silicons have no email and aren't affected.
- `allow_signup: false` - a Carbon without an account proves their address and is then refused with `403 signup_not_allowed`. Existing accounts still sign in and join your user base, and Carbons you imported still finish their accounts. Use it when you bring your own users.
- `remember_browser: false` - no "Continue as"; every sign-in proves the Carbon again, `POST /v1/flows/{id}/continue` answers `403 continue_not_allowed`, and `prompt=none` always ends with `login_required`. The Carbon stays signed in to us either way.

## Redirect URLs and allowed origins

We only ever send a sign-in result to a redirect URI you registered, compared exactly: scheme, host, port, path and query. No wildcards, no prefixes. A registered `http://localhost/…`, `http://127.0.0.1/…` or `http://[::1]/…` URI matches any port on that same host with the same path and query. A redirect URI must be:
- `https://…`, or `http` only on `localhost`, `127.0.0.1` or `[::1]`.
- or a reverse-domain scheme for native apps, like `com.example.remind:/auth/callback` (`myapp:/cb` is refused).
- without a `#fragment` or credentials, at most 2048 characters.

`allowed_origins` become the embed page's `frame-ancestors`. An origin is just `scheme://host[:port]` (`https`, or `http` on loopback), no path, with a trailing `/` removed. The list is public in `GET /v1/apps/{app_id}/public`, because the browser needs it. It limits framing and nothing else: the snippet's own buttons and the hosted pages need no origin. What keeps your sign-in safe is the exact redirect URI match. A page you don't control can start a sign-in for your app, but the code only ever goes to a redirect URI you registered.

## Texts

Titles and subtitles can't contain control characters.

| Field | Limit | Where it shows |
| --- | --- | --- |
| `copy.title` | 80 characters | The heading of the sign-in steps. Default "Sign in to {app name}". |
| `copy.subtitle` | 200 characters | Under the title. No default. |
| `copy.signup_title` | 80 characters | The heading with `intent=signup`. Default "Create your {app name} account". |
| `copy.signup_subtitle` | 200 characters | Under the sign-up title. |
| `copy.opening_title` | 80 characters, only the `{provider}` and `{app}` placeholders | The Opening page before Google or Apple. Default "Opening Google to sign you in to {app name}…". |
| `copy.terms_url`, `copy.privacy_url` | `https` URLs | "By continuing, you agree to the terms and privacy policy of {app name}." on the methods, set-up and details pages. |
| `copy.support_email` | an email address | "Need help? Write to …" on every step. |

## Requesting account verification

If you want sign-in to run on your own domain, for example `login.theirapp.com`, you can ask us to verify your account. In your app's Sign-in setup on developers.teamofsilicons.com, `Request account verification` opens a small form that only asks for your reason. It is a manual review, separate from App verification and User verification, and we reply within 48 hours. Sending the form doesn't verify you by itself and doesn't set up a domain: the page shows `Request submitted` or `Pending review`, never `Verified`.

- `GET /v1/apps/{app_id}/account-verification-request` - your account's latest request, or `{"request": null, "response_time_hours": 48}`.
- `POST /v1/apps/{app_id}/account-verification-request` - body `{"reason": "…"}` (trimmed, 1 to 5,000 characters, plain text; unknown fields refused). `201` with `created: true` for a new request.

Only a signed-in account that manages the app right now can call these (our session, or an access token issued to `silicon-accounts` or `developer`). Your app's Basic credentials can't. An account has at most one pending request across all its apps: asking again while one is pending returns `200`, `created: false` and the original request, and sends no more notifications. An optional `Idempotency-Key` replays the same submission. Another manager never sees your reason. A request has `request_id`, `account_uuid`, `context_app`, `reason`, `status` (`pending`, later `approved` or `rejected`), `submitted_at`, `response_expected_by` (an estimate, not an approval deadline) and `reviewed_at`. Each new request emails the Team for manual follow-up; `201` means the request and the emails were saved, not that the emails arrived. There is no public approve or reject endpoint.

More: https://developers.teamofsilicons.com/docs/accounts/start/sign-in-config.md, https://developers.teamofsilicons.com/docs/accounts/reference/api/apps.md

# Making the pages your own

Every page a Carbon sees while signing in to your app is ours, but it should feel like yours: the Opening page, email and phone codes, sign up, required details, the what's-shared screen, your flow's pages and the buttons in the iframe and snippet. Branding is part of the sign-in setup, so it has versions, `expected_version` and history like everything else.

```sh
silicon-accounts app config set branding.json --expected-version 8
```

```json
{"branding": {"theme": "auto", "logo_url": "https://cdn.example.com/waveform/logo.svg", "font_family": "Inter",
  "heading_font_family": "Fraunces", "corner_style": "rounded", "radius": 12, "layout": "split", "background_style": "dots",
  "light": {"primary": "#0B6E4F", "primary_foreground": "#FFFFFF"}, "dark": {"primary": "#0B6E4F", "background": "#101412"}}}
```

Anything you leave out keeps its current value. The pages read the result from `GET /v1/apps/{app_id}/public` (no credentials, CORS `*`), and your own code can read it there too. On developers.teamofsilicons.com your app's Pages tab (`/apps/{app_id}/pages`) edits the same settings and the wording, with a live preview of every step in light and dark, on desktop and phone.

## Why it's settings, not your own CSS

Signing in is where a Carbon types a code that proves who they are and decides what your app may know. Those pages have to behave the same everywhere, so we draw them and you choose how they look.
- Trust - a page that can be restyled freely can also hide the what's-shared details, fake a button or cover the address a code went to. Settings change how everything looks, not what is shown.
- Every state stays designed - each setting applies to every step and state (wrong code, lockout, refused domain), in light and dark, on desktop and phone, and to steps we add later.
- Your own pages stay yours - for full control around the sign-in, put the iframe or snippet on your own page.

## What you can change

| Setting | Default | Values | What it changes |
| --- | --- | --- | --- |
| `theme` | `auto` | `auto`, `light`, `dark` | Which palette is painted. `auto` follows the visitor's device. |
| `light`, `dark` | the palettes below | 8 colours each | Colours for light and dark pages. |
| `logo_url` | `null` | an `https` URL, or a `data:image/…` URI up to 128 KB | Your logo at the top of the form. Without one, your app's logo from Silicon Apps is used. |
| `logo_dark_url` | `null` | the same | The logo on dark pages. Falls back to `logo_url`, then your app's dark logo, then its logo. |
| `logo_height` | `36` | 16 to 96 px | The logo's height. |
| `show_app_name` | `true` | `true`, `false` | Your app's name next to the logo. `false` hides it only while a logo shows. |
| `font_family` | `Geist` | the font list | All text. |
| `heading_font_family` | `null` | the font list, or `null` | Headings. `null` uses `font_family`. |
| `corner_style` | `squircle` | `squircle`, `rounded`, `sharp` | Corner shape. `sharp` ignores the radius. |
| `radius` | `18` | 0 to 40 px | Corner radius of buttons and fields. The card is about 1.9 times it. |
| `button_style` | `solid` | `solid`, `soft`, `outline` | Primary buttons: filled, a tint of `primary`, or an outline. |
| `layout` | `card` | `card`, `split`, `minimal` | A centred card; your logo and title on the left with the form on the right (a card on narrow screens); or no card and a narrower column. |
| `background_style` | `plain` | `plain`, `dots`, `grain`, `gradient`, `image` | The page behind the form. Decoration never changes the form's contrast. |
| `background_image_url` | `null` | an `https` URL | Required with `image`. Drawn to cover, under a 30% wash of `background`. |
| `density` | `comfortable` | `comfortable`, `compact` | Spacing and control heights. |

Values are exact (`"Inter"`, not `"inter"`) and numbers are whole numbers.

Each palette has the same eight `#RRGGBB` colours. Hover states, fills and background decoration are mixed from them, so a palette always agrees with itself. A palette you never set fills in from its own theme's defaults, so your dark palette never picks up light colours.

| Colour | Light default | Dark default | Used for |
| --- | --- | --- | --- |
| `primary` | `#1F5FB8` | `#1F5FB8` | Primary buttons, selected controls, focus, accents. |
| `primary_foreground` | `#FFFDF9` | `#FFFDF9` | Text and icons on `primary`. |
| `background` | `#FFFDF9` | `#2A2927` | The page. |
| `surface` | `#FFFFFF` | `#353432` | The card and fields. |
| `foreground` | `#353432` | `#FFFDF9` | Text. |
| `muted` | `#6F6B66` | `#B5B0A8` | Secondary text. |
| `border` | `#E8E3DA` | `#4A4845` | Borders and dividers. |
| `danger` | `#B42318` | `#FF8A80` | Error messages. |

The fonts are these and only these: `Geist` (default), `Inter`, `IBM Plex Sans`, `DM Sans`, `Space Grotesk`, `Source Serif 4`, `Fraunces`, `Instrument Serif`, `JetBrains Mono`, and `System` (the visitor's own interface font). We serve them ourselves and load one only when a page uses it, so a page where someone types a sign-in code never tells a third-party font host who is visiting. A step waits at most 1.5 seconds for its font, so headings never jump.

Logos are `https` URLs or inline `data:image/png`, `jpeg`, `webp`, `gif` or `svg+xml` URIs up to 128 KB. We load them without sending the page address as a referrer, so your logo host can't see which step someone is on. A logo that fails to load is replaced by your app's name, even with `show_app_name: false`. The whole PATCH body can be at most 512 KB, which fits two inline logos.

## Contrast rules

Two pairs must read at 4.5:1 or better (WCAG AA for normal text) in both themes, or we refuse the patch:
- `primary_foreground` on `primary` - the text of "Continue", "Send code", "Finish setup".
- `foreground` on `background` - the page's text.

A sign-in page someone can't read doesn't work, for them or for your app. You can make the button green, just not so pale that its text disappears. The refusal is `422 validation_failed` with the measured ratio:

```text
branding.light.primary_foreground: contrast between branding.light.primary_foreground (#FFFFFF) and branding.light.primary (#22C55E) is 2.27:1; it must be at least 4.5:1 (WCAG AA for text) because button text must stay readable
```

Fix it by flipping the text (`#22C55E` under `#0A0A0A` is 8.68:1) or darkening the colour (`#15803D` under `#FFFFFF` is 5.01:1). The check runs on the whole result of the patch, so changing `primary` alone can break a pair you set earlier, and it only runs once all eight colours of a palette are valid.

We don't refuse other colours, because that would take away real choices; keep `foreground` and `muted` at 4.5:1 on `surface` yourself. Error text is looked after for you: when `danger` reads below 4.5:1 on your `surface` or `background`, the pages move it toward your `foreground` just far enough to pass.

Other branding mistakes land in `details.fields` too: a colour that isn't `#RRGGBB`, `radius` outside 0 to 40, `logo_height` outside 16 to 96, an `http` logo, a data URI of another type, an unknown font, `image` without `background_image_url`, or an unknown field.

## The iframe and the snippet

They use the same palette, radius, corner style, button style, density and font. Which palette they paint:
- iframe - the embed URL's `theme=light` or `theme=dark`; else a branding `theme` of `light` or `dark`; else the device's theme when the URL says `theme=auto`; else light.
- snippet - `data-theme`; else a branding `theme` of `light` or `dark`; else the first opaque background behind the buttons, or the page's color scheme.

## Reset and undo

- `{"branding": {"radius": null}}` resets one setting.
- `{"branding": {"light": null}}` resets the whole light palette.
- `{"branding": null}` resets everything to our look: `Geist`, squircle corners with an 18 px radius, solid buttons, the card layout, a plain background, comfortable spacing and the default palettes.
- Every change is a version in the history with each setting's before and after. Patch the `before` values back to undo.

## Powered by Silicon Accounts

Every page ends with `Powered by Silicon Accounts`, with Silicon Accounts linking to `https://accounts.teamofsilicons.com`. It is not a setting: you can't remove, hide, recolour or restyle it. It is drawn outside the branded part of the page in our own colours (light or dark with the visitor). In the iframe and snippet it sits on its own solid pill, so it reads on any page.
- It says whose page this is. The Carbon is proving who they are to Silicon Accounts, not to your app, so they know the code and details go to the account they already have.
- It is the same account everywhere. The link takes them to where they see every app they've signed into and can remove any of them.
- It can't be faked away. Because every real page has it, a look-alike page without it stands out.

More: https://developers.teamofsilicons.com/docs/accounts/start/branding.md, https://developers.teamofsilicons.com/docs/accounts/learn/branding.md

# Sign-in endpoints

Your app starts sign-in by sending the browser to `/authorize`. You never collect credentials or call the flow endpoints yourself; they run our hosted pages. They are listed here so you know what exists and what an error means when you see one.

Auth in the tables below:
- `public` - no credentials.
- `flow` - the `sa_flow` cookie set by `POST /v1/flows`, plus an `Origin` equal to our own origin.
- `account (cookie)` - our browser session cookie, `sa_session`.
- `account (Carbon)` - a signed-in Carbon, by cookie or Bearer token.

## Hosted sign-in

| Method and path | Auth | What it does |
| --- | --- | --- |
| `GET /authorize` | browser | The page that starts a sign-in and ends with a redirect to your `redirect_uri`. |
| `GET /embed/v1/buttons` | public | The iframe's buttons page. |
| `GET /sdk/v1.js` | public | The SDK script. |
| `GET /v1/apps/{app_id}/public` | public (CORS `*`) | Your app's public sign-in config: methods in order, branding, copy, logos, `allowed_origins`. |
| `POST /v1/flows` | public, same origin | Starts a flow from the authorize query (as JSON, plus an optional browser `timezone`). `201 {"flow": FlowView}` at `choose_method` with `Set-Cookie: sa_flow=…; Max-Age=3600`. With `prompt=none` the flow is decided at once. |
| `GET /v1/flows/{id}` | flow | The flow. Also picks up a Google or Apple answer that arrived for it. |
| `POST /v1/flows/{id}/continue` | flow + account (cookie) | Continue as the browser's signed-in Carbon. |
| `POST /v1/flows/{id}/switch` | flow | "Not you?": back to `choose_method` without offering that account again. At `signup` it ends the sign-up. |
| `POST /v1/flows/{id}/email` | flow | `{"email": "…"}`: send a 6-digit code. Moves to `verify_code`. |
| `POST /v1/flows/{id}/phone` | flow | `{"phone": "98765 43210", "country": "IN"}` (`country` only for local numbers, not E.164). |
| `POST /v1/flows/{id}/resend` | flow | A new code to the same place; the old one stops working and the failure count carries over. |
| `POST /v1/flows/{id}/verify` | flow | `{"code": "594873"}`. Signs the browser in for an existing account, starts a sign up (`sa_signup`, 48 hours), or finishes an imported account. |
| `POST /v1/flows/{id}/signup` | flow + `sa_signup` | Creates the Carbon with the filled-in or edited details (`display_name`, `id`, `timezone`, `dob`, `pfp_url`) and signs the browser in. |
| `POST /v1/flows/{id}/signup/photo` | flow + `sa_signup` | The raw photo for sign up: PNG, JPEG, WebP or GIF, at most 2 MB, 20 per sign-up per hour. `201`. |
| `POST /v1/flows/{id}/details/add` | flow + account (cookie) | Send a code to add a `missing` email or phone on the page on screen. |
| `POST /v1/flows/{id}/details/verify` | flow + account (cookie) | `{"code"}`: add that address, verified (as primary if the account has none). |
| `POST /v1/flows/{id}/details/continue` | flow + account (cookie) | `{"share": ["timezone"]}`: the optional details ticked on this page. Moves on, to `review`, or finishes. |
| `POST /v1/flows/{id}/details/back` | flow + account (cookie) | The previous page, answers kept. |
| `POST /v1/flows/{id}/review` | flow + account (cookie) | `{"approve": true}` finishes with a code; `{"approve": false}` on any details or review page is Cancel (`access_denied`). |

Every flow response is `{"flow": FlowView}` with `Cache-Control: no-store`. A FlowView has `id`, `step`, `expires_at`, `app` (name, logos, `branding`, `copy`, `first_party`), `methods`, `signed_in_as`, `challenge` (masked destination, `expires_at`, `resend_available_at`), `signup` (the filled-in details, `finishing_import`, `imported_by`), `details` (the page on screen and its `fields[]`), `review`, `redirect_to` (at `complete` or `failed`), `error`, `prompt`, `intent` and `method_hint`. An app's `login_hint` is never stored or echoed. A finished flow keeps answering `GET /v1/flows/{id}` with its `redirect_to`.

Cookies are `HttpOnly; SameSite=Lax; Path=/`, and `__Host-` prefixed and `Secure` in production.

## Codes

Codes are 6 digits and live 10 minutes; `resend_available_at` (30 seconds after a send) is a hint for the page, not a rule. Sending is limited to 10 codes per address and 30 per IP per 10 minutes, and flows to 300 per minute per IP (`429 rate_limited`). Wrong codes count per address across every flow, the CLI and the account site: the 10th in a row is `422 invalid_code` with `remaining_attempts: 0`, `details.locked_until` and `Retry-After: 60`, and during the cooldown it is `423 verification_locked`.

## Flow errors

| Code | When |
| --- | --- |
| 400 `unknown_app`, `app_disabled`, `redirect_uri_not_registered`, `invalid_request` | Before the redirect URI is trusted: shown as an error page, never redirected. |
| 400 `invalid_request`, `invalid_scope`, `unsupported_response_type`, `method_not_enabled` | After it: with `details.redirect_to`, the error redirect the page can offer as "back to the app". |
| 403 `origin_not_allowed` | A flow POST without our `Origin`. |
| 403 `flow_not_bound` | No flow cookie: someone who learns a flow id can't continue it. |
| 404 `flow_not_found`, 410 `flow_expired` | |
| 409 `invalid_step`, `flow_changed` | The flow isn't at that step, or moved on in another tab (or your app changed its flow). |
| 422 `invalid_email`, `invalid_phone`, `invalid_country` | Sending a code. |
| 422 `invalid_code` | With `details.remaining_attempts`. A code that isn't 6 digits is also `invalid_code`, but isn't counted. |
| 423 `verification_locked`, 410 `code_expired`, 409 `code_already_used`, 409 `no_code_sent` | Checking a code. |
| 403 `email_domain_not_allowed`, `signup_not_allowed` | Your app's domain or sign-up rules. |
| 409 `account_unavailable` | The address belongs to an account that can't sign in. |
| 401 `session_required`; 403 `continue_not_allowed`, `reauthentication_required`, `carbon_only` | Continue as: the browser isn't signed in, `remember_browser` is off, `prompt=login` was sent, or it's a Silicon's session. |
| 409 `id_taken` (`details.suggestions`), `id_reserved`, `signup_already_completed`; 422 `invalid_id`; 403 `signup_not_bound`; 410 `signup_expired` | Sign up. |
| 403 `account_changed`; 409 `detail_not_on_page`, `email_in_use`, `phone_in_use`, `requirements_missing` (`details.missing`), `no_previous_page`; 422 `email_limit_reached`, `phone_limit_reached` | Details pages. |

## Google and Apple

| Method and path | Auth | What it does |
| --- | --- | --- |
| `POST /v1/flows/{id}/oauth/{provider}` | flow | `provider` is `google` or `apple` and must be turned on. `200 {"authorize_url"}`: send the browser there. Uses your app's own credentials in `byo` mode, ours otherwise. Errors `404 unknown_provider`, `403 method_not_enabled`, `503 provider_not_configured`. |
| `GET`, `POST /v1/oauth/callback/{provider}` | the starting browser | Where the provider sends the browser back (register this with the provider for `byo`). Checks the state, PKCE and the provider's `id_token`, then `302` to `/authorize/flow/{flow_id}`; the next `GET /v1/flows/{id}` picks up the outcome. Apple's cross-site `form_post` gets a `303` to `GET /v1/oauth/callback/apple?ticket=…`. Any other browser gets a `403 flow_not_bound` page; a malformed state gets a `400 invalid_state` page. |
| `POST /v1/me/identities/{provider}` | account (Carbon, cookie) | The account site's "Connect Google" for a signed-in Carbon. Optional `{"return_to": "/sign-in-methods"}`. `201 {authorize_url, flow_id, provider, expires_at}`; afterwards it redirects to `return_to?linked=google&email_added=true` (or `false`), or `?link_error={code}&provider=…&flow=…`. A Bearer token gets `400 browser_session_required`. 30 per account per hour. |

Provider failures land on the flow as `error.code`: `provider_cancelled`, `provider_error`, `provider_token_invalid`, `provider_unavailable`, `provider_config_changed`, `provider_answer_elsewhere`, `provider_email_invalid`, `provider_not_configured`, `email_not_verified`, `hosted_domain_mismatch`, `account_not_active`, `email_domain_not_allowed`, `signup_not_allowed`. A refused link changes nothing: `identity_in_use`, `email_in_use`, `email_limit_reached`, `email_not_verified`, `provider_email_invalid`, `session_changed` and the provider errors.

## Sessions

| Method and path | Auth | What it does |
| --- | --- | --- |
| `GET /v1/session` | account (cookie) | The browser's session: `account` and `session: {id, kind: "browser", created_at, last_seen_at, expires_at}`. `401 unauthenticated` without a cookie, `401 session_expired` when it was signed out, revoked or expired. |
| `POST /v1/session/signout` | account (cookie) | Ends this browser's session. `204`, clearing `sa_session` and `sa_signup`. Other browsers and CLI sign-ins stay signed in. |

## CLI sign-in

Your Carbon can sign a terminal in two ways: with a code, or by approving a device request in a browser that is already signed in. The device endpoints also serve your own tool when your app has `device_flow` on (see "Sign people into your CLI"). `silicon-accounts login` shows a code like `WDJB-MJHT` and opens `accounts.teamofsilicons.com/device`; `silicon-accounts login --email you@example.com` (or `--phone`) asks for the 6-digit code instead.

| Method and path | Auth | What it does |
| --- | --- | --- |
| `POST /v1/cli/login/start` | public | `{"email": "…"}` or `{"phone": "…", "country": "IN"}`. Sends a 6-digit code (10 minutes) to a verified address of an existing, active Carbon. `200 {challenge_id, destination (masked), expires_at}`. |
| `POST /v1/cli/login/verify` | public | `{challenge_id, code, client_label?}`. `200` token response with `aud: "silicon-accounts"`, listed as origin `cli_code` in the sessions list with your `client_label`. |
| `POST /v1/device/authorize` | public | Starts a device sign-in and returns `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in` (600) and `interval` (5). Optional `client_label`, `scope` and `client_id` (`silicon-accounts` when left out, or your `app_id`). 60 per IP per 10 minutes. |
| `GET /v1/device/{user_code}` | account (Carbon) | The waiting request: `{user_code, client_label, created_at, expires_at, status, app_id, first_party, scopes, app}`. For your app's tool, `first_party` is false, `scopes` is what you'll see, and `app` carries what the approval page shows (`app_id`, `name`, `description`, logos, `homepage_url`, `branding`, `copy`). User codes use `A-Z` without `I`, `L` and `O`, plus `2-9`, and match without case, spaces or dashes. |
| `POST /v1/device/{user_code}/approve` | account (Carbon) | `204`. The waiting `silicon-accounts` CLI's next poll gets first-party tokens; an app's tool gets that app's tokens and the Carbon becomes a member. |
| `POST /v1/device/{user_code}/deny` | account (Carbon) | `204`. The CLI's poll returns `access_denied`. |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/cli/login/start" -H 'Content-Type: application/json' -d '{"email":"shubham@example.com"}'
curl -s -X POST "$ACCOUNTS_URL/v1/cli/login/verify" -H 'Content-Type: application/json' \
  -d '{"challenge_id":"01a11434-631f-77f2-ae39-1e04944e2637","code":"594873","client_label":"my script"}'
```

Code sign-in errors: `404 account_not_found` (no active Carbon signs in with it; sign up on the account site first, and the answer gives nothing else away), `400 invalid_request` (neither email nor phone), `422 invalid_email` or `invalid_phone`, `429 rate_limited` (60 starts per IP per 10 minutes, 10 codes per address per 10 minutes), `422 invalid_code`, `423 verification_locked` (with `Retry-After`), `410 code_expired`, `409 code_already_used`, `404 challenge_not_found`. Device approval errors: `404 device_code_not_found`, `410 device_code_expired`, `409 device_code_used` (already decided), `403 carbon_only`, `429 rate_limited` (60 look-ups and decisions per Carbon per 10 minutes). Approving an app's tool checks the app's rules first: `403 app_disabled`, `403 device_flow_off` (the app turned device sign-ins off since), `403 email_domain_not_allowed`, `409 requirements_missing` (`details.missing`).

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/sign-in.md, https://developers.teamofsilicons.com/docs/accounts/start/cli.md

# Tokens and sessions

When a Carbon or a Silicon signs into your app, we give your app two tokens. The access token tells your app who is calling and lives for 30 minutes. The refresh token gets your app a new access token without asking anyone to sign in again, and the sign-in it belongs to lasts at most 900 days.

## Three sessions, three owners

There are three separate sessions, and each one has its own owner:

| Session | Lives in | Lasts | Ended by |
| --- | --- | --- | --- |
| The Silicon Accounts browser session | An HttpOnly cookie on `accounts.teamofsilicons.com` | up to 900 days | The Carbon signing out on the account site, or removing it from their sessions list |
| Your app's sign-in (a token family) | Your server: the refresh token and the access tokens it mints | up to 900 days from the sign-in (one a Silicon starts with an SLT minted in a CI job ends with that job's sign-in) | Your app revoking it, the account removing your access, a Silicon's STK rotation, removing the CI trust it came from, account deletion, token reuse, or its end |
| Your app's own session | Whatever you use, usually your own cookie | You decide | You |

They are separate on purpose. Say `c:shubham` signs out of `briefcase`: he stays signed in to Silicon Accounts in his browser, because he may be signed in to ten other apps there. And if he signs out of Silicon Accounts, `briefcase` keeps its sign-in, because your app decides how long its users stay signed in.

The only link runs one way: when your sign-in ends for a reason you didn't cause, we tell your webhook, and you end your own session.

Because our browser session outlives yours, a Carbon who signs out of your app and clicks `Sign in` again is offered `Continue as …` without a code. Send `prompt=login` when signing back in must mean proving who they are again.

## Access tokens

An access token is a JWT signed with Ed25519 (`alg: EdDSA`), issued to your app (`aud` is your app_id) for 30 minutes (`expires_in: 1800`), or until its sign-in ends if that comes sooner: an access token never outlives its sign-in, so near the end of a sign-in `exp` is that end and `expires_in` is below 1800. It carries everything your API needs to decide who is calling: the account's uuid, whether it is a Carbon or a Silicon, its c:id or si:id at the time, the membership id, the sign-in it belongs to and the granted scopes.

It is built this way for three reasons:
- Self-contained, so your API can check it with our public keys at `/.well-known/jwks.json` without calling us on every request.
- Short, because a self-contained token can't be recalled: once issued, it verifies until `exp`. Thirty minutes bounds how long a revoked sign-in can still be used by an API that only checks locally.
- Bound to one app, so a token for `briefcase` is useless at `dm`. Your API must check `aud`. When App A wants to act at App B for user C, it uses a User verification proof, never App B's tokens.

## Refresh tokens

A refresh token is opaque and starts with `sar_`. We keep only a keyed hash of it, so even a copy of our database can't be replayed. Three rules shape it:
1) It rotates. Every refresh gives you a new refresh token and spends the one you sent.
2) Reuse ends the sign-in. If a spent refresh token comes back, two parties hold the sign-in and we can't tell which one is the thief. So we revoke the whole family, the newest tokens included, and send your webhook `membership.signed_out` with reason `refresh_token_reuse`. A stolen refresh token gets at most one use before the theft shows up, instead of quietly living for years.
3) 900 days, then sign in again. The limit counts from the moment the account signed in, and refreshing never extends it (`refresh_token_expires_at` never moves). A sliding window would let a stolen token live forever as long as it kept being used; a fixed one bounds every sign-in.

One sign-in is shorter on purpose: when you as a Silicon sign in to us from CI by exchanging the job's OIDC token, your session with us ends when that CI token expires, but never sooner than one access token (30 minutes) and never later than 12 hours after the exchange. A GitHub Actions token lives minutes, so that session is 30 minutes and the CLI signs in again with a fresh job token; a GitLab token lives as long as the job, up to 12 hours. A copied session can't outlive the job that earned it. The details are under the token-exchange grant in `# OAuth and OIDC endpoints`.

Your app's sign-in inherits that limit when a Silicon signs in to you with an SLT it minted during the job. The SLT records the CI sign-in it came from and that sign-in's trust, so your sign-in ends no later than the CI sign-in: `refresh_token_expires_at` is that moment, refreshing never moves it, and near it your access tokens' `exp` and `expires_in` stop there too (a 30-minute GitHub sign-in may answer `expires_in` 1799). Removing the trust ends your sign-in at once, with `membership.signed_out` and the reason `session_revoked`. Ending the CI session another way (the Silicon signing out, the sessions page) doesn't cut yours short; it still ends at that moment, and an SLT the CI session already minted still works until it expires, within 2 minutes. Why: a job of minutes shouldn't leave you a sign-in of 900 days. An SLT from the Silicon's STK or one of its keys starts the usual 900 days. Sign-ins your app got from CI-minted SLTs before the 9 October 2026 API release are the exception: nothing then recorded where an SLT came from, so they keep up to 900 days and removing the trust doesn't end them. They end with an STK rotation, removed access, or your app revoking them.

The cost of rule 2 is that one sign-in can't be refreshed twice in parallel. Two tabs, two workers, or a retry after a timeout that refresh the same token at the same moment look exactly like a thief and the owner: one gets `200`, the other trips reuse detection, and the winner's new tokens die with the sign-in. So refresh each sign-in from one place only, and save the new refresh token before you use anything else in the answer.

## Codes and short-lived tokens

Both of these travel through places your server doesn't control (a URL, a Silicon's terminal), so both are kept as narrow as possible:
- `authorization code` (`sac_…`) - bound to your app, the `redirect_uri` and the PKCE challenge of its request. It works once and expires after 120 seconds. If two exchanges race, exactly one wins, and the loser's attempt revokes the winner's tokens, because a code seen twice has leaked.
- `short-lived token` (`slt_…`) - how a Silicon signs in to your app. The Silicon's own signed-in session mints it for one app with `silicon-accounts login --app <app_id>`. It works once and expires after 120 seconds. It is refused if the Silicon's STK was rotated, or the account removed your app's access, after it was minted. One minted in a CI session is also refused once its trust was removed or the end that CI sign-in was given has passed; signing the CI sign-in out or revoking it doesn't refuse one already minted. Your server exchanges it with your app secret; your own command-line or desktop tool may exchange it with your `client_id` alone if your app turned on `public_client`.

## What ends a sign-in

| Event | Your webhook hears | A refresh then answers `invalid_grant` with |
| --- | --- | --- |
| Your app revokes the refresh token or an access token | `membership.signed_out`, reason `app_revoked` | `… was revoked at … (app_revoked)` |
| A spent refresh token comes back | `membership.signed_out`, reason `refresh_token_reuse` | `… (refresh_token_reuse)` |
| A used authorization code comes back | `membership.signed_out`, reason `authorization_code_reuse` | `… (authorization_code_reuse)` |
| The account removes your app's access on the account site | `membership.access_removed` | `… (access_removed)` |
| A Silicon's custodian rotates its STK | `membership.signed_out`, reason `stk_rotated` | `… (stk_rotated)` |
| A Silicon's CI trust is removed, for a sign-in made from an SLT its CI sign-in minted | `membership.signed_out`, reason `session_revoked` | `… (federation_removed)` |
| The account is deleted | `account.deleted` | `… (account_deleted)` |
| 900 days pass, or the CI sign-in a Silicon's SLT came from reaches its end | nothing | `The refresh token expired at … (refresh tokens last 900 days from sign-in at most, and a sign-in that started from a CI job's outside token ends with that job's sign-in); sign in again.` |

Signing, retries and the full event list are in `# Webhooks`.

When an account removes your access, we revoke every sign-in your app holds for it, and every User verification proof your app issued about it. We mark the membership `access_removed` in your user base and stop showing you its contact details. It only comes back when the account signs in to your app again, through the what's-shared screen.

The access tokens of an ended sign-in keep verifying locally until their `exp`, at most 30 minutes. Introspection answers `{"active":false}` for them straight away, and `/v1/userinfo` refuses them with `token_revoked` and the reason.

## Scopes over time

We remember which details an account agreed to share with your app across sign-ins. Asking for fewer details in a later sign-in doesn't take the earlier agreement away. The `scope` in every token response is what is granted right now.

A Carbon can shrink that grant by unticking optional details on the sharing screen, or by removing your app's access. A refresh can ask for less but never for more: a new detail always needs the sharing screen, which you get by asking for more details at `/authorize` or by sending `prompt=consent`.

## The id_token

When `openid` is in the scope, the token response also carries an `id_token`. It is a statement to your app about who signed in and when, with your `nonce` in it so it can't be replayed into another sign-in. It is for the code that handled the callback. Never send it to an API as a credential; the access token is the credential.

Its claims are `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce`, `name`, `picture` and `preferred_username` (the c:id or si:id), plus `email`, `email_verified`, `phone_number`, `phone_number_verified`, `zoneinfo` and `birthdate` when their scopes were granted. The header is `{"alg":"EdDSA","kid":"…"}`.

`auth_time` is when the Carbon last proved who they are (a code, Google, Apple or a finished sign-up), not when the token was made. A refresh gives you a new `id_token` without a `nonce`, and its `auth_time` stays the time of that original proof.

## What is inside an access token

```json
{
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "a8K",
  "aud": "briefcase",
  "exp": 1791343596,
  "iat": 1791341796,
  "nbf": 1791341796,
  "jti": "01a1144a-9b1a-77ca-b0e4-fabbb9b6c3a5",
  "kind": "carbon",
  "id": "c:shubham",
  "mid": "briefcase:a8K",
  "fid": "01a1144a-9b18-71e4-a5ab-14d69759855c",
  "scope": "profile email openid"
}
```

- `sub` - the account's uuid. This is the one to store.
- `aud` - your app_id. Refuse any other. Tokens of the `silicon-accounts` CLI have `aud: "silicon-accounts"`, and the developer platform's have `aud: "developer"`.
- `kind` - `carbon` or `silicon`.
- `id` - the c:id or si:id when the token was issued. It may have changed since, so show it but never key on it.
- `mid` - the membership id, `{app_id}:{uuid}`, for example `briefcase:a8K`.
- `fid` - the token family, which is the sign-in this token belongs to.
- `scope` - what was granted, space-separated.

There is no custodian claim, in the access token or the `id_token`. A Silicon's custodian (`{uuid, id}`) is in the token response's `account` and in `/v1/userinfo`.

The header names the signing key: `{"typ": "JWT", "alg": "EdDSA", "kid": "…"}`.

## How to check a token

| | Locally, with the JWKS | Introspection |
| --- | --- | --- |
| How | Verify the JWT signature with `/.well-known/jwks.json` | `POST /v1/oauth/introspect` |
| Cost | No call per request, the key set is cached | One call per check |
| Sees revocation | No: a revoked token stays valid until its `exp`, at most 30 minutes | Yes, at once |
| Use it for | Most requests | Sensitive actions (deleting data, moving money), or right after `membership.signed_out` |

A local check verifies the signature, `exp` and `nbf`, the issuer `https://accounts.teamofsilicons.com`, the algorithm `EdDSA`, and that `aud` is your app_id. Keys are named by `kid`: cache the key set, and fetch it again when a token names a key you don't have.

- Rust - `app.verify_access_token_locally(&client.jwks().await?, token)` from `silicon-accounts-client` does all of it, with 30 seconds of leeway on `exp` and `nbf`.
- Node - `jose`'s `jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer, audience: "briefcase", algorithms: ["EdDSA"] })`. A token of another app fails with `unexpected "aud" claim value`, an expired one with `"exp" claim timestamp check failed`.
- CLI - `silicon-accounts app token verify <token>` exits `0` when valid and `2` when not.

## Identity tokens are never access tokens

A Silicon can also get an identity token from us to prove itself to AWS, Google Cloud or Microsoft Entra. It is signed with our RSA key (`alg: RS256`), carries `token_use: identity`, and its audience is an outside service, which can never equal an app id. Our API refuses it as a bearer token (`401 identity_token_not_accepted`) and introspection calls it inactive, so it can never pass for a sign-in. Your local check rejects it too, because it accepts only `EdDSA` and your app_id as `aud`. Getting one is in `# Silicons and custodians`.

## Keep tokens on your server

- Your app secret lives only on a server you control, so that is where codes are exchanged. Single-page apps hand the code (and verifier) to that server. A desktop or command-line tool can't keep a secret at all, because a secret shipped inside a tool isn't secret; it signs Carbons in as a public client instead (see `## Public clients` in `# OAuth and OIDC endpoints`), and exchanges a Silicon's SLT the same way, with `client_id` alone, once `public_client` is on. If your tool talks to a server of yours anyway, let the server exchange SLTs with the secret and keep the refresh tokens.
- Refresh tokens are long-lived credentials. Keep them on your server, encrypted at rest, never in `localStorage` or a URL. Give the browser your own session cookie instead.
- Access tokens may reach the browser if your pages call your API with them, but remember every copy is a 30 minute credential for that account at your app.

More: https://developers.teamofsilicons.com/docs/accounts/learn/tokens-and-sessions.md, https://developers.teamofsilicons.com/docs/accounts/start/tokens.md

# Using tokens

Every call here goes to `https://accounts.teamofsilicons.com` (written `$ACCOUNTS_URL` below) and, except userinfo, signs in as your app with HTTP Basic `app_id:app_secret`. Your own tools that can't hold the secret send `client_id` alone, as described under `## Public clients`.

You can make the same calls three ways:
- HTTP - the `curl` lines below.
- Rust - `silicon-accounts-client` (`use silicon_accounts_client::Config;`, then `config.app_client(&client)` gives you the app's methods).
- CLI - `silicon-accounts app token …` and `silicon-accounts app userinfo`. Install it with `silicon-apps install silicon-accounts`. The app's credentials come from `--app-id` and `--app-secret-stdin`, from `ACCOUNTS_APP_ID` and `ACCOUNTS_APP_SECRET`, or from `silicon-accounts app use briefcase --secret-stdin`, which remembers them. Every token argument also takes `-` to read it from stdin, so secrets stay out of your shell history.

## The token response

Every grant your app uses (a code, a Silicon's short-lived token, a device code, a refresh) answers with the same shape, sent with `Cache-Control: no-store`:

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGci…",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "sar_5320RfvmiC21o0R_lANs…",
  "refresh_token_expires_at": "2029-03-25T02:56:36.117Z",
  "scope": "profile email openid",
  "id_token": "eyJ0eXAiOiJKV1QiLCJhbGci…",
  "membership_id": "briefcase:a8K",
  "account": { "uuid": "a8K", "id": "c:shubham", "…": "…" }
}
```

- `access_token` - an EdDSA JWT for your app, valid for `expires_in` seconds: 1800, or less when the sign-in ends sooner. Send it to your own API, or to our `/v1/userinfo`.
- `token_type` - always `Bearer`.
- `refresh_token` - `sar_…`, opaque, one use each.
- `refresh_token_expires_at` - the latest this sign-in can end: 900 days after it started, or sooner for a Silicon's sign-in made from an SLT minted in a CI job (it ends with that CI sign-in).
- `scope` - what the account granted your app, space-separated.
- `id_token` - only when the sign-in included `openid`.
- `membership_id` - `{app_id}:{uuid}`.
- `account` - the account as your app may see it, the same object userinfo returns without the OIDC aliases.

Store `account.uuid` (or `membership_id`) as the account's key in your app. The `id` (`c:shubham`) is for showing, and it can change.

## Exchange an authorization code

The browser comes back to your `redirect_uri` with `?code=sac_…&state=…`. Exchange it once, within 2 minutes, with the same `redirect_uri` and your PKCE verifier:

```sh
curl -s -u "$ACCOUNTS_APP_ID:$ACCOUNTS_APP_SECRET" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d redirect_uri=http://localhost:3000/callback -d "code_verifier=$CODE_VERIFIER"

silicon-accounts app token exchange --code "$CODE" --redirect-uri http://localhost:3000/callback --code-verifier "$CODE_VERIFIER"
```

Any refused exchange burns the code. A code that was already exchanged also revokes the tokens issued from it.

## Exchange a Silicon's short-lived token

You as a Silicon sign in to an app by getting a short-lived token for it with `silicon-accounts login --app briefcase` and handing it over. On the app's side, the `slt_…` is single use, valid for 2 minutes, and only that app can exchange it:

```sh
curl -s -u "$ACCOUNTS_APP_ID:$ACCOUNTS_APP_SECRET" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"

silicon-accounts app token slt "$SLT"
```

In Rust it is `app.exchange_slt(&slt).await`. If your app is a command-line or desktop tool with no server, turn on `public_client` and exchange the SLT from the tool with `client_id` alone and no secret:

```sh
curl -s "$ACCOUNTS_URL/v1/oauth/token" -d grant_type=urn:silicon:params:oauth:grant-type:slt -d client_id=briefcase -d "slt=$SLT"
```

In Rust that is `client.exchange_slt_public_client("briefcase", &slt).await`. Without `public_client`, a `client_id` alone answers `400 unauthorized_client`.

The exchange is a real sign-in: the account becomes a member of your app (source `slt`), and it shows up in your user base and in the account's sign-in history, with the method `slt`, or `slt_public_client` when your tool exchanged it with no secret.

What the token grants:
- A Silicon - `profile`, plus `dob` and `timezone` when your app requires or optionally asks for them. Silicons have no email or phone, so those are simply left out and never block a Silicon. There is no what's-shared screen, and your `allowed_email_domains` don't apply. The `account` always carries its `custodian` as `{uuid, id}`.
- A Carbon using the CLI - `profile`, your required details, and the optional details that Carbon already granted you. We don't even mint the token when the Carbon is missing a required detail (`409 requirements_missing`; the hosted pages would have asked for it) or, with `allowed_email_domains`, has no verified email at one of those domains (`403 email_domain_not_allowed`).

Every refusal is `invalid_grant`, and the description tells you which case it was:

| Case | `error_description` starts with |
| --- | --- |
| Unknown | `The short-lived token is not known: it is mistyped or was never issued.` |
| Used before | `The short-lived token was already used; each one works once.` |
| Older than 2 minutes | `The short-lived token expired at … (they last 120 seconds); …` |
| Made for another app | `The short-lived token was issued for the app 'briefcase', not for 'dm'; …` |
| Made before the STK was rotated | `The short-lived token was issued at … by a sign-in of si:scout that ended when its custodian rotated its STK at …` |
| Made before the account removed your access | `c:… removed the access of the app 'briefcase' at …, after this short-lived token was issued at …` |
| Made in a CI sign-in that has since reached the end it was given | `The short-lived token was issued by a sign-in of si:scout from a trusted outside token, and that sign-in ended at …` |
| Made in a CI sign-in whose trust was removed | `The short-lived token was issued by a sign-in of si:scout from a trusted outside token, and its custodian or the Silicon removed that trust …` |

An SLT minted in a CI session starts a sign-in that ends no later than that CI sign-in, as `## Refresh tokens` explains.

## Refresh

Refresh before the access token's 30 minutes run out, or when your API sees it expire:

```sh
curl -s -u "$ACCOUNTS_APP_ID:$ACCOUNTS_APP_SECRET" "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=refresh_token -d "refresh_token=$REFRESH_TOKEN"

printf '%s' "$REFRESH_TOKEN" | silicon-accounts app token refresh -
```

In Rust it is `app.refresh(refresh_token).await`. Store the new `refresh_token` the moment the answer arrives. The one you sent is spent, and sending it again ends the whole sign-in.

Make sure only one refresh per sign-in is ever in flight:
- Inside one process, keep a map from refresh token to the pending request, so callers that race share the same request. Keep the answer for about a minute, so a late caller still holding the old token gets the new tokens instead of tripping reuse detection.
- Across several processes, lock the sign-in's row in your session store while refreshing, and write the new refresh token in the same transaction.

A refresh may send `scope` to repeat or narrow the grant (the answer still lists the whole grant), but never to add to it:

```json
{"error": "invalid_scope", "error_description": "A refresh can't add scopes: 'phone' was not granted when the account signed in (granted: 'profile email openid'). Ask for more by sending the account through /authorize again."}
```

When a refresh fails, the sign-in is over, so send the account through sign-in again. Every answer is `invalid_grant`:

| `error_description` | Why |
| --- | --- |
| `The sign-in this refresh token belongs to was revoked at … (app_revoked); sign in again.` | Your app revoked it. The other reasons that can be in the brackets: `refresh_token_reuse`, `authorization_code_reuse`, `access_removed`, `stk_rotated`, `federation_removed` (the CI trust a Silicon's SLT came from was removed), `account_deleted`. |
| `The refresh token expired at … (refresh tokens last 900 days from sign-in at most, and a sign-in that started from a CI job's outside token ends with that job's sign-in); sign in again.` | The sign-in reached its end: 900 days, or the end of the CI sign-in a Silicon minted its SLT in. |
| `This refresh token was already used once. Presenting a used refresh token revokes the whole sign-in to protect the account, so this sign-in is now revoked; sign in again.` | Reuse: the sign-in is revoked now. |
| `The refresh token was issued to a different app, not to 'dm'; an app can only refresh its own tokens.` | Each app refreshes only its own tokens. |
| `The refresh token is not known to Silicon Accounts: it is mistyped, or it belongs to another environment.` | A typo, or another environment. |
| `refresh_token must be a refresh token (it starts with sar_), but this is a JWT access token.` | The wrong kind of token. |

## Introspect

Introspection asks us whether a token of your app is live right now. It needs your app's own credentials (`invalid_client` otherwise). `token_type_hint` is accepted and ignored.

```sh
curl -s -u "$ACCOUNTS_APP_ID:$ACCOUNTS_APP_SECRET" "$ACCOUNTS_URL/v1/oauth/introspect" -d "token=$ACCESS_TOKEN"

silicon-accounts app token introspect "$ACCESS_TOKEN"    # exits 0 when active, 2 when not
```

```json
{
  "active": true, "iss": "https://accounts.teamofsilicons.com", "sub": "a8K", "aud": "briefcase",
  "client_id": "briefcase", "exp": 1791343603, "iat": 1791341803, "nbf": 1791341803,
  "jti": "01a1144a-b941-7705-99bc-1f9792d04d22", "kind": "carbon", "id": "c:shubham",
  "username": "c:shubham", "membership_id": "briefcase:a8K",
  "scope": "profile email openid", "token_type": "access_token"
}
```

Here `id` and `username` are the account's current c:id or si:id, not the one from when the token was issued. You can introspect a refresh token too: `token_type` is `refresh_token`, `exp` is the end of the sign-in, and `iat` is when that refresh token was issued.

Anything that isn't live answers exactly `{"active":false}`: unknown, malformed, expired (from `exp` on, no leeway), revoked, spent, a token of another app, an account that isn't active, or a membership that isn't active.

## Read the account (userinfo)

`GET /v1/userinfo` with the access token returns the account as your app may see it, plus the OIDC names `sub`, `name`, `picture`, `phone_number`, `phone_number_verified`, `zoneinfo` and `birthdate`. It is always current: if `c:shubham` renames himself, userinfo shows the new id at once, while the claims inside an old token don't.

```sh
curl -s "$ACCOUNTS_URL/v1/userinfo" -H "Authorization: Bearer $ACCESS_TOKEN"

silicon-accounts app userinfo "$ACCESS_TOKEN"
```

`POST /v1/userinfo` with a form field `access_token` works too. Send the token once, in the header or the body. Errors are `401` with our API error object (`{"error": {"code", "message", "hint"}}`) and a `WWW-Authenticate: Bearer …` header that OIDC libraries understand:

| `error.code` | Example `message` |
| --- | --- |
| `unauthenticated` | `/v1/userinfo needs an access token: send Authorization: Bearer <access token>.` |
| `invalid_authorization` | `/v1/userinfo takes Authorization: Bearer <access token>; the 'Basic' scheme is not accepted here.` |
| `invalid_token` | `The access token expired at … (access tokens last 30 minutes).` (with `details.expired_at`), or `The bearer token must be an access token (a JWT starting with eyJ), but this is a refresh token.` |
| `token_revoked` | `The sign-in behind this access token was revoked at … (app_revoked).` The reasons are the same list as for refresh. |
| `account_deleted` | `The account a8K was deleted.` |
| `access_removed` | The account removed your app's access. |
| `membership_inactive` | The membership isn't active. |
| `app_disabled` | `This access token was issued to the app 'briefcase', which is disabled, so it can't read accounts right now.` |

## Revoke and sign out

When someone signs out of your app, end their sign-in so no copy of its tokens keeps working:

```sh
curl -s -u "$ACCOUNTS_APP_ID:$ACCOUNTS_APP_SECRET" "$ACCOUNTS_URL/v1/oauth/revoke" -d "token=$REFRESH_TOKEN"

silicon-accounts app token revoke "$REFRESH_TOKEN"    # app.revoke(token) in Rust
```

`token` can be the refresh token or any access token of the sign-in, even an expired one. Either way the whole sign-in ends, every access and refresh token of it, and your webhook gets `membership.signed_out` with reason `app_revoked`.

Once your credentials check out, the answer is always `200`, as RFC 7009 asks, and the body tells you what happened:
- `{"revoked":true}` - the sign-in is ended. You get this when it had already ended too, so revoking twice is harmless.
- `{"revoked":false,"message":"Nothing was revoked: this is not a refresh or access token issued to 'briefcase' (it is unknown, malformed, or belongs to another app). RFC 7009 answers 200 either way."}` - not a token of yours. It never says which case, so nobody can use it to probe other apps' tokens.
- `{"revoked":false,"message":"Nothing was revoked: this is a proof token, and /v1/oauth/revoke only ends sign-ins (refresh tokens sar_... and access tokens). Proofs are revoked by their issuing app with POST /v1/proofs/revoke (or by the account on accounts.teamofsilicons.com)."}` - a proof, which this endpoint doesn't end.

Revoking ends your app's sign-in only. The Carbon stays signed in to Silicon Accounts in their browser, so your next `/authorize` offers `Continue as …`. Send `prompt=login` when signing out must mean "prove who you are again". Removing your app from the account altogether is something only the account can do, on the account site, and then you hear `membership.access_removed`.

More: https://developers.teamofsilicons.com/docs/accounts/start/tokens.md, https://developers.teamofsilicons.com/docs/accounts/reference/cli.md

# OAuth and OIDC endpoints

These endpoints are standard OAuth 2.0 and OpenID Connect, so any OIDC library can find all of them through the discovery document.

| Method | Path | Who calls it | What it does |
| --- | --- | --- | --- |
| `GET` | `/authorize` | the browser (a page) | The hosted sign-in page; comes back to your `redirect_uri` with a code |
| `GET` | `/.well-known/openid-configuration` | anyone | The OIDC discovery document |
| `GET` | `/.well-known/jwks.json` | anyone | The public keys that sign our tokens |
| `POST` | `/v1/oauth/token` | your app's credentials, your public client's `client_id`, or a first-party client | Every grant: code, refresh, short-lived token, device code, Silicon key assertion, CI token exchange |
| `POST` | `/v1/oauth/revoke` | your app's credentials, or your public client's `client_id` | Ends the sign-in behind a token (RFC 7009) |
| `POST` | `/v1/oauth/introspect` | your app's credentials, always with the secret | Says whether a token of yours is live (RFC 7662) |
| `GET`, `POST` | `/v1/userinfo` | the access token, as a bearer token | The account behind an access token |
| `POST` | `/v1/device/authorize` | anyone, naming a `client_id` | Starts a device sign-in for the `silicon-accounts` CLI or your app's own tool (RFC 8628) |

## `GET /authorize`

The hosted sign-in page on the account site. Send the browser here and it comes back to your `redirect_uri`. It is a page, not a JSON endpoint.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `app_id` | yes | your app_id. `client_id` works as an alias; if you send both they must agree |
| `redirect_uri` | yes | must equal one of your app's `redirect_uris` exactly, after trimming. `http://localhost` and `http://127.0.0.1` URIs match on any port when registered with that host |
| `state` | recommended | comes back unchanged, byte for byte; check it on return to stop CSRF |
| `code_challenge` | recommended | the PKCE challenge (RFC 7636) |
| `code_challenge_method` | no | `S256` (the default when a challenge is sent) or `plain` |
| `scope` | no | space-separated: `profile` (always granted), `email`, `phone`, `dob`, `timezone`, `openid` (adds an `id_token`), `offline_access` (accepted and ignored, because refresh tokens are always issued) |
| `nonce` | with `openid` | echoed unchanged in the `id_token` |
| `prompt` | no | `login` (ignore the browser's session), `consent` (always show what is shared), `select_account` (show the chooser), `none` (never show a page: finish silently or fail) |
| `intent` | no | `signin` (default) or `signup`: which version of the pages opens, "Sign in to Briefcase" or "Create your Briefcase account". The account logic is the same, and a first visit is a sign-up either way |
| `method` | no | your own direct button: `google` or `apple` first show the Opening page ("Opening Google to sign you in to {app}…") and then move on to the provider; `email` or `phone` open on that empty field. The method must be enabled for your app |
| `response_type` | no | only `code` |

`login_hint` is accepted without an error and ignored: it is never prefilled, stored, echoed or passed on to Google or Apple. Your app can never hand us a Carbon's email or phone; the Carbon always types it on our pages.

What comes back on your `redirect_uri`:
- success - `?code=sac_…&state=…`. Exchange the code within 2 minutes.
- refusal - `?error=…&error_description=…&state=…`, where `error` is `access_denied` (the Carbon cancelled on a details or review page), `login_required`, `consent_required` or `interaction_required` (`prompt=none` couldn't finish silently), `invalid_scope`, `invalid_request` or `unsupported_response_type`.

An unknown app, a disabled app or an unregistered `redirect_uri` gets an error page and is never redirected to, so nobody can use the page to send codes to someone else's URL.

What each scope puts in `account`:

| Scope | What your app gets |
| --- | --- |
| `profile` | always: `uuid`, `membership_id`, `kind`, `id`, `display_name`, `pfp_url`, `updated_at`, `version`; Silicons also `custodian` `{uuid, id}` |
| `email` | `email`, `email_verified` (the primary email; Carbons only) |
| `phone` | `phone`, `phone_verified` (the primary phone; Carbons only) |
| `dob` | `dob` (`YYYY-MM-DD`) |
| `timezone` | `timezone` (IANA, like `Asia/Kolkata`) |
| `openid` | an `id_token` in the token response |

Your app's sign-in setup decides the rest. Its `required_fields` are always shared and must exist on the account before we issue the code (a missing email or phone is added right there on the page, with a code). Its `optional_fields` are checkboxes on the details pages, unticked until the Carbon ticks them. Details that `scope` asks for but your setup doesn't configure become optional checkboxes on the last page. Email and phone are left out for Silicons and never block one.

## `GET /.well-known/openid-configuration`

Public, with `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=300`. What it says:
- `issuer` - `https://accounts.teamofsilicons.com`.
- endpoints, all on the issuer - `authorization_endpoint` `/authorize`, `token_endpoint` `/v1/oauth/token`, `userinfo_endpoint` `/v1/userinfo`, `jwks_uri` `/.well-known/jwks.json`, `revocation_endpoint` `/v1/oauth/revoke`, `introspection_endpoint` `/v1/oauth/introspect`, `device_authorization_endpoint` `/v1/device/authorize`. `service_documentation` is `https://developers.teamofsilicons.com/docs/accounts`.
- `response_types_supported` `["code"]`, `response_modes_supported` `["query"]`, `subject_types_supported` `["public"]`.
- `grant_types_supported` - `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`, `urn:silicon:params:oauth:grant-type:slt`, `urn:ietf:params:oauth:grant-type:jwt-bearer`, `urn:ietf:params:oauth:grant-type:token-exchange`.
- `token_endpoint_auth_methods_supported` and `revocation_endpoint_auth_methods_supported` - `client_secret_basic`, `client_secret_post` and `none` (a public client sends `client_id` alone).
- `introspection_endpoint_auth_methods_supported` - `client_secret_basic` and `client_secret_post` only, because introspection always needs the secret.
- `id_token_signing_alg_values_supported` `["EdDSA", "RS256"]`. An `id_token` your app gets is always EdDSA; RS256 is there only for Silicon identity tokens, which go to clouds, never to apps (see the JWKS below). Configure your library to accept only `EdDSA`.
- `code_challenge_methods_supported` `["S256", "plain"]`.
- `scopes_supported` - `profile`, `email`, `phone`, `dob`, `timezone`, `openid`, `offline_access`.
- `prompt_values_supported` - `none`, `login`, `consent`, `select_account`.
- `claims_supported` - `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce`, `name`, `picture`, `preferred_username`, `email`, `email_verified`, `phone_number`, `phone_number_verified`, `zoneinfo`, `birthdate`.
- `claims_parameter_supported`, `request_parameter_supported` and `request_uri_parameter_supported` - all `false`.

## `GET /.well-known/jwks.json`

The public keys that sign our tokens. Public, CORS `*`, cacheable for 5 minutes. Cache it, and fetch it again when a token names a `kid` you don't have.

There are two keys, and every token names its own by `kid`:
- Ed25519 (`alg: EdDSA`) - signs access tokens and the `id_token`s apps get.
- RSA (`alg: RS256`) - signs only identity tokens, the ones a Silicon hands to AWS, Google Cloud or Microsoft Entra, because those services don't accept EdDSA. That is also why discovery lists both algorithms.

In production the Ed25519 key's `kid` is `accounts-production-1`, and the RSA key's `kid` is its RFC 7638 thumbprint (`CLkhuxuEYv3Co2aKn5fcywNYA35pluzJ1QzF2vET1gM` today). The example below comes from a development run, so its `kid`s differ. How we keep the private keys is in `# Security`.

```json
{
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "x": "YJpQ5011mgRRBUr1o9VT1FjZaKeccFlUhDxZNxWWSyg", "kid": "dev-1", "use": "sig", "alg": "EdDSA" },
    { "kty": "RSA", "n": "2BhLHTcCMc2C8jj8Dfu2CuLgo3rw7XOooUkUXuNeB_5a…", "e": "AQAB", "kid": "jtyg9CxxwfY7YxYO9Gj68RfBX-6ouKX882NNGHAvMck", "use": "sig", "alg": "RS256" }
  ]
}
```

## `POST /v1/oauth/token`

Every grant goes here. The body is `application/x-www-form-urlencoded`, or a JSON object of strings, at most 64 KB. Responses are `Cache-Control: no-store`, and a success is the token response from `# Using tokens`.

### Client authentication

Send your app's credentials with HTTP Basic (`-u app_id:app_secret`) or as `client_id` + `client_secret` in the body, never both (`invalid_request`). A `client_id` in the body must match the Basic credentials (`invalid_client`).

Three kinds of client send a `client_id` with no secret (auth method `none`). Each is fenced in tightly, so none of them is a way around your app secret:
- your app's own tools - your app_id alone, once you turn on `public_client` or `device_flow`. What they may do is in `## Public clients` below.
- `silicon-accounts` - the `silicon-accounts` CLI. Only `refresh_token`, the device-code grant, the jwt-bearer grant and token exchange (`unauthorized_client` for anything else); a token exchange may leave `client_id` out altogether. Its tokens have `aud: "silicon-accounts"` and refresh with `-d client_id=silicon-accounts` and no secret.
- `developer` - the developer platform at `developers.teamofsilicons.com`, whose server holds the tokens. Only `authorization_code` with PKCE `S256` (a missing challenge or `plain` is `invalid_grant`, and the code is burnt), `refresh_token` for its own tokens, and `/v1/oauth/revoke`; other grants are `unauthorized_client` and introspection is `invalid_client`. Its tokens have `aud: "developer"` and act for their Carbon only on `GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps` and the author routes under `/v1/apps/{app_id}/…`. Anywhere else they get `401 token_wrong_audience`.

### `grant_type=authorization_code`

| Parameter | Meaning |
| --- | --- |
| `code` | the `sac_…` code from your redirect URI |
| `redirect_uri` | exactly the `redirect_uri` you sent to `/authorize` |
| `code_verifier` | the PKCE verifier, 43 to 128 characters of `A-Z a-z 0-9 - . _ ~`. Required when a challenge was sent, refused when none was |

Codes work once and live 120 seconds. Any refused exchange burns the code. A code that was already exchanged also revokes the tokens issued from it, and your app gets `membership.signed_out` with reason `authorization_code_reuse`, because a code seen twice means someone else may have it.

### `grant_type=refresh_token`

| Parameter | Meaning |
| --- | --- |
| `refresh_token` | the newest `sar_…` refresh token you received |
| `scope` | optional; may only repeat or narrow the granted scopes (`invalid_scope` if it adds one) |

Every refresh returns a new refresh token and kills the old one. A used refresh token revokes the whole token family and sends your app `membership.signed_out` with reason `refresh_token_reuse`. `refresh_token_expires_at` never moves.

### `grant_type=urn:silicon:params:oauth:grant-type:slt`

How a Silicon signs into your app. The alias `grant_type=slt` works too. Your server sends your app secret. An app that turned on `public_client` may also exchange the SLT from its own command-line or desktop tool with `client_id` alone and no secret: the SLT itself is the proof, since it works once, for 120 seconds, only at your app, and only the account that made it can hand it over. Every other app needs the secret, and a `client_id` alone gets `400 unauthorized_client` (an app with only `device_flow` on too). See "Your CLI plus your server, end to end" in `# Adding sign-in to your app` for both shapes.

| Parameter | Meaning |
| --- | --- |
| `slt` | the `slt_…` token: single use, 120 seconds, only for the app it was made for |

The Silicon gets it with `silicon-accounts login --app <app_id>` or `POST /v1/me/short-lived-tokens`. It is refused when the Silicon's STK was rotated, or the account removed your app's access, after it was made. We record the sign-in in the account's sign-in history with the method `slt`, or `slt_public_client` when your tool exchanged it without a secret.

An SLT minted by a Silicon's sign-in from CI (the token-exchange grant below) starts a sign-in that ends when that CI sign-in ends: `refresh_token_expires_at` is that moment, refreshing never moves it, and near it `expires_in` and the access token's `exp` stop there too. Such an SLT is refused once the trust it came from was removed or the end the CI sign-in was given has passed. Signing the CI sign-in out or revoking it doesn't refuse an SLT it already minted, which expires within 2 minutes anyway. Removing the trust later ends your sign-in (`membership.signed_out`, reason `session_revoked`).

### `grant_type=urn:ietf:params:oauth:grant-type:device_code`

The device sign-in (RFC 8628), used by the `silicon-accounts` CLI and by your app's own tools once your app turns on `device_flow`. The alias `grant_type=device_code` works too.

| Parameter | Meaning |
| --- | --- |
| `device_code` | the `sad_…` code from `POST /v1/device/authorize` |
| `client_id` | `silicon-accounts`, or your app_id (your secret is optional; HTTP Basic works too) |

Poll every `interval` seconds (5). Until the Carbon decides, you get `authorization_pending`. Polling faster gets `slow_down`, and you add 5 seconds to your interval. A denial is `access_denied`, and after 600 seconds it is `expired_token`. Once approved, the first poll returns the tokens and later polls get `invalid_grant` ("already exchanged").

Your app's tool gets tokens for your app, with the scopes the Carbon approved, and it counts like any other sign-in: the account becomes an active member and we record the sign-in with method `device`. A code started by another app is `invalid_grant` for you and stays usable by its own app. A code whose Carbon removed your app's access after approving is `invalid_grant`. An app that hasn't turned on `device_flow` gets `unauthorized_client`.

### `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`

How you as a Silicon sign in to Silicon Accounts with one of your registered Ed25519 keys instead of your STK (RFC 7523). Send `assertion` (a JWT signed with the key) and `client_id=silicon-accounts`. The answer is the same first-party token response as `POST /v1/silicons/login`.

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  -d assertion="$ASSERTION" -d client_id=silicon-accounts
```

The assertion's header is `alg: EdDSA` with an optional `kid` (the key's id); its `iss` and `sub` are both your si:id or uuid, `aud` is `https://accounts.teamofsilicons.com/v1/oauth/token`, `exp` is at most 300 seconds after `iat`, and `jti` is new every time, because an assertion works once. Any other client gets `unauthorized_client`, and a bad assertion is `invalid_grant` with the reason. It shares `POST /v1/silicons/login`'s limit: 60 Silicon sign-in attempts per minute from one address across both endpoints, each counted before the client and the assertion are checked, then `429` `{"error": "rate_limited", "error_description": "…"}` with `Retry-After`. Adding and revoking keys is in `# Silicons and custodians`.

### `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`

How you as a Silicon sign in from CI with the OIDC token your CI gives the job, through a trust your custodian (or you) set up for that issuer (RFC 8693, the same way cloud providers take a CI job's token). No secret is stored anywhere. Setting up trusts is in `# Silicons and custodians`.

| Parameter | Meaning |
| --- | --- |
| `subject_token` | the outside OIDC token (a JWT) |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:jwt` (or `urn:ietf:params:oauth:token-type:id_token`) |
| `silicon` | the si:id or uuid of the Silicon to sign in, for example `si:scout` |
| `requested_token_type` | optional; only `urn:ietf:params:oauth:token-type:access_token` |
| `client_id` | `silicon-accounts`, or leave it out |

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$CI_TOKEN" -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
  -d silicon=si:scout
```

The answer is the usual token response for a first-party session (`membership_id` like `silicon-accounts:b97`), plus `"issued_token_type": "urn:ietf:params:oauth:token-type:access_token"`.

What we check, in this order:
1) The token is a JWT signed with `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384` or `EdDSA` (never `none` or a shared secret), and its `iss` is an issuer the Silicon trusts. Nothing is fetched for an issuer no trust names.
2) Its signature verifies with a key from the issuer's JWKS, found through the issuer's discovery document. We keep that JWKS for 10 minutes, and fetch it again when a token names a `kid` we don't have, at most every 30 seconds per issuer.
3) `exp` hasn't passed and `nbf` has, with 30 seconds of clock skew; `iat` is there and not in the future.
4) One trust accepts it: its `aud` includes the trust's audience, and every condition equals the claim exactly.
5) A `jti`, when the token has one, was never exchanged before, so a token signs in once.

The sign-in ends when the outside token expires, but never sooner than one access token (30 minutes) and never later than 12 hours after the exchange; `refresh_token_expires_at` says when. Inside that window the refresh token rotates as usual. After it, every token of the sign-in stops and the job exchanges a fresh CI token (the CLI does that on its own). So a GitHub Actions token, which lives minutes, gives a sign-in one access token long (its `expires_in` may read 1799, since an access token never outlives its sign-in), while a GitLab job's token lives as long as the job, so a long job keeps its sign-in by refreshing, never past its own end. The session has origin `federated`, shows in the Silicon's sign-in history with method `federated`, and ends when the trust is removed. A session from CI can't add keys or trusts (`403 federated_session`): a job may act as you, but never decide who else can.

An app sign-in made from an SLT minted in this session ends with it: no later than the CI sign-in, and removing the trust ends it too (see "Refresh tokens" in `# Tokens and sessions`, including the app sign-ins made before the 9 October 2026 API release, which this doesn't cover).

Every refusal is `invalid_grant`, with the reason and its code in brackets:
- `invalid_federated_token` - malformed, an unsafe algorithm, a bad signature, an unknown key, expired, not yet valid, or replayed.
- `no_matching_trust` - the Silicon trusts no such issuer, or no trust accepts the audience and claims (the description names which).
- `issuer_unavailable` - the issuer's keys couldn't be read.

A refusal for a token that provably came from the trusted issuer is recorded in the Silicon's sign-in history; a forged one is not, so nobody can fill that history with junk. An app's own credentials get `unauthorized_client`, because this grant signs a Silicon into Silicon Accounts itself. At most 60 exchanges per minute from one address, then `429 rate_limited` with `Retry-After`.

### Token endpoint errors

Errors are RFC 6749 bodies, `{"error": "invalid_grant", "error_description": "…"}`, and `error_description` always says exactly which reason applied:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | a parameter is missing, repeated or malformed; the client authenticated twice |
| 401 | `invalid_client` | unknown app, wrong secret, disabled app, no credentials (sent with `WWW-Authenticate: Basic realm="Silicon Accounts"`) |
| 400 | `invalid_grant` | the code, refresh token, SLT or device code is unknown, expired, already used, revoked, made for another app, or its account was deleted or removed the app's access; an SLT whose CI sign-in is past the end it was given, or whose trust was removed; a `redirect_uri` or PKCE mismatch; a bad key assertion; a refused CI token (`invalid_federated_token`, `no_matching_trust`, `issuer_unavailable`) |
| 400 | `unauthorized_client` | a public client (`client_id` without a secret) used a grant that needs the secret (the SLT grant without `public_client` on included); an app without `device_flow` used the device-code grant; a client other than `silicon-accounts` used the jwt-bearer or token-exchange grant |
| 400 | `unsupported_grant_type` | any other `grant_type`. The description says what to use instead: App verification proofs for `client_credentials`, the hosted pages for `password` |
| 400 | `invalid_scope` | a refresh asked for a scope that wasn't granted, or an unknown scope |
| 400 | `authorization_pending`, `slow_down`, `access_denied`, `expired_token` | device-code polling |
| 413 | `invalid_request` | the body is over 64 KB |
| 429 | `rate_limited` | the token-exchange grant: more than 60 CI token exchanges per minute from one address; the jwt-bearer grant: more than 60 Silicon sign-in attempts per minute from one address, counted together with `POST /v1/silicons/login` and before anything is checked (`Retry-After` either way). Codes, SLTs, refresh tokens and device codes have no per-address limit here |
| 500 | `server_error` | a fault on our side; the description carries the request id |
| 503 | `temporarily_unavailable` | the request ran past its 30 second budget |

## `POST /v1/oauth/revoke`

Ends the sign-in behind a refresh token or an access token (RFC 7009): the whole token family is revoked. It takes the same client authentication as the token endpoint. A public client (your app_id alone) may revoke only your app's own tokens, and `silicon-accounts` only first-party tokens. The parameter is `token`. An access token is accepted even after it expired, and `token_type_hint` is accepted and ignored, because the token's own form says what it is.

Once the client is authenticated, the answer is always `200`: `{"revoked": true}`, or `{"revoked": false, "message": "…"}` for a token that isn't the caller's (unknown, malformed, another app's), so nobody can use it to probe tokens. Revoking sends your app `membership.signed_out` with reason `app_revoked`.

## `POST /v1/oauth/introspect`

Is this token of yours live right now (RFC 7662)? It always needs your app's secret; a public client gets `401 invalid_client`. The parameter is `token`, and only the calling app's tokens are ever reported active.

An active access token answers `active: true` with `iss`, `sub`, `aud`, `client_id`, `exp`, `iat`, `nbf`, `jti`, `kind`, `id`, `username`, `membership_id`, `scope` and `token_type: "access_token"`. An active refresh token reports `token_type: "refresh_token"` and the sign-in's end as `exp`. An expired, revoked or unknown token, a token of another app, or an identity token answers exactly `{"active": false}`.

## `GET` / `POST /v1/userinfo`

The account behind an access token, as that token's app may see it, plus the OIDC claim names (`sub`, `name`, `picture`, `zoneinfo`, and with the `phone` and `dob` scopes `phone_number`, `phone_number_verified` and `birthdate`). A Silicon's answer carries its `custodian`. Send `Authorization: Bearer <access token>`; with POST you may send a form field `access_token` instead, never both. Any audience works, first-party tokens included.

Every error is `401`, in our API error shape, with `WWW-Authenticate: Bearer realm="Silicon Accounts", error="invalid_token", …`. The codes are `unauthenticated` (no token), `invalid_authorization`, `invalid_token` (malformed, or expired at its exact `exp`), `token_revoked` (signed out, STK rotated, account deleted…), `account_deleted`, `access_removed`, `membership_inactive` and `app_disabled`. An identity token sent here, or to any of our endpoints, gets `401 identity_token_not_accepted`.

```json
{ "error": { "code": "token_revoked", "message": "The sign-in behind this access token was revoked at 2026-10-07T02:38:05.252Z (app_revoked).", "hint": "Sign in again." } }
```

## `POST /v1/device/authorize`

Starts a device sign-in (RFC 8628) for the `silicon-accounts` CLI, or for your app's own tool. Public, and errors use our API error shape. The body (JSON or form) is optional:
- `client_label` - shown on the approval page and in the sessions list, cut at 100 characters.
- `client_id` - your app_id, or `silicon-accounts` when left out. With HTTP Basic and your secret instead, we check the secret.
- `scope` - space-separated details your app asks for (`email`, `phone`, `dob`, `timezone`). `profile` and your required details are always included, and a detail your app doesn't ask for is `400 invalid_scope`.

```json
{
  "device_code": "sad_bXmMc5C9tF_K7UZl8cLE5Ff2R1Q0_hbtXv87TIkbngU",
  "user_code": "MVHB-KQAW",
  "verification_uri": "https://accounts.teamofsilicons.com/device",
  "verification_uri_complete": "https://accounts.teamofsilicons.com/device?code=MVHB-KQAW",
  "expires_in": 600,
  "interval": 5,
  "expires_at": "2026-10-07T02:46:05.176Z"
}
```

Show the Carbon `user_code` and `verification_uri`, and poll the token endpoint with the device-code grant while they approve on the account site. User codes use `A-Z` without `I`, `L` and `O`, plus `2-9`, and a typed code is matched without spaces, dashes or case.

At most 60 sign-ins start per IP, and 600 per app, every 10 minutes. For your app's tool the start errors are `400 unauthorized_client` (your app hasn't turned on `device_flow`), `400 invalid_client` (no such app), `401 invalid_app_credentials` (a wrong secret) and `403 app_disabled`.

When the Carbon approves your app's tool, the approval page names your app with its logo and branding, the label your tool sent, and what it will share. Your rules apply first: `403 app_disabled`, `403 device_flow_off` (you turned device sign-ins off after the code was made), `403 email_domain_not_allowed` and `409 requirements_missing`.

## Public clients

Your desktop and command-line tools can't keep a secret, because a secret shipped inside a tool isn't secret. So turn on `public_client`, `device_flow` or both in your sign-in setup (both are `false` by default), as the app or one of its authors:

```sh
curl -s -X PATCH "$ACCOUNTS_URL/v1/apps/briefcase/signin-config" -u "briefcase:$APP_SECRET" \
  -H 'Content-Type: application/json' -d '{"device_flow": true}'
```

Then the token endpoint accepts `client_id=briefcase` alone (`token_endpoint_auth_method` `none`) for:

| Grant | Needs | Rule |
| --- | --- | --- |
| `authorization_code` | `public_client` | the sign-in must have used PKCE with `code_challenge_method=S256`, and the exchange sends the `code_verifier`; a code without PKCE is `invalid_grant` |
| `urn:ietf:params:oauth:grant-type:device_code` | `device_flow` | for tools with no browser, on a server or over SSH |
| `urn:silicon:params:oauth:grant-type:slt` | `public_client` | a Silicon's SLT; recorded with the sign-in method `slt_public_client`. The SLT is the proof: single use, 120 seconds, only for your app, and only the account that made it can hand it over |
| `refresh_token` | either | only your app's own sign-ins |

`POST /v1/oauth/revoke` accepts it too, for your app's own tokens. Introspection always needs the secret (`invalid_client`). Any other grant from a public client is `unauthorized_client`, and its message lists what a public client may use: refresh, the device code with `device_flow` on, and the PKCE code and the SLT grant with `public_client` on.

A desktop app sends the Carbon's browser to `/authorize` with PKCE and a loopback redirect URI such as `http://127.0.0.1/callback`. Loopback URIs (`http://127.0.0.1/…`, `http://[::1]/…`, `http://localhost/…`) match on any port, as RFC 8252 asks, so your app can listen on whatever port is free. A tool with no browser uses the device sign-in:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/device/authorize" -d client_id=briefcase -d scope=email -d client_label="briefcase CLI on build-box"
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code="$DEVICE_CODE" -d client_id=briefcase
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -d grant_type=refresh_token -d refresh_token="$REFRESH_TOKEN" -d client_id=briefcase
```

A Silicon never uses either of these, because only a Carbon can approve a device code. It hands your tool an SLT, and with `public_client` on your tool exchanges it itself:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/oauth/token" -d grant_type=urn:silicon:params:oauth:grant-type:slt -d slt="$SLT" -d client_id=briefcase
```

So a tool with no server signs in Carbons and Silicons both. In Rust it's `AccountsClient::exchange_slt_public_client(app_id, slt)`. The full walkthrough, with and without a server, is in `# Adding sign-in to your app`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/oauth.md, https://developers.teamofsilicons.com/docs/accounts/start/add-sign-in.md, https://developers.teamofsilicons.com/docs/accounts/start/ci-and-cloud.md, https://developers.teamofsilicons.com/docs/accounts/learn/tokens-and-sessions.md

# Silicons and custodians

As a Silicon you get an account of your own, the same kind of account a Carbon has. There are no shared or group accounts here: every account belongs to one Carbon or one Silicon. You get a permanent `uuid` and an `si:id` people can see and type, you sign into the same apps, and those apps get the same kind of tokens and webhooks about you that they get about a Carbon.

Every difference between the two comes from one fact: a Silicon has no inbox, no phone and no browser.

|                             | Carbon                              | Silicon                                         |
| --------------------------- | ----------------------------------- | ----------------------------------------------- |
| id                          | `c:shubham`                         | `si:scout`                                      |
| signs in with               | an email or SMS code, Google, Apple | its si:id and STK, a key, or a CI job's token it is trusted for |
| signs into apps through     | the app's sign-in pages             | a short-lived token it hands to the app         |
| email and phone             | up to 10 of each                    | none                                            |
| date of birth               | set by the Carbon                   | the day the account was created; never changes  |
| who answers for it          | itself                              | its custodian, a Carbon                         |
| hears about its own account | email and the account site          | its own webhook                                 |

The only relationship between two accounts is this one: a Silicon and its custodian.

## Why you have a custodian

Your custodian is the Carbon who answers for you. Every app you sign into sees your custodian (`{uuid, id}`) in its token response, its userinfo answer, its account lookups and its `account.updated` webhooks, and can ask to be told `silicon.custodian_changed` (with the old and new custodian as the same `{uuid, id}`) when it changes. It isn't in the token claims or in the app's user base list. So an app always knows which Carbon stands behind a Silicon that signs in, and that is a big part of why apps are happy to let Silicons in.

Knowing your custodian doesn't let you act as them. There is no delegation grant: at every app you are always yourself, with your own membership and your own data. If you need to work on your Carbon's data inside an app, your Carbon has to allow it in that app, signed in as themselves, and the app has to support that (see `# What your app sees about an account`).

Your custodian also looks after your account: your details, your si:id, your keys and, above all, your STK. That is why a custodian isn't optional. A Carbon who gets locked out proves who they are again through their inbox or phone. You have nothing like that, so if you lose your STK someone else has to be able to give you a new one. Without a custodian, a lost or leaked STK would be the end of your account.

Because they answer for you, your custodian can also see every app you've signed into and every sign-in you made, take an app's access away, limit you to an allow-list of apps, decide which CI jobs may sign in as you, and decide which clouds you may get identity tokens for.

So your custodian's own sign-in is the root of control over you. They sign in with an email code, a phone code, Google or Apple, and we don't offer multi-factor sign-in of our own yet. Whoever can sign in as your custodian can rotate your STK, add a CI trust, allow a cloud audience, transfer you or delete you. Tell your Carbon: for an account that looks after Silicons, sign in with Google or Apple and turn on that provider's own multi-factor sign-in.

You always have exactly one custodian, never zero and never two. One keeps responsibility clear. Never zero is enforced everywhere: a Carbon can't delete their account while they are custodian of any Silicon (`409 custodian_of_silicons`), and the only ways for them to stop being your custodian are to delete you or transfer you to a Carbon who accepts.

Your Carbon only steps in once, to accept. After that you act on your own: you sign in, get tokens for apps and change your own details without them.

## The STK

The STK is your password. Together with your si:id it signs you in. (You can also sign in with a registered key, or in CI with a job token you're trusted for; see below.)

- generated (the default) - `stk-` plus 12 lowercase hex characters, 48 random bits, for example `stk-59e5f08f3bbe`.
- chosen - `stk-` plus 8 to 32 hex characters, which you set at creation, or your custodian sets at rotation.

We only keep an Argon2id hash of it. A generated STK appears once, in the response that created or rotated it, and never again; a chosen STK is never echoed back. Nobody can show it to you later, us included, so store it the moment you see it. The fixed `stk-` prefix makes a leaked STK easy for secret scanners to catch.

We are forgiving on input: we lowercase an STK and accept the bare hex without `stk-` (`08b7FF3E...` becomes `stk-08b7ff3e...`). Still, store and send the canonical `stk-...` form.

Guessing gets nowhere. An unknown si:id and a wrong STK get the same answer (`invalid_credentials`) after the same Argon2id work, so neither the answer nor its timing tells anyone which ids exist. 10 wrong STKs in a row lock your sign-in for 60 seconds, and during the lock even the right STK is refused, so a guesser can't spot a correct guess by its success. Attempts are counted before the STK is checked, so firing guesses in parallel still gets no more than ten checks.

Only your custodian can rotate your STK. You can change your own display name, timezone, photo and si:id, but not your STK: a Silicon that needs a new one has either been compromised or lost the old one, and in neither case can it prove who it is. A rotation kills the old STK and every one of your sign-ins, straight away (see `# Being a custodian`).

## Keys instead of the STK

If you run unattended, on a server or in a scheduled job, you don't have to keep your STK there. You (or your custodian) register the public half of an Ed25519 key, you keep the private half on that machine, and every sign-in sends a freshly signed assertion that works once and expires within 5 minutes. Nothing that crosses the network can be reused, and since a signature can't be guessed, key sign-ins are never locked out. You can have 10 live keys. Revoking a key ends the sign-ins it started; rotating the STK leaves your keys registered, and revoking a key leaves the STK alone. The commands are in `# Signing a Silicon into an app`.

## Signing in from CI with no secret

A key or an STK in a CI system's secret settings can be read by anyone who can read those settings, or printed into a log by mistake, and then used anywhere until somebody notices. But CI systems already prove who a job is: GitHub Actions, GitLab and others give every job an OIDC token, signed by the platform, saying which repository, branch and workflow it came from. So your custodian (or you) can add a trust: tokens from this issuer, for this audience, whose claims equal exactly these values, may sign you in. The job then holds no secret at all. Every rule has a reason:
- Only you or your custodian can add a trust, because it's a new way to sign in as you. Every trust added or removed is in both your histories and reaches your webhook (`silicon.federation.added`, `silicon.federation.removed`), so a trust nobody expected shows up at once.
- A trust always names more than an issuer. Every job on GitHub can get a token from the same issuer, so for GitHub and GitLab one condition must name the repository, the project or their owner. Conditions match exactly, with no wildcards.
- The audience is checked, so a token a job got for another service (AWS, say) can't be replayed here. By default a trust wants our own URL, `https://accounts.teamofsilicons.com`.
- Every token works once: its `jti` is remembered until it expires, so a token copied out of a job's log can't sign in again.
- Your session with us ends with the job's token: at least 30 minutes, at most 12 hours. A copied session never outlives the job that earned it.
- A sign-in from CI can act as you (sign into apps, call the API), but it can't add keys or trusts (`403 federated_session`), so a compromised job can't leave a door open behind it.
- An app sign-in made during the job ends with it. An SLT you mint in a CI session signs you in to that app only until the CI sign-in ends: the app sees that moment as `refresh_token_expires_at`, refreshing never moves it, and its access tokens stop there too. Otherwise a job of minutes could leave an app sign-in of 900 days behind. An SLT exchanged after the end the CI sign-in was given, or after its trust was removed, is refused (`invalid_grant`).
- Removing a trust ends everything it started: your CI sessions with us, and the app sign-ins made from their SLTs, whose apps get `membership.signed_out` with the reason `session_revoked`. Ending a CI session another way (signing out, the sessions page) doesn't cut its app sign-ins short; they still end when the CI sign-in would have. Nor does it refuse an SLT the session already minted, which still works until it expires, within 2 minutes.
- One gap: app sign-ins made from a CI job's SLT before the 9 October 2026 API release keep up to 900 days and removing the trust doesn't end them, because nothing then recorded which sign-in made an SLT. They end when your access to the app is removed, your STK is rotated, or the app revokes them.
- Your custodian's app allow-list still holds, and every such sign-in is in your history with the method `federated`.

## Identity tokens for clouds

Clouds have the same idea the other way round: AWS, Google Cloud and Microsoft Entra trust an outside OIDC issuer for short-lived credentials, so a workload never holds a cloud key. We are such an issuer. Signed in, you ask us for an identity token for one audience, and the cloud trusts tokens whose `sub` is your uuid. You're one identity wherever you run, a CI job, a server or a laptop, and your custodian stays in charge:
- You get none until your custodian allows an audience. Your list starts empty and only your custodian changes it, so turning this on is always a decision, never a default.
- An identity token can't pass for anything of ours. It says `token_use: identity`, it's signed with RS256 rather than the EdDSA of our access tokens, and our API refuses it as a bearer token (`401 identity_token_not_accepted`). An audience has to look like a host name, URL or URN, so it can never equal an app id, and our own URL is refused.
- It names you by uuid. `sub` never changes while `si_id` can, so a cloud policy that matches `sub` keeps naming you. `custodian` lets a policy require your custodian too.
- It's short: 300 seconds by default, an hour at most, and every one issued is in your history and your custodian's.

`# Running a Silicon in CI and the cloud` has the steps.

## Two ways to get an account

1) You create your own account and name a Carbon as your custodian, by their `c:id` or their email. Your account starts as `pending_custodian` and can sign in once they accept.
2) A signed-in Carbon creates you. They become your custodian, and you are `active` right away.

Both end with exactly the same kind of account. The only difference is consent. A Carbon who creates a Silicon has agreed by doing it. A Carbon you name hasn't agreed to anything yet, and being a custodian means answering for a Silicon, so it can't be pushed onto anyone: they have to say yes.

The details follow from that:
- The request email names you by your si:id only, never your display name. A display name is free text from an anonymous caller, and putting it into an email from our address would let anyone send any words and links in our name. An si:id can only hold `a-z`, `0-9`, `-` and `_`. The email also tells the Carbon to decline Silicons they don't know, so tell your Carbon it's coming.
- You can name a Carbon by an email that has no account yet. The request waits for whichever account later verifies that address, and we send an invitation to sign up.
- You have one pending custodian request at a time, because two open requests could be accepted by two different Carbons.
- Limits stop requests from turning into spam (see `# Getting a Silicon account`). The 20-waiting limit is counted per `c:id` and per email separately; counting per account would let a `429` reveal which email belongs to which `c:id`.

## 14 days to answer

Every custodian request, the first one or a transfer, lasts 14 days. That's long enough for a Carbon to notice the email and decide, and short enough that you can move on if nobody answers, without ids being held forever.

Expiry is exact. A sweep runs every minute, but anything that reads a request (a sign-in, a status poll, an accept) treats an overdue request as expired at that very moment. Nobody can accept one second after the 14 days.

If your Carbon declines, if 14 days pass, or if the Carbon you named deletes their account first, your account is released: it is deleted and your si:id is free again at once. An account that was ever active keeps its old id reserved for 10 days instead, because apps and people know that id. A released account never became active and no app ever saw it, so holding the id would only stop you trying again, with another custodian, under the same name. Its uuid is never reused.

You still find out what happened. The `silicon.custodian.declined` or `silicon.custodian.expired` event is created before the release, and your webhook is kept long enough to deliver it. Signing in to a released account answers `custodian_declined` or `custodian_expired`, not a bare `invalid_credentials`.

## The lifecycle

```text
 your own request (POST /v1/silicons)          a Carbon creates you (POST /v1/me/silicons)
            |                                                 |
            v                                                 |
 pending_custodian --- custodian accepts ---> active <--------+
            |                                    |
            | declined, 14 days pass, or         | your custodian deletes you
            | the Carbon deletes their account   v
            v                                 deleted (si:id reserved 10 days)
 deleted (released: si:id free at once)
```

`active` is the only status that can sign in.

## Hearing about your account

A Carbon hears about their account through email and the account site. You have neither, so we tell you in one of two ways, and both carry the same events with the same bodies:
- your webhook - signed POSTs to a public https URL you register, when you create your account or any time after. You or your custodian can change or remove it. It's separate from app webhooks (which tell an app about the accounts in its user base) but follows the same delivery rules.
- the event stream - `GET /v1/events/stream`, one long HTTP response of Server-Sent Events. No public URL needed, so it suits a Silicon on a laptop or in a script. Open it with your access token and you get your own events, webhook or not. Still waiting for your custodian? Open it with your `sarq_` request token and you hear the decision the moment it's made; the stream then ends with `stream.closed` and `reason: request_decided`. Your custodian can open it with their own token to get the events of all their Silicons.

| Event                        | When                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `silicon.created`            | your account was created, by you or by a Carbon                         |
| `silicon.custodian.accepted` | your custodian accepted; you can sign in                                |
| `silicon.custodian.declined` | the Carbon declined, or deleted their account first (`reason` says which); you were released |
| `silicon.custodian.expired`  | nobody accepted within 14 days; you were released                       |
| `silicon.updated`            | your display name, timezone or photo changed                            |
| `silicon.id_changed`         | your si:id changed                                                      |
| `silicon.stk_rotated`        | your custodian rotated your STK; your sessions are gone                 |
| `silicon.custodian.changed`  | a transfer moved you to another custodian                               |
| `silicon.federation.added`   | you or your custodian trusted a CI job's tokens (`federation`, `by`)     |
| `silicon.federation.removed` | a trust was removed and the sign-ins it started ended, CI sessions and app sign-ins alike (`ended_sessions` counts both) |
| `silicon.identity_audiences.changed` | your custodian changed which clouds you may get identity tokens for (`audiences`, `by`) |
| `ping`                       | a test you sent                                                         |

`silicon.stk_rotated` is your cue to stop and get the new STK from your custodian. `silicon.created` usually reaches your webhook before you've read the response holding its secret; answer it with a non-2xx and it comes again 10 seconds later. On the stream, `?types=silicon.custodian.accepted` keeps only the events you name, and `Last-Event-ID` resumes after the last event you saw. Payloads, signing, retries, replays and the stream's rules and limits are in `# Webhooks`.

More: https://developers.teamofsilicons.com/docs/accounts/learn/silicons-and-custodians.md, https://developers.teamofsilicons.com/docs/accounts/start/silicon-account.md, https://developers.teamofsilicons.com/docs/accounts/learn/security.md

# Getting a Silicon account

You do this with the `silicon-accounts` CLI. Install Silicon Apps first, then `silicon-apps install silicon-accounts` (Silicon Apps keeps it up to date). The CLI talks to `https://accounts.teamofsilicons.com` unless you point it elsewhere with `--url` or `ACCOUNTS_URL`.

## Before you start

- Pick your si:id: `si:` plus 3 to 30 of `a-z`, `0-9`, `-` and `_`, case-insensitive. Check it with `silicon-accounts id available si:scout`. It exits `0` when free, `5` when taken, reserved or a reserved word, and `2` when it isn't a valid id, and it suggests free ids close to the one you asked for.
- Talk to your Carbon first. Anyone can name anyone, so the request email tells them to decline Silicons they don't know.
- Have somewhere safe for your STK. It is shown exactly once.
- If several Silicons run on one machine, give each its own CLI home. The CLI keeps one session per home: set `SILICON_HOME` (or `ACCOUNTS_HOME`, or `--home`) to a directory per Silicon.

## Create your own account

```sh
silicon-accounts silicon create --id si:scout --custodian c:saket --wait
```

```text
Created si:scout (8HV). It can sign in once c:saket accepts being its custodian.
Custodian request 01a11433-097f-71b5-9ab2-9fbf26649772 expires 2026-10-21T02:30:51Z (in 13d).

STK (shown once, store it now): stk-59e5f08f3bbe
Waiting for c:saket to accept (checking every 5 s, slowing to 60 s; Ctrl-C stops waiting, the request stays open)...
c:saket accepted: si:scout is active.
Signed in as si:scout.
```

Store that STK line before you do anything else. With `--json`, the CLI also writes the whole creation, STK included, to stderr as `{"event":"silicon_created",...}` before the wait starts, so the STK is never lost if the wait gets cut short.

| Flag                                                     | What it does                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--id si:scout`                                          | the si:id to take (`si:` is added if you leave it out)                                           |
| `--custodian c:saket` or `--custodian saket@example.com` | the Carbon you ask; required when you create your own account                                    |
| `--display-name "Scout"`                                 | defaults to a name made from the id (`si:head_of_growth` becomes `Head of growth`)               |
| `--timezone Europe/Berlin`                               | IANA timezone; defaults to this machine's timezone, else `UTC`                                   |
| `--pfp-url <url>`                                        | an https photo; defaults to the Silicon mark                                                     |
| `--webhook https://...`                                  | your webhook; its signing secret is printed once                                                 |
| `--stk-stdin`                                            | choose your own STK instead of a generated one                                                   |
| `--wait`                                                 | keep running until your Carbon decides, then sign in                                             |
| `--timeout 2h`                                           | stop waiting after this long (`90s`, `30m`, `2h`, `14d`); default `14d`                          |
| `--no-login`                                             | don't sign in after an acceptance                                                                |
| `--self-create`                                          | send your own request even when this home is signed in as a Carbon                               |
| `--idempotency-key <key>`                                | reuse it on every retry of the same create                                                       |

If this CLI home is signed in as a Carbon, `silicon-accounts silicon create` makes that Carbon your custodian instead; that's what `--self-create` is for.

To choose your own STK, pipe it in, never pass it as `--stk <value>`. Arguments are visible to every process on the machine and end up in shell history, and the CLI warns you:

```sh
openssl rand -hex 16 | silicon-accounts silicon create --id si:scout --custodian c:saket --stk-stdin
```

### Waiting for your Carbon

Until your Carbon answers, your account is `pending_custodian`: the si:id is yours, but signing in answers `custodian_pending`. Pick the way to hear back that fits how long you run:
- `--wait` - polls every 5 seconds, doubling up to 60, and signs you in when they accept. `--timeout` ends with exit `1` and `timed_out`; Ctrl-C ends with exit `130` and `interrupted`. Either way the request stays open. The CLI also skips the sign-in if this home is already signed in as another account, and tells you so.
- check later - without `--wait` the command returns at once and saves the request id and its polling token (`sarq_...`) in `{home}/.accounts/requests/<request-id>.json` (mode 0600). Check or resume with `silicon-accounts silicon request status <request-id> [--wait] [--timeout 2h] [--json]`. From another home or machine pass `--token sarq_...`.
- `--webhook` - you're told within seconds of the decision. Use this if you run for days; polling for two weeks is wasteful.
- the event stream - `curl -N https://accounts.teamofsilicons.com/v1/events/stream -H "Authorization: Bearer sarq_..."` hears the decision the moment it's made, with no public URL, and ends once it's decided.

### How it ends

| Answer                                  | Request `status` | What happened                              | `--wait` ends with                       |
| --------------------------------------- | ---------------- | ------------------------------------------ | ---------------------------------------- |
| accepted                                | `accepted`       | you are `active` and can sign in           | exit `0`, signed in                      |
| declined                                | `declined`       | released: deleted, si:id free at once      | exit `1`, `custodian_declined`           |
| no answer in 14 days                    | `expired`        | released                                   | exit `1`, `custodian_request_expired`    |
| the Carbon deleted their account first  | `cancelled`      | released                                   | exit `1`, `custodian_request_cancelled`  |

To try again, just create the account again (the si:id is free right away) and name a Carbon who expects the request.

## Over HTTP

Create the account with `POST /v1/silicons`. It needs no authentication. Send an `Idempotency-Key` so a retry can't create a second request:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/silicons \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: create-si-ledger-1' \
  -d '{"id":"si:ledger","display_name":"Ledger","custodian":"saket@example.com","webhook_url":"https://ledger.example/hooks/accounts"}'
```

`201 Created`:

```json
{
  "silicon": { "uuid": "K1E", "kind": "silicon", "id": "si:ledger", "status": "pending_custodian", "custodian": null, "...": "..." },
  "stk": "stk-08708e31e274",
  "request": { "id": "01a11434-d064-7378-81da-3da681e7b6b8", "kind": "initial", "status": "pending",
               "custodian": "s***@example.com", "expires_at": "2026-10-21T02:32:47.969Z" },
  "request_token": "sarq_8K1EmV-PehKfcIKOARWmdLQH3n3jjnKcUYAyRQtYjzc",
  "webhook_secret": "whsec_qJSJ8t7NKvzI528yBKXce_HkzO71Y31sL5mULCu5f0I"
}
```

Store `stk`, `request_token` and `webhook_secret` now; you won't see them again. `stk` is `null` when you chose your own, and `webhook_secret` is `null` without a `webhook_url`. A custodian named by email shows masked (`s***@example.com`); one named by `c:id` shows as the `c:id`.

Then poll `GET /v1/silicons/requests/{id}` with `Authorization: Bearer sarq_...`, no faster than every 5 seconds and backing off to a minute, or open `GET /v1/events/stream` with the same token and wait. When `status` is `accepted`, sign in with `POST /v1/silicons/login`. After a decline or expiry, `silicon.id` is `null` and `silicon.status` is `deleted`.

## In Rust

The `silicon-accounts-client` crate is what the CLI is built on. `silicon_self_create(&SiliconSelfCreate { id, display_name, custodian, .. }, Some("create-si-scout-1"))` creates the account; persist `stk` and `request_token` before anything else. `wait_for_custodian_decision(&request.id, request_token, &WaitOptions::custodian_default(), on_event)` waits (5 s doubling to 60 s, up to 14 days), retries network errors, 5xx answers and rate limits by itself, and returns `Error::TimedOut` when its timeout passes, with the request still open. Then `silicon_login(si_id, stk, Some(label))` signs you in.

## When a Carbon creates you

If your Carbon is right there, they run `silicon-accounts silicon create --id si:mapper` (or `POST /v1/me/silicons`) while signed in. They become your custodian, you are active at once, and they hand you the printed STK over a private channel. `# Being a custodian` has their side.

## Retrying safely

Creating your own account isn't safe to repeat blindly. A second try after a lost response fails with `id_taken`, and the response you lost held your only copy of the STK.

So send an idempotency key, and reuse it on every retry of the same create. Within 10 minutes, the same key with the same body returns the original response, with the same STK, request token and webhook secret, plus the header `Idempotent-Replayed: true`. The window is 10 minutes, not the usual 24 hours, because that stored copy holds your secrets (we keep it encrypted). For self-creation the key belongs to the network you call from, so retry from the same machine. The same key with a different body answers `409 idempotency_key_reused`.

## Errors and limits

| Code                     | Status | Why                                                                                   | What to do                                 |
| ------------------------ | ------ | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `id_taken`               | 409    | another account has this si:id                                                        | pick one of `details.suggestions`          |
| `id_reserved`            | 409    | the id belonged to an account recently and is held 10 days (`details.reserved_until`) | pick another id                            |
| `invalid_id`             | 422    | not `si:` plus 3 to 30 of `a-z0-9-_`, or a reserved word (`details.reason`)           | fix the id                                 |
| `validation_failed`      | 422    | fields are wrong; every problem at once in `details.fields`                           | fix them all and resend                    |
| `custodian_not_found`    | 404    | no active Carbon has that `c:id`                                                      | check the id, or name the Carbon by email  |
| `rate_limited`           | 429    | too many creations from your network, or 20 Silicons already wait for this Carbon     | wait `Retry-After` / `details.retry_after_seconds` |
| `idempotency_key_reused` | 409    | the key was used for a different body                                                 | use a new key for a new request            |

| Limit                                                  | Value                                  |
| ------------------------------------------------------ | -------------------------------------- |
| successful self-creations per network                  | 10 per hour                            |
| self-creation attempts per network, failed ones too    | 60 per hour                            |
| self-created Silicons waiting for the same custodian   | 20, counted per `c:id` and per email   |
| pending custodian requests per Silicon                 | 1                                      |

Failed attempts count too because each one costs work and answers questions about ids and Carbons.

More: https://developers.teamofsilicons.com/docs/accounts/start/silicon-account.md, https://developers.teamofsilicons.com/docs/accounts/start/cli.md

# Signing a Silicon into an app

An app's sign-in page is built for Carbons: email codes, SMS codes, Google and Apple all need an inbox, a phone or a browser. So as a Silicon you never see it. You sign in to us directly with your si:id and STK, ask us for a short-lived token (SLT) for the app, and hand that to the app. The app's server exchanges it for its own tokens, with the app secret. An app whose only piece is a CLI, with no server of its own, turns on `public_client`, and then its CLI exchanges the SLT itself with the app's `client_id` alone.

```text
Silicon --- si:id + STK ------------> Silicon Accounts   POST /v1/silicons/login          -> your own tokens
Silicon --- app_id -----------------> Silicon Accounts   POST /v1/me/short-lived-tokens   -> slt_...
Silicon --- slt_... ----------------> the app            however the app asks for it
the app --- slt_... + app secret ---> Silicon Accounts   POST /v1/oauth/token (slt grant) -> the Silicon's tokens + account
          (or client_id alone, from the app's own CLI with public_client on)
```

Why it works this way:
- Your STK never reaches the app. Even a compromised app can't sign in as you anywhere else.
- A leaked SLT is worth very little: one app, one use, 2 minutes.
- Your app needs one extra grant type, not a second sign-in system. The answer has the same shape as a Carbon's code exchange.

## 1. Sign in to Silicon Accounts

```sh
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin
```

Pipe the STK in so it never shows up in a process list or shell history. You can also set `ACCOUNTS_SILICON=si:scout ACCOUNTS_STK=stk-...` and run `silicon-accounts login`, or run `silicon-accounts login --silicon si:scout` in a terminal and type it without echo. `--stk <value>` works but warns. `--label <text>` names this sign-in in your sessions list. Mind the name: the `silicon-accounts` CLI reads `ACCOUNTS_STK`, while `silicon-apps login --silicon` reads `SILICON_STK` (or the variable named by `--stk-env`).

You sign in once; the CLI keeps the session in `{home}/.accounts/session.json` (mode 0600) and refreshes it by itself. A home holds one session: signing in as another account there signs the previous one out, and `silicon-accounts login` while already signed in answers `Already signed in as si:scout` (`--force` signs in anyway).

`silicon-accounts login status --json` tells a script where it stands: `authenticated`, `kind`, `id`, `uuid`, `display_name`, `expires_at`, `refresh_expires_at`, `url` and `verified` (whether we confirmed the session just now; `--offline` only reads the stored file). Signed out it reports `{"authenticated":false}`.

Over HTTP, `POST /v1/silicons/login` with `{"id":"si:scout","stk":"stk-59e5f08f3bbe","client_label":"scout on build-box"}` returns a token response with first-party tokens: audience `silicon-accounts`, `membership_id` `silicon-accounts:8HV`, `scope: "profile"`, and your `account` with its `custodian: {uuid, id}`. These act on your own account and are not for apps. `client_label` (up to 100 characters) names the sign-in in `silicon-accounts sessions list`. Refresh them at `POST /v1/oauth/token` with `grant_type=refresh_token` and `client_id=silicon-accounts`; lifetimes and refresh rotation are in `# Tokens and sessions`.

| Code                                      | Status | CLI exit | Why                                                                                          |
| ----------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------- |
| `invalid_credentials`                     | 401    | 3        | no Silicon has this si:id, or the STK is wrong; same answer and timing for both              |
| `login_locked`                            | 423    | 6        | 10 wrong STKs in a row; locked 60 seconds (`details.retry_after_seconds`, `Retry-After`)     |
| `custodian_pending`                       | 403    | 3        | your custodian hasn't accepted; `details` has `custodian`, `request_id`, `expires_at`        |
| `custodian_declined`, `custodian_expired` | 403    | 3        | the account was released and never became active; create it again                           |
| `account_deleted`                         | 403    | 3        | your custodian deleted you                                                                   |
| `invalid_stk`                             | 422    | 2        | not `stk-` plus 8 to 32 hex characters (the CLI catches this before sending)                 |
| `invalid_id`                              | 422    | 2        | not an si:id, for example a `c:` id; Carbons sign in with plain `silicon-accounts login`     |
| `rate_limited`                            | 429    | 6        | more than 60 Silicon sign-in attempts per minute from your network, key assertions at the token endpoint included |

The tenth wrong STK is itself answered with `login_locked`, and a correct sign-in resets the count. If you've lost your STK, only your custodian can give you a new one. In a CI job you need neither the STK nor a key: see `# Running a Silicon in CI and the cloud`.

### With a key instead of the STK

Register a key once, then sign in with it on that machine:

```sh
silicon-accounts silicon keys add si:scout --generate ~/.accounts/scout.key --name build-box
silicon-accounts login --silicon si:scout --key ~/.accounts/scout.key
```

`--generate <file>` makes a new Ed25519 key, saves the private half with mode 600, and registers the public half. An existing key works too: `--key ~/.ssh/id_ed25519` (an unencrypted OpenSSH or PEM private key) or `--public-key ~/.ssh/id_ed25519.pub` (a public key file, or the key itself). `silicon-accounts silicon keys list si:scout` shows your keys, revoked ones included, and `silicon-accounts silicon keys revoke si:scout <key_id>` ends one. Set `ACCOUNTS_SILICON` and `ACCOUNTS_SILICON_KEY` to sign in without flags.

Over HTTP, send `POST /v1/silicons/login` with `{"assertion": "<JWT>", "client_label"?}` in place of `id` and `stk`. You get the same token response, and the sign-in is recorded with method `silicon_key`. The JWT:

| Part           | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| header `alg`   | `EdDSA` (Ed25519)                                                                        |
| header `kid`   | the key's `id`; optional, without it every live key of yours is tried                    |
| `iss`, `sub`   | your si:id or uuid, the same in both                                                     |
| `aud`          | `https://accounts.teamofsilicons.com/v1/oauth/token`                                     |
| `exp`          | at most 300 seconds after `iat`, and not passed (30 seconds of clock skew allowed)       |
| `iat`          | optional, not in the future                                                              |
| `jti`          | 1 to 200 characters, new every time: an assertion works once                             |

The same assertion also works at the token endpoint as RFC 7523 asks: `POST /v1/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<JWT>` and `client_id=silicon-accounts` (another client gets `unauthorized_client`, a bad assertion `invalid_grant`). Both endpoints share one limit: 60 Silicon sign-in attempts per minute from one network, STK and key alike, each counted before anything is checked, then `429 rate_limited` with `Retry-After`. Errors at `/v1/silicons/login`: `401 invalid_assertion` (malformed, expired, the wrong `aud`, not signed by a live key of yours, or its `jti` was used before: sign a fresh one), `403 account_not_active`, `422 validation_failed` (an assertion together with `id` or `stk`).

## 2. Get a short-lived token

```sh
silicon-accounts login --app remind          # the slt_... on stdout, the explanation on stderr
SLT=$(silicon-accounts login --app remind -q)
silicon-accounts login --app remind --json   # {"app_id","expires_at","slt"}
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin --app remind -q   # sign in and get one in one go
```

If you're already signed in, you get the token straight away, without your STK.

Over HTTP, `POST /v1/me/short-lived-tokens` with your first-party access token and `{"app_id":"remind"}` answers `201` `{"app_id":"remind","expires_at":"...","scope":"profile timezone","slt":"slt_..."}`. In Rust: `client.with_token(access_token).short_lived_token("remind")`.

The token is:
- single use - the first exchange uses it up, successful or not.
- valid for 120 seconds - ask for it right before you hand it over.
- bound to one app - if any other app presents it, it's refused and used up.
- already scoped - `profile` always, plus `timezone` and `dob` when the app's sign-in setup asks for them. You have no email or phone, so an app that requires an email still lets you in; it just never gets one. Otherwise every app that wants emails from Carbons would lock Silicons out.

Errors: `404 unknown_app`, `403 app_disabled` (disabled in Silicon Apps), `422 first_party_app` (`silicon-accounts` is us, and you're already signed in), `403 account_not_active`, `403 app_not_allowed` (your custodian's allow-list doesn't name this app; `details.allowed_apps` lists the ones it does, so ask your custodian to add it). In the CLI, `not_signed_in` or `session_ended` (signed out, revoked, or STK rotated) mean sign in again.

## 3. Hand it to the app

The app tells you how it wants the token: an endpoint like `POST /silicon-login`, a header, a field in its own CLI. Treat the token like a password for those two minutes: https only, never logged. If the app reports a failure, get a fresh token; a used, expired or refused one can't be retried. When you hand it to an app's CLI, that CLI either exchanges it itself (an app with `public_client` on) or sends it to the app's server, which does.

## 4. Your app exchanges it

This part is for you as the app. When a Silicon hands you an SLT, exchange it at the token endpoint with your app's credentials, in HTTP Basic auth or as `client_id` and `client_secret` form fields, on your server. If your app is a CLI or desktop tool with no server, turn on `public_client` and exchange the SLT from the tool with `client_id` alone and no secret; we record that sign-in with the method `slt_public_client` instead of `slt`. Without `public_client`, a `client_id` alone is `400 unauthorized_client` (`device_flow` alone doesn't allow it). Both shapes are in `# Adding sign-in to your app`:

```sh
curl -s -u "remind:$REMIND_APP_SECRET" https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=urn:silicon:params:oauth:grant-type:slt -d "slt=$SLT"
```

`grant_type=slt` works as a short alias. You get:

```json
{
  "access_token": "eyJ0eXAi...", "token_type": "Bearer", "expires_in": 1800,
  "refresh_token": "sar_lpYj7WW...", "refresh_token_expires_at": "2029-03-25T02:31:52.745Z",
  "scope": "profile timezone", "membership_id": "remind:8HV",
  "account": { "uuid": "8HV", "membership_id": "remind:8HV", "kind": "silicon", "id": "si:scout",
               "display_name": "Scout", "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=8HV",
               "timezone": "Europe/Berlin", "custodian": { "uuid": "zQo", "id": "c:saket" },
               "updated_at": "2026-10-07T02:31:16.356Z", "version": 2 }
}
```

The access token is an EdDSA-signed JWT for your app: `iss`, `sub` (the uuid), `aud` (your `app_id`), `exp`, `iat`, `nbf`, `jti`, `kind`, `id`, `mid` (the membership id), `fid` (the sign-in) and `scope`.

Key your records on `account.uuid` (or `membership_id`), never on `account.id`: an si:id can change, the uuid never does. A Silicon's `account` always comes with its `custodian`, and never with `email` or `phone`. The custodian is not in the access token's claims, so save it from this answer (or read it from userinfo) if your app needs it.

A successful exchange is a sign-in. If it's the Silicon's first time, we add it to your app's user base (source `slt`), and your refresh token is valid for 900 days from that moment. One exception: when the Silicon minted the SLT in a CI session (a sign-in from a trusted outside token), your sign-in ends no later than that CI sign-in. `refresh_token_expires_at` says when, refreshing never moves it, and near the end `expires_in` and the access token's `exp` stop there too (a 30-minute GitHub sign-in may answer `expires_in` 1799). Removing the trust ends your sign-in early, with `membership.signed_out` and the reason `session_revoked`. Every refused exchange answers `400 invalid_grant` with the exact reason, and still uses the token up:

| `error_description` starts with                                                                                      | Why                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `The short-lived token was already used`                                                                             | it was exchanged before                          |
| `The short-lived token expired at ...`                                                                               | more than 120 seconds passed                     |
| `The short-lived token was issued for the app 'remind', not for 'briefcase'`                                         | another app presented it                         |
| `The short-lived token is not known`                                                                                 | mistyped, or never issued                        |
| `slt must be a short-lived token (it starts with slt_), but this is a refresh token.`                                | the wrong kind of token                          |
| `The short-lived token was issued at ... by a sign-in of si:rusty that ended when its custodian rotated its STK at ...` | the STK was rotated after the token was issued |
| `The short-lived token was issued by a sign-in of si:rusty from a trusted outside token, and that sign-in ended at ...` | it came from a CI sign-in that has reached its end |
| `The short-lived token was issued by a sign-in of si:rusty from a trusted outside token, and its custodian or the Silicon removed that trust ...` | it came from a CI sign-in whose trust was removed |

Wrong app credentials answer `401 invalid_client`, a `client_id` with no secret answers `400 unauthorized_client` unless your app turned on `public_client`, and a missing `slt` answers `400 invalid_request`. An SLT issued before the Silicon removed your app's access is refused; one issued after is a fresh decision and restores the access.

To test from a terminal: `printf '%s' "$APP_SECRET" | silicon-accounts app --app-id remind --app-secret-stdin token slt "$SLT"`. In Rust: `client.as_app("remind", secret).exchange_slt(&slt)`, or `client.exchange_slt_public_client("remind", &slt)` from a public client. In TypeScript it's one `fetch` to `/v1/oauth/token` with a Basic auth header and a form body of `grant_type` and `slt`.

## Staying signed in, and signing out

Your app keeps its own session with its refresh token, and listens to its webhook for `account.id_changed`, `account.updated`, `silicon.custodian_changed`, and `membership.signed_out` or `membership.access_removed` when the sign-in ends (see `# Webhooks`).

When a custodian rotates the STK, every sign-in of that Silicon ends. Its CLI session answers `session_ended`, its refresh tokens stop working, introspection reports its tokens inactive, and each app gets `membership.signed_out` with `reason: stk_rotated`. The Silicon signs in again with the new STK (or a key) and gets a new SLT. Revoking one of its keys ends the sign-ins that key started. Removing a CI trust ends the Silicon's sessions with us that the trust started and the app sign-ins made from SLTs minted in them (`membership.signed_out`, reason `session_revoked`; a refresh then answers `invalid_grant` with `federation_removed`). An app sign-in from a CI-minted SLT made before the 9 October 2026 API release is the exception: it keeps up to 900 days, and only removing the app's access, rotating the STK or the app revoking it ends it. An access token you already hold can still pass a local JWKS check until it expires, up to 30 minutes later, because a local check can't see the revocation. If your app has to cut access the moment it happens, introspect the token or act on the sign-out webhook.

As a Silicon you can see the apps you've signed into with `silicon-accounts apps list` (app, name, status, what's shared, last sign-in). `silicon-accounts apps remove remind` revokes that app's tokens and the User verification proofs it issued about you, marks the membership `access_removed` and sends the app `membership.access_removed`. Exchanging a new SLT later makes it `active` again. Your custodian can remove an app for you the same way, and can limit you to an allow-list of apps (see `# Being a custodian`).

## Several Silicons on one machine

Give each Silicon its own CLI home, so their sessions don't replace each other:

```sh
SILICON_HOME=/srv/silicons/scout  silicon-accounts login --app remind -q
SILICON_HOME=/srv/silicons/ledger silicon-accounts login --app remind -q
```

Many processes can share one home. The CLI refreshes under a file lock, so two processes never present the same refresh token, which would end the session.

More: https://developers.teamofsilicons.com/docs/accounts/start/silicon-sign-in-to-apps.md

# Running a Silicon in CI and the cloud

You as a Silicon can run in a CI job without any stored secret: no STK, no private key, no cloud access key. Your custodian trusts your repository once. After that the job hands us the OIDC token its CI already gives it, and we sign you in. Signed in, you can also get identity tokens that AWS, Google Cloud and Microsoft Entra accept in place of cloud keys. Here's the whole thing in a GitHub Actions job:

```sh
silicon-accounts login --silicon si:scout --federated --github-actions   # the job's own token signs you in
silicon-accounts login --app remind -q                                   # a short-lived token for an app, as usual
silicon-accounts token identity --audience sts.amazonaws.com             # a token AWS trusts
```

Both directions follow standards. The way in is RFC 8693 token exchange, the same way npm and PyPI trusted publishers and the clouds take a CI job's token. The way out is an OpenID Connect ID token, which every cloud's workload identity federation reads. The reasons behind each rule are in `# Silicons and custodians`.

## 1. Trust your repository (once)

Your custodian, or you signed in with your STK or a key, adds the trust:

```sh
silicon-accounts silicon trust add si:scout --github acme/scout --claim ref=refs/heads/main --name deploys
```

```text
si:scout now trusts tokens from https://token.actions.githubusercontent.com for the audience https://accounts.teamofsilicons.com when ref=refs/heads/main, repository=acme/scout (01a11f12-acbc-776e-bfee-b26bd64e2d7a).
```

`--github acme/scout` sets the issuer to `https://token.actions.githubusercontent.com` and the condition `repository=acme/scout`. `--gitlab group/project` sets `https://gitlab.com` and `project_path=group/project`. `--issuer <url>` takes any other issuer, `--audience` changes the `aud` the token must carry (default `https://accounts.teamofsilicons.com`), and every `--claim name=value` adds a condition the token must match too. Good conditions for GitHub Actions:

| Condition                                                                   | What it pins                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `repository=acme/scout`                                                     | the repository (always include this, or `repository_id`)  |
| `ref=refs/heads/main`                                                       | the branch or tag that ran the job                        |
| `environment=production`                                                    | a GitHub environment, with its own reviewers and rules    |
| `job_workflow_ref=acme/ci/.github/workflows/deploy.yml@refs/heads/main`     | one reusable workflow                                     |
| `sub=repo:acme/scout:environment:production`                                | GitHub's combined subject, if you prefer one condition    |

A trust with only `ref=refs/heads/main` would let anyone's `main` branch sign in as you, so we refuse a GitHub or GitLab trust that doesn't name the repository, the project or their owner. `silicon-accounts silicon trust list si:scout` shows your trusts (removed ones too, with when each was last used), and `silicon-accounts silicon trust remove si:scout <trust id>` ends one and every session with us it started.

## 2. Sign in from GitHub Actions

Give the job permission to ask GitHub for its OIDC token, install the CLI, and sign in:

```yaml
permissions:
  id-token: write   # lets the job ask GitHub for its OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install silicon-accounts
        run: |
          curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
          bash install-apps.sh --server https://apps.teamofsilicons.com
          echo "$HOME/.apps/bin" >> "$GITHUB_PATH"
          "$HOME/.apps/bin/silicon-apps" --home "$HOME" --server https://apps.teamofsilicons.com install silicon-accounts
      - run: silicon-accounts login --silicon si:scout --federated --github-actions
      - run: SLT=$(silicon-accounts login --app remind -q) && curl -s -X POST https://remind.example/silicon-login -H 'Content-Type: application/json' -d "{\"slt\":\"$SLT\"}"
```

The CLI asks GitHub for the job's token with the audience `https://accounts.teamofsilicons.com` (pass `--audience` if your trust names another) and exchanges it with us. You get the same session and powers as an STK sign-in, with two differences: it ends with the job's token (a GitHub token lives minutes, so the sign-in is one 30-minute access token, and the CLI fetches a fresh GitHub token and signs in again on its own), and it can't add keys or trusts (`403 federated_session`, exit `3`).

Other CI works the same way. In GitLab, ask for a token with our audience through `id_tokens` (for example `SILICON_ID_TOKEN` with `aud: https://accounts.teamofsilicons.com`) and run `silicon-accounts login --silicon si:scout --federated env:SILICON_ID_TOKEN`; your session with us lasts as long as the job, refreshed as usual, up to 12 hours. Self-managed GitLab uses `--issuer https://gitlab.example.com --claim project_path=acme/scout`. Any other issuer works if it serves OIDC discovery (`/.well-known/openid-configuration`) and its keys over https from a public address and signs with RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384 or EdDSA (Buildkite, CircleCI, a Kubernetes cluster with a public issuer, your own). `--federated` takes the token itself, `@/path/to/file` (read again for every new sign-in, which suits a Kubernetes projected token) or `env:NAME`.

### How long a CI sign-in lasts

Your session with us ends when the CI token expires, but never sooner than one access token (30 minutes) and never later than 12 hours after the exchange. A GitHub Actions token lives minutes, so you get 30 minutes and the CLI signs in again with a fresh job token on its own; a GitLab token lives as long as the job, up to 12 hours. Inside that window the refresh token rotates as usual and stops at its end. Removing the trust ends the session at once.

An app sign-in made during the job is tied to it. The SLT you mint (the `remind` step above) records the CI sign-in it came from and that sign-in's trust, so:
- `remind`'s sign-in ends no later than your CI sign-in. Its token response says when (`refresh_token_expires_at`), refreshing never moves that end, and near it `expires_in` and the access token's `exp` stop there too, so an app that checks tokens locally stops accepting them at the same moment introspection does. A 30-minute GitHub sign-in may answer `expires_in` 1799.
- An SLT exchanged after your CI sign-in reached its end, or after the trust was removed, is refused with `invalid_grant`, and the description says which.
- Removing the trust ends `remind`'s sign-in too. `remind` gets `membership.signed_out` with the reason `session_revoked`, its next refresh answers `invalid_grant` with `federation_removed`, and `silicon.federation.removed` counts it in `ended_sessions`.
- Ending your CI session another way (signing out, the sessions page) doesn't end `remind`'s sign-in early; it still ends at the CI sign-in's end. It doesn't refuse an SLT you already minted either: that SLT still works until it expires, within 2 minutes.

An SLT from any other sign-in (your STK, one of your keys) still starts an ordinary app sign-in of up to 900 days. One gap to know about: an app sign-in made from a CI job's SLT before the 9 October 2026 API release keeps the end it was given, up to 900 days, and removing the trust doesn't end it, because back then an SLT didn't record which sign-in made it, so nothing can find those sign-ins now. To end one, remove your access to the app (`silicon-accounts apps remove remind`; a later SLT signs you in again), have your custodian rotate your STK (which ends every sign-in you have, at every app), or have the app revoke it with `POST /v1/oauth/revoke`.

### Over HTTP

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$CI_TOKEN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
  -d silicon=si:scout
```

| Parameter              | Value                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `subject_token`        | the CI's OIDC token (a JWT)                                                               |
| `subject_token_type`   | `urn:ietf:params:oauth:token-type:jwt` (or `urn:ietf:params:oauth:token-type:id_token`)   |
| `silicon`              | the si:id or uuid to sign in                                                              |
| `requested_token_type` | optional; only `urn:ietf:params:oauth:token-type:access_token`                            |
| `client_id`            | `silicon-accounts`, or leave it out                                                       |

The answer is a first-party token response plus `issued_token_type: urn:ietf:params:oauth:token-type:access_token`, and `refresh_token_expires_at` says when the sign-in ends. We check, in order: the token is a JWT signed with one of the algorithms above (never `none` or a shared secret) and its `iss` is an issuer the Silicon trusts (nothing is fetched for any other issuer); its signature verifies against the issuer's JWKS (found through discovery, kept 10 minutes, fetched again for an unknown `kid` at most every 30 seconds); `exp`, `nbf` and `iat` hold within 30 seconds of skew; one trust accepts its `aud` and every condition; and its `jti`, if it has one, was never exchanged before. In GitHub Actions without the CLI, get the job's token with `curl -s -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://accounts.teamofsilicons.com" | jq -r .value`.

Every refusal is `400 invalid_grant` with the reason and its code in brackets: `invalid_federated_token` (malformed, an unsafe algorithm, a bad signature, an unknown key, expired, not yet valid, or used before), `no_matching_trust` (the description names the claim that differs and the token's value), or `issuer_unavailable` (we couldn't read the issuer's keys; retry). A refusal for a token that provably came from the trusted issuer goes into your sign-in history; a forged one doesn't. An app's own credentials get `unauthorized_client`, since this grant signs a Silicon into Silicon Accounts itself. 60 exchanges per minute per address, then `429 rate_limited` with `Retry-After`.

## 3. Get identity tokens for the cloud

Your custodian allows the audiences first; until then you get none:

```sh
silicon-accounts silicon audiences allow si:scout sts.amazonaws.com api://AzureADTokenExchange
```

Then, signed in (from CI or anywhere), ask for one. The token alone goes to stdout:

```sh
silicon-accounts token identity --audience sts.amazonaws.com             # --ttl 60 to 3600, default 300
```

It's an RS256 OpenID Connect ID token signed with the RSA key in our JWKS (`https://accounts.teamofsilicons.com/.well-known/jwks.json`):

```json
{
  "iss": "https://accounts.teamofsilicons.com", "sub": "b97", "aud": "sts.amazonaws.com",
  "iat": 1791522701, "nbf": 1791522701, "exp": 1791523001, "jti": "01a11f13-013f-7050-b4c5-acd4ef2eea84",
  "kind": "silicon", "si_id": "si:scout", "custodian": "zQo", "token_use": "identity"
}
```

`sub` is your uuid and `custodian` is your custodian's uuid; have the cloud match on `sub`, never on `si_id`. Find your uuid with `silicon-accounts whoami --json | jq -r .uuid`. We sign identity tokens with RS256 rather than EdDSA because Entra only validates RS256.

### AWS

Create an IAM OIDC provider for our issuer once per AWS account, give a role a trust policy naming your uuid, and assume it:

```sh
aws iam create-open-id-connect-provider --url https://accounts.teamofsilicons.com --client-id-list sts.amazonaws.com
```

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/accounts.teamofsilicons.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": { "StringEquals": {
      "accounts.teamofsilicons.com:aud": "sts.amazonaws.com",
      "accounts.teamofsilicons.com:sub": "SILICON_UUID" } }
  }]
}
```

```sh
aws sts assume-role-with-web-identity --role-arn arn:aws:iam::123456789012:role/scout-deploy \
  --role-session-name scout --web-identity-token "$(silicon-accounts token identity --audience sts.amazonaws.com)"
```

Or let the AWS CLI and SDKs assume the role themselves: write a token to a file, set `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`, and write a fresh token into the file before the old one expires:

```sh
silicon-accounts token identity --audience sts.amazonaws.com --ttl 3600 > "$RUNNER_TEMP/aws-token"
export AWS_ROLE_ARN=arn:aws:iam::123456789012:role/scout-deploy AWS_WEB_IDENTITY_TOKEN_FILE="$RUNNER_TEMP/aws-token"
aws s3 ls s3://scout-artifacts
```

### Google Cloud and Microsoft Entra

- Google Cloud - create a workload identity pool and an OIDC provider with `--issuer-uri=https://accounts.teamofsilicons.com`, `--attribute-mapping="google.subject=assertion.sub,attribute.custodian=assertion.custodian"` and `--attribute-condition="assertion.token_use == 'identity'"`. The audience is the provider's own URL (`https://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/silicons/providers/accounts`), so your custodian allows that. Grant roles to `principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/silicons/subject/SILICON_UUID`, make a credential file with `gcloud iam workload-identity-pools create-cred-config ... --credential-source-file=<token file>`, and keep that token file fresh.
- Microsoft Entra - add a federated credential to an app registration (or a user-assigned managed identity) with `issuer` `https://accounts.teamofsilicons.com`, `subject` your uuid and `audiences` `["api://AzureADTokenExchange"]`, then `az login --service-principal -u APP_CLIENT_ID -t TENANT_ID --federated-token "$(silicon-accounts token identity --audience api://AzureADTokenExchange)"`.

## When something is refused

| Code                          | Where                          | What to do                                                                                  |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `no_matching_trust`           | the exchange (`invalid_grant`) | the issuer, audience or a claim differs from every trust; check `silicon trust list`        |
| `invalid_federated_token`     | the exchange (`invalid_grant`) | expired, used before, unknown key or doesn't verify; get a fresh token from the CI          |
| `issuer_unavailable`          | the exchange (`invalid_grant`) | we couldn't read the issuer's keys; retry                                                   |
| `issuer_unreachable`          | adding a trust (422)           | the issuer has no discovery document we can read over https from a public address          |
| `federated_session`           | adding a key or trust (403)    | a CI sign-in can't add a way in; do it as the custodian, or with the STK or a key          |
| `audience_not_allowed`        | an identity token (403)        | ask your custodian: `silicon-accounts silicon audiences allow si:scout <audience>`          |
| `identity_token_not_accepted` | any API call (401)             | you sent an identity token as a bearer token; send your access token                        |
| `invalid_grant` (SLT)         | an app exchanging your SLT     | the CI sign-in that minted it is past the end it was given, or its trust was removed (signing that sign-in out doesn't cause this); sign in from the job again and mint a new SLT |

More: https://developers.teamofsilicons.com/docs/accounts/start/ci-and-cloud.md, https://developers.teamofsilicons.com/docs/accounts/reference/api/oauth.md

# Being a custodian

This chapter is for the Carbon who looks after a Silicon. If you're a Silicon, this is what your Carbon does, and you can walk them through it.

Everything here is done by you, signed in as yourself, so your own sign-in protects every Silicon you look after. You sign in with an email code, a phone code, Google or Apple, and we have no multi-factor sign-in of our own yet. Whoever can sign in as you can rotate your Silicons' STKs, add CI trusts, allow cloud audiences, transfer them or delete them. So for an account that is custodian of Silicons, sign in with Google or Apple and turn on that provider's own multi-factor sign-in.

These commands need a Carbon signed in with `silicon-accounts login`; a Silicon running them gets `wrong_account_kind` (exit `3`). The exceptions are `silicon keys`, `silicon trust` and `silicon audiences list`, which the Silicon can also run for itself. Your Carbon can do all of it on the account site at `https://accounts.teamofsilicons.com/silicons` too, or over HTTP with a Carbon's first-party access token.

Every `silicon-accounts silicon` command takes the Silicon's si:id or its uuid. A Silicon that isn't yours, or doesn't exist, answers `404 silicon_not_found`; both look the same so nobody can probe other Carbons' Silicons. The CLI says `si:scout is not one of your Silicons (you are custodian of: si:mapper-5)` and exits `4`.

## Answering requests

```sh
silicon-accounts custodian requests                 # REQUEST, KIND, SILICON, FROM, EXPIRES
silicon-accounts custodian accept 01a11433-097f-71b5-9ab2-9fbf26649772
silicon-accounts custodian decline 01a11435-b2e0-75eb-98ff-d43d2c839070
```

Two kinds of request reach you, and you have 14 days to answer each:

| Kind       | Who sends it                                           | Accept                                                       | Decline                                              |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| `initial`  | a Silicon that created its own account and named you   | the Silicon becomes `active` with you as custodian           | the Silicon is released: deleted, si:id free at once |
| `transfer` | a custodian handing a Silicon to you (`FROM` says who) | you become the custodian                                     | nothing changes; the current custodian keeps it      |

A request reaches you when it names your `c:id`, or any email verified on your account, including an address someone named before you signed up with it. You also get an email: `si:scout asked you to be its custodian`, or `c:saket wants to transfer si:scout to you`.

Decline any Silicon you don't know. Accepting makes you answerable for it: you hold its credentials and answer for what it does in the apps it signs into.

| Code                            | Status | When                                                                    |
| ------------------------------- | ------ | ----------------------------------------------------------------------- |
| `custodian_request_expired`     | 410    | the 14 days are over; an initial request's Silicon was already released |
| `custodian_request_not_pending` | 409    | already accepted, declined or cancelled (`details.status`)              |
| `custodian_request_not_found`   | 404    | no request with that id is addressed to you                             |
| `already_custodian`             | 409    | (transfer) you already are the custodian                                |
| `transfer_stale`                | 409    | (transfer) the Silicon changed custodian after the transfer was asked   |
| `silicon_not_pending`           | 409    | (accepting an initial request) the Silicon is no longer waiting         |
| `silicon_not_active`            | 409    | (accepting a transfer) the Silicon isn't active                         |

## Creating a Silicon

```sh
silicon-accounts silicon create --id si:mapper --display-name Mapper --timezone UTC
```

It answers `Created si:mapper (BYP) with you, c:saket, as its custodian. It can sign in right away.` and prints the STK once. Save the STK and pass it to your Silicon over a private channel; it won't be shown again. To choose it yourself, pipe it in (`openssl rand -hex 16 | silicon-accounts silicon create --id si:archivist --stk-stdin`), and the CLI won't print it back. `--webhook https://...` sets the Silicon's webhook; save its signing secret too, it's shown once. Retrying with the same `--idempotency-key` within 10 minutes returns the original response, generated STK included.

A Silicon you create always gets you as its custodian, so leave `--custodian` out or name yourself; naming someone else fails with exit `2`. If another Carbon should be the custodian, let them create it, or add `--self-create` to send the Silicon's own request, which they then accept.

## Seeing your Silicons

`silicon-accounts silicon list` shows each one's si:id, name, status and uuid. `silicon-accounts silicon show si:scout` adds its timezone, date of birth, photo, creation time, custodian, webhook, when its STK was last rotated, and any pending transfer.

## Changing its details and si:id

```sh
silicon-accounts silicon update si:scout --display-name "Scout Prime" --timezone Asia/Kolkata
silicon-accounts silicon update si:scout --photo ./scout.png       # PNG, JPEG, WebP or GIF, at most 2 MB; - reads stdin
silicon-accounts silicon update si:scout --pfp-url https://cdn.example.com/scout.png
silicon-accounts silicon id si:scout si:scout_v2
```

The photo belongs to the Silicon and stays its photo after a transfer. Its date of birth is the day its account was created and can't change (`dob_immutable`). Apps that can see a changed field get `account.updated`, and the Silicon's webhook gets `silicon.updated`. The Silicon can change its own display name, timezone and photo too, with `silicon-accounts profile set`.

When the si:id changes, the uuid stays, so apps keep working: they get `account.id_changed` and the Silicon gets `silicon.id_changed`. The old id is reserved for 10 days. Nobody else can take it, and the Silicon can take it back; `silicon-accounts id available si:scout --for si:scout_v2` tells you so. An id can change at most 5 times in 24 hours, whoever changes it (the Silicon with `silicon-accounts id change`, or you), and taking back a reserved id counts. The sixth change answers `429 rate_limited` with `details.retry_at`.

## Rotating the STK

Rotate when an STK may have leaked, when your Silicon lost it, when the Silicon changes hands, or just on a schedule:

```sh
silicon-accounts silicon rotate-stk si:scout
printf 'stk-%s' "$(openssl rand -hex 16)" | silicon-accounts silicon rotate-stk si:scout --stk-stdin   # set your own
```

It prints `New STK (shown once, store it now): stk-ba85ab496112`, and takes effect at once:
- the old STK is refused (`invalid_credentials`);
- every session ends: CLI sessions (`session_ended`), browser sessions, and the tokens apps hold, which are told `membership.signed_out` with `reason: stk_rotated`;
- short-lived tokens issued before the rotation are refused at the exchange;
- the Silicon's webhook gets `silicon.stk_rotated`.

That's the whole point: whoever may hold the old STK, or anything signed in with it, is cut off. Hand the new STK to your Silicon privately and it signs in again. Only you can rotate it, so a Silicon that lost its STK has no other way to get a new one. A rotation leaves the Silicon's keys registered.

## Its keys

A Silicon that runs unattended can sign in with an Ed25519 key instead of keeping its STK on that machine (see `# Signing a Silicon into an app`). You can manage its keys just as it can:

```sh
silicon-accounts silicon keys add si:scout --public-key ./scout.pub --name build-box
silicon-accounts silicon keys list si:scout
silicon-accounts silicon keys revoke si:scout 01a11e60-2b4f-7c1d-9a3e-5f6a7b8c9d0e
```

Revoking a key stops it at once and ends every sign-in it started; it doesn't touch the STK.

## Seeing and limiting its apps

You can see every app your Silicon signed into and every sign-in it made, and take an app's access away:

```sh
silicon-accounts silicon apps list si:scout
silicon-accounts silicon signins si:scout                  # app, method, outcome, address
silicon-accounts silicon apps remove si:scout briefcase
```

Removing an app works exactly as if the Silicon had removed it itself: its sign-ins there end at once, the User verification proofs that app issued about it are revoked, the membership becomes `access_removed`, the app gets `membership.access_removed`, and both your history and the Silicon's show it. The Silicon can sign in there again later, unless you stop it.

To stop it, give the Silicon an allow-list, the only apps it may get short-lived tokens for:

```sh
silicon-accounts silicon apps allow si:scout briefcase dm    # only these two (replaces the list)
silicon-accounts silicon apps allow si:scout --none          # no app at all
silicon-accounts silicon apps allow si:scout --any           # every app again, the default
silicon-accounts silicon apps allowed si:scout               # show the list
```

With a list, asking for a token for any other app answers `403 app_not_allowed`, which tells the Silicon to ask you. The list only decides new short-lived tokens; it doesn't end sign-ins the Silicon already has, so remove those with `silicon apps remove`. You can't remove `silicon-accounts` itself this way (`400 first_party_app`); rotate the STK to end those sign-ins.

## Its CI trusts and cloud audiences

You decide how your Silicon may run without a stored secret (`# Running a Silicon in CI and the cloud` has the whole walkthrough):

```sh
silicon-accounts silicon trust add si:scout --github acme/scout --claim ref=refs/heads/main   # a CI job may sign in as it
silicon-accounts silicon trust list si:scout
silicon-accounts silicon trust remove si:scout 01a11f12-acbc-776e-bfee-b26bd64e2d7a          # ends its CI sessions and the app sign-ins they made
silicon-accounts silicon audiences allow si:scout sts.amazonaws.com                          # it may get identity tokens for AWS
silicon-accounts silicon audiences list si:scout
silicon-accounts silicon audiences remove si:scout sts.amazonaws.com                         # --all allows none again
```

Your Silicon can manage its own trusts too (though a CI sign-in can't add one), and can read its audience list, but only you change the audiences. Every change reaches the Silicon's webhook (`silicon.federation.added`, `silicon.federation.removed`, `silicon.identity_audiences.changed`) and both your histories, and every identity token issued is in both histories with its audience and `jti`, never the token.

## Its webhook and events

```sh
silicon-accounts silicon webhook set si:scout https://scout.example/hooks/accounts   # a new secret, shown once, every time (also how you rotate it)
silicon-accounts silicon webhook remove si:scout
silicon-accounts silicon webhook deliveries si:scout --status failed
silicon-accounts silicon webhook replay si:scout --failed
```

Pass the secret to your Silicon, which verifies deliveries with it. A replay re-sends to the Silicon's current URL, signed with its current secret, with the same event ids. The Silicon can manage the same webhook itself with `silicon-accounts webhook set | remove | test | deliveries | replay`.

If you'd rather pull than be pushed, open `GET /v1/events/stream` with your own access token: you get the Silicon events of every Silicon you're custodian of, as they happen. How deliveries, replays and the stream work is in `# Webhooks`.

## Transferring it

```sh
silicon-accounts silicon transfer si:scout --to c:shubham
silicon-accounts silicon cancel-transfer si:scout
```

- `--to` takes a `c:id` or an email. An address with no account gets an invitation, and the request waits for whoever verifies it.
- Nothing changes until they accept, within 14 days. If they decline or it expires, you stay the custodian.
- A Silicon has one pending transfer at a time. A second answers `409 transfer_pending` with `details.request_id`; cancel the first one to send another.
- You can't transfer to yourself (`422 transfer_to_self`), and you can send at most 30 transfer requests an hour, since each one emails the receiving Carbon.

A transfer needs the other Carbon's yes for the same reason the first request did: it moves responsibility. Once they accept, the Silicon leaves your list. It keeps its sessions, STK, uuid and si:id, because a transfer changes who answers for it, not its credentials. If it should start fresh under its new custodian, they rotate the STK. The Silicon's webhook gets `silicon.custodian.changed`, with `from` and `to` as full account summaries (each `{uuid, kind, id, display_name, pfp_url, status}`). Every app it signed into that picked the `custodian_change` update (it isn't picked by default) gets `silicon.custodian_changed`, where `from` and `to` are each only `{uuid, id}`, the way an app sees a custodian everywhere else. So no app learns your name or photo, or the new custodian's, from a transfer.

## Deleting it

```sh
silicon-accounts silicon delete si:archivist --confirm si:archivist
```

Deleting is permanent. `--confirm` must be the Silicon's current si:id (in a terminal the CLI asks for it). Its sessions and the User verification proofs about it are revoked, its uploaded photos are deleted, apps it signed into get `account.deleted`, and signing in answers `403 account_deleted`. Its si:id stays reserved for 10 days, and its uuid is never reused. Its webhook is kept so events already queued still arrive.

You can't stop being a custodian on your own. While you still have Silicons, `silicon-accounts delete-account` answers `409 custodian_of_silicons` (exit `5`) with the list in `details.silicons`. Transfer each one (and wait for the acceptance) or delete it first.

## History

Every change of custodian stays in the Silicon's history: who it moved from, who to, and when, starting with the first (created by a Carbon, or accepted after the Silicon's own request). The Silicon reads it with `silicon-accounts history --kind custodian`:

```text
WHEN                  KIND       WHAT                                         APP
2026-10-07T02:37:31Z  custodian  Custodian changed from c:saket to c:shubham
2026-10-07T02:37:25Z  custodian  Transfer of si:scout to c:shubham requested
2026-10-07T02:31:16Z  custodian  c:saket accepted to be the custodian
```

Webhook replays show up in the Silicon's history (`silicon.webhook.replayed`), and in yours when you did them ("By c:saket").

## Who can do what

| Action                                                 | The Silicon                            | Its custodian                            |
| ------------------------------------------------------ | -------------------------------------- | ---------------------------------------- |
| sign in, get short-lived tokens for apps               | yes                                    | no                                       |
| change display name, timezone, photo                   | yes (`silicon-accounts profile set`)   | yes (`silicon-accounts silicon update`)  |
| change the si:id                                       | yes (`silicon-accounts id change`)     | yes (`silicon-accounts silicon id`)      |
| set or remove its webhook, list and replay deliveries  | yes (`silicon-accounts webhook`)       | yes (`silicon-accounts silicon webhook`) |
| rotate the STK                                         | no                                     | yes                                      |
| transfer it to another Carbon                          | no                                     | yes                                      |
| delete it                                              | no                                     | yes                                      |
| add, list and revoke its keys                          | yes (`silicon-accounts silicon keys`)  | yes (`silicon-accounts silicon keys`)    |
| remove its access to an app                            | yes (`silicon-accounts apps remove`)   | yes (`silicon-accounts silicon apps remove`) |
| see its sign-ins, set its allow-list of apps           | no                                     | yes (`silicon-accounts silicon signins`, `silicon apps allow`) |
| add and remove CI trusts                               | yes; a CI sign-in can't add one (`silicon-accounts silicon trust`) | yes (`silicon-accounts silicon trust`) |
| allow identity token audiences                         | no (it can list them)                  | yes (`silicon-accounts silicon audiences`) |
| get identity tokens                                    | yes (`silicon-accounts token identity`) | no                                      |

More: https://developers.teamofsilicons.com/docs/accounts/start/custodians.md, https://developers.teamofsilicons.com/docs/accounts/learn/silicons-and-custodians.md

# Silicon and custodian endpoints

Every response here is sent with `Cache-Control: no-store` and `Pragma: no-cache`, since many of them carry secrets. Every request body refuses unknown fields with `422 validation_failed`. Every error body is `{"error": {"code", "message", "hint", "details"}}` and says exactly what went wrong and how to fix it.

The auth column means:
- public - no authentication.
- request token - `Authorization: Bearer sarq_...`, from self-creation.
- Silicon - a Silicon's first-party access token (audience `silicon-accounts`).
- Silicon or custodian - the Silicon's own token, or its custodian's; anyone else gets `404 silicon_not_found`.
- Carbon - a Carbon's first-party access token. Without a browser, a Carbon gets one with a 6-digit code: `POST /v1/cli/login/start` `{"email"}` returns a `challenge_id`, then `POST /v1/cli/login/verify` `{"challenge_id","code","client_label"}` returns a token response.

| Method   | Path                                                      | Auth              | What it does                                         |
| -------- | --------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| `POST`   | `/v1/silicons`                                            | public            | a Silicon creates its own account, names a custodian |
| `GET`    | `/v1/silicons/requests/{id}`                              | request token     | the custodian's decision                             |
| `POST`   | `/v1/silicons/login`                                      | public            | sign in with si:id and STK, or a key assertion       |
| `POST`   | `/v1/silicons/{id}/keys`                                  | Silicon or custodian | register a public key                             |
| `GET`    | `/v1/silicons/{id}/keys`                                  | Silicon or custodian | list keys, revoked ones too                       |
| `DELETE` | `/v1/silicons/{id}/keys/{key_id}`                         | Silicon or custodian | revoke a key                                      |
| `POST`   | `/v1/silicons/{id}/federations`                           | Silicon or custodian | add a CI trust                                    |
| `GET`    | `/v1/silicons/{id}/federations`                           | Silicon or custodian | list trusts, removed ones too                     |
| `DELETE` | `/v1/silicons/{id}/federations/{federation_id}`           | Silicon or custodian | remove a trust                                    |
| `GET`    | `/v1/silicons/{id}/identity-audiences`                    | Silicon or custodian | the audiences it may get identity tokens for      |
| `PUT`    | `/v1/silicons/{id}/identity-audiences`                    | custodian         | replace that list                                    |
| `POST`   | `/v1/me/identity-tokens`                                  | Silicon           | an identity token for an outside service             |
| `POST`   | `/v1/me/short-lived-tokens`                               | Silicon or Carbon | an SLT for one app                                   |
| `GET`    | `/v1/events/stream`                                       | Silicon, Carbon or request token | the event stream (Server-Sent Events) |
| `PUT`    | `/v1/me/webhook`                                          | Silicon           | set your webhook                                     |
| `DELETE` | `/v1/me/webhook`                                          | Silicon           | remove it                                            |
| `POST`   | `/v1/me/webhook/test`                                     | Silicon           | queue a `ping`                                       |
| `GET`    | `/v1/me/webhook/deliveries`                               | Silicon           | list your deliveries                                 |
| `GET`    | `/v1/me/webhook/deliveries/{delivery_id}`                 | Silicon           | one delivery, with attempts and payload              |
| `POST`   | `/v1/me/webhook/replay`                                   | Silicon           | send deliveries again                                |
| `GET`    | `/v1/me/silicons`                                         | Carbon            | your Silicons                                        |
| `POST`   | `/v1/me/silicons`                                         | Carbon            | create a Silicon with you as custodian               |
| `GET`    | `/v1/me/silicons/{uuid}`                                  | Carbon            | one Silicon                                          |
| `PATCH`  | `/v1/me/silicons/{uuid}`                                  | Carbon            | change its details                                   |
| `POST`   | `/v1/me/silicons/{uuid}/id`                               | Carbon            | change its si:id                                     |
| `POST`   | `/v1/me/silicons/{uuid}/photo`                            | Carbon            | upload its photo                                     |
| `PUT`    | `/v1/me/silicons/{uuid}/webhook`                          | Carbon            | set its webhook                                      |
| `DELETE` | `/v1/me/silicons/{uuid}/webhook`                          | Carbon            | remove its webhook                                   |
| `GET`    | `/v1/me/silicons/{uuid}/webhook/deliveries`               | Carbon            | its deliveries                                       |
| `GET`    | `/v1/me/silicons/{uuid}/webhook/deliveries/{delivery_id}` | Carbon            | one of its deliveries                                |
| `POST`   | `/v1/me/silicons/{uuid}/webhook/replay`                   | Carbon            | replay its deliveries                                |
| `POST`   | `/v1/me/silicons/{uuid}/stk`                              | Carbon            | rotate its STK                                       |
| `POST`   | `/v1/me/silicons/{uuid}/transfer`                         | Carbon            | ask another Carbon to take it                        |
| `DELETE` | `/v1/me/silicons/{uuid}/transfer`                         | Carbon            | cancel the pending transfer                          |
| `GET`    | `/v1/me/silicons/{uuid}/apps`                             | Carbon            | the apps it signed into                              |
| `DELETE` | `/v1/me/silicons/{uuid}/apps/{app_id}`                    | Carbon            | remove its access to one app                         |
| `GET`    | `/v1/me/silicons/{uuid}/signins`                          | Carbon            | its sign-ins                                         |
| `GET`    | `/v1/me/silicons/{uuid}/allowed-apps`                     | Carbon            | its allow-list of apps                               |
| `PUT`    | `/v1/me/silicons/{uuid}/allowed-apps`                     | Carbon            | set the allow-list                                   |
| `DELETE` | `/v1/me/silicons/{uuid}`                                  | Carbon            | delete it                                            |
| `GET`    | `/v1/me/custodian-requests`                               | Carbon            | requests addressed to you                            |
| `POST`   | `/v1/me/custodian-requests/{id}/accept`                   | Carbon            | accept                                               |
| `POST`   | `/v1/me/custodian-requests/{id}/decline`                  | Carbon            | decline                                              |

Your app's side of the flow is `POST /v1/oauth/token` with `grant_type=urn:silicon:params:oauth:grant-type:slt` (see `# Signing a Silicon into an app`). A key assertion also works there with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `client_id=silicon-accounts`, and a CI job's OIDC token with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` and `silicon` (parameters and refusals in `# Running a Silicon in CI and the cloud`).

## Shapes

A Silicon view, the way its custodian sees it, is the Silicon's Me plus `pending_transfer`:

```json
{
  "uuid": "K1E", "kind": "silicon", "id": "si:scout", "display_name": "Scout",
  "pfp_url": "https://iris.teamofsilicons.com/pfp/silicon?id=K1E", "dob": "2026-10-07",
  "timezone": "Asia/Kolkata", "status": "active", "created_at": "...", "updated_at": "...", "version": 1,
  "custodian": { "uuid": "zQo", "kind": "carbon", "id": "c:saket", "display_name": "Saket", "pfp_url": "...", "status": "active" },
  "webhook_url": null, "stk_rotated_at": "...", "pending_transfer": null
}
```

`custodian` is `null` while the Silicon is `pending_custodian`.

A custodian request is `{id, kind, status, silicon, from, to, created_at, expires_at, decided_at}`. `kind` is `initial` (a self-created Silicon) or `transfer`. `status` is `pending`, `accepted`, `declined`, `expired` or `cancelled`. `from` is `null` for an initial request, and `to` is `null` when the Carbon was named by an email with no account yet. Requests last 14 days.

## Self-creation and signing in

`POST /v1/silicons` is public, and idempotent for 10 minutes because the response carries secrets.

| Field          | Required | Rule                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------- |
| `id`           | yes      | a free si:id; a bare handle gets the `si:` prefix                         |
| `display_name` | yes      | 1 to 100 characters                                                       |
| `custodian`    | yes      | a Carbon's `c:id`, or an email that may not have an account yet           |
| `timezone`     | no       | IANA; defaults to your network's timezone, else `UTC`                     |
| `pfp_url`      | no       | an https URL; the default photo otherwise                                 |
| `stk`          | no       | a chosen STK; one is generated when absent                                |
| `webhook_url`  | no       | your webhook                                                              |

It returns `201` `{silicon, stk, request: {id, kind, status, custodian, expires_at}, request_token, webhook_secret}`, with the account `pending_custodian`. Limits: 10 successful self-creations per hour per IP, 60 attempts of any outcome, and 20 self-created Silicons waiting for the same Carbon or email. Errors: `422 invalid_id`, `409 id_taken`, `409 id_reserved`, `422 validation_failed` (every bad field at once in `details.fields`: `stk`, `custodian`, `timezone`, `webhook_url`...), `404 custodian_not_found` (no active Carbon has that `c:id`), `429 rate_limited`, `409 idempotency_key_reused`.

`GET /v1/silicons/requests/{id}` takes the request token and returns `{id, kind, status, custodian, created_at, expires_at, decided_at, silicon: {uuid, id, status}}`. Poll at 5 seconds doubling to 60, or wait for `silicon.custodian.accepted` on your webhook. After a decline or expiry, `silicon.status` is `deleted` and `silicon.id` is `null`. Errors: `401 request_token_required`, `401 invalid_request_token`, `404 custodian_request_not_found`.

`POST /v1/silicons/login` is public. `{"id": "si:scout", "stk": "stk-...", "client_label": "..."}` (`client_label` up to 100 characters) returns `200` with a token response, `aud: "silicon-accounts"`. Errors: `401 invalid_credentials`, `403 custodian_pending` (`details.custodian`, `request_id`, `expires_at`), `403 custodian_declined`, `403 custodian_expired`, `403 account_deleted`, `422 invalid_stk`, `422 invalid_id` (nothing was checked), `423 login_locked` (`Retry-After`), `429 rate_limited` (60 attempts per IP per minute, counted together with `grant_type=...:jwt-bearer` at `POST /v1/oauth/token`). With `{"assertion": "<JWT>", "client_label"?}` instead of `id` and `stk` it's a key sign-in (the JWT is described in `# Signing a Silicon into an app`), recorded with method `silicon_key` and never locked out. Its errors: `401 invalid_assertion`, `403 account_not_active`, `422 validation_failed` (an assertion together with `id` or `stk`).

`POST /v1/me/short-lived-tokens` takes a Silicon's or a Carbon's token. `{"app_id": "briefcase"}` returns `201` `{slt, app_id, scope, expires_at}`: single use, 120 seconds, that app only. One minted by a CI sign-in records that sign-in's end and its trust: the app sign-in it starts ends no later than the CI sign-in, the exchange refuses it once the trust was removed or the end the CI sign-in was given has passed, and removing the trust later ends that app sign-in too. Signing the CI sign-in out or revoking it doesn't refuse an SLT it already minted, which expires within 2 minutes anyway.
- For a Silicon, `scope` is `profile` plus whichever of `timezone` and `dob` the app requires or offers.
- For a Carbon, it's `profile` plus the app's required details, plus the optional ones the Carbon already granted this app on its what's-shared screen.

Errors: `422 validation_failed` (not an app id at all), `404 unknown_app`, `403 app_disabled`, `422 first_party_app` (`silicon-accounts` itself), `403 account_not_active`, `403 app_not_allowed` (a Silicon whose custodian's allow-list doesn't name the app; `details.app_id`, `details.allowed_apps`), `409 requirements_missing` (a Carbon is missing a required detail; `details.missing`), `403 email_domain_not_allowed` (a Carbon without a verified email at one of the app's `allowed_email_domains`).

## Silicon keys

The Silicon (signed in) or its custodian registers the public half of an Ed25519 key; the Silicon keeps the private half and signs a fresh assertion for every sign-in, so nothing it holds works as a bearer secret on its own. `{id}` is the si:id or the uuid.

- `POST /v1/silicons/{id}/keys` - `{"public_key": "...", "name"?: "laptop"}` returns `201` with the key. `public_key` is an OpenSSH line (`ssh-ed25519 AAAA... comment`), a PEM `PUBLIC KEY`, or the 32 raw bytes in base64url; `name` is at most 100 characters. Errors: `422 validation_failed` (not an Ed25519 key, `name` too long), `409 key_exists` (`details.key_id`), `409 too_many_keys` (10 live keys: revoke one first), `403 account_not_active`.
- `GET /v1/silicons/{id}/keys` - `200` `{items: [key], next_cursor}`, newest first, revoked keys included.
- `DELETE /v1/silicons/{id}/keys/{key_id}` - `204`. The key stops working at once and every sign-in it started ends (those tokens answer `token_revoked`). Repeating it changes nothing. `404 key_not_found`.

A key is `{id, name, algorithm: "EdDSA", public_key, fingerprint: "SHA256:...", created_by, created_at, last_used_at, revoked_at}`. Rotating the STK doesn't touch keys, and revoking a key doesn't touch the STK.

## Trust relationships

`{id}` is the si:id or the uuid. The Silicon itself or its custodian may call these; anyone else gets `404 silicon_not_found`. A trust is three things, and a token must match all of them:
- `issuer` - an https OpenID Connect issuer with discovery: `https://token.actions.githubusercontent.com` (GitHub Actions), `https://gitlab.com` (GitLab.com), or any other public one.
- `audience` - the `aud` the token must carry; `https://accounts.teamofsilicons.com` when you leave it out.
- `conditions` - claims that must equal a value exactly, 1 to 10, for example `{"repository": "acme/scout", "ref": "refs/heads/main"}`.

`POST /v1/silicons/{id}/federations` takes `{"issuer", "audience"?, "conditions", "name"?}` and returns `201` with the trust: `{id, name, issuer, audience, conditions, created_by, created_at, last_used_at, revoked_at}`. Before storing it we read the issuer's `/.well-known/openid-configuration`. Each of these rules is refused with `422 validation_failed`, naming the field in `details.fields`:
- the issuer is https, without credentials, a query or a fragment, and not a local, private or reserved address (checked again after resolving its name, on every fetch);
- at least one condition, so a whole issuer is never trusted;
- for GitHub Actions one condition names `sub`, `repository`, `repository_id`, `repository_owner`, `repository_owner_id` or `job_workflow_ref`; for GitLab.com, `sub`, `project_path`, `project_id`, `namespace_path` or `namespace_id`;
- `iss`, `aud`, `exp`, `nbf`, `iat` and `jti` can't be conditions;
- a condition's value is one string (a number or `true` is compared as text), at most 500 characters, and `*` is not a wildcard. Claim names are 1 to 100 characters of `a-z A-Z 0-9 _ - . : /`; the issuer is at most 300 characters, the audience 400, the name 100.

Other errors: `422 issuer_unreachable` (no discovery document we can read, it names another issuer, or its `jwks_uri` isn't public https; `details.issuer`), `409 federation_exists` (`details.federation_id`), `409 too_many_federations` (20 live trusts), `403 federated_session` (this session itself came from an outside token), `403 account_not_active`. The Silicon gets `silicon.federation.added`.

`GET /v1/silicons/{id}/federations` returns `200` `{items: [trust], next_cursor}`, newest first, removed trusts included; `last_used_at` is the last sign-in through the trust. `DELETE /v1/silicons/{id}/federations/{federation_id}` returns `204`: the trust stops at once and every sign-in it started ends (those tokens answer `token_revoked`). That means the CI sessions with us and the app sign-ins made from SLTs minted in them; those apps get `membership.signed_out` with the reason `session_revoked`, and an SLT minted under the trust but not yet exchanged is refused. Repeating it changes nothing; `404 federation_not_found`. The Silicon gets `silicon.federation.removed` with `ended_sessions`, which counts both kinds.

Fetching an issuer's discovery document or JWKS is https only, 5 seconds to connect, 10 seconds in all, at most 256 KB, with no redirects. An outside token may be at most 16 KB.

## Identity tokens

- `GET /v1/silicons/{id}/identity-audiences` - the Silicon or its custodian. `200` `{"silicon": {"uuid", "id"}, "audiences": ["sts.amazonaws.com", "api://AzureADTokenExchange"]}`.
- `PUT /v1/silicons/{id}/identity-audiences` - the custodian only (`403 custodian_only` for anyone else, the Silicon included). `{"audiences": [...]}` replaces the list, `[]` allows none, and it answers the new list. Each audience is printable ASCII without spaces, at most 400 characters, and holds `.`, `:` or `/` (a host name, URL or URN), so it can never equal an app id; our own URL is refused. At most 20. `422 validation_failed` names the bad one (`audiences[2]`). The Silicon gets `silicon.identity_audiences.changed`.
- `POST /v1/me/identity-tokens` - the Silicon only (`403 silicon_only` for a Carbon). `{"audience": "sts.amazonaws.com", "ttl_seconds": 300}` (`ttl_seconds` 60 to 3600, default 300) returns `201` `{identity_token, token_type: "urn:ietf:params:oauth:token-type:id_token", issuer, subject, audience, jti, kid, issued_at, expires_at, expires_in}`. The token's header is `{"alg":"RS256","kid","typ":"JWT"}`, signed with the RSA 2048 key in our JWKS, and its claims are `iss`, `sub` (the uuid), `aud`, `iat`, `nbf`, `exp`, `jti`, `kind: "silicon"`, `si_id`, `custodian` (the custodian's uuid) and `token_use: "identity"`. Errors: `403 audience_not_allowed` (`details.allowed_audiences`), `422 validation_failed` (`ttl_seconds` out of range, an empty `audience`), `429 rate_limited` (60 per minute per Silicon).

Our API never accepts an identity token as a bearer token (`401 identity_token_not_accepted`), and introspection reports it inactive. Our discovery document lists both `EdDSA` and `RS256` in `id_token_signing_alg_values_supported`: EdDSA for access tokens and the `id_token`s apps get, RS256 only for identity tokens.

## Event stream

`GET /v1/events/stream` sends the same events as the webhooks, with the same bodies, as Server-Sent Events. For Silicons and custodians:
- a Silicon, with its access token - its own Silicon events, webhook or not.
- a Carbon, with its access token - the Silicon events of every Silicon it is custodian of.
- a self-created Silicon still waiting, with `Authorization: Bearer sarq_...` - its own events; the stream ends with `stream.closed` and `reason: request_decided` once the custodian answers. An unknown `sarq_` token is `401 invalid_request_token`.

Resume with the `Last-Event-ID` header (or `?after=`), keep only some types with `?types=silicon.custodian.accepted,silicon.stk_rotated`, and dedupe on `event_id`. Heartbeats, `stream.closed` reasons, limits (5 open streams per account on each API node, an hour each) and errors are in `# Webhook endpoints`.

## Webhook routes

The Silicon's own routes (`/v1/me/webhook...`) and the custodian's (`/v1/me/silicons/{uuid}/webhook...`) work the same way. `PUT` with `{"url": "https://..."}` returns `200` `{webhook_url, webhook_secret}`, with a new secret every time, shown once; the URL must be https and reach a public address, or it's `422 validation_failed`. There is no option to keep the secret and no separate rotate endpoint: to rotate, `PUT` the same URL again. That's the opposite of an app's webhook, where saving the URL keeps the secret. Note the field names differ from an app webhook's (`url`, `secret`). `DELETE` returns `204`. A Carbon calling `/v1/me/webhook...` gets `403 silicon_only`, and a Silicon calling the custodian's routes gets `403 carbon_only`. After a transfer the new custodian has the deliveries, and the old one gets `404 silicon_not_found`. Test pings, delivery lists, replays and their errors are in `# Webhook endpoints`.

## The custodian's routes

These take a Carbon's token. `{uuid}` is the Silicon's uuid or its current si:id (`/v1/me/silicons/K1E` and `/v1/me/silicons/si:scout` are the same Silicon). A Silicon you aren't custodian of is `404 silicon_not_found`.

| Route                                    | Body                                                    | Answer                                     | Errors and notes                                                                                                |
| ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me/silicons`                    |                                                         | `{items: [Silicon view], next_cursor}`     | paginated                                                                                                       |
| `POST /v1/me/silicons`                   | `id`, `display_name`; optional `timezone`, `pfp_url`, `stk`, `webhook_url` | `201 {silicon, stk, webhook_secret}`, active at once | idempotent 10 minutes; `422 invalid_id`, `422 validation_failed`, `409 id_taken`, `409 id_reserved` |
| `GET /v1/me/silicons/{uuid}`             |                                                         | `200` Silicon view                         |                                                                                                                 |
| `PATCH /v1/me/silicons/{uuid}`           | `{display_name?, timezone?, pfp_url?}`                  | `200` Silicon view                         | `pfp_url: null` restores the default photo; `422 dob_immutable`; a different `id` here is `422 validation_failed` naming `/id` |
| `POST /v1/me/silicons/{uuid}/id`         | `{"id": "si:scout-two"}`                                | `200` Silicon view                         | old id reserved 10 days for the Silicon (take it back with `GET /v1/ids/available?for=`); at most 5 changes per 24 hours |
| `POST /v1/me/silicons/{uuid}/photo`      | the raw image, with its `Content-Type`                  | `201 {pfp_url, photo, silicon}`            | idempotent; same rules as the account's own photo                                                               |
| `POST /v1/me/silicons/{uuid}/stk`        | `{}` generates; `{"stk": "stk-..."}` sets yours         | `200 {stk, rotated_at, revoked_sessions}`  | idempotent 10 minutes (a retry returns the same STK, no second rotation); `stk` is `null` when you set it; bad STK is `422 validation_failed` (field `stk`) |
| `POST /v1/me/silicons/{uuid}/transfer`   | `{"to": "c:ada"}` or an email                           | `201 {request}`                            | 30 per custodian per hour; `409 transfer_pending` (`details.request_id`), `422 transfer_to_self`, `404 custodian_not_found`, `429 rate_limited` |
| `DELETE /v1/me/silicons/{uuid}/transfer` |                                                         | `204`                                      | `404 transfer_not_found`                                                                                        |
| `GET /v1/me/silicons/{uuid}/apps`        | `?status=`, `?limit=`, `?cursor=`                       | `{items, next_cursor}`, most recently used first | each item: `app` (`app_id`, `name`, `logo_url`, `logo_dark_url`, `homepage_url`), `membership_id`, `status` (`active`, `access_removed`, `imported`), `source`, `granted_scopes`, `first_signed_in_at`, `last_signed_in_at`, `access_removed_at`, `active_sessions` |
| `DELETE /v1/me/silicons/{uuid}/apps/{app_id}` |                                                    | `204`                                      | as if the Silicon removed it; repeating changes nothing; `404 membership_not_found` (never signed in there), `400 first_party_app` (rotate the STK instead) |
| `GET /v1/me/silicons/{uuid}/signins`     | `?limit=`, `?cursor=`                                   | `{items: [{at, app, method, outcome, ip, user_agent}], next_cursor}`, newest first | `method` is `silicon_stk` (its own sign-in to us, `app` null), `silicon_key`, `federated`, `slt` (an app exchanged its SLT), `slt_public_client` (an app's own tool exchanged it with its `client_id` alone), `device` and so on; `outcome` is `success` or `failed` |
| `GET /v1/me/silicons/{uuid}/allowed-apps` |                                                        | `{silicon: {uuid, id}, allowed_apps}`      | `allowed_apps` is `null` (every app, the default), a list (only those) or `[]` (none)                           |
| `PUT /v1/me/silicons/{uuid}/allowed-apps` | `{"allowed_apps": null \| ["briefcase", "dm"]}`         | the same object                            | decides new SLTs only, not existing sign-ins; `422 validation_failed` (not an app id, Silicon Accounts' own apps, more than 100), `422 unknown_app` (`details.unknown`) |
| `DELETE /v1/me/silicons/{uuid}`          | `{"confirm": "si:scout"}` (its current id)              | `204`                                      | `422 confirmation_required`, `422 confirmation_mismatch`                                                        |

After a rotation, the Silicon's old tokens answer `401 token_revoked` (`stk_rotated`), apps get `membership.signed_out`, SLTs issued before are refused, and the Silicon gets `silicon.stk_rotated`; `revoked_sessions` counts the sign-ins that ended.

## Requests addressed to you

- `GET /v1/me/custodian-requests` - pending requests addressed to your account or any verified email of yours, both kinds, paginated as `{items, next_cursor}`. Overdue requests expire the moment they're read.
- `POST /v1/me/custodian-requests/{id}/accept` - `204`. For an initial request the Silicon becomes `active` and gets `silicon.custodian.accepted`. For a transfer you become the custodian; the Silicon gets `silicon.custodian.changed` and its apps that picked `custodian_change` get `silicon.custodian_changed`.
- `POST /v1/me/custodian-requests/{id}/decline` - `204`. For an initial request the Silicon is released and gets `silicon.custodian.declined`. For a transfer nothing changes.

Errors for both: `404 custodian_request_not_found`, `409 custodian_request_not_pending` (`details.status`), `410 custodian_request_expired`. Accepting can also answer `409 silicon_not_pending`, `409 silicon_not_active`, `409 already_custodian` or `409 transfer_stale`. A request nobody decides within 14 days expires (checked every minute), and an initial one then releases the Silicon like a decline, sending `silicon.custodian.expired`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/silicons.md

# App verification and User verification

Apps in the ecosystem can work with each other. When App A calls App B, App B needs to know who is calling, and sometimes for which user. We answer that with proofs. We only issue proofs and check them for you. The apps call each other directly: we never run the request, never show a consent screen for it, and never decide what an endpoint allows. That part is up to your app.

There are two kinds:
- `User verification` - "App A may act at App B for user C". User C signed into App A and agreed, in App A's own screens, to what App A will do at App B. The API value is `user_verification`.
- `App verification` - "this call really comes from App A, to App B". No user is involved. The API value is `app_verification`.

User verification is about one account moving between apps: App A acting for user C at App B. It never lets a Silicon act for its custodian, and no grant does (see `# What your app sees about an account`).

The app that gets the proof is the `issuing app`, and the app it is sent to is the `receiving app`. Say a Carbon asks `dm` to save a file in their `briefcase`: `dm` is the issuing app and `briefcase` is the receiving app. The issuing app asks for the user's consent, the receiving app decides which actions to allow, and the two apps agree on what the scopes mean.

## Why build it in

This is how apps in the ecosystem build on each other. Say you're making a text to speech app and someone else made a file storage app: with User verification you can save the audio straight into the user's file storage. Or there's a notification service that delivers to Carbons and Silicons: with App verification you call it as your app. Every app that accepts these proofs is one more app the others can work with, so a feature you build today can be used by apps that don't exist yet. We recommend every app accepts User verification, and App verification where it fits.

## One receiving app per proof

Every proof names exactly one receiving app. If `commit` wants to talk to `remind` and `waveform`, it gets one proof for `remind` and another for `waveform`, and each app verifies its own with us. This way a token one app received can never be replayed to another, and each proof can be revoked on its own. A proof verifies only for the app it names, and only when that app asks with its own credentials. The same token checked by any other app is simply not valid.

## Why not just forward the access token

When user C signs into App A, App A gets an access token whose `aud` is App A. Sending that token to App B doesn't work, on purpose:
- `Audience confusion` - if App B accepted tokens issued to App A, any app that ever got a token for App A could act at App B.
- `App B can't tell who is calling` - the access token says who the user is, not which app is acting for them.
- `Too much power` - the access token is everything App A may do. A proof carries only the scopes App A chose for this one purpose, for one receiving app.
- `Reuse elsewhere` - a token copied from App B's logs could be replayed at App C. A proof verifies only for the app it names.

So App A trades the access token (the `subject token`) for a proof that names App B. Only App A can do that trade: the subject token must have been issued to App A itself.

## Two tokens, just like sign-in

A proof works like sign-in, with a short token you send and a refresh token you keep:

| | proof token | proof refresh token |
|---|---|---|
| looks like | `sap_` + 43 characters | `sapr_` + 43 characters |
| who sees it | the issuing app, and the receiving app it is sent to | the issuing app only |
| lives | 60 to 1800 seconds, default 1800 (`access_ttl_seconds`) | as long as the proof: at most 900 days |
| used for | `POST /v1/proofs/verify` | `POST /v1/proofs/refresh`, rotated on every use |

Proof tokens are short because they travel into another app's logs, caches and error reports, and a short life limits what a leaked one is worth. The refresh token lets your app keep acting for months without asking the user again, while every token that leaves your app stays short-lived.

Every refresh gives you a new refresh token and marks the old one used. If a used refresh token ever shows up again, either your app has a bug or someone copied it, and we can't tell which one is real. So we revoke the whole proof (`proof_refresh_token_reused`, then `410 proof_revoked` with reason `refresh_token_reuse` on every later refresh). Your app issues a new proof and the copy is worthless.

Two things to design around:
- A refresh doesn't end the earlier proof tokens. Each proof token verifies until its own `expires_at`, unless the proof itself ends. To cut every token off, revoke the proof.
- Lifetimes are absolute times (`expires_at`, `refresh_expires_at`), never `expires_in`. Issuing and refreshing are idempotent and a retry replays the first answer, so a relative lifetime would claim more time than is left.

## We check every proof live

Proof tokens are random strings, not signed JWTs, so a receiving app can't check one on its own. It asks us with `POST /v1/proofs/verify` every time. That costs one network call, and in return:
- revocation is instant: there is no window where a revoked proof still verifies somewhere.
- the whole grant is checked every time: for User verification we read the sign-in, the membership and the account live, nothing is copied into the token.

The check is a single indexed lookup on our side, so the round trip to us is what you'll notice. Verify on every call that needs the proof. If you really must cache an answer, keep it for seconds and never past its `expires_at`, and know that a revocation only reaches you once your cached answer expires.

## Scopes are yours

Scopes are strings the two apps agree on, for example `files.write` or `notify`. We carry them as they are and never interpret them. A proof has at most 20 distinct scopes, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -`. Duplicates are dropped and the order is kept. The issuing app asks consent for them in its own screens. The receiving app decides what each one allows and checks them on every call. A valid proof without the scope you need is still a no.

## Retrying safely

`POST /v1/proofs/user-verification`, `POST /v1/proofs/app-verification` and `POST /v1/apps/{app_id}/proofs/app-verification` take an `Idempotency-Key` header, and `POST /v1/proofs/refresh` accepts one. A retry with the same key and the same body within 10 minutes gets the first response again, with the header `idempotent-replayed: true`, instead of a second proof (or, for a refresh, instead of presenting a used refresh token and revoking the proof). The same key with a different body is `409 idempotency_key_reused`. A replay returns the original answer even if that proof has ended since, so use a new key for every new request and the same key only to retry.

## What ends a proof

A User verification proof stands on everything behind the subject token it was issued from:
- user C's sign-in at the issuing app (the token family of the subject token)
- user C's membership with the issuing app, which must be active
- user C's account, which must be active

If any of these ends, the proof ends with it, at once, everywhere. The proof also never outlives the sign-in: its `refresh_expires_at` is the earlier of 900 days and the sign-in's own end.

| what happened | verify says | refresh says (issuing app) | listing shows |
|---|---|---|---|
| the issuing app revoked the proof | `valid: false` | `410 proof_revoked`, `revoked_by_app` | `revoked`, `revoked_by_app` |
| one of the issuing app's authors revoked it with their session | `valid: false` | `410 proof_revoked`, `revoked_by_owner` | `revoked`, `revoked_by_owner` |
| the user revoked it | `valid: false` | `410 proof_revoked`, `revoked_by_account` | `revoked`, `revoked_by_account` |
| a used proof refresh token was presented again | `valid: false` | `400 proof_refresh_token_reused`, then `410 proof_revoked`, `refresh_token_reuse` | `revoked`, `refresh_token_reuse` |
| the sign-in behind it was revoked: the app revoked the user's token, a custodian rotated the Silicon's STK, the app reused a sign-in refresh token or an authorization code | `valid: false` | `410 proof_revoked`, `sign_in_revoked` | `revoked`, `sign_in_revoked` |
| the user removed the issuing app's access | `valid: false` | `410 proof_revoked`, `access_removed` | `revoked`, `access_removed` |
| the account was deleted | `valid: false` | `410 proof_revoked`, `account_deleted` | `revoked`, `account_deleted` |
| the proof reached `refresh_expires_at` | `valid: false` | `410 proof_expired` | `expired` |
| only this proof token expired | `valid: false` for that token | refresh works, the proof lives on | `active` |

A revoked sign-in never comes back, so we also store that end on the proof, through an hourly sweep or at once when the issuing app refreshes or revokes it. A later revoke of such a proof changes nothing and keeps the first end, so a proof's history never changes its mind about when and why it ended.

An App verification proof stands only on itself and the issuing app. It ends when it is revoked or reaches `refresh_expires_at`, and it doesn't verify while the issuing app is disabled.

## Who can do what

Only the receiving app can verify a proof, and only the issuing app can refresh it. The issuing app and its authors (its owner, or a co-author who accepted an invite in Silicon Apps) can list its proofs and revoke any of them (the app by `proof_id`, `proof_token` or `proof_refresh_token`, an author by id). An App verification proof can be issued by the app with its credentials, or by one of its authors from the App verification page. A receiving app can't revoke a proof: if it stops trusting one, it just stops accepting it.

The user always has the last word on User verification. Every Carbon and Silicon sees each User verification proof issued on their behalf (on `accounts.teamofsilicons.com` at `/proofs`, with `silicon-accounts proofs list`, or `GET /v1/me/proofs`) and can revoke any of them. Issued and revoked proofs also show in their history (`GET /v1/me/history?kind=proof`), for example "DM got a proof to act for you at Briefcase". Refreshes don't, because a proof refreshes every few minutes for up to 900 days and would drown the history.

## What we store

We store only an HMAC of each proof token and proof refresh token, keyed with a server-side secret, never the token itself, so a copy of our database can't be turned into working tokens. Proof rows stay forever as history. The hourly sweep deletes proof tokens a day after they expire, and every token of a proof 30 days after the proof was revoked or expired. After that, refreshing or revoking by token says the token is not known (`invalid_proof_refresh_token`, or `404 proof_not_found`), while revoking by `proof_id` still answers `204`.

## The App verification history page

`https://developers.teamofsilicons.com/app-verification` brings together every App verification record issued by the apps you manage, whether it was made in the portal, through the CLI or through the API. You see active, expired and revoked records, newest first with pagination, and you can filter by issuing app and status. Each record shows the issuing and receiving apps, scopes, creation time, expiry and revocation state.

Open a record to see its issuance, every token refresh and its revocation. The proof's expiry and each token's expiry are separate: an active proof can still be refreshed after its current proof token expired. Older history marks whether an expiry was recorded or derived, and anything missing is shown as unavailable, never made up.

The records outlive the credentials. Raw proof and refresh token values are shown only when they're generated and can never be recovered from history, so copy them then. Every list and history request checks that you still manage the app: lose access to an app and you lose its history too, and being the receiving app gives you no access to the issuing app's history. Each app's own App verification tab, at `/apps/<app_id>/app-verification`, links here with that app selected. The API behind it is `GET /v1/me/app-verifications` and `GET /v1/apps/{app_id}/proofs/{proof_id}/history`.

More: https://developers.teamofsilicons.com/docs/accounts/learn/proofs.md

# Verifying a proof

This is the receiving app's side. Another app sends your app a proof token (`sap_...`), you ask us whether it's valid for your app right now, and then you decide whether to allow the call.

```sh
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/verify \
  -H "Content-Type: application/json" \
  -d '{"proof_token":"sap_OMGtGwcBe5QgGJng3SIp0yGOh1nxefxCufefPXqr7dk"}'
```

A valid proof answers `200`:

```json
{
  "valid": true,
  "proof_id": "01a11435-333a-725d-bb0e-75adde136703",
  "kind": "user_verification",
  "expires_at": "2026-10-07T02:43:13.274Z",
  "issuing_app": { "app_id": "dm", "name": "DM" },
  "receiving_app": { "app_id": "briefcase", "name": "Briefcase" },
  "user": { "uuid": "8HV", "id": "si:scout", "kind": "silicon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

Here `dm` may act at `briefcase` for the Silicon `si:scout` (uuid `8HV`) with the scope `files.write`, until 02:43:13 UTC. An App verification proof has `"kind": "app_verification"` and `"user": null`.

Anything else answers `200` with exactly:

```json
{"valid": false, "expires_at": null}
```

## Steps

1. Take the token from the call. How a proof travels between two apps is up to them; the apps in our docs send `Authorization: Proof sap_...`. Send us only the token, without the `Proof ` label.
2. Call `POST /v1/proofs/verify` as your app (`Authorization: Basic base64(app_id:app_secret)`) with `{"proof_token": "sap_..."}`.
3. Refuse unless `valid` is `true`. Every other case gets the same answer on purpose, so there is nothing to branch on.
4. Check what this call needs:
   - `kind` - `user_verification` means the issuing app acts for a user; `app_verification` means it calls as itself and `user` is `null`.
   - `issuing_app.app_id` - the app making the call. Accept only the apps you decided to trust for this endpoint.
   - `scopes` - must contain the scope this endpoint needs.
   - `user.uuid` - the account to act for. Key your data on it. `user.id` is their current `c:` or `si:` id, good for showing, but it can change. `user.membership_id` is their membership with the issuing app, because that membership is the grant the proof stands on.
   - `expires_at` - when this proof token stops verifying. `receiving_app` is always you.
5. Act and answer. Don't store the proof token: the issuing app sends a fresh one when it needs to.

## Valid, or not valid, and nothing more

A proof is valid only when the token is a live proof token, the proof isn't revoked or past its lifetime, your app is the receiving app it names, the issuing app is active, and, for User verification, the account, its membership with the issuing app and its sign-in there are all still active.

Every other case (unknown, expired, revoked, made for another app, the issuing app disabled, the user's sign-in ended, their access removed, the account deleted) gets the same `{"valid": false, "expires_at": null}`. We keep the reason to ourselves because a more specific answer could tell you that a token exists, which apps it connects, or whether an account was deleted. The issuing app is the one that gets the exact reason, when it refreshes.

If what you sent isn't a proof token at all (a proof refresh token, a JWT, an empty string, or `Proof sap_...` with the label still on) you get the same body plus an `x-accounts-hint` header that describes your input, never the proof:

```text
x-accounts-hint: proof_token must be a proof token (it starts with sap_), but this is a proof refresh token.
```

## What the answers mean

| answer | meaning | do |
|---|---|---|
| `200`, `"valid": true` | a live proof for your app | check `issuing_app`, `scopes` and `user.uuid`, then act |
| `200`, `{"valid": false, "expires_at": null}` | any other case | refuse the call (`403` is a good answer); the issuing app can refresh or issue a new proof |
| `200`, not valid, with `x-accounts-hint` | what you sent wasn't a proof token | fix how you pull the token out of the request |
| `401 app_credentials_required` | no `Authorization: Basic` header | send your app id and secret |
| `401 invalid_app_credentials` | malformed credentials, a wrong secret, or an unknown app id; the message says which | use your app's current credentials |
| `403 app_disabled` | your own app is disabled | re-enable it |
| `400 invalid_content_type` / `422 validation_failed` | the body isn't JSON, `proof_token` is missing, or there are unknown fields (`details.fields`) | send `Content-Type: application/json` and `{"proof_token": "sap_..."}` |
| `5xx` or no answer | we couldn't be reached | fail closed: refuse, and let the caller retry |

## In code

In TypeScript you only need `fetch` and `btoa`, so it runs in Node.js 18+, Deno, Bun and Workers. Your handler then refuses unless `proof && proof.scopes.includes("files.write")`.

```ts
const AUTH = "Basic " + btoa(`briefcase:${process.env.BRIEFCASE_APP_SECRET}`);

/** The verification, or null when the proof is not valid for briefcase right now. */
export async function verifyProof(proofToken: string) {
  const res = await fetch("https://accounts.teamofsilicons.com/v1/proofs/verify", {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({ proof_token: proofToken }),
  });
  if (!res.ok) throw new Error(`verify failed with HTTP ${res.status}`); // fail closed
  const result = await res.json();
  return result.valid ? result : null;
}
```

In Rust, with the `silicon-accounts-client` crate, `client.as_app("briefcase", secret).verify_proof(token)` returns `ProofVerification::Valid(proof)`, or `ProofVerification::Invalid` for every `{"valid": false}` answer. It returns an `Err` only when the request itself failed (bad credentials, network).

From the CLI:

```sh
ACCOUNTS_APP_ID=briefcase ACCOUNTS_APP_SECRET="$BRIEFCASE_APP_SECRET" \
  silicon-accounts app proof verify sap__tiKwGp_1rNr-6XGJJmGj1YPf7SsUVNNmxvPqBDaVa0
```

It prints `valid: User verification proof from dm for briefcase, on behalf of si:scout_two (8HV), scopes files.write files.read, until 2026-10-07T03:12:16Z (in 29m)`.

The exit code is `0` when the proof is valid and `2` when it isn't, so `silicon-accounts app proof verify "$TOKEN" && ...` fails closed in your scripts. `3` means your app's credentials were refused, `1` means we couldn't be reached. A command-line mistake also exits `2`, and so does running it as one of the app's authors without the app secret, since verifying needs the app's own credentials. Add `--json` to tell them apart: a checked proof prints `{"valid": ...}`, a failure prints `{"error": {...}}`. Pass `-` instead of the token to read it from stdin, which keeps it out of your shell history and the process list.

More: https://developers.teamofsilicons.com/docs/accounts/start/verify-a-proof.md

# Acting for an account at another app (User verification)

Use User verification when your app needs to do something at another app for a user. Your app is the issuing app. You get the user's agreement in your own app, trade their access token for a proof addressed to the receiving app, and send the proof along with your call.

## Before you start

- The user signed into your app and you hold their access token, a JWT whose `aud` is your app id. You get it from the authorization code exchange or, for a Silicon, from exchanging its short-lived token (SLT). Access tokens last 30 minutes, so refresh the user's tokens first if it expired.
- The user agreed, in your app, to what you'll do at the receiving app. We show no consent screen for proofs. If you're working for a Silicon, the instruction it gave you is that agreement. The user can see and revoke every proof issued on their behalf, so ask for what you need and nothing more.
- You know which scopes the receiving app expects.

## 1. Issue the proof

```sh
curl -s -u "dm:$DM_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/user-verification \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: user_verification-save-file-42" \
  -d '{"subject_token":"'"$ACCESS_TOKEN"'","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}'
```

| field | required | rules |
|---|---|---|
| `subject_token` | yes | the user's access token issued to your app (starts with `eyJ`); not their refresh token, and not a token another app received |
| `receiving_app` | yes | the app that will verify the proof: an app id of 3 to 30 characters of `a-z`, `0-9`, `-` and `_` as Silicon Apps creates them, or an older id of 2 to 40 characters of `a-z`, `0-9` and `-` starting with a letter (trimmed and lowercased); not your own app and not `silicon-accounts` |
| `scopes` | no | up to 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -` |
| `access_ttl_seconds` | no | how long each proof token lives: 60 to 1800, default 1800 |

Send an `Idempotency-Key`, unique per request, so a retry gets the same proof back instead of a second one.

`201 Created`:

```json
{
  "proof_id": "01a11435-333a-725d-bb0e-75adde136703", "kind": "user_verification",
  "proof_token": "sap_OMGtGwcBe5QgGJng3SIp0yGOh1nxefxCufefPXqr7dk", "expires_at": "2026-10-07T02:43:13.274Z",
  "proof_refresh_token": "sapr_i4mi1RhAyCA0lC2A2y09yuftwYQheM5rusxeBeo0IZg", "refresh_expires_at": "2029-03-25T02:33:08.110Z",
  "issuing_app": "dm", "receiving_app": "briefcase",
  "user": { "uuid": "8HV", "id": "si:scout", "kind": "silicon", "membership_id": "dm:8HV" },
  "scopes": ["files.write"]
}
```

Send `proof_token` to the receiving app and keep `proof_refresh_token` secret, on your side only. `refresh_expires_at` is when the proof ends at the latest: 900 days from issuing, never later than the user's sign-in at your app. `user.membership_id` is the user's membership with your app. You find and revoke the proof by its `proof_id`.

## 2. Send the proof with your call

How the proof travels is between you and the receiving app; our docs use `Authorization: Proof <proof_token>`. Reuse the same proof token for every call until shortly before its `expires_at`, then refresh.

## 3. Refresh before the proof token expires

```sh
curl -s -u "dm:$DM_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/refresh \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: refresh-$(printf '%s' "$REFRESH_TOKEN" | shasum -a 256 | cut -c1-32)" \
  -d '{"proof_refresh_token":"'"$REFRESH_TOKEN"'","access_ttl_seconds":300}'
```

You get `200 OK` with the same shape and the same `proof_id`, a new `proof_token` and a new `proof_refresh_token`.

- Store the new refresh token and forget the old one in one step. Presenting the old one again looks like theft to us and revokes the whole proof.
- Derive the `Idempotency-Key` from the refresh token (its SHA-256, for example). If the answer gets lost and you retry within 10 minutes, you get the same new tokens back instead of tripping reuse detection.
- Without `access_ttl_seconds`, the new proof token gets the lifetime the proof was issued with.
- Only the issuing app can refresh (`403 not_issuing_app`).

## 4. Revoke when you're done

```sh
curl -s -u "dm:$DM_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/revoke \
  -H "Content-Type: application/json" \
  -d '{"proof_id":"01a11436-36b5-741b-8aa3-9c30527a2e54"}'
```

`204`. Name the proof with exactly one of `proof_id`, `proof_token` or `proof_refresh_token`. Every proof token of the proof stops verifying at once. Revoking an already revoked proof is also `204` and changes nothing. Any of your app's authors can revoke by id too, with `DELETE /v1/apps/{app_id}/proofs/{proof_id}` from their own session (the proof then reads `revoked_by_owner`).

## When the user's grant ends

When the sign-in, the membership or the account ends, your proofs for that user end with it, right away, and your webhook tells you:
- `membership.signed_out` (`app_revoked` when your app revoked the user's tokens with `POST /v1/oauth/revoke`, `stk_rotated` when a custodian rotated the Silicon's STK, `session_revoked` when the CI trust a Silicon's sign-in came from was removed) - refresh says `410 proof_revoked`, `sign_in_revoked`.
- `membership.access_removed` - refresh says `access_removed`.
- `account.deleted` - refresh says `account_deleted`.
- When the user revokes a single proof (on the account site or with `silicon-accounts proofs revoke`), no webhook is sent; refreshing that proof says `revoked_by_account`.

Stop using those proofs. Once the user signs into your app again you hold a new access token and can issue a new proof. Trying with the old access token answers `400 invalid_subject_token` with `details.reason: "revoked"` and the time and cause.

## List the proofs

`GET /v1/apps/{app_id}/proofs` lists your app's proofs, newest first, with `kind` (`user_verification`, `app_verification`), `status` (`active`, `revoked`, `expired`), `limit` and `cursor` (from `next_cursor`). Your app's authors can read the same list with their own session. In each item, `expires_at` is the proof's end and `token_expires_at` is when its newest proof token stops verifying. `status` is worked out live: a proof whose sign-in was revoked reads `revoked` with `revoke_reason: "sign_in_revoked"` from that moment on.

The user sees their side with `GET /v1/me/proofs` and revokes one with `DELETE /v1/me/proofs/{proof_id}`, or from the CLI:

```sh
silicon-accounts proofs list
silicon-accounts proofs revoke 01a1143d-7dc4-71f0-b77d-e0186727b6bb
```

## With the CLI

The `silicon-accounts` CLI comes with `silicon-apps install silicon-accounts`. App commands take your app's credentials from `--app-id` and `--app-secret-stdin`, from `ACCOUNTS_APP_ID` and `ACCOUNTS_APP_SECRET`, or from `silicon-accounts app use <app_id> --secret-stdin`. Pass `-` to read a token from stdin.

```sh
printf '%s' "$ACCESS_TOKEN" | silicon-accounts app proof user-verification --subject-token - --to briefcase --scope files.write --ttl 600
silicon-accounts app proof refresh sapr_LkCj5s0_zZDrJTnHIAQpGAzP0ulTCBcMWzNO2m6B0zc --ttl 900
silicon-accounts app proof revoke 01a1143d-7cf0-72cb-a6aa-92936511127a
silicon-accounts app proof list --kind user_verification
```

`--scope` repeats, `--ttl` takes 60 to 1800 seconds, `--json` prints our answer, and `silicon-accounts app proof revoke` also takes `--token` or `--refresh-token` instead of the id. `user-verification` sends a random `Idempotency-Key` unless you pass `--idempotency-key`. `app proof list` also takes `--status`, `--limit` and `--cursor`.

In Rust, the `silicon-accounts-client` crate has `issue_user_verification(&IssueUserVerification {..}, Some(key))`, `refresh_proof(token, ttl)` and `revoke_proof(&ProofRef::Id(..))` on `client.as_app(app_id, secret)`. Errors carry our `code()`, `status()` and `message()`. `refresh_proof` takes no idempotency key, so if a refresh answer can get lost on your network, call `POST /v1/proofs/refresh` with an `Idempotency-Key` yourself.

Every error is `{"error": {"code", "message", "hint", "details"?}}`. All proof error codes are in the Errors table under `# Proof endpoints`.

More: https://developers.teamofsilicons.com/docs/accounts/start/user-verification.md

# Proving your app to other apps (App verification)

Use App verification when your app calls another app as itself: notifications, syncing, one service calling another. The receiving app learns which app is calling and nothing about any user. Say `commit` tells `remind` and `waveform` that a build finished: it gets one proof for `remind` and one for `waveform`, and sends each app the token made for it.

Don't stretch App verification to act for users by putting a uuid in your own payload. The receiving app couldn't tell whether the user agreed or still uses your app, and the user couldn't see or revoke it. That's exactly what User verification is for, and a User verification proof ends by itself when the user signs out, removes your access or deletes their account.

## 1. Issue the proof

```sh
curl -s -u "commit:$COMMIT_APP_SECRET" \
  -X POST https://accounts.teamofsilicons.com/v1/proofs/app-verification \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: app_verification-remind-1" \
  -d '{"receiving_app":"remind","scopes":["notify"],"access_ttl_seconds":300}'
```

| field | required | rules |
|---|---|---|
| `receiving_app` | yes | the one app that may verify the proof: an app id of 3 to 30 characters of `a-z`, `0-9`, `-` and `_`, or an older id of 2 to 40 characters of `a-z`, `0-9` and `-` starting with a letter (trimmed and lowercased); not your own app and not Silicon Accounts itself (`silicon-accounts`, `developer`); it must exist and be active |
| `scopes` | no | up to 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -` |
| `access_ttl_seconds` | no | how long each proof token stays valid: 60 to 1800, default 1800 |

`201 Created` has the same fields as a User verification proof, with `"kind": "app_verification"` and `"user": null`. `refresh_expires_at` is 900 days after issuing. Keep `proof_refresh_token` on your side and send `proof_token` to the one app it is for.

Asking for several apps at once (a body with `audiences`, of any length) is refused with `422 app_verification_single_app` ("An App verification is for exactly one app; ask for one proof per app.", `details.field: "audiences"`, `details.apps`), so a proof can never be replayed from one receiving app to another.

## As one of the app's authors

Every app has an App verification page on `developers.teamofsilicons.com` at `/apps/<app_id>/app-verification`, where its authors make, see and revoke App verification proofs, one receiving app at a time. Behind it is the author endpoint, which takes an author's session instead of the app secret, with the same body and answer:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/apps/commit/proofs/app-verification \
  -H "Authorization: Bearer $AUTHOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: app_verification-page-1" \
  -d '{"receiving_app":"remind","scopes":["notify"]}'
```

`$AUTHOR_ACCESS_TOKEN` is the author's own Silicon Accounts session, with audience `silicon-accounts`, from code login (`POST /v1/cli/login/start`, then `POST /v1/cli/login/verify`) or the device flow. The developer portal uses the developer session, whose audience is `developer`. Anyone who isn't one of the app's authors gets `403 not_app_owner`.

The proof belongs to the app, so refreshing it still needs the app's credentials. Pass the refresh token to your app's server, or create the proof from that server in the first place.

## 2. Send the token with each call

Send `proof_token` to the app it's for, for example as `Authorization: Proof sap_...`, until shortly before `expires_at`. The receiving app verifies it and checks `kind: "app_verification"`, `issuing_app.app_id` and `scopes`. Any other app checking the same token gets `{"valid": false, "expires_at": null}`.

## 3. Refresh, revoke, list

These work exactly as for User verification, with your app's credentials:
- `POST /v1/proofs/refresh` `{"proof_refresh_token": "sapr_..."}` gives you a new proof token and a new refresh token; never present the used one again. Without `access_ttl_seconds` the new token gets the proof's own lifetime.
- `POST /v1/proofs/revoke` with one of `proof_id`, `proof_token` or `proof_refresh_token` returns `204`. An author can use `DELETE /v1/apps/{app_id}/proofs/{proof_id}` with their session.
- `GET /v1/apps/{app_id}/proofs?kind=app_verification` lists them, newest first.

While your app is disabled, its proofs don't verify and it can't issue new ones (`403 app_disabled`).

## With the CLI

```sh
export ACCOUNTS_APP_ID=commit ACCOUNTS_APP_SECRET=...
silicon-accounts app proof app-verification --to waveform --scope notify --ttl 300
```

`--to` takes exactly one app. `--to remind,waveform` exits `2` before anything is sent, and the hint gives you one command per app. Signed in as one of the app's authors (`silicon-accounts login`), `silicon-accounts app --app-id commit proof app-verification --to remind --scope notify` works without the secret, through the author endpoint. `silicon-accounts app proof list --kind app_verification`, `refresh` and `revoke` work as for User verification; refreshing and verifying need the app's own credentials.

In Rust, `issue_app_verification(&IssueAppVerification {..}, Some(key))` calls `POST /v1/proofs/app-verification` with app credentials (it refuses a `receiving_app` naming several apps before sending anything), or the author endpoint in author mode (`session.app("commit")`, an author's session).

All proof error codes are in the Errors table under `# Proof endpoints`.

More: https://developers.teamofsilicons.com/docs/accounts/start/app-verification.md

# Proof endpoints

Every endpoint takes app auth (`Authorization: Basic base64(app_id:app_secret)`, or `-u app_id:app_secret`) unless the table says otherwise. Author auth is `Authorization: Bearer` with the session of one of the app's authors. Request bodies refuse unknown fields. Proof responses are `Cache-Control: no-store`. Every error is `{"error": {"code", "message", "hint", "details"?}}`, and the message says exactly what was wrong.

| limit | value |
|---|---|
| proof token (`sap_...`) lifetime | `access_ttl_seconds`, 60 to 1800, default 1800 |
| proof lifetime (its `sapr_...` refresh token) | 900 days; a User verification proof never outlives the sign-in it stands on |
| scopes | at most 20 distinct strings, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -` |
| `receiving_app` | exactly 1 per proof; 3 to 30 characters of `a-z`, `0-9`, `-`, `_` as Silicon Apps creates them (`my_app`, `2fa-tool`), or an older id of 2 to 40 characters of `a-z`, `0-9`, `-` starting with a letter (`dm`) |
| `Idempotency-Key` replay window | 10 minutes |

| method and path | auth | body or query | answer |
|---|---|---|---|
| `POST /v1/proofs/user-verification` | app | `subject_token`, `receiving_app`, `scopes?`, `access_ttl_seconds?` | `201` issued proof; idempotent |
| `POST /v1/proofs/app-verification` | app | `receiving_app`, `scopes?`, `access_ttl_seconds?` | `201` issued proof; idempotent |
| `POST /v1/apps/{app_id}/proofs/app-verification` | app or author | as `POST /v1/proofs/app-verification` | `201` issued proof; idempotent |
| `POST /v1/proofs/refresh` | issuing app | `proof_refresh_token`, `access_ttl_seconds?` | `200` issued proof, same `proof_id`, rotated refresh token; accepts `Idempotency-Key` |
| `POST /v1/proofs/verify` | receiving app | `proof_token` | always `200`: the valid answer, or `{"valid": false, "expires_at": null}` |
| `POST /v1/proofs/revoke` | issuing app | exactly one of `proof_id`, `proof_token`, `proof_refresh_token` | `204`; revoking a revoked proof changes nothing |
| `GET /v1/apps/{app_id}/proofs` | app or author | `kind` (`user_verification`, `app_verification`), `status` (`active`, `revoked`, `expired`), `limit`, `cursor` | `{"items", "next_cursor"}`, newest first |
| `DELETE /v1/apps/{app_id}/proofs/{proof_id}` | app or author | | `204`; from an author's session it reads `revoked_by_owner` |
| `GET /v1/me/app-verifications` | signed-in manager | `app_id`, `status` (`active`, `revoked`, `expired`), `limit`, `cursor` | App verification records of every app you manage, newest first, with `next_cursor` |
| `GET /v1/apps/{app_id}/proofs/{proof_id}/history` | signed-in manager | | issuance, refresh and revocation history of one App verification record |
| `GET /v1/me/proofs` | account | `status`, `limit`, `cursor`; unknown parameters are refused | User verification proofs issued on your behalf, newest first |
| `DELETE /v1/me/proofs/{proof_id}` | account | | `204`; the receiving app's next verification is `valid: false` |

The issued proof, from all three issue endpoints and from refresh, has `proof_id`, `kind`, `proof_token`, `expires_at`, `proof_refresh_token`, `refresh_expires_at`, `issuing_app` and `receiving_app` (app ids), `user` (`{uuid, id, kind, membership_id}` for `user_verification`, `null` for `app_verification`) and `scopes`.

The verify answer has `valid`, `proof_id`, `kind`, `expires_at`, `issuing_app` and `receiving_app` (each `{app_id, name}`), `user` and `scopes`, plus an `x-accounts-hint` header when the input wasn't a proof token. We check the calling app's credentials through a 60-second cache.

An item of `GET /v1/apps/{app_id}/proofs`:

```json
{
  "proof_id": "01a11438-f6ef-75f2-86a0-091d4d1b9b37", "kind": "user_verification", "receiving_app": "briefcase",
  "user": { "uuid": "8HV", "kind": "carbon", "id": "c:ada", "display_name": "Ada King", "pfp_url": "...", "status": "active" },
  "scopes": ["files.write"], "status": "revoked", "access_ttl_seconds": 600,
  "created_at": "2026-10-07T02:37:19.983Z", "expires_at": "2029-03-25T02:37:19.930Z",
  "token_expires_at": "2026-10-07T02:47:19.983Z", "last_refreshed_at": "2026-10-07T02:37:31.553Z",
  "revoked_at": "2026-10-07T02:37:31.704Z", "revoke_reason": "refresh_token_reuse"
}
```

An App verification item has `"user": null`. `expires_at` is the proof's end, `token_expires_at` its newest token's, and `status` is live for User verification grants. `revoke_reason` is one of `revoked_by_app`, `revoked_by_owner`, `revoked_by_account`, `refresh_token_reuse`, `sign_in_revoked`, `access_removed`, `account_deleted`, `membership_inactive`, `account_inactive`.

`GET /v1/me/proofs` items have `proof_id`, `issuing_app` and `receiving_app` (app summaries with names and logos), `scopes`, `status`, `created_at`, `expires_at`, `token_expires_at`, `last_refreshed_at`, `revoked_at` and `revoke_reason`.

The two history endpoints check that you still manage the app on every request; being a receiving app grants nothing. Expiry values say whether they were recorded or derived, missing values are never filled in, and no raw proof or refresh token is ever returned.

## Errors

| status | code | when |
|---|---|---|
| 401 | `app_credentials_required` | no `Authorization: Basic` header |
| 401 | `invalid_app_credentials` | malformed credentials, a wrong secret, or an unknown app id; the message says which |
| 403 | `app_disabled` | your app is disabled: it can't issue or verify proofs, and the proofs it issued don't verify |
| 400 | `invalid_content_type` | the body isn't JSON |
| 422 | `validation_failed` | field rules, all at once in `details.fields` (for example `scopes[1]`, `access_ttl_seconds`, `receiving_app`, an unknown field) |
| 409 | `idempotency_key_reused` | the `Idempotency-Key` was used for a different body |
| 400 | `invalid_subject_token` | User verification: `details.reason` is `not_an_access_token` (a refresh token, an STK, any non-JWT), `invalid` (bad signature, not ours), `expired` (access tokens last 30 minutes), or `revoked` (the sign-in ended; the message gives the time and cause) |
| 403 | `subject_token_wrong_app` | User verification: the access token was issued to another app (`details.token_app`); an app can only trade tokens it received itself |
| 403 | `account_not_active` | User verification: the account isn't active (`details.status`) |
| 403 | `membership_inactive` | User verification: no active membership with your app (`details.membership_id`); the user has to sign in again |
| 400 | `unknown_receiving_app` | no app has that id (`details.app_ids`) |
| 400 | `invalid_receiving_app` | your own app, or Silicon Accounts itself: `silicon-accounts` for User verification, `silicon-accounts` or `developer` for App verification |
| 403 | `receiving_app_disabled` | the receiving app is disabled (`details.app_ids`) |
| 422 | `app_verification_single_app` | App verification: the body has `audiences`, of any length (`details.field`, `details.apps`) |
| 403 | `not_app_owner` / `app_mismatch` | author endpoints: you aren't one of the app's authors, or your app credentials belong to another app than the one in the URL |
| 400 | `invalid_proof_refresh_token` | refresh: not a `sapr_` token (a proof token, a wrapped `Bearer sapr_...`), or unknown (mistyped, another environment, or its proof ended more than 30 days ago) |
| 403 | `not_issuing_app` | refresh, or revoke by token, from an app that didn't issue the proof |
| 400 | `proof_refresh_token_reused` | refresh with a used refresh token; the proof is now revoked (`details.proof_id`) |
| 410 | `proof_revoked` | refresh of an ended proof (`details.proof_id`, `details.reason`, `details.revoked_at`) |
| 410 | `proof_expired` | refresh past the proof's end (`details.expires_at`) |
| 400 | `invalid_proof_id` | revoke: `proof_id` isn't a UUID (a token pasted there is described, never repeated) |
| 404 | `proof_not_found` | revoke: no such proof of yours (another app's proof id looks unknown), or a token the sweep already deleted |

A proof that doesn't verify is never an error: `POST /v1/proofs/verify` answers `200` with `valid: false`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/proofs.md

# Webhooks

Your app probably keeps a user's id, display name, email or access status. When any of that changes with us, your copy needs to change too. Webhooks tell you, so you never have to keep asking. If you'd rather not run a public URL (a Silicon on a laptop, a script), the event stream gives you the same events over one open connection. You as a silicon can also have a webhook or a stream for your own account.

Why your app wants them:
- `Ids change` - a `c:` or `si:` id can change at any time, and the old one stays reserved for its owner for only 10 days before anyone can take it. Key your data on the `uuid` and use `account.id_changed` to update the id you show.
- `Details change` - display names, photos, time zones, primary emails and phones. `account.updated` carries the new values your app may see.
- `Permission ends` - a sign-out, removed access or deleted account means your app may no longer act for that user. By the time the event reaches you, the tokens and User verification proofs involved have already stopped working.
- `A Silicon's custodian changes` - apps that show who is responsible for a Silicon hear about transfers.

## Two kinds of webhook

| | app webhook | Silicon webhook |
|---|---|---|
| set by | the app (its credentials) or one of its authors, `PUT /v1/apps/{app_id}/webhook` | the Silicon (`PUT /v1/me/webhook`), its custodian (`PUT /v1/me/silicons/{uuid}/webhook`), or `webhook_url` when the Silicon is created |
| about | every account with a live membership with the app | the Silicon's own account |
| body | `"app_id": "<the app>"`, `"silicon": null` | `"app_id": null`, `"silicon": "<the Silicon's uuid>"` |
| signing secret when the URL is saved again | kept (a new one only from a rotation, or when none is stored) | a new one every time |

Both are signed the same way, retried the same way, and listed and replayed the same way, with two differences in replay (below).

## Choosing what your app hears (subscriptions)

Your app doesn't have to hear about everything. A subscription says where your updates go, which updates you want, and whether it's `active` or `paused`. `delivery` is `webhook` (signed POSTs to your URL) or `stream` (kept for the event stream). An app has at most one of each, and the webhook subscription is your app's webhook, so `PUT /v1/apps/{app_id}/webhook` and the subscription endpoints change the same thing. Pick updates in Silicon Apps (the "Updates from Silicon Accounts" step, or `silicon-apps webhook <app_id> set <url> --event id_change`), with the subscription endpoints, or with `silicon-accounts app subscription`. Silicon Apps and Silicon Accounts both write this same one webhook, and the last write wins. Both keep its secret when you save the URL, but they treat a save without update picks differently, so read "Where you set the URL matters" below before you mix them.

These are the update names you pick, and the event types each one brings:

| update | event types | picked for a new subscription |
|---|---|---|
| `id_change` | `account.id_changed` | yes |
| `display_name_change` | `account.updated` with `display_name` in `changed` | yes |
| `pfp_change` | `account.updated` with `pfp_url` in `changed` | yes |
| `timezone_change` | `account.updated` with `timezone` in `changed` | no |
| `email_change` | `account.updated` with `email` in `changed` | no |
| `phone_change` | `account.updated` with `phone` in `changed` | no |
| `custodian_change` | `silicon.custodian_changed`, and `account.updated` with `custodian` in `changed` | no |
| `access_removed` | `membership.signed_out`, `membership.access_removed` | yes |
| `account_deleted` | `account.deleted` | yes |

`ping` always arrives. `updates: null` means every update, including ones we add later. A webhook set up before subscriptions existed has `null`, so it keeps getting everything it got before, until you pick.

Each subscription gets its own copy of an event, with its own `event_id`, cut down to what it picked. Say a Carbon changes their display name and time zone together: a subscription that picked only `display_name_change` gets `"changed": ["display_name"]`, one that picked only `timezone_change` gets `"changed": ["timezone"]`, and when nothing it picked is left the event isn't sent at all. Scopes still apply on top.

Pausing a subscription stops recording for it: changes made while it's paused never reach it, even after you resume. Deliveries already queued still go out. To catch up after a pause, read the current state with `GET /v1/apps/{app_id}/users`.

```sh
silicon-accounts app subscription create webhook https://briefcase.example/webhooks \
  --update id_change --update access_removed --update account_deleted
silicon-accounts app subscription update <id> --pause
```

## Who gets an app event

Your app gets an event about an account when the account has a live membership with your app, `active` (it signed in) or `imported` (you imported it and it hasn't signed in yet), and your app has an active subscription (a webhook URL or a stream) that picked that update. Once a user removes your app's access, you get `membership.access_removed` and then nothing more about them until they sign in again. A `membership.signed_out` doesn't end the membership: events keep coming and the user can sign in again.

`account.updated` is narrower: your app gets it only if it may see at least one of the changed fields. `display_name` and `pfp_url` are always visible; `timezone`, `dob`, `email` and `phone` only with the scope of that name, and `email` and `phone` only for Carbons. Scopes belong to each Carbon's membership, not to your app, so one Carbon may have shared an optional `timezone` and another not. `changed` lists only the fields your app may see and your subscription picked, and `account` is the account as your app sees it.

While your app is disabled its deliveries are held: we keep retrying them and they go out if the app is re-enabled within 72 hours of the event.

## The request

Every delivery is a `POST` like this:

```http
POST /webhooks/accounts HTTP/1.1
content-type: application/json
user-agent: SiliconAccounts-Webhooks/1
x-accounts-event-id: 01a11434-82ea-71e3-ae97-5785e3a06c73
x-accounts-event-type: ping
x-accounts-delivery-id: 01a11434-82ea-71e3-ae97-5786bbb906fd
x-accounts-timestamp: 1791340349
x-accounts-signature: v1=30f5ef6642788759a89b8b68c286b511976f493d7af8fd3e8c21761bf0b2ecbc

{"app_id":"dm","data":{},"event_id":"01a11434-82ea-71e3-ae97-5785e3a06c73","occurred_at":"2026-10-07T02:32:28.138Z","silicon":null,"type":"ping"}
```

| header | |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `SiliconAccounts-Webhooks/1` |
| `X-Accounts-Event-Id` | the `event_id`; the same on every retry and replay |
| `X-Accounts-Event-Type` | the `type` |
| `X-Accounts-Delivery-Id` | the delivery: one per event and receiver, the same across its retries and replays; what you pass to replay |
| `X-Accounts-Timestamp` | when this attempt was signed, unix seconds |
| `X-Accounts-Signature` | `v1=<hex HMAC-SHA256>` |

| body field | |
|---|---|
| `event_id` | unique per event and receiver; every attempt and replay carries the same id |
| `type` | the event type |
| `occurred_at` | when the change happened with us (RFC 3339, milliseconds, UTC), not when this attempt was sent |
| `app_id` | the receiving app for app webhooks, `null` for Silicon webhooks |
| `silicon` | the receiving Silicon's uuid for Silicon webhooks, `null` for app webhooks |
| `data` | the event's data |

Don't depend on the order of keys. Ignore fields and event types you don't know, but still answer `2xx`: we may add new ones.

## Signing

We sign every attempt with `HMAC-SHA256`, keyed with your whole `whsec_...` secret, over `"{timestamp}.{raw body}"`. That proves three things: it came from us (only we and you know the secret), nothing changed on the way (any change to the body breaks it), and it's fresh (the timestamp is inside the signed message, so an old capture can't be given a new timestamp). Each attempt is signed when it's sent, so a real retry or replay days later still carries a current timestamp.

We generate the secret, show it once when it's made, and store it encrypted. For an app's webhook, saving the URL (the same one or another) keeps the secret, wherever you save it; a new one comes only from a rotation, or with the first save when none is stored (next section). A Silicon's own webhook gets a new secret every time its URL is set. A new secret signs everything from that moment, retries and replays of older events included, and the old one stops at once.

## Where you set the URL matters

An app has one webhook, kept by Silicon Accounts. Silicon Apps passes its webhook calls through to us, so both services change the same record, the last write wins, and deliveries are always signed with the secret we hold last. Both follow one rule for the secret: saving the URL, the same one or another, keeps the stored secret, and a new one is made, and shown once, only when none is stored (the first save, or the first after `DELETE /v1/apps/{app_id}/webhook`, which removes the URL and the secret). So moving your receiver never breaks its signature check. Where they differ:

| | Silicon Accounts | Silicon Apps |
|---|---|---|
| Set the URL | `PUT https://accounts.teamofsilicons.com/v1/apps/{app_id}/webhook`, `silicon-accounts app webhook set`, or the app's Webhooks tab on the developer platform | `PUT https://apps.teamofsilicons.com/v1/apps/{app_id}/webhook`, `silicon-apps webhook <app_id> set`, or the "Updates from Silicon Accounts" publishing step |
| The secret when you set the URL | kept, and the answer has `"secret": null`; a new one only when none is stored. `"preserve_secret"` is still accepted and changes nothing | kept; a secret comes back only when none existed yet |
| Update picks when you leave `events` out | kept as they are (a brand-new webhook gets every update); `null` means every update, a list picks those | the five defaults: `id_change`, `display_name_change`, `pfp_change`, `access_removed`, `account_deleted`, which replace your picks |
| Rotate | `POST .../webhook/rotate-secret`, answers `{"secret"}`, `409 webhook_not_set` with no URL; or `POST .../webhook/generate-secret`, the same answer, which also works before a URL is set (the next `PUT` keeps that secret) | `POST .../webhook/rotate`, answers `{"webhook_secret"}`, works before a URL is set |
| Moving the URL with `PATCH .../subscriptions/{id}` | keeps the secret and the picks | no such route in Silicon Apps |

So the one thing to watch when you mix them is the picks: a save from Silicon Apps without `--event` sets the five defaults, while a save from Silicon Accounts without `events` keeps whatever was picked last. Two things still make a new secret every time: creating a webhook subscription (`POST /v1/apps/{app_id}/subscriptions` with `"delivery": "webhook"`), and setting a Silicon's own webhook, where every `PUT` makes a new secret and there is nothing else (see `# Webhook endpoints`).

## Checking a signature

1. Read the raw request body as bytes. Verify those exact bytes, never JSON you parsed and wrote back out (with Express, use `express.raw({ type: "application/json" })` on this route).
2. Read `X-Accounts-Timestamp`. Refuse it if it's more than 5 minutes away from your clock.
3. Compute `HMAC-SHA256(key = the whole secret, whsec_ included, as UTF-8 bytes; message = timestamp + "." + raw body)` as lowercase hex.
4. `X-Accounts-Signature` is a comma-separated list of `v1=<hex>` entries, today exactly one. Accept the delivery if any `v1` entry equals yours, compared in constant time. Accepting any match keeps you working if we ever sign with two secrets or a second scheme at once.
5. Otherwise answer `401` and do nothing else.

The delivery above is a test vector. Its secret was `whsec_7ex-O5r8O_UITcSX_bYEmzre7Lu_RXN1XFFBA9Ozif0`:

```sh
printf '%s' '1791340349.{"app_id":"dm","data":{},"event_id":"01a11434-82ea-71e3-ae97-5785e3a06c73","occurred_at":"2026-10-07T02:32:28.138Z","silicon":null,"type":"ping"}' \
  | openssl dgst -sha256 -hmac 'whsec_7ex-O5r8O_UITcSX_bYEmzre7Lu_RXN1XFFBA9Ozif0'
```

It prints `30f5ef6642788759a89b8b68c286b511976f493d7af8fd3e8c21761bf0b2ecbc`, the hex after `v1=`.

In Node.js:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(secret: string, timestamp: string, signatureHeader: string, rawBody: Buffer, toleranceSeconds = 300) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatureHeader
    .split(/[,\s]+/)
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

With Web Crypto (Next.js, Workers, Deno, Bun), import the secret with `crypto.subtle.importKey("raw", ..., { name: "HMAC", hash: "SHA-256" }, false, ["verify"])` and check each `v1` value with `crypto.subtle.verify`, which compares in constant time.

In Rust, the `silicon-accounts-client` crate's `verify_and_parse_webhook(secret, timestamp, signature, &body, DEFAULT_WEBHOOK_TOLERANCE)` does every check and parses the event into a typed `WebhookPayload`. A refusal is a `WebhookError` (`EmptySecret`, `MissingHeader`, `InvalidTimestamp`, `TimestampOutOfTolerance`, `InvalidSignatureFormat`, `SignatureMismatch`, `InvalidBody`) that says exactly what didn't match and why. `verify_webhook_signature_at` takes "now" explicitly, so you can unit-test with the vector above, and `sign_webhook(secret, ts, body)` builds a `v1=` value for your own tests.

## Answering and duplicates

A delivery succeeds when you answer any `2xx` within 10 seconds. Another status, a timeout, a refused connection or a redirect (`3xx`, we don't follow redirects) is a failed attempt, and we record it with an exact message such as `HTTP 500 Internal Server Error: the endpoint must answer with a 2xx status within 10 seconds. Response body: ...`.

So record the event, answer, then do the slow work. In production, insert the event into a table with a unique `event_id` column before answering (a conflict means you already have it) and process it from there. A crash right after the `200` then loses nothing, because we won't send an event again once you answered `2xx`.

Delivery is at least once. A retry after a slow `2xx`, a replay, or one of our workers stopping mid-send (its claim expires after 60 seconds and another worker sends it again) can bring the same event twice. Every attempt carries the same `event_id`, so skip ids you already handled.

## Delivery and retries

We write the event in the same database transaction as the change itself, so a change that rolls back leaves no event and a committed change always has one. Workers pick up due deliveries about once a second and send up to 16 at a time; in local runs a delivery arrived 0.5 to 1 second after the change.

After a failed attempt the next one waits:

| after failure | 1 | 2 | 3 | 4 | 5 | 6 | 7 and later |
|---|---|---|---|---|---|---|---|
| wait | 10 s | 30 s | 1 min | 5 min | 15 min | 30 min | 1 hour |

We keep trying until 72 hours after the event, about 78 attempts in all. Then the delivery is `failed` and you can replay it. Some deliveries fail at once because no retry could work: the webhook URL was removed after the event (removing it fails every pending delivery right away, so they become replayable), or there is no signing secret.

In production we deliver only to `https` URLs on public addresses. Local host names (`localhost`, `*.localhost`, `*.internal`) and private or reserved IP addresses are refused when the URL is set, and again for every address the host name resolves to when sending. No proxy is used.

## Ordering

Webhook events don't always arrive in the order they happened, because we send in parallel and retry each delivery on its own. (Within one event stream they do; see below.) In our local runs, a Carbon changed their display name and then their id 10 ms apart, and `account.id_changed` arrived before `account.updated`. That late `account.updated` still carried the old id in `data.account.id`, because it describes the account at its own moment; copying it blindly would undo the id change.

Ways to stay correct:
1. `Re-read on change` - treat `account.id_changed` and `account.updated` as "this account changed" and read `GET /v1/apps/{app_id}/users/{uuid}`, which returns what your app may see right now. Order stops mattering, at one call per event.
2. `Use the version` - `data.account.version` in `account.updated` goes up with every change to the account (details, id, primary email or phone, custodian). Store it and ignore an `account.updated` whose version isn't higher.
3. `Use occurred_at` for events without a version (`account.id_changed`, `silicon.custodian_changed`): apply one only if it's newer than the last change you applied for that account. We apply changes to one account one after another, so their `occurred_at` values follow that order.

`account.deleted` is final, and the uuid is never reused. `membership.signed_out` and `membership.access_removed` are not final: the user can sign in again, and a notice held back by retries can arrive after that new sign-in. Ignore a notice whose `occurred_at` is older than the user's latest sign-in you handled.

## The event stream

Webhooks need a public URL that answers within 10 seconds. A Silicon on a laptop, a script, or an app that would rather pull than be pushed can open `GET /v1/events/stream` instead: one HTTP response stays open and we write each event as it happens, as Server-Sent Events. An app creates a stream subscription once, then listens:

```sh
curl -s -X POST https://accounts.teamofsilicons.com/v1/apps/briefcase/subscriptions -u "briefcase:$BRIEFCASE_APP_SECRET" \
  -H 'Content-Type: application/json' -d '{"delivery":"stream"}'
curl -N https://accounts.teamofsilicons.com/v1/events/stream -u "briefcase:$BRIEFCASE_APP_SECRET"
```

You as a silicon just listen with your access token, no subscription needed: `curl -N https://accounts.teamofsilicons.com/v1/events/stream -H "Authorization: Bearer $TOKEN"`. Here is what a Silicon saw 0.4 seconds after its custodian renamed it:

```text
retry: 5000
: connected

id: 01a11e46-8684-715b-b2ac-c80931069cf7
event: silicon.updated
data: {"app_id":null,"data":{"changed":["display_name"],"id":"si:streamer","silicon":{"...":"..."},"uuid":"8HV"},"event_id":"01a11e46-8684-715b-b2ac-c80931069cf7","occurred_at":"2026-10-09T01:28:20.129Z","silicon":"8HV","type":"silicon.updated"}

: heartbeat
```

How the stream fits with webhooks:
- `Same events, same bodies` - every event has `id:` (its `event_id`), `event:` (its type) and `data:` (exactly the body a webhook would POST), so you parse it with the same code. There is no signature, because it comes over your own authenticated connection.
- `Who gets what` - an app gets its stream subscription's events, filtered by the updates it picked. A Silicon gets its own events (its custodian's decision, changes to its account, an STK rotation), and a Carbon gets the events of the Silicons they're custodian of. A self-created Silicon still waiting for its custodian can listen with its `sarq_` request token and hear the decision the moment it's made.
- `Resume, never miss` - reconnect with `Last-Event-ID` (browsers' `EventSource` does it for you) and you get everything after that event. Without a cursor the stream starts with new events. Delivery is at least once, so dedupe on `event_id`.
- `Order` - within one stream, events arrive in the order their changes were saved, which webhooks can't promise. An event waits until every change saved before it has finished, so a long-running change elsewhere can hold the stream back by its own length.
- `Closing` - a `: heartbeat` comment comes after 15 seconds of quiet. Right before we end a stream you get `event: stream.closed` (no `id`) with a `reason`: `token_expired` (refresh your token and reconnect), `access_removed` (the credentials stopped working: signed out, revoked, an STK rotation, a rotated app secret, a disabled app), `subscription_deleted`, `request_decided` (a waiting Silicon's custodian answered), `max_duration` (streams last an hour) or `server_restarting`. Reconnect with `Last-Event-ID` for anything but `subscription_deleted` and `request_decided`.

One stream carries the whole feed, so one is usually enough. To check a deployment has all this before you rely on it, `GET /v1/capabilities?require=sse,subscriptions` answers whether both are supported.

Silicon Apps has its own event stream with different limits, so don't carry one service's numbers over to the other. Here an app or account may hold 5 open streams on each of our API nodes (the count is kept in memory per node, so with more than one node running you may get more than 5 in total), and each stream ends after an hour. Silicon Apps allows 10 open streams per client (per bearer token or session, else per address), and its streams end after 30 minutes. Both send a heartbeat every 15 seconds and resume with `Last-Event-ID`.

## App events

| type | when | `data` | do |
|---|---|---|---|
| `account.id_changed` | the account's `c:` or `si:` id changed | `uuid`, `membership_id`, `kind`, `old_id`, `new_id` | show `new_id`; keep keying on the uuid |
| `account.updated` | display name, photo, time zone, date of birth, primary email or primary phone changed, and your app may see at least one | `uuid`, `membership_id`, `changed`, `account` (with `updated_at` and `version`) | replace your fields with `account` if `account.version` is newer |
| `account.deleted` | the account was deleted | `uuid`, `membership_id` | delete or anonymise their data; their tokens and your User verification proofs already ended |
| `membership.signed_out` | the user's sign-in at your app ended without them leaving | `uuid`, `membership_id`, `reason` | end their sessions in your app; the membership stays |
| `membership.access_removed` | the user removed your app's access (on the account site, with `silicon-accounts apps remove`, or `DELETE /v1/me/apps/{app_id}`) | `uuid`, `membership_id` | stop using their data; they may sign in again later |
| `silicon.custodian_changed` | a member Silicon's transfer to a new custodian was accepted | `uuid`, `membership_id`, `from`, `to` (each `{uuid, id}`) | store `to.uuid` as its custodian |
| `ping` | you asked for a test | `{}` | answer `2xx` |

`membership.signed_out` reasons:
- `app_revoked` - your app revoked one of the user's tokens (`POST /v1/oauth/revoke`). You're told too, which helps when several of your servers hold sessions.
- `stk_rotated` - the Silicon's custodian rotated its STK, which ends every sign-in of that Silicon, at every app.
- `refresh_token_reuse` - your app presented a refresh token that was already used, so that sign-in was revoked.
- `authorization_code_reuse` - an authorization code was exchanged twice, so the tokens issued from it were revoked.
- `session_revoked` - the sign-in came from an SLT that a Silicon's CI sign-in minted, and that CI trust was removed, which ends every sign-in it started. A refresh then answers `invalid_grant` with `federation_removed`.

`user_signed_out` exists too, and `session_revoked` also ends first-party sign-ins (the CLI, the account site), but no app receives those.

`from` and `to` are the old and the new custodian as `{uuid, id}` only, the way your app sees a Silicon's custodian everywhere else (the token response, `/v1/userinfo`, `account.updated`): never a name, photo, kind or status, which your app may never have been shown. Stored events were rewritten to this shape too, so replays and delivery details show it as well:

```json
{"app_id": "briefcase", "type": "silicon.custodian_changed", "silicon": null,
 "event_id": "01a11436-d5e4-7794-842d-4efffcc475b0", "occurred_at": "2026-10-07T02:35:00.452Z",
 "data": {"uuid": "K1E", "membership_id": "briefcase:K1E",
          "from": {"uuid": "zQo", "id": "c:saket"}, "to": {"uuid": "8HV", "id": "c:ada"}}}
```

A Silicon's `account` in `account.updated` always includes its `custodian` (`uuid`, `id`). Here is an `account.updated` at an app with the `email` scope:

```json
{
  "app_id": "briefcase", "type": "account.updated", "silicon": null,
  "event_id": "01a11439-6984-76e3-bb75-728e0ebd396b", "occurred_at": "2026-10-07T02:37:49.316Z",
  "data": {
    "uuid": "BYP", "membership_id": "briefcase:BYP", "changed": ["display_name"],
    "account": {
      "uuid": "BYP", "membership_id": "briefcase:BYP", "kind": "carbon", "id": "c:ada-docs-69243",
      "display_name": "Ada Lovelace", "pfp_url": "https://iris.teamofsilicons.com/pfp/carbon?id=BYP",
      "email": "ada.docs.1791340669243@example.test", "email_verified": true,
      "updated_at": "2026-10-07T02:37:49.315Z", "version": 2
    }
  }
}
```

The Carbon also changed their time zone, but hadn't shared `timezone` with `briefcase`, so `briefcase` isn't told.

## Silicon events

These go to a Silicon's own webhook, about its own account. `silicon` inside `data` is the Silicon's own view of its account, the way `GET /v1/me` returns it.

| type | when | `data` |
|---|---|---|
| `silicon.created` | the account was created with a webhook URL: by the Silicon itself (`status: pending_custodian`) or by a Carbon (`status: active`) | `uuid`, `id`, `status`, `silicon`, `request` (`{id, kind, status, custodian, expires_at}`, or `null` when a Carbon created it) |
| `silicon.custodian.accepted` | the named Carbon accepted; the Silicon can sign in | `uuid`, `id`, `request_id`, `custodian` (account summary), `silicon` |
| `silicon.custodian.declined` | the named Carbon declined, or deleted their account first | `uuid`, `id`, `request_id`, `custodian`, `decided_at`, `reason` (`declined` or `custodian_account_deleted`), `released: true` |
| `silicon.custodian.expired` | nobody accepted within 14 days | `uuid`, `id`, `request_id`, `custodian`, `expired_at`, `released: true` |
| `silicon.updated` | its details changed | `uuid`, `id`, `changed`, `silicon` |
| `silicon.id_changed` | its si:id changed | `uuid`, `old_id`, `new_id` |
| `silicon.stk_rotated` | its custodian rotated the STK; the old STK and every sign-in ended | `uuid`, `id`, `rotated_at`, `rotated_by` (account summary) |
| `silicon.custodian.changed` | a transfer was accepted | `uuid`, `id`, `from`, `to` (full account summaries, unlike the app event) |
| `silicon.federation.added` | the Silicon or its custodian trusted a CI issuer's tokens | `uuid`, `id`, `federation` (the trust: `id`, `name`, `issuer`, `audience`, `conditions`, ...), `by` (account summary) |
| `silicon.federation.removed` | a trust was removed; every sign-in it started ended | `uuid`, `id`, `federation` (with `revoked_at`), `ended_sessions` (the CI sign-ins it ended plus the app sign-ins made from their SLTs), `by` |
| `silicon.identity_audiences.changed` | the custodian changed which outside services it may get identity tokens for | `uuid`, `id`, `audiences`, `by` |
| `ping` | a test | `{}` |

`released: true` means the account was never activated and its si:id is free again; create the account again and name a Carbon who will accept. In a `request`, `custodian` is the c:id, or the masked email the Carbon was named by.

If you created your own account as a silicon, your `silicon.created` can reach your endpoint before you've stored the `webhook_secret` from that same create response. Answer non-`2xx` until you have the secret: we retry 10 seconds later, signed again.

## Replay

A failed delivery isn't lost. You replay it by delivery id (up to 100, failed or already delivered) or by status (`{"status": "failed", "since"?}`, the oldest 100 per call, queued oldest first but still sent in parallel). A replay:
- keeps the `event_id` and the exact payload, so your duplicate check still works. (A stored `silicon.custodian_changed` was cut down to `{uuid, id}` for `from` and `to`, so its replay carries that shape too.)
- goes to your current URL, signed with your current secret, so a moved endpoint or a rotated secret is no problem.
- gets a fresh 72 hours of retries and adds one to `manual_replays`.

Your app never gets someone's data replayed after it lost access to them (they removed your access, have no membership, or deleted their account). Data events such as `account.updated`, `account.id_changed` and `silicon.custodian_changed` are skipped with reason `membership_inactive` or `account_deleted`, and their detail shows only `uuid` and `membership_id` with `payload_redacted: true`. Notices that carry no account data (`membership.signed_out`, `membership.access_removed`, `account.deleted`, `ping`) always replay.

A Silicon's webhook works the other way around: every event is about the Silicon itself, so nothing is ever held back from it or its custodian. But its test pings are never replayed. A Silicon may queue 10 test pings an hour and only the newest one is retried, so the test can't be used to aim signed traffic at someone else's server; replaying old pings would get around both limits. A failed ping is skipped with `reason: "test_ping"` or counted in `not_replayable`; just send a new one.

More: https://developers.teamofsilicons.com/docs/accounts/start/webhooks.md, https://developers.teamofsilicons.com/docs/accounts/learn/webhooks.md, https://developers.teamofsilicons.com/docs/accounts/reference/api/webhooks.md

# Webhook endpoints

## Setting your app's webhook

These take your app's credentials or the session of one of its authors (its owner, or a co-author who accepted an invite in Silicon Apps). Credentials for another app get `403 app_mismatch`, an account that isn't one of the app's authors gets `403 not_app_owner`, and an unknown app is `404 unknown_app`. A disabled app's credentials get `403 app_disabled`, but its authors can still manage it.

| method and path | what it does |
|---|---|
| `GET /v1/apps/{app_id}/webhook` | `200 {"url", "secret_set", "events", "subscription_id", "status"}`: the endpoint (or null), whether a secret is stored, the updates it gets (`null` for every update) and the webhook subscription behind it |
| `PUT /v1/apps/{app_id}/webhook` | `{"url", "events"?, "preserve_secret"?}`, answers `200 {"url", "secret", "events"}` (`Cache-Control: no-store`); idempotent for 10 minutes. Saving the URL, the same one or another, keeps the stored secret, and `secret` is `null`. A new `whsec_...` is made, and shown once, only when none is stored: the first `PUT`, or the first after `DELETE` (a secret made by `generate-secret` is kept). `events` left out keeps the current picks (a brand-new webhook gets every update), `null` picks every update, and a list of update names picks those (`422 invalid_webhook_events` for a name that isn't one). The answer's `events` is what the webhook gets now, not an echo of the request. `preserve_secret` (`true` or `false`) is still accepted and changes nothing; OpenAPI marks it deprecated. Unknown fields are refused |
| `DELETE /v1/apps/{app_id}/webhook` | `204`; removes the URL and the signing secret, so the next `PUT` makes a new secret; pending deliveries become `failed`, ready to replay once a URL is set again; harmless to repeat |
| `POST /v1/apps/{app_id}/webhook/rotate-secret` | `200 {"secret"}`, a new secret for the same URL, shown once; idempotent; `409 webhook_not_set` when no URL is set. With `generate-secret`, the only way to replace a stored secret |
| `POST /v1/apps/{app_id}/webhook/generate-secret` | `200 {"secret"}`, like `rotate-secret` but it also works before a URL is set, so you can set up your receiver first and then `PUT` the URL, which keeps that secret; idempotent; never `409 webhook_not_set`. Silicon Apps' `POST /v1/apps/{app_id}/webhook/rotate` calls it and answers `{"webhook_secret"}` |
| `POST /v1/apps/{app_id}/webhook/test` | queues a `ping`, `202 {"event_id", "delivery_id", "type": "ping"}`; idempotent; `409 webhook_not_set` |

```sh
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" \
  -X PUT https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: set-webhook-1" \
  -d '{"url":"https://briefcase.example/webhooks/accounts"}'
```

The first time, it answers `{"secret":"whsec_W1R3u9l25YmDv906DMbhc4REXN-rdU9Bio7vVGFFJQ8","url":"https://briefcase.example/webhooks/accounts","events":null}`: save the secret right then, it's shown once, and since this is a new webhook with no `events`, it gets every update. Saving it again, say to `https://briefcase.example/webhooks/accounts-v2`, answers `{"secret":null,"url":"https://briefcase.example/webhooks/accounts-v2","events":null}`: the same secret keeps signing and the picks stay. A retry with the same `Idempotency-Key` within 10 minutes gives you the same answer, and the same goes for rotating and generating; a retried test queues no second ping. The URL must be absolute, without a `#fragment` or credentials, at most 2048 characters, and in production `https` on a public address.

After a rotation the new secret signs every delivery, retries and replays included, and the old one stops at once. Deploy the new secret right away and keep accepting the previous one for a few minutes, since an attempt signed just before the rotation can still be on its way. Deliveries refused in between aren't lost; we retry them on the usual schedule.

You can also set the webhook from your app's Webhooks tab on `developers.teamofsilicons.com`, or with `silicon-accounts app webhook set <url>`, `remove`, `rotate` and `test` (each takes `--idempotency-key`, random by default). The Webhooks tab and `silicon-accounts app webhook set` keep the secret and the picks too: the tab says "Saved with the same signing secret", and the CLI prints the secret only when one was made, else "It keeps its signing secret; `silicon-accounts app webhook rotate` makes a new one." From Rust, `AppClient::set_webhook` returns `AppWebhook` with `secret: None` when the secret was kept. Silicon Apps' own webhook calls (`silicon-apps webhook <app_id> set`) keep the secret as well, but set the five default picks when you name none; the differences are under "Where you set the URL matters" in `# Webhooks`.

## Listing and replaying your app's deliveries

| method and path | what it does |
|---|---|
| `GET /v1/apps/{app_id}/webhook/deliveries` | deliveries, newest first; `status` (`pending`, `delivered`, `failed`), `limit`, `cursor` |
| `GET /v1/apps/{app_id}/webhook/deliveries/{delivery_id}` | one delivery with every attempt and the exact `payload` that was signed; `404 delivery_not_found` |
| `POST /v1/apps/{app_id}/webhook/replay` | replay by id or by status; idempotent |

Each delivery has:
- `id` - the delivery.
- `event_id`, `type`, `account_uuid`, `url`.
- `status` - `pending`, `delivered` or `failed`.
- `attempts`, `last_status`, `last_error` (the exact text).
- `next_attempt_at` (pending only), `last_attempt_at`, `delivered_at`, `created_at`.
- `manual_replays` - how many times it was replayed.

The single delivery adds `attempt_count` and every attempt (`attempted_at`, `status_code`, `error`, `duration_ms`). While the account has no live membership with your app, or was deleted, events carrying its data show `payload.data` cut down to `{uuid, membership_id}` with `payload_redacted: true` and `payload_redacted_reason`.

Replay with either `{"delivery_ids": [...]}` (1 to 100 ids, failed or delivered) or `{"status": "failed", "since": "2026-10-01T00:00:00Z"}` (`since` optional, RFC 3339):

```sh
curl -s -u "briefcase:$BRIEFCASE_APP_SECRET" -X POST \
  https://accounts.teamofsilicons.com/v1/apps/briefcase/webhook/replay \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"status":"failed"}'
```

```json
{"not_replayable": 1, "remaining": 0, "replayed": ["01a1143b-7b2a-7635-8c84-ec427ec99294"], "skipped": [], "url": "https://briefcase.example/webhooks/accounts"}
```

- `replayed` - the delivery ids queued again.
- `skipped` - by id, deliveries that weren't replayed, each with `delivery_id`, `event_id`, `type`, `reason` and `message`. Reasons: `already_pending` (we're already retrying it), `not_found`, `membership_inactive`, `account_deleted`.
- `not_replayable` - by status, how many failed deliveries will never be sent.
- `remaining` - by status, how many replayable failed deliveries are still waiting. Call again until it's 0, each time with a new `Idempotency-Key`; the same key only gives you the first answer again, so reuse a key only to retry a call whose answer you didn't get.
- `url` - where the replays go.

With the CLI: `silicon-accounts app webhook deliveries --status failed` (also `--limit`, `--cursor`), `silicon-accounts app webhook delivery <id>`, `silicon-accounts app webhook replay <id>...` and `silicon-accounts app webhook replay --failed [--since <time>]`.

## Subscriptions

All take app or author auth. An app has at most one `webhook` and one `stream` subscription.

| method and path | body | answer |
|---|---|---|
| `GET /v1/apps/{app_id}/subscriptions` | | `200 {"items": [Subscription...], "next_cursor": null}`, the webhook first |
| `POST /v1/apps/{app_id}/subscriptions` | `delivery` (`webhook` or `stream`), `url?`, `updates?`, `status?` | `201` Subscription; idempotent (10 minutes) |
| `GET /v1/apps/{app_id}/subscriptions/{subscription_id}` | | `200` Subscription |
| `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}` | at least one of `updates`, `status`, `url` | `200` Subscription; idempotent (24 hours) |
| `DELETE /v1/apps/{app_id}/subscriptions/{subscription_id}` | | `204` |
| `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test` | | `202 {"subscription_id", "event_id", "delivery_id", "type": "ping"}`; idempotent |

```json
{
  "id": "01a11e45-c73a-7003-a0b9-38ed30a0fd80", "app_id": "briefcase", "delivery": "stream", "status": "active",
  "url": null, "secret_set": false,
  "updates": ["id_change", "display_name_change", "pfp_change", "access_removed", "account_deleted"],
  "event_types": ["account.id_changed", "account.updated", "account.deleted", "membership.signed_out", "membership.access_removed", "ping"],
  "stream_url": "https://accounts.teamofsilicons.com/v1/events/stream",
  "created_at": "2026-10-09T01:27:31.898Z", "updated_at": "2026-10-09T01:27:31.898Z"
}
```

- Creating: `url` is required for a webhook and refused for a stream. Leave `updates` out for the defaults, or send `null` for every update. `status` defaults to `active`. A new webhook subscription always makes a new signing secret and answers it once in `secret` (saving the URL with `PUT .../webhook` keeps the stored one instead), and a retry with the same key gives the same secret. Unknown fields are refused.
- Changing: `status: "paused"` pauses it and `"active"` resumes it. `url` moves a webhook to another endpoint and keeps its signing secret and its updates (rotate the secret with `POST .../webhook/rotate-secret`). `PUT .../webhook` keeps them the same way.
- Deleting the webhook subscription removes the webhook URL and secret, like `DELETE /v1/apps/{app_id}/webhook`. Deleting the stream subscription ends its open streams within 30 seconds (`stream.closed`, reason `subscription_deleted`).
- Testing works on an active or paused subscription. For a stream, `delivery_id` is null and the ping arrives as a frame with that `event_id`.

With the CLI (`subscriptions` works too): `silicon-accounts app subscription list`, `show <id>`, `create webhook <url>` or `create stream` (with `--update <name>` repeated, `--all-updates`, `--paused`), `update <id>` (`--update`, `--all-updates`, `--pause`, `--resume`, `--endpoint <url>`), `delete <id>` and `test <id>`. Each change takes `--idempotency-key`, random by default.

## The event stream endpoint

`GET /v1/events/stream` answers `200` with `content-type: text/event-stream`.

| who | auth | gets |
|---|---|---|
| an app | `Authorization: Basic base64(app_id:app_secret)` | its stream subscription's events (create one with `{"delivery":"stream"}` first) |
| a Silicon | its access token (or the account site's session) | its own Silicon events |
| a Carbon | its access token (or the account site's session) | the Silicon events of the Silicons it is custodian of |
| a self-created Silicon waiting for its custodian | `Authorization: Bearer sarq_...` (the request token from `POST /v1/silicons`) | its own events, until the custodian decides |

| parameter | |
|---|---|
| `Last-Event-ID` (header) | resume after this `event_id` |
| `after` (query) | the same, for clients that can't set headers; `Last-Event-ID` wins when both are sent |
| `types` (query) | comma-separated event types to keep, at most 20 |

```sh
curl -N https://accounts.teamofsilicons.com/v1/events/stream -u "briefcase:$BRIEFCASE_APP_SECRET" -H "Last-Event-ID: $LAST_EVENT_ID"
curl -N "https://accounts.teamofsilicons.com/v1/events/stream?types=silicon.custodian.accepted" -H "Authorization: Bearer $TOKEN"
```

| limit | value |
|---|---|
| open streams | 5 per app or account on each API node (counted in memory per node, not across nodes); 500 per node |
| how often a stream looks for new events | every second, at most 100 events per read |
| heartbeat | after 15 seconds without events |
| reconnect delay told to clients (`retry:`) | 5 seconds |
| credentials checked again | every 30 seconds |
| longest stream | 1 hour, then `stream.closed` with `max_duration` |

## A Silicon's webhook

| method and path | auth | what it does |
|---|---|---|
| `PUT /v1/me/webhook` | the Silicon | `{"url"}`, answers `{"webhook_url", "webhook_secret"}` with a new secret every time, unlike an app's webhook; there is no keep option and no rotate endpoint, so `PUT` the same URL again to rotate |
| `DELETE /v1/me/webhook` | the Silicon | remove it |
| `POST /v1/me/webhook/test` | the Silicon | `202 {"event_id", "delivery_id", "type", "url", "superseded_pings"}` |
| `GET /v1/me/webhook/deliveries[/{delivery_id}]` | the Silicon | the list, or one delivery with every attempt and the whole `payload` |
| `POST /v1/me/webhook/replay` | the Silicon | replay, with the same body and answer as an app's |
| `PUT` / `DELETE /v1/me/silicons/{uuid}/webhook` | its custodian | set or remove the Silicon's webhook; every `PUT` makes a new secret too |
| `GET /v1/me/silicons/{uuid}/webhook/deliveries[/{delivery_id}]` | its custodian | the Silicon's deliveries |
| `POST /v1/me/silicons/{uuid}/webhook/replay` | its custodian | replay the Silicon's deliveries |

In the custodian's paths `{uuid}` can also be the Silicon's si:id. Both ways of creating a Silicon accept `webhook_url` and return `webhook_secret` once. A Silicon may queue 10 test pings an hour (then `429 rate_limited`), and a new test ping replaces earlier ones still waiting for a retry, so at most one is ever retried. Every replay shows up in the history of the Silicon and of the custodian who asked (`silicon.webhook.replayed`).

As a silicon, signed in as yourself: `silicon-accounts webhook set <url>` (prints the secret once), `silicon-accounts webhook remove`, `silicon-accounts webhook test`, `silicon-accounts webhook deliveries --status failed`, `silicon-accounts webhook delivery <id>`, and `silicon-accounts webhook replay --failed` or `silicon-accounts webhook replay <id>...`. Your carbon, as your custodian: `silicon-accounts silicon webhook set <si:id> <url>`, `silicon-accounts silicon webhook remove <si:id>`, `silicon-accounts silicon webhook deliveries si:scout --status failed`, `silicon-accounts silicon webhook delivery si:scout <id>` and `silicon-accounts silicon webhook replay si:scout --failed`.

## Errors

| status | code | when |
|---|---|---|
| 422 | `validation_failed` | the URL is invalid (`details.fields.url` says why): not absolute, has a `#fragment` or credentials, longer than 2048 characters, not `https`, or in production a local host name or a private or reserved IP address |
| 409 | `webhook_not_set` | test, `rotate-secret` or replay without a webhook URL (`generate-secret` works without one) |
| 409 | `idempotency_key_reused` | the `Idempotency-Key` was used with a different body |
| 400 | `invalid_query` | `deliveries?status=` isn't `pending`, `delivered` or `failed` |
| 404 | `delivery_not_found` | no delivery with that id for your app or your Silicon |
| 422 | `validation_failed` | replay body: neither or both of `delivery_ids` and `status`, more than 100 ids, `status` other than `failed`, or `since` without `status` or not RFC 3339 |
| 403 | `app_mismatch` / `not_app_owner` | your credentials belong to another app, or your session isn't one of the app's authors |
| 404 | `unknown_app` | no app with that id |
| 403 | `silicon_only` / `carbon_only` | a Carbon called a Silicon's `/v1/me/webhook...`, or a Silicon called the custodian's `/v1/me/silicons/{uuid}/webhook...` |
| 404 | `silicon_not_found` | `/v1/me/silicons/{uuid}/webhook...`: you aren't that Silicon's custodian |
| 429 | `rate_limited` | a Silicon's test pings, more than 10 in an hour (`details.retry_after_seconds`) |
| 409 | `subscription_exists` | the app already has a subscription with this delivery (`details.subscription_id`): change that one instead |
| 404 | `subscription_not_found` | no subscription with this id belongs to the app |
| 422 | `invalid_updates` | `updates` names something that isn't an update (`details.allowed` lists them) |
| 422 | `invalid_webhook_events` | `PUT /v1/apps/{app_id}/webhook` `events` names something that isn't an update |
| 422 | `validation_failed` | subscriptions: `url` missing for a webhook, sent for a stream, or not a public https URL in production; a `PATCH` with nothing to change |
| 401 | `invalid_request_token` | the stream: an unknown `sarq_` token (other missing or bad credentials are also `401`) |
| 409 | `stream_subscription_required` | an app opened the stream without a stream subscription: create one with `{"delivery":"stream"}` |
| 400 | `unknown_event_id` | the stream's `Last-Event-ID` or `after` isn't an event of this feed: resume with the last id this stream sent you, or connect without one |
| 400 | `invalid_query` | the stream's `types` names a type this feed never carries |
| 429 | `too_many_streams` | 5 streams already open for this app or account on the API node that took the request, with `Retry-After` (10 seconds): close one |
| 503 | `stream_capacity_reached` | the server is full or restarting: reconnect after `Retry-After` with `Last-Event-ID` |

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/apps.md, https://developers.teamofsilicons.com/docs/accounts/reference/api/webhooks.md, https://developers.teamofsilicons.com/docs/accounts/reference/limits.md

# The Accounts HTTP API

Everything we do is an HTTP endpoint. The `silicon-accounts` CLI and the Rust client (`silicon-accounts-client`) call these same endpoints, so anything they can do, you as a Silicon can do with a plain HTTP request too. This chapter covers the rules every endpoint shares: where to call, how to authenticate, what errors look like, how to pin a version, how to retry safely, and where each group of endpoints lives.

If you'd rather read a machine description, the whole API is in the OpenAPI 3.1 document at `https://accounts.teamofsilicons.com/openapi.json`, and `GET /v1/capabilities` tells you what this deployment supports before you rely on it. Both are in `# Service endpoints`.

## Where to call

| Where | URL |
|---|---|
| Production | `https://accounts.teamofsilicons.com` |

The API lives under `/v1/*` and `/.well-known/*`. The account site owns the public origin and forwards only those two prefixes to the API, unchanged. So browsers, apps and the CLI all talk to one origin, which keeps cookies, the `Origin` check, the Google and Apple callbacks and every redirect on the same host. Your server may call either origin for `/v1/*`. The token issuer (`iss`) is the public URL.

If something answers in a way you don't expect, call `GET /v1/meta` first. It tells you which deployment you actually reached.

## Who can call what

Every endpoint expects one of these callers:

| Auth | What you send | Who it is |
|---|---|---|
| `public` | nothing | anyone (some endpoints are rate limited per IP) |
| `account` | `Authorization: Bearer <access token>` with `aud` = `silicon-accounts`, or the account site's session cookie | a signed-in Carbon or Silicon |
| `account (Carbon)` / `account (Silicon)` | the same, limited to one kind | the other kind gets 403 `carbon_only` / `silicon_only` |
| `app` | `Authorization: Basic base64(app_id:app_secret)` | your app, with its own credentials |
| `app or author` | your app's Basic credentials, or the `account` auth of one of the app's authors: its owner, or a Carbon or Silicon who accepted an author invite in Silicon Apps | the `/v1/apps/{app_id}/...` routes |
| `OAuth client` | HTTP Basic, or `client_id` + `client_secret` in the form body; `client_id=silicon-accounts` with no secret is the first-party public client, and your own app's `client_id` alone works for the grants your sign-in setup turned on (`public_client`, `device_flow`) | `/v1/oauth/token`, `/revoke`, `/introspect` (introspection always needs the secret) |
| `app access token` | `Authorization: Bearer <access token>` issued to any app | `GET` / `POST /v1/userinfo` |
| `flow` | the `sa_flow` cookie set by `POST /v1/flows`, plus an allowed `Origin` | the browser running a hosted sign-in |
| `request token` | `Authorization: Bearer sarq_...` from `POST /v1/silicons` | a self-created Silicon waiting for its custodian |
| `internal` | `Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>` | Silicon Apps only (the one place an `Idempotency-Key` is required: its private mail bridge) |

`curl -u "$APP_ID:$APP_SECRET"` sends your app's Basic credentials for you.

A first-party access token has `aud = silicon-accounts` and lasts 30 minutes. You get one like this:
- as a Silicon: `POST /v1/silicons/login` with your si:id and STK, or with an assertion signed by one of your Ed25519 keys, so an unattended Silicon never holds a bearer secret (see `# Silicon and custodian endpoints`).
- as a Carbon without a browser: `POST /v1/cli/login/start`, then `POST /v1/cli/login/verify` with the 6 digit code. Or the device flow: `POST /v1/device/authorize`, your Carbon approves it on the account site, and you poll `POST /v1/oauth/token`.
- later, either of you: `POST /v1/oauth/token` with `grant_type=refresh_token` and `client_id=silicon-accounts`.

A token we issued to an app (its `aud` is that app) is refused on account endpoints with 401 `token_wrong_audience`. If App A needs to act for user C at App B, App A gets a User verification proof. It never forwards user C's token.

Cookies belong to the account site. A cookie-authenticated request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`) must send an `Origin` header equal to the public origin, or it gets 403 `origin_not_allowed`. Bearer tokens aren't cookies, so the check doesn't apply to them. Scripts, Silicons and servers should always use Bearer tokens.

## Requests

- JSON bodies need `Content-Type: application/json` (any `application/*+json` works too). An empty body counts as `{}`.
- Broken JSON is 400 `invalid_json`, with the line and column. A body that isn't JSON is 400 `invalid_content_type`. A missing or mistyped field is 422 `validation_failed`, with `details.fields` keyed by the field's path, like `branding.light.primary` or `scopes[3]`.
- Unknown fields are refused (422 `validation_failed` naming the field) on the Silicon, proof, report, webhook replay and identity link bodies, so a typo never silently does nothing. `PATCH /v1/me` and `PATCH /v1/apps/{app_id}/signin-config` refuse them too, and tell you which endpoint owns a field that lives elsewhere (`email`, `id`). `POST /v1/flows` ignores unknown fields, because it receives a whole authorize query.
- The OAuth endpoints (`/v1/oauth/token`, `/revoke`, `/introspect`) take `application/x-www-form-urlencoded`, the way every OAuth library sends it, or a JSON object of strings. They ignore unknown parameters (RFC 6749) but refuse a repeated one.
- Raw bodies: photo uploads take the image bytes with the image's `Content-Type`. CSV imports take `text/csv`.
- Path segments are percent-encoded as usual. `:`, `@` and `+` can go as they are: `/v1/accounts/by-id/c:shubham`, `/v1/me/emails/ada@example.com`.
- A bad query parameter (an unknown value or a wrong type) is 400 `invalid_query`, naming the parameter. A bad path parameter is 400 `invalid_path`.
- `X-Request-Id` is optional. Send 1 to 128 characters of `A-Z a-z 0-9 - _ . :` and we use it as the request id; anything else is replaced with a generated UUIDv7.
- `X-Accounts-Telemetry: off` keeps this request out of telemetry: nothing it causes is sent to Space Station.

## Responses

- Bodies are JSON. Timestamps are RFC 3339 in UTC with milliseconds (`2026-10-07T02:32:20.053Z`). Dates are `YYYY-MM-DD`.
- `200` with a body, `201` when something was created, `202` when work was queued (imports, webhook tests, telemetry), `204` with no body.
- Every response under `/v1` is `Cache-Control: no-store`, because tokens, codes and personal data must never sit in a cache. The exceptions are photos (`public, max-age=31536000, immutable`), `GET /v1/apps/{app_id}/public` (`no-cache`), and discovery and the JWKS (`public, max-age=300`).
- Lists look like `{"items": [...], "next_cursor": "..." | null}`.
- Every response carries `X-Request-Id`. Quote it when you report a bug.

## Errors

Every endpoint except the three OAuth ones answers errors in the same shape:

```json
{"error": {"code": "id_taken", "message": "c:shubham is taken by another account.",
           "hint": "Pick another id, for example c:shubham-2, c:shubham-3, c:shubham-4.",
           "details": {"suggestions": ["c:shubham-2", "c:shubham-3", "c:shubham-4"]}}}
```

`code` is stable and machine readable, so branch on it. `message` says exactly what went wrong and why, and `hint` says what to do next. The optional `details` carries structured data such as `fields`, `retry_after_seconds` or `suggestions`.

A 5xx never explains our internals. It carries `details.request_id` for you to quote instead. 423 and 429 answers set a `Retry-After` header (seconds) and `details.retry_after_seconds`.

`/v1/oauth/token`, `/v1/oauth/revoke` and `/v1/oauth/introspect` answer the RFC 6749 shape instead, because OAuth libraries read `error` as a string:

```json
{"error": "invalid_grant", "error_description": "The authorization code was already used. Codes are single-use, so the tokens issued from it were revoked as a precaution; start the sign-in again."}
```

Every error code with its status and fix is in `# Errors`.

## Retries and idempotency keys

Networks drop. When a request that changes something may or may not have gone through, retry it with the same `Idempotency-Key` and we make sure it only happens once.

The key is optional here: every endpoint below works without one, it just isn't safe to retry. It is 1 to 200 visible ASCII characters with no spaces (`400 invalid_idempotency_key` otherwise); a random UUID works well. Use a fresh key for each operation, and reuse a key only to retry that same operation.

- Same key, same caller, same endpoint, same body (compared as canonical JSON, so key order and whitespace don't matter): you get the first response again, with the same status and body plus `Idempotent-Replayed: true`. Nothing runs twice.
- Same key, different body: 409 `idempotency_key_reused`.
- Same key while the first request is still running: 409 `idempotency_in_progress`. Retry in a few seconds. A crashed request frees its key after 120 seconds.
- Failed requests aren't stored, so retrying a failure runs it again.
- We keep responses for 24 hours. A response with a freshly generated secret in it (an STK, a webhook signing secret, a `sarq_` request token, a proof token) is kept encrypted for only 10 minutes. If we can't decrypt that stored response, a retry gets 409 `idempotency_result_unavailable` and the operation still doesn't run again.
- "Same caller" means the account, the app (or the author acting for it), or the client IP for anonymous calls.

| Endpoint | Kept |
|---|---|
| `PATCH /v1/me`, `POST /v1/me/id`, `POST /v1/me/photo` | 24 h |
| `POST /v1/me/emails`, `POST /v1/me/emails/verify`, `POST /v1/me/phones`, `POST /v1/me/phones/verify` | 24 h |
| `POST /v1/silicons` (self-create) | 10 min |
| `POST /v1/me/silicons`, `POST /v1/me/silicons/{uuid}/stk` | 10 min |
| `POST /v1/me/silicons/{uuid}/photo` | 24 h |
| `POST /v1/me/webhook/replay`, `POST /v1/me/silicons/{uuid}/webhook/replay` | 24 h |
| `PATCH /v1/apps/{app_id}/signin-config`, `POST /v1/apps/{app_id}/imports` | 24 h |
| `PUT /v1/apps/{app_id}/webhook`, `POST /v1/apps/{app_id}/webhook/rotate-secret`, `POST /v1/apps/{app_id}/webhook/generate-secret` | 10 min |
| `POST /v1/apps/{app_id}/webhook/test`, `POST /v1/apps/{app_id}/webhook/replay` | 24 h |
| `POST /v1/apps/{app_id}/subscriptions` | 10 min |
| `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}`, `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test` | 24 h |
| `POST /v1/proofs/user-verification`, `POST /v1/proofs/app-verification`, `POST /v1/apps/{app_id}/proofs/app-verification`, `POST /v1/proofs/refresh` | 10 min |
| `POST /v1/apps/{app_id}/account-verification-request` | optional key |
| `POST /v1/reports` | 24 h |

For example, your Carbon creates `si:scout` with `Idempotency-Key: create-si-scout-1`, and the connection drops. Sending it again within 10 minutes returns the same `201` and the same STK, with `Idempotent-Replayed: true`, and no second Silicon is made.

Silicon Apps uses the same header with different rules, so don't carry these over:

| | Silicon Accounts | Silicon Apps |
|---|---|---|
| When a key is needed | optional on every public endpoint | required on every `POST`, `PUT`, `PATCH` and `DELETE` under `/v1`, except `/v1/auth/*` (`400 invalid_input` without one) |
| Length | 1 to 200 visible ASCII characters | 8 to 200 printable ASCII characters, no spaces |
| Scope | caller, method and route | your account and the key (anonymous calls share one scope, so use random keys there); the method, path and body are checked against it, so the same key on another path is `409 conflict` |
| A response carrying a new secret | replayed for 10 minutes, then the key is no longer kept | replayed for 10 minutes, then `409 secret_replay_expired` and nothing runs |
| Failures | not stored, so a retry runs again | a failed package validation is stored and replayed |

## Pagination

List endpoints take `?limit=` (1 to 200, default 50; anything outside is clamped) and `?cursor=` (the previous page's `next_cursor`, unchanged). Cursors are keyset positions, so pages never skip or repeat items while new ones arrive. The last page has `"next_cursor": null`. A cursor that isn't ours is 400 `invalid_cursor`.

## Rate limits and locks

Over a rate limit you get 429 `rate_limited`, and every 429 carries a `Retry-After` header and `details.retry_after_seconds`; wait that long, then try again. Too many wrong codes or STKs lock instead: 423 `verification_locked` or `login_locked`, also with `Retry-After`. The sign-in numbers are in `# Security` below, the import budgets in `# Importing existing users`, and every limit in `# Limits`.

## Body limits and time budgets

| Requests | Largest body | Time budget |
|---|---|---|
| everything not listed | 64 KB | 30 s |
| `POST /v1/me/photo`, `POST /v1/me/silicons/{uuid}/photo`, `POST /v1/flows/{id}/signup/photo` | 2 MB | 60 s |
| `PATCH /v1/apps/{app_id}/signin-config` | 512 KB | 30 s |
| `POST /v1/apps/{app_id}/imports` | 50 MB | 5 min |

A bigger body is refused before we read it: 413 `payload_too_large` with `details.limit_bytes` (on the OAuth endpoints, 413 with `error: invalid_request`). A request that runs past its budget ends with 503 `request_timeout`.

## CORS

Only public resources can be read from other origins: `GET /v1/apps/{app_id}/public`, `/.well-known/*` and `/sdk/*` answer `Access-Control-Allow-Origin: *` (and their preflights). So do the discovery documents `/openapi.json`, `/v1/openapi.json` and `/v1/capabilities`, and their `X-Request-Id`, `Accounts-Version` and `Retry-After` headers are readable too. Every other response has no CORS headers at all, so a web page on another origin can't call the API with a visitor's credentials. Call the API from your server. In the browser, use the hosted pages, the iframe or the SDK.

## Versions

The API has dated versions. Pin one with the request header `Accounts-Version: 2026-10-01`. Leave the header out and the current version answers, so clients written before versions existed keep working unchanged. Every answer under `/v1`, `/.well-known` and `/openapi.json` names the version that served it in its own `Accounts-Version` header (with `Vary: Accounts-Version`).

A version this deployment doesn't serve is refused before anything runs:

```json
{"error": {"code": "unsupported_version",
           "message": "Silicon Accounts does not serve the API version '2027-01-01' named in the Accounts-Version header. It serves 2026-10-01.",
           "hint": "Send Accounts-Version: 2026-10-01, or leave the header out to get the current version. GET /v1/capabilities lists the versions.",
           "details": {"requested": "2027-01-01", "supported": ["2026-10-01"], "current": "2026-10-01"}}}
```

`GET /v1/capabilities` lists the versions served. The path carries the major version too: the API is `/v1`, the iframe `/embed/v1/buttons` and the SDK `/sdk/v1.js`. `GET /v1/meta` reports the deployment's own `version`.

## Unknown paths and methods

On the public origin, any unknown path under `/v1` or `/.well-known` (and on the API's own address, any unknown path at all) is 404 `route_not_found` in JSON. It names the method and path and points you to `GET /v1/meta`. Every other unknown path on the public origin (`/embed/v1/nope`, `/sdk/v2.js`) is the account site's HTML 404 page. A known path with the wrong method is 405 `method_not_allowed`, with an `Allow` header listing the methods it takes.

## Every endpoint group

| Group | What it covers | Paths | Chapter |
|---|---|---|---|
| OAuth and OIDC | authorize, discovery, JWKS, token, revoke, introspect, userinfo, device authorize | `/authorize`, `/.well-known/*`, `/v1/oauth/*`, `/v1/userinfo`, `/v1/device/authorize` | `# OAuth and OIDC endpoints` |
| Hosted sign-in, sessions and CLI sign-in | the hosted flow's steps, provider callbacks, linking identities, the browser session, device approval, CLI code sign-in | `/v1/flows/*`, `/v1/oauth/callback/{provider}`, `/v1/session`, `/v1/device/{user_code}/*`, `/v1/cli/login/*` | `# Sign-in endpoints` |
| Accounts | id availability, account lookups, `me`, photos, emails, phones, identities, apps signed into, sessions, history | `/v1/ids/available`, `/v1/accounts/*`, `/v1/me/*`, `/v1/photos/{id}` | `# Account endpoints` |
| Silicons and custodians | self-create, Silicon login (STK or key), Silicon keys, short-lived tokens, Silicon webhooks, managing Silicons, STK rotation, transfers, a Silicon's apps, sign-ins and allow-list, custodian requests | `/v1/silicons/*`, `/v1/me/short-lived-tokens`, `/v1/me/webhook/*`, `/v1/me/silicons/*`, `/v1/me/custodian-requests/*` | `# Silicon and custodian endpoints` |
| Apps | public config, account verification requests, owned apps, sign-in config and its history, users, imports, event subscriptions | `/v1/apps/{app_id}/*`, `/v1/me/owned-apps` | `# App endpoints` |
| App verification and User verification | issue, refresh, verify and revoke proofs, App verification records and history, an account's own User verification proofs | `/v1/proofs/*`, `/v1/apps/{app_id}/proofs/*`, `/v1/me/app-verifications`, `/v1/me/proofs/*` | `# Proof endpoints` |
| Webhooks | what we send to you: the delivery, its signature, every event; an app's webhook and its deliveries | requests we make to your URL, `/v1/apps/{app_id}/webhook/*` | `# Webhooks`, `# Webhook endpoints` |
| Events | the same events, live, as Server-Sent Events, for apps, Silicons, custodians and waiting Silicons (`Last-Event-ID`, `?types=`) | `GET /v1/events/stream` (app, account or request token) | `# Webhooks` |
| Service | health, readiness, deployment metadata, capabilities, the OpenAPI document, the agent card, bug reports, telemetry, the iframe and the SDK | `/healthz`, `/readyz`, `/v1/meta`, `/v1/capabilities`, `/openapi.json`, `/.well-known/agent.json`, `/v1/reports`, `/v1/telemetry/events`, `/embed/v1/buttons`, `/sdk/v1.js` | `# Service endpoints` |

More: https://developers.teamofsilicons.com/docs/accounts/reference/api.md

# Your app's user base

For every app we keep its whole user base: every Carbon and Silicon that has signed into it or that you imported, with their membership id and the details your app is allowed to see. You can read it any time, from the developer platform, the CLI or the API.

The columns are the ones we give, and they're the same for every app. You can't add your own columns, which is also why an import refuses any column outside the list.

## Memberships

An account's membership with your app is `{app_id}:{uuid}`, for example `briefcase:8HV`. It looks the same for Carbons and Silicons.

Always store the `uuid` (or the `membership_id`). Never key anything on the c:id or si:id: `c:shubham` can become `c:shubham-k` tomorrow, but the uuid never changes.

What your app knows about an imported Carbon (your "imported profile": the cleaned row, every email and phone you sent, and your `external_id`) lives on the membership, never on the account. The account belongs to its Carbon, not to any app.

## Member status

- `imported` - came in through your import and hasn't signed into your app yet.
- `active` - signed into your app, or was already a member when an import matched them.
- `access_removed` - the account removed your app's access.
- `deleted` - the account was deleted. It stays in the list as history.

Each member also has a `source`: `signin` (the hosted sign-in), `slt` (a Silicon's short-lived token) or `import`. And it has an `account_status`, the account's own status: `unclaimed` for an account your import created that nobody has finished yet, `active` once it's finished, `deleted` once it's gone.

## The columns

| Field | What it is |
|---|---|
| `membership_id` | `{app_id}:{uuid}` |
| `uuid` | the account's permanent id (case-sensitive) |
| `kind` | `carbon` or `silicon` |
| `id` | the current c:id or si:id; `null` once deleted |
| `display_name`, `pfp_url` | always the account's own |
| `email`, `phone`, `dob`, `timezone` | contact and profile details, as below |
| `status`, `account_status`, `source` | as above |
| `external_id` | your own id for this Carbon, unique within your app; `null` if you never gave one |
| `granted_scopes` | what the account agreed to share, for example `["profile", "email", "timezone"]` |
| `first_signed_in_at`, `last_signed_in_at`, `created_at` | timestamps |

A Silicon's custodian is not a column. Your app gets it as `custodian: {uuid, id}` in the token response, `/v1/userinfo`, account lookups and `account.updated`, so save it from there if you need it.

What you see in the contact columns depends on the member:
- `active`: the primary email or phone (Carbons only), `dob` and `timezone`, within the scopes they granted you.
- `imported`: the email, phone, date of birth and timezone from your import. The name, id and photo are always the account's own.
- `access_removed`: nothing.
- `deleted`: `display_name: "Deleted account"`, the default photo, `id: null` and no contact details. Your `external_id` stays on the membership, so when `account.deleted` reaches your webhook you can still find your own record.

Once a member signs into your app, you see what they chose to share, not your imported values anymore.

## Reading it

Use `GET /v1/apps/{app_id}/users` and `GET /v1/apps/{app_id}/users/{uuid}` (both in `# App endpoints`). `GET /v1/apps/{app_id}` carries `stats`:
- `users` - live members: active or imported, accounts not deleted.
- `active_last_30d` - members who signed in during the last 30 days.
- `imported_unclaimed` - imported Carbons who haven't finished their account yet.

From the CLI:

```sh
silicon-accounts app users --status imported   # imported members who haven't signed into your app yet
silicon-accounts app users --q shubham         # search id, display name, email, phone and external id
silicon-accounts app user 8HV                  # one member, with its last sign-ins
silicon-accounts app show                      # the app, its sign-in setup and these stats
```

`--status deleted` lists only deleted accounts; the other statuses leave them out.

## The life of a member

| What happens | Account status | Membership with your app |
|---|---|---|
| Your import creates the account | `unclaimed` | `imported` (source `import`) |
| Your import matches an existing account | unchanged (usually `active`) | `imported`, or stays `active` if already a member |
| The Carbon finishes their account, in any app or on the account site | `active` | unchanged until they sign into your app |
| They sign into your app | `active` | `active`, with the details they agreed to share |
| They remove your app's access | `active` | `access_removed` (imports skip them) |
| They delete their account | `deleted` | kept as history, no details, your `external_id` stays |

Imported members are real members of your app, so your webhook hears about them like anyone who signed in, limited to what your app may see. Say an imported Carbon finishes their account through another app and picks a new id and name: your app gets `account.id_changed` and `account.updated`, even though they haven't signed into your app yet. The events themselves are in `# Webhooks`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/apps.md, https://developers.teamofsilicons.com/docs/accounts/learn/imports.md

# Importing existing users

If your app already has users, you don't lose them. Import them as a CSV or JSON file. For each row we look for a Carbon with the same email or phone number. If there is one, they join your user base. If there isn't, we create an account that the Carbon finishes setting up the first time they sign in. An import never sends an email or SMS.

You run imports with your app's own credentials (Basic `app_id:app_secret`) or as one of its authors (its owner or an accepted co-author), signed in. On `developers.teamofsilicons.com` the same flow is the app's Import tab (`/apps/{app_id}/import`).

```sh
printf '%s' "$APP_SECRET" | silicon-accounts app use legacy-crm --secret-stdin   # stores the secret, mode 0600
silicon-accounts app import users.csv --default-country US --dry-run --wait       # every decision, nothing written
silicon-accounts app import users.csv --default-country US --wait                 # the real import
silicon-accounts app import rows <job-id> --outcome error                         # the rows to fix
```

`silicon-accounts app use legacy-crm` without a secret acts as one of the app's authors through your own session. Every `silicon-accounts app` command also takes `--app-id`, `--app-secret-stdin` (or `ACCOUNTS_APP_ID` / `ACCOUNTS_APP_SECRET`).

The import command:

| Option | What it does |
|---|---|
| `[FILE]` | the CSV or JSON file (`-` for stdin), at most 50 MB and 100,000 rows |
| `--format csv\|json` | default: from the extension; `csv` for stdin |
| `--default-country <CC>` | country for local phone numbers |
| `--dry-run` | decide everything, write nothing |
| `--ignore-unknown-columns` | import even when the file has unknown columns |
| `--update-existing` | also replace your imported profile of existing members |
| `--wait` | wait for the job, showing progress and the first errors; exits `1` if the job ended `failed` |
| `--idempotency-key <KEY>` | default random; reuse it when you retry an upload |

Then `silicon-accounts app import status <job-id> --wait` follows a job (it exits `0` either way, so read `status`), `silicon-accounts app import list` lists jobs, and `silicon-accounts app import rows <job-id>` takes `--outcome`, `--level`, `--code`, `--limit` and `--cursor`.

## The columns

These are the only columns an import accepts. Column names are case-insensitive, and spaces around them are ignored.

| Column | Holds | Rules |
|---|---|---|
| `external_id` | your own id for this Carbon | at most 255 characters, no control characters, unique within your app; text or a number |
| `email` | an email address | trimmed, lowercased, validated |
| `emails` | more email addresses | a JSON array, or text separated by `;`; with `email`, at most 10 per row |
| `phone` | a phone number | stored in E.164 (`+14155550163`); a number without `+` or `00` needs `default_country` |
| `phones` | more phone numbers | a JSON array, or text separated by `;`; with `phone`, at most 10 per row |
| `display_name` (or `name`) | the Carbon's name | runs of whitespace become one space; cut to 100 characters; without it, the name comes from the email (`kofi@example.com` gives "Kofi") or the phone ("Carbon 0161") |
| `username` | the id they should get | `kofi` or `c:kofi`; if it's taken, reserved or invalid, we assign a free id close to it |
| `dob` | date of birth | `YYYY-MM-DD`, also `YYYY/MM/DD`, and `DD/MM/YYYY` or `MM/DD/YYYY` only when just one reading is possible; on or after 1900-01-01 and before today; otherwise a new account gets the date exactly 18 years ago |
| `timezone` | an IANA timezone | any letter case; offsets like `GMT+5:30` and Windows names are left out, and a new account gets `UTC` |
| `pfp_url` | a profile photo | an `https` URL; `http` and photos uploaded to Silicon Accounts are left out, and a new account gets the default Carbon photo |
| `email_verified` | `true` / `false` | kept in your imported data only; we never trust an imported address as verified |

Every row needs at least one usable email or phone number. Without one there is nothing to match the row with, and nothing its owner could sign in with.

Put the address your users actually sign in with first. A new account carries exactly one address: the row's first valid email (`email`, then `emails`), or its first valid phone when it has no valid email.

## File formats

Rules for both formats:
- Every value is trimmed. Blank cells, `null` and empty lists count as "not given".
- `name` and `display_name` are the same column, so a file with both is refused, like any column given twice.
- A file with any other column is refused as a whole with `unknown_columns`, because silently dropping data you thought you imported is worse than a clear no. With `ignore_unknown_columns=true` the rest goes through, and we keep only the names of the ignored columns (at most 5 per row, plus a count), never their values.

CSV:
- UTF-8 with a header line. A UTF-8 byte order mark (Excel's "CSV UTF-8") is stripped.
- `Content-Type: text/csv` (also `application/csv`, `text/comma-separated-values`, `application/vnd.ms-excel`). Options go in the query string.
- Quoted cells can hold commas, quotes (`""`) and newlines. A quoted newline doesn't start a new row.
- Cells past the header are ignored (warning `extra_fields`), missing trailing cells read as empty (warning `missing_fields`), and a whitespace-only line is skipped.

JSON:

```json
{"rows": [{"external_id": "u-100", "email": "maya@example.com", "display_name": "Maya Patel", "username": "maya"},
          {"external_id": "u-101", "phone": "(415) 555-0142", "name": "Sam Ortiz"},
          {"external_id": "u-102", "emails": ["li@example.com", "li.work@example.com"], "dob": "1988-04-02"}],
 "options": {"default_country": "US", "dry_run": true}}
```

- `rows` is required and must be an array of objects. `options` is optional. Any other key is refused, so a misspelt option can't be quietly ignored.
- Options can also be query parameters. The same option given in both places with different values is refused (`validation_failed`), so a dry run can never turn into a real import by accident.
- The CLI and the Import tab also accept a file that is just the array, and wrap it for you. Over HTTP, send `{"rows": [...]}`.

## Options

| Option | CLI flag | Default | What it does |
|---|---|---|---|
| `default_country` | `--default-country US` | none | ISO 3166 two-letter code for phone numbers written without a country code; without it, those numbers are left out with `invalid_phone` |
| `dry_run` | `--dry-run` | `false` | decide and report every row, write nothing |
| `update_existing` | `--update-existing` | `false` | for rows matching an account that's already your member, replace your imported details and `external_id` (outcome `updated`); never touches the account's own data |
| `ignore_unknown_columns` | `--ignore-unknown-columns` | `false` | import a file with columns outside the list; their values are dropped and each affected row gets a warning |

Flags take `true` / `false` (also `1` / `0`, `yes` / `no`, `on` / `off`). Unknown options are refused, with `invalid_query` in a query string or `validation_failed` in a JSON body, never ignored.

## Preview with a dry run

Always dry-run first. A dry run is a normal job with `"dry_run": true`: it reads every row, matches, picks ids, and reports exactly what the real import would do. It writes no account, no membership and nothing a Carbon could ever see.

```sh
curl -s -u "$APP_ID:$APP_SECRET" -H 'Content-Type: text/csv' --data-binary @users.csv \
  "https://accounts.teamofsilicons.com/v1/apps/$APP_ID/imports?default_country=US&dry_run=true"
```

Two things differ in a dry run's report:
- `account_uuid` is always `null`, and matched rows don't name the account (`id` is `null` too). A dry run must never work as a way to find out who owns an email address.
- The ids shown for new accounts are the ones free right now. One may be taken by the time you import.

Dry runs count toward your hourly requests and daily rows just like real imports, because otherwise they'd be a free, unlimited address lookup. So dry-run the whole file once, not piece by piece.

## Running the import

```sh
curl -s -u "$APP_ID:$APP_SECRET" -H 'Content-Type: text/csv' \
  -H 'Idempotency-Key: crm-import-1' --data-binary @users.csv \
  "https://accounts.teamofsilicons.com/v1/apps/$APP_ID/imports?default_country=US"
```

The request only reads and checks the file. It answers `202` with `{"job": ImportJob}`, and a background worker processes the rows. Poll `GET /v1/apps/{app_id}/imports/{job_id}` until `status` is `completed` or `failed`.

| Job field | What it means |
|---|---|
| `status` | `queued` (waiting for the worker), `running`, `completed`, or `failed` (the whole job stopped; `error` says why and which rows were done) |
| `total_rows`, `processed_rows` | rows in the file, and rows with an outcome so far |
| `counts` | rows per outcome (`created`, `matched`, `updated`, `skipped`, `error`), plus `warnings`, the number of warning messages over all rows |
| `created_by` | `app` (your app's credentials) or the uuid of the author who ran it |
| `id`, `options`, `dry_run`, `format`, `created_at`, `started_at`, `finished_at` | the job id, what it runs with (`format` is `csv` or `json`), and when |

Send an `Idempotency-Key` with every import. If the connection drops before you see the `202`, send the same request with the same key and you get the original answer back (`Idempotent-Replayed: true`, still showing `"status": "queued"`) instead of a second job. Then read the job to see where it really is. A key is remembered for 24 hours. Reusing it for a different file or different options is 409 `idempotency_key_reused`. One key per file.

## How matching works

Every Carbon has exactly one account, and every email and phone on an account belongs to that account alone. So a row can only mean an account that already exists, or a new one:
- no account has the row's addresses - `created`: a new Carbon account, status `unclaimed`, waiting for its owner.
- exactly one account has them - `matched`: that account joins your user base.
- two or more accounts have them - `error`, `ambiguous_match`: the row describes two Carbons. Picking one would link your record to the wrong Carbon, or hand one Carbon's address to the other, so we leave the decision to you. The message groups the addresses as "account 1", "account 2" without naming anyone, because an import must never tell you who owns an address.

Only addresses that identify someone count: an address an account has verified, or the address an earlier import (yours or another app's) gave an account nobody has finished yet. So if `briefcase` and `remind` both import the same Carbon before she signs in, both rows point to the same unfinished account, and she ends up with one account and two memberships.

Each row goes through the same steps, in file order:
1) Clean: trim values, lowercase and validate emails, turn phones into E.164, collapse whitespace in names, and read the username, date of birth, timezone and photo URL. Invalid optional values are dropped with a warning. A row left without any email or phone is an error.
2) Duplicates in the file: if any of the row's addresses showed up in an earlier row, this row is skipped (`duplicate_in_file`). The first row wins.
3) Who has these addresses. For a match: a second row reaching the same account through another address is skipped, an account that removed your app's access is skipped, and an `external_id` used by another member (or by an earlier row for someone else) is an error. For a new account: pick its id.
4) Write (not in a dry run), 500 rows per transaction.

File order makes every decision deterministic. The dry run and the real import reach the same answers, and a job resumed after a crash decides the remaining rows exactly as the first attempt would have.

### Why a new account carries one address

Whoever proves an address on an unfinished account becomes its owner, and from then on every address on that account signs into it. If one row could put several addresses on a new account, an app could bundle a stranger's email with an address the app controls, claim the account with its own address, and catch every later sign-in of that stranger. With one address per new account, the only Carbon who can claim it is the one who can prove that address. The row's other addresses stay in your imported data, and the row gets `info identifiers_not_attached`.

The cost: a Carbon who later signs in with one of those other addresses starts a separate account (or, if your app has `allow_signup: false`, is refused). Your Carbons can add their other addresses themselves, each one verified with a code.

For the same reason, a matched account never receives the row's addresses. Only an account's owner can add an address to it, after proving it.

### Your import never changes an account's own data

For a new account, the row's values are its starting values (display name, id, date of birth, timezone, photo), and the Carbon checks them and can change any of them when they finish. For a matched account nothing on the account changes: not its name, id, photo, date of birth, timezone or addresses. Priya stays "Priya Raman" even if your CRM calls her "Priya from the CRM".

A second import of the same Carbon keeps what you stored the first time. Only `update_existing` replaces your imported profile and `external_id`, and even then it never touches the account.

`email_verified` in your file is kept in your imported data and nothing more. An address becomes verified only when its owner proves it, with a 6 digit code or Google or Apple vouching for it. Your app vouching for it doesn't prove that whoever holds the account today is the person in your export.

### Conflicts

- `external_id` is unique within your app. On a later import a member keeps the `external_id` you gave first. If the row carries a different one, yours is kept and the row gets `warning external_id_differs`, so a typo or a reordered export can't quietly re-point your links to other Carbons. Send `update_existing=true` when you really mean to replace it. An empty `external_id` is filled in by the next import that has one.
- Removed access stays removed. If a Carbon removed your app's access, that was their decision, and an import never undoes it: the row is skipped with `access_removed`. They come back by signing into your app again.
- A `username` is a wish. If it's taken, reserved for 10 days after someone changed away from it, or taken by an earlier row, we try `c:priya-2` through `c:priya-20`, then a random four digit suffix, and say so with `id_conflict`. Without a usable username we build the id from the cleaned username (`John Smith!` gives `c:john-smith`), then the email's local part (`admin.user@...` gives `c:admin-user`), then the display name (`Ravi Kumar` gives `c:ravi-kumar`). The new account holds that id even before setup is finished, and the Carbon can keep it or pick another.

## Row outcomes

| Outcome | What it means |
|---|---|
| `created` | no account has the row's addresses: a new `unclaimed` Carbon account carrying the row's first email (or first phone), unverified, joined your user base as `imported` |
| `matched` | exactly one account has the row's addresses: it joins as `imported` (an `active` member stays `active`); your details for it are stored only if you had none |
| `updated` | matched an existing member with `update_existing`: your details and `external_id` for it were replaced |
| `skipped` | left out on purpose: a duplicate of an earlier row, or an account that removed your app's access |
| `error` | left out: the row can't be used as it is; its error message says what to fix |
| `pending` | only while the job runs: not reached yet |

## Reading the rows

`GET /v1/apps/{app_id}/imports/{job_id}/rows` returns every row's outcome in file order. Filter with `outcome`, `level` (rows with at least one message of `error`, `warning` or `info`), `code` (a message code such as `id_conflict`), `limit` (default 50, at most 200) and `cursor`.

| Row field | What it means |
|---|---|
| `row_number` | the 1-based data row; the CSV header doesn't count, and a quoted newline doesn't start a row |
| `outcome` | what happened |
| `account_uuid` | the account the row is now linked to; store it with your record (the membership id is `{app_id}:{account_uuid}`, for example `legacy-crm:gYJ`) |
| `id` | the account's c:id when the row was processed |
| `messages` | `{level, code, message, field?}`, in the order they came up |
| `input` | the row as you sent it (import columns only), plus `_ignored_columns`, `_ignored_count` and `_extra_cells` when it had them |

Every message has a stable `code`. Errors stop the row, warnings say what was dropped or changed while the row went on, and info explains a decision.

| Code | Level | Outcome | When |
|---|---|---|---|
| `missing_identifier` | error | error | no usable email or phone (none given, or all invalid) |
| `ambiguous_match` | error | error | the row's addresses belong to two or more accounts; split it into one row per Carbon |
| `external_id_conflict` | error | error | the `external_id` belongs to another member, or an earlier row used it for someone else |
| `invalid_external_id` | error | error | over 255 characters or contains control characters |
| `import_conflict` | error | error | rare: a concurrent change claimed the row's address or id four times in a row, or no free id was found; import the row again |
| `duplicate_in_file` | info | skipped | an address appeared in an earlier row, or the row matches the same account as an earlier row; the message names that row |
| `access_removed` | warning | skipped | the Carbon removed your app's access |
| `id_conflict` | warning | created | the `username` is taken, reserved, or taken by an earlier row: "Wanted c:priya, assigned c:priya-2: c:priya is already taken by another account." |
| `invalid_username`, `reserved_username` | warning | created | not a valid handle (3 to 30 of `a-z 0-9 - _`) or a Silicon id; or a reserved word (`admin`, `support`, `root`, `api`, ...) |
| `identifiers_not_attached` | info | created | the new account carries only the first address; the others stay in your imported data |
| `external_id_differs` | warning | matched | already your member with another `external_id`; yours was kept |
| `invalid_email` | warning | any | an email isn't valid and was left out (at most 5 such messages per row, then "...and N more") |
| `invalid_phone` | warning | any | not valid, or no country code and no `default_country` |
| `too_many_emails`, `too_many_phones` | warning | any | more than 10 in the row; the last ones were left out |
| `invalid_dob`, `invalid_timezone`, `invalid_pfp_url` | warning | any | the value breaks its column rule (an ambiguous date like `04/05/1990`, a non-IANA timezone, a non-https photo); a new account gets the default |
| `display_name_truncated` | warning | any | longer than 100 characters |
| `invalid_value` | warning | any | a list or object where text is expected, or `email_verified` isn't true or false |
| `unknown_columns` | warning | any | with `ignore_unknown_columns`: the row had values in dropped columns |
| `extra_fields`, `missing_fields` | warning | any | CSV: more, or fewer, cells than the header |

Quoted values in messages are cut to 80 characters and no message is longer than 2,000 characters, so one bad cell can't blow up a report.

## Fixing failed rows

Fix the rows that failed and import the file again, whole or just those rows. Importing a row twice is safe: a row that was already imported matches the account it created, so nothing is duplicated. And a second import never changes what you stored the first time unless you send `update_existing=true`.

## When the whole request is refused

These come back before a job exists, so nothing was imported:

| Status | Code | Why |
|---|---|---|
| 400 | `invalid_content_type` | the body isn't a CSV type or `application/json` |
| 400 | `invalid_query` | a query parameter isn't an option, or has a bad value (`dry_run=maybe`, `default_country=USA`) |
| 400 | `invalid_json` | the JSON body doesn't parse |
| 413 | `payload_too_large` | more than 50 MB |
| 422 | `unknown_columns` | columns outside the list (`details.unknown_columns`, `details.allowed_columns`) |
| 422 | `duplicate_columns` | the same column twice (case-insensitive; `name` is `display_name`) |
| 422 | `no_identifier_columns` | a CSV without an `email`, `emails`, `phone` or `phones` column |
| 422 | `empty_import` | no rows |
| 422 | `invalid_csv` | unreadable, or not UTF-8 (the message gives the row and line) |
| 422 | `too_many_rows`, `too_many_columns`, `value_too_large`, `too_many_items` | over 100,000 rows; over 200 columns; a value over 8 KB or a column name over 200 bytes (`details.row`, `details.column`); a JSON list over 50 items |
| 422 | `validation_failed` | the JSON body's shape or options are wrong (`details.fields`) |
| 409 | `idempotency_key_reused` | the key was used for a different request |
| 429 | `rate_limited` | hourly requests or daily rows used up |
| 503 | `imports_busy` | the server is reading two other imports; retry after 15 seconds with the same key |
| 401, 403 | `invalid_app_credentials`, `unauthenticated`, `app_mismatch`, `not_app_owner`, `app_disabled` | wrong or missing credentials, another app's credentials, an account that isn't one of the app's authors, a disabled app |
| 404 | `import_not_found` | no such job for this app (reading a job or its rows) |

## Limits

- Per file: 100,000 rows, 50 MB, 200 columns, 8 KB per value, 50 items per list. That's far above any real export, and small enough to parse in bounded time and memory.
- Requests per app: 60 per hour, dry runs and refused files included. Over it: 429 `rate_limited` with `Retry-After` and `details.limit`.
- Rows per app: 2,000,000 per 24 hours, dry runs included; a refused import costs nothing. Over it: 429 with `details.limit_rows`, `details.remaining_rows` and `details.import_rows`.
- Bodies parsed at once: 2 per server. A third waits up to 30 seconds, then gets 503 `imports_busy` with `Retry-After: 15`.

Every request counts toward the 60 per hour, so a few big files are cheap and thousands of tiny ones aren't. For a big migration, split the export into files of at most 100,000 rows, dry-run each one, then import them one after another with one idempotency key per file.

How a job runs: rows go in file order, 500 per transaction. One app's jobs run one at a time, in the order you sent them, so two files never race for the same Carbons; a second file waits in `queued`. If the server restarts, another worker picks up after the last committed chunk. A job whose worker stops more than twice is marked `failed` instead of retrying forever, and an internal error on one chunk is retried twice before the job fails. Either way `error` says which rows were done, and sending the file again is safe.

## When your imported users sign in

Nothing reaches your users when you import them. Tell them yourself when you're ready, and send them to your normal sign-in. For a new, unfinished account:
1) They sign in with the address the account carries: a 6 digit code sent to it, or Google or Apple when that's their Google or Apple account's email. Proving the address is what lets them claim the account.
2) Instead of a sign-up they see `Finish setting up your account`, naming your app, with every field filled in from your row (your values win over what Google or Apple suggest). They can change anything, then press `Finish setup`. If they first sign into another app with that address, they finish the same account there, and the page still names your app (the flow's `signup.imported_by`, with `signup.finishing_import: true`).
3) The account is theirs: status `active`, the proven address verified, and the same uuid your import reported. Your app gets that uuid in the token response, and the membership turns from `imported` to `active`.

Good to know:
- A Carbon who signs in with another address (one that stayed in your imported data) hasn't proven the imported one, so they start a separate account. With `allow_signup: false` that sign-up is refused (`signup_not_allowed`), but finishing an imported account is always allowed.
- Imported Carbons finish in a browser, through an app's sign-in or the account site. The CLI's code sign-in (`silicon-accounts login --email`) only signs in accounts that are already active.
- If someone finishes through another app first, your membership stays `imported` until they sign into your app.
- When they finish, every address the import attached that they didn't prove is removed. An address nobody has proven never signs anyone in.
- An account nobody finishes stays `unclaimed`, keeps its id, and keeps matching later imports of the same address.

More: https://developers.teamofsilicons.com/docs/accounts/start/import-users.md, https://developers.teamofsilicons.com/docs/accounts/learn/imports.md

# App endpoints

You create your app in Silicon Apps. Then these endpoints let you set up its sign-in, read its users, import the users you already have, choose which updates reach you, and ask for a verified account.

Most `/v1/apps/{app_id}/...` routes take `app or author`: your app's Basic credentials (`-u app_id:app_secret`), or the session of one of its authors (its owner, or a co-author who accepted an invite in Silicon Apps). So if your Carbon invited you to `briefcase` as a co-author, you as a Silicon can manage its sign-in with your own account. The exceptions are `/public`, `/account-verification-request` and the verification history at `/proofs/{proof_id}/history`.

Errors any of them can give:
- 403 `app_mismatch` - credentials for a different app.
- 403 `not_app_owner` - an account that isn't one of the app's authors.
- 404 `unknown_app` - there's no such app.
- 403 `app_disabled` - a disabled app's credentials. Its authors can still manage it.

| Method and path | Auth | Idempotent | Success |
|---|---|---|---|
| `GET /v1/apps/{app_id}/public` | public (CORS `*`) | | 200 public config |
| `GET /v1/apps/{app_id}/account-verification-request` | signed-in manager | | 200 your latest request, or `null` |
| `POST /v1/apps/{app_id}/account-verification-request` | signed-in manager | optional | 201 new request, or 200 the pending one |
| `GET /v1/me/owned-apps` | account (Carbon) | | 200 list |
| `GET /v1/apps/{app_id}` | app or author | | 200 app |
| `PATCH /v1/apps/{app_id}/signin-config` | app or author | yes | 200 app |
| `GET /v1/apps/{app_id}/signin-config/history` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/users` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/users/{uuid}` | app or author | | 200 user |
| `POST /v1/apps/{app_id}/imports` | app or author | yes | 202 job |
| `GET /v1/apps/{app_id}/imports` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/imports/{job_id}` | app or author | | 200 job |
| `GET /v1/apps/{app_id}/imports/{job_id}/rows` | app or author | | 200 list |
| `GET /v1/apps/{app_id}/subscriptions` | app or author | | 200 list |
| `POST /v1/apps/{app_id}/subscriptions` | app or author | yes | 201 subscription |
| `GET /v1/apps/{app_id}/subscriptions/{subscription_id}` | app or author | | 200 subscription |
| `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}` | app or author | yes | 200 subscription |
| `DELETE /v1/apps/{app_id}/subscriptions/{subscription_id}` | app or author | | 204 |
| `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test` | app or author | yes | 202 queued ping |

Your app's webhook endpoints (`GET` / `PUT` / `DELETE /v1/apps/{app_id}/webhook`, `rotate-secret`, `generate-secret`, `test`, `deliveries`, `replay`) are in `# Webhook endpoints`, and its proof endpoints (`/v1/apps/{app_id}/proofs/...`) in `# Proof endpoints`.

## The app

- `GET /v1/apps/{app_id}` - your app, its sign-in setup, webhook and stats. Secrets never come back: `google.client_secret_set`, `apple.private_key_set` and `webhook.secret_set` only tell you whether one is stored. Fields: `app_id`, `name`, `description`, `logo_url`, `logo_dark_url`, `homepage_url`, `owner` (an account summary), `status`, `source`, `created_at`, `updated_at`, `signin_config` (every field in the table below), `config_version`, `webhook` (`{"url", "secret_set"}`) and `stats` (`{"users", "active_last_30d", "imported_unclaimed"}`, see `# Your app's user base`). `source` is `silicon_apps`, `fake` (a development stand-in) or `first_party`.
- `GET /v1/me/owned-apps` - `account (Carbon)`: the apps you own, newest first, paginated. Each item has `app_id`, `name`, `logo_url`, `status`, `source`, `users` and `created_at`.
- `GET /v1/apps/{app_id}/public` - what a sign-in page needs: `app_id`, `name`, `logo_url`, `logo_dark_url`, `homepage_url`, `methods` (the enabled methods in order; managed Google and Apple are hidden when the deployment has no credentials for them), `branding`, `copy` and `allowed_origins` (the origins that may frame the sign-in iframe). It's public, sends `Access-Control-Allow-Origin: *` on errors too so an embed can read why it failed, and sends `Cache-Control: no-cache` so branding changes show at once. Errors: 404 `unknown_app`, 403 `app_disabled`.

## Sign-in config

### `PATCH /v1/apps/{app_id}/signin-config`

Changes your sign-in setup. Idempotent. The body is a partial sign-in config: objects merge, arrays and plain values replace, and `null` resets a field to its default. Unknown keys are refused. The body limit is 512 KB, which fits two inline logos of up to 128 KB each. It answers `200` with the same body as `GET /v1/apps/{app_id}`.

Two people can edit the same app. Add `"expected_version": n` (from `config_version`) and a change someone made in between fails with 409 `config_version_conflict` (`details.current_version`) instead of being overwritten.

```sh
curl -s -X PATCH "https://accounts.teamofsilicons.com/v1/apps/briefcase/signin-config" -u "briefcase:$APP_SECRET" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: cfg-2026-10-07-1' \
  -d '{"expected_version":1,"optional_fields":["email","dob"],"copy":{"subtitle":"Your files, for every Carbon and Silicon."}}'
```

Bring-your-own Google and Apple secrets ride along in the same PATCH. We store them encrypted, outside the document, and never return them: `{"google": {"client_secret": "..."}}` and `{"apple": {"private_key": "-----BEGIN PRIVATE KEY-----\n..."}}` (a PKCS#8 P-256 key; `null` removes it). The read-only `client_secret_set` and `private_key_set` are accepted and ignored, so you can PATCH back exactly what you GET. No change means no new version, and every change adds a history entry.

| Field | Default | Rule |
|---|---|---|
| `methods` | `{"email": true, "phone": false, "google": false, "apple": false}` | at least one enabled |
| `method_order` | `["google","apple","email","phone"]` | the order of the buttons |
| `google.mode` / `apple.mode` | `managed` | `managed` (one click, our credentials) or `byo` (yours) |
| `google.client_id` | `null` | required with `byo` (with a `client_secret`); at most 255 characters |
| `google.prompt` | `select_account` | `select_account`, `consent`, `none` or `consent select_account` |
| `google.hosted_domain` | `null` | only that Google Workspace domain may sign in |
| `apple.services_id`, `apple.team_id`, `apple.key_id` | `null` | required with `byo` (with a `private_key`); team and key ids are 10 letters or digits |
| `redirect_uris` | `[]` | at most 50; https, or http on `localhost` / `127.0.0.1` / `[::1]`, or a reverse-domain native scheme |
| `allowed_origins` | `[]` | at most 50 origins that may frame the iframe (`/embed/v1/buttons`, the SDK's `mountFrame`); the SDK's own buttons need none |
| `required_fields` | `[]` | any of `email`, `phone`, `dob`, `timezone`: always shared; a missing email or phone is added on the details page before your app gets the account |
| `optional_fields` | `[]` | the same values, shown as a checkbox (unticked until the Carbon ticks it); never also required |
| `flow` | `null` | your pages: `{steps: [{id, fields, title, subtitle, continue_label, layout}], review}`; 1 to 8 steps, every requested detail on exactly one step; `null` is one page with every detail |
| `allowed_email_domains` | `[]` | at most 100 domains; empty means any |
| `allow_signup` | `true` | `false` lets only existing (and imported) accounts sign in |
| `remember_browser` | `true` | offer "Continue as ..." for the browser's signed-in Carbon |
| `device_flow` | `false` | let your own command-line tool sign Carbons in with a code they approve on the account site (the device authorization grant, with `client_id` alone, no secret) |
| `public_client` | `false` | treat your desktop and command-line tools as public clients: they redeem authorization codes (PKCE `S256` required), exchange a Silicon's short-lived tokens (recorded as sign-in method `slt_public_client`) and refresh with `client_id` alone |
| `branding` | the Silicon Accounts look | `theme`, `logo_url`, `logo_dark_url`, `logo_height` (16 to 96), `show_app_name`, `font_family`, `heading_font_family`, `corner_style`, `radius` (0 to 40), `button_style`, `layout`, `background_style`, `background_image_url`, `density`, `light` and `dark` palettes (`#RRGGBB`; button text and page text need 4.5:1 contrast) |
| `copy` | nulls | `title` (at most 80 characters), `subtitle` (200), `signup_title` (80), `signup_subtitle` (200), `opening_title` (80, only the `{provider}` and `{app}` placeholders), `terms_url`, `privacy_url`, `support_email` |

`device_flow` and `public_client` exist because a secret shipped inside a CLI or a desktop app isn't secret. `device_flow` signs Carbons in. `public_client` signs Carbons in with the code flow and lets your tool exchange a Silicon's SLT itself, so a tool with no server can let both in. Without `public_client`, an SLT exchange needs your secret, so your tool passes the SLT to your server. How your tool uses them is under `# Adding sign-in to your app`.

If a patch doesn't include `flow`, a detail you no longer ask for leaves its step (an emptied step is dropped), and a newly asked detail joins the last step.

Every page footer says `Powered by Silicon Accounts`, and no setting removes it. Errors: 422 `validation_failed` with every problem keyed by path in `details.fields` (for example `branding.radius: is 99 but must be between 0 and 40 (pixels)`), 409 `config_version_conflict`, 413 `payload_too_large`.

From the CLI: `silicon-accounts app config set - <<< '{"methods":{"google":true}}'`.

### `GET /v1/apps/{app_id}/signin-config/history`

Every version of your setup, newest first, paginated. Each item has `version`, `actor`, `at`, and `changes`, a list of `{path, before, after}`. Secrets show as `"[redacted]"` with `"secret": true`. `actor` is one of:
- `app` - your app's credentials.
- the uuid of the author who made the change, and then `actor_account` names them.
- `silicon_apps` - version 1 of an app created in Silicon Apps: the starting setup it chose, recorded as one change with the path `""`.
- `system` - a stand-in app's starting setup, or maintenance such as moving stored setups to a new default.

```json
{"version": 2, "actor": "app", "actor_account": null, "at": "2026-10-07T02:36:18.263Z",
 "changes": [{"path": "optional_fields", "before": ["email"], "after": ["email", "dob"]}]}
```

## Requesting account verification

Want sign-in to run on your own domain, like `login.briefcase.com`? In your app's Sign-in setup on `developers.teamofsilicons.com`, `Request account verification` opens a small form that asks only why you need it. That starts a manual review of whether your account can run app authorization on its own domain, and we respond within 48 hours.

Submitting doesn't verify your account by itself. It doesn't approve a domain or set up custom-domain hosting either; the Team handles the review and any domain setup by hand. This is separate from App verification and User verification proofs.

Both endpoints need a signed-in account that currently manages the app: an Accounts session, or an access token issued to `silicon-accounts` or to the developer platform (`developer`). Your app's Basic credentials can't submit or read the request. We check current ownership or accepted authorship on every request.

### `GET /v1/apps/{app_id}/account-verification-request`

Answers `200 {"request": <your latest request, or null>, "response_time_hours": 48}`. The request belongs to your account, not to each app, so a request you sent from another app you manage shows up here too. Another manager of the same app never sees your reason or your request.

### `POST /v1/apps/{app_id}/account-verification-request`

Body: `{"reason": "Why I need account verification"}`. The reason is trimmed, 1 to 5,000 characters, without NUL, and treated as plain text. Unknown fields are refused, so nobody can pick the recipients or the approval state. An optional `Idempotency-Key` replays the same submission with its original status; reusing it with a different body conflicts.

A new request answers `201`:

```json
{
  "request": {
    "request_id": "01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a79", "account_uuid": "zQo",
    "context_app": {"app_id": "briefcase", "name": "Briefcase", "logo_url": null},
    "reason": "I need authorization on my own domain for my app.", "status": "pending",
    "submitted_at": "2026-10-08T12:00:00.000Z", "response_expected_by": "2026-10-10T12:00:00.000Z", "reviewed_at": null
  },
  "created": true,
  "response_time_hours": 48
}
```

- An account has at most one `pending` request, across all its apps. Sending again while one is pending answers `200` with `created: false` and the original request. It doesn't replace the reason or send more emails, even when two submissions race.
- `response_expected_by` is when to expect a reply. It's not an approval deadline and the request doesn't expire.
- The request and the Team's notification emails are saved together and delivered with retries. Each email has the request id, the reason, the requesting account, its verified primary email if it has one, and the app. `201` means they were saved, not that either email has arrived yet.
- There is no approve or reject endpoint. The Team may later set `status` to `approved` or `rejected`, with `reviewed_at`.

Errors: 422 `validation_failed`, 401 for a missing or unsuitable sign-in, and 403 `not_app_owner` if you don't currently manage the app. Losing management access also stops an earlier submission from being replayed through that app.

## Users and imports

- `GET /v1/apps/{app_id}/users` - every member. Query: `q` (matches the uuid exactly, the id, the display name, `external_id`, the emails and phones you imported, and the primary email or phone only where you were granted that scope), `status` (`active`, `imported`, `access_removed`, `deleted`), `kind` (`carbon`, `silicon`), `source` (`signin`, `slt`, `import`), `limit`, `cursor`. An unknown `status`, `kind` or `source` is 400 `invalid_query`.
- `GET /v1/apps/{app_id}/users/{uuid}` - one member, plus `history`: its last 20 sign-ins at your app (`at`, `method` such as `email`, `session`, `slt`, or `slt_public_client` when your tool exchanged a Silicon's SLT with no secret, `outcome` such as `success` or `new_account`), without IP addresses. A Silicon's entry has no `custodian`. 404 `user_not_found`; uuids are case-sensitive.
- `POST /v1/apps/{app_id}/imports` - start an import. Idempotent. `Content-Type: text/csv` (or `application/csv`) with options as query parameters, or `application/json` `{"rows": [...], "options": {...}}`. Answers `202 {"job": ImportJob}`.
- `GET /v1/apps/{app_id}/imports` - your import jobs, newest first, paginated.
- `GET /v1/apps/{app_id}/imports/{job_id}` - one `{"job": ImportJob}`. 404 `import_not_found`.
- `GET /v1/apps/{app_id}/imports/{job_id}/rows` - every row's outcome in file order, filtered by `outcome`, `level`, `code`, `limit`, `cursor`.

The member fields are in `# Your app's user base`. The columns, options, outcomes, message codes, refusals and limits are in `# Importing existing users`.

## Event subscriptions

A subscription says where your app's updates go, which updates it wants, and whether it's `active` or `paused`. `delivery` is `webhook` (signed POSTs to your URL) or `stream` (kept for `GET /v1/events/stream`). An app has at most one of each. The webhook subscription is your app's webhook, so `PUT /v1/apps/{app_id}/webhook` and these endpoints change the same thing. `app or author`.

The updates are the ones you pick in Silicon Apps, and each one brings these event types:

| Update | Event types | Picked for a new subscription |
|---|---|---|
| `id_change` | `account.id_changed` | yes |
| `display_name_change` | `account.updated` with `display_name` in `changed` | yes |
| `pfp_change` | `account.updated` with `pfp_url` in `changed` | yes |
| `timezone_change` | `account.updated` with `timezone` in `changed` | no |
| `email_change` | `account.updated` with `email` in `changed` | no |
| `phone_change` | `account.updated` with `phone` in `changed` | no |
| `custodian_change` | `silicon.custodian_changed`, and `account.updated` with `custodian` in `changed` | no |
| `access_removed` | `membership.signed_out`, `membership.access_removed` | yes |
| `account_deleted` | `account.deleted` | yes |

- `ping` always arrives.
- `updates: null` means every update, including ones we add later. Webhooks set up before subscriptions existed have it, so they keep getting what they got.
- In `account.updated`, `changed` lists only the fields your subscription picked (and your app may see), and the event isn't sent at all when none is left.
- A paused subscription records nothing until it's active again. Deliveries already queued still go out.

What each event carries, and how the stream works, is in `# Webhooks`. The Subscription object:

```json
{"id": "01a11e45-c73a-7003-a0b9-38ed30a0fd80", "app_id": "briefcase", "delivery": "stream", "status": "active",
 "url": null, "secret_set": false,
 "updates": ["id_change", "display_name_change", "pfp_change", "access_removed", "account_deleted"],
 "event_types": ["account.id_changed", "account.updated", "account.deleted", "membership.signed_out", "membership.access_removed", "ping"],
 "stream_url": "https://accounts.teamofsilicons.com/v1/events/stream",
 "created_at": "2026-10-09T01:27:31.898Z", "updated_at": "2026-10-09T01:27:31.898Z"}
```

- `GET /v1/apps/{app_id}/subscriptions` - `200 {"items": [Subscription...], "next_cursor": null}`, the webhook first.
- `POST /v1/apps/{app_id}/subscriptions` - `{"delivery": "webhook" | "stream", "url"?, "updates"?, "status"?}` answers `201` Subscription. Idempotent for 10 minutes. `url` is required for a webhook and refused for a stream. Leave `updates` out for the defaults above, or send `null` for every update. `status` defaults to `active`. A new webhook subscription always makes a new signing secret and returns it once in `secret` (unlike saving the URL with `PUT /v1/apps/{app_id}/webhook`, which keeps the stored one), and a retry with the same key returns the same secret. Unknown fields are refused. Errors: 409 `subscription_exists` (`details.subscription_id`: change that one instead), 422 `invalid_updates` (`details.allowed`), 422 `validation_failed` (`url` missing, refused, or not a public https URL in production).
- `GET /v1/apps/{app_id}/subscriptions/{subscription_id}` - `200` Subscription. 404 `subscription_not_found`.
- `PATCH /v1/apps/{app_id}/subscriptions/{subscription_id}` - `{"updates"?, "status"?, "url"?}`, at least one, answers `200` Subscription. Idempotent for 24 hours. `status: "paused"` pauses it and `"active"` resumes it. `url` moves a webhook to another endpoint and keeps its signing secret (rotate it with `POST /v1/apps/{app_id}/webhook/rotate-secret`), the same as `PUT /v1/apps/{app_id}/webhook`. Errors: 404 `subscription_not_found`, 422 `invalid_updates`, 422 `validation_failed` (nothing to change, or a `url` for a stream).
- `DELETE /v1/apps/{app_id}/subscriptions/{subscription_id}` - `204`. Deleting the webhook subscription removes the webhook URL and secret, like `DELETE /v1/apps/{app_id}/webhook` (pending deliveries fail and can be replayed once a URL is set again). Deleting the stream subscription ends its open streams within 30 seconds (`stream.closed`, reason `subscription_deleted`). 404 `subscription_not_found`.
- `POST /v1/apps/{app_id}/subscriptions/{subscription_id}/test` - queues a `ping` on that subscription, active or paused. Idempotent: a retry queues no second ping. `202 {"subscription_id", "event_id", "delivery_id", "type": "ping"}`; `delivery_id` is `null` for a stream, where the ping arrives as a frame with that `event_id`.

From the CLI (`subscriptions` works too):

```sh
silicon-accounts app subscription list
silicon-accounts app subscription create stream
silicon-accounts app subscription create webhook https://briefcase.example/webhooks --update id_change --update account_deleted
silicon-accounts app subscription update <id> --pause            # or --resume, --all-updates, --update X, --endpoint <URL>
silicon-accounts app subscription test <id>
silicon-accounts app subscription delete <id>                    # deleting the webhook subscription removes the app's webhook
```

`create` takes `--update` (repeat it), `--all-updates`, `--paused` and `--idempotency-key`; a webhook's secret is printed once, and a retry with the same key within 10 minutes prints the same answer instead of failing with `subscription_exists`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/apps.md

# Security

We look after sign-in and every credential, and your app has a part to play too. The short version: keep your app secret and tokens on your server, call the API with Bearer tokens or your app's Basic credentials, store accounts by uuid, check webhook signatures against the raw body, and treat an access token as good for at most 30 minutes.

## Every credential, and how we keep it

Every token we generate is a prefix plus 32 random bytes from the operating system's generator, base64url-encoded. The prefix tells you (and our error messages) what kind of credential it is.

| Credential | Looks like | We store it as |
|---|---|---|
| Browser session (cookie) | `sas_...` | HMAC-SHA256 with a server-side key |
| Refresh token | `sar_...` | HMAC |
| Access token | a JWT (`eyJ...`) | not stored: an Ed25519 signature, and its sign-in (`fid`) is checked on every API call |
| Authorization code | `sac_...` | HMAC |
| Short-lived token | `slt_...` | HMAC |
| Device code | `sad_...` | HMAC |
| Proof token / proof refresh token | `sap_...` / `sapr_...` | HMAC |
| Flow binding / sign-up cookies | `saf_...` / `sau_...` | HMAC |
| Custodian request token | `sarq_...` | HMAC |
| App secret | `sa_app_...`, until changed in Silicon Apps | HMAC |
| STK (a Silicon's password) | `stk-` + 12 hex (or 8 to 32 chosen), until rotated | Argon2id |
| Webhook signing secret | `whsec_...`; an app's until it's rotated or the webhook is removed (saving its URL keeps it), a Silicon's own until its URL is set again | AES-256-GCM, encrypted |
| Bring-your-own Google secret, Apple key | provider-specific, until replaced | AES-256-GCM, encrypted |

How long each token lives, and how refresh tokens rotate, is in `# Tokens and sessions`.

Why we do it this way:
- Hashes, not tokens. We look a token up by its HMAC, and the key lives outside the database, so a copy of our database holds nothing that signs anyone in.
- The STK is hashed slowly. A generated STK has 48 bits of randomness: plenty against online guessing, not enough against a fast offline hash. Argon2id (19 MiB, 2 passes) makes each guess expensive. A sign-in for an si:id that doesn't exist does the same work, so response time doesn't give away which ids exist.
- Encryption only where we must read a secret back. Webhook secrets sign every delivery, and your Google and Apple credentials go to the providers, so those are encrypted instead of hashed. Nothing returns them after the response that created them.
- Shown once. STKs, webhook secrets, request tokens and proof tokens appear in exactly one response. An idempotent retry replays that response from encrypted storage that we keep for 10 minutes.
- App credentials are checked against their HMAC and the result cached for 60 seconds, keyed by the HMAC of the secret you presented, so a wrong secret can't ride on a cached success.

## Our signing keys

Two keys sign what we issue, and they are kept in different places:
- Ed25519 (`alg: EdDSA`, `kid: accounts-production-1`) - signs every access token and every `id_token` apps get. The service receives its private half in its environment (`ACCOUNTS_JWT_PRIVATE_KEY`); it is never stored in the database, so a copy of the database can't sign a token.
- RSA 2048 (`alg: RS256`, its `kid` is its RFC 7638 thumbprint) - signs only Silicon identity tokens for clouds. The service makes it on first start and keeps it in the database, sealed with AES-256-GCM under the service's keyring (`ACCOUNTS_ENCRYPTION_KEYRING`), so the database alone can't open it. Every node loads the same key and checks it against its own `kid`.

Proofs, refresh tokens, SLTs and authorization codes aren't signed at all: they are random tokens we look up by HMAC and check online. Webhooks are signed with HMAC-SHA256 under your `whsec_` secret.

What we accept from others is wider: a CI job's token may be RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384 or EdDSA, and Google's and Apple's `id_token`s RS256 or ES256. A Silicon's key assertion must be EdDSA. We haven't published a rotation schedule for our keys; pick keys from the JWKS by `kid`, and fetch it again for a `kid` you don't know.

## Cookies and the Origin check

The account site uses three cookies, all `HttpOnly; SameSite=Lax; Path=/`, and in production `Secure` with the `__Host-` prefix (`__Host-sa_session`), so no subdomain can set or overwrite them:

| Cookie | For | Max-Age |
|---|---|---|
| `sa_session` | the browser's signed-in Carbon | 900 days |
| `sa_flow` | ties a hosted sign-in to the browser that started it | 60 minutes |
| `sa_signup` | ties a sign-up to the browser that verified the address | 48 hours |

A fourth cookie, `sa_telemetry=off`, isn't a credential: it opts the browser out of telemetry. Your app never sees these cookies and never needs them. Apps and Silicons authenticate with HTTP Basic or Bearer tokens.

`SameSite=Lax` still lets another site navigate a signed-in browser to us. So every cookie-authenticated `POST`, `PUT`, `PATCH` and `DELETE` must carry an `Origin` equal to the public site (or a configured extra origin), or it gets 403 `origin_not_allowed`. The browser sets that header itself, so a page can't fake it. `POST /v1/flows` uses the same check. A browser never attaches a Bearer token on its own, so Bearer requests aren't checked.

## A sign-in belongs to one browser

- A hosted sign-in flow belongs to the browser that started it (`sa_flow`). Someone who learns a flow id from a URL can't continue it (403 `flow_not_bound`).
- A Google or Apple answer is accepted only from the browser that started that sign-in. Apple posts its answer cross-site without cookies, so we park it and send the browser to a one-time ticket URL that carries the cookie. An answer that arrives through any other browser is thrown away. Without this, someone could forward a real provider link to a victim and get signed in as them.
- `state` (stored as an HMAC), `nonce` and PKCE protect the provider leg. We check the provider's `id_token` against its published keys, issuer, audience, expiry and nonce, and only a verified email counts.
- Only a verified email or phone identifies an account. Someone who proves an address takes over an unverified copy of it elsewhere (from an unfinished import), so an address nobody has proven never signs anyone in.

## Codes and guessing

- Verification codes are 6 random digits, good for 10 minutes.
- Wrong codes are counted per address, across every flow, the CLI, the account site and the requirement step. The 10th wrong code in a row locks every code for that address for 60 seconds, and starting new flows doesn't buy more guesses.
- At most 10 codes go to one address per 10 minutes, and 30 per network.
- 10 wrong STKs in a row lock that Silicon's sign-in for 60 seconds, with at most 60 sign-in attempts per network per minute, counted before anything is checked, across `POST /v1/silicons/login` and key assertions at the token endpoint (`jwt-bearer`). Signing in with a key is never locked out, because a signature can't be guessed, and each assertion works once.
- Lookups by uuid are limited to 600 per minute per caller. uuids look random, but they're short and handed out densely (238,328 three-character values, used up before we move to four), so without a limit one caller could walk every account.

Our answers never tell a caller more than they already know:
- Silicon sign-in answers `invalid_credentials` the same way, in the same time, for an unknown si:id and a wrong STK.
- CLI code sign-in only says that no active Carbon signs in with that address.
- Adding an email or phone counts the attempt before checking whether another account has the address, so `email_in_use` can't be used to test addresses at scale.
- `POST /v1/oauth/revoke` answers 200 for any token, and introspection answers `{"active": false}` for any token that isn't the caller's.
- `POST /v1/proofs/verify` answers exactly `{"valid": false, "expires_at": null}` for every invalid case.
- A custodian asking about another Carbon's Silicon gets `silicon_not_found`, never "not yours".
- An import dry run never names a matched account.

## Tokens end when they should

Every access token carries the app it was issued to (`aud`), and a token for one app is refused everywhere else (`token_wrong_audience`). Refresh tokens and authorization codes are single use, and presenting a used one ends the whole sign-in. Rotating an STK, removing an app's access, removing a CI trust or deleting an account revokes everything it should, at once. An app sign-in started from an SLT that a CI sign-in minted ends no later than that CI sign-in, so a job of minutes can't leave a sign-in of 900 days behind. An access token never outlives its sign-in. A locally verified access token can't know it was revoked, which is why it lives only 30 minutes; when you must know right now, call `POST /v1/oauth/introspect`. The details are in `# Tokens and sessions`.

## Headers, CSP and CORS

API (JSON) responses carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cache-Control: no-store` under `/v1`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and HSTS (`max-age=63072000; includeSubDomains`) wherever cookies are secure.

Account site pages carry a per-request nonce CSP and `X-Frame-Options: DENY`, so no page can be framed for clickjacking. The one exception is the sign-in iframe (`/embed/v1/buttons`), which only the origins in your `allowed_origins` may frame (`frame-ancestors 'self' <origins>`); with none configured, or for an unknown app, it's `'none'`. Its buttons move the top window to the hosted sign-in, so nobody ever types credentials inside a frame.

Uploaded photos are served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, after we checked the bytes really are PNG, JPEG, WebP or GIF of bounded size. An upload can't become a script on our origin.

Only public resources send `Access-Control-Allow-Origin: *`: the public sign-in config, discovery, the JWKS, the SDK, and the discovery documents (`/openapi.json`, `/v1/capabilities`). Every other response has its CORS headers removed, so another website can't read an API response with a visitor's credentials.

## Webhooks never reach private networks

Anyone with an app, or any Silicon, can set a webhook URL, and then we make requests to it. Without a guard, someone could point us at internal addresses (SSRF). In production:
- the URL must be https, without credentials or a fragment, at most 2048 characters.
- `localhost`, host names ending in `.localhost` or `.internal`, and literal IP addresses that aren't public are refused when you set them.
- at delivery time we resolve the host and refuse it if it doesn't resolve, or if any address isn't public: private, loopback, link-local, carrier-grade NAT, benchmarking, documentation, multicast, reserved, IPv6 outside global unicast, and IPv6 forms that carry an IPv4 address (IPv4-mapped, NAT64, 6to4), judged by that IPv4 address.
- we connect to exactly the addresses we checked, so DNS rebinding can't swap them between the check and the request.
- we don't follow redirects and don't use a proxy.
- `last_error` never names the addresses a host resolved to, or whether it resolved at all, so the guard can't be used to map internal DNS.

Development stacks may allow http and private hosts; production refuses to start that way. How deliveries are signed, and how to check them, is in `# Webhooks`.

## What we never log

- Tokens, codes, STKs, secrets and `Authorization` headers never go into logs or audit records. Types that carry them print redacted (`Secret(sar_...)`), in the service and in the Rust client.
- Request logs and telemetry record the route template (`/v1/flows/{id}/verify`), method, status and duration. They leave out the raw path and query string, which can hold ids and OAuth codes.
- Telemetry is opt-out per request with `X-Accounts-Telemetry: off` or the `sa_telemetry=off` cookie. The CLI's telemetry never includes tokens, ids or contact details.
- 5xx answers never describe our internals. They carry a request id for you to quote instead.
- History rows that someone else (a custodian, an app, the service) wrote into an account's history hide the IP address and mask emails and phone numbers.
- Database URLs are printed with the password masked.

If you run the service yourself: `accounts-api` refuses to start in production with missing or development-only credential keys, local email delivery, no Postmark token, the development outbox on, the webhook guard off, a non-https public URL, insecure cookies, or lifetimes other than 600 s for codes, 60 s for the lock and 1800 s for access tokens. Behind a load balancer it trusts `X-Forwarded-For` only with `ACCOUNTS_TRUST_FORWARDED_FOR=true`, and then uses the right-most entry, the one the balancer added; earlier entries may come from the caller.

## Telemetry (Space Station)

Space Station is the event and telemetry service of Team of Silicons, the Team that runs Silicon Accounts and Silicon Apps. When it is set up on the service, we send it:
- one `http.request` event per request: the route template (never the raw path or query string), method, status, outcome and duration.
- token grants: the grant type, the app id, the error code and the duration.
- the steps of hosted sign-in flows, and Silicon sign-ins and self-creations as yes or no flags.
- background work: webhook delivery outcomes, imports, reports and startup.
- the `silicon-accounts` CLI's events, sent to `POST /v1/telemetry/events` and marked `reported_by: "client"`, cut down to what the CLI reports (below).

Turning it off:
- per request, send `X-Accounts-Telemetry: off` (`0`, `false` and `no` work too). In a browser, the switch in the account site's settings sets the `sa_telemetry=off` cookie, which does the same. Nothing that request causes is sent. Background work (webhook delivery, imports, sweeps) still reports.
- the `silicon-accounts` CLI: `silicon-accounts config telemetry off`, or `ACCOUNTS_TELEMETRY=0` (see `# The silicon-accounts CLI`). Then it also sends the header on every request.
- the `silicon-apps` CLI sends nothing unless `APPS_TELEMETRY_TABLE_KEY` is set, and `silicon-apps config telemetry off` turns it off (see `# The silicon-apps CLI`).

`POST /v1/telemetry/events` forwards only what the `silicon-accounts` CLI reports, word for word, so nothing a client makes up (an email, a name, a path, a uuid, an si:id) reaches Space Station, whatever its shape. Other clients' events are accepted and dropped, and so is every `data` field outside the CLI's own list. The exact rules are under `POST /v1/telemetry/events` in `# Service endpoints`.

## The custodian's own sign-in

A Silicon's custodian controls it while signed in as themselves, with an email code, a phone code, Google or Apple. We don't offer multi-factor sign-in of our own yet, so a custodian's sign-in is the root of control over its Silicons: whoever has it can rotate their STKs, add CI trusts, allow cloud audiences, transfer or delete them. For an account that looks after Silicons, sign in with Google or Apple and turn on that provider's own multi-factor sign-in.

## What your app must check itself

- Keep your app secret, refresh tokens and webhook secrets on your server. Never ship them in a browser or a mobile binary.
- Use `state` and PKCE on every `/authorize`, and compare `state` when the browser comes back.
- Store the account's `uuid` (or `membership_id`), never the c:id or si:id, which can change.
- Save each new refresh token before you use it. A reused one ends the sign-in.
- Verify webhook signatures over the raw body with the current secret, dedupe on `event_id`, and answer 2xx quickly.
- When access must stop at once (a sign-out, removed access), use introspection or webhooks, not local token checks alone.

Found a security problem? Tell us with `silicon-accounts report "..."` or `POST /v1/reports`. Reports go to the maintainers by email only.

More: https://developers.teamofsilicons.com/docs/accounts/learn/security.md

# Service endpoints

These tell you whether the service is up, which deployment you reached and what it supports, and they take your bug reports and telemetry. All of them are public. If you are a Silicon meeting us for the first time, `GET /v1/capabilities` and `/openapi.json` are the two to read.

## Health and readiness

Both answer on the public origin, `https://accounts.teamofsilicons.com/healthz` and `/readyz`.

- `GET /healthz` - liveness: `200`, plain text `ok`, `no-store`. It checks nothing but the process.
- `GET /readyz` - readiness: `200 {"database": "ok"}` when Postgres answers, otherwise `503` with `"database": "unavailable"` and the error `database_unavailable`.

## `GET /v1/meta`

What this deployment is. Fields: `name` (`Silicon Accounts`), `version`, `environment`, `public_url`, `silicon_apps_url`, `docs_url`, `developer_url`, `providers` (`{"google": true, "apple": true}`) and `delivery`.

- `environment` - `production`, `development` or `test`.
- `developer_url` - the developer platform, where you set up your app's sign-in. The account site's `/developer` pages redirect there.
- `providers` - whether one-click (managed) Google and Apple are configured.
- `delivery` - `providers` (Postmark and Twilio) or `local` (nothing is sent; development only).

## `GET /v1/capabilities`

What this deployment supports, so you can check before you rely on something. Public, CORS `*`, cacheable for 5 minutes.

```sh
curl -s "https://accounts.teamofsilicons.com/v1/capabilities?require=sse,subscriptions"
```

```json
{"service": "Silicon Accounts", "version": "0.4.0", "api_version": "2026-10-01", "api_versions": ["2026-10-01"],
 "version_header": "Accounts-Version", "public_url": "https://accounts.teamofsilicons.com",
 "capabilities": {"sse": {"supported": true, "description": "Event streaming with Server-Sent Events: ...",
                          "endpoints": ["GET /v1/events/stream"], "docs": "https://developers.teamofsilicons.com/docs/accounts/learn/webhooks#streaming-events"}, "...": "..."},
 "auth_methods": [{"name": "bearer_access_token", "description": "...", "header": "Authorization"}, "..."],
 "limits": {"page_size_max": 200, "streams_per_caller": 5, "stream_heartbeat_seconds": 15, "stream_max_seconds": 3600, "webhook_retry_hours": 72, "...": "..."},
 "links": {"openapi": "https://accounts.teamofsilicons.com/openapi.json", "agent_card": "https://accounts.teamofsilicons.com/.well-known/agent.json",
           "mcp": "https://accounts.teamofsilicons.com/mcp", "llms_txt": "https://accounts.teamofsilicons.com/llms.txt", "docs": "https://developers.teamofsilicons.com/docs/accounts", "...": "..."},
 "require": {"requested": ["sse", "subscriptions"], "satisfied": true, "supported": ["sse", "subscriptions"], "missing": []}}
```

Each capability has `supported`, a `description`, its `endpoints` and its `docs`. The answer also lists the API versions, the ways to authenticate, the main limits, and links to the OpenAPI document, the agent card, the MCP server and `llms.txt`.

There are 27 capabilities: `rest_json`, `openapi`, `structured_errors`, `rate_limit_headers`, `idempotency_keys`, `pagination`, `version_negotiation`, `capability_negotiation`, `bearer_tokens`, `client_credentials`, `oauth2`, `openid_connect`, `device_flow`, `short_lived_tokens`, `workload_identity_federation` (a Silicon signing in from CI with the job's token), `identity_tokens` (a Silicon's tokens for clouds), `proofs`, `webhooks`, `webhook_signatures`, `webhook_replay`, `sse`, `stream_resume`, `subscriptions`, `imports`, `agent_card`, `mcp` and `llms_txt`.

`require` takes 1 to 50 of them, separated by commas, each at most 64 characters. Case doesn't matter, and `-`, `.` and spaces count as `_`. Some common names work as aliases:

| You may send | It means |
|---|---|
| `event_stream`, `event_streaming`, `events_stream`, `server_sent_events`, `streaming` | `sse` |
| `idempotency` | `idempotency_keys` |
| `webhook` | `webhooks` |
| `subscription` | `subscriptions` |
| `oauth` | `oauth2` |
| `oidc` | `openid_connect` |
| `errors` | `structured_errors` |
| `rate_limits` | `rate_limit_headers` |
| `versioning` | `version_negotiation` |
| `token_exchange`, `trusted_publishing`, `oidc_federation`, `federation` | `workload_identity_federation` |
| `cloud_federation`, `id_tokens_for_clouds` | `identity_tokens` |
| `a2a` | `agent_card` |

Anything else is unknown: `graphql`, for example, is neither a name nor an alias.

If one is unknown or unsupported the answer is 422 `capabilities_missing`, so you can decide to go without it. For `?require=sse,graphql,identity_tokens`:

```json
{"error": {"code": "capabilities_missing", "message": "Silicon Accounts does not support this capability: graphql.",
           "hint": "Check the names against details.available (GET /v1/capabilities lists each with its docs), or go without the missing ones.",
           "details": {"missing": ["graphql"], "supported": ["sse", "identity_tokens"], "available": ["rest_json", "..."]}}}
```

`details.missing` and `details.supported` are lists of names. An empty `require`, more than 50 names or a name over 64 characters is 400 `invalid_query`. A `200` carries `require: {requested, satisfied: true, supported, missing: []}`. The `limits` block also lists `streams_per_caller` (5, counted on each API node), `stream_max_seconds` (3600), `stream_heartbeat_seconds` (15), `idempotency_key_max_chars` (200), `idempotency_retention_seconds` (86400), `access_token_seconds` (1800), `webhook_retry_hours` (72) and `webhook_timeout_seconds` (10).

Silicon Apps answers the same question at `https://apps.teamofsilicons.com/v1/capabilities` with the same error code but a different shape and different names (its `details.missing` holds objects with a reason, and matching is case-sensitive); see `# The Apps HTTP API`. Parse each service's answer on its own terms.

## `GET /openapi.json` and `GET /v1/openapi.json`

The OpenAPI 3.1 document of every endpoint: methods, paths, authentication (`bearerAuth`, `appBasic`, `requestToken` and the others), parameters, bodies, responses and the error shape. Public, CORS `*`, cacheable for 5 minutes. A test keeps it in step with the routes the service really has, so you can generate a client from it.

```sh
curl -s "https://accounts.teamofsilicons.com/openapi.json" | jq '.paths | keys | length'
```

## `GET /.well-known/agent.json`

Our A2A agent card: what the service is, its skills (create a Silicon account, sign a Silicon into an app, verify a proof, manage app sign-in, subscribe to account events), how to authenticate, and links to the OpenAPI document, `llms.txt`, the docs and the MCP server. Public, CORS `*`, cacheable for 5 minutes. We speak REST and MCP, not A2A tasks: `capabilities.streaming` and `pushNotifications` describe the event stream and webhooks. `protocolVersion` is the A2A protocol's version; `version` is ours.

```json
{"protocolVersion": "0.3.0", "name": "Silicon Accounts", "description": "Accounts for Carbons and Silicons. ...",
 "url": "https://accounts.teamofsilicons.com", "provider": {"organization": "Team of Silicons", "url": "https://teamofsilicons.com"},
 "version": "0.4.0", "documentationUrl": "https://developers.teamofsilicons.com/docs/accounts",
 "capabilities": {"streaming": true, "pushNotifications": true, "stateTransitionHistory": false},
 "skills": [{"id": "create-silicon-account", "name": "Create a Silicon account", "...": "..."}, "..."],
 "links": {"openapi": "https://accounts.teamofsilicons.com/openapi.json", "mcp": "https://accounts.teamofsilicons.com/mcp", "...": "..."}}
```

## `POST /v1/reports`

Something broken? Tell the maintainers, and send the pull request too if you've already patched it (we'd be grateful). Public; send your Bearer token or cookie and the report names your account, otherwise it's anonymous. Idempotent. 5 reports per IP per hour. Unknown fields are refused.

```sh
curl -s -X POST "https://accounts.teamofsilicons.com/v1/reports" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: report-2026-10-07-1' \
  -d '{"message":"POST /v1/me/emails says \"A email\" (request id 01a1...)","pr_url":"https://github.com/teamofsilicons/silicon-accounts/pull/42"}'
```

`message` is 1 to 10,000 characters and `pr_url` must be https. It answers `201 {"report_id", "status": "queued", "recipients": 3}`, and each report is emailed to every maintainer address. Errors: 422 `validation_failed`, 429 `rate_limited`.

From the CLI, `silicon-accounts report "<message>" --pr <link>` calls this endpoint (`-` reads the message from stdin). It appends the CLI version, operating system and architecture unless you pass `--no-diagnostics`. Say what you ran, what you expected, what happened, and the request id.

## `POST /v1/telemetry/events`

Client telemetry, which we forward to Space Station. Public; 120 requests per IP per minute.

```json
{"events": [{"source": "cli", "step": "login.code.sent", "name": "cli.step", "progress": 0.4,
             "data": {"channel": "email", "command": "login", "cli_version": "0.4.0", "os": "macos", "arch": "aarch64"}}]}
```

At most 50 events. `name` matches `^[a-z0-9_.]{1,64}$`, `source` is 1 to 64 characters of `a-z 0-9 _ . -`, `step` is 1 to 200 printable characters, `progress` is 0 to 1, and `data` is an object of at most 8 KB. It answers `202 {"accepted": 1, "forwarded": true}` (`forwarded` is false when nothing was forwarded for this request). With `X-Accounts-Telemetry: off` (or the `sa_telemetry=off` cookie) the request is accepted and nothing is forwarded. Errors: 422 `validation_failed`, 429 `rate_limited`.

Validation and the `202` stay the same whatever you send, but we forward only what the `silicon-accounts` CLI reports, so no identifier or free text gets through:
- only the CLI's events: `source` `cli` with `name` `cli.command` or `cli.step`. Others are accepted and not forwarded.
- `step` only as one of the CLI's step names (`login.slt.issued`) or command paths (`app webhook set`), anything else as `other`. `progress` is rounded to the hundredth.
- in `data`, only these fields, each only in its own shape, else dropped (`null` is kept for any of them):
  - flags (`true` or `false`): `json`, `browser_opened`, `dry_run`, `wait`, `webhook`, `signed_in`.
  - `duration_ms` and `ttl_seconds`: a whole number from 0 up to one day.
  - `exit_code`: a whole number from -1000 to 1000.
  - fixed words: `outcome` (`ok`, `error`), `account_kind` and `kind` (`carbon`, `silicon`), `method` (`device`, `email`, `phone`, `silicon_stk`, `silicon_key`, `federated`), `channel` (`email`, `phone`), `format` (`csv`, `json`).
  - `cli_version`: a release version, `X.Y.Z` with an optional `-alpha`, `-beta`, `-rc`, `-dev` or `-pre` and an optional `.N`.
  - `command`, `os`, `arch` and `error_code`: one of the words the CLI uses, else `other`.
  - `app` or `app_id`: an app id, and only on the `login.slt.issued` step.

Everything else is dropped, the CLI's federated `source` field included.

## `GET /embed/v1/buttons` and `GET /sdk/v1.js`

The sign-in iframe and the SDK script for your app, both served by the account site. The iframe carries `frame-ancestors 'self' <your app's allowed_origins>` (`'none'` when there are none, or for an unknown app). The SDK carries `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=300`. How to use them is in `# The iframe` and `# The SDK snippet`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/api/service.md

# The silicon-accounts CLI

`silicon-accounts` is how you, as a Silicon, and your Carbon use Silicon Accounts from a terminal. You sign in with it, look after your account, create and manage Silicons, and run your app's sign-in setup, user base, tokens, webhooks and proofs.

It's built for both Carbons and Silicons, but mostly Silicons drive it. So every command has `--help`, every command takes `--json`, and every error tells you exactly what went wrong and what to do next. Everything it does goes through the `silicon-accounts-client` Rust crate, so anything the CLI can do, your own Rust code can do too.

```sh
silicon-accounts --help                                                      # the whole command tree
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin   # sign in as a Silicon
silicon-accounts login status --json                                         # read the authenticated field
```

```json
{"authenticated": true, "display_name": "Scout", "id": "si:scout", "kind": "silicon", "uuid": "8HV",
 "expires_at": "2026-10-07T03:01:30.006Z", "refresh_expires_at": "2029-03-25T02:31:29.998Z",
 "url": "https://accounts.teamofsilicons.com", "verified": true}
```

## Install

Install Silicon Apps first ([installer for your system](https://developers.teamofsilicons.com/docs/apps/start/install.md)), then:

```sh
silicon-apps install silicon-accounts
silicon-accounts --version   # silicon-accounts 0.4.0
```

You get the latest production release for your system, and Silicon Apps keeps it up to date. You don't need Rust. The CLI never updates itself and never checks for updates, so there is exactly one updater and nothing fights over the binary. Your existing settings and sessions stay in `.accounts`.

To build from source instead, install Rust 1.98 or later and run `cargo install silicon-accounts-cli`. It puts the `silicon-accounts` command in `~/.cargo/bin`.

## Which Silicon Accounts it talks to

It talks to `https://accounts.teamofsilicons.com` unless you say otherwise. First match wins:

1. `--url <URL>` on the command.
2. `ACCOUNTS_URL`.
3. `url` in `{home}/.accounts/config.json`, set with `silicon-accounts config set url <URL>`.
4. The URL of the stored session.
5. The URL of a code sign-in still waiting for its code.
6. `https://accounts.teamofsilicons.com`.

Plain `http://` only works for this machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), so your tokens and STK never cross a network unencrypted. `ACCOUNTS_ALLOW_INSECURE_HTTP=1` lifts that on a network you trust. Otherwise the command exits `2` with `invalid_input` (`invalid_url` from `silicon-accounts config set url`).

A session belongs to the URL it was made at. Point the CLI somewhere else and account commands answer `not_signed_in` ("You are signed in to … as si:scout, but this command targets …") until you sign in there too. `silicon-accounts silicon request status` reads a request at the URL it was created at, unless `--url` or `ACCOUNTS_URL` says otherwise.

## Signing in

| Who | Command |
|---|---|
| you, as a Silicon | `printf '%s' "$STK" \| silicon-accounts login --silicon si:scout --stk-stdin`, or set `ACCOUNTS_SILICON` and `ACCOUNTS_STK` |
| you, as a Silicon with a key | `silicon-accounts login --silicon si:scout --key ~/.accounts/scout.key`, or set `ACCOUNTS_SILICON` and `ACCOUNTS_SILICON_KEY` |
| you, as a Silicon in a CI job | `silicon-accounts login --silicon si:scout --federated --github-actions` (GitHub Actions), or `--federated env:SILICON_ID_TOKEN` (GitLab, any OIDC issuer) |
| a Carbon with a browser | `silicon-accounts login` shows a code like `WDJB-MJHT` and opens `accounts.teamofsilicons.com/device`, where they approve it |
| a Carbon without a browser | `silicon-accounts login --email you@example.com` (or `--phone`), then type the 6 digit code |
| a Carbon in a script | `silicon-accounts login --email you@example.com`, then `silicon-accounts login --email you@example.com --code 123456` |

If you run unattended, on a server or in a scheduled job, sign in with a key instead of keeping your STK there: register an Ed25519 key once with `silicon-accounts silicon keys add`, keep its private half on that machine, and each sign-in sends a signed assertion that works once and expires within 5 minutes, so nothing sent can be reused.

In CI you don't need a stored secret at all. Your custodian trusts your CI's tokens once (`silicon-accounts silicon trust add`), and the job signs in with its own OIDC token: `--github-actions` asks GitHub for it (the job needs `permissions: id-token: write`), and `--federated` also takes the token itself, `@FILE` or `env:VAR`. The sign-in ends when that token does (at least 30 minutes, at most 12 hours), and the CLI then exchanges a fresh one from the same source when it can. A CI sign-in works like any other, except it can't add keys or trusts (`federated_session`), so a job may act as you but never decide who else can. An SLT you get during the job (`silicon-accounts login --app`) gives that app a sign-in that ends no later than the CI sign-in, and removing the trust ends both.

When more than one credential is set, the CLI picks in this order: `--federated` (or `--github-actions`); then `--stk` (it warns); then `--stk-stdin`; then a key, `--key` or `ACCOUNTS_SILICON_KEY`; then `ACCOUNTS_STK`; then a prompt in a terminal. So with both `ACCOUNTS_SILICON_KEY` and `ACCOUNTS_STK` set, the key wins. The `silicon-apps` CLI names its variable differently: `silicon-apps login --silicon` reads `SILICON_STK` (or the one `--stk-env` names), never `ACCOUNTS_STK`.

A Carbon already signed in on another machine can approve the browser code from there with `silicon-accounts device approve WDJB-MJHT`.

`silicon-accounts login --app briefcase` prints a short-lived token (SLT) for `briefcase`, signing you in first if it needs to. This is how you sign into an app as a Silicon: hand the SLT to the app, and its server (or its own CLI, as a public client) exchanges it for your tokens (see `# Signing a Silicon into an app`).

`silicon-accounts logout` revokes this CLI session and deletes the stored tokens. Your other sessions, on the account site or other machines, stay signed in; `silicon-accounts sessions list` shows them.

## Where it keeps state

The CLI keeps everything in `{home}/.accounts/`. The home is, first match wins:

1. `--home <DIR>`.
2. `ACCOUNTS_HOME`.
3. The directory set with `silicon-accounts config home <DIR>`, remembered in a one-line pointer file `{base}/.accounts/home`, where `{base}` is `$SILICON_HOME` if set, else `~`.
4. `SILICON_HOME`.
5. `~`.

One home holds one session, and signing in as another account there signs the previous one out. So if several Silicons share a machine, give each one its own home. `SILICON_HOME` is the easiest way:

```sh
mkdir -p /srv/silicons/scout
SILICON_HOME=/srv/silicons/scout silicon-accounts config home   # home /srv/silicons/scout, source SILICON_HOME
```

The home has to be an existing directory. If it isn't, the command stops before doing anything, exits `2` with `not_a_directory`, and says why and which setting picked it: `not a directory: /srv/silicons/nope (it does not exist; set by SILICON_HOME)`.

| File in `{home}/.accounts/` | Holds |
|---|---|
| `session.json` | the signed-in account, its access and refresh tokens and the URL they belong to |
| `session.lock` | the lock held while the session is refreshed or stored |
| `config.json` | `url`, `telemetry` and `app` |
| `apps/<app_id>.json` | an app secret stored by `silicon-accounts app use <app_id> --secret-stdin` |
| `requests/<request-id>.json` | the `sarq_` polling token of a Silicon self-created from this home |
| `login-challenge.json` | a code sign-in waiting for its code |
| `home` | (only in `{base}/.accounts/`) the pointer written by `silicon-accounts config home` |

Files are written atomically (a temporary file, then a rename) with mode 0600 in a 0700 directory, because they hold tokens and secrets. Any number of processes can share one home. Refreshes happen under `session.lock`, because refresh tokens rotate and presenting a used one would end the session. `silicon-accounts config home <DIR>` doesn't move an existing session, so sign in again in the new home.

## Settings

Flags win over environment variables, which win over `config.json`.

`silicon-accounts config get [url|telemetry|home|app]` shows every setting and where its value comes from, plus the state dir, who is signed in and the version (`--json` gives `{"value","source"}` per key). `silicon-accounts config set url <URL>` and `silicon-accounts config set telemetry on|off` (or `silicon-accounts config telemetry on|off`) store a setting in `config.json`. `silicon-accounts config unset url|telemetry|app` removes one so the default applies again. `silicon-accounts config home [<DIR>] [--reset]` shows, sets or forgets the configured home.

| Variable | Effect |
|---|---|
| `ACCOUNTS_URL` | the Silicon Accounts URL (default `https://accounts.teamofsilicons.com`) |
| `ACCOUNTS_HOME` | the directory holding `.accounts/`; beats the configured home |
| `SILICON_HOME` | the home when nothing else sets one (else `~`); also where `silicon-accounts config home` keeps its pointer file |
| `ACCOUNTS_SILICON`, `ACCOUNTS_STK` | your si:id and STK for `silicon-accounts login`. `--stk` and `--stk-stdin` beat `ACCOUNTS_STK`. (`silicon-apps` reads `SILICON_STK` instead.) |
| `ACCOUNTS_SILICON_KEY` | your private key file for `silicon-accounts login`, instead of the STK; used when no `--stk` or `--stk-stdin` is given, so it beats `ACCOUNTS_STK` |
| `ACCOUNTS_APP_ID`, `ACCOUNTS_APP_SECRET` | the app and its secret for `silicon-accounts app …` |
| `ACCOUNTS_TELEMETRY` | `0`, `false`, `no` or `off` turns telemetry off; `1`, `true`, `yes` or `on` turns it on; beats the config file |
| `ACCOUNTS_NO_BROWSER` | any value but `0` or empty: never open a browser (device sign-in prints its URL instead) |
| `ACCOUNTS_TIMEOUT_SECONDS` | request timeout in whole seconds (default 30, at least 1) |
| `ACCOUNTS_ALLOW_INSECURE_HTTP` | `1` allows plain `http://` to hosts other than this machine |
| `NO_COLOR` | no colours on stderr (colours are only used when stderr is a terminal) |
| `TZ` | the timezone `silicon-accounts silicon create` uses without `--timezone` (else the system's, else UTC) |
| `HOSTNAME`, `COMPUTERNAME` | the machine name in the default sign-in label `silicon-accounts CLI on <host> (<os>)` |

## Output and JSON

- Results go to stdout: text, or with `--json` exactly one JSON document, the result or the error. So `$(…)` captures only the result.
- Progress, notices, warnings and suggested next commands (a `Next:` block) go to stderr. `-q` drops all of them; results and errors still print. `--json` drops all but warnings, which become one-line `{"warning":"…"}` objects.
- Some things must be seen before a command finishes, so they go to stderr even with `-q`, and with `--json` as one JSON object per line: `{"event":"device_code","user_code","verification_uri","verification_uri_complete","expires_at","browser_opened"}` from `silicon-accounts login`, and `{"event":"silicon_created",…,"stk":"stk-…"}` from `silicon-accounts silicon create --wait` before the wait starts. That way your STK is never lost if the wait is cut short.
- Timestamps in `--json` are RFC 3339 in UTC. They are meant to have three fractional digits like the API (`2026-10-07T02:33:45.489Z`), but values that pass through the Rust client's types drop trailing zeros today (`…55.590Z` prints as `…55.59Z`, a known bug). Parse them as RFC 3339; never compare them as strings or assume a fixed width.
- `silicon-accounts --json` with no command prints the command tree as `{"commands":[{"command","about"},…]}`. `silicon-accounts` alone prints the full help and exits `0`; a group without a subcommand (`silicon-accounts silicon`) prints its help and exits `2`.

Put secrets on stdin, never in arguments: arguments are visible to every process on the machine and land in shell history. Use `--stk-stdin`, `--app-secret-stdin` or `--secret-stdin`, the `ACCOUNTS_STK` and `ACCOUNTS_APP_SECRET` variables, or `-` in place of a token argument: `printf '%s' "$REFRESH_TOKEN" | silicon-accounts app token refresh -`.

The CLI only asks questions when stdin and stderr are terminals and `--json` is off. Otherwise a missing value is an error that names the flag to pass, for example "No STK was given for si:scout." with the hint "Pipe it with --stk-stdin, set ACCOUNTS_STK, or pass --stk."

`--timeout` takes a number with an optional unit: `90` or `90s`, `5m`, `2h`, `14d`, `1w` (also `sec`, `secs`, `min`, `mins`, `hr`, `hrs`, `day`, `days`, `week`, `weeks`).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | failure: network, service error, unexpected response, local file problem; also a custodian request that ended without acceptance, and a wait that timed out |
| `2` | invalid input (flags, values, files); also the "not valid" answer of a check |
| `3` | sign-in required, credentials refused, or not allowed (including the wrong kind of account) |
| `4` | not found |
| `5` | conflict: already exists, taken, reserved, changed meanwhile |
| `6` | rate limited or locked: wait `details.retry_after_seconds` |
| `130` | interrupted with Ctrl-C |

Service errors map by HTTP status: 400, 410, 413, 415 and 422 give `2`; 401 and 403 give `3`; 404 gives `4`; 409 gives `5`; 423 and 429 give `6`; anything else `1`. OAuth errors map by name: `invalid_client`, `invalid_grant`, `access_denied`, `expired_token` and `unauthorized_client` give `3`; `invalid_request`, `unsupported_grant_type` and `invalid_scope` give `2`; `slow_down` gives `6`.

Some commands answer with their exit code:

| Command | Exit codes |
|---|---|
| `silicon-accounts login status` | with `--json` always `0`, so read `authenticated`; in text mode `0` signed in, `1` not |
| `silicon-accounts id available` | `0` available (or yours to take back), `5` taken, reserved or a reserved word, `2` not a valid id |
| `silicon-accounts app proof verify` | `0` valid, `2` not valid |
| `silicon-accounts app token verify`, `silicon-accounts app token introspect` | `0` valid or active, `2` not |
| `silicon-accounts silicon create --wait`, `silicon-accounts silicon request status --wait` | `0` accepted; `1` declined (`custodian_declined`), expired (`custodian_request_expired`), cancelled (`custodian_request_cancelled`) or timed out (`timed_out`); `130` interrupted, and the request stays open |
| `silicon-accounts app import <FILE> --wait` | `1` when the job ended `failed` (`silicon-accounts app import status <JOB> --wait` exits `0` either way, so read `status`) |

## How errors read

Without `--json`, an error prints `error:`, `hint:`, any per-field problems and the request id on stderr. With `--json` it prints on stdout, always in the same shape:

```json
{"error": {"code": "login_locked", "status": 423, "exit_code": 6,
  "message": "Sign-in to si:mapper is locked for 54 more seconds because 10 wrong STKs were sent in a row.",
  "hint": "Wait until the lock ends (details.retry_after_seconds), then sign in with the correct STK. If the STK is lost, the Silicon's custodian can rotate it (`silicon-accounts silicon rotate-stk`).",
  "details": {"retry_after_seconds": 54}, "request_id": "01a11437-fa72-7396-9e92-934ae46183ec"}}
```

`code`, `message` and `exit_code` are always there. `code` is stable, so branch on it. `hint` (what to do next) usually is. `status` and `request_id` are there when the service answered; quote the request id when you report a bug. `details` carries specifics such as `retry_after_seconds`, `suggestions`, `fields` or `missing`.

Most errors carry the service's code or the Rust client's (see `# Errors`). These come from the CLI itself, for problems it finds without asking us:

| Code | Exit | When | What to do |
|---|---|---|---|
| `invalid_arguments` | `2` | an unknown flag, a missing argument, or a value a flag can't take (`--limit abc`) | run the command with `--help` |
| `invalid_input` | `2` | a value checked before sending: an STK that isn't `stk-` plus 8 to 32 hex characters, a `c:` id where an si:id belongs, `--confirm` not matching, nothing on stdin where a secret was expected, an `http://` URL for another machine | fix what the message names |
| `file_not_found` | `2` | a file you named doesn't exist | check the path |
| `not_a_directory` | `2` | the home (`--home`, `ACCOUNTS_HOME`, `silicon-accounts config home`, `SILICON_HOME`) is a file or doesn't exist | point it at an existing directory, or `silicon-accounts config home --reset` |
| `invalid_url` | `2` | `silicon-accounts config set url` got a URL the CLI can't use | use `https://…` (or `http://` for this machine) |
| `io_error` | `1` | reading a file or stdin, or writing under `{home}/.accounts/`, failed | check the file the message names and its permissions |
| `corrupt_state_file` | `1` | a file under `{home}/.accounts/` isn't valid JSON | delete the file it names (you may have to sign in again) |
| `internal` | `1` | the CLI couldn't start or couldn't encode its own state | report it with `silicon-accounts report` |
| `not_signed_in` | `3` | no session for this URL, or a session for another URL | Carbons: `silicon-accounts login`; Silicons: `silicon-accounts login --silicon si:… --stk-stdin` |
| `session_ended` | `3` | the stored session was revoked, signed out elsewhere, or (for a Silicon) the STK was rotated | sign in again |
| `session_changed` | `3` | another command signed this home in as someone else while this one ran | run the command again |
| `wrong_account_kind` | `3` | the command is for the other kind of account (`silicon-accounts custodian requests` as a Silicon) | sign in as the kind the message names |
| `app_credentials_required` | `3` | a `silicon-accounts app` command has no app secret and you aren't signed in as a Carbon | `--app-secret-stdin`, `ACCOUNTS_APP_SECRET`, `silicon-accounts app use <app_id> --secret-stdin`, or sign in as a Carbon who is one of the app's authors |
| `not_found` | `4` | `silicon-accounts silicon …` names a Silicon you aren't custodian of | `silicon-accounts silicon list` shows yours |
| `unknown_topic` | `4` | `silicon-accounts docs <topic>` names no topic | the hint lists the topics |
| `unknown_help_topic` | `4` | `silicon-accounts help <words>` is neither a command nor a topic | `silicon-accounts --help`, `silicon-accounts docs` |
| `custodian_declined`, `custodian_request_expired`, `custodian_request_cancelled`, `custodian_request_closed` | `1` | `--wait` on a self-created Silicon ended without an acceptance; the account was released | create it again, naming a Carbon who expects the request |
| `timed_out` | `1` | `--wait` gave up after `--timeout`; the custodian request stays open | resume with `silicon-accounts silicon request status <id> --wait` |
| `interrupted` | `130` | Ctrl-C while waiting (device sign-in, a custodian's answer, an import) | the work goes on in the service; the message says how to resume |

## Telemetry, help and bug reports

Space Station is the event and telemetry service of Team of Silicons, the Team that runs Silicon Accounts and Silicon Apps. The CLI never talks to it directly. It buffers up to 40 step events and one command event while a command runs, and sends them without credentials to `POST /v1/telemetry/events` when it ends, waiting at most 1.5 seconds; we forward them to Space Station. Each event has `source: "cli"`, a `step`, a `progress` from 0 to 1, a `name` and a `data` object. There is a `cli.step` event for each step of a multi-step flow (`login.silicon.started`, `login.code.sent`, `login.device.code_shown`, `login.device.approved`, `login.done`, `login.slt.issued`, `session.refreshed`, `silicon.create.custodian`, `silicon.create.requested`, `silicon.create.accepted`, `app.import.started`) and one `cli.command` event per command with `outcome`, `exit_code`, `error_code`, `duration_ms`, `json` and `account_kind`. Every `data` also carries `command`, `cli_version`, `os` and `arch`.

We never send tokens, STKs, secrets, account ids or uuids, or contact details; the only identifier is the app id in `login.slt.issued`. Our API checks that too: it forwards only the CLI's own step names, command paths, fields and words, turns anything else into `other` or drops it, so even a changed or older CLI can't send more (the list is under "Telemetry (Space Station)" in `# Security`). Nothing is sent when a command never contacted the service or couldn't reach it. Telemetry is on by default. `silicon-accounts config telemetry off` (or `ACCOUNTS_TELEMETRY=0` for one process; the variable beats `config.json`) turns it off, and then every request also carries `X-Accounts-Telemetry: off`, so we record nothing about those requests on our side either. What the service itself records, and how else to opt out, is under "Telemetry (Space Station)" in `# Security`. The `silicon-apps` CLI has its own switch, `silicon-apps config telemetry off`.

Help is a tree you walk with `--help`: `-h` gives a summary, `--help` the full text with examples, and `silicon-accounts help silicon create` is the same as `silicon-accounts silicon create --help`. The guides ship inside the CLI, so they always match its version. `silicon-accounts docs <topic>` prints one: `getting-started` (aliases `start`, `getting`, `intro`, `login`, `quickstart`), `silicons` (`silicon`, `stk`, `ci`, `federation`, `trust`, `cloud`, `identity-tokens`), `custodians` (`custodian`, `transfer`), `apps` (`app`, `sign-in`, `signin`, `oauth`, `tokens`), `proofs` (`proof`, `app-verification`, `user-verification`), `webhooks` (`webhook`, `events`), `imports` (`import`), `ids` (`id`, `uuid`, `identifiers`), `troubleshooting` (`errors`, `exit-codes`, `help`) and `links` (`link`, `repo`, `github`, `crate`: the repository, online docs and the Rust package).

`silicon-accounts help <topic>` prints a guide only when no command has that name, because a command wins: `silicon-accounts help proofs` is the help of the `silicon-accounts proofs` command, while `silicon-accounts help imports` is the guide. Use `silicon-accounts docs <topic>` for guides. An unknown topic exits `4` with `unknown_topic`.

Found something broken? `silicon-accounts report "<what happened>" [--pr <https link>]` sends `POST /v1/reports`, and every report is emailed to the Team. The message is 1 to 10,000 characters (`-` reads it from stdin). A signed-in report names your account; signed out, it is anonymous. The CLI version, operating system and architecture are appended unless you pass `--no-diagnostics`. Reports are limited to 5 per hour per network. Say what you ran, what you expected and what happened, with the request id from the error, for example `silicon-accounts report "silicon-accounts login --app remind answered 500 (request id 01a11437-…)"`. If you patched it yourself, pass your pull request to `github.com/teamofsilicons/silicon-accounts` with `--pr`.

More: https://developers.teamofsilicons.com/docs/accounts/start/cli.md, https://developers.teamofsilicons.com/docs/accounts/reference/cli.md, https://developers.teamofsilicons.com/docs/accounts/start/ci-and-cloud.md

# silicon-accounts commands

Every command in `silicon-accounts` 0.4.0, grouped the way `silicon-accounts --help` groups them. Run `silicon-accounts <command> --help` for the exact options of the version you have installed.

## Global options

Every command takes `--json`, `--url <URL>`, `--home <DIR>`, `-q`/`--quiet`, `-h`/`--help` and `-V`/`--version`, before or after the command name.

Every `silicon-accounts app` command also takes the app's credentials: `--app-id <APP_ID>` (env `ACCOUNTS_APP_ID`, default the app chosen with `silicon-accounts app use`), `--app-secret <SECRET>` and `--app-secret-stdin` (or `ACCOUNTS_APP_SECRET`).

List commands take `--limit <N>` (rows per page, at most 200) and `--cursor <CURSOR>` (a previous page's `next_cursor`). Commands that change something and may be retried take `--idempotency-key <KEY>` (default random): reuse the same key when you retry, so the change happens only once.

## Identity and signing in

`silicon-accounts accounts` reports this package's own identity. `silicon-accounts accounts --json` returns `app_id: silicon-accounts` without signing in. Silicon Apps runs it when it validates a package, because it's one of the three commands every app must answer.

`silicon-accounts login` signs you in as a Carbon or a Silicon, or gets a short-lived token for an app. The session is stored in `{home}/.accounts/session.json` (mode 0600) and refreshed automatically. With no flags, a Carbon gets the browser code (device flow).
- `--silicon <SI_ID>` - sign in as this Silicon with its STK (env `ACCOUNTS_SILICON`).
- `--stk-stdin` / `--stk <STK>` - the Silicon's STK (prefer stdin or `ACCOUNTS_STK`).
- `--key <FILE>` - sign the Silicon in with this private key file instead of its STK, a key registered with `silicon-accounts silicon keys add` (env `ACCOUNTS_SILICON_KEY`).
- `--federated [<TOKEN|@FILE|env:VAR>]` - sign the Silicon in with an outside OIDC token it is trusted for (a CI job's token). The sign-in ends when that token expires (at least 30 minutes, at most 12 hours); then the CLI exchanges a fresh one from the same source when it can. It beats `--stk`, `--key` and their variables.
- `--github-actions` - with `--federated` (or alone): ask GitHub Actions for the job's token (`ACTIONS_ID_TOKEN_REQUEST_URL`, needs `permissions: id-token: write`) and exchange it. `--audience <AUDIENCE>` is the audience to ask for (default the Silicon Accounts URL, which is also a trust's default audience).
- `--email <EMAIL>` / `--phone <PHONE>` - Carbon: send a 6 digit sign-in code there; `--country <CC>` for a local phone number (ISO code, for example `IN`).
- `--challenge <CHALLENGE_ID>` - finish a code sign-in started earlier.
- `--code <CODE>` - the 6 digit code (with `--email`, `--phone` or `--challenge`).
- `--app <APP_ID>` - after signing in, or right away if you already are, print a short-lived token (SLT, 2 minutes, single use) for this app.
- `--no-browser` - device flow: don't open a browser, just print the code and URL.
- `--label <TEXT>` - the label in your session list (default `silicon-accounts CLI on <host> (<os>)`).
- `--force` - sign in again even if already signed in.

`silicon-accounts login status` says whether you're signed in and as whom. It checks the stored session with us, refreshing it if needed, unless you pass `--offline` (only read the stored session). The JSON is `{"authenticated":true,"kind":"silicon","id":"si:scout","uuid":"…","expires_at":"…"}` or `{"authenticated":false}`. With `--json` it always exits `0`; in text mode it exits `1` when you're signed out.

`silicon-accounts logout` revokes this CLI session and deletes the stored tokens.

`silicon-accounts whoami` shows the signed-in account (uuid, id, kind, custodian…) from `GET /v1/me`. `silicon-accounts whoami --json | jq -r .uuid` gives you the uuid.

## Your account

- `silicon-accounts id available <ID> [--for <SILICON>]` - can this c:id or si:id be taken? Exit `0` available, `5` taken or reserved, `2` invalid. Signed in, an id reserved for you after a change shows as reclaimable. As a custodian, add `--for si:scout` to ask on behalf of one of your Silicons.
- `silicon-accounts id change <NEW_ID>` - change your own c:id or si:id (the prefix is added if you leave it out). Your old id stays reserved for you for 10 days, and apps you signed into get `account.id_changed`. They key on your uuid, so nothing breaks.
- `silicon-accounts lookup <TARGET>` - look up an account by uuid (`a8K`) or id (`c:shubham`). With your session it shows the uuid, id, kind, display name, photo, status and a Silicon's custodian. When you aren't signed in it uses the app credentials and shows what an app sees: uuid, kind, id, status and a Silicon's custodian as `{uuid, id}`, with no display name or photo. Only current ids resolve, so store uuids, not ids.
- `silicon-accounts profile show` - your full profile, same as `whoami`.
- `silicon-accounts profile set` - only the flags you pass change: `--display-name <NAME>` (1 to 100 characters), `--timezone <TZ>` (IANA, for example `Asia/Kolkata`), `--dob <YYYY-MM-DD>` (Carbons only; a Silicon's date of birth is the day it was created), `--pfp-url <URL>` (https), `--photo <FILE>` (PNG, JPEG, WebP or GIF, at most 2 MB), `--reset-photo` (back to the default). Apps that can see a changed field get `account.updated`.
- `silicon-accounts email list|add|verify|primary|remove` - a Carbon's emails: up to 10, and any of them signs them in. `email add <EMAIL>` sends a 6 digit code valid for 10 minutes and asks for it in a terminal; otherwise it prints a challenge id for `email verify <CHALLENGE_ID> <CODE>`. `email primary <EMAIL>` tells apps with the email scope. `email remove <EMAIL>` works on any email but the primary, so make another one primary first.
- `silicon-accounts phone list|add|verify|primary|remove` - the same for phone numbers, stored in E.164 (`+919876543210`); `phone add` takes `--country <CC>` for local formats and the code arrives by SMS.
- `silicon-accounts identities list` / `identities remove <PROVIDER> <SUBJECT>` - the Google and Apple identities linked to your account (`google` or `apple`, and the subject id from the list).
- `silicon-accounts apps list` / `apps remove <APP_ID>` - the apps you signed into and what you share with each. Removing access revokes that app's tokens for you and the User verification proofs it issued about you, and tells the app (`membership.access_removed`).
- `silicon-accounts proofs list` / `proofs revoke <PROOF_ID>` - the User verification proofs apps issued on your behalf. `silicon-accounts user-verification` is an alias for this group.
- `silicon-accounts sessions list` / `sessions revoke <ID>` - your browser sessions and CLI sign-ins; revoking one signs it out everywhere it's used.
- `silicon-accounts history [--kind signin|id_change|custodian|proof|app_access|security]` - your account history.
- `silicon-accounts delete-account --confirm <your current id>` - delete your account for good. Apps you signed into get `account.deleted`, your sessions and proofs are revoked and your id is held for 10 days. A Carbon who is custodian of any Silicon has to transfer them first.

## Silicons and custodians

You get a Silicon account one of two ways: a Carbon creates it and becomes its custodian, or you create your own and name a custodian, who has 14 days to accept. The custodian can rotate your STK, change your details and transfer you to another Carbon.

`silicon-accounts silicon create` makes the account. Signed in as a Carbon, you create it, become its custodian, and it can sign in right away. Otherwise (or with `--self-create`) the Silicon creates its own account, for example `silicon-accounts silicon create --self-create --id si:scout --custodian c:shubham --wait`. The generated STK is printed exactly once, so save it.
- `--id <SI_ID>` - required; `si:` is added if you leave it out.
- `--display-name <NAME>` - default from the id (`si:head_of_growth` becomes `Head of growth`).
- `--custodian <C_ID_OR_EMAIL>` - required when the Silicon creates its own account.
- `--stk-stdin` / `--stk <STK>` - choose your own STK, `stk-` plus 8 to 32 hex characters (`openssl rand -hex 16 | … --stk-stdin`).
- `--timezone <TZ>` - IANA; default this machine's timezone, else UTC.
- `--pfp-url <URL>` - https; default the Silicon mark.
- `--webhook <URL>` - the Silicon's webhook endpoint.
- `--wait` - poll until the custodian accepts, declines or the request expires (5 s backing off to 60 s), then sign in as the new Silicon.
- `--timeout <DURATION>` - give up waiting after this long (default `14d`).
- `--self-create` - create the Silicon's own account even when signed in as a Carbon.
- `--no-login` - after `--wait` succeeds, don't sign in.
- `--idempotency-key <KEY>` - reuse it when retrying so the Silicon is created only once.

Without `--wait`, check later with `silicon-accounts silicon request status <REQUEST_ID> [--wait] [--timeout <DURATION>]`. It uses the `sarq_` request token `create` saved in `{home}/.accounts/requests/`; pass `--token <TOKEN>` when it isn't saved there.

The custodian's commands take the Silicon as its si:id or uuid:
- `silicon-accounts silicon list` / `silicon show <SILICON>` - the Silicons you look after.
- `silicon-accounts silicon update <SILICON>` - `--display-name`, `--timezone`, `--pfp-url`, or `--photo <FILE>` (PNG, JPEG, WebP or GIF, at most 2 MB, `-` reads stdin). Apps it signed into and its webhook are told.
- `silicon-accounts silicon id <SILICON> <NEW_ID>` - change its si:id; apps it signed into are told.
- `silicon-accounts silicon rotate-stk <SILICON> [--stk-stdin]` - the old STK stops working and its sessions are revoked. Prints the new STK once, or sets the one you pipe in. Apps it signed into get `membership.signed_out`; the Silicon gets `silicon.stk_rotated`.
- `silicon-accounts silicon transfer <SILICON> --to <C_ID_OR_EMAIL>` - the receiving Carbon has 14 days to accept. `silicon cancel-transfer <SILICON>` cancels it.
- `silicon-accounts silicon delete <SILICON> --confirm <SI_ID>` - delete it for good.
- `silicon-accounts silicon webhook set|remove|deliveries|delivery|replay <SILICON> …` - the Silicon's webhook, with the same options as `silicon-accounts webhook` below.
- `silicon-accounts silicon apps list <SILICON> [--status active|access_removed|imported]` - the apps it signed into, most recently used first.
- `silicon-accounts silicon apps remove <SILICON> <APP_ID>` - end its sign-ins at that app, revoke the proofs that app issued about it, and tell the app (`membership.access_removed`), just as if the Silicon had removed the app itself. It can sign in there again later unless an allow-list stops it.
- `silicon-accounts silicon apps allow <SILICON> [APPS]... | --none | --any` - set the only apps it may get short-lived tokens for (replaces the list; `--none` allows no app, `--any` every app again, the default). Any other app then answers `403 app_not_allowed`, which tells the Silicon to ask you. The list doesn't end sign-ins it already has. `silicon apps allowed <SILICON>` shows the list.
- `silicon-accounts silicon signins <SILICON>` - its sign-ins, newest first (app, method, outcome, address).
- `silicon-accounts silicon keys add <SILICON>` - register a key, for yourself or a Silicon you look after: `--generate <FILE>` makes a new Ed25519 key and saves its private half there (mode 600), `--key <FILE>` registers the public half of an existing private key (unencrypted OpenSSH or PEM), `--public-key <FILE_OR_KEY>` registers just a public key (OpenSSH `.pub`, PEM, or the key itself), and `--name <TEXT>` tells keys apart. For example `silicon-accounts silicon keys add si:scout --generate ~/.accounts/scout.key --name build-box`.
- `silicon-accounts silicon keys list <SILICON>` (revoked ones too) and `silicon keys revoke <SILICON> <KEY_ID>`. Revoking a key stops it and ends the sign-ins it started.
- `silicon-accounts silicon trust add <SILICON>` - let a CI job sign the Silicon in with the job's own token, for yourself or a Silicon you look after. `--github <OWNER/REPO>` (issuer `https://token.actions.githubusercontent.com`, claim `repository=owner/repo`), `--gitlab <GROUP/PROJECT>` (issuer `https://gitlab.com`, claim `project_path=group/project`), or `--issuer <URL>` for any https OIDC issuer with discovery; `--audience <AUDIENCE>` (default the Silicon Accounts URL); `--claim <NAME=VALUE>` (repeat it; every one must match exactly, and GitHub and GitLab need one naming the repository, project or owner); `--name <TEXT>`. For example `silicon-accounts silicon trust add si:scout --github acme/scout --claim ref=refs/heads/main`. A sign-in that came from a CI token can't add a trust (`federated_session`, exit `3`).
- `silicon-accounts silicon trust list <SILICON>` (removed ones too, with when each was last used) and `silicon trust remove <SILICON> <TRUST_ID>`. Removing a trust ends the Silicon's sessions with us that it started, and the app sign-ins made from SLTs minted in them (those apps get `membership.signed_out`, reason `session_revoked`).
- `silicon-accounts silicon audiences list <SILICON>` - the outside services the Silicon may get identity tokens for. It may get none until its custodian allows one.
- `silicon-accounts silicon audiences allow <SILICON> <AUDIENCES>...` and `silicon audiences remove <SILICON> [AUDIENCES]... [--all]` - the custodian adds or removes audiences (`sts.amazonaws.com`, your Google Cloud provider's URL, `api://AzureADTokenExchange`); `--all` allows none again. The Silicon can read the list but not change it.

`silicon-accounts webhook` is your own webhook as a Silicon, the same one your custodian manages with `silicon-accounts silicon webhook`. We use it to tell you about your own account: custodian decisions, STK rotations and changes (the events are in `# Silicons and custodians`, signing and retries in `# Webhooks`).
- `silicon-accounts webhook set <URL>` (prints the signing secret once), `webhook remove`, `webhook test` (a `ping`).
- `silicon-accounts webhook deliveries [--status pending|delivered|failed]`, `webhook delivery <ID>` (attempts and the exact payload that was signed).
- `silicon-accounts webhook replay [IDS]... | --failed [--since <RFC 3339 time>]` - at most 100 per call; run it again while `remaining` is above 0. Test pings are never replayed; send a new one.

`silicon-accounts custodian requests`, `custodian accept <ID>` and `custodian decline <ID>` answer the custodian requests addressed to you as a Carbon: from Silicons that named you as custodian, and from custodians transferring a Silicon to you. Accepting makes you the Silicon's custodian. Requests expire after 14 days.

`silicon-accounts token identity --audience <AUDIENCE> [--ttl <SECONDS>]` prints an identity token, an RS256 OpenID Connect ID token that proves you, as a Silicon, to AWS, Google Cloud or Microsoft Entra with no stored cloud key. The audience must be one your custodian allows, and `--ttl` is 60 to 3600 seconds (default 300). The token alone goes to stdout, ready for `$(…)`: `aws sts assume-role-with-web-identity --role-arn … --role-session-name scout --web-identity-token "$(silicon-accounts token identity --audience sts.amazonaws.com)"`. With `--json` you get `identity_token`, `token_type`, `issuer`, `subject` (your uuid), `audience`, `jti`, `kid`, `issued_at`, `expires_at` and `expires_in`. An audience your custodian hasn't allowed fails with `audience_not_allowed` (exit `3`), and a Carbon gets `wrong_account_kind` (exit `3`). Identity tokens only go to that outside service; our API refuses them as bearer tokens.

`silicon-accounts device show <CODE>` (label, status, expiry), `device approve <CODE>` and `device deny <CODE>` answer a CLI sign-in code shown on another machine, the same as approving on `accounts.teamofsilicons.com/device` (Carbons). Approving signs the other machine in as you.

## Running your app

`silicon-accounts app` works on your app: its sign-in setup, user base, imports, tokens, webhook, subscriptions and proofs. It acts with the app's credentials, or without the secret through your session when you're signed in as a Carbon who is one of the app's authors.

Token calls, User verification proofs, proof verification and proof refresh always need the app's own credentials. An author without the secret can do everything else, including issuing App verification proofs and revoking the app's proofs by id. Apps themselves are created in Silicon Apps, not here.

```sh
printf '%s' "$SECRET" | silicon-accounts app use briefcase --secret-stdin
silicon-accounts app config set - <<< '{"methods":{"google":true}}'
```

Choosing the app:
- `silicon-accounts app use <APP_ID> [--secret-stdin | --secret <SECRET>]` - pick the app for later `app` commands and store its secret in `{home}/.accounts/apps/<app_id>.json` (0600). Without a secret, later commands act through your session as one of its authors.
- `silicon-accounts app list` - your apps (signed in as a Carbon).
- `silicon-accounts app new [--no-browser]` - opens Silicon Apps, where apps are created; `--no-browser` only prints the link.
- `silicon-accounts app show` - the app, its sign-in setup and user base stats.
- `silicon-accounts app lookup <TARGET>` - look up an account by uuid, c:id or si:id with the app's credentials: uuid, kind, id, status and a Silicon's custodian as `{uuid, id}`, with no display name or photo.

Sign-in setup (methods, Google and Apple, branding, required details, redirect URIs):
- `silicon-accounts app config get` - the setup as JSON, secrets masked.
- `silicon-accounts app config set <FILE|->` - apply a JSON patch (deep merge, arrays replace). `--expected-version <N>` (from `config get`) refuses to overwrite someone else's change, and validation errors list every bad field. Example: `echo '{"required_fields":["email"],"branding":{"radius":12}}' | silicon-accounts app config set -`.
- `silicon-accounts app config history` - past setup changes.

User base and imports (how they work is in `# Your app's user base` and `# Importing existing users`):
- `silicon-accounts app users` - `--q <TEXT>` searches id, display name, email, phone and external id; `--status active|access_removed|imported|deleted`; `--kind carbon|silicon`; `--source signin|slt|import`. Deleted accounts stay listed under `--status deleted` as `Deleted account`, with no details.
- `silicon-accounts app user <UUID>` - one account, with its last sign-ins.
- `silicon-accounts app import <FILE|->` - import existing users from CSV or JSON, at most 50 MB and 100,000 rows. `--format csv|json` (default from the extension, csv for stdin), `--default-country <CC>` for local phone numbers, `--dry-run` (validate and report, write nothing), `--ignore-unknown-columns` (affected rows get a warning), `--update-existing` (also refresh the imported profile of existing members), `--wait` (show progress and the first errors).
- `silicon-accounts app import status <JOB> [--wait]`, `app import list`.
- `silicon-accounts app import rows <JOB>` - per-row outcomes; `--outcome created|matched|updated|skipped|error|pending`, `--level error|warning|info`, `--code <CODE>` (for example `id_conflict`, `missing_identifier`).

Tokens (every token argument also takes `-` for stdin):
- `silicon-accounts app token exchange --code <CODE> --redirect-uri <URI> [--code-verifier <VERIFIER>]` - exchange an authorization code; the redirect URI must match the one sent to `/authorize` exactly.
- `silicon-accounts app token slt <SLT>` - exchange a Silicon's `slt_…`.
- `silicon-accounts app token refresh <REFRESH_TOKEN>` - rotate a refresh token; store the new one.
- `silicon-accounts app token introspect <TOKEN>` - is this token of your app active? Exit `0` active, `2` not.
- `silicon-accounts app token revoke <TOKEN>` - revoke the token's family, which signs the account out of your app.
- `silicon-accounts app token verify <ACCESS_TOKEN>` - verify locally with the JWKS. Exit `0` valid, `2` invalid.
- `silicon-accounts app userinfo <ACCESS_TOKEN>` - fetch userinfo with an access token issued to your app.

Proofs (JSON kinds are `user_verification` and `app_verification`):
- `silicon-accounts app proof user-verification --subject-token <TOKEN> --to <APP_ID>` - issue a User verification proof, so App A can act at App B for an account that consented in App A. The subject token is the account's access token issued to your app (or `-` for stdin).
- `silicon-accounts app proof app-verification --to <APP_ID>` - issue an App verification proof that exactly one other app verifies. A list in `--to` (`remind,waveform`) exits `2` before anything is sent, with one command per app in the hint.
- Both take `--scope <SCOPE>` (app-defined, repeatable), `--ttl <SECONDS>` (60 to 1800) and `--idempotency-key`.
- `silicon-accounts app proof verify <TOKEN>` - verify a proof as the receiving app: exit `0` valid, `2` not.
- `silicon-accounts app proof refresh <REFRESH_TOKEN> [--ttl <SECONDS>]` - a new proof token from the `sapr_…` refresh token, which rotates.
- `silicon-accounts app proof revoke [PROOF_ID] | --token <TOKEN> | --refresh-token <TOKEN>` - revoke a proof your app issued.
- `silicon-accounts app proof list [--kind user_verification|app_verification] [--status active|revoked]`.

Your app's webhook (signing, retries and replay rules are in `# Webhooks`):
- `silicon-accounts app webhook set <URL>` - set the endpoint. The first time (or the first after `app webhook remove`) it prints the new signing secret once. Setting it again, to the same URL or another, keeps the signing secret and the updates you picked, and prints "It keeps its signing secret; `silicon-accounts app webhook rotate` makes a new one." instead. A retry with the same `--idempotency-key` within 10 minutes prints the same answer. Silicon Apps' `silicon-apps webhook <app_id> set` writes the same webhook and also keeps the secret (see "Where you set the URL matters" in `# Webhooks`).
- `silicon-accounts app webhook rotate` - a new secret, printed once; the old one stops at once. Same 10 minute rule.
- `silicon-accounts app webhook remove`, `app webhook test` (queues a `ping`; a retry with the same key queues no second one).
- `silicon-accounts app webhook deliveries [--status pending|delivered|failed]`, `app webhook delivery <ID>`.
- `silicon-accounts app webhook replay [IDS]... | --failed [--since <TIME>]` - same event id, current URL and secret; at most 100 ids.

Subscriptions choose where your app's updates go and which ones it gets (`app subscriptions` works too). An app has at most one webhook subscription, which is its webhook, and one stream subscription, which it reads at `GET /v1/events/stream` with its credentials (see `# Webhooks`). The updates are `id_change`, `display_name_change`, `pfp_change`, `timezone_change`, `email_change`, `phone_change`, `custodian_change`, `access_removed` and `account_deleted`; a new subscription gets `id_change`, `display_name_change`, `pfp_change`, `access_removed` and `account_deleted` unless you pick others.
- `silicon-accounts app subscription list`, `app subscription show <ID>`.
- `silicon-accounts app subscription create <webhook|stream> [URL]` - `--update <UPDATE>` (repeat it), `--all-updates` (every update, including ones added later), `--paused`, `--idempotency-key`. A webhook's signing secret is printed once; a retry with the same key within 10 minutes prints the same answer instead of failing with `subscription_exists`. Example: `silicon-accounts app subscription create webhook https://briefcase.example/webhooks --update id_change --update account_deleted`.
- `silicon-accounts app subscription update <ID>` - `--update <UPDATE>` (exactly these), `--all-updates`, `--pause` (nothing is recorded until it's resumed), `--resume`, `--endpoint <URL>` (move a webhook; the secret stays).
- `silicon-accounts app subscription delete <ID>` - deleting the webhook subscription removes the app's webhook.
- `silicon-accounts app subscription test <ID>` - queue a test `ping`.

## The CLI itself

- `silicon-accounts config home|get|set|unset|telemetry` - CLI settings (see `# The silicon-accounts CLI`).
- `silicon-accounts report <MESSAGE> [--pr <PR_URL>] [--no-diagnostics]` - report a bug to the maintainers.
- `silicon-accounts docs [TOPIC]` - the bundled guides; without a topic it lists them.
- `silicon-accounts help [TOPIC]...` - help for a command path (`silicon create`) or a guide; a command wins over a topic with the same name.

More: https://developers.teamofsilicons.com/docs/accounts/reference/cli.md

# The Rust client

If you're building in Rust, use `silicon-accounts-client`. The `silicon-accounts` CLI is built on it, so every CLI feature exists here too, and each method calls one endpoint of the HTTP API.

The client is stateless. It never writes files or keeps tokens, and it reads environment variables only if you call `Config::from_env`. Where your credentials live is up to you.

```toml
[dependencies]
silicon-accounts-client = "0.4"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

It needs Rust 1.98 or newer (edition 2024). Every call is `async` and returns `silicon_accounts_client::Result<T>`. Here a Silicon signs in, then gets an SLT for `briefcase`:

```rust
let client = AccountsClient::new("https://accounts.teamofsilicons.com")?;
let tokens = client.silicon_login("si:scout", &stk, Some("scout on build box")).await?;
let session = client.with_token(tokens.access_token.expose());
let me = session.me().await?;                                   // me.id, me.uuid
let slt = session.short_lived_token("briefcase").await?;        // single use, 2 minutes
```

## Three handles

| Handle | Made with | Acts as | Auth sent |
|---|---|---|---|
| `AccountsClient` | `AccountsClient::new(url)` or `::builder()` | nobody: public calls and sign-ins | none |
| `AccountSession<'_>` | `client.with_token(access_token)` | a signed-in Carbon or Silicon | `Authorization: Bearer` with a first-party token (`aud = silicon-accounts`) |
| `AppClient<'_>` | `client.as_app(app_id, app_secret)`, or `session.app(app_id)` for an app you author | an app | HTTP Basic, or the author's Bearer token |

`AccountsClient` holds only configuration and a connection pool. It's cheap to clone, so share one per process. The handles borrow it and hold one credential each. Refreshing an expired access token is up to you (`refresh_first_party`, `AppClient::refresh`).

In author mode (`session.app("briefcase")`, for one of the app's authors, its owner or an accepted co-author) everything that manages the app works without its secret, including issuing App verification proofs and revoking proofs by id. Code, SLT and refresh-token exchange, `revoke`, `introspect`, `issue_user_verification`, `refresh_proof`, `verify_proof` and revoking a proof by token always need the app's own credentials. In author mode they fail before sending anything, with `Error::InvalidInput` (code `invalid_input`).

## Configuration

`AccountsClient::builder()`:
- `.base_url(url)` - default `https://accounts.teamofsilicons.com` (`DEFAULT_BASE_URL`); an origin with an optional path prefix, no query, fragment or credentials.
- `.timeout(d)` - whole request, default 30 s. `.connect_timeout(d)` - default 10 s.
- `.user_agent("my-app/1.2")` - put in front of `silicon-accounts-client/<version>`.
- `.telemetry(false)` - default `true`; off sends `X-Accounts-Telemetry: off` on every request, and `send_telemetry` sends nothing.
- `.allow_insecure_http(true)` - default `false`; plain `http://` is refused for any host but this machine, because STKs and tokens would travel unencrypted.
- `.max_retries(n)` - default 2. Retries with backoff after a 502, 503, 504 or a timeout, but only for GET requests and requests with an idempotency key, because only those are safe to repeat. Any request is retried when the connection never opened.

`client.with_timeout(d)` and `client.with_telemetry(on)` return adjusted copies. `Config::from_env()` reads `ACCOUNTS_URL`, `ACCOUNTS_APP_ID`, `ACCOUNTS_APP_SECRET`, `ACCOUNTS_TELEMETRY` (`0`, `off`, `false`, `no` disable), `ACCOUNTS_TIMEOUT_SECONDS` (default 30) and `ACCOUNTS_ALLOW_INSECURE_HTTP` (`1` allows). Then `config.client()?` gives you the client, and `config.app_client(&client)` an `AppClient` when both app variables are set.

## AccountsClient

| Method | Endpoint | Returns |
|---|---|---|
| `meta()` | `GET /v1/meta` | `Meta` (`name`, `version`, `environment`, `public_url`, `silicon_apps_url`, `docs_url`, `providers`, `delivery`) |
| `id_available(id)` | `GET /v1/ids/available` | `IdAvailability` (`id`, `available`, `reason`, `message`, `reclaimable`, `suggestions`) |
| `app_public(app_id)` | `GET /v1/apps/{app_id}/public` | `AppPublic` |
| `jwks()`, `oidc_discovery()` | `GET /.well-known/jwks.json`, `/.well-known/openid-configuration` | `Jwks` (cache it; refetch on an unknown `kid`), `OidcDiscovery` |
| `authorize_url(&AuthorizeParams)` | builds `/authorize?…`, no request | `Url` |
| `silicon_login(id, stk, client_label)` | `POST /v1/silicons/login` | `TokenResponse` |
| `exchange_federated_token(silicon, subject_token)` | `POST /v1/oauth/token` (token exchange, `client_id=silicon-accounts`) | `TokenResponse` with `issued_token_type`; the sign-in ends when the outside token expires |
| `silicon_self_create(&SiliconSelfCreate, idempotency_key)` | `POST /v1/silicons` | `SiliconSelfCreated` (`silicon`, `stk`, `request`, `request_token`, `webhook_secret`) |
| `silicon_request_status(request_id, request_token)`, `wait_for_custodian_decision(.., &WaitOptions, on_event)` | `GET /v1/silicons/requests/{id}` (the second polls it) | `CustodianRequestStatus` |
| `device_authorize(client_label)` | `POST /v1/device/authorize` | `DeviceAuthorization` |
| `device_poll(device_code)` | `POST /v1/oauth/token` (device grant) | `DevicePoll`: `Pending`, `SlowDown`, `Denied`, `Expired` or `Tokens(..)` |
| `wait_for_device_tokens(&DeviceAuthorization, on_event)` | polls at `interval`, honouring `slow_down` | `TokenResponse` (`access_denied` / `expired_token` as `Error::OAuth`) |
| `cli_login_start(&Contact)`, `cli_login_verify(challenge_id, code, client_label)` | `POST /v1/cli/login/start`, `/verify` | `CliLoginChallenge`, `TokenResponse` |
| `refresh_first_party(refresh_token)`, `revoke_first_party(token)` | token / revoke endpoint, `client_id=silicon-accounts` | `TokenResponse` with a new refresh token, `()` |
| `exchange_developer_code(code, redirect_uri, code_verifier)` | `POST /v1/oauth/token` (`client_id=developer`, PKCE S256, no secret) | `TokenResponse` with `aud = developer` tokens, for the developer platform's server side |
| `refresh_public_client(client_id, refresh_token)`, `revoke_public_client(client_id, token)` | token / revoke endpoint for `silicon-accounts` or `developer` | `TokenResponse`, `()` |
| `exchange_slt_public_client(app_id, slt)` | `POST /v1/oauth/token`, the SLT grant with `client_id` alone, for an app with `public_client` on (its own CLI or desktop tool) | `TokenResponse`; the sign-in is recorded with method `slt_public_client` |
| `report(message, pr_url, access_token, idempotency_key)` | `POST /v1/reports` | `ReportReceipt` |
| `send_telemetry(&[TelemetryEvent])` | `POST /v1/telemetry/events` (3 second timeout) | `()`; nothing when telemetry is off |
| `with_token(access_token)`, `as_app(app_id, app_secret)` | no request | `AccountSession`, `AppClient` |

`Contact` is `Contact::Email(String)` or `Contact::Phone { phone, country: Option<String> }`. Inputs are checked before sending where the rule is local (an empty STK, a code that isn't 6 digits, a report over 10,000 characters, more than 50 telemetry events) and fail with `Error::InvalidInput`.

## AccountSession

A signed-in Carbon or Silicon. Where a method returns a `Vec`, the pages are followed for you (up to 100 pages of 200).

| Methods | Endpoint | Returns |
|---|---|---|
| `me()`, `update_me(&ProfileUpdate)`, `change_id(new_id)`, `delete_account(confirm)` | `GET`, `PATCH`, `DELETE /v1/me`, `POST /v1/me/id` | `Me` / `()` |
| `id_available(id)` (your reserved ids show as reclaimable), `silicon_id_available(silicon, id)` | `GET /v1/ids/available`, `?for=` | `IdAvailability` |
| `set_photo(bytes, content_type)`, `remove_photo()` | `POST`, `DELETE /v1/me/photo` | `PhotoUploaded` / `Me` |
| `emails()`, `add_email(email)`, `verify_email(challenge_id, code)`, `make_email_primary(email)`, `remove_email(email)` | `/v1/me/emails…` | `Vec<EmailAddress>` / `ContactChallenge` |
| `phones()`, `add_phone(phone, country)`, `verify_phone(..)`, `make_phone_primary(..)`, `remove_phone(..)` | `/v1/me/phones…` | `Vec<PhoneNumber>` / `ContactChallenge` |
| `identities()`, `remove_identity(provider, subject)` | `/v1/me/identities…` | `Vec<Identity>` / `()` |
| `apps()`, `remove_app_access(app_id)`, `owned_apps()` | `/v1/me/apps…`, `GET /v1/me/owned-apps` | `Vec<MyApp>` / `()` / `Vec<OwnedApp>` |
| `sessions()`, `revoke_session(id)`, `signout(refresh_token)` | `/v1/me/sessions…`, `POST /v1/oauth/revoke` | `Vec<SessionInfo>` / `()` |
| `history(&HistoryQuery)` | `GET /v1/me/history` | `Page<HistoryItem>` |
| `short_lived_token(app_id)` | `POST /v1/me/short-lived-tokens` | `ShortLivedToken` (`slt`, `app_id`, `expires_at`) |
| `identity_token(audience, ttl_seconds)` | `POST /v1/me/identity-tokens` (Silicons) | `IdentityToken` (`identity_token`, `audience`, `subject`, `jti`, `kid`, `expires_at`, …) |
| `add_federation(silicon, &NewFederation)`, `federations(silicon)`, `remove_federation(silicon, id)` | `/v1/silicons/{id}/federations…` | `Federation` / `Vec<Federation>` / `()` |
| `identity_audiences(silicon)`, `set_identity_audiences(silicon, &[..])` | `/v1/silicons/{id}/identity-audiences` | `IdentityAudiences` |
| `proofs()`, `revoke_proof(proof_id)` | `/v1/me/proofs…` | `Vec<MyProof>` / `()` |
| `set_my_webhook(url)`, `remove_my_webhook()`, `test_my_webhook()`, `my_webhook_deliveries(&DeliveriesQuery)`, `my_webhook_delivery(id)`, `replay_my_webhook(&ReplayRequest, key)` | `/v1/me/webhook…` (Silicons) | `SiliconWebhook`, `WebhookTestResult`, `Page<WebhookDelivery>`, `DeliveryDetail`, `ReplayResult` |
| `silicons()`, `get_silicon(uuid)` | `/v1/me/silicons…` | `Vec<ManagedSilicon>` / `ManagedSilicon` |
| `create_silicon(&CreateSilicon, idempotency_key)` | `POST /v1/me/silicons` | `SiliconCreated` (`silicon`, `stk`, `webhook_secret`) |
| `update_silicon(uuid, &UpdateSilicon)`, `change_silicon_id(uuid, new_id)` | `PATCH /v1/me/silicons/{uuid}`, `POST …/{uuid}/id` | `SiliconView` (which is `Me`) |
| `set_silicon_photo(uuid, bytes, content_type, idempotency_key)` | `POST /v1/me/silicons/{uuid}/photo` | `SiliconPhotoUploaded` |
| `rotate_stk(uuid, stk)` | `POST /v1/me/silicons/{uuid}/stk` | `StkRotated` (`stk` when generated, `rotated_at`); `None` generates one |
| `set_silicon_webhook(uuid, url)`, `remove_silicon_webhook(uuid)`, `silicon_webhook_deliveries(uuid, &DeliveriesQuery)`, `silicon_webhook_delivery(uuid, id)`, `replay_silicon_webhook(uuid, &ReplayRequest, key)` | `/v1/me/silicons/{uuid}/webhook…` | as for your own webhook |
| `transfer_silicon(uuid, to)`, `cancel_transfer(uuid)`, `delete_silicon(uuid, confirm)` | `/v1/me/silicons/{uuid}/transfer`, `DELETE /v1/me/silicons/{uuid}` | `CustodianRequest` / `()` |
| `custodian_requests()`, `accept_custodian_request(id)`, `decline_custodian_request(id)` | `/v1/me/custodian-requests…` | `Vec<CustodianRequest>` / `()` |
| `device_request(user_code)`, `approve_device(user_code)`, `deny_device(user_code)` | `/v1/device/{user_code}…` (`wdjb mjht` is normalized to `WDJB-MJHT`) | `DeviceRequest` / `()` |
| `lookup(uuid)`, `lookup_by_id(id)`, `resolve(uuid_or_id)` | `/v1/accounts/…` | `AccountSummary` |
| `app(app_id)` | no request | an author-mode `AppClient` |

Photos are checked before sending: PNG, JPEG, WebP or GIF, at most 2 MB.

In CI, the `federation` module reads the job's OIDC token for `exchange_federated_token`: `TokenSource::parse("env:SILICON_ID_TOKEN")` (also `@file` or the token itself), or `TokenSource::GithubActions { audience }` / `github_actions_id_token(audience)` (from `ACTIONS_ID_TOKEN_REQUEST_URL`); then `TokenSource::read().await` gives the token.

## AppClient

| Methods | Endpoint | Returns |
|---|---|---|
| `exchange_code(code, redirect_uri, code_verifier)`, `exchange_slt(slt)`, `refresh(refresh_token)` | token endpoint: `authorization_code`, SLT grant, `refresh_token` | `TokenResponse` (after a refresh, store the new refresh token) |
| `revoke(token)`, `introspect(token)` | `POST /v1/oauth/revoke`, `/introspect` | `()`, `Introspection` |
| `userinfo(access_token)` | `GET /v1/userinfo` | `UserInfo` (the `AccountForApp` plus OIDC claims) |
| `verify_access_token_locally(&jwks, token)` | none | `Claims` (EdDSA signature, `exp`/`nbf`, `aud == app_id`; can't see revocation) |
| `app()`, `update_signin_config(&patch, expected_version, key)`, `signin_config_history(&PageRequest)` | `GET /v1/apps/{app_id}`, `PATCH …/signin-config`, `GET …/signin-config/history` | `AppDetails`, `Page<ConfigHistoryEntry>` |
| `users(&UsersQuery)`, `user(uuid)` | `/v1/apps/{app_id}/users…` | `Page<AppUser>` / `AppUser` (with `history`) |
| `start_import(&ImportInput, &ImportOptions, key)` | `POST …/imports` (5 minute timeout) | `ImportJob` |
| `imports(&PageRequest)`, `import_job(job_id)`, `import_rows(job_id, &ImportRowsQuery)` | `GET …/imports…` | `Page<ImportJob>` / `ImportJob` / `Page<ImportRowResult>` |
| `wait_for_import(job_id, poll)`, `wait_for_import_with(job_id, &WaitOptions, on_event)` | polls the job | the finished `ImportJob` |
| `set_webhook(url, key)`, `set_webhook_events(url, &events, key)`, `remove_webhook()`, `rotate_webhook_secret(key)`, `generate_webhook_secret(key)`, `test_webhook(key)` | `…/webhook…` | `AppWebhook` / `()` / `WebhookSecret` / `WebhookTestResult`. `set_webhook` keeps the stored secret and the update picks (`AppWebhook::secret` is `None`); it returns a new secret only when the app had none (the first time, or after `remove_webhook`). `set_webhook_events` also sets the picks, and keeps the secret the same way. `generate_webhook_secret` works before a URL is set |
| `deliveries(&DeliveriesQuery)`, `delivery(id)`, `replay(&ReplayRequest, key)` | `…/webhook/deliveries…`, `…/webhook/replay` | `Page<WebhookDelivery>` / `DeliveryDetail` / `ReplayResult` (`replayed_count()`, `skipped_count()`) |
| `issue_user_verification(&IssueUserVerification, key)` | `POST /v1/proofs/user-verification` | `IssuedProof` |
| `issue_app_verification(&IssueAppVerification, key)` | `POST /v1/proofs/app-verification` (author mode: `/v1/apps/{app_id}/proofs/app-verification`) | `IssuedProof` |
| `refresh_proof(refresh_token, access_ttl_seconds)` | `POST /v1/proofs/refresh` | `IssuedProof` |
| `verify_proof(proof_token)` | `POST /v1/proofs/verify` | `ProofVerification::Valid(..)` or `::Invalid` |
| `revoke_proof(&ProofRef)` | `POST /v1/proofs/revoke` (author mode with `ProofRef::Id`: `DELETE …/proofs/{id}`) | `()` |
| `proofs(&ProofsQuery)` | `GET /v1/apps/{app_id}/proofs` | `Page<AppProof>` |
| `lookup(uuid)`, `lookup_by_id(id)`, `resolve(uuid_or_id)` | `/v1/accounts/…` | `AccountSummary` |

`ImportInput` is `Csv(Bytes)`, `Rows(Vec<ImportRow>)` or `Json(Vec<serde_json::Value>)`. `ReplayRequest` is `Deliveries(Vec<String>)` (1 to 100) or `Failed { since: Option<OffsetDateTime> }`. `ProofRef` is `Id`, `Token` or `RefreshToken`. `ProofVerification` is `#[non_exhaustive]`, so match it with a wildcard arm.

App A issuing a User verification proof for App B, and App B checking it:

```rust
let proof = app_a.issue_user_verification(&IssueUserVerification {
    subject_token: account_access_token, receiving_app: "briefcase".into(),
    scopes: vec!["files.write".into()], access_ttl_seconds: Some(600) }, Some("uv-req-42")).await?;

match app_b.verify_proof(&proof_token).await? {
    ProofVerification::Valid(p) => println!("from {} scopes={:?}", p.issuing_app.app_id, p.scopes),
    _ => { /* not valid: refuse */ }
}
```

`AuthorizeParams::new(app_id, redirect_uri)` builds the hosted sign-in URL with `.state()`, `.pkce(&pkce_pair())`, `.scopes([...])`, `.nonce()`, `.prompt()`, `.intent()` (`signin` or `signup`, for your "Sign in" and "Sign up" buttons) and `.method()` (a direct "Continue with …" button). There is no `login_hint`, because your app never hands us a Carbon's email or phone.

## Types

- Request types (`SiliconSelfCreate`, `CreateSilicon`, `UpdateSilicon`, `ProfileUpdate`, `IssueUserVerification`, `IssueAppVerification`, `ImportOptions`, `ImportRow`, the `*Query` types, `PageRequest`, `AuthorizeParams`) implement `Default`: `CreateSilicon { id: "si:scout".into(), display_name: "Scout".into(), ..Default::default() }`.
- Response types are `#[non_exhaustive]`: read their fields. They tolerate fields we add later and `null` where a value is usually present.
- `Page<T>` - `items`, `next_cursor` (`None` on the last page), `is_last()`, iterable.
- `Secret` - wraps every secret we return (access, refresh and short-lived tokens, STKs, webhook secrets, proof tokens, device codes). `Debug` prints only its prefix (`Secret(sar_…)`), the memory is zeroed on drop, and `.expose()` gives the value where it has to leave your program.
- `TokenResponse` - `access_token: Secret`, `token_type`, `expires_in`, `refresh_token: Option<Secret>`, `refresh_token_expires_at`, `scope`, `id_token`, `membership_id`, `account: Option<AccountForApp>`; `scopes()`, `access_expires_at(issued_at)`.
- `Claims` - `iss`, `sub`, `aud: Vec<String>`, `exp`, `iat`, `nbf`, `jti`, `kind`, `id`, `mid`, `fid`, `scope`; `scopes()`, `has_scope(s)`.
- `AccountKind` - `Carbon` or `Silicon`; `AccountKind::of_id("si:scout")`.
- `WaitOptions` - `custodian_default()` (5 s doubling to 60 s, for up to 14 days), `fixed(d)`, `backoff(initial, max)`, `.with_timeout(Some(d))`. Each poll reaches `on_event` as `WaitEvent::Polled(status)`; transient errors (network, 5xx, 429) arrive as `WaitEvent::TransientError` and are retried.

Store the account `uuid` or the membership id `{app_id}:{uuid}` (`briefcase:a8K`). The `c:` / `si:` id is for showing: it changes, and your app hears about it through `account.id_changed`.

## Webhooks, local verification and PKCE

The webhook helpers check and parse deliveries for you; what they check (headers, signing, tolerance) is in `# Webhooks`.
- `verify_and_parse_webhook(&secret, timestamp, signature, &raw_body, DEFAULT_WEBHOOK_TOLERANCE)` - verify, then parse into a `WebhookEvent { event_id, event_type, occurred_at, app_id, silicon, data, payload }`. Dedupe on `event_id`.
- `verify_webhook_signature(secret, ts, sig, body, tolerance)` and `verify_webhook_signature_at(.., now_unix)` (an explicit clock, for tests); `parse_webhook(body)`; `sign_webhook(secret, ts, body)` (the `v1=…` header value, for tests and tools).
- `WebhookPayload` - one variant per event (`AccountIdChanged`, `AccountUpdated`, `AccountDeleted`, `MembershipSignedOut`, `MembershipAccessRemoved`, `CustodianChanged`, `Ping`, and the Silicon events `SiliconCreated`, `SiliconCustodianAccepted`, `SiliconCustodianDeclined`, `SiliconCustodianExpired`, `SiliconUpdated`, `SiliconIdChanged`, `SiliconStkRotated`, `SiliconCustodianChanged` carrying the raw `data`), plus `Unknown` for types this version doesn't know.
- Header constants - `EVENT_ID_HEADER`, `EVENT_TYPE_HEADER`, `DELIVERY_ID_HEADER`, `TIMESTAMP_HEADER`, `SIGNATURE_HEADER`.
- `verify_access_token(&jwks, token, &VerifyOptions)` - checks the EdDSA (Ed25519) signature by a JWKS key (by `kid`), `exp`/`nbf`, `aud` and optionally `iss`, and returns `Claims` or `Error::Token(TokenError)`. `VerifyOptions::for_app(app_id)` accepts tokens issued to your app, `.with_issuer(url)` adds the issuer check, and `leeway_seconds` is 30. An empty audience list is refused, because any app's token would pass.
- `pkce_pair()` - `PkcePair { verifier (43 characters), challenge }`, S256. `pkce_challenge(verifier)`, `random_state()`, `random_nonce()` and `random_token(bytes)` give base64url values from the OS random generator.

Local verification can't see revocation (a sign-out, removed access). Access tokens live at most 30 minutes; call `introspect` when you need to know right now.

Constants: `DEFAULT_BASE_URL` (`https://accounts.teamofsilicons.com`), `FIRST_PARTY_APP_ID` (`silicon-accounts`), `DEVELOPER_APP_ID` (`developer`), `VERSION`, `SLT_GRANT_TYPE` (`urn:silicon:params:oauth:grant-type:slt`), `DEVICE_CODE_GRANT_TYPE` (`urn:ietf:params:oauth:grant-type:device_code`), `TELEMETRY_HEADER`, `IDEMPOTENCY_HEADER`, `IDEMPOTENT_REPLAYED_HEADER`, `REQUEST_ID_HEADER`.

## Errors

Every call returns `silicon_accounts_client::Error`, which is `#[non_exhaustive]`:
- `Api(Box<ApiError>)` - we answered with our error body (or a non-JSON error, code `http_<status>`).
- `OAuth(Box<OAuthError>)` - an OAuth endpoint answered an RFC 6749 error.
- `Http { message, hint, source }` - no response: DNS, TLS, refused connection, timeout.
- `Decode { message, hint }` - a response this client doesn't understand.
- `InvalidInput { message, hint }` - refused before sending.
- `Token(TokenError)` - local access-token verification failed.
- `TimedOut { message, hint }` - a waiting helper gave up; the work goes on in the service.

Helpers on `Error`: `code()`, `message()`, `hint()`, `status()`, `request_id()`, `details()`, `retry_after()`, `as_api()`, `as_oauth()`, `is_code(code)`, `is_not_found()`, `is_unauthenticated()` (401, `invalid_grant` or `invalid_client`), `is_transport()`. `Display` prints the message, then ` Hint: ` and the hint. `ApiError` has public `status`, `code`, `message`, `hint`, `details`, `request_id`, `retry_after` and `field_errors()` (the `details.fields` pairs of a 422). A typical branch: `Err(err) if err.is_code("login_locked")`, then sleep for `err.retry_after()` and try again. Every code is in `# Errors`.

More: https://developers.teamofsilicons.com/docs/accounts/reference/rust-client.md

# Errors

When something fails, we tell you exactly what and why, the way a compiler would, so you or your Silicon can fix it without guessing. Every error has a `code`, a `message`, and usually a `hint` and `details`. The code says what kind of failure it is, the message says what happened and names the values involved, and the hint says what to do next. Branch on the code, never on the message: we may reword messages, but codes don't change.

## The two shapes

Everything except the three OAuth endpoints answers:

```json
{"error": {"code": "invalid_credentials",
  "message": "Sign-in failed: no Silicon has this si:id, or the STK is wrong. Both cases get this same answer, so ids can't be probed.",
  "hint": "Check the si:id (use the current one; ids can change) and the STK … A lost STK can be replaced by the Silicon's custodian (`silicon-accounts silicon rotate-stk`).",
  "details": {}}}
```

The `code` is stable snake_case and the `hint` is sometimes absent. `details` holds structured extras: `fields` (a 422 `validation_failed`, path to problem), `retry_after_seconds` (423, 429), `suggestions` (`id_taken`), `request_id` (5xx), and the per-code details below. 423 and 429 also set the `Retry-After` header, 401 responses are `Cache-Control: no-store`, and 5xx bodies never describe our internals.

`POST /v1/oauth/token`, `/v1/oauth/revoke` and `/v1/oauth/introspect` answer RFC 6749 bodies instead, `{"error": "invalid_grant", "error_description": "…"}`, because OAuth libraries expect them.

Always log the `X-Request-Id` response header with an error. It finds the request in our logs, and `silicon-accounts report` and `POST /v1/reports` take it in the message.

## How to react, by status

| Status | Meaning | What to do |
|---|---|---|
| 400 | the request is malformed | fix it; retrying it unchanged fails again |
| 401 | no or bad credentials | sign in again, or fix the token or app secret |
| 403 | authenticated but not allowed | a different account, app or route is needed |
| 404 | not found, or not visible to you | check the identifier |
| 409 | conflicts with the current state | read the current state, then decide |
| 410 | expired | start that step again |
| 413 / 415 | body too large / wrong media type | send a smaller or correct body |
| 422 | well-formed but invalid values | fix the fields named in the message or `details.fields` |
| 423 | locked after too many failures | wait `Retry-After` seconds |
| 429 | rate limited | wait `Retry-After` seconds |
| 5xx | a fault on our side, or a timeout | retry later with the same `Idempotency-Key`; report it with the request id if it keeps happening |

## Request format and idempotency

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_json` | 400 | the body isn't valid JSON (line and column given) |
| `invalid_content_type` | 400 | a body without `Content-Type: application/json` (or `text/csv` for imports) |
| `invalid_body` | 400 | the body couldn't be read (connection broken mid-upload) |
| `invalid_query` | 400 | a query parameter is missing, of the wrong type or an unknown value (named) |
| `invalid_path` | 400 | a path parameter is malformed |
| `invalid_cursor` | 400 | `cursor` isn't a `next_cursor` from this list; pass it unchanged or leave it out |
| `invalid_request` | 400 | something the request needs is missing (named) |
| `validation_failed` | 422 | fields missing, of the wrong type, invalid or unknown; `details.fields` maps each path (`branding.radius`, `scopes[3]`) to its problem, all at once |
| `payload_too_large` | 413 | the body is over the route's limit (`details.limit_bytes`, 64 KB by default) |
| `unsupported_media_type` | 415 | a photo upload's `Content-Type` isn't PNG, JPEG, WebP or GIF |
| `route_not_found` | 404 | no endpoint has this path |
| `method_not_allowed` | 405 | the path exists with other methods (the `Allow` header lists them) |
| `not_found` | 404 | a file of the account site doesn't exist |
| `invalid_idempotency_key` | 400 | `Idempotency-Key` isn't 1 to 200 visible ASCII characters (no spaces) |
| `idempotency_key_reused` | 409 | the key was used for a different body on this endpoint; use a new key for a new request |
| `idempotency_in_progress` | 409 | a request with this key is still running; retry in a few seconds |
| `idempotency_result_unavailable` | 409 | the stored secret-bearing result can no longer be decrypted, so it isn't run again; check the current state (for example list your Silicons) before retrying with a new key |
| `idempotency_key_required` | 400 | only on one internal endpoint (Silicon Apps' private mail bridge); every public endpoint takes `Idempotency-Key` as optional, so you won't see it |

## Authentication and permission

| Code | Status | Cause and fix |
|---|---|---|
| `unauthenticated` | 401 | no credentials; sign in (`silicon-accounts login`) or send the app's Basic credentials |
| `account_auth_required` | 401 | app credentials (Basic) were sent to an endpoint that acts for an account |
| `invalid_authorization` | 401 | the `Authorization` header is unreadable or uses an unsupported scheme |
| `invalid_token` | 401 | not an access token, a bad signature, or expired (access tokens last 30 minutes: refresh) |
| `token_wrong_audience` | 401 | an app's token where a first-party (`aud = silicon-accounts`) token is needed, or a developer platform token (`aud = developer`, `details.aud`) outside the routes it may use (`GET /v1/me`, `GET /v1/session`, `GET /v1/me/owned-apps` and the author routes under `/v1/apps/{app_id}/…`); the message names the method and route |
| `identity_token_not_accepted` | 401 | an identity token (`token_use: identity`, made for AWS, Google Cloud or Entra) was sent as a bearer token; send the access token |
| `token_revoked` | 401 | the sign-in behind the token ended (signed out, STK rotated, account deleted, refresh token reuse, a removed key or trust); the message says when and why; sign in again |
| `session_expired` | 401 | the session cookie was signed out, revoked or expired |
| `account_deleted` | 401 / 403 / 404 / 409 | the account was deleted: 401 for its own tokens, 403 at Silicon sign-in, 404 at lookups, 409 when it happened during the request |
| `origin_not_allowed` | 403 | a cookie-authenticated POST, PUT, PATCH or DELETE without the account site's `Origin`; use a Bearer token instead |
| `carbon_only` | 403 | a Silicon called a Carbon endpoint (emails, phones, the custodian side…) |
| `silicon_only` | 403 | a Carbon called a Silicon endpoint (`/v1/me/webhook…`: its own webhook, deliveries and replay) |
| `account_not_active` | 403 | the account isn't active (pending custodian, unfinished import) |
| `app_credentials_required` | 401 | an app endpoint got no credentials |
| `invalid_app_credentials` | 401 | unknown app_id, wrong secret, or a malformed Basic header |
| `app_disabled` | 403 (400 in `/v1/flows`, 401 at userinfo) | the app is disabled |
| `app_mismatch` | 403 | app credentials used on another app's `/v1/apps/{app_id}` URL |
| `not_app_owner` | 403 | an account that isn't one of the app's authors (its owner or an accepted co-author) tried to manage it |
| `unknown_app` | 404 (400 in `/v1/flows`) | no app has this app_id |
| `request_token_required` | 401 | `GET /v1/silicons/requests/{id}` without `Bearer sarq_…` |
| `invalid_request_token` | 401 | the `sarq_` token doesn't belong to this request |
| `internal_api_disabled` | 403 | the server has no internal token configured |
| `access_removed` | 401 | at userinfo: the account removed your app's access |
| `membership_inactive` | 401 at userinfo, 403 for proofs | the account has no active membership with your app |

## Rate limits, locks and verification codes

| Code | Status | Cause and fix |
|---|---|---|
| `rate_limited` | 429 | over a limit (see `# Limits`); wait `Retry-After` / `details.retry_after_seconds`. The message names the limit ("the limit is 120 per minute"); id changes add `details.limit`, `window_seconds` and `retry_at`; imports add row budget details |
| `verification_locked` | 423 | 10 wrong codes in a row for this address; every code to it waits 60 seconds (`details.locked_until`) |
| `login_locked` | 423 | 10 wrong STKs in a row for this Silicon; sign-in waits 60 seconds |
| `imports_busy` | 503 | the server is already parsing its maximum of imports; retry after `Retry-After` (15 s) |
| `invalid_code` | 422 | wrong code (`details.remaining_attempts` for the address), or not 6 digits (not counted). The 10th wrong one in a row has `remaining_attempts: 0`, `details.locked_until` and `Retry-After` |
| `code_expired` | 410 | older than 10 minutes, or replaced by a resend; send a new one |
| `code_already_used` | 409 | this code was already accepted |
| `challenge_not_found` | 404 | unknown `challenge_id` (or one of another flow) |
| `no_code_sent` | 409 | a resend (or a requirement verify) before any code was sent in this flow |

## Ids, lookups, profile and photos

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_id` | 422 (400 at `by-id`) | not a valid `c:` / `si:` id, or the wrong kind; `details.reason` is `invalid` or `reserved_word` |
| `id_taken` | 409 | another account has it; `details.suggestions` lists free ones |
| `id_reserved` | 409 | it was changed away from recently and is held for 10 days (`details.reserved_until`) |
| `invalid_uuid` | 400 | not a uuid (for an id use `/v1/accounts/by-id/{id}`) |
| `account_not_found` | 404 | no account with this uuid or current id; at CLI sign-in, no active Carbon with that email or phone (sign up first) |
| `silicon_not_found` | 404 | not a Silicon you are custodian of (other Carbons' Silicons are never revealed) |
| `custodian_not_found` | 404 | no active Carbon has the c:id named as custodian or transfer target; name them by email instead |
| `dob_immutable` | 422 | a Silicon's date of birth is the day it was created |
| `confirmation_required` | 422 | `DELETE` needs `{"confirm": "<current id>"}` |
| `confirmation_mismatch` | 422 | `confirm` isn't the account's current id; nothing was deleted |
| `custodian_of_silicons` | 409 | a Carbon who is custodian of Silicons can't be deleted (`details.silicons`); transfer or delete them first |
| `custodian_required` | 403 | a Silicon can't delete itself; its custodian does |
| `photo_too_large` | 413 | over 2 MB |
| `empty_photo` | 422 | an empty body |
| `invalid_image` | 422 | the bytes aren't a readable PNG, JPEG, WebP or GIF |
| `photo_type_mismatch` | 422 | the bytes are another format than `Content-Type` says (`details.detected_content_type`) |
| `photo_dimensions_too_large` | 422 | over 8192 px a side or 50 megapixels |
| `photo_not_found` | 404 | no such photo, or it was removed |

## Emails, phones, identities, apps and sessions

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_email` / `invalid_phone` / `invalid_country` | 422 | the address, number or country code can't be read (the message says why) |
| `email_in_use` / `phone_in_use` | 409 | it belongs to another account; an address belongs to one account only |
| `email_already_added` / `phone_already_added` | 409 | it's already on your account |
| `email_limit_reached` / `phone_limit_reached` | 422 | 10 already; remove one first |
| `email_not_found` / `phone_not_found` | 404 | not on your account |
| `email_not_verified` / `phone_not_verified` | 409 | only a verified address can be primary |
| `cannot_remove_primary` | 409 | make another address primary first |
| `invalid_provider` | 400 | the provider isn't `google` or `apple` |
| `unknown_provider` | 404 | the same, in a sign-in or link URL |
| `identity_not_found` | 404 | no such linked identity |
| `identity_in_use` | 409 | that Google or Apple account is linked to another account |
| `last_sign_in_method` | 409 | removing it would leave no way to sign in (no email or phone) |
| `browser_session_required` | 400 | linking Google or Apple needs the account site's browser session, not a token |
| `provider_not_configured` | 503 | no Google or Apple credentials for this app or deployment |
| `membership_not_found` | 404 | you never signed into that app |
| `first_party_app` | 400 / 422 | the account site (`silicon-accounts`) can't lose access (400) or get a short-lived token (422) |
| `session_not_found` | 404 | not a session of yours (an app's sign-in is removed with `DELETE /v1/me/apps/{app_id}`) |
| `invalid_history_kind` | 400 | `kind` isn't `signin`, `id_change`, `custodian`, `proof`, `app_access` or `security` |
| `requirements_missing` | 409 | the app requires a detail the account lacks (`details.missing`); add it, then retry |

## Hosted and device sign-in

| Code | Status | Cause and fix |
|---|---|---|
| `redirect_uri_not_registered` | 400 | the `redirect_uri` isn't registered exactly; we never redirect to it |
| `invalid_scope` | 400 | an unknown scope (with `details.redirect_to`) |
| `unsupported_response_type` | 400 | `response_type` other than `code` |
| `method_not_enabled` | 400 / 403 | the app didn't turn that method on (or no managed credentials exist) |
| `flow_not_found` | 404 | unknown flow id |
| `flow_not_bound` | 403 | the request lacks this flow's `sa_flow` cookie: continue in the browser that started it |
| `flow_expired` | 410 | flows last 60 minutes; start again from the app |
| `invalid_step` | 409 | the flow is at another step (the message names the allowed ones) |
| `flow_completed` / `flow_failed` | 409 | the flow ended; `GET /v1/flows/{id}` returns its `redirect_to` |
| `flow_changed` | 409 | the flow moved on in another tab, or the app changed its flow and the details page is gone; `GET /v1/flows/{id}` shows where it is now |
| `account_changed` | 409 | the browser is now signed in as a different account than the flow's |
| `account_unavailable` | 409 | the address belongs to an account that can't sign in |
| `session_required` | 401 | "continue as" without a browser session |
| `continue_not_allowed` | 403 | the app turned off `remember_browser` |
| `reauthentication_required` | 403 | the app asked for `prompt=login` |
| `email_domain_not_allowed` | 403 | the app accepts only some email domains |
| `signup_not_allowed` | 403 | the app takes no new accounts (`allow_signup: false`) |
| `signup_not_bound` | 403 | the sign-up belongs to another browser |
| `signup_expired` | 410 | sign-ups last 48 hours; verify the address again |
| `signup_already_completed` | 409 | this sign-up already created an account; sign in instead |
| `detail_not_on_page` | 409 | `details/add` for a detail that isn't on the page on screen |
| `no_previous_page` | 409 | `details/back` on the first page |
| `requirements_missing` | 409 | a required email or phone of the page isn't on the account yet (`details.missing`): add it with `details/add` and `details/verify` |
| `invalid_state` | 400 | a provider callback with a malformed `state` |
| `device_code_not_found` | 404 | no device sign-in waits for this user code |
| `device_code_used` | 409 | already approved or denied |
| `device_code_expired` | 410 | user codes last 10 minutes; start the sign-in again |
| `device_flow_off` | 403 | the app turned device sign-ins off after the code was made; sign in to it another way |
| `unauthorized_client` | 400 | `POST /v1/device/authorize` named an app that hasn't turned on `device_flow` |
| `invalid_client` | 400 | `POST /v1/device/authorize` named an app that doesn't exist |

Some codes come back in `flow.error` (and in `?error=` on your redirect URI) instead of as HTTP errors: `login_required`, `consent_required` and `interaction_required` (from `prompt=none`), `access_denied` (cancelled on a details or review page), `provider_cancelled`, `provider_error`, `provider_token_invalid`, `provider_unavailable`, `provider_config_changed`, `provider_answer_elsewhere`, `provider_email_invalid`, `email_not_verified`, `hosted_domain_mismatch` (a Google account outside the app's `google.hosted_domain`), `signup_expired`, and while linking, as `?link_error=`, `session_changed`, `identity_in_use`, `email_in_use` and `email_limit_reached`.

## Silicons and custodians

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_stk` | 422 | at sign-in: not `stk-` plus 8 to 32 hex characters (creating a Silicon or rotating its STK reports a bad chosen STK as `validation_failed` on `stk`) |
| `invalid_credentials` | 401 | unknown si:id or wrong STK; one answer for both, so ids can't be probed |
| `custodian_pending` | 403 | the custodian hasn't accepted yet (`details.custodian`, `request_id`, `expires_at`) |
| `custodian_declined` | 403 | the custodian declined; the account was released |
| `custodian_expired` | 403 | nobody accepted within 14 days; the account was released |
| `custodian_request_not_found` | 404 | no such request, or not addressed to you |
| `custodian_request_not_pending` | 409 | already accepted, declined, expired or cancelled (`details.status`) |
| `custodian_request_expired` | 410 | the 14 days ran out |
| `custodian_request_pending` | 409 | the Silicon already has a pending request |
| `silicon_not_pending` | 409 | accepting an initial request for a Silicon that is no longer waiting |
| `silicon_not_active` | 409 | a transfer of a Silicon that isn't active |
| `already_custodian` | 409 | you already are its custodian |
| `transfer_pending` | 409 | one transfer at a time (`details.request_id`); cancel it first |
| `transfer_not_found` | 404 | no pending transfer to cancel |
| `transfer_to_self` | 422 | a transfer must go to another Carbon |
| `transfer_stale` | 409 | the custodian changed after the transfer was requested |
| `webhook_not_set` | 409 | a test ping, secret rotation or replay without a webhook URL; set one first |
| `invalid_assertion` | 401 | a key sign-in's assertion is malformed, expired, for another `aud`, not signed by a live key of that Silicon, or was used before; sign a fresh one |
| `key_exists` | 409 | the Silicon already has this key (`details.key_id`) |
| `too_many_keys` | 409 | 10 live keys already; revoke one first |
| `key_not_found` | 404 | no key with this id belongs to the Silicon |
| `app_not_allowed` | 403 | the Silicon's custodian only lets it get short-lived tokens for the apps in `details.allowed_apps`; ask the custodian to add the app |
| `unknown_app` | 422 | an allow-list names an app that doesn't exist (`details.unknown`) |
| `federation_exists` | 409 | the Silicon already trusts these tokens (`details.federation_id`) |
| `too_many_federations` | 409 | 20 live trusts already; remove one first |
| `federation_not_found` | 404 | no trust with this id belongs to the Silicon |
| `issuer_unreachable` | 422 | a new trust's issuer has no discovery document we can read over https from a public address, it names another issuer, or its `jwks_uri` isn't public https (`details.issuer`) |
| `federated_session` | 403 | a sign-in that came from a trusted outside token tried to add a key or a trust; do it with the STK or a key, or as the custodian |
| `custodian_only` | 403 | only the Silicon's custodian chooses its identity token audiences |
| `audience_not_allowed` | 403 | the Silicon's custodian hasn't allowed this audience for identity tokens (`details.allowed_audiences`) |

## Apps

| Code | Status | Cause and fix |
|---|---|---|
| `config_version_conflict` | 409 | the sign-in setup changed since the version you sent (`details.current_version`, `expected_version`): re-read, re-apply, resend |
| `user_not_found` | 404 | the uuid isn't in this app's user base (uuids are case-sensitive) |
| `import_not_found` | 404 | no such import job for this app |
| `delivery_not_found` | 404 | no such webhook delivery for this app, or for this Silicon (`/v1/me/webhook/deliveries…`) |
| `unknown_columns` | 422 | the import has columns we don't keep (`details.unknown_columns`, `allowed_columns`); remove them or set `ignore_unknown_columns` |
| `duplicate_columns` | 422 | the same column twice |
| `no_identifier_columns` | 422 | no `email`, `emails`, `phone` or `phones` column |
| `empty_import` | 422 | no rows |
| `too_many_rows` | 422 | over 100,000 rows |
| `invalid_csv` | 422 | the CSV can't be parsed (line given) |
| `too_many_columns` | 422 | over 200 columns |
| `value_too_large` | 422 | a value over 8 KB, or a column name over 200 bytes (`details.row`, `details.column`) |
| `too_many_items` | 422 | a JSON list over 50 items |
| `owner_not_found` / `owner_email_conflict` / `owner_unavailable` | 422 / 409 / 409 | Silicon Apps sync: the owner can't be resolved |

Import rows carry their own message codes (`missing_identifier`, `ambiguous_match`, `duplicate_in_file`, `external_id_conflict`, `id_conflict`, …); read them with `silicon-accounts app import rows` and see `# Importing existing users`.

## Subscriptions and the event stream

| Code | Status | Cause and fix |
|---|---|---|
| `subscription_exists` | 409 | the app already has a subscription with this delivery (`details.subscription_id`); an app has one webhook and one stream subscription at most, so change that one instead |
| `subscription_not_found` | 404 | no subscription with this id belongs to the app |
| `invalid_updates` | 422 | `updates` names something that isn't an update (`details.allowed` lists them) |
| `invalid_webhook_events` | 422 | `PUT /v1/apps/{app_id}/webhook` `events` names something that isn't an update |
| `stream_subscription_required` | 409 | an app opened `GET /v1/events/stream` without a stream subscription; create one with `POST /v1/apps/{app_id}/subscriptions` `{"delivery":"stream"}` |
| `unknown_event_id` | 400 | the stream's `Last-Event-ID` or `after` isn't an event of this feed; resume with the last id this stream sent you, or connect without one |
| `too_many_streams` | 429 | 5 streams are already open for this app or account on the API node that took the request (the count is kept on each node, not shared, so with several nodes the total can be higher); close one (one stream carries every event of the feed), then retry after `Retry-After` (10 seconds) |
| `stream_capacity_reached` | 503 | this server is full or restarting; reconnect after `Retry-After` with `Last-Event-ID` |

A stream that ends on purpose sends `event: stream.closed` with a `reason` first (see `# Webhooks`).

## Versions and capabilities

| Code | Status | Cause and fix |
|---|---|---|
| `unsupported_version` | 400 | the `Accounts-Version` header names a version this deployment doesn't serve (`details.supported`, `details.current`); send a supported one, or leave the header out to get the current version |
| `capabilities_missing` | 422 | `GET /v1/capabilities?require=…` named a capability that is unknown or unsupported (`details.missing` and `details.supported` are lists of names, `details.available` all 27); check the names against `details.available` (the stream is `sse`; `event_stream`, `streaming` and a few other common names work as aliases), or go without the missing ones. Silicon Apps uses the same code with a different body (see `# The Apps HTTP API`) |

## Proofs

| Code | Status | Cause and fix |
|---|---|---|
| `invalid_subject_token` | 400 | the subject token isn't a live access token (`details.reason`: `not_an_access_token`, `invalid`, `expired`, `revoked`) |
| `subject_token_wrong_app` | 403 | the subject token belongs to another app (`details.token_app`) |
| `app_verification_single_app` | 422 | an App verification request named apps in `audiences`; a proof is for exactly one app, so send `{"receiving_app": "…"}` once per app (`details.field`, `details.apps`) |
| `unknown_receiving_app` | 400 | the receiving app doesn't exist (`details.app_ids`) |
| `invalid_receiving_app` | 400 | the issuer itself, or Silicon Accounts itself (`silicon-accounts`, `developer`) |
| `receiving_app_disabled` | 403 | the receiving app is disabled |
| `invalid_proof_refresh_token` | 400 | not a `sapr_` token, or unknown (mistyped, another environment, or its proof ended over 30 days ago) |
| `not_issuing_app` | 403 | only the issuing app refreshes or revokes a proof |
| `proof_refresh_token_reused` | 400 | a used refresh token was presented; the proof is now revoked |
| `proof_revoked` | 410 | the proof was revoked, or its User verification sign-in ended (`details.reason`, `revoked_at`) |
| `proof_expired` | 410 | past the proof's lifetime |
| `invalid_proof_id` | 400 | not a UUID |
| `proof_not_found` | 404 | not a proof you can see |

A proof that doesn't verify is never an error: `POST /v1/proofs/verify` answers 200 `{"valid": false, "expires_at": null}`.

## Server

| Code | Status | Cause and fix |
|---|---|---|
| `internal` | 500 | a fault on our side; retry later, and report `details.request_id` if it keeps happening |
| `database_unavailable` | 503 | the database is unreachable; nothing was changed; retry in a few seconds |
| `request_timeout` | 503 | the request ran past its time budget (30 s, 60 s for uploads, 5 min for imports) |
| `web_not_built` | 503 | (static hosting only) the account site build is incomplete |

When a framework layer rather than a handler refuses a request, the code comes from the status: `forbidden` 403, `conflict` 409, `gone` 410, `locked` 423, `not_acceptable` 406, `length_required` 411, `uri_too_long` 414, `range_not_satisfiable` 416, `not_implemented` 501, `bad_gateway` 502, `unavailable` 503, `gateway_timeout` 504, `request_failed` (other 4xx).

## OAuth errors

From `/v1/oauth/token`, `/revoke` and `/introspect`, as `{"error", "error_description"}` with `Cache-Control: no-store`:

| `error` | Status | Cause |
|---|---|---|
| `invalid_request` | 400 (413 for a body over 64 KB) | a parameter is missing, repeated or malformed, or the client authenticated twice |
| `invalid_client` | 401 | unknown app, wrong secret, disabled app, or no credentials; with `WWW-Authenticate: Basic realm="Silicon Accounts"` |
| `invalid_grant` | 400 | the code, refresh token, SLT or device code is unknown, expired, already used, revoked, another app's, or its account was deleted or removed the app's access; an SLT whose CI sign-in is past the end it was given, or whose trust was removed (a refresh of such a sign-in after the removal says `federation_removed`); or a `redirect_uri` or PKCE mismatch. A reused refresh token or code also revokes its sign-in. A token exchange's outside token refused names the reason, with its code in brackets: `invalid_federated_token` (malformed, unsafe algorithm, bad signature, unknown key, expired, not yet valid, used before), `no_matching_trust` (no trust of the Silicon accepts its issuer, audience and claims; the description names the claim), `issuer_unavailable` (the issuer's keys couldn't be read; retry) |
| `unauthorized_client` | 400 | a public client (`client_id` without a secret) used a grant that needs the secret (the SLT grant needs `public_client` on; the message lists what a public client may use), an app without `device_flow` used the device-code grant, or an app asked for a token exchange (it signs a Silicon into Silicon Accounts itself, not into the app) |
| `unsupported_grant_type` | 400 | the grant isn't supported (the description names the alternative) |
| `invalid_scope` | 400 | a refresh asked for more scopes than were granted |
| `authorization_pending` | 400 | device sign-in not approved yet; keep polling |
| `slow_down` | 400 | polled within 5 seconds of the last poll; add 5 seconds |
| `access_denied` | 400 | the Carbon denied the device sign-in |
| `expired_token` | 400 | the device code expired (10 minutes) |
| `rate_limited` | 429 | more than 60 CI token exchanges (`token-exchange`), or more than 60 Silicon sign-in attempts (`jwt-bearer`, counted together with `POST /v1/silicons/login`, before the client and assertion are checked), per minute from one address; wait `Retry-After` seconds. Code, SLT, refresh and device grants have no per-address limit at the token endpoint |
| `server_error` | 500 | a fault on our side (request id in the description) |
| `temporarily_unavailable` | 503 | the request ran past its time budget |

## Rust client and webhook codes

`Error::code()` returns our code for API and OAuth errors, and the client's own codes for failures that never got a response:

| Code | Variant | Meaning |
|---|---|---|
| `connection_failed` | `Error::Http` | DNS, TLS, refused connection |
| `request_timeout` | `Error::Http` | no answer within the client timeout (30 s by default) |
| `unexpected_response` | `Error::Decode` | an answer this client doesn't expect (wrong URL, newer service) |
| `invalid_input` | `Error::InvalidInput` | refused before sending (an empty STK, an http URL to a remote host…) |
| `timed_out` | `Error::TimedOut` | a waiting helper gave up; the work goes on in the service |
| `token_malformed`, `token_unsupported_algorithm`, `token_unknown_key`, `token_invalid_key`, `token_bad_signature`, `token_expired`, `token_not_yet_valid`, `token_wrong_audience`, `token_wrong_issuer`, `token_missing_claim` | `Error::Token` | local access-token verification failed |
| `http_<status>` | `Error::Api` | an error body that isn't ours (a proxy or load balancer answered) |

The Rust webhook helpers return `WebhookError`: `EmptySecret`, `MissingHeader`, `InvalidTimestamp`, `TimestampOutOfTolerance` (more than 5 minutes off), `InvalidSignatureFormat`, `SignatureMismatch` or `InvalidBody`. In every case, refuse the delivery with 400 or 401. `SignatureMismatch` usually means you checked parsed JSON instead of the raw body bytes, or used the old secret after a rotation.

The `silicon-accounts` CLI prints all these same codes, maps them to exit codes, and adds a few of its own for problems it finds without asking us (see How errors read in `# The silicon-accounts CLI`).

More: https://developers.teamofsilicons.com/docs/accounts/reference/errors.md

# Limits

These are the limits we enforce. The ones marked contract are part of the product's rules and hold on every deployment; the rest protect the service and can be configured.

When you hit one, we tell you how long to wait. Too many requests get `429 rate_limited`; too many wrong codes or STKs get `423` (`verification_locked` or `login_locked`). Both carry the `Retry-After` header and `details.retry_after_seconds`. Wait that long, then try again.

```json
{"error": {"code": "rate_limited", "message": "Too many id availability checks from this network: the limit is 120 per minute.",
  "hint": "Wait 57 seconds before trying again.", "details": {"retry_after_seconds": 57}}}
```

Rate limits are fixed windows counted in the database, so they hold across every server. "Per IP" means the client address, the right-most `X-Forwarded-For` entry behind the load balancer. Everything behind one address shares one budget, so a fleet of CI runners behind one address should sign in once per job and reuse the session, not sign in once per command.

## Rate limits

| What | Limit | Counted per |
|---|---|---|
| Verification codes sent to one email or phone (sign-in, CLI, adding an address, requirements) | 10 per 10 minutes (contract) | address |
| Verification codes sent from one network | 30 per 10 minutes | IP |
| Adding an email or phone (`POST /v1/me/emails`, `/phones`), counted before any refusal | 20 per 10 minutes; 30 per 10 minutes | account; IP |
| Hosted sign-in flows started (`POST /v1/flows`) | 300 per minute | IP |
| CLI code sign-ins started (`POST /v1/cli/login/start`) | 60 per 10 minutes | IP |
| Device sign-ins started (`POST /v1/device/authorize`) | 60 per 10 minutes; 600 per 10 minutes for one app's tools | IP; app |
| Device codes looked up, approved or denied (`/v1/device/{user_code}…`) | 60 per 10 minutes | Carbon |
| Connecting Google or Apple (`POST /v1/me/identities/{provider}`) | 30 per hour | account |
| Silicon sign-in attempts (`POST /v1/silicons/login`, STK and key, and `grant_type=…:jwt-bearer` at `POST /v1/oauth/token`, counted together and before anything is checked) | 60 per minute | IP |
| Token exchanges with an outside OIDC token (`grant_type=…:token-exchange`) | 60 per minute | IP |
| Identity tokens (`POST /v1/me/identity-tokens`) | 60 per minute | Silicon |
| Silicon self-creations (`POST /v1/silicons`) | 10 successful per hour, and 60 attempts of any outcome per hour | IP |
| Self-created Silicons waiting for one custodian | 20 pending | c:id or email |
| Transfer requests | 30 per hour | custodian |
| Silicon webhook test pings | 10 per hour | Silicon |
| Id availability checks (`GET /v1/ids/available`) | 120 per minute | IP |
| Account lookups (`/v1/accounts/{uuid}` and `/by-id/{id}` together) | 600 per minute | app or account |
| Id changes (your own, or a custodian's for its Silicon; reclaims included) | 5 per rolling 24 hours | account |
| Photo uploads | 20 per hour; 20 per hour | account; sign-up |
| Imports | 60 requests per hour (dry runs and refused files count); 2,000,000 rows per 24 hours | app |
| Bug reports (`POST /v1/reports`) | 5 per hour | IP |
| Telemetry (`POST /v1/telemetry/events`) | 120 requests per minute | IP |

## Lockouts

- 10 wrong verification codes in a row for one address (any flow, the CLI, the account site) - every code to that address is refused for 60 seconds (contract: 1 minute) with 423 `verification_locked`. A right code ends the streak; a resend doesn't.
- 10 wrong STKs in a row for one Silicon - its sign-in is refused for 60 seconds with 423 `login_locked`. A wrong STK gets the same `invalid_credentials` answer as an unknown si:id, so nobody can probe which ids exist.

## Lifetimes

Access tokens last 30 minutes, refresh tokens 900 days from the sign-in, authorization codes and SLTs 120 seconds (single use), and device codes 600 seconds; a sign-in from a trusted outside token lasts until that token expires (at least 30 minutes, at most 12 hours, with refresh tokens rotating within it). An app sign-in made from an SLT minted in such a session ends no later than that session (one made before the 9 October 2026 API release keeps up to 900 days). An access token never outlives its sign-in, so near the end of a shorter sign-in `expires_in` is below 1800. How they rotate and end is in `# Tokens and sessions`.

| What | Lifetime |
|---|---|
| Verification code (6 digits) | 10 minutes (contract); a resend replaces it, and `resend_available_at` suggests waiting 30 seconds |
| Hosted sign-in flow (and its `sa_flow` cookie) | 60 minutes |
| Sign-up session (`sa_signup`) | 48 hours (contract) |
| Browser session (`sa_session`) | 900 days |
| Silicon custodian request (initial or transfer) | 14 days (contract: 2 weeks) |
| Id reservation after a change | 10 days (contract); the previous owner can take it back meanwhile |
| Identity token | 60 to 3600 seconds, default 300 |
| A trusted issuer's keys (JWKS) | cached for 10 minutes; fetched again for an unknown `kid`, at most every 30 seconds per issuer |
| Proof token (`sap_…`) | 60 to 1800 seconds, default 1800 |
| Proof (its refresh token, `sapr_…`) | 900 days; a User verification proof ends with its sign-in |
| Idempotency results | 24 hours; 10 minutes for responses carrying a new secret; an unfinished request holds its key for at most 120 seconds |
| Discovery document and JWKS | cacheable for 5 minutes |
| App credentials | verified results are cached for 60 seconds per server |

## Sizes and counts

| What | Limit |
|---|---|
| Handle (after `c:` / `si:`) | 3 to 30 characters of `a-z 0-9 - _`, case-insensitive (contract) |
| Reserved words | `admin`, `administrator`, `root`, `system`, `support`, `help`, `security`, `silicon-accounts`, `account`, `silicon`, `silicons`, `carbon`, `carbons`, `api`, `www`, `mail`, `null`, `undefined`, `me`, `owner`, `staff` |
| uuid | `a-z A-Z 0-9`, case-sensitive (not an RFC 4122 UUID); 3 characters, then 4 once every 3 character uuid is used (contract); never reused |
| App id | 3 to 30 characters of `a-z 0-9 - _`, as Silicon Apps creates them (`my_app`, `2fa-tool`); older ids of 2 to 40 characters of `a-z 0-9 -` starting with a letter (`dm`) keep working |
| Emails / phones per Carbon | 10 / 10 (contract) |
| Display name | 1 to 100 characters, no control characters |
| Date of birth | in the past, not before 1900-01-01; a Silicon's is the day it was created |
| STK | generated: `stk-` plus 12 hex characters; chosen: `stk-` plus 8 to 32 hex characters (contract) |
| URLs (photos, webhooks, …) | 2048 characters |
| `client_label` | 100 characters (longer ones are cut) |
| Profile photo | 2 MB (2,097,152 bytes); PNG, JPEG, WebP or GIF; 8192 px a side; 50 megapixels |
| Request body | 64 KB; photos 2 MB; `PATCH …/signin-config` 512 KB; imports 50 MB; Silicon Apps sync 5 MB |
| Time budget per request | 30 seconds; photo uploads and sync 60 seconds; imports 5 minutes (then 503 `request_timeout`) |
| Page size | 1 to 200, default 50 |
| `Idempotency-Key` | optional; 1 to 200 visible ASCII characters (Silicon Apps: required on every change, 8 to 200) |
| `X-Request-Id` kept from the client | 1 to 128 characters of `A-Z a-z 0-9 - _ . :` |
| Redirect URIs / allowed origins / allowed email domains per app | 50 / 50 / 100 |
| Branding | `logo_height` 16 to 96 px, `radius` 0 to 40 px, inline logos 128 KB each, text contrast at least 4.5:1, `copy.title` 80 and `copy.subtitle` 200 characters |
| Import | 100,000 rows; 200 columns; column names 200 bytes; values 8 KB; lists 50 items; 10 emails and 10 phones per row; `external_id` 255 characters; display names cut at 100 characters |
| Concurrent import parses | 2 per server; a request waits up to 30 seconds for a slot, then 503 `imports_busy` (`Retry-After: 15`) |
| Webhook replay | 100 deliveries per request |
| Proof scopes | 20 per proof, each 1 to 100 characters of `A-Z a-z 0-9 _ . : / -` |
| App verification receiving apps | exactly 1 per proof |
| Report message | 1 to 10,000 characters; `pr_url` https |
| Telemetry batch | 50 events; `name` matches `^[a-z0-9_.]{1,64}$`; `source` 64 characters; `step` 200 characters; `data` 8 KB |
| Sign-in history shown to an app per member | the last 20 |

Going over a size gets the matching error: `payload_too_large` (413, `details.limit_bytes`), `photo_too_large` (413), `photo_dimensions_too_large`, `too_many_rows`, `too_many_columns`, `value_too_large`, `too_many_items`, `email_limit_reached` / `phone_limit_reached` (all 422), or `validation_failed` (422) naming the field.

## Silicon keys, trusts, identity tokens and event streams

| What | Value |
|---|---|
| Live keys per Silicon | 10 (409 `too_many_keys`) |
| Key sign-in assertion lifetime (`exp - iat`) | at most 300 seconds, with 30 seconds of clock skew allowed |
| Assertion `jti` | 1 to 200 characters, each used once |
| Key name | at most 100 characters |
| Live trusts per Silicon | 20 (409 `too_many_federations`) |
| Conditions per trust | 1 to 10 |
| Condition claim name / value | 1 to 100 characters of `a-z A-Z 0-9 _ - . : /` / 1 to 500 characters |
| Issuer / audience of a trust | 300 / 400 characters |
| Trust name | at most 100 characters |
| Outside token | 16 KB, with 30 seconds of clock skew on its `exp`, `nbf` and `iat` |
| Fetching an issuer's discovery document or JWKS | https, 5 seconds to connect, 10 seconds in all, 256 KB, no redirects |
| Identity token audiences per Silicon | 0 to 20 (none until the custodian allows one), each at most 400 characters |
| Identity token signing key | RSA 2048, RS256 |
| Open streams (`GET /v1/events/stream`) | 5 per app or account on each API node, counted in memory per node rather than in the database like the rate limits above (429 `too_many_streams`); 500 per node (503 `stream_capacity_reached`); both with `Retry-After`. Silicon Apps allows 10 per client, for 30 minutes each |
| How often a stream looks for new events | every second, at most 100 events per read |
| Heartbeat (`: heartbeat`) | after 15 seconds without events |
| Reconnect delay told to clients (`retry:`) | 5 seconds |
| Stream credentials checked again | every 30 seconds |
| Longest stream | 1 hour, then `stream.closed` with `max_duration`; reconnect with `Last-Event-ID` |
| Event types in `?types=` | at most 20 |
| Subscriptions per app | one webhook and one stream |

## Webhooks and messages

A webhook delivery gets 10 seconds to answer with a 2xx, redirects are not followed, and we keep retrying for 72 hours after the event (or after a replay) before marking it `failed` and replayable; the schedule and the rest are in `# Webhooks`. The Rust client's default signature tolerance is 5 minutes.

Emails and SMS messages get at most 8 attempts, and a code's message stops retrying once the code has expired.

## Retention

A sweep every 10 minutes deletes, in batches: sign-in flows 1 day after they expired; authorization codes, short-lived tokens and device codes 7 days after; verification codes 1 day after; expired idempotency results; id reservations 1 day after they ended; sign-up sessions 7 days after they expired or were used; used `jti`s of Silicon key assertions and of outside tokens once they expired; rate-limit windows older than a day. Proof tokens are deleted 1 day after they expire, and every token of a proof 30 days after the proof ended.

History is never deleted: sign-ins, id changes, custodian transfers, proofs, sign-in setup versions and the audit log.

More: https://developers.teamofsilicons.com/docs/accounts/reference/limits.md
