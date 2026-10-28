-- A committed rotation and its encrypted recovery result are written together.
-- Keep the small request binding after retiring the ciphertext: an old retry must
-- get a conflict, never execute again or look like unrecognized token reuse.
create table refresh_recoveries (
    app_id text not null references apps(app_id),
    key_hash bytea not null,
    request_hash bytea not null,
    family_id uuid not null references token_families(id) on delete cascade,
    generation integer not null,
    response bytea,
    access_expires_at bigint not null,
    expires_at timestamptz not null,
    primary key (app_id, key_hash),
    unique (family_id, generation)
);
create index refresh_recoveries_expiry_idx on refresh_recoveries(expires_at) where response is not null;
create index refresh_recoveries_live_family_idx on refresh_recoveries(family_id) where response is not null;
