-- The permanent cell callback also remains the webhook delivery address.
-- A domain generation fences delayed updates after removal or replacement.
alter table cells_app_links
    add column custom_callback_uri text,
    add column callback_suspended boolean not null default false,
    add column callback_generation bigint not null default 0 check (callback_generation >= 0);

-- Callback commands must not acquire another meaning when a caller reuses a key.
-- Generations, not expiring HTTP response receipts, fence obsolete desired state.
create table cells_callback_commands (
    cell_uuid uuid not null,
    app_id text not null,
    key text not null,
    request_hash bytea not null,
    primary key(cell_uuid,app_id,key),
    foreign key(cell_uuid,app_id) references cells_app_links(cell_uuid,app_id) on delete cascade
);
