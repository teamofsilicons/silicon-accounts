/**
 * The hosted flow as the hosted pages read it, plus the small browser memory they keep and the helpers every step
 * shares. The server's FlowView (crates/auth flow/view.rs, typed in lib/api/types.ts) is the source of truth; the
 * pages never decide where a sign-in goes next.
 *
 * Browser memory is best effort: storage can be blocked (private windows, disabled site data), and nothing here is
 * needed for a sign-in to work. Everything that touches `window` checks for it, so these helpers are safe to import
 * from code that also renders on the server.
 */
import type { AccountSummary, Branding, FlowChallenge, FlowView, SigninCopy, SigninMethod } from "@/lib/api/types";
import { ZONE_COUNTRY } from "./phone-data";

export type HostedFlow = FlowView;
export type HostedStep = FlowView["step"];
export type { AccountSummary, FlowChallenge };

/** The order steps usually come in, for the direction of the card morph. */
export const STEP_ORDER: readonly HostedStep[] = ["choose_method", "verify_code", "signup", "requirements", "consent", "complete", "failed"];

/** The title the app chose, or "Sign in to {name}". */
export const appTitle = (flow: Pick<HostedFlow, "app">): string => flow.app.copy.title?.trim() || `Sign in to ${flow.app.name}`;

/** Google and Apple are providers; email and phone are contact methods with a code. */
export const isProvider = (method: SigninMethod): method is "google" | "apple" => method === "google" || method === "apple";

/** What the frame needs to know about the app (a FlowView's `app`, or a remembered look while it loads). */
export interface FrameApp {
  app_id: string;
  name: string;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  branding?: Partial<Branding> | null;
  copy?: Partial<SigninCopy> | null;
  first_party?: boolean;
}

/** Silicon Accounts itself, for its own pages (device approval, the account site's sign-in, problems with no app). */
export const SILICON_ACCOUNTS: FrameApp = { app_id: "accounts", name: "Silicon Accounts", first_party: true };

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browser memory                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

const QUERY_PREFIX = "silicon-accounts:flow-query:";
const REDIRECTED_PREFIX = "silicon-accounts:flow-redirected:";
const AUTOSTART_PREFIX = "silicon-accounts:flow-autostart:";
const FLOW_APP_PREFIX = "silicon-accounts:flow-app:";
const LOOK_PREFIX = "silicon-accounts:app-look:";

function store(kind: "session" | "local"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function read(kind: "session" | "local", key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(kind: "session" | "local", key: string, value: string): void {
  try {
    store(kind)?.setItem(key, value);
  } catch {
    // Full or blocked storage: the page keeps working without the memory.
  }
}

/**
 * The /authorize query a flow started from. An expired flow (60 minutes) or one bound to a cleared cookie can start
 * again with the same parameters: the app's state, PKCE challenge and nonce are still waiting on its side.
 */
export function rememberAuthorizeQuery(flowId: string, query: string): void {
  write("session", QUERY_PREFIX + flowId, query);
}

export function authorizeQueryOf(flowId: string): string | null {
  return read("session", QUERY_PREFIX + flowId);
}

/** Set once the browser was sent to the app with this flow's code (a code works once). */
export function markRedirected(flowId: string): void {
  write("session", REDIRECTED_PREFIX + flowId, String(Date.now()));
}

export function wasRedirected(flowId: string): boolean {
  return read("session", REDIRECTED_PREFIX + flowId) !== null;
}

/** `method=google|apple` jumps straight to the provider once per flow, never in a loop after a cancel. */
export function claimAutoStart(flowId: string): boolean {
  if (read("session", AUTOSTART_PREFIX + flowId) !== null) return false;
  write("session", AUTOSTART_PREFIX + flowId, "1");
  return read("session", AUTOSTART_PREFIX + flowId) !== null;
}

/** What an app looks like, remembered so the next sign-in to it paints in its colours before the flow loads. */
export interface AppLook {
  app_id: string;
  name: string;
  branding: Partial<Branding>;
}

const APP_ID = /^[a-z][a-z0-9-]{1,39}$/;

/** Remembers the app's look (by app id, across visits) and which app this flow belongs to (this tab). */
export function rememberLook(flow: HostedFlow): void {
  if (flow.app.first_party) return;
  // Logos and background images stay out: they can be large data URIs, and the colours are what prevents a flash.
  const look: AppLook = { app_id: flow.app.app_id, name: flow.app.name, branding: { ...flow.app.branding, logo_url: null, logo_dark_url: null, background_image_url: null } };
  write("local", LOOK_PREFIX + flow.app.app_id, JSON.stringify(look));
  write("session", FLOW_APP_PREFIX + flow.id, flow.app.app_id);
}

export function rememberedLook(appId: string | null | undefined): AppLook | null {
  if (!appId || !APP_ID.test(appId)) return null;
  const raw = read("local", LOOK_PREFIX + appId);
  if (!raw) return null;
  try {
    const look = JSON.parse(raw) as AppLook;
    return look && look.app_id === appId && look.branding && typeof look.branding === "object" ? look : null;
  } catch {
    return null;
  }
}

/** The look of the app a flow id belongs to, when this tab saw that flow before (coming back from Google or Apple). */
export function lookOfFlow(flowId: string): AppLook | null {
  return rememberedLook(read("session", FLOW_APP_PREFIX + flowId));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

const origin = () => (typeof window === "undefined" ? "http://localhost" : window.location.origin);

/**
 * A redirect the page may follow: http(s), or a native app's reverse-domain scheme (com.example.app:/callback), the
 * same rule the server applies to registered redirect URIs. Anything else (javascript:, data:, file:…) is refused
 * here too, so a bad value can never run on this origin. Returns the absolute URL, or null.
 */
export function safeRedirect(target: string | null | undefined): string | null {
  if (!target) return null;
  let url: URL;
  try {
    url = new URL(target, origin());
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
    const url = new URL(redirectTo, origin());
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
    if (typeof navigator !== "undefined") {
      for (const tag of navigator.languages ?? [navigator.language]) {
        const region = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})\b/.exec(tag ?? "")?.[1];
        if (region) return region.toUpperCase();
      }
    }
  } catch {
    // No navigator: fall through.
  }
  return "US";
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The split layout's hero                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface HeroCopy {
  title: string;
  subtitle: string | null;
}

/**
 * The large copy beside the form in the split layout, following where the Carbon is. The app's own title and
 * subtitle are the sign-in page's copy, so they win on the sign-in steps; once the Carbon is past them, the hero says
 * what is true now: a first visit is a welcome ("Welcome to Acme Notes") and never a "welcome back", and only a
 * Carbon who has been to the app before is welcomed back.
 *
 * `firstVisit`: this page showed the sign-up step of this flow (a new account, or one an app imported).
 */
export function heroCopy(flow: HostedFlow, journey: { firstVisit: boolean }): HeroCopy {
  const app = flow.app.name;
  const copy = flow.app.copy;
  const signIn: HeroCopy = { title: appTitle(flow), subtitle: copy.subtitle?.trim() || null };
  const knowsApp = (flow.consent?.previously_granted ?? []).some(scope => scope !== "profile" && scope !== "openid" && scope !== "offline_access");
  switch (flow.step) {
    case "choose_method":
    case "verify_code":
      return signIn;
    case "signup":
      return flow.signup?.finishing_import
        ? { title: `Welcome to ${app}`, subtitle: `${app} set up an account for you. Check what it filled in, and you are in.` }
        : { title: `Welcome to ${app}`, subtitle: "Your account works here and in every other app that signs in with Silicon Accounts." };
    case "requirements":
      return journey.firstVisit
        ? { title: `Welcome to ${app}`, subtitle: `${app} needs one more detail before you continue.` }
        : { title: `One more detail for ${app}`, subtitle: "Add it once and it stays on your account, for the apps you choose to share it with." };
    case "consent":
      return knowsApp && !journey.firstVisit
        ? { title: `Welcome back to ${app}`, subtitle: `${app} is asking for a little more than before. You choose what it sees.` }
        : { title: `Welcome to ${app}`, subtitle: `You choose what ${app} sees, and you can change it any time in your account.` };
    case "complete":
    case "failed":
      return journey.firstVisit ? { title: `Welcome to ${app}`, subtitle: "Taking you there now." } : { title: `Signed in to ${app}`, subtitle: "Taking you there now." };
    default:
      return signIn;
  }
}
