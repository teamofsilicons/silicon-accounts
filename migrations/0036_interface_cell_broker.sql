-- A missing binding is disabled; it is synchronized by the Interfaces service.
alter table interface_auth_clients add column cell_broker jsonb;

-- A cancellation remains authoritative even if an older sync request arrives
-- after a recovery process observed no operation. Never expire automatically.
create table interface_sync_cancellations (
    interface_id text not null,
    key text not null,
    request_hash bytea not null,
    created_at timestamptz not null default now(),
    primary key (interface_id,key)
);
