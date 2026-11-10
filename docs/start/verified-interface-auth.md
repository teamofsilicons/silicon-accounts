---
title: Build verified Interface sign-in
description: Implement a verified Interface's own sign-in with the Accounts backend bridge and hosted provider handoff.
kind: instructive
order: 86
---

# Build verified Interface sign-in

A verified or trusted Interface may build its own email and phone sign-in screens. Its confidential backend calls Silicon Accounts; the Interface secret, flow capability and Accounts cookies stay off the browser. The same app review and Interface authorization code are used as in the hosted flow. An unverified Interface uses the hosted flow instead.

First register the Interface's exact callback URI and the origin of the Interface in its sign-in setup. Store the Interface secret securely on the backend. On each call below, authenticate to Accounts with `Authorization: Bearer <interface-secret>`. These are backend-to-backend endpoints; they do not permit cross-origin browser calls. Use HTTPS outside local development.

Create a fresh random `state`, an S256 PKCE verifier and its challenge. Bind the state and verifier to the visitor's own backend session; check the state on the callback. Never send the verifier to the authorization page or another visitor. A public browser or native client must never contain the Interface secret.

## Start the flow

Send `POST /v1/verified-interface-auth/start` as JSON:

```json
{
  "interface_id": "potato",
  "interface_origin": "https://potato.example",
  "redirect_uri": "https://potato.example/callback",
  "state": "a-fresh-random-state",
  "code_challenge": "the-base64url-s256-challenge",
  "code_challenge_method": "S256"
}
```

`interface_origin` must match a registered allowed origin, and `redirect_uri` must exactly match a registered callback. The response contains `capability` and `flow`. Keep the capability only on the backend and bind it to the visitor's session. `flow.step` and the other flow fields describe what your own UI should show. Accounts holds the flow and browser-session cookies encrypted; it does not return them to you. A flow expires after ten minutes. Completing or denying it revokes the temporary Accounts browser session and erases its encrypted cookies. An identical decision may be retried safely while the flow is live.

## Collect and verify a contact

Send each action to `POST /v1/verified-interface-auth/action`, with the same backend authentication:

```json
{
  "interface_id": "potato",
  "interface_origin": "https://potato.example",
  "capability": "the-backend-only-capability",
  "action": "email",
  "payload": { "email": "person@example.test" }
}
```

The action response contains the updated `flow`. Render its current step and handle its errors. The supported actions are:

| Action | Payload | Purpose |
| --- | --- | --- |
| `get` | `{}` | Read the current Accounts step. |
| `email` | `{"email":"…"}` | Send an email sign-in code. |
| `phone` | `{"phone":"…","country":"in"}` | Send a phone code; `country` is optional for an international number. |
| `resend` | `{}` | Replace and resend the current code. |
| `verify` | `{"code":"…"}` | Verify the code. |
| `signup` | `{"display_name":"…","id":"…","timezone":"…","dob":"YYYY-MM-DD"}` | Complete a new account when the flow asks for sign-up. Fields are optional when the provided defaults are acceptable. |
| `select_account` | `{"account_uuid":"…"}` | Select an offered linked account when the flow asks. |
| `details_add` | `{"email":"…"}` or `{"phone":"…","country":"in"}` | Add a missing contact on a configured Interface details page. |
| `details_verify` | `{"code":"…"}` | Verify the contact added on that page. |
| `details_continue` | `{"share":["timezone"]}` | Continue a configured page, selecting the optional details to share with the Interface. |
| `details_back` | `{}` | Return to the preceding configured page. |
| `signin_review` | `{"approve":true}` | Continue or deny the Interface's own configured details review. |
| `review` | `{}` | Once the account is verified, retrieve the Interface's app review. |
| `decision` | `{"approve":true,"optional_scopes":{"app-id":["email"]}}` | Continue or deny the reviewed app access. Optional scopes default to unselected. |

The existing Accounts limits and verification rules apply. If a network interruption occurs after verification or signup, retry the same action: a previously committed proof can return the current flow step without repeating account creation. On `flow.step = "complete"`, check `flow.outcome`: if it is `denied`, stop. Otherwise request `review`; this is an Accounts identity step, not yet the Interface's authorization code. Accounts deliberately omits its own first-party redirect and cookies from this response. Show every app and its required details, the supplied explanations and optional details before a verified Interface asks for Continue or Deny. A trusted Interface's review reports `consent_required: false`; organization policy and an account's prior removal of app access still apply.

The Interface's own details grant is separate from each app's details grant. Approved Interface details appear on the token response's `account` object; they do not expand any app token's scope. A changed Interface policy or a removed verified contact requires sign-in again on refresh.

A decision returns `redirect_to`. Redirect the visitor there; denial returns `error=access_denied` with the original state. On approval, check the state at the registered callback and exchange its code at `POST /v1/interface-auth/token` using the original verifier and a durable `Idempotency-Key`. Save the returned Interface refresh token and per-app access tokens securely, then remove the code and state from the browser address bar. A refresh uses the same token endpoint with `grant_type: "refresh_token"`; save a new operation key before each refresh and reuse that key after an uncertain response.

If an app needs an email or phone the account has not verified, Accounts returns `required_detail_missing`. The hosted Interface flow links the Carbon to account contact setup and then back to sign-in. A custom UI should offer the same path and restart review after the detail is added. If the Interface or an app's requirements change during review, start again.

## Google and Apple

Use the normal top-level hosted handoff for Google or Apple: send the visitor to `/interface-authorize` with the same `interface_id`, registered `redirect_uri`, random `state`, S256 `code_challenge` and `code_challenge_method=S256`, plus `method=google` or `method=apple`. Accounts uses its managed provider configuration, and the visitor returns to the registered callback after the app review. Accounts session cookies stay with Accounts. BYO provider credentials in the verified backend are not part of this bridge.

## Rust client

The Accounts Rust client exposes `AccountsClient::as_interface`, `InterfaceClient::verified_start`, `verified_action`, `exchange_code`, `refresh`, `introspect` and `revoke`. Its `Secret` wrapper redacts the Interface secret, capability, callback result and tokens from debug output. Keep the secret and capability on the backend even when using a Cell.
