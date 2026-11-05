-- A missing binding is disabled; it is synchronized by the Interfaces service.
alter table interface_auth_clients add column cell_broker jsonb;
