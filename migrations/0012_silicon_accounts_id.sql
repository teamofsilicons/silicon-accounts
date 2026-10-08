-- Correct our own app's identity without changing ordinary app-ID immutability.
-- SQLx applies this migration in one transaction. Credentials, dates and ownership
-- are copied exactly; every foreign key is moved before the old row is removed.
do $$
declare
    reference record;
begin
    if not exists(select 1 from apps where app_id='accounts') then
        return;
    end if;
    if not exists(select 1 from apps where app_id='accounts' and name='Silicon Accounts'
                  and source = 'first_party') then
        raise exception 'The legacy Accounts ID is not the Silicon Accounts service; manual review required';
    end if;
    if exists(select 1 from apps where app_id='silicon-accounts') then
        raise exception 'silicon-accounts already exists; refusing to merge distinct app identities';
    end if;
    insert into apps
    select (jsonb_populate_record(null::apps, to_jsonb(a) || '{"app_id":"silicon-accounts"}'::jsonb)).*
    from apps a where app_id='accounts';

    -- Inspect actual references so a forgotten child table cannot be cascade-deleted.
    for reference in
        select c.conrelid::regclass as relation, a.attname as column_name
        from pg_constraint c
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
        where c.contype='f' and c.confrelid='apps'::regclass
    loop
        execute format('update %s set %I=$1 where %I=$2',
                       reference.relation, reference.column_name, reference.column_name)
            using 'silicon-accounts', 'accounts';
    end loop;
    update proof_families set audiences=array_replace(audiences,'accounts','silicon-accounts')
        where 'accounts'=any(audiences);
    update webhook_events set target_id='silicon-accounts' where target_kind='app' and target_id='accounts';
    update webhook_deliveries set target_id='silicon-accounts' where target_kind='app' and target_id='accounts';
    update audit_log set app_id='silicon-accounts' where app_id='accounts';
    update audit_log set target_id='silicon-accounts' where target_kind='app' and target_id='accounts';
    update audit_log set actor_id='silicon-accounts' where actor_kind='app' and actor_id='accounts';
    update signin_history set app_id='silicon-accounts' where app_id='accounts';
    delete from apps where app_id='accounts';
    insert into audit_log(actor_kind,actor_id,action,target_kind,target_id,app_id,details)
    values('system','migration:0012','app.id_migrated','app','silicon-accounts','silicon-accounts',
           '{"previous_app_id":"accounts","app_id":"silicon-accounts"}');
end $$;

-- Device sign-ins created after the migration use the renamed public client.
alter table device_authorizations alter column app_id set default 'silicon-accounts';
