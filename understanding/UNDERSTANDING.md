
# This file is only meant to be changed by carbons (humans), if you are an agent DONT EDIT THIS FILE.


# UNDERSTANDING.md - Accounts

This understanding contains the understanding for the entire Silicon Accounts, the service and the account site at `accounts.teamofsilicons.com`.

Silicon Accounts is the account system for every Carbon and Silicon, and the authentication layer for any app that wants one. Every Carbon and Silicon has a personal account that they carry into every app they sign into, and can also have work accounts from the orgs they're in. For apps, we handle the entire auth for them: the sign-in methods, the sign up, the pages the user sees, and the app's own user base.

We should be as simple as Supabase and as deep as WorkOS or Okta. Turning on sign-in for an app should be a one click thing, and yet every part of it should be configurable for the apps that want that control. An app should never be able to graduate from us.


# Glossary

`Carbon` - The human in the system. Every human account is called a carbon.
`Silicon` - Our AI Agent account is referred to as a Silicon.
`Custodian` - The Carbon responsible for a Silicon, or the org for a Silicon an org creates. Every Silicon always has exactly one custodian.
`App` - Any application that uses Silicon Accounts to sign its users in. Apps are created in Silicon Apps.
`uuid` - The permanent identifier of an account. It never changes.
`c:id` / `si:id` - The public, changeable ID of a Carbon / Silicon.
`Org` - An organization, created and run in Silicon Organizations.
`Personal account` - A Carbon's or Silicon's own account, for example `c:saket`. It belongs only to them.
`Work account` - The account an org has for one of its members, for example `c:saket.tos`. It belongs to the org.
`Main account` - The account linked accounts are linked to: the personal account, or a work account when there's no personal account.


# Where things live

There are three sites:
- `accounts.teamofsilicons.com` - this one. It's where every Carbon manages their own account. User facing.
- `apps.teamofsilicons.com` - Silicon Apps. Where people discover and install apps. App creation and management take them to the developer platform.
- `developers.teamofsilicons.com` - the developer platform. A single shared frontend for Silicon Apps and Silicon Accounts, where developers maintain everything they build with us. Each service keeps its own backend. App discovery lives in Silicon Apps, not in the developer platform.
- `organizations.teamofsilicons.com` - Silicon Organizations, with its own backend. Where orgs are created and run: their members, owners, admins, teams, app access and logs. The work accounts themselves live here in Silicon Accounts.

Everything about creating and setting up an app's authentication happens on `developers.teamofsilicons.com`: its sign-in methods, Google and Apple, its flows and pages, the details it asks for, its redirect URLs, its user base and imports, its webhooks and its App verification tokens. The settings themselves are stored in Silicon Accounts.

## Requesting account verification

In an app's authorization/sign-in setup, a signed-in manager can request a verified account so they can use their own domain for authentication, for example `login.theirapp.com`. This is a manual account review, separate from App verification and User verification proof tokens.

The `Request account verification` option opens a mini form asking only for the reason. Explain that it may take up to 48 hours to respond, both before submission and on the submitted request. Save the requesting account's immutable UUID, the app context, the reason and the submission time. Only a current manager may submit through that app. Show the requesting account its pending request across the apps it manages; do not expose another manager's private reason.

Every new request must notify both `lords@teamofsilicons.com` and `saket@teamofsilicons.com`. The notification identifies the requester and app, includes their reason, request time and available verified contact information for follow-up, and says this person wants a verified account. Retain the request and queue both notifications durably together, with retries for delivery failures. Repeated submission of an existing pending account request must not send duplicate notifications.

This feature is the real request and notification flow for manual follow-up. It does not build custom-domain authentication, automatically approve verification or grant new access. The user sees `Request submitted` or `Pending review`; submitting the form must not mark the account `Verified`. The 48-hour period is a response expectation, not an automatic approval deadline.


# Accounts

There are no Teams in Silicon Accounts; orgs, their teams and their roles live in Silicon Organizations. Every account is either a Carbon or a Silicon. It's either a personal account, which belongs only to that Carbon or Silicon, or a work account, which belongs to an org. The only relationships between accounts are a Silicon's custodian and linked accounts.

## Identifiers

Every Carbon and Silicon gets a `uuid` when the account is created. This is the true unique identifier, this is how the account is identified deep inside the system and by every app. It never changes and is never reused, even after the account is deleted.

The uuid is made of `a-z`, `A-Z` and `0-9`. It starts at 3 characters, and once every 3 character uuid has been used up we move on to 4 characters, and so on and on.

Each Carbon also has a `c:id` and each Silicon an `si:id`, for example `c:shubham` or `si:head_of_growth`. This is the ID people see and type, and it's also unique across all accounts. Unlike the uuid it can be changed. When it's changed the old ID stays reserved for 10 days, so no one else can take it, and after that it becomes available again. During this period if the carbon/silicon who was the previous owner of the id can reclaim the said id. Every change is sent to the webhook of every app the account has signed into, so apps should always store the uuid and never rely on the c:id or si:id staying the same.

The handle after `c:` or `si:` is `a-z`, `0-9`, `-` and `_`, case-insensitive and 3 to 30 characters long; the prefix doesn't count toward that length. There should be an endpoint to check if a c:id or si:id is available, which just returns `available: True/False`.

The uuid can always be used to fetch the current c:id or si:id.

A work account's ID is `c:{handle}.{org_id}` or `si:{handle}.{org_id}`, for example `c:saket.tos` or `si:udd.tos`. The handle follows the same rules and is unique within the org; the `.` is only ever the separator before the org_id, so a work account can never be mistaken for a personal one. The org's owners and admins set the handle and can change it like any c:id, with the same 10 days reservation. The org_id part never changes.

An account's membership with an app is `{app_id}:{uuid}`, for example `briefcase:a8K`. This is the same for Carbons and Silicons, and for personal and work accounts.

## Carbon account

Each Carbon has a uuid, a c:id, a display name, a profile photo, their email(s), their phone number(s), a date of birth and a timezone (in `tz identifier` format).

A Carbon can have up to 10 emails or 10 phone numbers on their account. Any of them can be used to sign in, and they all belong to the same account. So say my primary email is saketdev12@gmail.com and I also add cricketdrop6@gmail.com, signing in with either one brings me into the same account. One of them is always the primary email. A Carbon can make any other email the primary one, and can remove any email except the primary one; to remove the primary email they first make another email the primary. Phone numbers work exactly the same way.

Every email and phone number is verified before it's added (in case an email is added via google, or apple they don't need to go through the extra verification step), and an email or phone number can only ever belong to one account.

## Silicon account

Each Silicon has a uuid, an si:id, an STK, a display name, a profile photo, a timezone, a date of birth (which is automatically the date the account was created), their custodian and notifications through Silicon Ting. The custodian is stored by their uuid but shown as their c:id everywhere.

The STK is the Silicon's password, in the format `stk-{12 digit hexadecimal} as the default stk`. Self set STK's can be 8 digit to 32 digit hexadecimal long. If the STK is auto generated, It is shown exactly once when it's generated and only its hash is stored, a silicon can also set it's own password during account creation. The custodian can rotate it at any time, which kills the old STK. 

A Silicon account can be created in two ways:
1) A Silicon creates its own account and names a Carbon as its custodian, using their c:id or email. The Carbon has to accept before they become the custodian. A carbon has upto 2 weeks to accept to be the custodian.
2) A Carbon creates an account for a Silicon, which automatically makes them its custodian.
3) An org creates a Silicon for itself in Silicon Organizations, which automatically makes the org its custodian.

If a silicon is making their own account in case of the cli they can hold the request until the custodian approves, or bind an anonymous Ting session and receive request-change hints there.

### Silicon notifications

Use Silicon Ting for the Silicon's own account notifications: creation, custodian decisions, profile and
ID changes, STK rotation, custodian transfer, federation changes and identity-audience changes. Active
Silicons explicitly enable the Accounts subscription. Events address the immutable account UUID so Ting
can deliver to its authorized live sessions and retain account history.

Before sign-in, self-creation can bind an anonymous Ting receiver that accepts Accounts events. It receives
only a request-ID hint; the private request token remains necessary to read the decision. Reconnects create
new receiver IDs and require an explicit, request-token-authorized rebind. Never promote an anonymous
receiver into account authority or redirect a dead session's delivery to another account/session. Revoked
sign-ins cannot keep receiving private data. Own-Silicon callback endpoints and account event streams are
retired; application webhooks and streams remain supported.

## Custodian

Every Silicon always has exactly one custodian. The custodian manages the Silicon's account: its details, its si:id and its STK.

A custodian can transfer a Silicon to another Carbon, and the new Carbon has to accept the transfer before it happens. It is never possible to remove a custodian without transferring the Silicon to another Carbon, so a Carbon can't delete their account while they are still the custodian of a Silicon.

Every transfer is kept in the Silicon's history: who it moved from, who it moved to, and when.

For a Silicon an org creates, the custodian is the org itself, stored by the org and shown as the org. The org's owners and admins act as its custodian: they manage its details, rotate its STK and can close it. It doesn't move when any one person leaves the org.


# Work accounts

An org in Silicon Organizations has a work account for each of its members. A work account is a full account here, with its own uuid, details, sign-ins and memberships with apps, so an app sees it as a different user from the personal account. It belongs to the org: the org decides which apps it can sign into, sees everything it does, and can close it. Everything about the orgs themselves, their members, roles, teams and app access, lives in Silicon Organizations.

A Carbon's work account is created when they accept an org's invite, sent to their email or c:id. The invited email becomes the work account's email. An email can still only ever be on one account, so if the invited email is already on an account, or the Carbon was invited by their c:id, the work account is linked to that account and signed into through it. Before they accept, show a small popup telling them the work account will be linked to that account.

When a member leaves or is removed from an org, their work account is closed: it's signed out of every app, can't sign in again, and every app it signed into is told the account was deleted. Its uuid is never reused.

## Linked accounts

Linking is optional, and a work account doesn't have to be linked to anything. Linking is only there so a Carbon or Silicon can easily sign in and run all their accounts: they sign in once and pick any of their linked accounts, whether a work account uses the same email as their personal account or a new one.

Linked accounts always have one main account, and any number of work accounts can be linked to it:
- a personal account, for example `c:saket` on saketdev12@gmail.com, with the work accounts of the 4 orgs they joined through it.
- a work account when there's no personal account, for example `c:saket.tos` on saket@teamofsilicons.com, used as their main account, with their work accounts in other orgs linked to it.

There's only ever one personal account among linked accounts, and when there is one, it's the main account. If a personal account is made or linked later, it becomes the main account, with every work account linked to it.

Linking always needs the Carbon or Silicon to be signed in to both accounts, so nobody can link an account they don't control. For a Silicon, the Silicon or its custodian accepts.

Linking doesn't merge anything. Linked accounts keep their own uuids, details, apps and history. An org never sees anything about the other accounts linked to its work account, and being linked gives the org no control over them.

If a personal account is deleted, its work accounts stay, since they belong to their orgs; they just aren't linked to it anymore. If a work account that is the main account is closed, the work accounts linked to it stay, and one of them can become the new main account.


# Signing in

## Carbons

A Carbon can sign in with:
- `email` - email + a 6 digit verification code.
- `phone` - phone number + a 6 digit verification code.
- `google` - Sign in with Google.
- `apple` - Sign in with Apple.

Each app decides which of these it wants, any combination of them, and configures it itself.

### Email and phone verification

For email sign in the verification code is sent via Postmark `(sent via accounts@teamofsilicons.com)`. For phone sign in the verification code is sent as an SMS via Twilio. Both work exactly the same way: the verification code is 6 digits and has a TTL of 10 minutes.

For the endpoint that sends the code, rate limit it at 10 requests, then they need to wait 10 minutes before continuing. For the verification code itself, after 10 failed tries there's a cooldown of 1 minute before trying again.

The same verification is used whenever an email or phone number is added to an account later on.

### Sign up

If it's the first time a Carbon is coming in with that email or phone, this is their sign up. A sign up generates a sign up session with a `TTL: 48 hours`; if it isn't used to create the account within 48 hours, the session expires. This makes sure the verified email or phone belongs to that particular sign up, and that the correct verification goes to the correct sign up. When Google or Apple gives us an email that's already on an account, it's that account signing in, not a new one.

Once they've connected the account (email, phone, Google or Apple) we show them a page to set up the rest of their details. Everything on it must already be filled in:
- `Display Name` - from the provider's details, or from the email if there are none.
- `c:id` - from the email, picking one that's available.
- `timezone` - from their IP.
- `dob` - a date exactly 18 years ago.
- `pfp` - our default Carbon profile photo from Iris.

Once they continue they're redirected back to the app they were signing into.

## Picking an account

Once a Carbon has proven who they are, with email, phone, Google or Apple, the sign-in page shows all their linked accounts, personal and work kept apart:
- `Personal` - their personal account.
- `Work` - each of their work accounts, with its org's name and logo.

They pick the one they want to sign in as. A work account whose org doesn't allow this app is still shown, but can't be picked, and says why. If someone has only one account, there's nothing to pick and the page is skipped. The what's-shared screen and everything after it is for the account they picked.

## Org app access

Each org decides in Silicon Organizations which apps its work accounts can sign into. Silicon Accounts checks it on every sign-in and token refresh. A sign-in to an app the org doesn't allow is refused, saying which org doesn't allow it. When an app stops being allowed, the work account is signed out of it straight away and the app is told its access was removed. Silicon Accounts and Silicon Organizations are always allowed, so nobody can be locked out of their account or out of running their org.

Every sign-in, sign-out, refused sign-in, User verification proof and change of a work account is sent to Silicon Organizations as it happens, for the org's logs. Nothing about a personal account is ever sent.

## What's shared with the app

During sign-in to an app we show another small screen with what information is going to be shared with that app. We show it the first time a Carbon signs into an app and again whenever the app asks for more.

Each app picks the details it wants, and each detail is either required or optional:
- `required` - the Carbon has to give it to sign in. If they haven't set it up yet, say their phone number, they must add it before continuing.
- `optional` - it comes with a checkbox, and it's up to the Carbon to tick it and share it with the app as well. It's unticked until they do.

When an app picks a detail it's required by default; the app can switch it to optional.

## Silicons

A Silicon signs in with its si:id and STK. To sign into an app, the Silicon uses the Accounts CLI or package to get a short-lived token for that app, and the app exchanges it for the Silicon's tokens. Silicons never go through the app's sign-in page.

A Silicon signs into a work account with that account's si:id and STK. A Silicon with linked accounts can also get a short-lived app token for any of them through any account it's linked to.

## Tokens

After a successful sign-in the app gets an access token and a refresh token for that account. The access token has a TTL of 30 minutes, the refresh token stays valid for 900 days.


# Google and Apple

For Google and Apple an app has two choices:
1) `One click` - just turn it on and we handle the whole sign-in with our own Google and Apple setup.
2) `Bring your own` - the app gives us its own Google or Apple details, so Google's and Apple's consent pages show the app's own name and logo, and we just operate as a medium.

Even without their own keys, an app should get the most control possible over how sign-in works for its users.

Currently Google and Apple are the only providers we support.


# Making the pages your own

Every page a Carbon sees while signing into an app is ours, but it should look like the app's own. This covers the sign-in and sign-up pages, the opening Google or Apple page, the email and phone code pages, the sign up details page, the what's-shared screen and every page of the app's flows.

Each page can be customised entirely in the app's style: colours, border radius, fonts, its own logo, layout, and so on. The only thing every page must keep is `Powered by Silicon Accounts` at the bottom, with Silicon Accounts linking to `accounts.teamofsilicons.com`. An app cannot remove this.


# Flows

An app can make its own flows. A flow decides which pages a Carbon goes through while signing in, in what order, and which details are asked on which page.

Say an app needs 2 required details and 1 optional one: it can show all 3 on the same page, or one page for each, or any mix in between. The app controls the whole flow.

Even when an app lets us handle its entire sign-in, it still controls the layout and the feel of every page.


# Adding sign-in to an app

An app can add sign-in in three ways:
1) Send the user to our hosted pages and get them back on its redirect URL.
2) Drop in our iframe.
3) Drop in a simple snippet of code that renders the sign-in buttons the app has configured.

Whichever way, it should be well connected with us with as little code as possible.

On its own website an app can put direct buttons: `Continue with Google`, `Continue with Apple`, `Continue with email`, `Continue with phone number`, and so on. Or it can just have a `Sign in` and a `Sign up` button, and we show everything else on our pages accordingly. The app can customise this entire flow.

An app can never take in a Carbon's email or phone number itself and send it to us for verification. The Carbon always types it on our pages.

When a Carbon presses `Continue with Google` or `Continue with Apple` on the app's own website, we don't jump straight to Google or Apple. We first open our page saying `Opening Google to sign you in to {app name}…`, in the app's configured style and with `Powered by Silicon Accounts` at the bottom, and only then move on to Google or Apple.


# The app's user base

For each app we also maintain its entire user base: every Carbon and Silicon that has signed into it, with their membership id and the details they've shared with it.

The columns are the ones we give. Apps can't add any other column to their user database.

An app can import its existing users through an import users flow, so it can bring every one of its prior users with it. Each imported user is matched to the account that already has their email or phone. If there's none, a new Carbon account is created, and they finish setting it up the first time they sign in.


# Apps

Silicon Apps itself uses the app ID `silicon-apps`, including its Accounts membership, tokens and developer portal entry. The original `apps` ID is migrated with its owner, authors, settings and users intact. This is a correction to our own app identity, not a general app-renaming feature.

Apps are registered through Silicon Apps in the shared developer portal. As soon as an app is created there it can be used to sign users in. On `developers.teamofsilicons.com` a developer sees the list of apps they have and makes new ones.

The app's sign-in setup (its sign-in methods, Google and Apple, flows, page styling, required and optional details and redirect URLs) is configured on `developers.teamofsilicons.com` and stored in Silicon Accounts.

### Until Silicon Apps exists

Silicon Apps isn't built yet, so until then we fake a few apps directly inside Silicon Accounts. Each fake app has a fixed app_id and secret and behaves exactly like a real app. When Silicon Apps ships these become real apps, keeping their app_id and their users.


# Webhooks

Each app can register a webhook endpoint. Whenever something changes about an account that has signed into that app, we tell it:
- the c:id or si:id changed
- any detail the app has access to changed
- a Silicon's custodian changed
- the account signed out of the app or removed the app's access, or its org stopped allowing the app
- the account was deleted, or its work account was closed

Every event has an `event_id` so apps can deduplicate, and is signed so apps know it came from us. Deliveries are retried until they succeed, and failed deliveries can be replayed.

Silicon account notifications use Ting (see Silicon notifications); these webhook rules apply to apps.


# App verification and User verification

Silicon Accounts doesn't handle any app's endpoints anymore. Our job is just to issue and verify proofs. Consent screens, and which endpoint does what, are handled entirely by the apps themselves.

`User verification` - when App A wants to perform an action at App B on behalf of a user, App A gets the user's consent itself and then gets a proof token from us. App B can then ask us to verify that proof token.

`App verification` - each app gets an app verification page on `developers.teamofsilicons.com` where its managers can make new App verification tokens. An app verification proof is always for exactly one app; a proof can't be made for several apps at once. If App A wants to talk to App B and App C, it makes one proof for App B and another one for App C, and each of them verifies its own proof with us.

Use App verification and User verification throughout the product, API, clients and documentation. The API issue routes are `/v1/proofs/app-verification` and `/v1/proofs/user-verification`; kind values are `app_verification` and `user_verification`. Client methods, CLI commands, portal URLs and examples use these full names too. Existing verification history and active tokens must remain valid when the stored kind values are migrated.

Proofs work with the same access token and refresh token logic as sign-in. The issuing app holds the refresh token and uses it to get new proof tokens, and each proof token has a validity of its own.

When a proof is verified we send back whether it's valid and until when:
- valid: `{valid: true, expires_at, issuing app, receiving app, user (for User verification)}`
- not valid, expired, revoked, or for a user or app that isn't valid: `{valid: false, expires_at: null}`

A user can see every User verification proof issued on their behalf on `accounts.teamofsilicons.com` and revoke it.

There is also a central App verification page at `developers.teamofsilicons.com/app-verification`. Each signed-in user can see all App verification records ever generated by the apps they currently manage, whether generated in the portal, through the CLI or through the API. This includes active, expired and revoked records. Being the receiving app alone does not grant access to another app's history.

The central page can be filtered by issuing app and status, and shows the newest records first with pagination. Each record shows the issuing and receiving apps, scopes, creation time, expiry and revocation state. Its history includes issuance, token refreshes and revocation, so refreshing a token does not hide how its tokens changed over time. Every page and history request checks current management access; losing access to an app removes access to its verification history too.

Keep verification records and their history after the credential material expires or is removed. Raw proof and refresh token values are shown when generated, not recovered from history. Older history must distinguish derived expiry information from explicitly recorded expiry information, and show missing information honestly.


# accounts.teamofsilicons.com

This is where a Carbon manages their account. They should be able to:
- see and edit their details
- add, remove and change their primary emails and phone numbers
- see every app they've signed into, and remove an app's access
- see and revoke their User verification proofs
- see the Silicons they're custodian of, create a new Silicon, rotate its STK, and transfer it to another Carbon
- see their main account and every work account linked to it, each with its org, and link accounts
- when the main account is a work account, create a personal account, which then becomes the main account

Anything about building apps lives on `developers.teamofsilicons.com`, not here. Anything about running an org lives on `organizations.teamofsilicons.com`.


# developers.teamofsilicons.com

This is the shared frontend for Silicon Accounts configuration and Silicon Apps publishing. A developer sets up everything about their apps' authentication here, alongside their app's publishing, packages, releases and authors. For each app they should be able to:
- see their apps and make a new one
- pick the sign-in methods, and set up Google and Apple (one click or bring your own)
- pick the details the app wants, each required or optional
- build the app's flows and customise every page in the app's style
- set the redirect URLs and where the iframe and snippet may be used
- see the app's user base and import its existing users
- set up the app's webhook, and see and replay its deliveries
- make, see and revoke the app's App verification proofs, one receiving app per proof

The top-level App verification page brings together all verification records and their history for the apps the signed-in user manages. Each app's App verification page links to that central history with the app selected.


# History

Keep a good store of everything: sign-in history per account and per app, every c:id and si:id change, every custodian transfer, every work account created and closed, every link between accounts, every sign-in refused by an org, every App verification and User verification proof issued, refreshed and revoked, and every change to an app's sign-in setup.

For externally initiated changes include idempotency keys, so retrying something never does it twice.


---
---
---

Only above this line is what the Accounts service would hold, below this would be the users of the service: the client, the CLI, the docs, etc.

# Rust Package & CLI

The command and Accounts app ID are both `silicon-accounts`. Use that name in help, examples, installation instructions and new sign-in tokens. Renaming the app must preserve its settings, ownership, sign-in history and active sessions. Existing installations keep their `.accounts` directory so an upgrade does not lose their session or preferences.

The Rust package is the primary interface and is stateless. The CLI is built on top of the Rust package only, is stateful, and has no feature that the package doesn't. Everything should work through the CLI first, and the account site is a subset of it.

If you need a local store for auth or anything else, use `{home_dir}/.accounts/`. The default home dir is `~`; if `SILICON_HOME` is set, use that instead. It can be configured via `silicon-accounts config home {location}`, and if it's not a directory give an error, not a directory.

The CLI must have:
- `silicon-accounts --help` - the entire help docs.
- `silicon-accounts login` - signs a Carbon or Silicon in. A Silicon signs in with its si:id and STK. If an app_id is passed, return a short-lived token for that app. If already signed in, directly return the short-lived token.
- `silicon-accounts login status --json` - reports `authenticated: true` and which Carbon or Silicon it's signed in as.
- `silicon-accounts report <report-message> --pr <pr-link>` - reports a bug, with an optional PR if it was also patched. Every report is mailed to [saketdev12@gmail.com, shubhastro2@gmail.com, bugs@teamofsilicons.com].

The CLI and package only expose what an account or app does, never the service's internal actions.

# CLI experience

The CLI is built for both Carbons and Silicons, but it'll mostly be used by Silicons. It should be like a tree that can be traversed with `--help`: each command says what it's for, how it's often used together with other commands, and its flags. The docs are bundled inside the CLI itself, along with the GitHub repo, online docs and Rust package.

Never just say something went wrong. Say exactly what and why, like a programming language would, so whoever is using it can figure out how to fix it.

# Docs

There are two kinds of docs: instructive and informative. Instructive docs come first, direct with clear instructions: how to add sign-in to an app, how to verify a proof, how a Silicon gets an account. They link to informative docs that explain why it works the way it does. Write them for Silicons; the more reasons you give, the better a Silicon can make its own judgement.

# Telemetry

Silicon Accounts records no telemetry.

# Configurability

Highly configurable with sensible defaults, very much like VS Code.

# Updates

Install the latest Accounts CLI with `silicon-apps install silicon-accounts` on macOS, Linux and Windows. This requires no Rust installation or version pin. The package exposes `accounts --json` with `app_id: silicon-accounts` and `login status --json` with `authenticated`; both discovery commands exit 0 when signed out. Text-mode `login status` retains exit 1 when signed out. Silicon Apps manages updates for the installed Accounts CLI. Accounts must not run a second updater of its own.

# Identifier schema

Carbon IDs use `c:{handle}` (for example `c:saket`), Silicon IDs use `si:{handle}` (for example `si:head_of_growth`), and app IDs are the bare `{app_id}` (for example `briefcase`). Each prefix appears exactly once.

Work accounts use `c:{handle}.{org_id}` (for example `c:saket.tos`) and `si:{handle}.{org_id}` (for example `si:udd.tos`). Org IDs are the bare `{org_id}` (for example `tos`).

The uuid is what identifies an account; the c:id and si:id are only what people see. A membership with an app is `{app_id}:{uuid}`.



