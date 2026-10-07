"use client";

/**
 * Who is signed in to the developer site, through the BFF: `GET /auth/session` (is there a session cookie at all), then
 * `GET /v1/me` (the BFF answers it with the sealed session's token; 401 `signed_out` when the session ended). The
 * service meta, signing out (`POST /auth/sign-out`, which
 * revokes the sign-in and clears the cookie) and starting a sign-in (`/auth/sign-in`, a full navigation to the hosted
 * sign-in on the accounts site).
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { Me } from "../api/types";
import { paths } from "../navigation";
import { setTelemetryEnabled, subscribeTelemetry, telemetryEnabled } from "../telemetry";
import { isSignedOutError } from "./client";
import { queryKeys } from "./keys";

export { isSignedOutError };

export type SessionStatus = "loading" | "signed_in" | "signed_out" | "error";

/** `GET /v1/meta` (cached for the tab's life; the values only change with a deploy). */
export function useMeta() {
  return useQuery({ queryKey: queryKeys.meta, queryFn: ({ signal }) => api.meta.get(signal), staleTime: Infinity });
}

/** `GET /auth/session`: whether the sealed session cookie is there at all (no API call, never a 401). */
async function hasSession(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) return true; // Unknown: let /me answer.
  const body = (await response.json().catch(() => null)) as { signed_in?: unknown } | null;
  return body?.signed_in !== false;
}

async function readMe(signal: AbortSignal): Promise<Me | null> {
  // A signed-out visit stops here, so the browser never logs the 401 /me would answer.
  if (!(await hasSession(signal).catch(() => true))) return null;
  try {
    return await api.me.get(signal);
  } catch (error) {
    if (isSignedOutError(error)) return null;
    throw error;
  }
}

/**
 * The signed-in Carbon. `status` is "loading" until the first answer, then "signed_in" | "signed_out", or "error" when
 * Silicon Accounts could not be reached (with the error, for an inline retry). A refetch that fails keeps the last
 * answer: one network blip never signs anyone out of the page.
 */
export function useSession(): { status: SessionStatus; me: Me | null; error: ApiError | null; refetch: () => void } {
  const query = useQuery({ queryKey: queryKeys.me.view, queryFn: ({ signal }) => readMe(signal), staleTime: 60_000 });
  const status: SessionStatus = query.data !== undefined ? (query.data ? "signed_in" : "signed_out") : query.isError ? "error" : "loading";
  return { status, me: query.data ?? null, error: query.error ?? null, refetch: () => void query.refetch() };
}

/** Marks the session gone (an API call answered a signed-out 401); the shell then sends the visitor to sign in. */
export function markSignedOut(client: QueryClient): void {
  if (client.getQueryData(queryKeys.me.view) === null) return;
  client.setQueryData(queryKeys.me.view, null);
}

/**
 * Signing this browser out of the developer site. Waits for the server (the sign-in is revoked and the cookie cleared),
 * then leaves with a full load, so no page stays mounted without a session. The account site's own sign-in is untouched.
 */
export function useSignOut(): { signOut: () => Promise<void>; pending: boolean } {
  const [pending, setPending] = useState(false);
  const signOut = useCallback(async () => {
    setPending(true);
    let response: Response;
    try {
      response = await fetch("/auth/sign-out", { method: "POST", credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      setPending(false);
      throw new ApiError({ status: 0, code: "network_error", message: `Could not reach the developer site to sign out: ${error instanceof Error ? error.message : String(error)}.`, hint: "Check your connection, then try again." });
    }
    if (!response.ok && response.status !== 401) {
      setPending(false);
      const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string; hint?: string } } | null;
      throw new ApiError({ status: response.status, code: body?.error?.code ?? "sign_out_failed", message: body?.error?.message ?? `Signing out failed (HTTP ${response.status}).`, hint: body?.error?.hint ?? "Reload the page and try again." });
    }
    window.location.replace(`${paths.signIn}?signed_out=1`);
  }, []);
  return { signOut, pending };
}

/** Re-reads who is signed in. */
export function useRefreshSession(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: queryKeys.me.view }), [client]);
}

/** This browser's telemetry choice (opted in by default) and a setter that remembers it. */
export function useTelemetryEnabled(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeTelemetry, telemetryEnabled, () => true);
  return [enabled, setTelemetryEnabled];
}

/**
 * A path on this site to come back to, as the browser reads it, or null. Text that only looks like a path can be
 * another origin once parsed, so anything else is dropped (the server checks the same again).
 */
export function sameSitePath(value: string | null | undefined): string | null {
  if (!value) return null;
  // Resolved against a placeholder origin, so the server's render and the browser's agree (no window needed).
  const here = "http://developer.invalid";
  let url: URL;
  try {
    url = new URL(value, here);
  } catch {
    return null;
  }
  if (url.origin !== here) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (["/sign-in", "/auth", "/api"].some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return null;
  return path;
}

/** Sends the browser to the sign-in page, which comes back to `returnTo` afterwards. */
export function beginSignIn(returnTo: string = window.location.pathname + window.location.search): void {
  const back = sameSitePath(returnTo);
  // A full navigation on purpose: the sign-in leaves this site and comes back with a fresh load.
  window.location.assign(new URL(`${paths.signIn}${back && back !== "/" ? `?return_to=${encodeURIComponent(back)}` : ""}`, window.location.origin).href);
}
