/**
 * The hosted flow as the hosted pages read it, plus the small browser memory they keep.
 *
 * The server's FlowView (crates/auth flow/view.rs) is the source of truth. It carries a few things the shared
 * `FlowView` type in src/api does not have yet, so this area widens it here:
 *   - step `failed`: a `prompt=none` sign-in that could not finish silently (redirect_to carries the error);
 *   - `prompt`, `login_hint` and `method_hint`: the /authorize parameters the pages must honour;
 *   - `signup.provider_pfp_url`: the Google picture offered beside the default photo;
 *   - `error.hint` may be null.
 */
import type { AccountSummary, FlowChallenge, FlowConsent, FlowSignup, FlowView, SigninMethod } from "../../../api";
import { ZONE_COUNTRY } from "./phone-data";

export type HostedStep = FlowView["step"] | "failed";

export interface HostedSignup extends Omit<FlowSignup, "pfp_url"> {
  /** The prefilled photo: our default Iris photo, or the imported account's photo. */
  pfp_url: string | null;
  /** The provider's picture (Google), offered as an alternative. */
  provider_pfp_url?: string | null;
}

export interface HostedFlow extends Omit<FlowView, "step" | "signup" | "error"> {
  step: HostedStep;
  signup: HostedSignup | null;
  error: { code: string; message: string; hint?: string | null } | null;
  prompt?: string | null;
  login_hint?: string | null;
  method_hint?: SigninMethod | null;
}

export type { AccountSummary, FlowChallenge, FlowConsent };

/** Widens what the API client returns (the same JSON). */
export const asHosted = (flow: FlowView): HostedFlow => flow as unknown as HostedFlow;

/** The order steps usually come in, for the direction of the card morph. */
export const STEP_ORDER: readonly HostedStep[] = ["choose_method", "verify_code", "signup", "requirements", "consent", "complete", "failed"];

/** The title the app chose, or "Sign in to {name}". */
export const appTitle = (flow: Pick<HostedFlow, "app">) => flow.app.copy.title?.trim() || `Sign in to ${flow.app.name}`;

/** Google and Apple are providers; email and phone are contact methods with a code. */
export const isProvider = (method: SigninMethod): method is "google" | "apple" => method === "google" || method === "apple";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browser memory (best effort: storage can be blocked, and nothing here is needed for a sign-in to work)             */
/* ------------------------------------------------------------------------------------------------------------------ */

const QUERY_PREFIX = "silicon-accounts:flow-query:";
const REDIRECTED_PREFIX = "silicon-accounts:flow-redirected:";
const AUTOSTART_PREFIX = "silicon-accounts:flow-autostart:";
const LOOK_PREFIX = "silicon-accounts:app-look:";

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Full or blocked storage: the page keeps working without the memory.
  }
}

/** The flow /authorize just created, handed to the flow page so it renders without asking again. */
const created = new Map<string, HostedFlow>();

export function handOver(flow: HostedFlow): void {
  created.set(flow.id, flow);
}

export function takeHandedOver(id: string): HostedFlow | undefined {
  const flow = created.get(id);
  created.delete(id);
  return flow;
}

/**
 * The /authorize query a flow started from. An expired flow (60 minutes) or one bound to a cleared cookie can start
 * again with the same parameters: the app's state, PKCE challenge and nonce are still waiting on its side.
 */
export function rememberAuthorizeQuery(flowId: string, query: string): void {
  write(session(), QUERY_PREFIX + flowId, query);
}

export function authorizeQueryOf(flowId: string): string | null {
  return read(session(), QUERY_PREFIX + flowId);
}

/** Set once the browser was sent to the app with this flow's code (a code works once). */
export function markRedirected(flowId: string): void {
  write(session(), REDIRECTED_PREFIX + flowId, String(Date.now()));
}

export function wasRedirected(flowId: string): boolean {
  return read(session(), REDIRECTED_PREFIX + flowId) !== null;
}

/** `method=google|apple` jumps straight to the provider once per flow, never in a loop after a cancel. */
export function claimAutoStart(flowId: string): boolean {
  if (read(session(), AUTOSTART_PREFIX + flowId) !== null) return false;
  write(session(), AUTOSTART_PREFIX + flowId, "1");
  return read(session(), AUTOSTART_PREFIX + flowId) !== null;
}

/** What an app looks like, remembered so the next /authorize for it paints in its colours before the flow loads. */
export interface AppLook {
  app_id: string;
  name: string;
  branding: HostedFlow["app"]["branding"];
}

export function rememberLook(flow: HostedFlow): void {
  const look: AppLook = { app_id: flow.app.app_id, name: flow.app.name, branding: { ...flow.app.branding, logo_url: null, logo_dark_url: null, background_image_url: null } };
  write(local(), LOOK_PREFIX + flow.app.app_id, JSON.stringify(look));
}

export function rememberedLook(appId: string | null | undefined): AppLook | null {
  if (!appId || !/^[a-z][a-z0-9-]{1,39}$/.test(appId)) return null;
  const raw = read(local(), LOOK_PREFIX + appId);
  if (!raw) return null;
  try {
    const look = JSON.parse(raw) as AppLook;
    return look && look.app_id === appId && look.branding && typeof look.branding === "object" ? look : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A redirect the page may follow: http(s), or a native app's reverse-domain scheme (com.example.app:/callback), the
 * same rule the server applies to registered redirect URIs. Anything else (javascript:, data:, file:…) is refused
 * here too, so a bad value can never run on this origin. Returns the absolute URL, or null.
 */
export function safeRedirect(target: string | null | undefined): string | null {
  if (!target) return null;
  let url: URL;
  try {
    url = new URL(target, window.location.origin);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "https" || scheme === "http") return url.toString();
  if (/^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/.test(scheme)) return url.toString();
  return null;
}

/** The `error` (and `error_description`) a redirect_to carries, when the flow ended without a code. */
export function redirectError(redirectTo: string | null | undefined): { error: string; description: string | null } | null {
  if (!redirectTo) return null;
  try {
    const url = new URL(redirectTo, window.location.origin);
    const error = url.searchParams.get("error");
    return error ? { error, description: url.searchParams.get("error_description") } : null;
  } catch {
    return null;
  }
}

/** Where "Go to {app}" points when the code is spent: the app's homepage, else the origin it redirects to. */
export function appHome(flow: Pick<HostedFlow, "app" | "redirect_to">): string | null {
  if (flow.app.homepage_url && /^https?:\/\//i.test(flow.app.homepage_url)) return flow.app.homepage_url;
  try {
    return flow.redirect_to ? new URL(flow.redirect_to).origin : null;
  } catch {
    return null;
  }
}

/** The first name of a display name, for buttons ("Continue as Saket"). */
export function firstName(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0] ?? "";
  return first.length > 18 ? `${first.slice(0, 17)}…` : first || displayName;
}

/**
 * A best guess at the visitor's country (ISO 3166-1 alpha-2) for phone numbers: the timezone's country, else the
 * region of the browser's language, else the United States. It can be any country, not only the ones the phone
 * picker formats (PhoneField offers the others with their calling code).
 */
export function guessCountry(): string {
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    zone = "";
  }
  const byZone = ZONE_COUNTRY.get(zone);
  if (byZone) return byZone;
  try {
    for (const tag of navigator.languages ?? [navigator.language]) {
      const region = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})\b/.exec(tag ?? "")?.[1];
      if (region) return region.toUpperCase();
    }
  } catch {
    // No navigator (tests): fall through.
  }
  return "US";
}
