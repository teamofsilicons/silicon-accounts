-- Silicon Accounts — initial schema.
--
-- Source of truth: the build spec 01-schema.sql (copied verbatim below; it ran unchanged on
-- Postgres 16), followed by supporting indexes and the first-party `accounts` app.
-- All times are timestamptz UTC. Account uuids are text collate "C" (case-sensitive base62).
-- Never edit an applied migration: add a new numbered file instead.

create sequence account_number_seq as bigint start with 0 minvalue 0;

create table accounts (
    uuid               text collate "C" primary key,
    number             bigint not null unique,
    kind               text not null check (kind in ('carbon', 'silicon')),
    handle             text unique,                         -- 'c:saket' / 'si:scout' lowercase; null once deleted
    status             text not null check (status in ('active', 'unclaimed', 'pending_custodian', 'deleted')),
    display_name       text not null,
    pfp_url            text not null,
    dob                date not null,
    timezone           text not null,
    -- Silicon-only columns
    custodian_uuid     text collate "C" references accounts (uuid),
    stk_hash           text,                                -- argon2id PHC string
    stk_failed_attempts integer not null default 0,
    stk_locked_until   timestamptz,
    stk_rotated_at     timestamptz,
    webhook_url        text,
    webhook_secret_enc bytea,                               -- AES-GCM (keyring version || nonce || ciphertext)
    --
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    deleted_at         timestamptz,
    version            bigint not null default 1,           -- bumped on every profile/id change (webhook ordering)
    check (kind = 'silicon' or (custodian_uuid is null and stk_hash is null and webhook_url is null)),
    check (kind = 'carbon' or status <> 'unclaimed'),
    check (status = 'deleted' or handle is not null),
    check (kind = 'carbon' or status in ('pending_custodian', 'deleted') or custodian_uuid is not null)
);
create index accounts_custodian_idx on accounts (custodian_uuid) where custodian_uuid is not null;

create table handle_reservations (
    handle         text primary key,
    account_uuid   text collate "C" not null references accounts (uuid),
    reserved_until timestamptz not null,
    created_at     timestamptz not null default now()
);

create table handle_history (
    id           bigserial primary key,
    account_uuid text collate "C" not null references accounts (uuid),
    old_handle   text,
    new_handle   text,
    changed_by   text,          -- actor account uuid, 'import', 'system'
    changed_at   timestamptz not null default now()
);
create index handle_history_account_idx on handle_history (account_uuid, changed_at desc);

create table account_emails (
    email        text primary key,                      -- normalized lowercase
    account_uuid text collate "C" not null references accounts (uuid) on delete cascade,
    is_primary   boolean not null default false,
    verified_at  timestamptz,                           -- null only for unclaimed imported rows
    verified_via text check (verified_via in ('code', 'google', 'apple')),
    created_at   timestamptz not null default now()
);
create unique index account_emails_one_primary on account_emails (account_uuid) where is_primary;
create index account_emails_account_idx on account_emails (account_uuid);

create table account_phones (
    phone        text primary key,                      -- E.164
    account_uuid text collate "C" not null references accounts (uuid) on delete cascade,
    is_primary   boolean not null default false,
    verified_at  timestamptz,
    verified_via text check (verified_via in ('code')),
    created_at   timestamptz not null default now()
);
create unique index account_phones_one_primary on account_phones (account_uuid) where is_primary;
create index account_phones_account_idx on account_phones (account_uuid);

create table identities (
    provider     text not null check (provider in ('google', 'apple')),
    subject      text not null,
    client_id    text not null,                          -- managed or BYO client that authenticated it
    account_uuid text collate "C" not null references accounts (uuid) on delete cascade,
    email        text,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    primary key (provider, subject)
);
create index identities_account_idx on identities (account_uuid);

create table photos (
    id           uuid primary key,
    account_uuid text collate "C" not null references accounts (uuid) on delete cascade,
    content_type text not null,
    bytes        bytea not null,
    created_at   timestamptz not null default now()
);

-- Apps ------------------------------------------------------------------------------------------
create table apps (
    app_id        text primary key,
    name          text not null,
    description   text not null default '',
    logo_url      text,
    logo_dark_url text,
    homepage_url  text,
    owner_uuid    text collate "C" references accounts (uuid),
    secret_hash   bytea not null,                         -- HMAC(pepper, secret)
    status        text not null default 'active' check (status in ('active', 'disabled')),
    source        text not null check (source in ('first_party', 'fake', 'silicon_apps')),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index apps_owner_idx on apps (owner_uuid);

create table app_signin_configs (
    app_id                  text primary key references apps (app_id) on delete cascade,
    version                 bigint not null default 1,
    config                  jsonb not null,               -- SigninConfig document (see 02-api.md), no secrets
    google_client_secret_enc bytea,                       -- BYO Google secret
    apple_private_key_enc   bytea,                        -- BYO Apple p8 key
    webhook_url             text,
    webhook_secret_enc      bytea,
    updated_at              timestamptz not null default now(),
    updated_by              text not null default 'system'
);

create table app_config_history (
    id      bigserial primary key,
    app_id  text not null references apps (app_id) on delete cascade,
    version bigint not null,
    actor   text not null,                                -- 'app' | account uuid | 'system' | 'silicon_apps'
    changes jsonb not null,                               -- list of {path, before, after} (secrets redacted)
    at      timestamptz not null default now()
);
create index app_config_history_app_idx on app_config_history (app_id, version desc);

create table memberships (
    app_id             text not null references apps (app_id),
    account_uuid       text collate "C" not null references accounts (uuid),
    membership_id      text generated always as (app_id || ':' || account_uuid) stored unique,
    status             text not null check (status in ('active', 'access_removed', 'imported')),
    source             text not null check (source in ('signin', 'slt', 'import')),
    granted_scopes     text[] not null default '{}',
    external_id        text,
    imported_profile   jsonb,
    first_signed_in_at timestamptz,
    last_signed_in_at  timestamptz,
    access_removed_at  timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    primary key (app_id, account_uuid)
);
create index memberships_account_idx on memberships (account_uuid);
create unique index memberships_external_idx on memberships (app_id, external_id) where external_id is not null;

-- Sessions and tokens ---------------------------------------------------------------------------
create table browser_sessions (
    id           uuid primary key,
    token_hash   bytea not null unique,
    account_uuid text collate "C" not null references accounts (uuid),
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at   timestamptz not null,
    revoked_at   timestamptz,
    ip           text,
    user_agent   text
);
create index browser_sessions_account_idx on browser_sessions (account_uuid);

create table token_families (
    id                 uuid primary key,
    app_id             text not null references apps (app_id),
    account_uuid       text collate "C" not null references accounts (uuid),
    origin             text not null check (origin in ('authorization_code', 'slt', 'silicon_login', 'device', 'cli_code')),
    scopes             text[] not null default '{}',
    browser_session_id uuid,
    label              text,
    created_at         timestamptz not null default now(),
    expires_at         timestamptz not null,
    last_used_at       timestamptz,
    revoked_at         timestamptz,
    revoke_reason      text
);
create index token_families_account_idx on token_families (account_uuid);
create index token_families_app_account_idx on token_families (app_id, account_uuid);

create table refresh_tokens (
    token_hash bytea primary key,
    family_id  uuid not null references token_families (id) on delete cascade,
    generation integer not null,
    created_at timestamptz not null default now(),
    used_at    timestamptz
);
create index refresh_tokens_family_idx on refresh_tokens (family_id);

create table authorization_codes (
    code_hash             bytea primary key,
    flow_id               text not null,
    app_id                text not null references apps (app_id),
    account_uuid          text collate "C" not null references accounts (uuid),
    redirect_uri          text not null,
    code_challenge        text,
    code_challenge_method text,
    scopes                text[] not null,
    nonce                 text,
    browser_session_id    uuid,
    created_at            timestamptz not null default now(),
    expires_at            timestamptz not null,
    consumed_at           timestamptz
);

create table short_lived_tokens (
    token_hash   bytea primary key,
    account_uuid text collate "C" not null references accounts (uuid),
    app_id       text not null references apps (app_id),
    scopes       text[] not null,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    consumed_at  timestamptz
);

create table device_authorizations (
    device_code_hash bytea primary key,
    user_code        text not null unique,
    app_id           text not null default 'accounts' references apps (app_id),
    status           text not null check (status in ('pending', 'approved', 'denied', 'consumed')),
    account_uuid     text collate "C" references accounts (uuid),
    client_label     text,
    created_at       timestamptz not null default now(),
    expires_at       timestamptz not null,
    approved_at      timestamptz,
    last_polled_at   timestamptz
);

-- Sign-in flows ---------------------------------------------------------------------------------
create table signin_flows (
    id                    text primary key,               -- random base64url
    binding_hash          bytea not null,                 -- HMAC of the saf_ cookie that owns this flow
    app_id                text not null references apps (app_id),
    redirect_uri          text not null,
    state                 text,
    code_challenge        text,
    code_challenge_method text,
    nonce                 text,
    requested_scopes      text[] not null default '{}',
    prompt                text,
    login_hint            text,
    method_hint           text,
    step                  text not null,                  -- choose_method | verify_code | signup | requirements | consent | complete | failed
    account_uuid          text collate "C" references accounts (uuid),
    signup_session_id     uuid,
    challenge_id          uuid,
    provider_state        jsonb,                          -- {provider, state_hash, nonce, pkce_verifier_enc, client_mode}
    result_redirect       text,                           -- final redirect (complete/failed)
    created_at            timestamptz not null default now(),
    expires_at            timestamptz not null,           -- 60 minutes
    completed_at          timestamptz
);

create table otp_challenges (
    id           uuid primary key,
    purpose      text not null check (purpose in ('signin', 'add_email', 'add_phone', 'requirement', 'cli_login', 'delete_account')),
    channel      text not null check (channel in ('email', 'phone')),
    destination  text not null,                           -- normalized email or E.164
    code_hash    bytea not null,
    account_uuid text collate "C" references accounts (uuid),
    flow_id      text,
    failed_streak integer not null default 0,
    total_failures integer not null default 0,
    locked_until timestamptz,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    consumed_at  timestamptz
);
create index otp_challenges_destination_idx on otp_challenges (destination, created_at desc);

create table signup_sessions (
    id                    uuid primary key,
    secret_hash           bytea not null,
    verified_email        text,
    verified_phone        text,
    provider              text,
    provider_subject      text,
    provider_client_id    text,
    provider_email        text,
    suggested_display_name text,
    suggested_pfp_url     text,
    claim_account_uuid    text collate "C" references accounts (uuid),   -- unclaimed imported account being finished
    created_at            timestamptz not null default now(),
    expires_at            timestamptz not null,           -- created_at + 48 hours
    consumed_at           timestamptz,
    account_uuid          text collate "C" references accounts (uuid)
);

create table rate_limits (
    bucket            text primary key,                   -- e.g. 'otp_send:dest:<hash>' 'otp_send:ip:<ip>'
    window_started_at timestamptz not null,
    count             integer not null,
    blocked_until     timestamptz
);

-- Silicons and custodians -----------------------------------------------------------------------
create table custodian_requests (
    id                 uuid primary key,
    silicon_uuid       text collate "C" not null references accounts (uuid),
    kind               text not null check (kind in ('initial', 'transfer')),
    from_uuid          text collate "C" references accounts (uuid),
    to_uuid            text collate "C" references accounts (uuid),
    to_email           text,                              -- set when named by an email with no account yet
    status             text not null check (status in ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    request_token_hash bytea,                             -- initial requests: lets the Silicon poll
    created_at         timestamptz not null default now(),
    expires_at         timestamptz not null,              -- created_at + 14 days
    decided_at         timestamptz,
    decided_by         text collate "C"
);
create unique index custodian_requests_one_pending on custodian_requests (silicon_uuid) where status = 'pending';
create index custodian_requests_to_idx on custodian_requests (to_uuid) where status = 'pending';
create index custodian_requests_email_idx on custodian_requests (to_email) where status = 'pending';

create table custodian_history (
    id           bigserial primary key,
    silicon_uuid text collate "C" not null references accounts (uuid),
    from_uuid    text collate "C" references accounts (uuid),
    to_uuid      text collate "C" not null references accounts (uuid),
    kind         text not null check (kind in ('created_by_custodian', 'initial_accepted', 'transfer')),
    request_id   uuid,
    at           timestamptz not null default now()
);
create index custodian_history_silicon_idx on custodian_history (silicon_uuid, at desc);

-- Proofs ----------------------------------------------------------------------------------------
create table proof_families (
    id                 uuid primary key,
    kind               text not null check (kind in ('obo', 'ata')),
    issuing_app        text not null references apps (app_id),
    audiences          text[] not null,
    account_uuid       text collate "C" references accounts (uuid),   -- OBO subject
    subject_family_id  uuid references token_families (id),           -- OBO: the user's grant at the issuing app
    scopes             text[] not null default '{}',
    access_ttl_seconds integer not null,
    created_at         timestamptz not null default now(),
    expires_at         timestamptz not null,
    last_refreshed_at  timestamptz,
    revoked_at         timestamptz,
    revoked_by         text,
    revoke_reason      text,
    check ((kind = 'obo') = (account_uuid is not null))
);
create index proof_families_account_idx on proof_families (account_uuid) where account_uuid is not null;
create index proof_families_issuer_idx on proof_families (issuing_app, created_at desc);

create table proof_tokens (
    token_hash bytea primary key,
    family_id  uuid not null references proof_families (id) on delete cascade,
    kind       text not null check (kind in ('access', 'refresh')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at    timestamptz
);
create index proof_tokens_family_idx on proof_tokens (family_id);

-- Webhooks --------------------------------------------------------------------------------------
create table webhook_events (
    event_id     uuid primary key,                         -- UUIDv7, one per (event, target)
    type         text not null,
    target_kind  text not null check (target_kind in ('app', 'silicon')),
    target_id    text not null,                            -- app_id or silicon uuid
    account_uuid text collate "C",
    payload      jsonb not null,                           -- full JSON body that is signed and sent
    occurred_at  timestamptz not null default now()
);
create index webhook_events_target_idx on webhook_events (target_kind, target_id, occurred_at desc);

create table webhook_deliveries (
    id              uuid primary key,
    event_id        uuid not null references webhook_events (event_id),
    target_kind     text not null,
    target_id       text not null,
    url             text not null,
    status          text not null check (status in ('pending', 'delivered', 'failed')),
    attempts        integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    locked_until    timestamptz,
    last_attempt_at timestamptz,
    last_status     integer,
    last_error      text,
    delivered_at    timestamptz,
    manual_replays  integer not null default 0,
    created_at      timestamptz not null default now()
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_target_idx on webhook_deliveries (target_kind, target_id, created_at desc);

create table webhook_attempts (
    id           bigserial primary key,
    delivery_id  uuid not null references webhook_deliveries (id) on delete cascade,
    attempted_at timestamptz not null default now(),
    status_code  integer,
    error        text,
    duration_ms  integer not null
);

-- Messaging, reports, imports, idempotency, history -------------------------------------------
create table outbound_messages (
    id                  uuid primary key,
    channel             text not null check (channel in ('email', 'sms')),
    to_address          text not null,
    subject             text,
    text_body           text not null,
    html_body           text,
    purpose             text not null,                    -- otp_signin, otp_add_email, custodian_request, report, ...
    status              text not null check (status in ('pending', 'sent', 'failed', 'local')),
    attempts            integer not null default 0,
    next_attempt_at     timestamptz not null default now(),
    provider_message_id text,
    last_error          text,
    created_at          timestamptz not null default now(),
    sent_at             timestamptz
);
create index outbound_messages_due_idx on outbound_messages (next_attempt_at) where status = 'pending';
create index outbound_messages_to_idx on outbound_messages (to_address, created_at desc);

create table bug_reports (
    id           uuid primary key,
    account_uuid text collate "C",
    message      text not null,
    pr_url       text,
    created_at   timestamptz not null default now()
);

create table import_jobs (
    id              uuid primary key,
    app_id          text not null references apps (app_id),
    status          text not null check (status in ('queued', 'running', 'completed', 'failed')),
    format          text not null check (format in ('json', 'csv')),
    options         jsonb not null default '{}',
    total_rows      integer not null default 0,
    processed_rows  integer not null default 0,
    counts          jsonb not null default '{}',           -- {created, matched, updated, skipped, error}
    error           text,
    created_by      text not null,                         -- 'app' | account uuid
    created_at      timestamptz not null default now(),
    started_at      timestamptz,
    finished_at     timestamptz
);
create index import_jobs_app_idx on import_jobs (app_id, created_at desc);

create table import_job_rows (
    job_id       uuid not null references import_jobs (id) on delete cascade,
    row_number   integer not null,                         -- 1-based data row (excluding CSV header)
    input        jsonb not null,
    outcome      text not null check (outcome in ('pending', 'created', 'matched', 'updated', 'skipped', 'error')),
    account_uuid text collate "C",
    messages     jsonb not null default '[]',              -- [{level: 'error'|'warning'|'info', code, message, field?}]
    primary key (job_id, row_number)
);

create table idempotency_keys (
    scope        text not null,                            -- caller + endpoint, e.g. 'app:briefcase:POST /v1/proofs/obo'
    key          text not null,
    request_hash bytea not null,
    status_code  integer not null,
    response     jsonb not null,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    primary key (scope, key)
);

create table audit_log (
    id           bigserial primary key,
    at           timestamptz not null default now(),
    actor_kind   text not null,                            -- 'account' | 'app' | 'system' | 'internal'
    actor_id     text,
    action       text not null,                            -- dotted, e.g. 'silicon.stk.rotated'
    target_kind  text,
    target_id    text,
    app_id       text,
    account_uuid text collate "C",
    details      jsonb not null default '{}',
    ip           text
);
create index audit_log_account_idx on audit_log (account_uuid, at desc);
create index audit_log_app_idx on audit_log (app_id, at desc);

create table signin_history (
    id           bigserial primary key,
    account_uuid text collate "C" references accounts (uuid),
    app_id       text,
    method       text not null,                            -- email | phone | google | apple | silicon_stk | slt | device | session
    outcome      text not null,                            -- success | failed | new_account
    ip           text,
    user_agent   text,
    at           timestamptz not null default now()
);
create index signin_history_account_idx on signin_history (account_uuid, at desc);
create index signin_history_app_idx on signin_history (app_id, at desc);

-- Additions to the spec schema -------------------------------------------------------------------
-- GET /v1/me/sessions lists first-party token families (CLI / Silicon sign-ins) with ip and
-- user_agent, so the family keeps where it was created from.
alter table token_families add column ip text, add column user_agent text;

-- Supporting indexes ----------------------------------------------------------------------------
-- Not in the spec schema; they back lookups and sweeps the services run often.
create index handle_reservations_account_idx on handle_reservations (account_uuid);
create index custodian_requests_silicon_idx on custodian_requests (silicon_uuid, created_at desc);
create index token_families_browser_session_idx on token_families (browser_session_id) where browser_session_id is not null;
create index memberships_app_created_idx on memberships (app_id, created_at desc);
create index signin_flows_expires_idx on signin_flows (expires_at);
create index otp_challenges_expires_idx on otp_challenges (expires_at);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);
create index signup_sessions_expires_idx on signup_sessions (expires_at);
create index device_authorizations_expires_idx on device_authorizations (expires_at);
create index webhook_events_account_idx on webhook_events (account_uuid, occurred_at desc) where account_uuid is not null;

-- First-party app -------------------------------------------------------------------------------
-- `accounts` is the account site and the accounts CLI. It is a public client: its secret_hash is
-- the hash of a random value nobody knows, and the token endpoint never checks it for the device
-- and CLI grants. Its redirect URIs are not stored: code accepts any redirect_uri on
-- ACCOUNTS_PUBLIC_URL or an ACCOUNTS_EXTRA_ALLOWED_ORIGINS origin. Google and Apple are switched
-- on at runtime only when managed credentials are configured, and it never shows a consent screen.
insert into apps (app_id, name, description, homepage_url, secret_hash, status, source)
values (
    'accounts',
    'Silicon Accounts',
    'The account site and the accounts CLI.',
    'https://account.teamofsilicons.com',
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')),
    'active',
    'first_party'
);

insert into app_signin_configs (app_id, version, config, updated_by)
values (
    'accounts',
    1,
    '{
        "methods": {"email": true, "phone": true, "google": false, "apple": false},
        "method_order": ["google", "apple", "email", "phone"],
        "google": {"mode": "managed", "client_id": null, "prompt": "select_account", "hosted_domain": null},
        "apple": {"mode": "managed", "services_id": null, "team_id": null, "key_id": null},
        "redirect_uris": [],
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
values ('accounts', 1, 'system', '[{"path": "", "before": null, "after": "first-party app created by migration 0001_init"}]'::jsonb);
