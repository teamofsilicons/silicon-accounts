-- Bind a configured Interface's sign-in proof and its own approved account
-- details to exactly one Interface authorization request and session.
alter table interface_login_flows add column signin_code_hash bytea unique;
alter table interface_login_flows add column interface_scopes text[] not null default '{profile}';
alter table interface_sessions add column interface_scopes text[] not null default '{profile}';
alter table interface_login_flows add column signin_policy jsonb not null default '{}';
alter table interface_sessions add column signin_policy jsonb not null default '{}';
alter table verified_interface_auth_flows add column interface_revision bigint;
update verified_interface_auth_flows f set interface_revision=c.revision from interface_auth_clients c where c.interface_id=f.interface_id;
alter table verified_interface_auth_flows alter column interface_revision set not null;
