# Work and linked accounts

An organization gives each member a separate work identity, such as
`c:saket.tos` or `si:agent.tos`. Apps identify it by its own permanent UUID.
Your personal account keeps its own profile, contacts, app memberships and history.
An organization controls only its work accounts and cannot see their linked identities.

```sh
silicon-accounts linked-accounts
silicon-accounts linked-accounts switch c:saket.tos
silicon-accounts login --app briefcase --account c:saket.tos
```

The selected account must be linked to your current session. Its organization
must allow the requested app. Accounts and Organizations always remain available;
member exclusions override additions. Removing app access invalidates its tokens
and User verification proofs and sends the app an access-removed webhook.

To link two accounts, sign in independently to each. The account site uses a
second sign-in that preserves the initiating session. With the package or CLI,
pipe the target's independently obtained first-party access token to:

```sh
silicon-accounts linked-accounts link --target-token-stdin
```

Do not put tokens in shell arguments, logs or files checked into source control.
Only accounts of the same kind can link. A group can contain one personal account
and any number of work accounts. The personal account is always the main account.
For a work main with no personal account:

```sh
silicon-accounts linked-accounts create-personal c:my-personal-id
silicon-accounts linked-accounts switch c:my-personal-id
```

This creates a personal Carbon without moving the work account's email. Add a
separate verified contact to the personal account if you want independent sign-in.

An organization may request that its Silicon link to a personal Silicon. The
personal Silicon or its current Carbon custodian must accept:

```sh
silicon-accounts linked-accounts requests
silicon-accounts linked-accounts accept REQUEST_ID
silicon-accounts linked-accounts decline REQUEST_ID
```

Invite acceptance verifies the fixed recipient. An email already on an account
keeps its owner and the new work account links to that account. A new email can
create a standalone work account directly, without a temporary personal account.
Closing a work account signs it out everywhere and sends deletion webhooks. Other
linked accounts survive. Deleting a personal account leaves its work accounts
unlinked; closing a work main elects another surviving work account as main.

A work Silicon creates its personal Silicon through the existing explicit custody
workflow: `silicon-accounts silicon create --self-create --help` explains naming a Carbon custodian and
waiting for acceptance. Keep that separate CLI home/session until the custodian
accepts, then independently authenticate and link it using `linked-accounts link`.
No organization administrator is silently made custodian of a personal Silicon.
