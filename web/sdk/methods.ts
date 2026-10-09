/**
 * Sign-in methods as buttons, shared by the embed page (components/auth/embed) and the SDK (sdk/v1.ts). Plain strings and
 * functions only: the SDK is a dependency-free script, so nothing here may import from the account site.
 */

export type ButtonMethod = "google" | "apple" | "email" | "phone";

const KNOWN: readonly ButtonMethod[] = ["google", "apple", "email", "phone"];

export const METHOD_LABEL: Readonly<Record<ButtonMethod, string>> = {
  google: "Continue with Google",
  apple: "Continue with Apple",
  email: "Continue with email",
  phone: "Continue with phone number",
};

/** Which hosted page a button opens: the sign-in page or the sign-up page (the account logic is the same). */
export type ButtonIntent = "signin" | "signup";

/** `Sign in` / `Sign up` buttons, for apps that let our pages show every method. */
export const INTENT_LABEL: Readonly<Record<ButtonIntent, string>> = { signin: "Sign in", signup: "Sign up" };

export function isButtonIntent(value: unknown): value is ButtonIntent {
  return value === "signin" || value === "signup";
}

/**
 * What the buttons show: one button per method (`methods`, the default: "Continue with Google"…, each opening our
 * pages on that method), or `intents`: "Sign in" and "Sign up", and our pages show every method.
 */
export type ButtonSet = "methods" | "intents";

export function isButtonSet(value: unknown): value is ButtonSet {
  return value === "methods" || value === "intents";
}

/** The intent buttons to show: both (Sign in first, the primary one), or the one `only` names. */
export function visibleIntents(only?: string | null): ButtonIntent[] {
  return isButtonIntent(only) ? [only] : ["signin", "signup"];
}

/**
 * 18 px marks as trusted, static SVG markup. Google's mark keeps its colours; Apple's draws in the text colour, as
 * Apple's guidelines ask; email and phone use line icons in the text colour.
 */
export const METHOD_MARK: Readonly<Record<ButtonMethod, string>> = {
  google:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
  apple:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
  email:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="3"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  phone:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="20" x="5" y="2" rx="3"/><path d="M12 18h.01"/></svg>',
};

/** The Silicon Accounts mark for the "Powered by" line (fixed colours, never branded). */
export const POWERED_MARK =
  '<svg viewBox="0 0 64 64" width="14" height="14" aria-hidden="true"><path fill="#1F5FB8" d="M32 0c19.6 0 25.4 1.4 28.6 3.4C62.6 6.6 64 12.4 64 32s-1.4 25.4-3.4 28.6C57.4 62.6 51.6 64 32 64S6.6 62.6 3.4 60.6C1.4 57.4 0 51.6 0 32S1.4 6.6 3.4 3.4C6.6 1.4 12.4 0 32 0Z"/><circle cx="32" cy="25" r="9" fill="#FFFFFF"/><path fill="#FFFFFF" d="M15 49c2.6-8 9.2-12.5 17-12.5S46.4 41 49 49c-4.6 3-10.4 4.6-17 4.6S19.6 52 15 49Z"/></svg>';

/** Where "Powered by Silicon Accounts" links. Not configurable: an app cannot remove or change the line. */
export const POWERED_BY_HREF = "https://accounts.teamofsilicons.com";

/**
 * The /authorize parameters an embed or SDK passes through (anything else in its URL is not forwarded). There is no
 * login_hint, email or phone: an app never hands us a Carbon's email or phone; the Carbon types it on our pages.
 */
export const AUTHORIZE_PARAMS = [
  "app_id",
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "nonce",
  "prompt",
  "intent",
] as const;

export function isButtonMethod(value: unknown): value is ButtonMethod {
  return typeof value === "string" && (KNOWN as readonly string[]).includes(value);
}

/** The buttons to show: the app's enabled methods in its order, de-duplicated, narrowed to `only` when given. */
export function visibleMethods(enabled: readonly unknown[] | null | undefined, only?: string | null): ButtonMethod[] {
  const list: ButtonMethod[] = [];
  for (const method of enabled ?? []) if (isButtonMethod(method) && !list.includes(method)) list.push(method);
  return only ? list.filter(method => method === only) : list;
}

/**
 * The one primary button: the app's own path (email, else phone). Google and Apple stay neutral, as their own
 * guidelines ask, so a page of provider buttons has no primary at all.
 */
export function primaryMethod(methods: readonly ButtonMethod[]): ButtonMethod | null {
  return methods.find(method => method === "email") ?? methods.find(method => method === "phone") ?? null;
}
