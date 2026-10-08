"use client";

/**
 * The browser session of the account site: who is signed in (GET /v1/session), the full Me view shared by every
 * account page, the service meta, signing out, and the first-party sign-in round trip
 * (/sign-in?return_to=… → /authorize?app_id=silicon-accounts → back to /sign-in?code&state, which restores the saved path;
 * components/auth/sign-in.tsx). A code or error counts as a return only when this browser saved its state.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, authorizeUrl } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { BrowserSession, FlowIntent, FlowPrompt, Me, SigninMethod } from "../api/types";
import { browserTimezone } from "../format";
import { developerSiteUrl, paths } from "../navigation";
import { modernTimezone } from "../timezones";
import { setTelemetryEnabled, subscribeTelemetry, telemetryEnabled } from "../telemetry";
import { queryKeys } from "./keys";

export type SessionStatus = "loading" | "signed_in" | "signed_out" | "error";

/** The first-party app: the account site and the CLI sign in through it. */
export const FIRST_PARTY_APP_ID = "silicon-accounts";
const RETURN_PREFIX = "silicon-accounts:return:";

/** `GET /v1/meta` (cached for the tab's life; the values only change with a deploy). */
export function useMeta() {
  return useQuery({ queryKey: queryKeys.meta, queryFn: ({ signal }) => api.meta.get(signal), staleTime: Infinity });
}

/**
 * The developer site (GET /v1/meta `developer_url`), where apps' sign-in is set up: the production address until the
 * meta answers or when it names none.
 */
export function useDeveloperUrl(): string {
  return developerSiteUrl(useMeta().data?.developer_url);
}

/**
 * The browser session. `status` is "loading" until the first answer, then "signed_in" | "signed_out", or "error" when
 * the API could not be reached (with the error, for an inline retry).
 */
export function useSession(): { status: SessionStatus; session: BrowserSession | null; error: ApiError | null; refetch: () => void } {
  const query = useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => api.session.get(signal),
    staleTime: 60_000,
  });
  // A refetch that fails keeps the last answer: one network blip never signs anyone out of the page.
  const status: SessionStatus = query.data !== undefined ? (query.data ? "signed_in" : "signed_out") : query.isError ? "error" : "loading";
  return { status, session: query.data ?? null, error: query.error ?? null, refetch: () => void query.refetch() };
}

/** The signed-in account's full Me view (shared by every page; refetched after changes through the hooks). */
export function useMe(options: { enabled?: boolean } = {}) {
  const { status } = useSession();
  return useQuery({
    queryKey: queryKeys.me.view,
    queryFn: ({ signal }) => api.me.get(signal),
    enabled: status === "signed_in" && options.enabled !== false,
  });
}

/** Replaces the cached Me view with one the server just returned (PATCH /v1/me and friends answer Me). */
export function setMe(client: QueryClient, me: Me): void {
  client.setQueryData(queryKeys.me.view, me);
  // The session summary shows the name, id and photo too.
  client.setQueryData<BrowserSession | null>(queryKeys.session, session => session && session.account.uuid === me.uuid
    ? { ...session, account: { ...session.account, id: me.id, display_name: me.display_name, pfp_url: me.pfp_url, status: me.status } }
    : session);
}

/** Marks the session gone (any API call answered 401); the account shell then sends the visitor to sign in. */
export function markSignedOut(client: QueryClient): void {
  if (client.getQueryData(queryKeys.session) === null) return;
  client.setQueryData(queryKeys.session, null);
  client.removeQueries({ queryKey: queryKeys.me.root });
}

/**
 * Signing this browser out. `signOut()` waits for the server first and only then leaves for the landing page with a
 * full load, so no account page is ever left mounted without a session (a review finding on the Solid shell). A
 * failure other than "already signed out" rejects (the caller shows it) and nothing changes.
 */
export function useSignOut(): { signOut: () => Promise<void>; pending: boolean } {
  const [pending, setPending] = useState(false);
  const signOut = useCallback(async () => {
    setPending(true);
    try {
      await api.session.signOut();
    } catch (raw) {
      const failure = ApiError.from(raw);
      if (failure.status !== 401) {
        setPending(false);
        throw failure;
      }
    }
    window.location.replace("/");
  }, []);
  return { signOut, pending };
}

/** Re-reads the session (after a sign-in finished in another tab, for example). */
export function useRefreshSession(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: queryKeys.session }), [client]);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Telemetry choice                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** This browser's telemetry choice (opted in by default) and a setter that remembers it. */
export function useTelemetryEnabled(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeTelemetry, telemetryEnabled, () => true);
  return [enabled, setTelemetryEnabled];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* First-party sign-in round trip                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Pages a sign-in never returns to: the sign-in pages themselves and the embed. (/device does get its code back.) */
const NO_RETURN = ["/sign-in", "/authorize", "/embed"];

/**
 * A `return_to` this site can go back to: a path on this origin, as the browser itself reads it, or null. Text that only
 * looks like a path can be another origin once parsed ("/\t/evil.example/x" loses its tab and becomes
 * "//evil.example/x"), so anything else is dropped.
 */
export function sameSitePath(value: string | null | undefined): string | null {
  if (!value || typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // "//host" and "/\host" read as other origins wherever a path is resolved again.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (NO_RETURN.some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return null;
  return path;
}

/** A same-origin path to come back to after signing in, or "/" (see sameSitePath). */
export function safeReturnPath(value: string | null | undefined): string {
  return sameSitePath(value) ?? "/";
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The /authorize URL that signs a Carbon into the account site itself (app `silicon-accounts`, redirect `{origin}/sign-in`).
 * `returnTo` (a same-site path) is remembered against the state in this tab, and /sign-in restores it when the flow
 * comes back.
 */
export function firstPartySignInUrl(returnTo?: string | null, extra: { prompt?: FlowPrompt; method?: SigninMethod; intent?: FlowIntent } = {}): string {
  const state = randomState();
  try {
    sessionStorage.setItem(RETURN_PREFIX + state, sameSitePath(returnTo) ?? paths.home);
  } catch {
    // Without storage the visitor lands on the home page after signing in.
  }
  return authorizeUrl({ app_id: FIRST_PARTY_APP_ID, redirect_uri: `${window.location.origin}${paths.signIn}`, state, timezone: modernTimezone(browserTimezone()), ...extra });
}

/** What firstPartySignInUrl saved for `state` in this browser, exactly; null when it saved nothing. */
export function savedSignInReturn(state: string): string | null {
  try {
    return sessionStorage.getItem(RETURN_PREFIX + state);
  } catch {
    return null;
  }
}

/** Forgets a saved return once it has been used (or the sign-in ended). */
export function forgetSignInReturn(state: string): void {
  try {
    sessionStorage.removeItem(RETURN_PREFIX + state);
  } catch {
    // Nothing to clean up without storage.
  }
}

/** Sends the browser to sign in (a full navigation; the hosted flow takes over), then back to `returnTo`. */
export function beginSignIn(returnTo: string = window.location.pathname + window.location.search): void {
  // A full navigation on purpose: the hosted flow takes over the page, and coming back loads the site afresh.
  window.location.assign(new URL(`${paths.signIn}?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`, window.location.origin).href);
}
