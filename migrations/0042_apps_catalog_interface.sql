-- Interface sign-ins need a catalog identity separate from the publisher token.
-- This is an ordinary membership and consent audience with no owner credential.
-- A preexisting registration must be investigated, never adopted.
insert into apps (app_id, name, description, homepage_url, secret_hash, status, source)
values ('silicon-apps-catalog', 'Silicon Apps catalog',
        'Browse published apps shared with your account and download their releases.',
        'https://apps.teamofsilicons.com',
        sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')),
        'active', 'first_party');

insert into app_signin_configs (app_id, config, updated_by)
values ('silicon-apps-catalog', '{"public_client":true,"optional_fields":["email"]}'::jsonb, 'system');
