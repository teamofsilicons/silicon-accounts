CREATE TABLE app_registry_lifecycle (app_id text PRIMARY KEY REFERENCES apps(app_id), deleted_at timestamptz);
