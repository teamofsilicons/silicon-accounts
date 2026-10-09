-- Apps see a Silicon's custodian as {uuid, id} only. silicon.custodian_changed to apps used to
-- carry the old and new custodian's full account summary (kind, display name, photo, status);
-- the payloads already stored are cut down to {uuid, id} too, so a replay, a delivery's detail or
-- the event stream never shows an app more. The Silicon's own silicon.custodian.changed keeps the
-- summaries.
--
-- The database keeps the rule from now on, not only the code: a trigger cuts every app-bound
-- silicon.custodian_changed row down as it is written. A release runs this migration before its
-- new API tasks replace the old ones, and an old task still writes the full summaries until then;
-- the trigger cuts those rows too. It is created before the rewrite below: creating it waits for
-- every transaction already writing to webhook_events and holds new writers until this migration
-- commits, so the rewrite sees every row stored without it and every later row passes through it.

-- {uuid, id} for data.from and data.to, when they are objects (anything else is left as it is).
create function custodian_changed_refs(payload jsonb) returns jsonb
language plpgsql immutable as $$
declare
    side text;
begin
    foreach side in array array['from', 'to'] loop
        if jsonb_typeof(payload #> array['data', side]) = 'object' then
            payload := jsonb_set(
                payload,
                array['data', side],
                jsonb_build_object(
                    'uuid', payload #> array['data', side, 'uuid'],
                    'id', payload #> array['data', side, 'id']));
        end if;
    end loop;
    return payload;
end
$$;

create function webhook_events_custodian_refs() returns trigger
language plpgsql as $$
begin
    new.payload := custodian_changed_refs(new.payload);
    return new;
end
$$;

create trigger webhook_events_custodian_refs
    before insert or update of payload, type, target_kind on webhook_events
    for each row
    when (new.target_kind = 'app' and new.type = 'silicon.custodian_changed')
    execute function webhook_events_custodian_refs();

update webhook_events
   set payload = custodian_changed_refs(payload)
 where target_kind = 'app'
   and type = 'silicon.custodian_changed'
   and payload is distinct from custodian_changed_refs(payload);
