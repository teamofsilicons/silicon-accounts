/**
 * Sample FlowViews for every hosted step, for screenshots and checks without the Rust server (components/auth/screens.ts
 * and checks.ts). Shapes follow crates/auth flow/view.rs (lib/api/types.ts). Everything here is sample data; nothing is
 * sent anywhere.
 *
 * Plain TypeScript with type-only imports, so the Node runners load it without the browser code.
 */
import type { AccountSummary, AppPublic, Branding, FlowDetailField, FlowDetails, FlowView, SigninCopy } from "../../../lib/api/types";

export type Scenario =
  | "choose_method"
  | "signup_intent"
  | "continue_as"
  | "provider_cancelled"
  | "opening_google"
  | "opening_apple"
  | "email_direct"
  | "verify_code"
  | "verify_phone"
  | "signup"
  | "signup_google"
  | "signup_import"
  | "details"
  | "details_more"
  | "details_missing"
  | "details_code"
  | "details_added"
  | "details_profile"
  | "details_step1"
  | "details_step2"
  | "review"
  | "complete"
  | "declined"
  | "failed";

export const SCENARIOS: readonly Scenario[] = [
  "choose_method", "signup_intent", "continue_as", "provider_cancelled", "opening_google", "opening_apple", "email_direct", "verify_code",
  "verify_phone", "signup", "signup_google", "signup_import", "details", "details_more", "details_missing", "details_code", "details_added",
  "details_profile", "details_step1", "details_step2", "review", "complete", "declined", "failed",
];

/** A soft squircle-friendly portrait with initials, as an SVG data URI (no network in screenshot runs). */
export function portrait(name: string, hue = 212): string {
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 46% 74%)"/><stop offset="1" stop-color="hsl(${hue + 28} 42% 58%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="60" font-family="Georgia, serif" font-size="38" text-anchor="middle" fill="#FFFDF9">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The Carbon most samples are about. */
export const SAMPLE_ACCOUNT: AccountSummary = { uuid: "a8K", kind: "carbon", id: "c:saket", display_name: "Saket Dev", pfp_url: portrait("Saket Dev", 206), status: "active" };

/** The first-party app (the account site and CLI sign in through it). */
export const FIRST_PARTY: AppPublic = {
  app_id: "silicon-accounts",
  name: "Silicon Accounts",
  logo_url: null,
  logo_dark_url: null,
  homepage_url: null,
  methods: ["google", "apple", "email", "phone"],
  branding: {} as Branding,
  copy: { title: "Sign in to Silicon Accounts", subtitle: "One account for every Carbon and Silicon.", terms_url: null, privacy_url: null, support_email: null } as SigninCopy,
};

/**
 * Where completed samples "redirect". It sits under /v1 so the mock answers it (204 keeps the page where it is),
 * instead of the browser leaving for an app that does not exist.
 */
export const SAMPLE_CALLBACK = "/v1/__sample-callback";

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
const seconds = (count: number) => new Date(Date.now() + count * 1000).toISOString();

/** Sample flow `{app_id}~{scenario}` for an app. */
export function sampleFlow(app: AppPublic, scenario: Scenario, extra: Partial<FlowView> = {}): FlowView {
  const base: FlowView = {
    id: `${app.app_id}~${scenario}`,
    step: "choose_method",
    expires_at: minutes(52),
    app: {
      app_id: app.app_id,
      name: app.name,
      logo_url: app.branding?.logo_url ?? app.logo_url,
      logo_dark_url: app.branding?.logo_dark_url ?? app.logo_dark_url,
      homepage_url: app.homepage_url,
      branding: app.branding,
      copy: app.copy,
      first_party: app.app_id === "silicon-accounts",
    },
    methods: app.methods,
    signed_in_as: null,
    challenge: null,
    signup: null,
    details: null,
    review: null,
    redirect_to: null,
    error: null,
    prompt: null,
    intent: "signin",
    method_hint: null,
  };
  const emailChallenge = { channel: "email" as const, destination: "s***@gmail.com", expires_at: minutes(10), resend_available_at: seconds(27) };
  const phoneChallenge = { channel: "phone" as const, destination: "+1********0142", expires_at: minutes(10), resend_available_at: seconds(27) };
  const signup = {
    display_name: "Saket Dev",
    id: "c:saket-2",
    timezone: "Asia/Kolkata",
    dob: "2008-10-06",
    pfp_url: portrait("Saket Dev", 206),
    provider_pfp_url: null,
    email: "saket.dev@example.test",
    phone: null,
    provider: null,
    finishing_import: false,
    expires_at: minutes(60 * 48),
  };
  const field = (name: FlowDetailField["field"], mode: FlowDetailField["mode"], value: string | null, extra: Partial<FlowDetailField> = {}): FlowDetailField => ({
    field: name,
    mode,
    label: { email: "Email address", phone: "Phone number", dob: "Date of birth", timezone: "Timezone" }[name],
    value,
    missing: value === null && (name === "email" || name === "phone"),
    shared: mode === "required",
    previously_granted: false,
    new: !extra.previously_granted,
    ...extra,
  });
  const page = (fields: FlowDetailField[], extra: Partial<FlowDetails> = {}): FlowDetails => ({ index: 0, count: 1, id: "details", title: null, subtitle: null, continue_label: null, layout: null, fields, challenge: null, review_next: false, ...extra });
  const whatsShared = [field("email", "required", "s***@gmail.com"), field("timezone", "optional", "Asia/Kolkata"), field("dob", "optional", "1998-03-14"), field("phone", "optional", null)];
  const step = (patch: Partial<FlowView>): FlowView => ({ ...base, ...patch, ...extra });
  switch (scenario) {
    case "signup_intent":
      return step({ intent: "signup" });
    case "continue_as":
      return step({ signed_in_as: SAMPLE_ACCOUNT });
    case "provider_cancelled":
      return step({ method_hint: "google", error: { code: "provider_cancelled", message: "The Google sign-in was cancelled before it finished.", hint: "Pick a sign-in method again." } });
    case "opening_google":
      return step({ method_hint: "google" });
    case "opening_apple":
      return step({ method_hint: "apple" });
    case "email_direct":
      return step({ method_hint: "email" });
    case "verify_code":
      return step({ step: "verify_code", challenge: emailChallenge });
    case "verify_phone":
      return step({ step: "verify_code", challenge: phoneChallenge });
    case "signup":
      return step({ step: "signup", signup });
    case "signup_google":
      return step({ step: "signup", signup: { ...signup, provider: "google", provider_pfp_url: portrait("S D", 38), email: "saketdev12@gmail.com", id: "c:saketdev12" } });
    case "signup_import":
      // Legacy CRM imported the Carbon; they may finish the account while signing into any app.
      return step({ step: "signup", signup: { ...signup, display_name: "Saket D.", id: "c:saket-crm", timezone: "America/New_York", dob: "1994-07-21", finishing_import: true, imported_by: { app_id: "legacy-crm", name: "Legacy CRM" } } });
    case "details":
      // No flow of the app's own: one page with every detail (the what's-shared screen).
      return step({ step: "details", signed_in_as: SAMPLE_ACCOUNT, details: page(whatsShared) });
    case "details_more":
      // A returning Carbon: the app asks for more than before; what was shared before stays ticked.
      return step({
        step: "details",
        signed_in_as: SAMPLE_ACCOUNT,
        details: page([
          field("email", "required", "s***@gmail.com", { previously_granted: true }),
          field("timezone", "optional", "Asia/Kolkata", { previously_granted: true, shared: true }),
          field("dob", "optional", "1998-03-14"),
          field("phone", "optional", null),
        ]),
      });
    case "details_missing":
      return step({ step: "details", signed_in_as: SAMPLE_ACCOUNT, details: page([field("email", "required", "s***@gmail.com"), field("phone", "required", null)]) });
    case "details_code":
      return step({ step: "details", signed_in_as: SAMPLE_ACCOUNT, details: page([field("email", "required", "s***@gmail.com"), field("phone", "required", null)], { challenge: phoneChallenge }) });
    case "details_added":
      return step({ step: "details", signed_in_as: SAMPLE_ACCOUNT, details: page([field("email", "required", "s***@gmail.com"), field("phone", "required", "+1********0142")]) });
    case "details_profile":
      // An app that asks for no details still shows, on the first sign-in, that it sees the profile.
      return step({ step: "details", signed_in_as: SAMPLE_ACCOUNT, details: page([]) });
    case "details_step1":
      // A flow of the app's own (ledgerly's): contact first, with its own title…
      return step({
        step: "details",
        signed_in_as: SAMPLE_ACCOUNT,
        details: page([field("email", "required", "s***@gmail.com"), field("phone", "optional", null)], { index: 0, count: 2, id: "contact", title: "How can we reach you?" }),
      });
    case "details_step2":
      // …then about you, in the split layout, with "Finish" on its button; a review follows.
      return step({
        step: "details",
        signed_in_as: SAMPLE_ACCOUNT,
        details: page([field("dob", "required", "1998-03-14"), field("timezone", "optional", "Asia/Kolkata")], { index: 1, count: 2, id: "about-you", continue_label: "Finish", layout: "split", review_next: true }),
      });
    case "review":
      return step({
        step: "review",
        signed_in_as: SAMPLE_ACCOUNT,
        review: {
          fields: [
            { field: "profile", mode: "required", label: "Name, id and profile photo", value: "Saket Dev (c:saket)", shared: true },
            { field: "email", mode: "required", label: "Email address", value: "s***@gmail.com", shared: true },
            { field: "dob", mode: "required", label: "Date of birth", value: "1998-03-14", shared: true },
            { field: "timezone", mode: "optional", label: "Timezone", value: "Asia/Kolkata", shared: true },
            { field: "phone", mode: "optional", label: "Phone number", value: null, shared: false },
          ],
        },
      });
    case "complete":
      return step({ step: "complete", signed_in_as: SAMPLE_ACCOUNT, redirect_to: `${SAMPLE_CALLBACK}?code=sac_sample&state=xyz` });
    case "declined":
      return step({ step: "complete", signed_in_as: SAMPLE_ACCOUNT, redirect_to: `${SAMPLE_CALLBACK}?error=access_denied&error_description=The+Carbon+declined&state=xyz` });
    case "failed":
      return step({
        step: "failed",
        redirect_to: `${SAMPLE_CALLBACK}?error=login_required&error_description=No+Carbon+is+signed+in&state=xyz`,
        error: { code: "login_required", message: "No Carbon is signed in to Silicon Accounts in this browser, and prompt=none forbids showing the sign-in page.", hint: "Send the browser to /authorize without prompt=none so the Carbon can sign in." },
        prompt: "none",
      });
    default:
      return step({});
  }
}

/** Actions of the hosted pages, for interactive samples. */
export type SampleAction = "email" | "phone" | "verify" | "signup" | "continue" | "switch" | "details_add" | "details_verify" | "details_continue" | "details_back" | "approve" | "decline";

/** The scenario after an action succeeds on `from`, for interactive samples (a multi-page flow walks its pages). */
export function scenarioAfter(from: Scenario, action: SampleAction): Scenario {
  switch (action) {
    case "email":
      return "verify_code";
    case "phone":
      return "verify_phone";
    case "verify":
      return "signup";
    case "signup":
    case "continue":
      return "details";
    case "switch":
      return "choose_method";
    case "details_add":
      return "details_code";
    case "details_verify":
      return "details_added";
    case "details_continue":
      return from === "details_step1" ? "details_step2" : from === "details_step2" ? "review" : "complete";
    case "details_back":
      return from === "review" ? "details_step2" : "details_step1";
    case "approve":
      return "complete";
    case "decline":
      return "declined";
  }
}

/** The answer after a step's action succeeds, for interactive samples. */
export function nextAfter(app: AppPublic, action: SampleAction, from: Scenario = "choose_method"): FlowView {
  return sampleFlow(app, scenarioAfter(from, action));
}
