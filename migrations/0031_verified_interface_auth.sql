-- A verified Interface's confidential backend holds an opaque capability; only
-- Accounts holds the encrypted flow and browser-session cookies behind it.
create table verified_interface_auth_flows (
    capability_hash bytea primary key,
    interface_id text not null references interface_auth_clients(interface_id),
    signin_flow_id text not null references signin_flows(id),
    sealed_cookies bytea not null,
    interface_origin text not null,
    redirect_uri text not null,
    state text not null,
    code_challenge text not null,
    interface_flow_id text references interface_login_flows(id),
    review_snapshot jsonb,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '10 minutes'
);
create index verified_interface_auth_flows_expiry on verified_interface_auth_flows(expires_at);
