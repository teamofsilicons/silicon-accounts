-- Event subscriptions and the event stream.
--
-- An app picks where its updates go (its webhook, or the event stream at GET /v1/events/stream),
-- which updates it wants and whether each destination is active or paused. One row per
-- destination, at most one webhook and one stream per app.
create table app_event_subscriptions (
    id         uuid primary key,
    app_id     text not null references apps (app_id) on delete cascade,
    delivery   text not null check (delivery in ('webhook', 'stream')),
    -- The updates wanted (id_change, display_name_change, ...); null = every update, which is
    -- what every webhook set up before subscriptions existed receives.
    updates    jsonb check (updates is null or jsonb_typeof(updates) = 'array'),
    status     text not null default 'active' check (status in ('active', 'paused')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (app_id, delivery)
);

-- The webhook subscription follows the app's webhook columns, whoever writes them (the API,
-- the Silicon Apps sync, an older accounts-api during a rollback): it exists exactly while
-- webhook_url is set, and its updates are app_signin_configs.webhook_events. Its status lives
-- here only.
create function app_webhook_subscription_sync() returns trigger language plpgsql as $$
begin
    if new.webhook_url is null then
        delete from app_event_subscriptions where app_id = new.app_id and delivery = 'webhook';
    else
        insert into app_event_subscriptions (id, app_id, delivery, updates)
        values (gen_random_uuid(), new.app_id, 'webhook',
                case when jsonb_typeof(new.webhook_events) = 'array' then new.webhook_events end)
        on conflict (app_id, delivery) do update
            set updates = excluded.updates, updated_at = now()
            where app_event_subscriptions.updates is distinct from excluded.updates;
    end if;
    return null;
end $$;

create trigger app_webhook_subscription_sync
    after insert or update of webhook_url, webhook_events on app_signin_configs
    for each row execute function app_webhook_subscription_sync();

-- Every webhook set up so far becomes its app's webhook subscription, receiving exactly what it
-- receives today.
insert into app_event_subscriptions (id, app_id, delivery, updates, status, created_at, updated_at)
select gen_random_uuid(), app_id, 'webhook',
       case when jsonb_typeof(webhook_events) = 'array' then webhook_events end,
       'active', updated_at, updated_at
from app_signin_configs where webhook_url is not null;

-- webhook_events: the subscription a row was recorded for (null for Silicon events and rows
-- recorded before subscriptions existed), and the transaction that wrote it. The stream reads a
-- feed in (tx_id, event_id) order and only below the oldest transaction still running, so an
-- event that commits late is never skipped.
alter table webhook_events add column subscription_id uuid;
alter table webhook_events add column tx_id xid8 not null default pg_current_xact_id();
create index webhook_events_subscription_feed_idx on webhook_events (subscription_id, tx_id, event_id)
    where subscription_id is not null;
create index webhook_events_silicon_feed_idx on webhook_events (target_id, tx_id, event_id)
    where target_kind = 'silicon';

-- A self-created Silicon opens the stream with its sarq_ request token, found by its hash.
create index custodian_requests_token_idx on custodian_requests (request_token_hash)
    where request_token_hash is not null;
