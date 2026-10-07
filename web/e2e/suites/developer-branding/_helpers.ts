/**
 * Helpers of the developer-branding suite (a helper file: its name starts with "_", so run.ts never takes it for
 * journeys). Everything here is built on e2e/lib.ts; nothing in it is specific to one journey.
 *
 * - The fake apps as testkit/fake-apps.json describes them (their owners, secrets and seeded setups), and calls made
 *   with an app's own credentials (`asApp`).
 * - Signing an app's owner in on the site (`ownerSignIn`): the owners are the Carbons the seed created for the fake
 *   apps (Silicon Apps is not built yet, so they are the only Carbons who own apps).
 * - Fresh Carbons signed into an app without a browser (`apiSignUp`): the hosted flow's own API, driven by a
 *   Playwright request context that keeps the flow's cookies and sends the site's Origin.
 * - "Powered by Silicon Accounts" as a Carbon sees it (`checkPoweredBy`), and the branding a hosted page paints
 *   (`readHostedLook`).
 * - The fake apps' webhook inboxes and the mock providers' request logs.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { request as playwrightRequest, type APIRequestContext, type BrowserContext, type Frame, type Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { E2E_DIR, api, codeFor, json, lastSeq, newContext, randomIp, shot, signInOnSite, sleep, sql, tag, type ApiInit, type Env, type JsonAnswer } from "../../lib";

export const POWERED_BY_HREF = "https://account.teamofsilicons.com";

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake apps                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FakeApp {
  app_id: string;
  name: string;
  logo_url?: string;
  logo_dark_url?: string;
  owner_id?: string;
  owner_email?: string;
  secret: string;
  webhook_url?: string;
  webhook_secret?: string;
  signin_defaults?: {
    google?: Record<string, unknown>;
    apple?: Record<string, unknown>;
    branding?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

let fakeApps: FakeApp[] | null = null;

/** An app of testkit/fake-apps.json (the file the stack was seeded from). */
export function fakeApp(appId: string): FakeApp {
  fakeApps ??= (JSON.parse(readFileSync(join(resolve(E2E_DIR, "../.."), "testkit/fake-apps.json"), "utf8")) as { apps: FakeApp[] }).apps;
  const app = fakeApps.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`testkit/fake-apps.json has no app "${appId}"`);
  return app;
}

/** `Authorization: Basic` with the app's own id and secret. */
export const appBasic = (appId: string, secret = fakeApp(appId).secret) => `Basic ${Buffer.from(`${appId}:${secret}`).toString("base64")}`;

/** A call made by the app's own server (its credentials), through the site. */
export function asApp<T = unknown>(ctx: Ctx, appId: string, path: string, init: ApiInit = {}): Promise<JsonAnswer<T>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", appBasic(appId));
  return api<T>(ctx, path, { ...init, headers });
}

/** The registered callback of a fake app on this stack. */
export const callbackOf = (env: Env, appId: string) => `${env.apps}/${appId}/callback`;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small things                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** A US number in the 202-555 range (the phone library takes these as valid). */
export const randomPhone = () => `+1202555${String(1000 + Math.floor(Math.random() * 8999))}`;

/** A fresh address for one journey's Carbon. */
export const freshEmail = (label: string) => `dvb.${label}.${tag()}${tag()}@example.test`;

/** "#1F5FB8" → "rgb(31, 95, 184)", as getComputedStyle reports it. */
export function rgb(hex: string): string {
  const value = hex.replace("#", "");
  const n = (index: number) => Number.parseInt(value.slice(index, index + 2), 16);
  return `rgb(${n(0)}, ${n(2)}, ${n(4)})`;
}

/** True when a computed colour ("rgb(…)" or "#RRGGBB", any case and spacing) is the colour `hex`. */
export function sameColour(value: string | null | undefined, hex: string): boolean {
  const text = (value ?? "").replace(/\s+/g, "").toLowerCase();
  return text === hex.toLowerCase() || text === rgb(hex).replace(/\s+/g, "").toLowerCase();
}

/** WCAG 2 contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const v = hex.replace("#", "");
    const channel = (i: number) => {
      const c = Number.parseInt(v.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Polls `probe` until it returns something truthy (or `timeoutMs` passes); returns the last value. */
export async function until<T>(probe: () => Promise<T>, timeoutMs = 20_000, everyMs = 400): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!value && Date.now() < deadline) {
    await sleep(everyMs);
    value = await probe();
  }
  return value;
}

/** Text of an element, whitespace collapsed ("" when it is not there). */
export async function textOf(page: Page, selector: string): Promise<string> {
  return ((await page.locator(selector).first().innerText({ timeout: 2_000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Signing in                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Codes this suite sent to an address in the last 10 minutes are counted against the 10-per-10-minutes limit of that
 * destination. Owners sign in once or twice per journey, so moving their earlier sends out of the window (time travel
 * on rows this suite made) keeps every journey independent of how many ran before it.
 */
export async function forgetCodeSends(env: Env, destination: string): Promise<void> {
  const safe = destination.replace(/'/g, "");
  await sql(env, `update otp_challenges set created_at = created_at - interval '11 minutes' where destination = '${safe}' and created_at > now() - interval '11 minutes'`);
}

export interface SignedIn {
  context: BrowserContext;
  page: Page;
  email: string;
}

export interface SignInOptions {
  width?: number;
  height?: number;
  dark?: boolean;
  /** Console errors the journey provokes on purpose (the 409 of a conflict, a 422 it asks for…). */
  expected?: RegExp[];
}

/**
 * WebKit reports a fetch that a navigation cut short as "… due to access control checks." (lib.ts treats the same
 * report for Next's route prefetches as browser noise). Journeys leave the account home page for the developer pages
 * right after signing in, which can cut short its own reads of /v1/me/… in WebKit; that is noise too, never a product
 * error (Chromium reports nothing for them).
 */
const ABORTED_HOME_READS = /\/v1\/me\/\S* due to access control checks/;

/** Production Iris, where the default profile photos of the seeded owners point (see keepIrisLocal). */
export const PRODUCTION_IRIS = "https://iris.teamofsilicons.com";

/**
 * The seed (scripts/dev.sh runs accounts-seed without ACCOUNTS_IRIS_BASE_URL) gives the fake apps' owners default
 * photos on production Iris, so every page that shows an owner would load its photo from the internet (and production
 * Iris answers headless browsers with a 403 bot challenge, which Chromium blocks as ERR_BLOCKED_BY_ORB). This context
 * gets those photos from the stack's own mock Iris instead (the same drawing for the same id); `seen` collects what
 * the pages asked for, so a journey can report it.
 */
export async function keepIrisLocal(context: BrowserContext, env: Env, seen?: string[]): Promise<void> {
  await context.route(url => url.href.startsWith(`${PRODUCTION_IRIS}/`), async route => {
    const url = new URL(route.request().url());
    seen?.push(url.href);
    try {
      await route.fulfill({ response: await route.fetch({ url: `${env.iris}${url.pathname}${url.search}` }) });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
}

/** The Carbon who owns `appId` (created by the seed), signed in on the site in a browser context of its own. */
export async function ownerSignIn(ctx: Ctx, appId: string, label: string, options: SignInOptions = {}): Promise<SignedIn> {
  const email = fakeApp(appId).owner_email;
  if (!email) throw new Error(`${appId} has no owner_email in testkit/fake-apps.json`);
  await forgetCodeSends(ctx.env, email);
  const context = await newContext(ctx.browser, { width: options.width, height: options.height, dark: options.dark });
  await keepIrisLocal(context, ctx.env);
  const page = await context.newPage();
  ctx.results.watch(page, label, [...(options.expected ?? []), ABORTED_HOME_READS]);
  page.on("dialog", dialog => void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()));
  await signInOnSite(ctx.env, page, email);
  // Let the home page finish its own reads before the journey takes the owner elsewhere.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  return { context, page, email };
}

/** A brand-new Carbon, signed up on the site with a fresh address. */
export async function freshCarbonOnSite(ctx: Ctx, label: string, options: SignInOptions = {}): Promise<SignedIn> {
  const email = freshEmail(label);
  const context = await newContext(ctx.browser, { width: options.width, height: options.height, dark: options.dark });
  const page = await context.newPage();
  ctx.results.watch(page, label, [...(options.expected ?? []), ABORTED_HOME_READS]);
  await signInOnSite(ctx.env, page, email);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  return { context, page, email };
}

/**
 * A request with the browser's session cookie, as the site's own scripts make it (the page's context shares its
 * cookies with page.request): the site's Origin on mutations, one Idempotency-Key per call.
 */
export async function asSession<T = unknown>(page: Page, env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await page.request.fetch(`${env.site}${path}`, {
    method,
    headers: { origin: env.site, accept: "application/json", "idempotency-key": randomUUID(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { data: JSON.stringify(body) } : {}),
    failOnStatusCode: false,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON.
  }
  return { status: response.status(), body: parsed as T };
}

interface FlowView {
  id: string;
  step: string;
  signup?: { display_name: string; id: string; timezone: string; dob: string } | null;
  requirements?: { missing: string[] } | null;
  redirect_to?: string | null;
  error?: { code: string; message: string } | null;
}

export interface ApiSignIn {
  email: string;
  uuid: string;
  id: string;
  displayName: string;
  phone: string | null;
  /** The app's tokens (null for the account site's own sign-in). */
  tokens: { access_token: string; refresh_token: string; id_token?: string } | null;
  /** The "browser" that went through the flow: it keeps the sa_session cookie (signed in on the site). */
  browser: APIRequestContext;
  ip: string;
}

/**
 * Signs a fresh Carbon into `appId` through the hosted flow's API (no page): an email code, the sign-up (prefill
 * accepted unless overridden), the requirements (a phone with its SMS code, an email with its code), consent, then
 * the app's code exchange with its own credentials. `appId: "accounts"` is the account site itself.
 */
export async function apiSignUp(ctx: Ctx, appId: string, options: { email?: string; displayName?: string; handle?: string; optionalScopes?: string[]; phone?: string; scope?: string } = {}): Promise<ApiSignIn> {
  const { env } = ctx;
  const ip = randomIp();
  const browser = await playwrightRequest.newContext({ baseURL: env.site, extraHTTPHeaders: { origin: env.site, "x-forwarded-for": ip, accept: "application/json" } });
  const call = async (path: string, data?: unknown): Promise<FlowView> => {
    const response = await browser.fetch(path, { method: "POST", data: data === undefined ? {} : data, failOnStatusCode: false });
    const body = (await response.json().catch(() => null)) as { flow?: FlowView; error?: unknown } | null;
    if (!response.ok() || !body?.flow) throw new Error(`POST ${path} answered ${response.status()}: ${JSON.stringify(body).slice(0, 300)}`);
    return body.flow;
  };
  const email = options.email ?? freshEmail(appId.replace(/[^a-z]/g, "").slice(0, 6) || "app");
  const redirectUri = appId === "accounts" ? `${env.site}/` : callbackOf(env, appId);
  const pkce = pkcePair();
  const state = base64url(randomBytes(12));
  let flow = await call("/v1/flows", { app_id: appId, redirect_uri: redirectUri, state, code_challenge: pkce.challenge, code_challenge_method: "S256", timezone: "Asia/Kolkata", ...(options.scope ? { scope: options.scope } : {}) });
  let after = await lastSeq(env);
  flow = await call(`/v1/flows/${flow.id}/email`, { email });
  flow = await call(`/v1/flows/${flow.id}/verify`, { code: await codeFor(env, email, after) });
  let phone: string | null = null;
  for (let guard = 0; guard < 8 && flow.step !== "complete"; guard++) {
    if (flow.step === "signup" && flow.signup) {
      flow = await call(`/v1/flows/${flow.id}/signup`, { display_name: options.displayName ?? flow.signup.display_name, id: options.handle ?? flow.signup.id, timezone: flow.signup.timezone, dob: flow.signup.dob });
    } else if (flow.step === "requirements") {
      const missing = flow.requirements?.missing ?? [];
      if (missing.includes("phone")) {
        phone = options.phone ?? randomPhone();
        after = await lastSeq(env);
        await call(`/v1/flows/${flow.id}/requirements/phone`, { phone });
        flow = await call(`/v1/flows/${flow.id}/requirements/verify`, { code: await codeFor(env, phone, after) });
      } else if (missing.includes("email")) {
        const extra = freshEmail("req");
        after = await lastSeq(env);
        await call(`/v1/flows/${flow.id}/requirements/email`, { email: extra });
        flow = await call(`/v1/flows/${flow.id}/requirements/verify`, { code: await codeFor(env, extra, after) });
      } else throw new Error(`flow ${flow.id} requires ${missing.join(", ")}, which this helper cannot fill`);
    } else if (flow.step === "consent") {
      flow = await call(`/v1/flows/${flow.id}/consent`, { approve: true, optional_scopes: options.optionalScopes ?? [] });
    } else throw new Error(`flow ${flow.id} stopped at ${flow.step}: ${JSON.stringify(flow.error)}`);
  }
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`flow ${flow.id} did not complete (${flow.step})`);
  const code = new URL(flow.redirect_to).searchParams.get("code");
  if (!code) throw new Error(`flow ${flow.id} completed without a code: ${flow.redirect_to}`);
  let tokens: ApiSignIn["tokens"] = null;
  let uuid = "";
  let id = "";
  let displayName = options.displayName ?? "";
  if (appId === "accounts") {
    const me = (await (await browser.get("/v1/me")).json()) as { uuid: string; id: string; display_name: string };
    uuid = me.uuid;
    id = me.id;
    displayName = me.display_name;
  } else {
    const response = await json<{ access_token: string; refresh_token: string; id_token?: string; account?: { uuid: string; id: string; display_name: string }; error?: string }>(`${env.site}/v1/oauth/token`, {
      method: "POST",
      headers: { authorization: appBasic(appId), "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: pkce.verifier }).toString(),
    });
    if (response.status !== 200) throw new Error(`the ${appId} code exchange answered ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`);
    tokens = { access_token: response.body.access_token, refresh_token: response.body.refresh_token, id_token: response.body.id_token };
    uuid = response.body.account?.uuid ?? "";
    id = response.body.account?.id ?? "";
    displayName = response.body.account?.display_name ?? displayName;
  }
  return { email, uuid, id, displayName, phone, tokens, browser, ip };
}

/** A POST/PATCH/DELETE with the API sign-in's browser session (sa_session cookie, the site's Origin). */
export async function asApiBrowser<T = unknown>(user: ApiSignIn, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await user.browser.fetch(path, { method, ...(body !== undefined ? { data: body } : {}), headers: { "idempotency-key": randomUUID() }, failOnStatusCode: false });
  return { status: response.status(), body: (await response.json().catch(() => null)) as T };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* "Powered by Silicon Accounts"                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PoweredByFacts {
  count: number;
  insideBranding: boolean;
  text: string;
  linkText: string;
  href: string | null;
  target: string | null;
  rel: string | null;
  hidden: string[];
  opacity: number;
  width: number;
  height: number;
  fontSize: number;
  inViewport: boolean;
  covered: string | null;
  linkColor: string;
  pillColor: string;
}

/**
 * What a Carbon gets of "Powered by Silicon Accounts" in `root` (a page, a frame, or the shadow root under `host`):
 * exactly one, its text and link, every ancestor displayed and visible, the opacity it ends up with, a box with a
 * size, in the viewport once scrolled to, and not covered by anything (the element at its centre is the link).
 */
export async function poweredByFacts(target: Page | Frame, shadowHost?: string): Promise<PoweredByFacts> {
  return target.evaluate(hostSelector => {
    const root: Document | ShadowRoot | null = hostSelector ? (document.querySelector(hostSelector)?.shadowRoot ?? null) : document;
    const nodes = root ? [...root.querySelectorAll<HTMLElement>("[data-powered-by]")] : [];
    const node = nodes[0];
    const empty = { count: nodes.length, insideBranding: false, text: "", linkText: "", href: null, target: null, rel: null, hidden: ["no [data-powered-by] element"], opacity: 0, width: 0, height: 0, fontSize: 0, inViewport: false, covered: null, linkColor: "", pillColor: "" };
    if (!node) return empty;
    const link = node.querySelector("a");
    const hidden: string[] = [];
    let opacity = 1;
    for (let el: Element | null = link ?? node; el; el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null)) {
      const style = getComputedStyle(el);
      if (style.display === "none") hidden.push(`${el.tagName} display:none`);
      if (style.visibility !== "visible") hidden.push(`${el.tagName} visibility:${style.visibility}`);
      if (style.getPropertyValue("content-visibility") === "hidden") hidden.push(`${el.tagName} content-visibility:hidden`);
      opacity *= Number(style.opacity);
      if (el === document.documentElement) break;
    }
    (link ?? node).scrollIntoView({ block: "center", inline: "center" });
    const box = (link ?? node).getBoundingClientRect();
    const inViewport = box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight + 0.5 && box.right <= innerWidth + 0.5;
    const hitRoot = (node.getRootNode() as Document | ShadowRoot);
    const hit = hitRoot.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const covered = hit && (hit === link || link?.contains(hit) || node.contains(hit)) ? null : hit ? `${hit.tagName}.${String((hit as HTMLElement).className).slice(0, 60)}` : "nothing";
    const pill = node.matches("p") ? node : (node.querySelector("p") ?? node);
    return {
      count: nodes.length,
      insideBranding: !!node.closest(".sa-brand"),
      text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
      linkText: (link?.textContent ?? "").trim(),
      href: link?.getAttribute("href") ?? null,
      target: link?.getAttribute("target") ?? null,
      rel: link?.getAttribute("rel") ?? null,
      hidden,
      opacity,
      width: box.width,
      height: box.height,
      fontSize: Number.parseFloat(getComputedStyle(link ?? node).fontSize),
      inViewport,
      covered,
      linkColor: link ? getComputedStyle(link).color : "",
      pillColor: getComputedStyle(pill).backgroundColor,
    };
  }, shadowHost ?? null);
}

/**
 * Checks "Powered by Silicon Accounts" on `target` and records one check: present exactly once, the text and link the
 * contract fixes (Silicon Accounts → https://account.teamofsilicons.com, in a new tab), visible by computed style, a
 * non-zero box in the viewport, nothing on top of it. `outsideBranding`: on the hosted pages it must live outside the
 * app's branded subtree (so no branding variable reaches it).
 */
export async function checkPoweredBy(ctx: Ctx, target: Page | Frame, label: string, options: { shadowHost?: string; outsideBranding?: boolean } = {}): Promise<boolean> {
  const problemsOf = (facts: PoweredByFacts): string[] => {
    const problems: string[] = [];
    if (facts.count !== 1) problems.push(`${facts.count} elements`);
    if (facts.text !== "Powered by Silicon Accounts") problems.push(`text "${facts.text}"`);
    if (facts.linkText !== "Silicon Accounts") problems.push(`link text "${facts.linkText}"`);
    if (!facts.href || facts.href.replace(/\/$/, "") !== POWERED_BY_HREF) problems.push(`href ${facts.href}`);
    if (facts.target !== "_blank") problems.push(`target ${facts.target}`);
    if (facts.hidden.length) problems.push(`hidden: ${facts.hidden.join(", ")}`);
    if (facts.opacity < 0.99) problems.push(`opacity ${facts.opacity}`);
    if (!(facts.width > 0 && facts.height > 0)) problems.push(`box ${facts.width}×${facts.height}`);
    if (facts.fontSize < 11) problems.push(`font ${facts.fontSize}px`);
    if (!facts.inViewport) problems.push("not in the viewport after scrolling to it");
    if (facts.covered) problems.push(`covered by ${facts.covered}`);
    if (options.outsideBranding && facts.insideBranding) problems.push("inside the app's branded subtree");
    return problems;
  };
  let facts: PoweredByFacts | null = null;
  let problems: string[] = ["not inspected"];
  // A step may still be fading or morphing in: measure again for up to about 2 s before calling it a problem.
  for (let attempt = 0; attempt < 7 && problems.length; attempt++) {
    if (attempt) await sleep(300);
    try {
      facts = await poweredByFacts(target, options.shadowHost);
      problems = problemsOf(facts);
    } catch (error) {
      problems = [`the page could not be inspected: ${String(error).slice(0, 200)}`];
    }
  }
  return ctx.results.check(
    `${label}: "Powered by Silicon Accounts" is there once, visible, uncovered, linking to account.teamofsilicons.com`,
    problems.length === 0,
    problems.length || !facts ? problems.join("; ") : `${Math.round(facts.width)}×${Math.round(facts.height)} px, ${facts.fontSize}px text, link ${facts.linkColor} on ${facts.pillColor}`,
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* What a hosted page paints                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface HostedLook {
  attrs: Record<string, string>;
  vars: Record<string, string>;
  scopeBackground: string;
  bodyBackground: string;
  themeColor: string | null;
  bodyFont: string;
  headingFont: string;
  headingColor: string;
  headingText: string;
  subtitleColor: string | null;
  primary: { background: string; color: string; border: string; radius: string; height: number; text: string } | null;
  input: { radius: string; height: number } | null;
  panel: { background: string; border: string; radius: string; cornerShape: string } | null;
  asideVisible: boolean;
  backdrop: string;
  logo: { src: string; height: number } | null;
  appName: string | null;
  legalLinks: string[];
  supportEmail: string | null;
}

/** The branding the hosted page in `page` paints right now (scope attributes, variables and computed styles). */
export function readHostedLook(page: Page): Promise<HostedLook> {
  return page.evaluate(() => {
    const scope = document.querySelector<HTMLElement>(".sa-brand[data-brand]") ?? document.querySelector<HTMLElement>(".sa-brand");
    if (!scope) throw new Error("no .sa-brand scope on the page");
    const attrs: Record<string, string> = {};
    for (const name of scope.getAttributeNames()) if (name.startsWith("data-")) attrs[name] = scope.getAttribute(name) ?? "";
    const style = getComputedStyle(scope);
    const vars: Record<string, string> = {};
    for (const name of ["--background", "--surface", "--foreground", "--text-muted", "--border", "--accent", "--primary", "--primary-foreground", "--danger", "--radius-control", "--font-body", "--font-display", "--brand-logo-height", "--brand-pad", "--control-height-md", "--brand-bg-image"]) vars[name] = style.getPropertyValue(name).trim();
    const main = document.querySelector<HTMLElement>("main.sa-brand-panel") ?? scope;
    const heading = main.querySelector<HTMLElement>("h1");
    const primary = main.querySelector<HTMLElement>("[data-variant='primary']") ?? main.querySelector<HTMLElement>("button[type='submit']");
    const input = main.querySelector<HTMLElement>("input:not([type='hidden'])");
    const panel = main.classList.contains("sa-brand-panel") ? main : null;
    const aside = scope.querySelector<HTMLElement>(".sa-brand-aside");
    // The split layout hides the panel's own header and shows the app's identity in the aside: take what is shown.
    // (No named helper functions in here: the bundler would wrap them in a __name() the page does not have.)
    let logo: HTMLImageElement | null = null;
    for (const el of scope.querySelectorAll<HTMLImageElement>(".sa-brand-logo")) {
      if (el.getBoundingClientRect().height > 0) {
        logo = el;
        break;
      }
    }
    let name: HTMLElement | null = null;
    for (const el of scope.querySelectorAll<HTMLElement>(".sa-brand-name")) {
      if (el.getBoundingClientRect().height > 0) {
        name = el;
        break;
      }
    }
    const subtitle = main.querySelector<HTMLElement>("h1 + p") ?? scope.querySelector<HTMLElement>(".sa-brand-subtitle");
    const legal = [...document.querySelectorAll<HTMLAnchorElement>(".sa-brand-legal a")];
    const support = legal.find(link => link.href.startsWith("mailto:"));
    const meta = document.querySelector<HTMLMetaElement>("meta[name='theme-color']");
    return {
      attrs,
      vars,
      scopeBackground: style.backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      themeColor: meta?.content ?? null,
      bodyFont: style.fontFamily,
      headingFont: heading ? getComputedStyle(heading).fontFamily : "",
      headingColor: heading ? getComputedStyle(heading).color : "",
      headingText: (heading?.textContent ?? "").trim(),
      subtitleColor: subtitle ? getComputedStyle(subtitle).color : null,
      // A squircle drawn by the fallback (no native corner-shape) paints its fill and ring on ::before / ::after.
      primary: primary ? { background: primary.hasAttribute("data-sq-fb") ? getComputedStyle(primary, "::before").backgroundColor : getComputedStyle(primary).backgroundColor, color: getComputedStyle(primary).color, border: primary.hasAttribute("data-sq-fb") ? getComputedStyle(primary).getPropertyValue("--sq-stroke").trim() : getComputedStyle(primary).borderTopColor, radius: getComputedStyle(primary).borderTopLeftRadius, height: primary.getBoundingClientRect().height, text: (primary.textContent ?? "").trim() } : null,
      input: input ? { radius: getComputedStyle(input).borderTopLeftRadius, height: input.getBoundingClientRect().height } : null,
      panel: panel ? { background: getComputedStyle(panel).backgroundColor, border: getComputedStyle(panel).borderTopColor, radius: getComputedStyle(panel).borderTopLeftRadius, cornerShape: getComputedStyle(panel).getPropertyValue("corner-shape") } : null,
      asideVisible: !!aside && getComputedStyle(aside).display !== "none" && aside.getBoundingClientRect().width > 0,
      backdrop: getComputedStyle(scope, "::before").backgroundImage,
      logo: logo ? { src: logo.getAttribute("src") ?? "", height: logo.getBoundingClientRect().height } : null,
      appName: name ? (name.textContent ?? "").trim() : null,
      legalLinks: legal.map(link => link.getAttribute("href") ?? ""),
      supportEmail: support ? support.href.replace(/^mailto:/, "") : null,
    };
  });
}

/**
 * The step's main action (the visible primary button) as a Carbon reads it: its text colour against what is really
 * behind it (its own fill, or the card or page under a transparent outline button, semi-transparent layers composited),
 * as a WCAG contrast ratio. Plain JS in a string: helper functions inside a compiled evaluate callback would be wrapped
 * in a __name() call the page does not define.
 */
const PRIMARY_READABILITY = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  function rgba(color) {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = "rgba(0, 0, 0, 0)";
    g.fillStyle = color;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function channel(v) { v = v / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]); }
  function fill(el) {
    const before = el.hasAttribute("data-sq-fb") ? getComputedStyle(el, "::before").backgroundColor : null;
    return before && rgba(before)[3] > 0 ? before : getComputedStyle(el).backgroundColor;
  }
  const button = [...document.querySelectorAll("main [data-variant='primary']")].find(b => b.getBoundingClientRect().height > 0 && !b.closest("[inert]"));
  if (!button) return null;
  const layers = [];
  for (let el = button; el; el = el.parentElement) {
    const c = rgba(fill(el));
    if (c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
  }
  let base = [255, 255, 255];
  for (let i = layers.length - 1; i >= 0; i--) { const c = layers[i]; base = [0, 1, 2].map(k => c[k] * c[3] + base[k] * (1 - c[3])); }
  const text = rgba(getComputedStyle(button).color);
  const ink = [0, 1, 2].map(k => text[k] * text[3] + base[k] * (1 - text[3]));
  const a = lum(ink), b = lum(base);
  return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), text: getComputedStyle(button).color, background: "rgb(" + base.map(Math.round).join(", ") + ")", label: (button.textContent || "").trim() };
})()`;

export interface Readability {
  ratio: number;
  text: string;
  background: string;
  label: string;
}

/** The contrast of the step's main action (null when the step has none). */
export async function primaryReadability(page: Page): Promise<Readability | null> {
  return (await page.evaluate(PRIMARY_READABILITY)) as Readability | null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhook inboxes and the mock providers                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface InboxEvent {
  seq: number;
  event_id: string;
  type: string;
  delivery_id: string | null;
  deliveries: number;
  duplicate_count: number;
  payload: Record<string, unknown>;
}

export interface Inbox {
  items: InboxEvent[];
  rejected: Array<{ status: number; reason: string; event_id: string | null; type: string | null; delivery_id: string | null }>;
}

/** A fake app's webhook inbox (`<apps>/<app>`) or a generic sink (`<apps>/hooks/<key>`). */
export async function readInbox(prefix: string): Promise<Inbox> {
  const { body } = await json<Partial<Inbox>>(`${prefix}/_events?include_rejected=1&limit=500`);
  return { items: body.items ?? [], rejected: body.rejected ?? [] };
}

export async function inboxSecret(prefix: string, secret: string | null): Promise<void> {
  const answer = await json(`${prefix}/_webhook-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
  if (answer.status !== 200) throw new Error(`${prefix}/_webhook-secret answered ${answer.status}`);
}

export async function inboxFaults(prefix: string, failNext: number, status = 503): Promise<void> {
  const answer = await json(`${prefix}/_webhook-faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fail_next: failNext, status }) });
  if (answer.status !== 200) throw new Error(`${prefix}/_webhook-faults answered ${answer.status}`);
}

export interface OidcLogEntry {
  seq: number;
  endpoint: string;
  client_id: string | null;
  status: number;
  outcome: string;
  error: string | null;
  error_description: string | null;
}

/** The mock provider's newest requests to one endpoint (newest first). */
export async function oidcLog(env: Env, provider: "google" | "apple", endpoint: "authorize" | "token"): Promise<OidcLogEntry[]> {
  const { body } = await json<{ items?: OidcLogEntry[] }>(`${env.oidc}/_requests?provider=${provider}&endpoint=${endpoint}`);
  return body.items ?? [];
}

/** On the mock provider's chooser: "Use another account" with this email and name. */
export async function chooseMockIdentity(env: Env, page: Page, email: string, name: string): Promise<void> {
  await page.waitForURL(new RegExp(env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(name);
  await page.locator('#new-identity button[data-action="use-another"]').click();
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Host pages on other origins                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Serves `html` at `url` for this browser context only (Playwright answers the request; nothing listens there), so a
 * journey can put the iframe or the SDK on any origin it likes: the app's allowed one, or one nobody allowed.
 */
export async function hostPage(context: BrowserContext, url: string, html: string): Promise<void> {
  await context.route(url, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
}

export const htmlPage = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Walking a hosted sign-in, step by step                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface WalkOptions {
  app: string;
  /** Screenshot and check names: "<label>-<n>-<step>". */
  label: string;
  width?: number;
  height?: number;
  dark?: boolean;
  /** How the Carbon signs in. */
  via: "email" | "phone" | "apple";
  /** Runs at every step (after the step settled), e.g. checks of the branding. */
  atStep?: (step: string, page: Page) => Promise<void>;
  /** Routes for this browser context (images on hosts that do not exist…). */
  prepare?: (context: BrowserContext) => Promise<void>;
  /** Console errors the walk provokes on purpose. */
  expected?: RegExp[];
}

export interface WalkResult {
  steps: string[];
  account: Record<string, unknown> | null;
  ms: number;
  /** The main action's contrast at each step that has one. */
  readability: Array<Readability & { step: string }>;
}

/**
 * A fresh visitor signs up to `app` through its hosted pages from the fake app's page, step by step: the methods, the
 * email or phone code (or Apple through the mock), sign-up, requirements with their code, consent, and the complete
 * step (held on screen by keeping the app's callback waiting), then back at the app. At every step "Powered by
 * Silicon Accounts" is checked and the page photographed; `atStep` adds checks of its own.
 */
export async function walkHosted(ctx: Ctx, options: WalkOptions): Promise<WalkResult> {
  const { env, results, browser } = ctx;
  const started = Date.now();
  const context = await newContext(browser, { width: options.width, height: options.height, dark: options.dark });
  await options.prepare?.(context);
  const page = await context.newPage();
  results.watch(page, options.label, options.expected ?? []);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(done => (release = done));
  await page.route(`${env.apps}/${options.app}/callback**`, async route => {
    await gate;
    await route.continue();
  });
  const steps: string[] = [];
  const readability: WalkResult["readability"] = [];
  const at = async (step: string) => {
    steps.push(step);
    await page.locator("main[data-fonts='ready']").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(700);
    await checkPoweredBy(ctx, page, `${options.label} ${step}`, { outsideBranding: true });
    const action = await primaryReadability(page).catch(() => null);
    if (action) readability.push({ ...action, step });
    await options.atStep?.(step, page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(env, page, `${options.label}-${steps.length}-${step}`, true);
  };
  try {
    await page.goto(`${env.apps}/${options.app}/?only=hosted`);
    await page.locator("#signin-hosted").click();
    await page.waitForURL(/\/authorize\/flow\//, { timeout: 30_000 });
    await page.locator("main h1").first().waitFor({ timeout: 30_000 });
    await at("methods");
    const t = tag();
    if (options.via === "apple") {
      await page.getByRole("button", { name: "Continue with Apple" }).click();
      await chooseMockIdentity(env, page, `dvb.walk.${t}@icloud.test`, `Walk Tester ${t}`);
    } else {
      const segments = page.getByRole("group", { name: "Sign in with" });
      if (await segments.count()) await segments.getByRole("button", { name: options.via === "email" ? "Email" : "Phone", exact: true }).click();
      const to = options.via === "email" ? freshEmail("walk") : randomPhone();
      const after = await lastSeq(env);
      if (options.via === "email") await page.getByRole("textbox", { name: "Email" }).fill(to);
      else {
        await page.getByRole("textbox", { name: "Phone number" }).click();
        await page.keyboard.type(to, { delay: 20 });
      }
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, to, after);
      await page.getByRole("group", { name: options.via === "email" ? /Code from the email/ : /Code from the text message/ }).waitFor({ timeout: 15_000 });
      await at(options.via === "email" ? "email-code" : "phone-code");
      await page.getByRole("group", { name: options.via === "email" ? /Code from the email/ : /Code from the text message/ }).getByRole("textbox").first().click();
      await page.keyboard.type(code, { delay: 25 });
    }
    // Exact names: the code step's "Resend code" must never pass for the requirements' "Send code".
    const signup = page.getByRole("button", { name: "Create account", exact: true });
    const sendCode = page.getByRole("button", { name: "Send code", exact: true });
    const share = page.getByRole("button", { name: "Share and continue", exact: true });
    const complete = page.getByRole("heading", { level: 1, name: /^Signed in to / });
    for (let guard = 0; guard < 6; guard++) {
      const next = await Promise.race([
        signup.waitFor({ timeout: 30_000 }).then(() => "signup" as const),
        sendCode.waitFor({ timeout: 30_000 }).then(() => "requirements" as const),
        share.waitFor({ timeout: 30_000 }).then(() => "consent" as const),
        complete.waitFor({ timeout: 30_000 }).then(() => "complete" as const),
      ]);
      if (next === "signup") {
        await at("signup");
        await signup.click();
        await signup.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
      } else if (next === "requirements") {
        await at("requirements");
        // The app requires a phone (or an email) the account does not have yet: add one, with its own code.
        const wantsEmail = (await page.getByRole("textbox", { name: "Email" }).count()) > 0;
        const value = wantsEmail ? freshEmail("req") : randomPhone();
        const codeGroup = wantsEmail ? /Code from the email/ : /Code from the text message/;
        const after = await lastSeq(env);
        if (wantsEmail) await page.getByRole("textbox", { name: "Email" }).fill(value);
        else {
          await page.getByRole("textbox", { name: "Phone number" }).click();
          await page.keyboard.type(value, { delay: 20 });
        }
        await sendCode.click();
        const code = await codeFor(env, value, after);
        await page.getByRole("group", { name: codeGroup }).waitFor({ timeout: 15_000 });
        await at("requirements-code");
        await page.getByRole("group", { name: codeGroup }).getByRole("textbox").first().click();
        await page.keyboard.type(code, { delay: 25 });
        await sendCode.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
      } else if (next === "consent") {
        await at("consent");
        await share.click();
        await share.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
      } else {
        await at("complete");
        break;
      }
    }
    release();
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/${options.app}/`), { timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const raw = await page.locator("#account").innerText().catch(() => "");
    let account: Record<string, unknown> | null = null;
    try {
      account = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      account = null;
    }
    return { steps, account, ms: Date.now() - started, readability };
  } finally {
    release();
    await context.close();
  }
}
