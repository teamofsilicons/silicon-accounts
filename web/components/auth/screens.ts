/**
 * Screens of the hosted sign-in and CLI device approval, picked up by scripts/screens.ts: every step for four
 * brandings (the default look, acme-notes dark/serif/split, pixel-studio loud/sharp/minimal, orbit-games compact), the
 * problem pages, interactions (a wrong code, a taken id, the phone tab, international numbers, a click-through), the
 * first-party look and the device page. The API is mocked with ./mocks/flows.ts.
 *
 *   pnpm screens --only auth-              everything here (device screens start with device-)
 *   pnpm screens --only auth-acme          one branding
 *   SCREENS_ERRORS=1 pnpm screens --only auth-problem,auth-default-verify-wrong --allow-errors
 *       screens whose API answers are errors (Chromium logs every failed fetch as a console error)
 *
 * Interaction checks (mock and live) are in ./checks.ts.
 */
import type { AppPublic } from "../../lib/api/types";
import { appPublic } from "../../scripts/mock/fixtures";
import type { MockRoute, ScreenSpec } from "../../scripts/screens-types";
import { FIRST_PARTY, SAMPLE_CALLBACK, portrait, sampleFlow, scenarioAfter, type SampleAction, type Scenario } from "./mocks/flows";

const BRANDINGS = [
  { key: "default", appId: "briefcase" },
  { key: "acme", appId: "acme-notes" },
  { key: "pixel", appId: "pixel-studio" },
  { key: "orbit", appId: "orbit-games" },
] as const;

const SHOT_SCENARIOS: Scenario[] = ["choose_method", "opening_google", "continue_as", "verify_code", "signup", "details", "details_code", "details_step2", "review", "complete"];
/** Shown for the default look only: the same parts in other states. */
const EXTRA_SCENARIOS: Scenario[] = [
  "signup_intent", "provider_cancelled", "opening_apple", "email_direct", "verify_phone", "signup_google", "signup_import", "details_more",
  "details_missing", "details_added", "details_profile", "details_step1", "declined", "failed",
];

export const appOf = (appId: string): AppPublic => (appId === "accounts" ? FIRST_PARTY : appPublic(appId) ?? FIRST_PARTY);
export const apiError = (status: number, code: string, message: string, hint?: string, details?: Record<string, unknown>) => ({ status, json: { error: { code, message, hint, details } } });
export const flowJson = (flow: unknown) => ({ json: { flow } });
const parse = (id: string): { app: AppPublic; scenario: Scenario } => {
  const [appId = "briefcase", scenario = "choose_method"] = id.split("~");
  return { app: appOf(appId), scenario: scenario as Scenario };
};

/**
 * Where each sample flow is now: a GET starts it afresh at the scenario its id names, and every action moves it on
 * (scenarioAfter), so a multi-page flow clicks through its pages, the review and back.
 */
const flowState = new Map<string, Scenario>();
const current = (id: string): { app: AppPublic; scenario: Scenario } => {
  const parsed = parse(id);
  return { app: parsed.app, scenario: flowState.get(id) ?? parsed.scenario };
};
const advance = (id: string, action: SampleAction) => {
  const { app, scenario } = current(id);
  const next = scenarioAfter(scenario, action);
  flowState.set(id, next);
  // The answer keeps the page's flow id: the page goes on calling the flow it started.
  return flowJson({ ...sampleFlow(app, next), id });
};

/** A mock of the flow API good enough to click through: each action answers with the sample of the next step. */
export const flowRoutes: MockRoute[] = [
  ["GET /v1/flows/:id", ({ params }) => {
    const id = params.id ?? "";
    flowState.delete(id);
    const { app, scenario } = parse(id);
    return flowJson(sampleFlow(app, scenario));
  }],
  ["POST /v1/flows", ({ body }) => {
    const input = (body ?? {}) as Record<string, unknown>;
    const appId = String(input.app_id ?? input.client_id ?? "");
    if (appId === "nope") return apiError(400, "unknown_app", "No app with app_id 'nope' exists in Silicon Accounts.", "Check the app_id in the sign-in link; apps are created in Silicon Apps.");
    if (String(input.redirect_uri ?? "").includes("evil")) {
      return apiError(400, "redirect_uri_not_registered", `redirect_uri 'https://evil.example/steal' is not registered for the app '${appId}': it must equal one of the app's registered redirect_uris exactly (http://localhost and http://127.0.0.1 match on any port when registered with that host).`, `Register it in the app's sign-in setup (on developers.teamofsilicons.com, or PATCH /v1/apps/${appId}/signin-config with redirect_uris), or use a registered URI.`, { app_id: appId });
    }
    const method = typeof input.method === "string" ? input.method : null;
    const scenario: Scenario = method === "google" ? "opening_google" : method === "apple" ? "opening_apple" : method === "email" ? "email_direct" : input.intent === "signup" ? "signup_intent" : "choose_method";
    return { status: 201, json: { flow: sampleFlow(appOf(appId || "accounts"), scenario) } };
  }],
  ["POST /v1/flows/:id/email", ({ params }) => advance(params.id ?? "", "email")],
  ["POST /v1/flows/:id/phone", ({ params }) => advance(params.id ?? "", "phone")],
  ["POST /v1/flows/:id/resend", ({ params }) => {
    const { app, scenario } = current(params.id ?? "");
    return flowJson({ ...sampleFlow(app, scenario), id: params.id ?? "" });
  }],
  ["POST /v1/flows/:id/verify", ({ params, body }) => {
    const code = String((body as Record<string, unknown> | null)?.code ?? "");
    if (code === "123456") return advance(params.id ?? "", "verify");
    return apiError(422, "invalid_code", "That code is wrong; 9 more tries for s***@gmail.com before a 60 second cooldown.", "Check the latest code you received and type it again.", { remaining_attempts: 9 });
  }],
  ["POST /v1/flows/:id/continue", ({ params }) => advance(params.id ?? "", "continue")],
  ["POST /v1/flows/:id/switch", ({ params }) => advance(params.id ?? "", "switch")],
  ["POST /v1/flows/:id/signup", ({ params }) => advance(params.id ?? "", "signup")],
  ["POST /v1/flows/:id/signup/photo", () => ({ status: 201, json: { pfp_url: portrait("New Photo", 150), photo: { id: "photo-sample", content_type: "image/png", bytes: 1024, width: 8, height: 8 } } })],
  ["POST /v1/flows/:id/details/add", ({ params }) => advance(params.id ?? "", "details_add")],
  ["POST /v1/flows/:id/details/verify", ({ params, body }) => {
    const code = String((body as Record<string, unknown> | null)?.code ?? "");
    if (code === "123456") return advance(params.id ?? "", "details_verify");
    return apiError(422, "invalid_code", "That code is wrong; 9 more tries for +1********0142 before a 60 second cooldown.", "Check the latest code you received and type it again.", { remaining_attempts: 9 });
  }],
  ["POST /v1/flows/:id/details/continue", ({ params }) => advance(params.id ?? "", "details_continue")],
  ["POST /v1/flows/:id/details/back", ({ params }) => advance(params.id ?? "", "details_back")],
  ["POST /v1/flows/:id/review", ({ params, body }) => advance(params.id ?? "", (body as { approve?: boolean } | null)?.approve ? "approve" : "decline")],
  // A real provider would take the browser away; the samples point at an address nothing answers.
  ["POST /v1/flows/:id/oauth/:provider", ({ params }) => ({ json: { authorize_url: `https://provider.example/${params.provider}/authorize?sample=1` } })],
  // Completed samples "redirect" here; 204 keeps the page in place for the screenshot.
  [`GET ${SAMPLE_CALLBACK}`, () => ({ status: 204 })],
];

const minutesFromNow = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

/** WDJB-MJHT is waiting; EXPD-0000 expired; USED-0000 was used. */
export const deviceRoutes: MockRoute[] = [
  ["GET /v1/device/:code", ({ params }) => {
    const code = params.code ?? "";
    const status = code.startsWith("EXPD") ? "expired" : code.startsWith("USED") ? "consumed" : "pending";
    return { json: { user_code: code, client_label: "accounts CLI on saket-mbp", created_at: minutesFromNow(-1), expires_at: minutesFromNow(status === "expired" ? -2 : 9), status } };
  }],
  ["POST /v1/device/:code/approve", () => ({ status: 204 })],
  ["POST /v1/device/:code/deny", () => ({ status: 204 })],
];

/** A soft abstract picture (an SVG data URI, so screenshot runs need no network). */
const BACKGROUND_SAMPLE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000"><defs><radialGradient id="a" cx="20%" cy="25%" r="70%"><stop offset="0" stop-color="#9DB8E8"/><stop offset="1" stop-color="#F3EBDD"/></radialGradient><radialGradient id="b" cx="85%" cy="80%" r="55%"><stop offset="0" stop-color="#E7B98A" stop-opacity=".8"/><stop offset="1" stop-color="#F3EBDD" stop-opacity="0"/></radialGradient></defs><rect width="1600" height="1000" fill="url(#a)"/><rect width="1600" height="1000" fill="url(#b)"/></svg>')}`;

export const flowPath = (appId: string, scenario: Scenario) => `/authorize/flow/${encodeURIComponent(`${appId}~${scenario}`)}`;
export const READY = 'main[data-fonts="ready"]';

/**
 * The Opening page moves on to the provider by itself after 900 ms: for its screenshots the provider's address takes
 * its time to come, so the page stays on "Opening Google…" (its bar full, the button busy).
 */
const routesFor = (scenario: Scenario): MockRoute[] =>
  scenario.startsWith("opening")
    ? [...flowRoutes, ["POST /v1/flows/:id/oauth/:provider", ({ params }) => ({ delay: 60_000, json: { authorize_url: `https://provider.example/${params.provider}/authorize?sample=1` } })]]
    : flowRoutes;

const stepScreens: ScreenSpec[] = BRANDINGS.flatMap(({ key, appId }) =>
  SHOT_SCENARIOS.map(scenario => ({ name: `auth-${key}-${scenario}`, path: flowPath(appId, scenario), as: "signed-out" as const, routes: routesFor(scenario), waitFor: READY, settle: 1000 })),
);

const extraScreens: ScreenSpec[] = EXTRA_SCENARIOS.map(scenario => ({
  name: `auth-default-${scenario}`,
  path: flowPath("briefcase", scenario),
  as: "signed-out" as const,
  routes: routesFor(scenario),
  waitFor: READY,
  settle: 1000,
}));

const interactionScreens: ScreenSpec[] = [
  {
    name: "auth-default-signup-id-taken",
    path: flowPath("briefcase", "signup"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    prepare: async page => {
      await page.getByRole("textbox", { name: "Your id" }).fill("saket");
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "auth-default-signup-dob-years",
    path: flowPath("briefcase", "signup"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Date of birth" }).click();
      await page.getByRole("button", { name: /choose a year/ }).click();
      await page.waitForTimeout(700);
    },
  },
  {
    name: "auth-default-choose-phone",
    path: flowPath("briefcase", "choose_method"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "auth-default-choose-phone-international",
    path: flowPath("dm", "choose_method"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      await page.getByRole("button", { name: "Country not in the list?" }).click();
      await page.keyboard.type("40 755 345 678");
      await page.waitForTimeout(600);
    },
  },
  {
    name: "auth-acme-click-through",
    path: flowPath("acme-notes", "choose_method"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    fullPage: false,
    prepare: async page => {
      await page.getByRole("textbox", { name: "Email" }).fill("saket.dev@example.test");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.waitForSelector("text=Check your email");
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
      await page.keyboard.type("123456", { delay: 30 });
      await page.waitForSelector("text=Set up your account");
      await page.waitForTimeout(900);
    },
  },
  { name: "auth-first-party", path: flowPath("accounts", "choose_method"), as: "signed-out", routes: flowRoutes, waitFor: READY },
  {
    // No fake app uses a background image: briefcase with one (and a logo-only header), to see the image treatment.
    name: "auth-branding-image",
    path: flowPath("briefcase", "choose_method"),
    as: "signed-out",
    routes: [...flowRoutes, ["GET /v1/flows/:id", () => {
      const app = appOf("briefcase");
      return flowJson(sampleFlow({ ...app, branding: { ...app.branding, background_style: "image", background_image_url: BACKGROUND_SAMPLE, show_app_name: false, logo_height: 44 } }, "choose_method"));
    }]],
    waitFor: READY,
  },
  { name: "auth-problem-no-app", path: "/authorize", as: "signed-out", routes: flowRoutes, waitFor: "[data-problem]" },
];

const problemScreens: ScreenSpec[] = [
  { name: "auth-problem-unknown-app", path: "/authorize?app_id=nope&redirect_uri=https%3A%2F%2Fnope.example%2Fcallback&state=abc", as: "signed-out", routes: flowRoutes, waitFor: "[data-problem]" },
  { name: "auth-problem-bad-redirect", path: "/authorize?app_id=briefcase&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&state=abc", as: "signed-out", routes: flowRoutes, waitFor: "[data-problem]" },
  {
    name: "auth-problem-expired",
    path: flowPath("acme-notes", "choose_method"),
    as: "signed-out",
    routes: [...flowRoutes, ["GET /v1/flows/:id", () => apiError(410, "flow_expired", "Sign-in flow 'acme-notes~choose_method' expired at 2026-10-06T10:41:00.000Z; flows last 60 minutes.", "Start the sign-in again from the app. A verified email or phone stays ready for sign-up for 48 hours, so no new code is needed for that.")]],
    waitFor: "[data-problem]",
    prepare: async page => {
      // The browser remembers the /authorize query of flows it started: "Start again" reuses it.
      await page.evaluate(() => sessionStorage.setItem("silicon-accounts:flow-query:acme-notes~choose_method", "app_id=acme-notes&redirect_uri=http%3A%2F%2F127.0.0.1%3A8593%2Facme-notes%2Fcallback&state=abc"));
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("[data-problem]");
      await page.waitForTimeout(600);
    },
  },
  {
    name: "auth-default-verify-wrong-code",
    path: flowPath("briefcase", "verify_code"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    fullPage: false,
    prepare: async page => {
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
      await page.keyboard.type("111111", { delay: 30 });
      await page.waitForTimeout(900);
    },
  },
];

const deviceScreens: ScreenSpec[] = [
  { name: "device-enter", path: "/device", routes: deviceRoutes, waitFor: "text=Connect your terminal" },
  { name: "device-review", path: "/device?code=WDJB-MJHT", routes: deviceRoutes, waitFor: "text=Approve this sign-in?" },
  {
    name: "device-approved",
    path: "/device?code=WDJB-MJHT",
    routes: deviceRoutes,
    waitFor: "text=Approve this sign-in?",
    prepare: async page => {
      await page.getByRole("button", { name: "Approve sign-in" }).click();
      await page.waitForSelector("text=Your terminal is signed in");
      await page.waitForTimeout(1200);
    },
  },
  { name: "device-expired", path: "/device?code=EXPD-0000", routes: deviceRoutes, waitFor: "text=This code expired" },
];

/**
 * Screens whose API answers are errors. Chromium logs every failed fetch as a console error, which fails a normal run,
 * so they only run on request (SCREENS_ERRORS=1 with --allow-errors).
 */
const errorScreens = process.env.SCREENS_ERRORS === "1" ? problemScreens : [];

export const screens: ScreenSpec[] = [...stepScreens, ...extraScreens, ...interactionScreens, ...errorScreens, ...deviceScreens];
