-- Cells is a confidential first-party service, not a substitute for an app's secret.
-- Every delegation requires an authenticated author of that app. Cells independently
-- verifies authorship of the cell before calling this private bridge.
create table cells_app_links (
    cell_uuid uuid not null,
    app_id text not null references apps(app_id),
    callback_uri text not null,
    linked_by text collate "C" not null references accounts(uuid),
    created_at timestamptz not null default now(),
    revoked_at timestamptz,
    primary key(cell_uuid,app_id)
);
create index cells_app_links_app on cells_app_links(app_id) where revoked_at is null;
-- A refresh, introspection or revocation may touch only a family issued through
-- this exact cell/app delegation, even when two cells link to the same app.
create table cells_token_families (
    family_id uuid primary key references token_families(id) on delete cascade,
    cell_uuid uuid not null,
    app_id text not null,
    foreign key(cell_uuid,app_id) references cells_app_links(cell_uuid,app_id)
);
create index cells_token_families_link on cells_token_families(cell_uuid,app_id);
