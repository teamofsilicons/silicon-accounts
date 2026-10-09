-- Workload identity federation: trust relationships that let an outside OIDC token (a GitHub
-- Actions or GitLab CI job, any HTTPS OpenID Connect issuer) sign a Silicon in with no stored
-- secret, and identity tokens a Silicon presents to cloud providers.

-- One trust: tokens from `issuer`, for `audience`, whose claims equal every condition.
create table silicon_federations (
    id           uuid primary key,
    silicon_uuid text collate "C" not null references accounts (uuid) on delete cascade,
    name         text not null,
    issuer       text not null,
    audience     text not null,
    conditions   jsonb not null check (jsonb_typeof(conditions) = 'object' and conditions <> '{}'::jsonb),
    created_by   text collate "C" not null,                 -- the Silicon or its custodian
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    revoked_by   text collate "C"
);
create index silicon_federations_silicon_idx on silicon_federations (silicon_uuid, created_at);

-- Every outside token's (issuer, jti) until it expires: an outside token signs in once.
create table federated_token_uses (
    issuer        text not null,
    jti           text not null,
    federation_id uuid not null,
    expires_at    timestamptz not null,
    primary key (issuer, jti)
);
create index federated_token_uses_expires_idx on federated_token_uses (expires_at);

-- Which trust started a sign-in, so removing the trust ends the sign-ins it started.
create table silicon_federation_sessions (
    family_id     uuid primary key references token_families (id) on delete cascade,
    federation_id uuid not null references silicon_federations (id) on delete cascade
);
create index silicon_federation_sessions_federation_idx on silicon_federation_sessions (federation_id);

-- Sign-ins from a trusted outside token are their own origin.
alter table token_families drop constraint if exists token_families_origin_check;
alter table token_families add constraint token_families_origin_check
    check (origin in ('authorization_code', 'slt', 'silicon_login', 'device', 'cli_code', 'federated'));

-- The audiences a Silicon may get identity tokens for, set by its custodian. Empty = none.
alter table accounts add column identity_audiences text[] not null default '{}';
alter table accounts add constraint accounts_identity_audiences_silicon_check
    check (cardinality(identity_audiences) = 0 or kind = 'silicon');

-- Signing keys the service generates and keeps itself (sealed with the encryption keyring), next
-- to the Ed25519 key from ACCOUNTS_JWT_PRIVATE_KEY. Today one purpose: RS256 identity tokens,
-- because cloud token services (AWS STS, Google Cloud, Microsoft Entra) don't accept EdDSA.
create table signing_keys (
    kid             text primary key,
    purpose         text not null check (purpose in ('identity_token')),
    algorithm       text not null check (algorithm in ('RS256')),
    private_key_enc bytea not null,
    public_jwk      jsonb not null,
    created_at      timestamptz not null default now(),
    retired_at      timestamptz
);
create unique index signing_keys_current_idx on signing_keys (purpose) where retired_at is null;
