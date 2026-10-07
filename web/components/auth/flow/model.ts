/**
 * The hosted flow as the hosted pages read it, plus the small browser memory they keep and the helpers every step
 * shares. The server's FlowView (crates/auth flow/view.rs, typed in lib/api/types.ts) is the source of truth; the
 * pages never decide where a sign-in goes next.
 *
 * Browser memory is best effort: storage can be blocked (private windows, disabled site data), and nothing here is
 * needed for a sign-in to work. Everything that touches `window` checks for it, so these helpers are safe to import
 * from code that also renders on the server.
 */
import type { AccountSummary, Branding, FlowChallenge, FlowIntent, FlowView, SigninCopy, SigninMethod } from "@/lib/api/types";

export type HostedFlow = FlowView;
export type HostedStep = FlowView["step"];
export type { AccountSummary, FlowChallenge };

/** The order steps usually come in, for the direction of the card morph. */
export const STEP_ORDER: readonly HostedStep[] = ["choose_method", "verify_code", "signup", "details", "review", "complete", "failed"];

/** Which page the app asked for: the sign-in page (default) or the sign-up page. */
export const intentOf = (flow: Pick<HostedFlow, "intent">): FlowIntent => (flow.intent === "signup" ? "signup" : "signin");

/**
 * The page's title: the app's own (copy.title, or copy.signup_title on the sign-up page), else "Sign in to {name}" or
 * "Create your {name} account".
 */
export const appTitle = (flow: Pick<HostedFlow, "app" | "intent">): string =>
  intentOf(flow) === "signup"
    // Silicon Accounts' own sign-up is "Create your account" (never "Create your Silicon Accounts account").
    ? flow.app.copy.signup_title?.trim() || (flow.app.first_party ? "Create your account" : `Create your ${flow.app.name} account`)
    : flow.app.copy.title?.trim() || `Sign in to ${flow.app.name}`;

/** The app's subtitle for the page (copy.subtitle, or copy.signup_subtitle on the sign-up page), or null. */
export const appSubtitle = (flow: Pick<HostedFlow, "app" | "intent">): string | null =>
  (intentOf(flow) === "signup" ? flow.app.copy.signup_subtitle?.trim() : flow.app.copy.subtitle?.trim()) || null;

export const providerName = (provider: "google" | "apple"): string => (provider === "google" ? "Google" : "Apple");

/**
 * The Opening page's title: the app's copy.opening_title with {provider} and {app} filled in, else
 * "Opening Google to sign you in to Briefcase…".
 */
export function openingTitle(app: { name: string; copy?: Partial<SigninCopy> | null }, provider: "google" | "apple"): string {
  const own = app.copy?.opening_title?.trim();
  const name = providerName(provider);
  if (own) return own.replace(/\{provider\}/g, name).replace(/\{app\}/g, app.name);
  return `Opening ${name} to sign you in to ${app.name}…`;
}

/**
 * Where the Carbon goes after signing in, in a sentence: "your account" for the account site itself (app `accounts`),
 * else the app's name (also for our other first-party app, the developer site, "Silicon Developer").
 */
export const destinationName = (app: Pick<HostedFlow["app"], "app_id" | "name">): string => (app.app_id === "accounts" ? "your account" : app.name);

/** Google and Apple are providers; email and phone are contact methods with a code. */
export const isProvider = (method: SigninMethod): method is "google" | "apple" => method === "google" || method === "apple";

/**
 * The provider whose Opening page this flow starts on: the app's own "Continue with Google/Apple" (method=google|apple)
 * on a flow that has not moved yet. A flow that came back from the provider with an error shows the methods instead.
 */
export function openingProvider(flow: Pick<HostedFlow, "step" | "method_hint" | "methods" | "error">): "google" | "apple" | null {
  const hint = flow.method_hint;
  if (flow.step !== "choose_method" || !hint || !isProvider(hint) || !flow.methods.includes(hint) || flow.error) return null;
  return hint;
}

/**
 * Which page the flow is on, as the card draws it: the step, the page of the app's flow on a details step (a page the
 * app renamed is another page), and on the methods step the Opening page or "Continue as". When a failed action makes
 * the flow move to another page, the page that asked is gone, and the reason has to show on the new one.
 */
export function placeOf(flow: Pick<HostedFlow, "step" | "details" | "signed_in_as" | "method_hint" | "methods" | "error"> | null | undefined): string | null {
  if (!flow) return null;
  if (flow.step === "details") return `details:${flow.details?.id ?? ""}:${flow.details?.index ?? 0}`;
  if (flow.step === "choose_method") {
    const opening = openingProvider(flow);
    return opening ? `opening:${opening}` : flow.signed_in_as ? "choose_method:account" : "choose_method";
  }
  return flow.step;
}

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

/** `method=google|apple` opens the provider (after the Opening page) once per flow, never in a loop after a cancel. */
export function claimAutoStart(flowId: string): boolean {
  if (read("session", AUTOSTART_PREFIX + flowId) !== null) return false;
  write("session", AUTOSTART_PREFIX + flowId, "1");
  return read("session", AUTOSTART_PREFIX + flowId) !== null;
}

/** True when this tab already moved this flow on to the provider once (the Opening page then waits for a press). */
export function autoStartClaimed(flowId: string): boolean {
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

// The visitor's likely country for phone numbers lives with the phone field (components/foundation/phone-field).
export { guessCountry } from "@/components/foundation/phone-field/phone-data";

/* ------------------------------------------------------------------------------------------------------------------ */
/* The split layout's hero                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface HeroCopy {
  title: string;
  subtitle: string | null;
}

/**
 * The large copy beside the form in the split layout, following where the Carbon is. The app's own title and
 * subtitle are the sign-in page's copy (or the sign-up page's, when the app asked for it), so they win on the sign-in
 * steps; once the Carbon is past them, the hero says what is true now: a first visit is a welcome ("Welcome to Acme
 * Notes") and never a "welcome back", and only a Carbon who has been to the app before is welcomed back.
 *
 * `firstVisit`: this page showed the sign-up step of this flow (a new account, or one an app imported).
 */
export function heroCopy(flow: HostedFlow, journey: { firstVisit: boolean }): HeroCopy {
  return heroCopyFor({
    name: flow.app.name,
    copy: flow.app.copy,
    intent: intentOf(flow),
    step: flow.step,
    firstVisit: journey.firstVisit,
    knowsApp: (flow.details?.fields ?? []).some(field => field.previously_granted),
    finishingImport: !!flow.signup?.finishing_import,
    importedBy: flow.signup?.imported_by?.name ?? null,
  });
}

/** What heroCopyFor needs: the app's name and copy, the step, and what the page knows about the Carbon. */
export interface HeroInput {
  name: string;
  copy: Pick<SigninCopy, "title" | "subtitle"> & Partial<Pick<SigninCopy, "signup_title" | "signup_subtitle">>;
  /** The page the app asked for (default signin). */
  intent?: FlowIntent;
  step: HostedFlow["step"];
  /** This page showed the sign-up step of this flow (a new account, or one an app imported). */
  firstVisit: boolean;
  /** The Carbon shared something with the app before (beyond its name, id and photo). */
  knowsApp?: boolean;
  /** The sign-up finishes an account an app imported. */
  finishingImport?: boolean;
  /**
   * The name of the app whose import created that account (FlowSignup.imported_by): it may be another app than the
   * one being signed into. Null when the server does not say; the copy then names no app.
   */
  importedBy?: string | null;
}

/** The name of the app that imported the Carbon, for "Legacy CRM added you…"; null when no app can be named. */
export function importerName(importedBy: string | null | undefined): string | null {
  return importedBy?.trim() || null;
}

/** heroCopy without a FlowView: the same rules for anything that knows the step and the app. */
export function heroCopyFor({ name: app, copy, intent = "signin", step, firstVisit, knowsApp = false, finishingImport = false, importedBy = null }: HeroInput): HeroCopy {
  const signIn: HeroCopy = intent === "signup"
    ? { title: copy.signup_title?.trim() || `Create your ${app} account`, subtitle: copy.signup_subtitle?.trim() || null }
    : { title: copy.title?.trim() || `Sign in to ${app}`, subtitle: copy.subtitle?.trim() || null };
  switch (step) {
    case "choose_method":
    case "verify_code":
      return signIn;
    case "signup": {
      if (!finishingImport) return { title: `Welcome to ${app}`, subtitle: "Your account works here and in every other app that signs in with Silicon Accounts." };
      // The app that imported the Carbon, which need not be this one (legacy-crm's import finished at briefcase).
      const importer = importerName(importedBy);
      return { title: `Welcome to ${app}`, subtitle: `${importer ?? "An app you use"} set up an account for you. Check what it filled in, and you are in.` };
    }
    case "details":
      return knowsApp && !firstVisit
        ? { title: `Welcome back to ${app}`, subtitle: `${app} is asking for a little more than before. You choose what it sees.` }
        : { title: `Welcome to ${app}`, subtitle: `You choose what ${app} sees, and you can change it any time in your account.` };
    case "review":
      return { title: `Almost in to ${app}`, subtitle: `Check what ${app} sees. Nothing is shared until you continue.` };
    case "complete":
    case "failed":
      return firstVisit ? { title: `Welcome to ${app}`, subtitle: "Taking you there now." } : { title: `Signed in to ${app}`, subtitle: "Taking you there now." };
    default:
      return signIn;
  }
}
