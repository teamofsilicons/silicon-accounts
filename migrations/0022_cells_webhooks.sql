-- Each delegation gets its own destination and secret. Existing app webhook
-- configuration/subscriptions are never replaced by linking a cell.
alter table cells_app_links add column webhook_secret_enc bytea;
alter table webhook_events add column cell_uuid uuid;
create index webhook_events_cell on webhook_events(cell_uuid,event_id) where cell_uuid is not null;
