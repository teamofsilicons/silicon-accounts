-- The registry acknowledges a sealed result only after saving it durably.
alter table interface_sync_operations add column acknowledged_at timestamptz;

-- Preserve the exact per-app details approved by the Carbon. Existing sessions
-- without a matching flow fail closed when their requirements are next checked.
alter table interface_sessions add column approved_descriptors jsonb not null default '[]'::jsonb;
update interface_sessions s set approved_descriptors = f.app_descriptors
from interface_login_flows f where f.session_id = s.id;
