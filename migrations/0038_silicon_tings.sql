-- Silicon account delivery moves to Ting. App webhooks and their subscriptions are unchanged.
create table silicon_ting_requests (
    request_id uuid primary key references custodian_requests(id),
    session_id text not null,
    generation uuid not null,
    updated_at timestamptz not null default now()
);

create table silicon_tings (
    id uuid primary key,
    account_uuid text not null references accounts(uuid),
    event_id uuid references webhook_events(event_id),
    request_id uuid references custodian_requests(id),
    session_id text,
    generation uuid,
    payload jsonb not null,
    status text not null default 'pending' check (status in ('pending','accepted','cancelled','failed')),
    attempts integer not null default 0,
    created_at timestamptz not null default now(),
    next_attempt_at timestamptz not null default now(),
    retry_deadline timestamptz,
    lease_id uuid,
    lease_until timestamptz,
    last_error text,
    accepted_at timestamptz,
    check ((session_id is null and request_id is null and generation is null) or
           (session_id is not null and request_id is not null and generation is not null))
);
create index silicon_tings_due on silicon_tings(next_attempt_at) where status='pending';
create unique index silicon_tings_account_event on silicon_tings(event_id) where session_id is null;

-- Transfer unfinished deliveries; stable historical event IDs remain the deduplication keys.
insert into silicon_tings(id,account_uuid,event_id,payload)
select e.event_id,e.target_id,e.event_id,jsonb_build_object('type',names.name,'for',e.target_id,'key','accounts:'||e.event_id::text,'data',e.payload,'metadata','{}'::jsonb)
from webhook_events e join (values ('silicon.created','silicon-accounts.siliconCreated'),
('silicon.custodian.accepted','silicon-accounts.custodianAccepted'),
('silicon.custodian.declined','silicon-accounts.custodianDeclined'),
('silicon.custodian.expired','silicon-accounts.custodianExpired'),
('silicon.updated','silicon-accounts.siliconUpdated'),
('silicon.id_changed','silicon-accounts.siliconIdChanged'),
('silicon.stk_rotated','silicon-accounts.stkRotated'),
('silicon.custodian.changed','silicon-accounts.custodianChanged'),
('silicon.federation.added','silicon-accounts.federationAdded'),
('silicon.federation.removed','silicon-accounts.federationRemoved'),
('silicon.identity_audiences.changed','silicon-accounts.identityAudiencesChanged')) as names(old,name) on names.old=e.type
where e.target_kind='silicon' and exists(select 1 from webhook_deliveries d where d.event_id=e.event_id and d.status='pending')
on conflict do nothing;

-- Preserve the old history, but never send it to old callback URLs after the cutover.
update webhook_deliveries set status='failed', next_attempt_at=now()
 where target_kind='silicon' and status='pending';
update accounts set webhook_url=null, webhook_secret_enc=null where kind='silicon';
