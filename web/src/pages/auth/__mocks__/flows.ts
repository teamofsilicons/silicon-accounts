/**
 * Sample FlowViews for every hosted step, for screenshots and page work without the Rust server (see screens.ts in
 * this folder). Shapes follow crates/auth flow/view.rs. Everything here is sample data; nothing is sent anywhere.
 *
 * Plain TypeScript with type-only imports, so both the browser and the Node type-check accept it. The app's public
 * config is passed in (screens.ts reads it from testkit/fake-apps.json).
 */
import type { AccountSummary, AppPublic, Branding, SigninCopy } from "../../../api/types";
import type { HostedFlow } from "../flow/model";

export type Scenario =
  | "choose_method"
  | "continue_as"
  | "provider_cancelled"
  | "verify_code"
  | "verify_phone"
  | "signup"
  | "signup_google"
  | "signup_import"
  | "requirements"
  | "requirements_code"
  | "requirements_both"
  | "consent"
  | "consent_more"
  | "complete"
  | "declined"
  | "failed";

export const SCENARIOS: readonly Scenario[] = [
  "choose_method", "continue_as", "provider_cancelled", "verify_code", "verify_phone", "signup", "signup_google", "signup_import",
  "requirements", "requirements_code", "requirements_both", "consent", "consent_more", "complete", "declined", "failed",
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
  app_id: "accounts",
  name: "Silicon Accounts",
  logo_url: null,
  logo_dark_url: null,
  homepage_url: null,
  methods: ["google", "apple", "email", "phone"],
  branding: {} as Branding,
  copy: { title: "Sign in to Silicon Accounts", subtitle: "One account for every Carbon and Silicon.", terms_url: null, privacy_url: null, support_email: null } as SigninCopy,
};

/**
 * Where completed samples "redirect". It sits under /v1 so the screenshot mock answers it (204 keeps the page where
 * it is), instead of the browser leaving for an app that does not exist.
 */
export const SAMPLE_CALLBACK = "/v1/__sample-callback";

const minutes = (count: number, base = Date.now()) => new Date(base + count * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
const seconds = (count: number) => new Date(Date.now() + count * 1000).toISOString();

/** Sample flow `{app_id}~{scenario}` for an app. */
export function sampleFlow(app: AppPublic, scenario: Scenario, extra: Partial<HostedFlow> = {}): HostedFlow {
  const base: HostedFlow = {
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
      first_party: app.app_id === "accounts",
    },
    methods: app.methods,
    signed_in_as: null,
    challenge: null,
    signup: null,
    requirements: null,
    consent: null,
    redirect_to: null,
    error: null,
    prompt: null,
    login_hint: null,
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
  const required = [
    { scope: "profile" as const, label: "Name, id and profile photo", value: "Saket Dev (c:saket)" },
    { scope: "email" as const, label: "Email address", value: "s***@gmail.com" },
  ];
  const optional = [
    { scope: "timezone" as const, label: "Timezone", value: "Asia/Kolkata", granted: true },
    { scope: "dob" as const, label: "Date of birth", value: "1998-03-14", granted: false },
    { scope: "phone" as const, label: "Phone number", value: null, granted: false },
  ];
  const step = (patch: Partial<HostedFlow>): HostedFlow => ({ ...base, ...patch, ...extra });
  switch (scenario) {
    case "continue_as":
      return step({ signed_in_as: SAMPLE_ACCOUNT });
    case "provider_cancelled":
      return step({ error: { code: "provider_cancelled", message: "The Google sign-in was cancelled before it finished.", hint: "Pick a sign-in method again." } });
    case "verify_code":
      return step({ step: "verify_code", challenge: emailChallenge });
    case "verify_phone":
      return step({ step: "verify_code", challenge: phoneChallenge });
    case "signup":
      return step({ step: "signup", signup });
    case "signup_google":
      return step({ step: "signup", signup: { ...signup, provider: "google", provider_pfp_url: portrait("S D", 38), email: "saketdev12@gmail.com", id: "c:saketdev12" } });
    case "signup_import":
      return step({ step: "signup", signup: { ...signup, display_name: "Saket D.", id: "c:saket-crm", timezone: "America/New_York", dob: "1994-07-21", finishing_import: true } });
    case "requirements":
      return step({ step: "requirements", signed_in_as: SAMPLE_ACCOUNT, requirements: { missing: ["phone"], challenge: null } });
    case "requirements_code":
      return step({ step: "requirements", signed_in_as: SAMPLE_ACCOUNT, requirements: { missing: ["phone"], challenge: phoneChallenge } });
    case "requirements_both":
      return step({ step: "requirements", signed_in_as: SAMPLE_ACCOUNT, requirements: { missing: ["email", "phone"], challenge: null } });
    case "consent":
      return step({ step: "consent", signed_in_as: SAMPLE_ACCOUNT, consent: { required, optional, previously_granted: [] } });
    case "consent_more":
      return step({ step: "consent", signed_in_as: SAMPLE_ACCOUNT, consent: { required, optional, previously_granted: ["profile", "email"] } });
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

/** The answer after a step's action succeeds, for interactive samples. */
export function nextAfter(app: AppPublic, action: "email" | "phone" | "verify" | "signup" | "requirement" | "requirement_verify" | "consent" | "decline" | "continue" | "switch"): HostedFlow {
  switch (action) {
    case "email":
      return sampleFlow(app, "verify_code");
    case "phone":
      return sampleFlow(app, "verify_phone");
    case "verify":
      return sampleFlow(app, "signup");
    case "signup":
    case "continue":
      return sampleFlow(app, "consent");
    case "requirement":
      return sampleFlow(app, "requirements_code");
    case "requirement_verify":
      return sampleFlow(app, "consent");
    case "consent":
      return sampleFlow(app, "complete");
    case "decline":
      return sampleFlow(app, "declined");
    case "switch":
      return sampleFlow(app, "choose_method");
  }
}
