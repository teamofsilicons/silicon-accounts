-- A Carbon that deletes its account is archived first: signed out everywhere but kept with its id,
-- emails, phones and sign-ins. Signing in again with a code restores it; otherwise the hourly sweep
-- deletes it for real once `archived_at` is 10 days old.
alter table accounts add column archived_at timestamptz;
alter table accounts drop constraint accounts_status_check;
alter table accounts add constraint accounts_status_check
  check (status in ('active', 'unclaimed', 'pending_custodian', 'archived', 'deleted'));
alter table accounts add constraint accounts_archived
  check (status <> 'archived' or (kind = 'carbon' and archived_at is not null));
create index accounts_archived_idx on accounts (archived_at) where status = 'archived';
