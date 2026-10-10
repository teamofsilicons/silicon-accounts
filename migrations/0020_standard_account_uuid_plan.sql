-- Preparing a plan does not apply it. The offline accounts-migrate-uuids command
-- exports this one immutable mapping for Accounts and every dependent service.
create table account_uuid_migration_plan (
    old_uuid text collate "C" primary key,
    new_uuid uuid not null unique,
    kind text not null check (kind in ('carbon', 'silicon')),
    created_at timestamptz not null default now(),
    applied_at timestamptz,
    check (new_uuid::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
create function preserve_account_uuid_plan() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'account UUID mapping is immutable';
    end if;
    if (new.old_uuid, new.new_uuid, new.kind, new.created_at) is distinct from
       (old.old_uuid, old.new_uuid, old.kind, old.created_at)
       or (old.applied_at is not null and new.applied_at is distinct from old.applied_at) then
        raise exception 'account UUID mapping is immutable';
    end if;
    return new;
end $$;
create trigger preserve_account_uuid_plan before update or delete on account_uuid_migration_plan
    for each row execute function preserve_account_uuid_plan();

-- Retain the original signed body and event ID for audit. A retired event can
-- neither be delivered, replayed nor read from the live event stream. The cutover
-- emits fresh scoped state and lifecycle notifications with the new identity.
alter table webhook_events add column identity_migrated_at timestamptz;
