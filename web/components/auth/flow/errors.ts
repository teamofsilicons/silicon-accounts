/**
 * Errors in the words of the Carbon signing in.
 *
 * The flow API's errors are written for whoever calls the API: their hints name endpoints ("Call POST
 * /v1/flows/{id}/switch…"), fields of the FlowView, settings and internal flow ids, which mean nothing on the hosted
 * pages. Every error a hosted page shows goes through `carbonError`: known codes get copy of their own (and, where the
 * fix is one click, the action that does it); anything else keeps the server's message and hint, minus API
 * instructions and internal ids. The code itself stays on the alert as `data-error-code` for the app's developers and
 * for tests.
 */

/** What every error shape on these pages has (ApiError, a FlowView's `error`). */
export interface ErrorLike {
  code: string;
  message: string;
  hint?: string | null;
  details?: Record<string, unknown>;
  requestId?: string | null;
}

/** One click that does what the copy asks: forget this flow's account and choose again (POST …/switch). */
export type ErrorAction = { kind: "switch"; label: string };

export interface CarbonError {
  code: string;
  title: string;
  /** What happened and what to do next, in one or two sentences. */
  text: string;
  action?: ErrorAction;
}

export interface ErrorContext {
  /** The app being signed into, for "Briefcase asks you to…". */
  app?: string | null;
}

/**
 * Hints that instruct an API client (endpoints, FlowView fields, query parameters such as `redirect_uri=…` or a whole
 * `/authorize?…`, cookies, settings, curl).
 */
const API_SPEAK = /\b(GET|POST|PATCH|PUT|DELETE)\s+\/|\/v1\/|\/authorize\?|\b[a-z_]+=|FlowView|details\.|remember_browser|\bsa_[a-z]+\b|\bcookie\b|credentials:|\.mode\s*=|ACCOUNTS_[A-Z_]+|\bcurl\b|Content-Type/;

/** True for text that instructs an API client rather than a person (endpoints, FlowView fields, settings). */
export const isApiSpeak = (text: string | null | undefined): boolean => !!text && API_SPEAK.test(text);

/** "sign-in flow 'eVdo4FYOPFzXjl-M9BTMiQ'" → "this sign-in"; internal ids are no use to a Carbon. */
const FLOW_ID = /\b(?:sign-in\s+)?flow\s+'[A-Za-z0-9_~-]{6,}'/gi;

/** An exact UTC instant as the server writes it into a sentence ("2026-10-06T10:41:00.000Z"). */
const RFC3339 = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`;
/** " (until 2026-10-06T10:41:00.000Z)", " (at …)": the whole aside goes. */
const INSTANT_ASIDE = new RegExp(String.raw`\s*\((?:until|at)\s+${RFC3339}\)`, "g");
/** "expired at 2026-…Z: a verified email…": the clause ends where its time was ("expired. A verified email…"). */
const INSTANT_BEFORE_COLON = new RegExp(String.raw`\s+(?:until|at)\s+${RFC3339}:\s+(\p{Ll})`, "gu");
/** " at 2026-10-06T10:41:00.000Z", " until …", or a bare instant: the time goes with the word that introduces it. */
const INSTANT = new RegExp(String.raw`\s*(?:\b(?:until|at)\s+)?${RFC3339}`, "g");

/**
 * The server's sentence without its exact UTC instants, which read as noise on these pages, and without the words
 * that introduced them: "The sign-up session expired at 2026-…Z: a verified email … stays ready for 48 hours." reads
 * "The sign-up session expired. A verified email … stays ready for 48 hours.", never "expired at: …".
 */
export function withoutInstants(text: string): string {
  return text
    .replace(INSTANT_ASIDE, "")
    .replace(INSTANT_BEFORE_COLON, (_, next: string) => `. ${next.toUpperCase()}`)
    .replace(INSTANT, "");
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** The server's words with API instructions, internal ids and exact instants taken out. */
export function plainWords(error: ErrorLike): string {
  const message = sentence(withoutInstants(error.message.replace(FLOW_ID, "this sign-in")));
  const hint = error.hint && !API_SPEAK.test(error.hint) ? sentence(error.hint.replace(FLOW_ID, "this sign-in")) : "";
  return [message, hint].filter(Boolean).join(" ");
}

const DETAIL_NAMES: Record<string, string> = { email: "email address", phone: "phone number", dob: "date of birth", timezone: "timezone" };

function missingDetails(error: ErrorLike): string {
  const missing = Array.isArray(error.details?.missing) ? (error.details?.missing as unknown[]).map(String) : [];
  const names = missing.map(field => DETAIL_NAMES[field] ?? field);
  if (!names.length) return "a detail";
  return names.length === 1 ? `your ${names[0]}` : `your ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Carbon-facing copy for an error a hosted page shows. */
export function carbonError(error: ErrorLike, context: ErrorContext = {}): CarbonError {
  const app = context.app?.trim() || "This app";
  const code = error.code;
  const make = (title: string, text: string, action?: ErrorAction): CarbonError => ({ code, title, text, action });
  switch (code) {
    case "session_required":
      return make("You were signed out", "This browser signed out of Silicon Accounts (in another tab, or the session ended), so it cannot continue as that account. Sign in again to go on.", { kind: "switch", label: "Sign in again" });
    case "account_changed":
      return make("Another account signed in", "This browser signed in to a different account in another tab, so this sign-in stopped. Choose the account to continue with.", { kind: "switch", label: "Choose the account" });
    case "flow_changed":
    case "invalid_step":
      return make("This sign-in moved on", "It changed in another tab while you were here, so this page now shows where it is.");
    case "flow_completed":
      return make("This sign-in already finished", "It finished in another tab.");
    case "flow_failed":
      return make("This sign-in ended", `It ended without signing in. Start again from ${context.app?.trim() || "the app"}.`);
    case "signup_already_completed":
      return make("Your account is already set up", "This email or phone already finished setting up an account, in this tab or another one. Sign in with it instead.", { kind: "switch", label: "Sign in instead" });
    case "signup_not_bound":
      return make("This sign-up belongs to another browser", "The email or phone was verified in a different browser, or this browser's cookies were cleared. Verify it again here, or finish in the browser where you verified it.", { kind: "switch", label: "Verify again" });
    case "signup_expired":
      return make("Your sign-up expired", plainWords(error));
    case "method_not_enabled":
      return make("That way of signing in is off", `${app} does not offer it any more. Choose one of the ways shown here.`);
    case "continue_not_allowed":
      return make("Sign in again to continue", `${app} asks everyone to sign in each time, so this browser's account cannot be reused. Choose a way to sign in below.`);
    case "reauthentication_required":
      return make("Sign in again to continue", `${app} asked for a fresh sign-in, so this browser's account cannot be reused. Choose a way to sign in below.`);
    case "requirements_missing":
      return make("One more detail is needed", `${app} needs ${missingDetails(error)} on your account before you continue. Add it below.`);
    case "requirement_not_needed":
      return make("That detail is already there", "Your account already has it, so nothing more is needed for it.");
    case "no_code_sent":
    case "challenge_not_found":
      return make("No code is waiting", "Send a new code, then type it here.");
    case "code_expired":
      return make("This code expired", "Codes work for 10 minutes, and a newer code replaces the one before it. Send a new code.");
    case "code_already_used":
      return make("That code was already used", "Each code works once. Send a new code, then type it here.");
    case "verification_locked":
      return make("Too many wrong codes", "Entry is paused after 10 wrong codes in a row. Wait for the countdown, then type the code again.");
    case "rate_limited":
      return make("Too many tries", sentence(withoutInstants(error.message)));
    case "invalid_phone":
      return make("Check the phone number", `${sentence(error.message)} Check the number. For a number from another country, start it with + and its country code.`);
    case "invalid_country":
      return make("Check the phone number", "Choose the country of the number again, or type the number with + and its country code.");
    case "provider_not_configured": {
      const provider = /apple/i.test(error.message) ? "Apple" : "Google";
      return make(`${provider} is not available here`, `Sign in with ${provider} is not set up for ${context.app?.trim() || "this app"} right now. Choose another way to sign in.`);
    }
    case "photo_too_large":
      return make("That photo is too large", "Photos can be at most 2 MB. Pick a smaller one (512 by 512 pixels is plenty).");
    case "unsupported_media_type":
    case "invalid_image":
    case "photo_type_mismatch":
    case "empty_photo":
      return make("That file is not a photo we can use", "Pick a PNG, JPEG, WebP or GIF image.");
    case "origin_not_allowed":
      return make("That did not go through", "This page could not send the request. Reload the page and try again.");
    case "network_error":
      return make("Silicon Accounts is unreachable", "Check your connection, then try again.");
    case "client_error":
      return make("That did not work", "Something in this page failed. Reload the page and try again.");
    case "internal":
    case "server_unavailable":
      return make("Silicon Accounts had a problem", `Try again in a moment.${error.requestId && error.requestId !== "mock" ? ` If it keeps happening, mention request ${error.requestId}.` : ""}`);
    default:
      return make(titleFor(code), plainWords(error));
  }
}

/** Short alert titles for codes that keep the server's own sentence as their text. */
export function titleFor(code: string): string {
  switch (code) {
    case "provider_cancelled":
      return "Sign-in was cancelled";
    case "email_domain_not_allowed":
      return "That email cannot sign in here";
    case "signup_not_allowed":
      return "This app does not take new accounts";
    case "account_unavailable":
    case "account_not_active":
      return "That account cannot sign in";
    case "app_disabled":
      return "This app is not taking sign-ins";
    case "provider_unavailable":
    case "provider_error":
    case "provider_token_invalid":
    case "provider_config_changed":
    case "provider_answer_elsewhere":
      return "That provider did not finish";
    case "hosted_domain_mismatch":
    case "email_not_verified":
    case "provider_email_invalid":
      return "That account cannot be used here";
    case "carbon_only":
      return "Only Carbons use this page";
    case "login_required":
      return "Sign-in needed";
    case "email_in_use":
    case "phone_in_use":
      return "That belongs to another account";
    case "photo_dimensions_too_large":
      return "That photo is too large";
    default:
      return "That did not work";
  }
}

/** An error as one line in the Carbon's words (field errors, step alerts). */
export const describe = (error: ErrorLike | null | undefined, context?: ErrorContext): string | null => (error ? carbonError(error, context).text : null);
