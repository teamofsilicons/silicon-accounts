-- A custodian's allow-list of the apps its Silicon may get short-lived tokens for.
-- Null = every app (the default); an empty list = none.
alter table accounts add column slt_allowed_apps text[];
alter table accounts add constraint accounts_slt_allowed_apps_silicon_check
    check (slt_allowed_apps is null or kind = 'silicon');
