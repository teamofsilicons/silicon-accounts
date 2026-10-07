"use client";

/**
 * Looking up other apps by app id (GET /v1/apps/{app_id}/public, shared with the rest of the site through the query
 * cache): their name and logo for proof audiences, and whether they exist and are active. Apps the Carbon already
 * knows (owned, or signed into) render at once without a request.
 */
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/query/keys";

export interface KnownApp {
  app_id: string;
  name: string;
  logo_url: string | null;
}

export type AppLookup =
  | { state: "loading" }
  | { state: "found"; app: KnownApp }
  | { state: "missing"; message: string }
  | { state: "error"; message: string };

/** The lookup state of each app id (known apps first, then the public config). */
export function useAppLookups(ids: readonly string[], known: readonly KnownApp[]): Record<string, AppLookup> {
  const byId = new Map(known.map(app => [app.app_id, app]));
  const unknown = ids.filter(id => !byId.has(id));
  const results = useQueries({
    queries: unknown.map(id => ({
      queryKey: queryKeys.app.public(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.apps.public(id, signal),
      retry: false,
      staleTime: 5 * 60_000,
    })),
  });
  const out: Record<string, AppLookup> = {};
  for (const id of ids) {
    const knownApp = byId.get(id);
    if (knownApp) {
      out[id] = { state: "found", app: knownApp };
      continue;
    }
    const result = results[unknown.indexOf(id)];
    if (!result || result.isPending) out[id] = { state: "loading" };
    else if (result.data) out[id] = { state: "found", app: { app_id: result.data.app_id, name: result.data.name, logo_url: result.data.logo_url } };
    else {
      const error = ApiError.from(result.error);
      out[id] = error.status === 404 || error.status === 403
        ? { state: "missing", message: error.message }
        : { state: "error", message: [error.message, error.hint].filter(Boolean).join(" ") };
    }
  }
  return out;
}
