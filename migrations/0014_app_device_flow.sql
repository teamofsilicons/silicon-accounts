-- Device sign-ins for apps' own command-line tools (RFC 8628): the scopes the tool asked for,
-- which the approving Carbon shares with the app. Null for the silicon-accounts CLI (profile).
alter table device_authorizations add column scopes text[];
create index device_authorizations_app_idx on device_authorizations (app_id, created_at desc);
