-- Apps owns resource ownership/policy. Accounts keeps its authenticated service
-- projection and checks current Organizations authority for every account action.
CREATE TABLE app_organization_publishers (
    app_id text PRIMARY KEY REFERENCES apps(app_id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    access jsonb NOT NULL DEFAULT '{"grants":[],"audience":{"mode":"organization","include":[],"exclude":[]}}',
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_organization_publishers_org ON app_organization_publishers(organization_id);
