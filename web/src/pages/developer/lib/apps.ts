/**
 * Looking up other apps by app id (GET /v1/apps/{app_id}/public): their name and logo for proof audiences and chips,
 * and whether they exist and are active. Results are cached for the page's lifetime.
 */
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { api, ApiError, type AppPublic } from "../../../api";

export type AppLookup =
  | { state: "loading" }
  | { state: "found"; app: AppPublic }
  | { state: "missing"; message: string }
  | { state: "error"; message: string };

const store = createRoot(() => {
  const [lookups, setLookups] = createStore<Record<string, AppLookup>>({});
  return { lookups, setLookups };
});

/** The lookup state of an app id (starts the request the first time). */
export function lookupApp(appId: string): AppLookup {
  const id = appId.trim().toLowerCase();
  const current = store.lookups[id];
  if (current) return current;
  store.setLookups(id, { state: "loading" });
  api.apps.public(id).then(
    app => store.setLookups(id, { state: "found", app }),
    raw => {
      const error = ApiError.from(raw);
      store.setLookups(id, error.status === 404 || error.status === 403 ? { state: "missing", message: error.message } : { state: "error", message: `${error.message}${error.hint ? ` ${error.hint}` : ""}` });
    },
  );
  return store.lookups[id] ?? { state: "loading" };
}

/** Seeds the cache with apps already known (owned apps, apps signed into) so their chips render at once. */
export function rememberApp(app: Pick<AppPublic, "app_id" | "name" | "logo_url"> & Partial<AppPublic>): void {
  if (store.lookups[app.app_id]?.state === "found") return;
  store.setLookups(app.app_id, {
    state: "found",
    app: { app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, logo_dark_url: app.logo_dark_url ?? null, homepage_url: app.homepage_url ?? null, methods: app.methods ?? [], branding: app.branding as AppPublic["branding"], copy: app.copy as AppPublic["copy"] },
  });
}
