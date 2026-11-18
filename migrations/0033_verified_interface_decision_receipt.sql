-- A completed bridge may erase its Accounts cookies and still replay the same
-- decision safely after a dropped backend response.
alter table verified_interface_auth_flows add column decision_hash bytea;
alter table verified_interface_auth_flows add column decision_result jsonb;
