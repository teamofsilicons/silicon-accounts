-- Rename verification kinds without replacing families, tokens, or their history.
-- Earlier migrations are immutable because SQLx verifies their checksums.
alter table proof_families drop constraint proof_families_kind_check;
alter table proof_families drop constraint proof_families_check;

update proof_families set kind = case kind
    when 'ata' then 'app_verification' when 'obo' then 'user_verification' end;

alter table proof_families add constraint proof_families_kind_check
    check (kind in ('app_verification', 'user_verification'));
alter table proof_families add constraint proof_families_subject_check
    check ((kind = 'user_verification') = (account_uuid is not null));

drop index proof_families_ata_page_idx;
drop index proof_families_unrevoked_obo_idx;
create index proof_families_app_verification_page_idx on proof_families (created_at desc, id desc)
    where kind = 'app_verification';
create index proof_families_unrevoked_user_verification_idx on proof_families (subject_family_id)
    where kind = 'user_verification' and revoked_at is null;

update audit_log set details = jsonb_set(details, '{kind}', to_jsonb(case details->>'kind'
    when 'ata' then 'app_verification'::text when 'obo' then 'user_verification'::text end))
where target_kind = 'proof' and action like 'proof.%' and details->>'kind' in ('ata', 'obo');

-- Secret-bearing retry responses are encrypted and bound to their route. The API migrates
-- those with its keyring before listening, retaining the original token and retry key.
