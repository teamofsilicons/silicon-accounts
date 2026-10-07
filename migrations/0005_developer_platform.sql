-- Silicon Accounts — the developer platform's first-party app, the accounts site's new domain,
-- and hosted sign-in flows without an app's login_hint.
--
-- 0001 to 0004 are applied and never edited; everything below builds on them.

-- 1. The first-party app `developer` ------------------------------------------------------------
-- developer.teamofsilicons.com is the developer platform: one site where developers set up
-- everything about their apps' authentication. Carbons sign into it like into any app, through
-- the hosted pages, as the first-party app `developer`:
-- - a public client: there is no secret (secret_hash is the hash of a random value nobody
--   knows); the token endpoint accepts client_id=developer without a secret for the
--   authorization_code grant (PKCE S256 required), the refresh_token grant and revocation;
-- - its only redirect URI is {ACCOUNTS_DEVELOPER_URL}/auth/callback, compared exactly. The value
--   stored below is the production one; accounts-api rewrites it at start-up when
--   ACCOUNTS_DEVELOPER_URL says otherwise (http://localhost:8600 in development);
-- - like `accounts`: email and phone codes, Google and Apple only when managed credentials are
--   configured (a managed provider without them is never offered), no consent screen and no
--   membership (it is Silicon Accounts itself, not an app with a user base);
-- - its access tokens (aud = developer) may only read the signed-in Carbon and manage the apps
--   that Carbon owns (accounts_core::http::auth).
-- Nobody owns it and it has no secret, so no app credentials or owner session can change it.
insert into apps (app_id, name, description, homepage_url, secret_hash, status, source)
values (
    'developer',
    'Silicon Developer',
    'The developer platform: set up sign-in, flows, users, webhooks and proofs for the apps you build.',
    'https://developer.teamofsilicons.com',
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')),
    'active',
    'first_party'
);

insert into app_signin_configs (app_id, version, config, updated_by)
values (
    'developer',
    1,
    '{
        "methods": {"email": true, "phone": true, "google": true, "apple": true},
        "method_order": ["google", "apple", "email", "phone"],
        "google": {"mode": "managed", "client_id": null, "prompt": "select_account", "hosted_domain": null},
        "apple": {"mode": "managed", "services_id": null, "team_id": null, "key_id": null},
        "redirect_uris": ["https://developer.teamofsilicons.com/auth/callback"],
        "allowed_origins": [],
        "required_fields": [],
        "optional_fields": [],
        "allowed_email_domains": [],
        "allow_signup": true,
        "remember_browser": true,
        "branding": {},
        "copy": {"title": null, "subtitle": null, "terms_url": null, "privacy_url": null, "support_email": null}
    }'::jsonb,
    'system'
);

insert into app_config_history (app_id, version, actor, changes)
values ('developer', 1, 'system', '[{"path": "", "before": null, "after": "first-party app created by migration 0005_developer_platform"}]'::jsonb);

-- 2. The account site moved to accounts.teamofsilicons.com -------------------------------------
-- The first-party app `accounts` still pointed at the old account.teamofsilicons.com.
update apps
   set homepage_url = 'https://accounts.teamofsilicons.com', updated_at = now()
 where app_id = 'accounts' and homepage_url = 'https://account.teamofsilicons.com';

-- 3. Hosted sign-in flows no longer keep an app's login_hint ------------------------------------
-- An app can never hand Silicon Accounts a Carbon's email or phone (the Carbon always types it on
-- the hosted pages): /authorize accepts login_hint without an error and ignores it, so the column
-- that kept it goes. A flow's intent (signin|signup) and its progress through the details pages
-- live in its provider_state document, owned by the auth crate.
alter table signin_flows drop column login_hint;
