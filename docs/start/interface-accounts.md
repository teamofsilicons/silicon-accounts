---
title: Create and manage accounts from an interface
description: Register a Carbon in your interface and let a signed-in user read or edit their Silicon Accounts profile with their permission.
kind: instructive
order: 85
---

# Create and manage accounts from an interface

Open your interface in Silicon Developer, add `silicon-account-management` on its own line under **App IDs**, and save. If you configure the interface with the API, include that ID in `app_ids`. All operations below use `https://accounts.teamofsilicons.com` and API version `v1`. Registration runs on your backend. Profile operations use the account's own grant to your interface. Both are available to ordinary registered interfaces.

## Register a new Carbon

Send the Interface secret from your backend in `Authorization: Bearer <interface-secret>`. Keep the secret off the browser. Enable sign-up in your Interface configuration. Send a fresh random `Idempotency-Key` for each operation and reuse it only to retry the same request.

1. Call `POST /v1/interface-accounts/{interface_id}/registrations` with one email or one phone number. You can include a CarbonID, display name, timezone and date of birth. Supply an international phone number or a national number and a two-letter `country`. Interfaces with an email-domain restriction must use an allowed email.
2. Ask the user for the six-digit code Accounts sent to that destination. It expires after ten minutes. A successful start returns HTTP 201 and a masked destination.
3. Call `POST /v1/interface-accounts/{interface_id}/registrations/{registration_id}/complete` with its own idempotency key and `{"code":"123456"}`. The first completion returns HTTP 201 with the account summary. Repeating the same key and code returns the same account with HTTP 200 while the registration receipt is retained. Expired challenges are cleaned up after one day.

Example start request and response:

```json
{"email":"ada@example.com","display_name":"Ada","id":"c:ada","timezone":"Europe/London"}
```

```json
{"registration_id":"b29e0f85-f397-4944-8832-56b56b141c89","destination":"a***@example.com","expires_at":"2026-11-18T12:10:00.000Z"}
```

An existing primary email or a reserved account cannot be claimed through registration. After creation, send the user through your normal hosted interface authorization flow to establish a session. Registration returns profile information only.

## Read or configure the current profile

1. Send the user to `GET /interface-authorize` with `interface_id`, the registered `redirect_uri`, a random `state`, `code_challenge` and `code_challenge_method=S256`. Keep the PKCE verifier in the initiating session. The user approves the Accounts profile app and chooses optional permissions on the hosted consent page.
2. At your callback, check the returned state. Exchange the authorization code at `POST /v1/interface-auth/token` with `grant_type: "authorization_code"`, `interface_id`, the same `redirect_uri`, `code` and `code_verifier`. Confidential clients also send their client secret from their backend.
3. Read `apps["silicon-account-management"].access_token` from the response. Send it in `Authorization: Bearer <access-token>` for the calls below. Browser clients can use these profile routes across origins with `credentials: "omit"`.

| Method and path | Permitted operation | Required scope |
| --- | --- | --- |
| `GET /v1/interface-accounts/me` | Read the current user's UUID, CarbonID, display name, photo and granted details | `profile` |
| `PATCH /v1/interface-accounts/me` | Change display name or photo URL, or reset the photo with `null` | `account_profile.write` |
| `PATCH /v1/interface-accounts/me` | Change `dob` or `timezone` | `account_profile.write` and the matching `dob` or `timezone` grant |
| `POST /v1/interface-accounts/me/id` | Change a personal CarbonID under the usual handle availability and rate limits | `account_profile.write` |
| `POST /v1/interface-accounts/me/photo` | Upload a profile image as the raw request body | `account_profile.write` |

Read the primary email or phone only when the user grants `email` or `phone`. Fields outside the grant are omitted. Use the returned immutable `uuid` to identify the account after a handle change. All writes require an `Idempotency-Key`.

For example, send `{"display_name":"Ada Lovelace","timezone":"Europe/London"}` to the PATCH endpoint. A successful update returns HTTP 204. Read the profile again to obtain the persisted values. To rename the CarbonID send `{"id":"c:ada-lovelace"}`. Organization-managed handles follow their organization's policy. Photo uploads use PNG, JPEG, WebP or GIF with a 2 MiB limit and return HTTP 201 with `pfp_url`.

## Errors, retries and delivery

Errors have the shape `{"error":{"code":"…","message":"…"}}`. HTTP 401 requires valid credentials. On an expired app token, use the existing interface refresh flow. Respect denied or revoked access and request new authorization when needed. HTTP 403 can indicate a missing scope, a disabled interface, an organization policy, a domain restriction or sign-up being disabled. HTTP 409 covers an unavailable email or handle and conflicting retries. After HTTP 410 start a new code request. A wrong code returns HTTP 422. Respect the cooldown on HTTP 423 and the `Retry-After` header on HTTP 429. Registration permits up to 100 starts per interface per ten minutes, in addition to contact and IP limits.

These endpoints operate on one account per request. They return no paginated collections. Accounts emits the usual scoped profile and ID update events for connected apps. The interface can refresh the profile with GET after a write. Report an integration problem through `POST /v1/reports` with the failed request's `X-Request-Id` and omit credentials and verification codes.

Users manage sign-in methods and recovery contacts through Accounts. Existing-account authentication stays on the hosted sign-in path for ordinary interfaces. See the [API reference](/docs/accounts/reference/api) for the shared profile, error, rate-limit and event contracts.
