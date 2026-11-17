-- A separate resource audience for interfaces. It has no interactive callback,
-- client secret available to callers, or first-party account privileges.
insert into apps (app_id, name, description, homepage_url, secret_hash, status, source)
values ('silicon-account-management', 'Silicon Accounts profile', 'Create and manage a Silicon Accounts profile from an interface.',
        'https://developers.teamofsilicons.com/docs/accounts/start/interface-accounts',
        sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'active', 'first_party');
insert into app_signin_configs (app_id, version, config, updated_by)
select 'silicon-account-management', 1, config || '{"required_fields":[],"optional_fields":["email","phone","dob","timezone"],"redirect_uris":[],"allowed_origins":[]}'::jsonb, 'system'
from app_signin_configs where app_id='silicon-accounts';

alter table otp_challenges drop constraint otp_challenges_purpose_check;
alter table otp_challenges add constraint otp_challenges_purpose_check
check (purpose in ('signin','add_email','add_phone','requirement','cli_login','delete_account','interface_registration'));

-- The approved contact and profile belong to this one registration. A retry can
-- finish an already proved request without issuing any sign-in credential.
create table interface_account_registrations (
    challenge_id uuid primary key references otp_challenges(id) on delete cascade,
    interface_id text not null references interface_auth_clients(interface_id) on delete cascade,
    profile jsonb not null,
    result jsonb,
    completion_hash bytea
);
