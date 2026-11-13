alter table organization_invitations drop constraint organization_invitations_status_check;
alter table organization_invitations add constraint organization_invitations_status_check check(status in ('pending','accepted','cancelled','declined'));
create table organization_notification_accounts (
  account_uuid text collate "C" not null references accounts(uuid),
  recipient_uuid text collate "C" not null references accounts(uuid),
  expires_at timestamptz not null default now()+interval '30 days',
  primary key(account_uuid,recipient_uuid)
);
-- Grant consumption, tokens, and the encrypted receipt commit in one transaction.
create table grant_exchange_recoveries (
  app_id text not null references apps(app_id),
  key_hash bytea not null,
  request_hash bytea not null,
  family_id uuid not null references token_families(id) on delete cascade,
  response bytea not null,
  expires_at timestamptz not null,
  primary key(app_id,key_hash)
);
create index grant_exchange_recoveries_expiry on grant_exchange_recoveries(expires_at);
