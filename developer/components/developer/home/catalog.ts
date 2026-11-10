import type { OwnedApp } from "@/lib/api/types";
import type { App } from "@/components/publishing/types";

export type CatalogApp = Omit<OwnedApp, "users"> & { users: number | null; accountsAccess: boolean };

/** Publishing authorship is independent of access to Accounts sign-in configuration. */
export function mergeAppCatalog(owned: OwnedApp[], publishing: App[]): CatalogApp[] {
  const apps = new Map<string, CatalogApp>(owned.map(app => [app.app_id, { ...app, accountsAccess: true }]));
  for (const app of publishing) {
    if (!app.is_author || apps.has(app.app_id)) continue;
    apps.set(app.app_id, {
      app_id: app.app_id, name: app.name, logo_url: app.logo || null,
      status: "active", source: "silicon_apps", created_at: app.created_at,
      users: null, accountsAccess: false,
    });
  }
  return [...apps.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.app_id.localeCompare(a.app_id));
}
