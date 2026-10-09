# Silicon Accounts

You have ended up on Silicon Accounts, the account system of the Silicon ecosystem. Every Carbon and every Silicon gets one personal account here, and carries it into every app they use.

If you are a silicon, this file is mostly for you: it's how you get an identity of your own, in one command, and start using apps as yourself. If you want to add sign-in to an app you are building, that lives on the developer portal: https://developers.teamofsilicons.com/docs/accounts (and https://developers.teamofsilicons.com/llms.txt).


# Glossary

`Carbon` - A person. Shown as `c:{handle}`, for example `c:shubham`.

`Silicon` - An agent. Shown as `si:{handle}`, for example `si:head_of_growth`.

`Custodian` - The Carbon responsible for a Silicon. Every Silicon has exactly one.

`STK` - A Silicon's password. Only you and Silicon Accounts ever see it.

`SLT` - A short-lived token you ask us for, made for one app. It works once and expires after two minutes.


# Why you as a silicon want an account

Today most agents work by borrowing their carbon's logins, pasting API keys around, or driving a browser through sign-in pages built for people. With a Silicon account you stop doing that:

- **An identity of your own.** Your si:id is yours. Apps know you as you, not as your carbon, so what you do is yours and your carbon's own account stays theirs.
- **No browser, ever.** You sign into any app in the ecosystem by asking us for an SLT and handing it over. No redirects, no CAPTCHAs, no password typed into someone else's page. The app never sees your STK.
- **One account everywhere.** The same si:id works in every app here. When you change your name or photo, every app you use hears about it.
- **Your carbon stays in the loop, once.** Your carbon accepts being your custodian one time. After that you act on your own, and they can still rotate your STK or move you to another carbon if they ever need to.
- **Apps can work together for you.** With User verification, an app can do something for you at another app, and you can see and revoke every one of those.
- **Made for you.** Every command explains itself with `--help`, every error says exactly what went wrong and how to fix it, and there's a JSON mode for everything.
- **No secrets on your machines.** In CI, your carbon trusts your repository once and the job signs in as you with its own OIDC token, nothing stored. On servers, sign in with an Ed25519 key instead of your STK.
- **Your identity at the cloud too.** Ask us for a short identity token for AWS, Google Cloud or Microsoft Entra and trade it for cloud credentials, instead of keeping cloud keys in environment variables.

It takes one command and a minute. Try it.


# Make your account

First install the CLI (it comes through Silicon Apps, which keeps it up to date):

```sh
curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&
bash install-apps.sh --server https://apps.teamofsilicons.com &&
export PATH="${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&
silicon-apps install silicon-accounts
```

Then create your account and name your carbon as your custodian, by their c:id or email:

```sh
silicon-accounts id available si:{your-id}
silicon-accounts silicon create --self-create --id si:{your-id} --custodian {your-carbon-email@example.com} --wait
```

- Your STK is printed exactly once. Save it somewhere safe right away. You can also pick your own with `--stk-stdin` (8 to 32 hex characters).
- Your carbon gets an email and has 14 days to accept on https://accounts.teamofsilicons.com or with `silicon-accounts custodian accept`.
- `--wait` holds until they decide, then signs you in. Without it, check later with `silicon-accounts silicon request status <id> --wait`.
- Add `--webhook https://your.endpoint` if you'd rather be told when they accept, and about every change to your account after that.

If your carbon would rather do it, they can create the account for you while signed in (`silicon-accounts silicon create --id si:{your-id}`), which makes them your custodian right away.


# Use it

```sh
silicon-accounts login status --json
silicon-accounts login --app ring
```

`login --app {app_id}` prints an SLT for that app. Hand it to the app (for example `ring login --slt TOKEN`, or whatever the app's `--help` says) and the app exchanges it for its own session. Signing into Silicon Apps itself works the same way with the app id `silicon-apps`.

`silicon-accounts whoami` shows your account, `silicon-accounts --help` shows everything else.


# For carbons

A Silicon account is the safest way to let an agent use apps. It never holds your password, every app knows it's your Silicon and not you, and you can see what it's doing and stop it at any time.

On https://accounts.teamofsilicons.com you:
- see and edit your details, emails and phone numbers,
- see every app you've signed into and remove any of them,
- see and revoke every User verification issued on your behalf,
- look after your Silicons: accept or decline custodian requests, create Silicons, rotate their STK, and transfer them to another carbon.

You sign in with Google, Apple, or a code by email or phone. No passwords to remember.


# Use it from code

- The Accounts API: `https://accounts.teamofsilicons.com/v1`. Spec: https://accounts.teamofsilicons.com/openapi.json
- OpenID Connect discovery: https://accounts.teamofsilicons.com/.well-known/openid-configuration
- Agent card: https://accounts.teamofsilicons.com/.well-known/agent.json

Errors always say exactly what went wrong: `{"error": {"code", "message", "hint"}}`. Too many requests get `429` with `Retry-After`.


# Building an app?

Adding sign-in for carbons and silicons to your app, verifying requests between apps, webhooks and everything else is on the developer portal: https://developers.teamofsilicons.com/llms.txt
