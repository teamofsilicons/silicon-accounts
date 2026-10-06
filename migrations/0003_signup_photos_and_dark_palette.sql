-- Silicon Accounts — photos uploaded during sign-up, and the default dark palette.
--
-- 0001 and 0002 are applied and never edited; everything below builds on them.

-- 1. Photos uploaded during sign-up ------------------------------------------------------------
-- The sign-up page lets the Carbon pick a profile photo before the account exists
-- (POST /v1/flows/{id}/signup/photo). Such an upload belongs to the 48-hour sign-up session
-- until the sign-up finishes; then it moves to the new account (account_uuid set,
-- signup_session_id cleared), exactly like a photo uploaded with POST /v1/me/photo. A photo
-- always belongs to exactly one of the two. Uploads of a sign-up that never finishes are deleted
-- by the sign-in sweep once the session expired or was used, and in any case with the session
-- row itself (on delete cascade).
alter table photos alter column account_uuid drop not null;
alter table photos
    add column signup_session_id uuid references signup_sessions (id) on delete cascade;
alter table photos
    add constraint photos_one_owner check ((account_uuid is null) <> (signup_session_id is null));
create index photos_signup_session_idx on photos (signup_session_id)
    where signup_session_id is not null;

-- 2. The default dark palette -----------------------------------------------------------------
-- The default dark theme filled buttons with #5B8FE0 under #FFFDF9 text: 3.2:1, below WCAG AA
-- (4.5:1) for button text. The default is now the brand rule, #1F5FB8 under #FFFDF9 (6.1:1);
-- #5B8FE0 stays an ink for links and accents only. Branding whose text contrast is below 4.5:1
-- is refused from now on, so every stored sign-in config that still carries the old default pair
-- moves to the new default: a new config version with a history entry and an audit record, both
-- by 'system'. A config that pairs #5B8FE0 with another text colour was chosen on purpose and is
-- left alone.
with changed as (
    update app_signin_configs
       set config = jsonb_set(config, '{branding,dark,primary}', '"#1F5FB8"'::jsonb),
           version = version + 1,
           updated_at = now(),
           updated_by = 'system'
     where upper(config #>> '{branding,dark,primary}') = '#5B8FE0'
       and upper(coalesce(config #>> '{branding,dark,primary_foreground}', '#FFFDF9')) = '#FFFDF9'
    returning app_id, version
), history as (
    insert into app_config_history (app_id, version, actor, changes)
    select app_id, version, 'system',
           '[{"path": "branding.dark.primary", "before": "#5B8FE0", "after": "#1F5FB8"}]'::jsonb
      from changed
    returning app_id
)
insert into audit_log (actor_kind, actor_id, action, target_kind, target_id, app_id, details)
select 'system', null, 'app.signin_config.updated', 'app', c.app_id, c.app_id,
       jsonb_build_object(
           'version', c.version,
           'changed', jsonb_build_array('branding.dark.primary'),
           'reason', 'The default dark palette changed: filled buttons use #1F5FB8 so button text reaches WCAG AA (migration 0003).')
  from changed c;
