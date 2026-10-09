-- Silicon key credentials: Ed25519 public keys a Silicon (or its custodian) registers, so an
-- unattended Silicon signs in with a short-lived signed assertion instead of holding its STK.
create table silicon_keys (
    id           uuid primary key,
    silicon_uuid text collate "C" not null references accounts (uuid) on delete cascade,
    name         text not null,
    public_key   bytea not null check (octet_length(public_key) = 32),
    fingerprint  text not null,                          -- SHA256:<base64 of the key>, like ssh-keygen -l
    created_by   text collate "C" not null,              -- the Silicon or its custodian
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    revoked_by   text collate "C"
);
create unique index silicon_keys_live_key_idx on silicon_keys (silicon_uuid, public_key)
    where revoked_at is null;
create index silicon_keys_silicon_idx on silicon_keys (silicon_uuid, created_at);

-- Every assertion's jti, until it expires: an assertion works once.
create table silicon_key_assertions (
    silicon_uuid text collate "C" not null,
    jti          text not null,
    key_id       uuid not null,
    expires_at   timestamptz not null,
    primary key (silicon_uuid, jti)
);
create index silicon_key_assertions_expires_idx on silicon_key_assertions (expires_at);

-- Which key started a sign-in, so revoking the key ends the sign-ins it started.
create table silicon_key_sessions (
    family_id uuid primary key references token_families (id) on delete cascade,
    key_id    uuid not null references silicon_keys (id) on delete cascade
);
create index silicon_key_sessions_key_idx on silicon_key_sessions (key_id);
