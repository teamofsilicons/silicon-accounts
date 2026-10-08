-- Silicon Apps is the authority for accepted authors. Keep owner_uuid for legacy clients.
create table app_authors (
    app_id text not null references apps(app_id) on delete cascade,
    account_uuid text collate "C" not null references accounts(uuid),
    joined_at timestamptz not null default now(),
    primary key(app_id, account_uuid)
);
insert into app_authors(app_id, account_uuid)
select app_id, owner_uuid from apps where owner_uuid is not null;
create index app_authors_account_idx on app_authors(account_uuid);

-- NULL retains the previous Accounts behavior for existing integrations.
alter table app_signin_configs add column webhook_events jsonb;
