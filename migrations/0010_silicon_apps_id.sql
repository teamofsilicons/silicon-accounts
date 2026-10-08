-- Correct our own app's identity without changing ordinary app-ID immutability.
-- SQLx applies this migration in one transaction. Credentials, dates and ownership
-- are copied exactly; every foreign key is moved before the old row is removed.
do $$
declare
    reference record;
begin
    if not exists(select 1 from apps where app_id='apps') then
        return;
    end if;
    if not exists(select 1 from apps where app_id='apps' and name='Silicon Apps'
                  and source in ('silicon_apps','first_party')) then
        raise exception 'The legacy apps ID is not the Silicon Apps service; manual review required';
    end if;
    if exists(select 1 from apps where app_id='silicon-apps') then
        raise exception 'silicon-apps already exists; refusing to merge distinct app identities';
    end if;
    insert into apps
    select (jsonb_populate_record(null::apps, to_jsonb(a) || '{"app_id":"silicon-apps"}'::jsonb)).*
    from apps a where app_id='apps';

    -- Inspect actual references so a forgotten child table cannot be cascade-deleted.
    for reference in
        select c.conrelid::regclass as relation, a.attname as column_name
        from pg_constraint c
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
        where c.contype='f' and c.confrelid='apps'::regclass
    loop
        execute format('update %s set %I=$1 where %I=$2',
                       reference.relation, reference.column_name, reference.column_name)
            using 'silicon-apps', 'apps';
    end loop;
    update proof_families set audiences=array_replace(audiences,'apps','silicon-apps')
        where 'apps'=any(audiences);
    update webhook_events set target_id='silicon-apps' where target_kind='app' and target_id='apps';
    update webhook_deliveries set target_id='silicon-apps' where target_kind='app' and target_id='apps';
    update audit_log set app_id='silicon-apps' where app_id='apps';
    update audit_log set target_id='silicon-apps' where target_kind='app' and target_id='apps';
    update audit_log set actor_id='silicon-apps' where actor_kind='app' and actor_id='apps';
    update signin_history set app_id='silicon-apps' where app_id='apps';
    delete from apps where app_id='apps';
    insert into audit_log(actor_kind,actor_id,action,target_kind,target_id,app_id,details)
    values('system','migration:0010','app.id_migrated','app','silicon-apps','silicon-apps',
           '{"previous_app_id":"apps","app_id":"silicon-apps"}');
end $$;
