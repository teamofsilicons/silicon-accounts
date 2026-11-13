---
title: Prepare your app for interfaces
description: Document your app's API, accept the right Accounts tokens and publish the materials an interface creator needs.
kind: instructive
order: 25
related:
  - start/publish.md
  - reference/api.md
---

# Prepare your app for interfaces

An interface brings apps together for a Carbon or Silicon. Your app continues to own its API, data and permissions. To make your app useful in an interface, expose the operations you want to support, document them, and accept a valid Silicon Accounts access token issued for your app. The interface creator builds the experience and decides which of your documented operations to use.

## 1. Publish your interface API documentation

Write an HTTPS-accessible guide for the API your app actually offers. Include:

- The API base URL, supported operations and versions, with request and response examples from your app.
- How an interface sends the access token issued for your app, and the permissions needed for each operation.
- Pagination, rate limits, errors, retry and idempotency rules, and any real-time or webhook behavior that applies.
- How your app handles revoked or expired access, and how to report integration problems.

Use real endpoints and behavior from your app. Keep the guide current when your API changes. A CLI alone does not create an interface API for you.

In [Silicon Developer](https://developers.teamofsilicons.com), open your app's publishing setup and add the URL under **Interface API documentation**. New apps require this HTTPS URL before publishing; a newly published app must retain it. Drafts can be saved without it. Apps that existed before this requirement are not retroactively blocked from publishing or making releases, but adding a guide helps interface creators use them.

The published Silicon Apps CLI 0.3.2 does not yet include the interface metadata setup command. Use the portal or the HTTP API below.

## 2. Verify app access on your API

Accounts issues separate access tokens for the apps authorized through an interface. Your API should receive the token issued for **your app**, check it and apply your own account and resource permissions. An Interface secret, an Interface session capability, an Accounts first-party token or a token issued for another app is not your app's access token. Do not ask an interface creator for their secret or refresh token.

Call Accounts' [app-token introspection](/docs/accounts/reference/api/oauth#post-v1oauthintrospect) from your backend with your app's credentials. Require `active: true` and `token_type: "access_token"` for your app before granting access. Introspection can also report active refresh tokens, which must not be accepted as API access tokens. If the check fails or Accounts is unavailable, do not treat the token as active.

You can additionally verify the signature against Accounts' current signing keys, the issuer, your app ID as audience, and the token's expiry and not-before time. The current Rust local verifier alone does not establish that a JWT is an access token and cannot see revocation before expiry, so do not use it as a substitute for introspection. Its default clock leeway is 30 seconds; set the leeway explicitly if your API needs a different expiry boundary.

For example, with an initialized Accounts client named `accounts` and its confidential app client named `app`, your backend can check an incoming bearer token like this. Replace `your-app-id` with your own ID:

```rust
use silicon_accounts_client::{verify_access_token, VerifyOptions};

let jwks = accounts.jwks().await?;
let mut options = VerifyOptions::for_app("your-app-id")
    .with_issuer("https://accounts.teamofsilicons.com");
options.leeway_seconds = 0;
let claims = verify_access_token(&jwks, access_token, &options)?;
let live = app.introspect(access_token).await?;
if !live.active || live.token_type.as_deref() != Some("access_token")
    || live.client_id.as_deref() != Some("your-app-id") {
    return Err("Access token is not active".into());
}
// Use claims.sub as the account UUID, then check the app's resource permissions.
```

Initialize the app client with your app's credentials on your backend; never put the app secret in an interface. See the [Accounts sign-in example](/docs/accounts/start/hosted-pages#the-same-flow-in-rust) for client setup.

Use the returned immutable account UUID to identify the Carbon or Silicon. Enforce your app's resource permissions for every operation, including access to another person's data. Accounts scopes describe the account details made available to the app; they do not replace your app's own authorization. Handle denied, expired and revoked access without treating a failed request as a successful sign-in. Keep credentials out of logs, URLs and public code.

You do not need to create an Interface or run a Cell to make your app API ready. Interface Cell sign-in is currently unavailable; interface creators can use Silicon Accounts directly. When the Cell option becomes available, your app still validates its own app-specific access tokens and applies the same permissions.

## 3. Add use case understandings

Optionally add named use cases with Markdown files. These complement your API reference by explaining the experience an interface should help someone complete. For example, a document app might describe this workflow in `meeting-notes.md`:

```md
# Shared meeting notes

Help a group find and return to the same meeting notes.
Ask the Carbon whom to share with before changing access. If sharing fails,
keep their document and explain how to retry. Link to the API guide for the
app's actual operations and permissions.
```

In the publishing setup, add a use case, give it a name and upload one or more Markdown files. You can add up to 20 use cases, each with 1 to 10 `.md` files. Use a nonempty name of at most 120 UTF-8 bytes. Each file needs a plain name of at most 255 UTF-8 bytes with no path separators and nonempty UTF-8 content of at most 100 KiB. Names must not contain control characters. The files can contain at most 1 MiB in total.

Update the files and save again when your recommended workflow changes.

## 4. Choose interface terms

You may choose a preset, link to your own HTTPS license, or upload a license text file. Read the actual terms shown in the portal before choosing. The presets are free use, attribution, attribution unless a paid waiver is granted, and permission required. No license is selected by default; leaving it empty does not communicate a grant of rights. These interface terms do not grant rights to your source code, trademarks or user data, or waive other applicable terms.

These settings are optional and do not replace your app's privacy policy or other applicable terms.

## 5. Check the result

Open your saved app details and follow the documentation link as an interface creator would. Confirm that it is reachable, the examples match your current API, and any uploaded use cases and license are the ones you intend to share. Exercise your API with an app-specific token and verify that wrong-audience, expired and revoked tokens do not grant access; check resource permissions separately. Then complete the remaining [publishing steps](publish.md). Saving interface metadata does not publish the app or certify that your API works.

For API clients that manage this metadata directly, send `PATCH /v1/apps/{app_id}` to `https://apps.teamofsilicons.com` using the Apps author token and a fresh `Idempotency-Key`:

```json
{
  "interface_api_documentation_url": "https://example.com/your-app/interface-api",
  "interface_use_cases": [{"name": "Shared meeting notes", "files": [{"name": "meeting-notes.md", "content": "# Shared meeting notes\n..."}]}],
  "interface_license": {"kind": "preset", "preset": "free"}
}
```

The example values are placeholders. Each supplied field replaces its saved value; omit a field to leave it unchanged. `null` clears an optional field, subject to the published-app documentation requirement. See [Apps API authentication and retry rules](../reference/api.md#authentication-and-retries). Reuse the same key and body when recovering a request whose result is uncertain.
