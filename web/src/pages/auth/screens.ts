/**
 * Screens and checks of the hosted sign-in, the embed and the SDK (and, run from here, of CLI device approval).
 *
 * Screens (picked up by scripts/screens.ts): every step for four brandings (the default look, acme-notes
 * dark/serif/split, pixel-studio loud/sharp/minimal, orbit-games compact), the problems pages, and a few interactions
 * (a wrong code, a taken id, the phone tab). The API is mocked with ./__mocks__/flows.ts.
 *
 *   pnpm screens --only auth-           everything here
 *   pnpm screens --only auth-acme       one branding
 *
 * Checks (run this file directly): interaction tests in a real browser. Each fails on a broken expectation, a page
 * error, or a console error other than the failed requests a check provokes on purpose. This file holds them because
 * only `src/pages/<area>/screens.ts` files are type-checked as Node code (tsconfig.node.json).
 *
 *   pnpm -C web exec tsx src/pages/auth/screens.ts                       mock API (no server needed), Chromium
 *   pnpm -C web exec tsx src/pages/auth/screens.ts --engine webkit       the same in WebKit (Safari)
 *   pnpm -C web exec tsx src/pages/auth/screens.ts --only phone          checks whose name contains "phone"
 *   pnpm -C web exec tsx src/pages/auth/screens.ts --live http://localhost:8690
 *        end to end against a running accounts-api that serves the built web app (ACCOUNTS_WEB_DIST), with the dev
 *        outbox on, a database seeded from testkit/fake-apps.json and the testkit's mock Google/Apple
 *        (LIVE_OIDC_URL, default http://127.0.0.1:8591). LIVE_PSQL="psql … -d <db>" enables the expired-flow check.
 *        Each browser sends its own X-Forwarded-For; with ACCOUNTS_TRUST_FORWARDED_FOR=true the per-network send
 *        limits then apply per check, so the suite can run again and again.
 *   CHECKS_SHOTS=<dir>  screenshots of every open page of a check that failed.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, expect, webkit, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { build, createServer, type Plugin } from "vite";
import { mockApi, type MockRequest } from "../../../scripts/mock/api";
import type { MockRoute, ScreenSpec } from "../../../scripts/screens-types";
import { appPublic } from "../../../scripts/mock/fixtures";
import type { AppPublic } from "../../api/types";
import { FIRST_PARTY, SAMPLE_CALLBACK, nextAfter, sampleFlow, type Scenario } from "./__mocks__/flows";
import type { HostedFlow } from "./flow/model";

const BRANDINGS = [
  { key: "default", appId: "briefcase" },
  { key: "acme", appId: "acme-notes" },
  { key: "pixel", appId: "pixel-studio" },
  { key: "orbit", appId: "orbit-games" },
] as const;

const SHOT_SCENARIOS: Scenario[] = ["choose_method", "continue_as", "verify_code", "signup", "requirements", "requirements_code", "consent", "complete"];
/** Shown for the default look only: the same parts in other states. */
const EXTRA_SCENARIOS: Scenario[] = ["provider_cancelled", "verify_phone", "signup_google", "signup_import", "requirements_both", "consent_more", "declined", "failed"];

const appOf = (appId: string): AppPublic => (appId === "accounts" ? FIRST_PARTY : appPublic(appId) ?? FIRST_PARTY);
const error = (status: number, code: string, message: string, hint?: string, details?: Record<string, unknown>) => ({ status, json: { error: { code, message, hint, details } } });
const flowJson = (flow: unknown) => ({ json: { flow } });
const parse = (id: string): { app: AppPublic; scenario: Scenario } => {
  const [appId = "briefcase", scenario = "choose_method"] = id.split("~");
  return { app: appOf(appId), scenario: scenario as Scenario };
};

/** A mock of the flow API good enough to click through: each action answers with the sample of the next step. */
export const flowRoutes: MockRoute[] = [
  ["GET /v1/flows/:id", ({ params }) => {
    const { app, scenario } = parse(params.id ?? "");
    return flowJson(sampleFlow(app, scenario));
  }],
  ["POST /v1/flows", ({ body }) => {
    const appId = String((body as Record<string, unknown>)?.app_id ?? (body as Record<string, unknown>)?.client_id ?? "");
    if (appId === "nope") return error(400, "unknown_app", "No app with app_id 'nope' exists in Silicon Accounts.", "Check the app_id in the sign-in link; apps are created in Silicon Apps.");
    if (String((body as Record<string, unknown>)?.redirect_uri ?? "").includes("evil")) {
      return error(400, "redirect_uri_not_registered", `redirect_uri 'https://evil.example/steal' is not registered for the app '${appId}': it must equal one of the app's registered redirect_uris exactly (http://localhost and http://127.0.0.1 match on any port when registered with that host).`, `Register it in the app's sign-in setup (PATCH /v1/apps/${appId}/signin-config with redirect_uris), or use a registered URI.`, { app_id: appId });
    }
    return { status: 201, json: { flow: sampleFlow(appOf(appId || "accounts"), "choose_method") } };
  }],
  ["POST /v1/flows/:id/email", ({ params }) => flowJson(nextAfter(parse(params.id ?? "").app, "email"))],
  ["POST /v1/flows/:id/phone", ({ params }) => flowJson(nextAfter(parse(params.id ?? "").app, "phone"))],
  ["POST /v1/flows/:id/resend", ({ params }) => flowJson(sampleFlow(parse(params.id ?? "").app, parse(params.id ?? "").scenario))],
  ["POST /v1/flows/:id/verify", ({ params, body }) => {
    const code = String((body as Record<string, unknown>)?.code ?? "");
    if (code === "123456") return flowJson(nextAfter(parse(params.id ?? "").app, "verify"));
    return error(422, "invalid_code", "That code is wrong; 9 more tries for s***@gmail.com before a 60 second cooldown.", "Check the latest code you received and type it again.", { remaining_attempts: 9 });
  }],
  ["POST /v1/flows/:id/continue", ({ params }) => flowJson(nextAfter(parse(params.id ?? "").app, "continue"))],
  ["POST /v1/flows/:id/switch", ({ params }) => flowJson(nextAfter(parse(params.id ?? "").app, "switch"))],
  ["POST /v1/flows/:id/signup", ({ params }) => flowJson(nextAfter(parse(params.id ?? "").app, "signup"))],
  ["POST /v1/flows/:id/requirements/:kind", ({ params }) => flowJson(nextAfter(parse(params.id ?? "").app, params.kind === "verify" ? "requirement_verify" : "requirement"))],
  ["POST /v1/flows/:id/consent", ({ params, body }) => flowJson(nextAfter(parse(params.id ?? "").app, (body as { approve?: boolean })?.approve ? "consent" : "decline"))],
  ["POST /v1/flows/:id/oauth/:provider", () => ({ json: { authorize_url: `${SAMPLE_CALLBACK}?provider=sample` } })],
  // Completed samples "redirect" here; 204 keeps the page in place for the screenshot.
  [`GET ${SAMPLE_CALLBACK}`, () => ({ status: 204 })],
];

const flowPath = (appId: string, scenario: Scenario) => `/authorize/flow/${encodeURIComponent(`${appId}~${scenario}`)}`;
const READY = 'main[data-fonts="ready"]';

const typeCode = async (page: Page, code: string) => {
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
  await page.keyboard.type(code, { delay: 30 });
  await page.waitForTimeout(900);
};

const stepScreens: ScreenSpec[] = BRANDINGS.flatMap(({ key, appId }) =>
  SHOT_SCENARIOS.map(scenario => ({ name: `auth-${key}-${scenario}`, path: flowPath(appId, scenario), as: "signed-out" as const, routes: flowRoutes, waitFor: READY, settle: 1000 })),
);

const extraScreens: ScreenSpec[] = EXTRA_SCENARIOS.map(scenario => ({
  name: `auth-default-${scenario}`,
  path: flowPath("briefcase", scenario),
  as: "signed-out" as const,
  routes: flowRoutes,
  waitFor: READY,
  settle: 1000,
}));

const wrongCode: ScreenSpec = { name: "auth-default-verify-wrong-code", path: flowPath("briefcase", "verify_code"), as: "signed-out", routes: flowRoutes, waitFor: READY, fullPage: false, prepare: page => typeCode(page, "111111") };

const interactionScreens: ScreenSpec[] = [
  {
    name: "auth-default-signup-id-taken",
    path: flowPath("briefcase", "signup"),
    as: "signed-out",
    routes: flowRoutes,
    waitFor: READY,
    prepare: async page => {
      const field = page.getByRole("textbox", { name: "Your id" });
      await field.fill("saket");
      await page.waitForTimeout(1200);
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
      await typeCode(page, "123456");
      await page.waitForSelector("text=Set up your account");
      await page.waitForTimeout(700);
    },
  },
  { name: "auth-first-party", path: flowPath("accounts", "choose_method"), as: "signed-out", routes: flowRoutes, waitFor: READY },
];

const problemScreens: ScreenSpec[] = [
  { name: "auth-problem-unknown-app", path: "/authorize?app_id=nope&redirect_uri=https%3A%2F%2Fnope.example%2Fcallback&state=abc", as: "signed-out", routes: flowRoutes, waitFor: "[data-problem]" },
  { name: "auth-problem-bad-redirect", path: "/authorize?app_id=briefcase&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&state=abc", as: "signed-out", routes: flowRoutes, waitFor: "[data-problem]" },
  { name: "auth-problem-no-app", path: "/authorize", as: "signed-out", routes: flowRoutes, waitFor: "[data-problem]" },
  {
    name: "auth-problem-expired",
    path: flowPath("acme-notes", "choose_method"),
    as: "signed-out",
    routes: [...flowRoutes, ["GET /v1/flows/:id", () => error(410, "flow_expired", "Sign-in flow 'acme-notes~choose_method' expired at 2026-10-06T10:41:00.000Z; flows last 60 minutes.", "Start the sign-in again from the app. A verified email or phone stays ready for sign-up for 48 hours, so no new code is needed for that.")]],
    waitFor: "[data-problem]",
    prepare: async page => {
      // The browser remembers the /authorize query of flows it started: "Start again" reuses it.
      await page.evaluate(() => sessionStorage.setItem("silicon-accounts:flow-query:acme-notes~choose_method", "app_id=acme-notes&redirect_uri=http%3A%2F%2F127.0.0.1%3A8593%2Facme-notes%2Fcallback&state=abc"));
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("[data-problem]");
      await page.waitForTimeout(600);
    },
  },
];

/**
 * Screens whose API answers are errors. Chromium logs every failed fetch as a console error, which fails a normal run,
 * so they only run on request: SCREENS_ERRORS=1 pnpm screens --only auth-problem,auth-default-verify-wrong --allow-errors
 */
const errorScreens = process.env.SCREENS_ERRORS === "1" ? [...problemScreens, wrongCode] : [];

export const screens: ScreenSpec[] = [...stepScreens, ...extraScreens, ...interactionScreens, ...errorScreens];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Checks                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface CheckEnv {
  page: Page;
  context: BrowserContext;
  /** Silicon Accounts: the dev server. */
  base: string;
  /** Another origin, for an app's own page (the dev server under "localhost"). */
  appOrigin: string;
  /** Every request the mock API answered, in order. */
  requests: MockRequest[];
  /** Serves `html` as a page of the app's origin at `path`; returns its URL. */
  host: (path: string, html: string) => string;
}

export interface MockCheck {
  name: string;
  /** Where the check starts, on Silicon Accounts. Without it the check navigates itself. */
  path?: string;
  /** Who the mock API says is signed in (default: nobody). */
  as?: "carbon" | "signed-out";
  /** Mock routes on top of the flow and device samples (a function gets fresh state for every run). */
  routes?: MockRoute[] | (() => MockRoute[]);
  width?: number;
  dark?: boolean;
  /** The browser's timezone (default Asia/Kolkata): it decides the phone field's starting country. */
  timezone?: string;
  run: (env: CheckEnv) => Promise<void>;
}

const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });
const routeFlow = (make: () => HostedFlow): MockRoute => ["GET /v1/flows/:id", () => flowJson(make())];
const isoIn = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const doc = (body: string, style = "margin:0;padding:24px;background:#ffffff") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head><body style="${style}">${body}</body></html>`;

/** A paste as the browser fires it (the clipboard's text on the event). */
async function paste(field: Locator, text: string): Promise<void> {
  await field.focus();
  await field.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/** The JSON body of the next POST whose path ends with `suffix`. */
function nextPost(page: Page, suffix: string): Promise<Record<string, unknown>> {
  return page
    .waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname.endsWith(suffix))
    .then(request => (request.postDataJSON() ?? {}) as Record<string, unknown>);
}

type Rgba = [number, number, number, number];
function rgba(css: string): Rgba {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(css);
  if (!match) throw new Error(`not an rgb() colour: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}
function contrast(a: string, b: string): number {
  const lum = ([r, g, bl]: Rgba) => {
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const [x, y] = [lum(rgba(a)), lum(rgba(b))].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** The colour on screen at one CSS pixel of the viewport. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async data => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, png.toString("base64"));
}

/** What the SDK drew in `#sa`: its theme and the "Powered by" pill's colours. */
function sdkLook(page: Page) {
  return page.locator("#sa").evaluate(host => {
    const shadow = host.shadowRoot;
    const root = shadow?.querySelector<HTMLElement>(".sa");
    const pill = shadow?.querySelector<HTMLElement>(".w");
    const link = pill?.querySelector("a");
    if (!root || !pill || !link) return null;
    const primary = shadow?.querySelector<HTMLElement>(".b.p");
    return {
      theme: root.dataset.theme ?? "",
      pillBg: getComputedStyle(pill).backgroundColor,
      pillText: getComputedStyle(pill).color,
      pillLink: getComputedStyle(link).color,
      primaryFill: primary ? getComputedStyle(root).getPropertyValue("--pr").trim() : null,
      native: CSS.supports("corner-shape", "squircle"),
      buttons: shadow?.querySelectorAll(".b").length ?? 0,
      shaped: Array.from(shadow?.querySelectorAll<HTMLElement>(".b") ?? []).filter(button => button.hasAttribute("data-fb") && button.style.getPropertyValue("--p").startsWith("path(")).length,
    };
  });
}

const hostedChecks: MockCheck[] = [
  {
    name: "change: a refused address stays under its field instead of jumping back to the old code",
    path: flowPath("campus-connect", "verify_code"),
    routes: () => {
      let calls = 0;
      // One stored flow, as the server keeps it: a re-read returns the same challenge.
      const stored = sampleFlow(appOf("campus-connect"), "verify_code");
      return [routeFlow(() => stored), ["POST /v1/flows/:id/email", () => (++calls === 1
        ? error(403, "email_domain_not_allowed", "Campus Connect only accepts email addresses at university.test; gmail.test is not one of them.", "Sign in with an email address at university.test.")
        : error(403, "method_not_enabled", "Campus Connect doesn't offer sign-in with email; it offers google.", "Use one of the methods in FlowView.methods."))]];
    },
    run: async ({ page, requests }) => {
      await expect(heading(page, "Check your email")).toBeVisible();
      await page.getByRole("button", { name: /^Change where the code goes/ }).click();
      await expect(heading(page, "Send the code somewhere else")).toBeVisible();
      await page.getByRole("textbox", { name: "Email" }).fill("rv@gmail.test");
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByText(/only accepts email addresses at university\.test/).first()).toBeVisible();
      await expect(heading(page, "Send the code somewhere else")).toBeVisible();
      const reads = () => requests.filter(request => request.method === "GET" && request.path.startsWith("/v1/flows/")).length;
      // The server refused before touching the flow: nothing to read again.
      expect(reads()).toBe(1);
      // A refusal after which the flow is read again (its methods changed) keeps the field and its error too.
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByText(/does not offer it any more/).first()).toBeVisible();
      await expect.poll(reads).toBe(2);
      await expect(heading(page, "Send the code somewhere else")).toBeVisible();
      await expect(page.getByText("FlowView")).toHaveCount(0);
    },
  },
  {
    name: "methods: a new failure is shown instead of the error the flow came back with",
    path: flowPath("briefcase", "provider_cancelled"),
    routes: [["POST /v1/flows/:id/oauth/:provider", () => error(503, "provider_not_configured", "Sign in with Apple isn't available: this Silicon Accounts has no managed Apple setup (ACCOUNTS_APPLE_SERVICES_ID, _TEAM_ID, _KEY_ID and _PRIVATE_KEY are not all set).", "Use another sign-in method. The app can also bring its own Apple setup (apple.mode = byo).")]],
    run: async ({ page }) => {
      const alert = page.locator("[data-error-code]");
      await expect(alert).toHaveAttribute("data-error-code", "provider_cancelled");
      await page.getByRole("button", { name: "Continue with Apple" }).click();
      await expect(alert).toHaveAttribute("data-error-code", "provider_not_configured");
      await expect(alert).toContainText("Apple is not available here");
      await expect(alert).not.toContainText("ACCOUNTS_");
      await expect(alert).not.toContainText("apple.mode");
      await expect(page.getByText("Sign-in was cancelled")).toHaveCount(0);
      // Other ways to sign in still work: the Apple button is usable again.
      await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeEnabled();
    },
  },
  {
    name: "consent: signed out in another tab, the page says so in plain words and offers to sign in again",
    path: flowPath("briefcase", "consent"),
    routes: [["POST /v1/flows/:id/consent", ({ params }) => error(401, "session_required", `This browser is no longer signed in (it signed out, or the session expired), so sign-in flow '${params.id}' can't continue for its account.`, `Call POST /v1/flows/${params.id}/switch and sign in again.`)]],
    run: async ({ page, requests }) => {
      await page.getByRole("button", { name: "Share and continue" }).click();
      const alert = page.locator('[data-error-code="session_required"]');
      await expect(alert).toContainText("You were signed out");
      await expect(alert).not.toContainText("/v1/");
      await expect(alert).not.toContainText("flow '");
      await expect(page.getByRole("button", { name: "Share and continue" })).toBeDisabled();
      await alert.getByRole("button", { name: "Sign in again" }).click();
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      expect(requests.some(request => request.method === "POST" && request.path.endsWith("/switch"))).toBe(true);
    },
  },
  {
    name: "requirements: signed out in another tab, the step offers to sign in again instead of blaming the number",
    path: flowPath("dm", "requirements"),
    routes: [["POST /v1/flows/:id/requirements/:kind", ({ params }) => error(401, "session_required", `This browser is no longer signed in (it signed out, or the session expired), so sign-in flow '${params.id}' can't continue for its account.`, `Call POST /v1/flows/${params.id}/switch and sign in again.`)]],
    run: async ({ page }) => {
      await expect(heading(page, "Add your phone number")).toBeVisible();
      await page.getByRole("textbox", { name: "Phone number" }).click();
      await page.keyboard.type("9876543210");
      await page.getByRole("button", { name: "Send code" }).click();
      const alert = page.locator('[data-error-code="session_required"]');
      await expect(alert).toContainText("You were signed out");
      await expect(page.getByText(/\/v1\//)).toHaveCount(0);
      await alert.getByRole("button", { name: "Sign in again" }).click();
      await expect(heading(page, "Sign in to DM")).toBeVisible();
    },
  },
  {
    name: "consent: asking again for nothing new is not 'a little more'",
    path: flowPath("briefcase", "consent"),
    routes: [routeFlow(() => {
      const base = sampleFlow(appOf("briefcase"), "consent");
      return {
        ...base,
        consent: {
          required: (base.consent?.required ?? []).filter(row => row.scope === "profile" || row.scope === "email"),
          optional: [{ scope: "timezone", label: "Timezone", value: "Asia/Kolkata", granted: true }],
          previously_granted: ["profile", "email", "timezone"],
        },
        prompt: "consent",
      };
    })],
    run: async ({ page }) => {
      await expect(heading(page, "Share your details with Briefcase")).toBeVisible();
      await expect(page.getByText("would like a little more")).toHaveCount(0);
      await expect(page.getByText("New", { exact: true })).toHaveCount(0);
    },
  },
  {
    name: "consent: asking for something new says so and marks it",
    path: flowPath("briefcase", "consent_more"),
    run: async ({ page }) => {
      await expect(heading(page, "Briefcase would like a little more")).toBeVisible();
      await expect(page.getByText("New", { exact: true }).first()).toBeVisible();
    },
  },
  {
    name: "phone: a pasted number whose country the list lacks is sent exactly as typed",
    path: flowPath("dm", "choose_method"),
    run: async ({ page }) => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      const field = page.getByRole("textbox", { name: "Phone number" });
      await paste(field, "+40 755 345 678");
      await expect(page.locator('[data-phone-mode="international"]')).toBeVisible();
      await expect(field).toHaveValue("+40 755 345 678");
      await expect(page.getByText(/Romania \(\+40\)/).first()).toBeVisible();
      const sent = nextPost(page, "/phone");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      expect(await sent).toEqual({ phone: "+40755345678" });
      await expect(heading(page, "Check your phone")).toBeVisible();
    },
  },
  {
    name: "phone: autofill and '+7' typed into the country search switch to the number with its code",
    path: flowPath("dm", "choose_method"),
    run: async ({ page }) => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      const field = page.getByRole("textbox", { name: "Phone number" });
      // Autofill: the whole number arrives in one input event.
      await field.evaluate(el => {
        (el as HTMLInputElement).value = "+36 20 123 4567";
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
      });
      await expect(page.locator('[data-phone-mode="international"]')).toBeVisible();
      await expect(field).toHaveValue("+36 20 123 4567");
      await expect(page.getByText(/Hungary \(\+36\)/).first()).toBeVisible();
      await page.getByRole("button", { name: "Choose the country from the list" }).click();
      await expect(page.locator('[data-phone-mode="picker"]')).toBeVisible();
      // "+" opens the country search; "7" matches none of its countries, so the field takes it as a number instead.
      await field.click();
      await page.keyboard.type("+");
      await expect(page.getByRole("combobox", { name: "Search countries or calling codes" })).toBeFocused();
      await page.keyboard.type("7");
      await expect(page.locator('[data-phone-mode="international"]')).toBeVisible();
      await expect(field).toBeFocused();
      await page.keyboard.type("9123456789");
      await expect(field).toHaveValue("+79123456789");
      const sent = nextPost(page, "/phone");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      expect(await sent).toEqual({ phone: "+79123456789" });
    },
  },
  {
    name: "phone: numbers the list knows stay in it, and extra digits are never cut off",
    path: flowPath("dm", "choose_method"),
    run: async ({ page }) => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      const field = page.getByRole("textbox", { name: "Phone number" });
      await paste(field, "+44 7400 123456");
      await expect(page.locator('[data-phone-mode="picker"]')).toBeVisible();
      let sent = nextPost(page, "/phone");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      expect(await sent).toEqual({ phone: "+447400123456", country: "GB" });
      await expect(heading(page, "Check your phone")).toBeVisible();
      // One digit too many for the United Kingdom: the picker would drop it (another person's number), so it is sent
      // as typed for the server to judge.
      await page.getByRole("button", { name: /^Change where the code goes/ }).click();
      await expect(heading(page, "Send the code somewhere else")).toBeVisible();
      await field.fill("");
      await paste(field, "+44 7400 1234567");
      await expect(page.locator('[data-phone-mode="international"]')).toBeVisible();
      sent = nextPost(page, "/phone");
      await page.getByRole("button", { name: "Send code" }).click();
      expect(await sent).toEqual({ phone: "+4474001234567" });
    },
  },
  {
    name: "phone: a visitor in Romania starts with +40, and the requirements step takes any country",
    path: flowPath("dm", "requirements"),
    timezone: "Europe/Bucharest",
    run: async ({ page }) => {
      await expect(heading(page, "Add your phone number")).toBeVisible();
      const field = page.getByRole("textbox", { name: "Phone number" });
      await expect(page.locator('[data-phone-mode="international"]')).toBeVisible();
      await expect(field).toHaveValue("+40 ");
      await field.click();
      await page.keyboard.press("End");
      await page.keyboard.type("755 345 678");
      const sent = nextPost(page, "/requirements/phone");
      await page.getByRole("button", { name: "Send code" }).click();
      expect(await sent).toEqual({ phone: "+40755345678" });
    },
  },
  {
    name: "phone: a number with no country code, or an unknown one, is stopped with the reason",
    path: flowPath("dm", "choose_method"),
    run: async ({ page, requests }) => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      await page.getByRole("button", { name: "Country not in the list?" }).click();
      const field = page.getByRole("textbox", { name: "Phone number" });
      await expect(field).toBeFocused();
      await field.fill("+999 1234 5678");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByText(/No country's calling code starts with \+999/).first()).toBeVisible();
      await field.fill("0755 345 678");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByText(/Start the number with \+ and its country code/).first()).toBeVisible();
      expect(requests.some(request => request.method === "POST" && request.path.endsWith("/phone"))).toBe(false);
    },
  },
  {
    name: "sign-up: 'Not you?' ends the waiting sign-up in a browser where nobody is signed in",
    path: flowPath("briefcase", "signup"),
    run: async ({ page, requests }) => {
      await expect(heading(page, "Set up your account")).toBeVisible();
      await page.getByRole("button", { name: "Not you? Use another account" }).click();
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      const posts = requests.filter(request => request.method === "POST").map(request => request.path);
      expect(posts).toEqual(["/v1/session/signout", "/v1/flows/briefcase~signup/switch"]);
    },
  },
  {
    name: "sign-up: 'Not you?' never signs out a browser that is signed in",
    path: flowPath("briefcase", "signup"),
    as: "carbon",
    run: async ({ page, requests }) => {
      await page.getByRole("button", { name: "Not you? Use another account" }).click();
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      expect(requests.filter(request => request.method === "POST").map(request => request.path)).toEqual(["/v1/flows/briefcase~signup/switch"]);
    },
  },
  {
    name: "verify: an expired code says so and offers a new one",
    path: flowPath("briefcase", "verify_code"),
    routes: [
      routeFlow(() => sampleFlow(appOf("briefcase"), "verify_code", { challenge: { channel: "email", destination: "s***@gmail.com", expires_at: isoIn(-1), resend_available_at: isoIn(-2) } })),
      ["POST /v1/flows/:id/resend", () => flowJson(sampleFlow(appOf("briefcase"), "verify_code"))],
    ],
    run: async ({ page }) => {
      await expect(page.getByText(/This code expired, so send a new one below/)).toBeVisible();
      await expect(page.getByText("This code expired. Send a new one.").first()).toBeVisible();
      await expect(page.getByText(/more minute/)).toHaveCount(0);
      await page.getByRole("button", { name: "Send a new code" }).click();
      await expect(page.getByText(/It works for 10 minutes/)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Resend code/ })).toBeVisible();
    },
  },
  {
    name: "verify: at 320 px the six code cells fit inside the card",
    path: flowPath("briefcase", "verify_code"),
    width: 320,
    run: async ({ page }) => {
      await expect(page.getByRole("group", { name: "Code from the email" })).toBeVisible();
      const fit = await page.evaluate(() => {
        const panel = document.querySelector("main");
        if (!panel) return null;
        const style = getComputedStyle(panel);
        const inner = panel.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
        const cells = Array.from(document.querySelectorAll<HTMLInputElement>('main [role="group"] input')).map(cell => cell.getBoundingClientRect().right);
        return { inner, last: Math.max(...cells), count: cells.length, scroll: document.documentElement.scrollWidth };
      });
      expect(fit?.count).toBe(6);
      expect(fit?.last ?? Infinity).toBeLessThanOrEqual((fit?.inner ?? 0) + 0.5);
      expect(fit?.scroll ?? Infinity).toBeLessThanOrEqual(320);
    },
  },
  {
    name: "flow: in dark mode the default palette fills buttons with the brand blue; an app's own palette is kept",
    path: flowPath("briefcase", "choose_method"),
    dark: true,
    run: async ({ page, base }) => {
      const primaryOf = (locator: Locator) => locator.evaluate(el => ({ fill: getComputedStyle(el).getPropertyValue("--primary").trim().toUpperCase(), text: getComputedStyle(el).color }));
      const own = await primaryOf(page.getByRole("button", { name: "Continue", exact: true }));
      expect(own.fill).toBe("#1F5FB8");
      expect(contrast(own.text, "rgb(31, 95, 184)")).toBeGreaterThanOrEqual(4.5);
      await page.goto(`${base}${flowPath("acme-notes", "choose_method")}`);
      const acme = await primaryOf(page.getByRole("button", { name: "Continue", exact: true }));
      expect(acme.fill).toBe((appOf("acme-notes").branding.dark.primary ?? "").toUpperCase());
    },
  },
  {
    name: "problems: a link with an unregistered return address explains itself plainly, never redirects, and keeps the exact reason for developers",
    path: "/authorize?app_id=briefcase&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&state=abc",
    run: async ({ page, base }) => {
      await expect(heading(page, "This sign-in link is not set up right")).toBeVisible();
      const problem = page.locator("[data-problem]");
      await expect(problem).toHaveAttribute("data-problem", "redirect_uri_not_registered");
      await expect(problem.locator("p").filter({ hasText: "PATCH" })).toHaveCount(0);
      const details = page.getByRole("definition").filter({ hasText: "PATCH /v1/apps/briefcase/signin-config" });
      await expect(details).toHaveCount(1);
      await page.waitForTimeout(500);
      expect(page.url().startsWith(base)).toBe(true);
    },
  },
  {
    name: "sign-in: a return_to that only looks like a path falls back to the home page",
    path: "/sign-in?return_to=%2F%09%2Fevil.example%2Fx",
    run: async ({ page, base, requests }) => {
      const storedReturn = async () => {
        await expect(page).toHaveURL(/\/authorize\/flow\//);
        const created = requests.filter(request => request.method === "POST" && request.path === "/v1/flows").at(-1);
        const state = String((created?.body as Record<string, unknown> | null)?.state ?? "");
        expect(state).not.toBe("");
        return page.evaluate(key => sessionStorage.getItem(key), `silicon-accounts:return:${state}`);
      };
      expect(await storedReturn()).toBe("/");
      await page.goto(`${base}/sign-in?return_to=${encodeURIComponent("/device?code=WDJB-MJHT")}`);
      expect(await storedReturn()).toBe("/device?code=WDJB-MJHT");
    },
  },
];

let sdkBundle: Promise<string> | undefined;
/** sdk/v1.ts built the way `pnpm build` ships it (one IIFE), for a plain script tag. */
function sdkCode(): Promise<string> {
  sdkBundle ??= (async () => {
    const outDir = await mkdtemp(join(tmpdir(), "accounts-sdk-checks-"));
    try {
      await build({
        configFile: false,
        root: webRoot(),
        logLevel: "error",
        publicDir: false,
        define: { __ACCOUNTS_WEB_VERSION__: JSON.stringify("checks") },
        build: { outDir, emptyOutDir: true, target: "es2019", minify: true, copyPublicDir: false, lib: { entry: resolve(webRoot(), "sdk/v1.ts"), formats: ["iife"], name: "SiliconAccountsSdk", fileName: () => "v1.js" } },
      });
      return await readFile(join(outDir, "v1.js"), "utf8");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  })();
  return sdkBundle;
}

async function serveSdk(page: Page, base: string): Promise<void> {
  const code = await sdkCode();
  await page.route(`${base}/sdk/v1.js`, route => route.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: code }));
}

const sdkTag = (base: string, appOrigin: string, attributes = "") =>
  `<div id="sa" style="width:360px"></div><script src="${base}/sdk/v1.js" data-app-id="briefcase" data-redirect-uri="${appOrigin}/callback" data-target="#sa" ${attributes}></script>`;

const embedChecks: MockCheck[] = [
  {
    name: "sdk: on a light page with a dark device the buttons follow the page, and 'Powered by' reads",
    dark: true,
    run: async ({ page, base, appOrigin, host }) => {
      await serveSdk(page, base);
      await page.goto(host("/__checks/sdk-light", doc(sdkTag(base, appOrigin))));
      await expect(page.locator("#sa").getByRole("button", { name: "Continue with email" })).toBeVisible();
      const look = await sdkLook(page);
      expect(look?.theme).toBe("light");
      expect(rgba(look?.pillBg ?? "")[3]).toBe(1);
      expect(contrast(look?.pillText ?? "", look?.pillBg ?? "")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(look?.pillLink ?? "", look?.pillBg ?? "")).toBeGreaterThanOrEqual(4.5);
      // Safari and Firefox draw the squircles from a path (Chromium natively).
      await expect.poll(async () => {
        const now = await sdkLook(page);
        return now?.native || (now?.shaped ?? 0) === (now?.buttons ?? -1);
      }).toBe(true);
    },
  },
  {
    name: "sdk: a dark page goes dark; a dark-branded app keeps an opaque dark pill on a light page; dark buttons use the brand blue",
    run: async ({ page, base, appOrigin, host }) => {
      await serveSdk(page, base);
      await page.goto(host("/__checks/sdk-dark", doc(sdkTag(base, appOrigin), "margin:0;padding:24px;background:#141414")));
      await expect(page.locator("#sa").getByRole("button", { name: "Continue with email" })).toBeVisible();
      let look = await sdkLook(page);
      expect(look?.theme).toBe("dark");
      expect(look?.primaryFill).toBe("#1F5FB8");
      expect(contrast(look?.pillText ?? "", look?.pillBg ?? "")).toBeGreaterThanOrEqual(4.5);
      await page.goto(host("/__checks/sdk-acme", doc(`<div id="sa" style="width:360px"></div><script src="${base}/sdk/v1.js" data-app-id="acme-notes" data-redirect-uri="${appOrigin}/callback" data-target="#sa"></script>`)));
      await expect(page.locator("#sa").getByRole("button", { name: "Continue with email" })).toBeVisible();
      look = await sdkLook(page);
      expect(look?.theme).toBe("dark");
      expect(rgba(look?.pillBg ?? "")).toEqual([42, 41, 39, 1]);
      expect(contrast(look?.pillLink ?? "", look?.pillBg ?? "")).toBeGreaterThanOrEqual(4.5);
    },
  },
  {
    name: "sdk: a page that switches to dark (a class on <html>) takes the buttons with it",
    run: async ({ page, base, appOrigin, host }) => {
      await serveSdk(page, base);
      await page.goto(host("/__checks/sdk-toggle", `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html.dark body{background:#101010}body{margin:0;padding:24px;background:#fff}</style></head><body>${sdkTag(base, appOrigin)}</body></html>`));
      await expect(page.locator("#sa").getByRole("button", { name: "Continue with email" })).toBeVisible();
      expect((await sdkLook(page))?.theme).toBe("light");
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await expect.poll(async () => (await sdkLook(page))?.theme).toBe("dark");
    },
  },
  {
    name: "embed: no backdrop of its own on a light page with a dark device; theme=dark matches a dark page",
    dark: true,
    run: async ({ page, base, host }) => {
      const query = new URLSearchParams({ app_id: "briefcase", redirect_uri: "http://127.0.0.1:8593/briefcase/callback", state: "st-embed" });
      const frameTag = (extra: string) => `<iframe id="embed" title="Sign in" src="${base}/embed/buttons.html?${query}${extra}" style="display:block;width:360px;height:340px;border:0"></iframe>`;
      await page.goto(host("/__checks/embed-light", doc(frameTag(""))));
      const frame = page.frameLocator("#embed");
      const links = frame.locator("a[data-method]");
      await expect(links.first()).toBeVisible();
      // No dark scheme of its own (the site's tokens say "light", which a page without a scheme also uses).
      expect(await frame.locator("html").evaluate(el => getComputedStyle(el).colorScheme)).not.toMatch(/dark/);
      const gapBetween = async () => {
        const first = await links.nth(0).boundingBox();
        const second = await links.nth(1).boundingBox();
        if (!first || !second) throw new Error("embed buttons are not laid out");
        return pixel(page, first.x + first.width / 2, (first.y + first.height + second.y) / 2);
      };
      // Between two buttons the app's white page shows through: the frame paints nothing of its own.
      expect(Math.min(...(await gapBetween()))).toBeGreaterThanOrEqual(245);
      // A page that declares no scheme is a light page: light buttons, whatever the device prefers.
      expect(await frame.locator("#silicon-accounts-embed").getAttribute("data-theme")).toBe("light");
      const pill = await frame.locator("[data-powered-by]").evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color, link: getComputedStyle(el.querySelector("a") as Element).color }));
      expect(rgba(pill.bg)[3]).toBe(1);
      expect(contrast(pill.text, pill.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pill.link, pill.bg)).toBeGreaterThanOrEqual(4.5);
      // A dark page that says so: the frame declares dark too, and the page's own dark shows between the buttons.
      await page.goto(host("/__checks/embed-dark", doc(frameTag("&theme=dark"), "margin:0;padding:24px;background:#141414")));
      await expect(links.first()).toBeVisible();
      expect(await frame.locator("html").evaluate(el => getComputedStyle(el).colorScheme)).toBe("dark");
      expect(Math.max(...(await gapBetween()))).toBeLessThanOrEqual(40);
      expect(await frame.locator("#silicon-accounts-embed").getAttribute("data-theme")).toBe("dark");
      // theme=auto: a page that follows the device (here dark).
      await page.goto(host("/__checks/embed-auto", doc(frameTag("&theme=auto"), "margin:0;padding:24px;background:#141414")));
      await expect(links.first()).toBeVisible();
      expect(await frame.locator("#silicon-accounts-embed").getAttribute("data-theme")).toBe("dark");
      expect(await frame.locator("html").evaluate(el => getComputedStyle(el).colorScheme)).toMatch(/light dark|dark/);
    },
  },
];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Live checks (a running accounts-api)                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

interface LiveEnv {
  base: string;
  /** The fake apps' origin, as their redirect URIs are registered (answered here by the browser, no server needed). */
  appOrigin: string;
  browser: Browser;
  open: (options?: { width?: number; timezone?: string }) => Promise<{ context: BrowserContext; page: Page }>;
  /** The newest code sent to `to` after `after` (ms since epoch), from the dev outbox. */
  code: (to: string, after: number) => Promise<string>;
  oidc: (path: string, body: unknown) => Promise<void>;
  patchConfig: (appId: string, patch: unknown) => Promise<void>;
  secret: (appId: string) => string;
  authorize: (appId: string, extra?: Record<string, string>) => string;
  /** Runs SQL on the stack's database (LIVE_PSQL), or null when not configured. */
  sql: ((statement: string) => void) | null;
}

interface LiveCheck {
  name: string;
  run: (env: LiveEnv) => Promise<void>;
}

const rand = () => Math.random().toString(36).slice(2, 8);
const digits = (count: number) => Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join("");
const flowIdOf = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");

/** A tiny valid PNG (8x8, brand blue), for the photo upload. */
function png(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rows.set([31, 95, 184], y * 25 + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

async function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createHttpServer(handler);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The Carbon the first check signs up; later checks continue as them in the same browser. */
let carbon: { context: BrowserContext; page: Page; email: string; name: string } | null = null;
const needCarbon = () => {
  if (!carbon) throw new Error("needs the first live check (a new Carbon) to have passed");
  return carbon;
};

/** Email → code → sign-up with defaults → the next step, in a fresh browser. */
async function signUpByEmail(env: LiveEnv, page: Page, appId: string, name = "Live Tester"): Promise<string> {
  const email = `webauth+${rand()}@example.test`;
  await page.goto(env.authorize(appId));
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  const sentAt = Date.now() - 2000;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(heading(page, "Check your email")).toBeVisible();
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
  await page.keyboard.type(await env.code(email, sentAt));
  await expect(heading(page, "Set up your account")).toBeVisible();
  await page.getByRole("textbox", { name: "Display name" }).fill(name);
  await page.getByRole("button", { name: "Create account" }).click();
  return email;
}

const liveChecks: LiveCheck[] = [
  {
    name: "new Carbon: email, a wrong code, the code, sign-up (taken id, a free one, a photo), consent, back to the app",
    run: async env => {
      const { context, page } = await env.open();
      const email = `webauth+${rand()}@example.test`;
      await page.goto(env.authorize("briefcase", { state: "st-live-1", scope: "email" }));
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      await expect(page).toHaveURL(/\/authorize\/flow\//);
      await expect(page.locator("[data-powered-by] a")).toHaveAttribute("href", "https://account.teamofsilicons.com");
      const sentAt = Date.now() - 2000;
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(heading(page, "Check your email")).toBeVisible();
      const code = await env.code(email, sentAt);
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(code === "000000" ? "111111" : "000000");
      await expect(page.getByText(/That code is wrong; 9 more tries/).first()).toBeVisible();
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(code);
      await expect(heading(page, "Set up your account")).toBeVisible();
      const idField = page.getByRole("textbox", { name: "Your id" });
      await expect(idField).toHaveValue(/^webauth/);
      await expect(page.getByText(/is available\./).first()).toBeVisible();
      await idField.fill("saket");
      await expect(page.getByText(/c:saket is taken/).first()).toBeVisible();
      const chip = page.getByRole("group", { name: "Free ids" }).getByRole("button").first();
      await expect(chip).toBeVisible();
      const chosen = (await chip.textContent())?.trim() ?? "";
      await chip.click();
      await expect(idField).toHaveValue(chosen.replace(/^c:/, ""));
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: /Upload photo/ }).click();
      await (await chooser).setFiles({ name: "me.png", mimeType: "image/png", buffer: png() });
      await expect(page.getByText("me.png uploads when you continue.").first()).toBeVisible();
      await page.getByRole("textbox", { name: "Display name" }).fill("Web Auth Tester");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(heading(page, "Share your details with Briefcase")).toBeVisible({ timeout: 10_000 });
      const me = (await page.evaluate(async () => (await fetch("/v1/me", { credentials: "include" })).json())) as { pfp_url: string; id: string; display_name: string };
      expect(me.pfp_url).toContain("/v1/photos/");
      expect(me.id).toBe(chosen);
      expect(me.display_name).toBe("Web Auth Tester");
      const tz = page.getByRole("switch", { name: "Timezone" });
      if ((await tz.getAttribute("aria-checked")) === "true") await tz.click();
      await page.getByRole("button", { name: "Share and continue" }).click();
      await expect(heading(page, "Signed in to Briefcase")).toBeVisible();
      await page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      const back = new URL(page.url());
      expect(back.searchParams.get("code")).toMatch(/^sac_/);
      expect(back.searchParams.get("state")).toBe("st-live-1");
      carbon = { context, page, email, name: "Web" };
    },
  },
  {
    name: "continue as + requirements (dm needs a phone; a Romanian number) + consent",
    run: async env => {
      const { page } = needCarbon();
      await page.goto(env.authorize("dm", { state: "st-live-2" }));
      await page.getByRole("button", { name: "Continue as Web" }).click();
      await expect(heading(page, "Add your phone number")).toBeVisible();
      // This browser is in India; a number from a country the picker does not list still goes through as typed.
      const phone = `+4075${digits(7)}`;
      await paste(page.getByRole("textbox", { name: "Phone number" }), `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`);
      await expect(page.locator('[data-phone-mode="international"]')).toBeVisible();
      const sentAt = Date.now() - 2000;
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByRole("textbox", { name: /digit 1 of 6/ })).toBeVisible();
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(await env.code(phone, sentAt));
      await expect(heading(page, "Share your details with DM")).toBeVisible();
      await page.getByRole("button", { name: "Share and continue" }).click();
      await page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      expect(new URL(page.url()).searchParams.get("state")).toBe("st-live-2");
      const me = (await (await needCarbon().context.request.get(`${env.base}/v1/me`)).json()) as { phones: Array<{ phone: string }> };
      expect(me.phones.map(entry => entry.phone)).toContain(phone);
    },
  },
  {
    name: "consent: Cancel sends access_denied back",
    run: async env => {
      const { page } = needCarbon();
      await page.goto(env.authorize("remind", { state: "st-live-3" }));
      await page.getByRole("button", { name: "Continue as Web" }).click();
      await expect(heading(page, "Share your details with Remind")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(heading(page, "Nothing was shared")).toBeVisible();
      await page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      expect(new URL(page.url()).searchParams.get("error")).toBe("access_denied");
    },
  },
  {
    name: "consent: prompt=consent for nothing new is not 'a little more'",
    run: async env => {
      const { page } = needCarbon();
      // Browser asks for the timezone only (optional, on by default): share it once, then ask again with prompt=consent.
      await page.goto(env.authorize("browser", { state: "st-live-4", scope: "timezone" }));
      await page.getByRole("button", { name: "Continue as Web" }).click();
      await expect(heading(page, "Share your details with Browser")).toBeVisible();
      await page.getByRole("button", { name: "Share and continue" }).click();
      await page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      await page.goto(env.authorize("browser", { state: "st-live-5", scope: "timezone", prompt: "consent" }));
      await page.getByRole("button", { name: "Continue as Web" }).click();
      await expect(heading(page, "Share your details with Browser")).toBeVisible();
      await expect(page.getByText("would like a little more")).toHaveCount(0);
      await expect(page.getByText("New", { exact: true })).toHaveCount(0);
    },
  },
  {
    name: "use another account (switch) forgets the browser's account for the flow",
    run: async env => {
      const { page } = needCarbon();
      await page.goto(env.authorize("briefcase", { state: "st-live-6" }));
      await page.getByRole("button", { name: "Use another account" }).click();
      await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Continue as/ })).toHaveCount(0);
    },
  },
  {
    name: "prompt=none: signed in finishes silently; signed out returns login_required",
    run: async env => {
      const { page } = needCarbon();
      await page.goto(env.authorize("briefcase", { state: "st-none", prompt: "none" }));
      await page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      expect(new URL(page.url()).searchParams.get("code")).toMatch(/^sac_/);
      const fresh = await env.open();
      await fresh.page.goto(env.authorize("briefcase", { state: "st-none2", prompt: "none" }));
      await fresh.page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      expect(new URL(fresh.page.url()).searchParams.get("error")).toBe("login_required");
      await fresh.context.close();
    },
  },
  {
    name: "consent after signing out in another tab: plain words and a way to sign in again",
    run: async env => {
      const { context, page } = await env.open();
      await signUpByEmail(env, page, "briefcase");
      await expect(heading(page, "Share your details with Briefcase")).toBeVisible({ timeout: 10_000 });
      // Another tab signs out.
      const status = await page.evaluate(async () => (await fetch("/v1/session/signout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "include" })).status);
      expect(status).toBe(204);
      await page.getByRole("button", { name: "Share and continue" }).click();
      const alert = page.locator('[data-error-code="session_required"]');
      await expect(alert).toContainText("You were signed out");
      await expect(alert).not.toContainText("/v1/");
      await alert.getByRole("button", { name: "Sign in again" }).click();
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
      await context.close();
    },
  },
  {
    name: "sign-up: 'Not you?' ends it, so the next sign-in to any app opens on the methods",
    run: async env => {
      const { context, page } = await env.open();
      const email = `notyou+${rand()}@example.test`;
      await page.goto(env.authorize("briefcase"));
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      const sentAt = Date.now() - 2000;
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(await env.code(email, sentAt));
      await expect(heading(page, "Set up your account")).toBeVisible();
      await page.getByRole("button", { name: "Not you? Use another account" }).click();
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      await page.goto(env.authorize("commit"));
      await expect(heading(page, "Sign in to Commit")).toBeVisible();
      await expect(page.getByText(email)).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("");
      await context.close();
    },
  },
  {
    name: "change: an address the app refuses stays under the field (campus-connect)",
    run: async env => {
      const { context, page } = await env.open();
      const email = `student+${rand()}@university.test`;
      await page.goto(env.authorize("campus-connect"));
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(heading(page, "Check your email")).toBeVisible();
      await page.getByRole("button", { name: /^Change where the code goes/ }).click();
      await page.getByRole("textbox", { name: "Email" }).fill(`rv+${rand()}@gmail.test`);
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByText(/only accepts email addresses at university\.test/).first()).toBeVisible();
      await expect(heading(page, "Send the code somewhere else")).toBeVisible();
      await context.close();
    },
  },
  {
    name: "unknown app and unregistered redirect never redirect",
    run: async env => {
      const { context, page } = await env.open();
      await page.goto(`${env.base}/authorize?app_id=nope-app&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x`);
      await expect(heading(page, "This app is not on Silicon Accounts")).toBeVisible();
      await page.waitForTimeout(800);
      expect(page.url().startsWith(env.base)).toBe(true);
      await page.goto(`${env.base}/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=x`);
      await expect(heading(page, "This sign-in link is not set up right")).toBeVisible();
      await page.waitForTimeout(800);
      expect(page.url().startsWith(env.base)).toBe(true);
      // A mistake found after the redirect was checked: offered (not forced) a way back to the app.
      await page.goto(env.authorize("briefcase", { scope: "email nonsense" }));
      await expect(page.getByRole("link", { name: "Back to the app" })).toBeVisible();
      expect(page.url().startsWith(env.base)).toBe(true);
      await context.close();
    },
  },
  {
    name: "an expired flow offers to start again with the same parameters",
    run: async env => {
      if (!env.sql) {
        console.log("    (skipped: set LIVE_PSQL to let this check expire a flow in the database)");
        return;
      }
      const { context, page } = await env.open();
      await page.goto(env.authorize("briefcase", { state: "st-exp" }));
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      const id = flowIdOf(page);
      env.sql(`update signin_flows set expires_at = now() - interval '1 minute' where id = '${id.replace(/'/g, "")}'`);
      await page.reload();
      await expect(heading(page, "This sign-in expired")).toBeVisible();
      await page.getByRole("button", { name: "Start again" }).click();
      await expect(heading(page, "Sign in to Briefcase")).toBeVisible();
      expect(flowIdOf(page)).not.toBe(id);
      await context.close();
    },
  },
  {
    name: "device approval: approve, then the terminal gets its token and a reload says the code was used",
    run: async env => {
      const { page } = needCarbon();
      const started = await fetch(`${env.base}/v1/device/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_label: "accounts CLI on live-test" }) });
      const auth = (await started.json()) as { device_code: string; user_code: string };
      await page.goto(`${env.base}/device`);
      await page.getByRole("textbox", { name: "Code from your terminal" }).fill(auth.user_code.replace("-", "").toLowerCase());
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(heading(page, "Approve this sign-in?")).toBeVisible();
      await expect(page.getByText("accounts CLI on live-test").first()).toBeVisible();
      await page.getByRole("button", { name: "Approve sign-in" }).click();
      await expect(heading(page, "Your terminal is signed in")).toBeVisible();
      const token = await fetch(`${env.base}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code, client_id: "accounts" }) });
      expect(((await token.json()) as { access_token?: string }).access_token).toBeTruthy();
      await page.reload();
      await expect(heading(page, "This code was already used")).toBeVisible();
    },
  },
  {
    name: "/device signed out goes through /sign-in and comes back with the code",
    run: async env => {
      const { context, page } = await env.open();
      await page.goto(`${env.base}/device?code=ABCD-EFGH`);
      await expect(heading(page, "Sign in to Silicon Accounts")).toBeVisible();
      await expect(page).toHaveURL(/\/authorize\/flow\//);
      await context.close();
    },
  },
  {
    name: "/sign-in for a signed-in browser: continue as, back to the page asked for",
    run: async env => {
      const { page } = needCarbon();
      await page.goto(`${env.base}/sign-in?return_to=${encodeURIComponent("/apps")}`);
      await page.getByRole("button", { name: /Continue as Web/ }).click();
      await page.waitForURL(url => url.pathname === "/apps", { timeout: 8000 });
      // Let the page it returned to settle, so anything it reports lands with this check (as a note: not ours).
      await page.waitForTimeout(1500);
    },
  },
  {
    name: "google: a new identity signs up with the Google photo",
    run: async env => {
      const { context, page } = await env.open();
      const email = `g${rand()}@gmail.test`;
      await env.oidc("/_identities", { provider: "google", email, email_verified: true, name: "Grace Hopper", given_name: "Grace", family_name: "Hopper", picture: "https://lh3.googleusercontent.com/a/default-user=s96-c" });
      await env.oidc("/_next", { provider: "google", email });
      await page.goto(env.authorize("briefcase"));
      await page.getByRole("button", { name: "Continue with Google" }).click();
      await expect(heading(page, "Set up your account")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Verified by Google").first()).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue("Grace Hopper");
      await page.getByRole("button", { name: "Use Google photo" }).click();
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(heading(page, "Share your details with Briefcase")).toBeVisible({ timeout: 10_000 });
      const me = (await page.evaluate(async () => (await fetch("/v1/me", { credentials: "include" })).json())) as { pfp_url: string };
      expect(me.pfp_url).toBe("https://lh3.googleusercontent.com/a/default-user=s96-c");
      await context.close();
    },
  },
  {
    name: "google: cancelled at Google comes back with the reason, and a new failure replaces it",
    run: async env => {
      const { context, page } = await env.open();
      await env.oidc("/_next", { provider: "google", error: "access_denied" });
      await page.goto(env.authorize("briefcase"));
      await page.getByRole("button", { name: "Continue with Google" }).click();
      await expect(page.locator('[data-error-code="provider_cancelled"]')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      // The next attempt fails before leaving (the network is down): its failure is the one on screen.
      await context.setOffline(true);
      await page.getByRole("button", { name: "Continue with Apple" }).click();
      await expect(page.locator('[data-error-code="network_error"]')).toBeVisible();
      await expect(page.locator('[data-error-code="provider_cancelled"]')).toHaveCount(0);
      await context.setOffline(false);
      await context.close();
    },
  },
  {
    name: "method=google opens Google at once, once",
    run: async env => {
      const { context, page } = await env.open();
      const email = `m${rand()}@gmail.test`;
      await env.oidc("/_identities", { provider: "google", email, email_verified: true, name: "Method Hint" });
      await env.oidc("/_next", { provider: "google", email });
      await page.goto(env.authorize("briefcase", { method: "google" }));
      await expect(heading(page, "Set up your account")).toBeVisible({ timeout: 15_000 });
      await context.close();
    },
  },
  {
    name: "apple (bring your own, form_post): orbit-games signs up a new Carbon",
    run: async env => {
      const { context, page } = await env.open();
      const email = `a${rand()}@privaterelay.appleid.test`;
      await env.oidc("/_identities", { provider: "apple", email, email_verified: true, name: "Ada Apple", given_name: "Ada", family_name: "Apple" });
      await env.oidc("/_next", { provider: "apple", email });
      await page.goto(env.authorize("orbit-games"));
      await page.getByRole("button", { name: "Continue with Apple" }).click();
      await expect(heading(page, "Set up your account")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Verified by Apple").first()).toBeVisible();
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(heading(page, /Share your details with Orbit Games|Signed in to Orbit Games/)).toBeVisible({ timeout: 10_000 });
      await context.close();
    },
  },
  {
    name: "embed in an allowed origin: buttons, resize messages, top-window sign-in; no origins: a clear note",
    run: async env => {
      const query = new URLSearchParams({ app_id: "briefcase", redirect_uri: `${env.appOrigin}/briefcase/callback`, state: "st-frame", theme: "light" });
      const { server, origin } = await listen((request, response) => {
        response.setHeader("content-type", "text/html");
        if ((request.url ?? "").startsWith("/sdk")) {
          response.end(doc(`<div id="mount"></div><script src="${env.base}/sdk/v1.js"></script><script>window.SiliconAccounts.mountFrame("#mount",{appId:"briefcase",redirectUri:"${env.appOrigin}/briefcase/callback",pkce:"S256"}).then(function(m){window.mounted=m.iframe.src})</script>`));
          return;
        }
        response.end(doc(`<script>window.heights=[];addEventListener("message",function(e){if(e.data&&e.data.type==="silicon-accounts:resize")heights.push(e.data.height)})</script><iframe id="embed" title="Sign in" src="${env.base}/embed/v1/buttons?${query}" style="width:360px;border:0"></iframe>`));
      });
      await env.patchConfig("briefcase", { allowed_origins: [env.appOrigin, origin] });
      await env.patchConfig("spacestation", { allowed_origins: [] });
      const { context, page } = await env.open();
      try {
        await page.goto(`${origin}/`);
        const frame = page.frameLocator("#embed");
        await expect(frame.getByRole("link", { name: "Continue with email" })).toBeVisible();
        await expect.poll(() => page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1) ?? 0)).toBeGreaterThan(150);
        await frame.getByRole("link", { name: "Continue with email" }).click();
        await page.waitForURL(url => url.pathname.startsWith("/authorize"), { timeout: 8000 });
        await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
        await page.goto(`${origin}/sdk`);
        await expect.poll(() => page.evaluate(() => (window as unknown as { mounted?: string }).mounted ?? "")).toContain("/embed/v1/buttons?");
        await expect(page.frameLocator("iframe").getByRole("link", { name: "Continue with email" })).toBeVisible();
        const src = await page.evaluate(() => document.querySelector("iframe")?.src ?? "");
        const state = new URL(src).searchParams.get("state") ?? "";
        const stored = await page.evaluate(key => sessionStorage.getItem(key), `silicon-accounts:auth:${state}`);
        expect(JSON.parse(stored ?? "{}").code_verifier).toBeTruthy();
        await page.goto(`${env.base}/embed/v1/buttons?app_id=spacestation&redirect_uri=${encodeURIComponent(`${env.appOrigin}/spacestation/callback`)}`);
        await expect(page.locator('[data-error-code="no_allowed_origins"]')).toBeVisible();
      } finally {
        server.close();
        await context.close();
      }
    },
  },
  {
    name: "sdk end to end: state + PKCE in sessionStorage, handleCallback, the code exchanged with the verifier",
    run: async env => {
      const { server, origin } = await listen((request, response) => {
        response.setHeader("content-type", "text/html");
        if ((request.url ?? "").startsWith("/callback")) {
          response.end(doc(`<pre id="out"></pre><script src="${env.base}/sdk/v1.js"></script><script>try{document.getElementById("out").textContent=JSON.stringify(window.SiliconAccounts.handleCallback())}catch(e){document.getElementById("out").textContent="ERR "+e.code+" "+e.message}</script>`));
          return;
        }
        response.end(doc(`<div id="sa"></div><script src="${env.base}/sdk/v1.js" data-app-id="briefcase" data-redirect-uri="${origin}/callback" data-target="#sa" data-pkce="S256" data-scope="openid email" data-method="email"></script>`));
      });
      await env.patchConfig("briefcase", { redirect_uris: [`${env.appOrigin}/briefcase/callback`, `${origin}/callback`] });
      const { context, page } = await env.open();
      try {
        await page.goto(`${origin}/`);
        await page.locator("#sa").getByRole("button", { name: "Continue with email" }).click();
        const email = carbon?.email ?? `sdk+${rand()}@example.test`;
        await page.getByRole("textbox", { name: "Email" }).fill(email);
        const sentAt = Date.now() - 2000;
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
        await page.keyboard.type(await env.code(email, sentAt));
        const share = page.getByRole("button", { name: "Share and continue" });
        const create = page.getByRole("button", { name: "Create account" });
        const atCallback = () => page.url().startsWith(`${origin}/callback`);
        for (let i = 0; i < 40 && !atCallback() && !(await share.isVisible()) && !(await create.isVisible()); i++) await page.waitForTimeout(250);
        if (!atCallback() && (await create.isVisible())) await create.click();
        if (!atCallback()) {
          await expect(share.or(page.locator("#out"))).toBeVisible({ timeout: 10_000 });
          if (await share.isVisible()) await share.click();
        }
        await page.waitForURL(url => url.origin === origin && url.pathname === "/callback", { timeout: 8000 });
        await expect(page.locator("#out")).not.toBeEmpty();
        const out = (await page.locator("#out").textContent()) ?? "";
        expect(out.startsWith("ERR")).toBe(false);
        const result = JSON.parse(out) as { code: string; codeVerifier: string; nonce: string; redirectUri: string };
        const exchanged = await fetch(`${env.base}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`briefcase:${env.secret("briefcase")}`).toString("base64")}` }, body: new URLSearchParams({ grant_type: "authorization_code", code: result.code, redirect_uri: result.redirectUri, code_verifier: result.codeVerifier }) });
        const body = (await exchanged.json()) as { access_token?: string; id_token?: string };
        expect(body.access_token).toBeTruthy();
        const claims = JSON.parse(Buffer.from(body.id_token?.split(".")[1] ?? "", "base64url").toString()) as { nonce?: string };
        expect(claims.nonce).toBe(result.nonce);
        await page.reload();
        await expect(page.locator("#out")).toContainText("ERR unknown_state");
      } finally {
        server.close();
        await context.close();
      }
    },
  },
  {
    name: "allow_signup=false: a new email is refused and the flow says why",
    run: async env => {
      const { context, page } = await env.open();
      const email = `nobody+${rand()}@example.test`;
      await page.goto(env.authorize("legacy-crm"));
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      const sentAt = Date.now() - 2000;
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(await env.code(email, sentAt));
      await expect(page.getByText("This app does not take new accounts", { exact: true })).toBeVisible({ timeout: 8000 });
      await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
      await context.close();
    },
  },
  {
    name: "send limit: the 11th code in 10 minutes waits with a countdown",
    run: async env => {
      const { context, page } = await env.open();
      const email = `limit+${rand()}@example.test`;
      await page.goto(env.authorize("briefcase"));
      await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
      const id = flowIdOf(page);
      const statuses = await page.evaluate(async ({ id, email }) => {
        const out: number[] = [];
        for (let i = 0; i < 10; i++) out.push((await fetch(`/v1/flows/${id}/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }), credentials: "include" })).status);
        return out;
      }, { id, email });
      expect(statuses.every(code => code === 200)).toBe(true);
      await page.reload();
      await expect(heading(page, "Check your email")).toBeVisible();
      await page.getByRole("button", { name: /^Change where the code goes/ }).click();
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      await page.getByRole("button", { name: "Send code" }).click();
      await expect(page.getByText(/Too many codes were sent to/).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /Try again in \d+:\d\d/ })).toBeVisible();
      await context.close();
    },
  },
  {
    name: "lockout: the tenth wrong code locks entry with a countdown",
    run: async env => {
      const { context, page } = await env.open();
      const email = `lock+${rand()}@example.test`;
      await page.goto(env.authorize("briefcase"));
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      const sentAt = Date.now() - 2000;
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const real = await env.code(email, sentAt);
      const wrong = real === "123456" ? "654321" : "123456";
      const id = flowIdOf(page);
      await page.evaluate(async ({ id, wrong }) => {
        for (let i = 0; i < 9; i++) await fetch(`/v1/flows/${id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: wrong }), credentials: "include" });
      }, { id, wrong });
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(wrong);
      await expect(page.getByText(/Locked\. Try again in 0:[0-5]\d\./).first()).toBeVisible();
      await expect(page.getByRole("textbox", { name: /digit 1 of 6/ })).toBeDisabled();
      await expect(page.getByText(/\d{4}-\d{2}-\d{2}T/)).toHaveCount(0);
      await context.close();
    },
  },
  {
    name: "an imported Carbon finishes setting up: prefill from the import, own id kept",
    run: async env => {
      const auth = `Basic ${Buffer.from(`legacy-crm:${env.secret("legacy-crm")}`).toString("base64")}`;
      const email = `imported+${rand()}@example.test`;
      const handle = `imp-${rand()}`;
      const created = await fetch(`${env.base}/v1/apps/legacy-crm/imports`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ rows: [{ email, display_name: "Ivy Imported", username: handle, timezone: "Europe/London", dob: "1990-04-05", external_id: `crm-${rand()}` }], options: { default_country: "US" } }) });
      const job = (await created.json()) as { job?: { id: string }; id?: string };
      const jobId = job.job?.id ?? job.id;
      expect(jobId).toBeTruthy();
      for (let i = 0; i < 40; i++) {
        const state = (await (await fetch(`${env.base}/v1/apps/legacy-crm/imports/${jobId}`, { headers: { authorization: auth } })).json()) as { job?: { status: string }; status?: string };
        const status = state.job?.status ?? state.status;
        if (status === "completed" || status === "failed") break;
        await new Promise(done => setTimeout(done, 250));
      }
      const { context, page } = await env.open();
      await page.goto(env.authorize("legacy-crm"));
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      const sentAt = Date.now() - 2000;
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type(await env.code(email, sentAt));
      await expect(heading(page, "Finish setting up your account")).toBeVisible({ timeout: 8000 });
      await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue("Ivy Imported");
      await expect(page.getByRole("textbox", { name: "Your id" })).toHaveValue(handle);
      await page.getByRole("button", { name: "Finish setup" }).click();
      await expect(heading(page, "Share your details with Legacy CRM")).toBeVisible({ timeout: 8000 });
      await page.getByRole("button", { name: "Share and continue" }).click();
      await page.waitForURL(url => url.origin === env.appOrigin, { timeout: 8000 });
      const me = (await (await context.request.get(`${env.base}/v1/me`)).json()) as { id: string; status: string };
      expect(me).toMatchObject({ id: `c:${handle}`, status: "active" });
      await context.close();
    },
  },
];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Runner                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

function webRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** With CHECKS_SHOTS=<dir>, a failed check leaves a screenshot of every page it had open there. */
async function shootFailure(name: string, pages: Page[]): Promise<void> {
  const dir = process.env.CHECKS_SHOTS;
  if (!dir) return;
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  await Promise.all(pages.map((page, index) => page.screenshot({ path: join(dir, `${slug}-${index}.png`), fullPage: true }).catch(() => undefined)));
}

/** Console errors that are not failures: requests a check makes fail on purpose (and a signed-out GET /v1/session). */
const expectedConsole = (text: string) => text.startsWith("Failed to load resource");

async function runMockChecks(selected: MockCheck[], engine: "chromium" | "webkit"): Promise<number> {
  const pages = new Map<string, string>();
  const hostPages: Plugin = {
    name: "auth-checks:host-pages",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const body = pages.get((request.url ?? "").split("?")[0] ?? "");
        if (body === undefined) return next();
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(body);
      });
    },
  };
  const server = await createServer({ configFile: resolve(webRoot(), "vite.config.ts"), root: webRoot(), logLevel: "error", plugins: [hostPages], server: { port: 6600 + Math.floor(Math.random() * 300), strictPort: false, host: "127.0.0.1" } });
  await server.listen();
  const base = (server.resolvedUrls?.local[0] ?? "").replace(/\/$/, "");
  const appOrigin = base.replace("127.0.0.1", "localhost");
  const browser = await (engine === "webkit" ? webkit : chromium).launch();
  const { deviceRoutes } = await import("../device/screens");
  let failures = 0;
  try {
    for (const check of selected) {
      const context = await browser.newContext({
        viewport: { width: check.width ?? 1280, height: 900 },
        colorScheme: check.dark ? "dark" : "light",
        locale: "en-US",
        timezoneId: check.timezone ?? "Asia/Kolkata",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const problems: string[] = [];
      const requests: MockRequest[] = [];
      page.on("console", message => {
        if (message.type() === "error" && !expectedConsole(message.text())) problems.push(`console: ${message.text()}`);
      });
      page.on("pageerror", failure => problems.push(`page error: ${failure.message} (at ${page.url()})`));
      const extra = typeof check.routes === "function" ? check.routes() : check.routes ?? [];
      await mockApi(page, { as: check.as ?? "signed-out", routes: [...flowRoutes, ...deviceRoutes, ...extra], onRequest: request => requests.push(request) });
      const started = Date.now();
      try {
        if (check.path) await page.goto(base + check.path, { waitUntil: "networkidle" });
        await check.run({ page, context, base, appOrigin, requests, host: (path, html) => (pages.set(path, html), `${appOrigin}${path}`) });
      } catch (failure) {
        problems.push(`failed: ${failure instanceof Error ? failure.message.split("\n").slice(0, 8).join(" | ") : String(failure)}`);
      }
      if (problems.length) await shootFailure(check.name, [page]);
      await context.close();
      if (problems.length) {
        failures++;
        console.log(`✗ ${check.name}\n${problems.map(problem => `    ${problem}`).join("\n")}`);
      } else console.log(`✓ ${check.name} (${Date.now() - started} ms)`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return failures;
}

async function runLiveChecks(selected: LiveCheck[], base: string, engine: "chromium" | "webkit"): Promise<number> {
  const appOrigin = process.env.LIVE_APP_ORIGIN ?? "http://127.0.0.1:8593";
  const oidcUrl = process.env.LIVE_OIDC_URL ?? "http://127.0.0.1:8591";
  const fakeApps = JSON.parse(readFileSync(resolve(webRoot(), "../testkit/fake-apps.json"), "utf8")) as { apps: Array<{ app_id: string; secret: string }> };
  const secret = (appId: string) => {
    const app = fakeApps.apps.find(entry => entry.app_id === appId);
    if (!app) throw new Error(`${appId} is not in testkit/fake-apps.json`);
    return app.secret;
  };
  const browser = await (engine === "webkit" ? webkit : chromium).launch();
  const problems: string[] = [];
  /** Errors of pages other areas own (the account site a sign-in returns to): reported, but not this suite's failures. */
  const notes: string[] = [];
  const siteOrigin = new URL(base).origin;
  const ours = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.origin !== siteOrigin || /^\/(authorize|sign-in|device|embed|sdk)(\/|$)/.test(parsed.pathname);
    } catch {
      return true;
    }
  };
  const report = (page: Page, text: string) => (ours(page.url()) ? problems : notes).push(`${text} (at ${page.url()})`);
  const contexts = new Set<BrowserContext>();
  const env: LiveEnv = {
    base,
    appOrigin,
    browser,
    open: async (options = {}) => {
      const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 }, locale: "en-US", timezoneId: options.timezone ?? "Asia/Kolkata" });
      contexts.add(context);
      context.on("close", () => contexts.delete(context));
      // A network of its own (honoured with ACCOUNTS_TRUST_FORWARDED_FOR=true), only on requests to Silicon Accounts.
      const network = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
      const origin = new URL(base).origin;
      await context.route(url => url.origin === origin, route => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": network } }));
      // The fake apps' callbacks are answered here: what matters is the address the browser was sent to.
      await context.route(`${appOrigin}/**`, route => route.fulfill({ status: 200, contentType: "text/html", body: doc(`<p id="callback">${route.request().url().replace(/</g, "&lt;")}</p>`) }));
      const page = await context.newPage();
      page.on("console", message => {
        if (message.type() === "error" && !expectedConsole(message.text())) report(page, `console: ${message.text()}`);
      });
      page.on("pageerror", failure => report(page, `page error: ${failure.message}`));
      return { context, page };
    },
    code: async (to, after) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = await fetch(`${base}/v1/dev/outbox?to=${encodeURIComponent(to)}&limit=5`);
        if (!response.ok) throw new Error(`GET /v1/dev/outbox answered ${response.status}: start the API with ACCOUNTS_EXPOSE_DEV_OUTBOX=true.`);
        const body = (await response.json()) as { items: Array<{ code: string | null; created_at: string }> };
        const fresh = body.items.find(item => item.code && Date.parse(item.created_at) > after);
        if (fresh?.code) return fresh.code;
        await new Promise(done => setTimeout(done, 250));
      }
      throw new Error(`no code reached the dev outbox for ${to}`);
    },
    oidc: async (path, body) => {
      const response = await fetch(`${oidcUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`mock-oidc ${path} answered ${response.status}: ${await response.text()}`);
    },
    patchConfig: async (appId, patch) => {
      const response = await fetch(`${base}/v1/apps/${appId}/signin-config`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${appId}:${secret(appId)}`).toString("base64")}` }, body: JSON.stringify(patch) });
      if (!response.ok) throw new Error(`PATCH ${appId} sign-in setup answered ${response.status}: ${await response.text()}`);
    },
    secret,
    authorize: (appId, extra = {}) => `${base}/authorize?${new URLSearchParams({ app_id: appId, redirect_uri: `${appOrigin}/${appId}/callback`, state: `st-${rand()}`, ...extra })}`,
    sql: process.env.LIVE_PSQL ? statement => void execSync(`${process.env.LIVE_PSQL} -q -c ${JSON.stringify(statement)}`, { stdio: "pipe" }) : null,
  };
  let failures = 0;
  try {
    for (const check of selected) {
      const started = Date.now();
      problems.length = 0;
      notes.length = 0;
      try {
        await check.run(env);
      } catch (failure) {
        problems.push(`failed: ${failure instanceof Error ? failure.message.split("\n").slice(0, 8).join(" | ") : String(failure)}`);
      }
      if (problems.length) await shootFailure(check.name, [...contexts].flatMap(context => context.pages()));
      if (problems.length) {
        failures++;
        console.log(`✗ ${check.name}\n${problems.map(problem => `    ${problem}`).join("\n")}`);
      } else console.log(`✓ ${check.name} (${Date.now() - started} ms)`);
      for (const note of notes) console.log(`    note, outside the sign-in pages: ${note}`);
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser.close();
  }
  return failures;
}

async function main(argv: string[]): Promise<void> {
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const engine = value("--engine") === "webkit" ? "webkit" : "chromium";
  const only = (value("--only") ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const live = value("--live")?.replace(/\/$/, "");
  const pick = <T extends { name: string }>(list: T[]) => list.filter(check => !only.length || only.some(name => check.name.includes(name)));
  let failures: number;
  let count: number;
  if (live) {
    const selected = pick(liveChecks);
    count = selected.length;
    console.log(`Live checks against ${live} (${engine})`);
    failures = await runLiveChecks(selected, live, engine);
  } else {
    const { checks: deviceChecks } = await import("../device/screens");
    const selected = pick([...hostedChecks, ...deviceChecks, ...embedChecks]);
    count = selected.length;
    console.log(`Checks with the mock API (${engine})`);
    failures = await runMockChecks(selected, engine);
  }
  if (!count) throw new Error(`No check matches --only ${only.join(",")}.`);
  if (failures) {
    console.error(`\n${failures} of ${count} check(s) failed.`);
    process.exitCode = 1;
  } else console.log(`\nAll ${count} checks passed.`);
}

// Run directly (not when scripts/screens.ts imports the screens above).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch(failure => {
    console.error(`checks: ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exitCode = 1;
  });
}

