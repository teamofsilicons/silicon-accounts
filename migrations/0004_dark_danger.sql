-- Silicon Accounts — the default dark error colour.
--
-- 0001 to 0003 are applied and never edited; everything below builds on them.

-- The default dark palette drew error text in #F97066, which reads at 4.46:1 on the default dark
-- card (#353432): below WCAG AA (4.5:1) for text. The default is now #FF8A80 (5.45:1 there). Every
-- stored sign-in config that still pairs #F97066 with the default dark card moves to the new
-- colour: a new config version with a history entry and an audit record, both by 'system' (the
-- same way 0003 moved the old dark button colour). A config that puts #F97066 on its own surface
-- colour chose that pair and is left alone.
with changed as (
    update app_signin_configs
       set config = jsonb_set(config, '{branding,dark,danger}', '"#FF8A80"'::jsonb),
           version = version + 1,
           updated_at = now(),
           updated_by = 'system'
     where upper(config #>> '{branding,dark,danger}') = '#F97066'
       and upper(coalesce(config #>> '{branding,dark,surface}', '#353432')) = '#353432'
    returning app_id, version
), history as (
    insert into app_config_history (app_id, version, actor, changes)
    select app_id, version, 'system',
           '[{"path": "branding.dark.danger", "before": "#F97066", "after": "#FF8A80"}]'::jsonb
      from changed
    returning app_id
)
insert into audit_log (actor_kind, actor_id, action, target_kind, target_id, app_id, details)
select 'system', null, 'app.signin_config.updated', 'app', c.app_id, c.app_id,
       jsonb_build_object(
           'version', c.version,
           'changed', jsonb_build_array('branding.dark.danger'),
           'reason', 'The default dark palette changed: error text uses #FF8A80 so it reaches WCAG AA on the default dark card (migration 0004).')
  from changed c;
