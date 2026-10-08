# silicon-accounts-account (`accounts_account`)

Account management for a signed-in Carbon or Silicon, plus the account lookups. Built on
`accounts_core` (see `crates/core/README.md`); the server merges `accounts_account::router()`
and starts `accounts_account::spawn_background(state)` (an hourly sweep of id reservations that
ended over a day ago).

Auth: **session** = the `sa_session` cookie (mutations need an allowed `Origin`) or
`Authorization: Bearer <access token with aud=accounts>`. **app** = `Authorization: Basic
base64(app_id:app_secret)`. Errors use the standard body `{"error":{"code","message","hint","details"}}`.
Timestamps are RFC 3339 UTC with milliseconds. Lists are `{"items":[…],"next_cursor":…}`
(`?limit=1..200&cursor=`).

## Lookups

| route | auth | response |
|---|---|---|
| `GET /v1/ids/available?id=c:saket` | public, 120/min per IP (429 `rate_limited`) | `{"id","available","reason":"taken"\|"reserved"\|"reserved_word"\|"invalid"\|null,"message","reclaimable","suggestions":[…]}`; `suggestions` holds up to 3 free ids close to the one asked for (empty when it is available or has no prefix); with a session, an id reserved for the caller is `available:true, reclaimable:true`; a custodian adds `&for=<uuid or si:id>` of one of its Silicons to ask for that Silicon (an id reserved for it is `available:true, reclaimable:true`, and the message names the Silicon; another Carbon's Silicon → 404 `silicon_not_found`; no session → 401 `unauthenticated`; a blank `for` is ignored); invalid ids are a 200 answer; missing `id` → 400 `invalid_query` |
| `GET /v1/accounts/{uuid}` | app or session; 600 per minute per app or per account, both lookup routes together (429 `rate_limited`) | session: AccountSummary `{"uuid","kind","id","display_name","pfp_url","status"}`; Silicons add `"custodian": AccountSummary\|null`. app: the public identity only, `{"uuid","kind","id","status"}`; Silicons add `"custodian": {"uuid","id"}\|null` (never a display name or photo: an account shares those with an app by signing in to it and takes them back by removing its access, so apps read them from their user base, `GET /v1/apps/{app_id}/users/{uuid}`). 400 `invalid_uuid` (the hint points to by-id when given an id), 404 `account_not_found`, 404 `account_deleted` |
| `GET /v1/accounts/by-id/{id}` | app or session; same limit | same view; current ids only. 400 `invalid_id`, 404 `account_not_found` (hint says when the id was released recently) |

## Profile and id (`session`, Carbons and Silicons)

- `GET /v1/me` → Me (core `MeView`: Carbon `emails`, `phones`, `identities` (with `subject`),
  `custodian_of`; Silicon `custodian`, `webhook_url`, `stk_rotated_at`).
- `PATCH /v1/me` `{"display_name"?,"timezone"?,"dob"?,"pfp_url"?}` → Me. Only real changes are
  written; `version` bumps; member apps (live memberships with a webhook) get `account.updated`
  with only the changed fields their granted scopes can see (apps that can see none are
  skipped); a Silicon's own webhook gets `silicon.updated`. `"pfp_url": null` = default photo.
  A new `pfp_url` on this service must be the caller's own upload, written exactly as
  `POST /v1/me/photo` returned it: `{PUBLIC_URL}/v1/photos/{photo_id}` with a lowercase id and
  no query string, `#fragment` or extra path. Any other spelling is a 422 whose message gives
  the exact URL. Sending back the current `pfp_url` unchanged is always accepted, even when it
  isn't the caller's upload (a Silicon whose custodian set its photo). The check is core's
  `repo::photos::check_usable`, run under the account's row lock, so a photo can't be pruned
  between the check and the update. Every bad
  field is reported at once: 422 `validation_failed` with `details.fields` (fields that live
  elsewhere, like `id` or `email`, say which endpoint to use). A Silicon's dob: 422
  `dob_immutable` (sending the current value is fine). Accepts `Idempotency-Key`.
- `POST /v1/me/id` `{"id":"c:new"}` (bare handle → the account's prefix) → Me. Old id reserved
  10 days for this account; reclaiming one's own reserved id removes that reservation. Apps get
  `account.id_changed`, a Silicon `silicon.id_changed`. At most 5 id changes per account in any
  24 hours (`ID_CHANGES_PER_DAY`, enforced by core's `accounts::change_id` for every caller, so
  `POST /v1/me/silicons/{uuid}/id` shares it), counting every change of the account's id by
  anyone (a Silicon's custodian too) and reclaims. Asking for the current id again is a no-op and always
  allowed. Over the limit: 429 `rate_limited` with `Retry-After` and `details.limit`,
  `details.window_seconds`, `details.retry_at`. This bounds the reserved ids one account can
  hold (at most 50) and the webhooks it can cause. 422 `invalid_id` (`details.reason`), 409
  `id_taken` (`details.suggestions`), 409 `id_reserved` (`details.reserved_until`). Accepts
  `Idempotency-Key`.

## Photos

- `POST /v1/me/photo` — (the reading rules live in core's `photo_upload`, shared with a custodian's
  `POST /v1/me/silicons/{uuid}/photo` and the sign-up page's `POST /v1/flows/{id}/signup/photo`)
  raw image body, `Content-Type` image/png, image/jpeg (also image/jpg),
  image/webp or image/gif, at most 2 MB (2 097 152 bytes). The bytes must be that format
  (checked by signature) and at most 8192 px a side / 50 megapixels. → **201**
  `{"pfp_url":"{PUBLIC_URL}/v1/photos/{photo_id}","photo":{"id","content_type","bytes","width","height"},"me":Me}`.
  Apps get `account.updated` (`pfp_url`). Older uploads of the account are deleted (core's
  `repo::photos::prune`), except
  those another account that isn't deleted still shows. That is a Silicon its custodian gave the
  photo to, even after the Silicon was transferred; such an upload goes at the uploader's next
  photo change once nobody shows it. 20 uploads per account per hour. Errors: 415
  `unsupported_media_type`, 413 `photo_too_large`, 422 `empty_photo` / `invalid_image` /
  `photo_type_mismatch` (`details.detected_content_type`) / `photo_dimensions_too_large`.
  Accepts `Idempotency-Key`. **The route reads the body itself; a server-wide body limit must
  let at least 2 MB through on this route.**
- `DELETE /v1/me/photo` → Me, back to `{IRIS}/pfp/{carbon|silicon}?id={uuid}`; uploads nobody
  else shows are deleted.
- `GET /v1/photos/{id}` — public. Stored type, `Cache-Control: public, max-age=31536000,
  immutable`, `ETag` (304 on `If-None-Match`, which only checks that the photo still exists and
  never reads its bytes), `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
  default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`. 404
  `photo_not_found` (also for a revalidation of a removed photo).

## Emails and phones (`session`, Carbons only — Silicons get 403 `carbon_only`)

| route | response |
|---|---|
| `GET /v1/me/emails` | `{"items":[{"email","is_primary","verified_at","verified_via","created_at"}],"next_cursor":null}` (primary first) |
| `POST /v1/me/emails` `{"email"}` | **201** `{"challenge_id","channel":"email","destination","expires_at","resend_available_at"}` — a 6-digit code (purpose `add_email`) goes to the address. 409 `email_in_use` / `email_already_added`, 422 `email_limit_reached` (10) / `invalid_email`, 429 `rate_limited` (10 codes per address per 10 minutes; and every add attempt counts before any 409/422 answer: 20 per account per 10 minutes for emails and phones together, `CONTACT_ADDS_PER_ACCOUNT`, and 30 per client IP per 10 minutes, `CONTACT_ADDS_PER_IP`, so `email_in_use` can't be used to check addresses without limit). Accepts `Idempotency-Key` |
| `POST /v1/me/emails/verify` `{"challenge_id","code"}` | the updated list. 422 `invalid_code` (`details.remaining_attempts`), 423 `verification_locked`, 410 `code_expired`, 409 `code_already_used`, 404 `challenge_not_found`, 409 `email_in_use` if someone proved it first, 409 `account_deleted` if the account was deleted while the request was in flight (nothing is added). Wrong codes count **per address** (core's `otp::verify`), together with every sign-in code and every other account's add code to the same address: 10 wrong in a row lock the address for 60 s, so adding someone else's address never buys more guesses than signing in with it. Accepts `Idempotency-Key` |
| `POST /v1/me/emails/{email}/primary` | the updated list. 404 `email_not_found`, 409 `email_not_verified` |
| `DELETE /v1/me/emails/{email}` | the updated list. 409 `cannot_remove_primary`, 404 `email_not_found` |

Phones: the same under `/v1/me/phones` with `{"phone","country"?}` (E.164, or a local number
with an ISO country), purpose `add_phone`, errors `phone_*` / `invalid_phone` /
`invalid_country`. A new primary (including the first one added), or an unverified (imported)
primary that gets verified (apps see `email_verified` / `phone_verified` change), bumps
`version` and sends `account.updated` (`email` / `phone`) to apps holding that scope.

## Identities, apps, sessions

- `GET /v1/me/identities` (Carbon) → `{"items":[{"provider","subject","email","created_at","last_used_at"}],"next_cursor":null}`.
  Connecting one from the account site is the auth crate's `POST /v1/me/identities/{provider}`
  (a browser round trip through Google or Apple that also adds the provider's verified email).
- `DELETE /v1/me/identities/{provider}/{subject}` → 204. 400 `invalid_provider`, 404
  `identity_not_found`, 409 `last_sign_in_method` (no email or phone left to sign in with).
- `GET /v1/me/apps?status=active|access_removed|imported&limit&cursor` → items
  `{"app":{"app_id","name","logo_url","logo_dark_url","homepage_url"},"membership_id","status","source","granted_scopes","first_signed_in_at","last_signed_in_at","access_removed_at","active_sessions"}`,
  most recently used first; the first-party apps (`accounts`: the account site and CLI;
  `developer`: the developer platform) are not listed.
- `DELETE /v1/me/apps/{app_id}` → 204: the app's token families for the account and the User verification
  proofs it issued about the account are revoked, the membership becomes `access_removed`, the
  app gets `membership.access_removed`. Repeating it does nothing (no second webhook). 404
  `membership_not_found`, 400 `first_party_app` for `accounts` and `developer` (Silicon
  Accounts' own apps hold sessions, not access: the hint points to `DELETE /v1/me/sessions/{id}`).
- `GET /v1/me/sessions?limit&cursor` → items `{"id","kind":"browser"|"cli"|"developer","label","origin","ip","user_agent","created_at","last_seen_at","expires_at","current"}`
  (browser sessions, live `aud=accounts` token families as `cli` and live `aud=developer` ones
  as `developer`, labelled "Silicon Developer (developers.teamofsilicons.com)"), newest first. A browser session's
  `label` describes its user agent the way sign-in history does (`sessions::describe_user_agent`):
  "Safari on macOS" for a browser (only a `Mozilla/…` or `Opera/…` agent is ever called one, "A
  browser" when it isn't recognized), "accounts CLI 0.1.0" for the CLI
  (`accounts-cli/<v> silicon-accounts-client/<v>`), "Silicon Accounts Rust package 0.1.0" for
  the package (after the program's own product when it names one: "dm 2.0 (Silicon Accounts Rust
  package 0.1.0)"), any other program by its product ("curl 8.4.0"), else "An unknown client".
- `DELETE /v1/me/sessions/{id}` → 204; revoking the calling cookie session also clears the
  cookie. 404 `session_not_found` (unknown, another account's, or another app's sign-in).

## History

`GET /v1/me/history?kind=signin|id_change|custodian|proof|app_access|security&limit&cursor` →
items `{"id","kind","at","title","detail","app":AppSummary|null,"meta":{…}}`, newest first,
stable keyset pagination. Sources: `signin_history` (signin), `handle_history` (id_change),
`custodian_history` (custodian), `proof_families` User verification proofs about the account, issued and
revoked (proof), `memberships` first sign-in and imports (app_access), and `audit_log` rows
with `account_uuid` = the account: actions `membership.*`, `consent.*`, `app_access.*` →
app_access; actions containing `custodian` or `transfer` → custodian; everything else →
security. To avoid duplicates, audit actions `proof.*`, `account.id.*`, `silicon.id.*` and
custodian/transfer actions ending in `.accepted` are not shown. Audit rows that another actor
wrote into the account's history (a custodian's action on its Silicon, a Silicon naming this
Carbon as custodian, an app, the service) show `meta.ip: null` and mask email addresses and
phone numbers in `meta.details`; only the account's own actions show their IP; a row written by
another account adds `By c:…` to `detail`. Every audit row about a Silicon (target `silicon`)
names it in its title by its current si:id (or the id the row recorded once it was deleted):
"STK of si:scout rotated", "Webhook of si:scout set" (detail "Events go to https://…"),
"Profile of si:scout updated", "New profile photo for si:scout", "Transfer of si:scout to c:x
requested", "Custodian request of si:scout declined"…, and carries the Silicon's AccountSummary
in `meta.silicon`. 400 `invalid_history_kind`, 400 `invalid_cursor`.

Titles and details are sentences, never codes. A sign-in's detail is `from {ip} · {client}`
(the client as for sessions above). A revoked proof's detail says why in the Proofs page's words:
"Revoked by you", "Revoked by DM", "Revoked by DM's owner", "Revoked because its refresh token
was used twice, which can mean it leaked", "Ended when your sign-in at DM ended", "Ended when
you removed DM's access"; only an unknown reason falls back to "Revoked by … (reason)". Audit
actions written by other crates have titles of their own (`history::other_entry`), for example
`contact.added` (auth's requirement step) → "Phone number added while signing in to DM" (with
the address when the entry records it as `details.email` / `details.phone`), `identity.linked`
→ "Google account connected", `session.created` → "New CLI sign-in", `device.approved` →
"Approved a terminal sign-in", `signin.locked` → "Too many wrong codes for s***@example.com",
`oauth.refresh_reuse_detected` → "Sign-in at DM ended"; an action nobody mapped yet shows its
code in words. Sign-outs are named as what was signed out: `account.session.revoked` (Settings)
→ "A browser session was signed out", "A CLI sign-in was signed out" or "A developer site
sign-in was signed out" (detail "Silicon Developer (developers.teamofsilicons.com)"), and
`oauth.token_revoked` of a first-party sign-in → "Signed out of a CLI sign-in" (the family's
label as detail, never the internal `code:…` marker) or "Signed out of the developer site".

## Deleting the account

`DELETE /v1/me` `{"confirm":"c:saket"}` (Carbons; case-insensitive, bare handle accepted) → 204
(+ cookie cleared for cookie sessions). 422 `confirmation_required` / `confirmation_mismatch`;
409 `custodian_of_silicons` (`details.silicons`: AccountSummary list) while custodian of any
non-deleted Silicon; Silicons get 403 `custodian_required` (their custodian deletes them). The
deletion is core's `accounts::delete_account`, in one transaction: status `deleted`, id reserved
10 days, emails/phones/identities removed, sessions, token families and User verification proofs revoked,
pending custodian requests cancelled, `pfp_url` reset and the uploads no other account shows
deleted, the apps' imported personal data about the account dropped (`imported_profile`; their
`external_id` stays), `account.deleted` to every live member app. A second `DELETE /v1/me`
already in flight waits for the first and answers 204 without doing anything, so apps hear about
the deletion once. If the id changed while the request waited, it answers 422
`confirmation_mismatch` and nothing is deleted. Self-created Silicons still waiting for this
Carbon to accept are released (id free at once) and get `silicon.custodian.declined`
`{uuid,id,request_id,custodian,decided_at,reason:"custodian_account_deleted",released:true}`
(core's `events::silicon_custodian_declined`, the payload the silicons crate sends), with the
`silicon.custodian_request.closed` audit entry. Their webhook URL/secret are kept so that notice
can be delivered. The `account.deleted` audit entry lists `released_silicons` and
`deleted_photos`.

## Tests

```bash
scripts/dev-db.sh   # Postgres on 127.0.0.1:5444
CARGO_TARGET_DIR=target/account cargo test -p silicon-accounts-account
```
