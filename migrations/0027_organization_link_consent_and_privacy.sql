alter table account_link_requests add column requested_target_uuid text collate "C" references accounts(uuid);
alter table account_link_requests add column authorized_org_id text references organization_projections(org_id);
alter table account_link_requests add column declined_at timestamptz;
create index account_link_request_recipient on account_link_requests(requested_target_uuid) where completed_at is null and declined_at is null;
-- Keep private delivery snapshots until the durable relay succeeds, including prolonged outages.
alter table organization_notification_accounts alter column expires_at set default 'infinity';
alter table organization_notification_contacts alter column expires_at set default 'infinity';
update organization_notification_accounts set expires_at='infinity';
update organization_notification_contacts set expires_at='infinity';
-- Never expose personal or another organization's actor identifiers in work activity.
create or replace function record_organization_audit() returns trigger language plpgsql as $$
declare work_org text; visible_actor text;
begin
  select org_id into work_org from accounts where uuid=new.account_uuid;
  if work_org is not null then
    select uuid into visible_actor from accounts where uuid=new.actor_id and org_id=work_org;
    insert into organization_work_events(org_id,account_uuid,actor_id,app_id,kind,details)
    values(work_org,new.account_uuid,coalesce(visible_actor,new.account_uuid),new.app_id,new.action,
      jsonb_build_object('data',new.details,'ip',new.ip));
  end if;
  return new;
end $$;
update organization_work_events e set actor_id=e.account_uuid where actor_id is not null and not exists(select 1 from accounts a where a.uuid=e.actor_id and a.org_id=e.org_id);
