/**
 * `GET /v1/meta`, read once for the whole developer area: the public URL (callback URLs, snippets), the Silicon Apps
 * URL ("New app") and which managed providers this deployment has.
 */
import { createRoot, createSignal, type Accessor } from "solid-js";
import { api, ApiError, type Meta } from "../../../api";

const store = createRoot(() => {
  const [meta, setMeta] = createSignal<Meta>();
  const [error, setError] = createSignal<ApiError>();
  let inflight: Promise<Meta | undefined> | null = null;
  const load = (): Promise<Meta | undefined> => {
    if (meta()) return Promise.resolve(meta());
    inflight ??= api.meta.get()
      .then(value => {
        setMeta(value);
        setError(undefined);
        return value;
      })
      .catch(raw => {
        setError(ApiError.from(raw));
        return undefined;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return { meta, error, load };
});

/** The meta document (loads it on first use). */
export function useMeta(): Accessor<Meta | undefined> {
  void store.load();
  return store.meta;
}

export const metaError: Accessor<ApiError | undefined> = store.error;

/** The browser-facing origin of Silicon Accounts (the OIDC issuer). Falls back to this page's origin. */
export function publicUrl(meta: Meta | undefined): string {
  const value = meta?.public_url?.replace(/\/+$/, "");
  return value || (typeof location !== "undefined" ? location.origin : "https://account.teamofsilicons.com");
}

/** Where apps are created. */
export function siliconAppsUrl(meta: Meta | undefined): string {
  return meta?.silicon_apps_url?.replace(/\/+$/, "") || "https://apps.teamofsilicons.com";
}
