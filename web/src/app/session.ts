/**
 * The browser session of the account site: who is signed in (GET /v1/session), the full Me view shared by every
 * account page, signing out, and the first-party sign-in round trip (/sign-in → /authorize?app_id=accounts → back
 * to /?code&state, where the return path is restored).
 */
import { batch, createResource, createRoot, createSignal, type Accessor } from "solid-js";
import { api, authorizeUrl, configureApi, ApiError, type BrowserSession, type Me, type AccountSummary } from "../api";
import { browserTimezone } from "../lib/format";

export type SessionStatus = "loading" | "signed_in" | "signed_out" | "error";

const RETURN_PREFIX = "silicon-accounts:return:";
export const FIRST_PARTY_APP_ID = "accounts";

const store = createRoot(() => {
  const [status, setStatus] = createSignal<SessionStatus>("loading");
  const [current, setCurrent] = createSignal<BrowserSession | null>(null);
  const [error, setError] = createSignal<ApiError | null>(null);
  /** True from the moment this browser chose to sign out until the page left the account area. */
  const [leaving, setLeaving] = createSignal(false);
  let inflight: Promise<BrowserSession | null> | null = null;

  const refresh = (): Promise<BrowserSession | null> => {
    if (inflight) return inflight;
    inflight = api.session.get()
      .then(value => {
        batch(() => {
          setCurrent(value);
          setError(null);
          setStatus(value ? "signed_in" : "signed_out");
        });
        return value;
      })
      .catch(raw => {
        const failure = ApiError.from(raw);
        batch(() => {
          setError(failure);
          setStatus(current() ? "signed_in" : "error");
        });
        return current();
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  // The shared Me view, loaded once a session exists.
  const [me, { refetch: refetchMe, mutate: setMe }] = createResource(
    () => (status() === "signed_in" ? current()?.account.uuid : undefined),
    async () => {
      try {
        return await api.me.get();
      } catch (raw) {
        throw ApiError.from(raw);
      }
    },
  );

  return { status, current, error, refresh, setStatus, setCurrent, me, refetchMe, setMe, leaving, setLeaving };
});

/** "loading" until the first answer, then "signed_in" | "signed_out" (or "error" when the API is unreachable). */
export const sessionStatus: Accessor<SessionStatus> = store.status;
/** The browser session, or null. */
export const browserSession: Accessor<BrowserSession | null> = store.current;
/** The signed-in account's summary, or null. */
export const signedInAccount = (): AccountSummary | null => store.current()?.account ?? null;
/** The error that kept the session from loading (network, server), if any. */
export const sessionError: Accessor<ApiError | null> = store.error;
/** Re-reads GET /v1/session. */
export const refreshSession = (): Promise<BrowserSession | null> => store.refresh();

/** The signed-in account's full Me view (a Solid resource shared by every page). */
export const me = store.me;
/** Reloads Me (after a change made elsewhere). */
export const refreshMe = (): void => void store.refetchMe();
/** Replaces Me with a fresh value the server returned (optimistic or confirmed). */
export const setMe = (value: Me | ((previous: Me | undefined) => Me)): void => {
  store.setMe(value as Me);
};

/** True while a sign-out this browser asked for is in progress (the shell then does not send it to sign in). */
export const signingOut: Accessor<boolean> = store.leaving;
/** Clears the sign-out flag once the page has left the account area. */
export const finishSignOut = (): void => {
  store.setLeaving(false);
};

/** Signs this browser out and forgets the account locally. A failure (other than "already signed out") rejects. */
export async function signOut(): Promise<void> {
  store.setLeaving(true);
  try {
    await api.session.signOut();
  } catch (raw) {
    const failure = ApiError.from(raw);
    if (failure.status !== 401) {
      store.setLeaving(false);
      throw failure;
    }
  }
  batch(() => {
    store.setCurrent(null);
    store.setStatus("signed_out");
    store.setMe(undefined as unknown as Me);
  });
}

/** Marks the session as gone (an API call answered 401). The account shell then sends the visitor to sign in. */
export function markSignedOut(): void {
  if (store.status() !== "signed_in") return;
  batch(() => {
    store.setCurrent(null);
    store.setStatus("signed_out");
  });
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/authorize") || value.startsWith("/sign-in")) return "/";
  return value;
}

/**
 * The /authorize URL that signs a Carbon into the account site itself (app `accounts`, redirect `{origin}/`).
 * `returnTo` (a same-site path) is remembered against the state and restored when the flow comes back.
 */
export function firstPartySignInUrl(returnTo?: string | null, extra: { prompt?: "login" | "select_account"; login_hint?: string; method?: "google" | "apple" | "email" | "phone" } = {}): string {
  const state = randomState();
  try {
    sessionStorage.setItem(RETURN_PREFIX + state, safeReturnPath(returnTo));
  } catch {
    // Without storage the visitor lands on / after signing in.
  }
  return authorizeUrl({
    app_id: FIRST_PARTY_APP_ID,
    redirect_uri: `${location.origin}/`,
    state,
    timezone: browserTimezone(),
    ...extra,
  });
}

/** Sends the browser to sign in (a full navigation; the hosted flow takes over), then back to `returnTo`. */
export function beginSignIn(returnTo: string = location.pathname + location.search): void {
  location.assign(`/sign-in?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`);
}

export interface SignInReturn {
  /** Where to continue (the path saved when sign-in started). */
  path: string;
  /** Set when the flow ended without signing in (`error=access_denied`, `login_required`…). */
  error: string | null;
}

/**
 * Handles the end of a first-party sign-in: `/?code=…&state=…` (or `?error=…`). The browser session cookie was
 * already set by the flow, so the code is not exchanged; the query is removed from the address bar and the saved
 * return path is handed back. Returns null when the current URL is not a sign-in return.
 */
export function consumeSignInReturn(): SignInReturn | null {
  if (typeof location === "undefined" || location.pathname !== "/") return null;
  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("error");
  if (!state || (!code && !error)) return null;
  let path = "/";
  try {
    path = safeReturnPath(sessionStorage.getItem(RETURN_PREFIX + state));
    sessionStorage.removeItem(RETURN_PREFIX + state);
  } catch {
    path = "/";
  }
  history.replaceState(history.state, "", path);
  return { path, error };
}

/** Installs the API's 401 hook (once, from the app root). */
export function installSessionHooks(): void {
  configureApi({ onUnauthenticated: () => markSignedOut() });
}
