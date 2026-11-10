-- Every living identity belongs to Silicon Accounts from creation, including app imports,
-- pending Silicons and organization work accounts. Enforce this at the shared table boundary
-- so repository helpers, bulk imports and future creation paths cannot miss registration.
--
-- Keep the existing `signin` source category for first-party registration (compatible with
-- deployed API/SDK enums). Actual sign-in timestamps stay NULL: registration creates neither
-- a sign-in nor a session. Account status continues to gate authentication independently.
create function register_accounts_membership() returns trigger
language plpgsql as $$
begin
    insert into memberships (app_id, account_uuid, status, source, granted_scopes)
    values ('silicon-accounts', new.uuid, 'active', 'signin', array['profile'])
    on conflict (app_id, account_uuid) do nothing;
    return new;
end;
$$;

create trigger accounts_register_membership
after insert on accounts
for each row when (new.status <> 'deleted')
execute function register_accounts_membership();

-- CREATE TRIGGER holds a table lock until this migration commits, so concurrent account
-- creation cannot fall between installing the trigger and backfilling existing identities.
-- Preserve every existing membership verbatim; deleted tombstones are not registered anew.
insert into memberships (app_id, account_uuid, status, source, granted_scopes)
select 'silicon-accounts', uuid, 'active', 'signin', array['profile']
from accounts where status <> 'deleted'
on conflict (app_id, account_uuid) do nothing;
