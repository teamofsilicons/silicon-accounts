-- Accounts owns work identities and links. Organizations owns roles, teams and policy.
create table organization_projections (
  org_id text primary key check (org_id ~ '^[a-z0-9_-]{3,30}$'),
  name text not null,
  logo_url text,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table accounts add column org_id text references organization_projections(org_id);
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='accounts'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%custodian_uuid IS NOT NULL%'
  loop execute format('alter table accounts drop constraint %I',c.conname); end loop;
end $$;
alter table accounts add constraint accounts_custodian_kind check (
  kind='carbon' or status in ('pending_custodian','deleted') or
  ((custodian_uuid is not null)::integer + (org_id is not null)::integer = 1)
);
alter table accounts add constraint accounts_work_handle check (
  handle is null or (org_id is null and position('.' in handle)=0) or
  (org_id is not null and split_part(handle,'.',2)=org_id and
    split_part(handle,':',2) ~ '^[a-z0-9_-]{3,30}\.[a-z0-9_-]{3,30}$')
);
create unique index accounts_work_handle_unique on accounts(org_id,split_part(split_part(handle,':',2),'.',1)) where handle is not null and org_id is not null;
create table account_links (
  account_uuid text collate "C" primary key references accounts(uuid),
  main_uuid text collate "C" not null references accounts(uuid),
  linked_at timestamptz not null default now()
);
create index account_links_main on account_links(main_uuid);
create table account_link_requests (
  id uuid primary key,
  source_uuid text collate "C" not null references accounts(uuid),
  target_uuid text collate "C" references accounts(uuid),
  source_session uuid,
  expires_at timestamptz not null default now()+interval '15 minutes',
  completed_at timestamptz
);
create table organization_account_policies (
  account_uuid text collate "C" primary key references accounts(uuid),
  version bigint not null,
  mode text not null check(mode in ('everywhere','only','except')),
  apps text[] not null default '{}',
  extra_apps text[] not null default '{}',
  excluded_apps text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create table organization_work_events (
  cursor bigserial primary key,
  event_id uuid not null unique default gen_random_uuid(),
  org_id text not null references organization_projections(org_id),
  account_uuid text collate "C" not null references accounts(uuid),
  actor_id text,
  app_id text,
  kind text not null,
  details jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index organization_work_events_org on organization_work_events(org_id,cursor);
create function record_organization_audit() returns trigger language plpgsql as $$
declare work_org text;
begin
  select org_id into work_org from accounts where uuid=new.account_uuid;
  if work_org is not null then
    insert into organization_work_events(org_id,account_uuid,actor_id,app_id,kind,details)
    values(work_org,new.account_uuid,new.actor_id,new.app_id,new.action,
      jsonb_build_object('data',new.details,'ip',new.ip));
  end if;
  return new;
end $$;
create trigger organization_audit after insert on audit_log for each row execute function record_organization_audit();
create function record_organization_signin() returns trigger language plpgsql as $$
declare work_org text;
begin
  select org_id into work_org from accounts where uuid=new.account_uuid;
  if work_org is not null then
    insert into organization_work_events(org_id,account_uuid,actor_id,app_id,kind,details)
    values(work_org,new.account_uuid,new.account_uuid,new.app_id,'account.signin',
      jsonb_build_object('method',new.method,'outcome',new.outcome,'ip',new.ip,'user_agent',new.user_agent));
  end if;
  return new;
end $$;
create trigger organization_signin after insert on signin_history for each row execute function record_organization_signin();
create table organization_invitations (
  invite_id text primary key,
  org_id text not null references organization_projections(org_id),
  ticket_hash bytea not null unique,
  email text,
  account_uuid text collate "C" references accounts(uuid),
  handle text not null,
  return_to text not null,
  status text not null default 'pending' check(status in ('pending','accepted','cancelled')),
  expires_at timestamptz not null,
  proof_hash bytea unique,
  proof_expires_at timestamptz,
  profile jsonb,
  created_account_uuid text collate "C" references accounts(uuid),
  check(email is not null or account_uuid is not null)
);

-- Private delivery snapshot, only for post-removal notifications; never returned to Organizations.
create table organization_notification_contacts (
 account_uuid text collate "C" not null references accounts(uuid),
 email text not null,
 expires_at timestamptz not null default now()+interval '30 days',
 primary key(account_uuid,email)
);
