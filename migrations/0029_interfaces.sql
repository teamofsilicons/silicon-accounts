-- Accounts is the authority for interface authentication and creator eligibility.
-- The registry can submit changes only through the authenticated internal bridge.
create table interface_creator_eligibility (
    account_uuid text collate "C" primary key references accounts(uuid),
    verified boolean not null default false,
    trusted boolean not null default false,
    updated_at timestamptz not null default now(),
    check (not trusted or verified)
);

create table interface_auth_clients (
    interface_id text primary key,
    owner_uuid text collate "C" not null references accounts(uuid),
    revision bigint not null check (revision > 0),
    kind text not null check (kind in ('unverified','verified','trusted')),
    name text not null,
    logo_url text,
    app_ids text[] not null,
    redirect_uris text[] not null,
    allowed_origins text[] not null,
    branding jsonb not null,
    signin_config jsonb not null,
    app_descriptions jsonb not null,
    active boolean not null,
    secret_hash bytea not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- A sealed sync result commits with its mutation. Even after the secret replay
-- window expires, retaining the request key prevents an uncertain retry from
-- rotating the secret a second time.
create table interface_sync_operations (
    interface_id text not null references interface_auth_clients(interface_id),
    key text not null,
    request_hash bytea not null,
    sealed_response jsonb not null,
    created_at timestamptz not null default now(),
    primary key(interface_id, key)
);

create table interface_tier_requests (
    id uuid primary key,
    interface_id text not null references interface_auth_clients(interface_id),
    actor_uuid text collate "C" not null references accounts(uuid),
    kind text not null check (kind in ('verified','trusted')),
    reason text not null,
    status text not null default 'pending' check (status in ('pending','approved','rejected')),
    created_at timestamptz not null default now(),
    reviewed_at timestamptz
);
create unique index interface_tier_requests_pending on interface_tier_requests(actor_uuid,kind) where status='pending';
create table interface_tier_request_operations (
    interface_id text not null references interface_auth_clients(interface_id),
    key text not null,
    request_hash bytea not null,
    request_id uuid not null references interface_tier_requests(id),
    created boolean not null,
    primary key(interface_id,key)
);
create table interface_tier_request_notifications (
    request_id uuid not null references interface_tier_requests(id),
    recipient text not null,
    message_id uuid not null references outbound_messages(id),
    primary key(request_id,recipient)
);

-- A browser approval is bound to both its Accounts session and the revision
-- whose app list was displayed. Codes and all refresh credentials are hashed.
create table interface_login_flows (
    id text primary key,
    interface_id text not null references interface_auth_clients(interface_id),
    interface_revision bigint not null,
    account_uuid text collate "C" not null references accounts(uuid),
    browser_session_id uuid not null references browser_sessions(id),
    redirect_uri text not null,
    state text not null,
    code_challenge text not null,
    app_ids text[] not null,
    app_descriptors jsonb not null,
    kind text not null,
    result_sealed bytea,
    code_hash bytea unique,
    decision text check (decision in ('approved','denied')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '10 minutes',
    code_expires_at timestamptz,
    consumed_at timestamptz,
    session_id uuid
);
create table interface_sessions (
    id uuid primary key,
    interface_id text not null references interface_auth_clients(interface_id),
    account_uuid text collate "C" not null references accounts(uuid),
    approved_apps text[] not null,
    kind text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '900 days',
    revoked_at timestamptz,
    revoke_reason text
);
create index interface_sessions_interface on interface_sessions(interface_id) where revoked_at is null;
create table interface_refresh_tokens (
    token_hash bytea primary key,
    session_id uuid not null references interface_sessions(id),
    used_at timestamptz,
    created_at timestamptz not null default now()
);
create table interface_app_token_families (
    family_id uuid primary key references token_families(id) on delete cascade,
    session_id uuid not null references interface_sessions(id),
    app_id text not null references apps(app_id)
);
create index interface_app_token_families_session on interface_app_token_families(session_id);
create table interface_token_operations (
    interface_id text not null references interface_auth_clients(interface_id),
    key text not null,
    request_hash bytea not null,
    session_id uuid not null references interface_sessions(id),
    sealed_response jsonb not null,
    created_at timestamptz not null default now(),
    primary key(interface_id,key)
);
