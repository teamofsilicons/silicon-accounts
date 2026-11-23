-- Passkeys (WebAuthn) as a Carbon sign-in method (Anil, 2026-11-23). A passkey is added from the
-- account site by a Carbon who is already signed in, and then signs that account in on any hosted
-- sign-in page. It never creates an account. See crates/core/src/webauthn.rs.

-- One registered passkey. The public key is the authenticator's COSE key as it sent it; the
-- signature counter guards against cloned authenticators when the authenticator keeps one.
create table passkeys (
    id               uuid primary key,
    account_uuid     text collate "C" not null references accounts(uuid) on delete cascade,
    credential_id    bytea not null unique,
    public_key       bytea not null,
    algorithm        integer not null check (algorithm in (-7, -8, -257)),
    sign_count       bigint not null default 0 check (sign_count >= 0),
    aaguid           bytea,
    backup_eligible  boolean not null default false,
    backed_up        boolean not null default false,
    transports       text[] not null default '{}',
    name             text not null check (char_length(name) between 1 and 64),
    created_at       timestamptz not null default now(),
    last_used_at     timestamptz
);
create index passkeys_account_idx on passkeys (account_uuid, created_at);

-- A passkey being added: the challenge the browser must sign, used once, for five minutes.
create table passkey_registrations (
    id            uuid primary key,
    account_uuid  text collate "C" not null references accounts(uuid) on delete cascade,
    challenge     text not null,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null
);
create index passkey_registrations_account_idx on passkey_registrations (account_uuid);
