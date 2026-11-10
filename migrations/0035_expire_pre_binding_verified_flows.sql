-- Before 0034 these short-lived bridges did not record the Interface revision
-- at their creation. They cannot safely inherit a later configuration's grant.
-- End only those in-flight bridges; established Interface sessions are separate.
update browser_sessions set revoked_at=coalesce(revoked_at,now())
where id in (
    select browser_session_id from verified_interface_auth_flows
    where browser_session_id is not null and created_at <
      (select installed_on from _sqlx_migrations where version=34 and success)
);
delete from verified_interface_auth_flows
where created_at < (select installed_on from _sqlx_migrations where version=34 and success);
