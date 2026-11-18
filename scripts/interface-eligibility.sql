-- Operator-only. Run with psql variables: account_uuid, operator, verified,
-- trusted, reason. The registry's service credential cannot call this.
\set ON_ERROR_STOP on
begin;
-- Make invalid or inactive targets and an empty review reason hard errors.
select 1 / case when exists (select 1 from accounts where uuid=:'account_uuid' and status='active') and length(trim(:'operator'))>0 and length(trim(:'reason'))>0 then 1 else 0 end;
insert into interface_creator_eligibility(account_uuid, verified, trusted)
values (:'account_uuid', :'verified'::boolean, :'trusted'::boolean)
on conflict(account_uuid) do update set verified=excluded.verified, trusted=excluded.trusted, updated_at=now();
insert into audit_log(actor_kind,actor_id,action,target_kind,target_id,account_uuid,details)
values ('internal', :'operator', 'interface.creator_eligibility.updated', 'account', :'account_uuid', :'account_uuid',
        jsonb_build_object('verified',:'verified'::boolean,'trusted',:'trusted'::boolean,'reason',:'reason'));
commit;
