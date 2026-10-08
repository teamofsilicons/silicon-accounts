/**
 * Helpers of the developer-site suite: developers.teamofsilicons.com (developer/, base + 5 on a stack) walked end to end
 * through its BFF. A helper file (its name starts with "_"), so run.ts never takes it for journeys; everything here is
 * built on e2e/lib.ts and nothing in it belongs to one journey.
 *
 * - The developer site's sealed session cookie, opened and sealed again with the stack's DEVELOPER_SESSION_SECRET
 *   (scripts/dev.sh gives every stack `local-stack-<base>-developer-session-secret-not-for-production`), so a journey can
 *   read the tokens the browser must never see and check where they go, or move the access token's expiry (time travel
 *   for the BFF's refresh).
 * - Calls as an app (its own credentials) and as a bearer token, straight at accounts-api.
 * - Sign-ins: an app's owner (the Carbon testkit/fake-apps.json seeds for it) or a fresh Carbon, on the developer site.
 * - The sign-in setup of an app: read it, and put it back as it was when a journey started.
 * - The developer site's controls (save bar, Arc selects, segmented controls, sliders, colour pickers, tag fields) and
 *   what a hosted page paints (the branding scope, "Powered by Silicon Accounts").
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { BrowserContext, Cookie, Locator, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { DEVELOPER_SIGNED_OUT, POWERED_BY_HREF, api, fakeApp, newContext, signInOnDeveloper, sleep, sql, tag, type ApiInit, type ContextOptions, type Env, type JsonAnswer } from "../../lib";

/* ------------------------------------------------------------------------------------------------------------------ */
/* The developer site's session cookie                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The developer site's cookies over http (`__Host-` prefixed over https). */
export const SESSION_COOKIE = "sa_dev_session";
export const SIGNIN_COOKIE = "sa_dev_signin";

/** The secret the stack's developer site seals its cookies with (scripts/dev.sh's per-stack default). */
export function developerSecret(env: Env): string {
  return process.env.DEVELOPER_SESSION_SECRET?.trim() || `local-stack-${env.base}-developer-session-secret-not-for-production`;
}

const keys = new Map<string, Buffer>();
function sealKey(secret: string): Buffer {
  let key = keys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "silicon-accounts-developer", "cookie seal v1", 32));
    keys.set(secret, key);
  }
  return key;
}

/** developer/lib/server/seal.ts: AES-256-GCM, the cookie's purpose as additional data, `v1.<base64url(iv‖ct‖tag)>`. */
export function seal(value: unknown, purpose: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
}

export function unseal<T>(sealed: string | null | undefined, purpose: string, secret: string): T | null {
  if (!sealed?.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKey(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** What the developer site's session cookie holds (developer/lib/server/session.ts StoredSession). */
export interface DevSession {
  v: 1;
  /** Access token (aud=developer). */
  at: string;
  /** Refresh token (sar_…). */
  rt: string;
  /** Access token expiry, epoch ms. */
  ae: number;
  re: number;
  sub: string;
}

/** The context's developer-site session cookie, and what it holds. */
export async function readDevSession(context: BrowserContext, env: Env): Promise<{ cookie: Cookie | undefined; session: DevSession | null }> {
  const cookie = (await context.cookies(env.developer)).find(item => item.name === SESSION_COOKIE);
  return { cookie, session: unseal<DevSession>(cookie?.value, SESSION_COOKIE, developerSecret(env)) };
}

/** Puts a session into the context's developer-site cookie (sealed with the stack's secret), keeping its attributes. */
export async function writeDevSession(context: BrowserContext, env: Env, session: DevSession, like?: Cookie): Promise<void> {
  const url = new URL(env.developer);
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: seal(session, SESSION_COOKIE, developerSecret(env)),
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    expires: like?.expires && like.expires > 0 ? like.expires : Math.floor(Date.now() / 1000) + 3600,
  }]);
}

/** The claims of a JWT (no verification: the journeys only read what a token says). */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Calls straight at accounts-api                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A call with `Authorization: Bearer <token>`, straight at accounts-api with the journey's address. */
export function bearer<T = unknown>(ctx: Ctx, token: string, path: string, init: ApiInit = {}): Promise<JsonAnswer<T>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return api<T>(ctx, path, { ...init, direct: true, headers });
}

/** `Authorization: Basic` with a fake app's own id and secret. */
export const appBasic = (appId: string) => `Basic ${Buffer.from(`${appId}:${fakeApp(appId).secret}`).toString("base64")}`;

/** A call made by the app's own server (its credentials), straight at accounts-api. */
export function asApp<T = unknown>(ctx: Ctx, appId: string, path: string, init: ApiInit = {}): Promise<JsonAnswer<T>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", appBasic(appId));
  return api<T>(ctx, path, { ...init, direct: true, headers });
}

/** POST /v1/oauth/token as a form, straight at accounts-api. */
export function tokenCall<T = Record<string, unknown>>(ctx: Ctx, form: Record<string, string>): Promise<JsonAnswer<T>> {
  return api<T>(ctx, "/v1/oauth/token", { method: "POST", direct: true, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
}

/** The API's error shape. */
export interface ApiErrorBody {
  error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
}

export const errorCode = (body: unknown) => (body as ApiErrorBody | null)?.error?.code;
export const errorMessage = (body: unknown) => (body as ApiErrorBody | null)?.error?.message ?? "";
/** 422 `details.fields` of a validation error, by path. */
export const errorFields = (body: unknown) => ((body as ApiErrorBody | null)?.error?.details?.fields ?? {}) as Record<string, string>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* An app's sign-in setup                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Palette = Record<"primary" | "primary_foreground" | "background" | "surface" | "foreground" | "muted" | "border" | "danger", string>;

export interface Branding {
  theme: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  logo_height: number;
  show_app_name: boolean;
  font_family: string;
  heading_font_family: string | null;
  corner_style: string;
  radius: number;
  button_style: string;
  layout: string;
  background_style: string;
  background_image_url: string | null;
  density: string;
  light: Palette;
  dark: Palette;
}

export interface FlowStep {
  id: string;
  fields: string[];
  title: string | null;
  subtitle: string | null;
  continue_label: string | null;
  layout: string | null;
}

/** The sign-in setup as GET /v1/apps/{app_id} shows it (secrets masked to `client_secret_set` / `private_key_set`). */
export interface SigninConfigView {
  methods: Record<"email" | "phone" | "google" | "apple", boolean>;
  method_order: string[];
  google: { mode: string; client_id: string | null; prompt: string | null; hosted_domain: string | null; client_secret_set?: boolean; [key: string]: unknown };
  apple: { mode: string; services_id: string | null; team_id: string | null; key_id: string | null; private_key_set?: boolean; [key: string]: unknown };
  required_fields: string[];
  optional_fields: string[];
  flow: { steps: FlowStep[]; review: boolean } | null;
  redirect_uris: string[];
  allowed_origins: string[];
  allowed_email_domains: string[];
  allow_signup: boolean;
  remember_browser: boolean;
  branding: Branding;
  copy: Record<string, string | null>;
  [key: string]: unknown;
}

export interface AppDetailView {
  app_id: string;
  name: string;
  owner: { uuid: string; id: string | null; display_name: string } | null;
  status: string;
  source: string;
  signin_config: SigninConfigView;
  config_version: number;
  webhook: { url: string | null; secret_set: boolean };
  stats: { users: number; active_last_30d: number; imported_unclaimed: number };
  [key: string]: unknown;
}

/** GET /v1/apps/{app_id} as the app itself. */
export async function appDetail(ctx: Ctx, appId: string): Promise<AppDetailView> {
  const answer = await asApp<AppDetailView>(ctx, appId, `/v1/apps/${appId}`);
  if (answer.status !== 200) throw new Error(`GET /v1/apps/${appId} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`);
  return answer.body;
}

/** PATCH /v1/apps/{app_id}/signin-config as the app itself (one Idempotency-Key per call). */
export function patchConfig(ctx: Ctx, appId: string, patch: Record<string, unknown>): Promise<JsonAnswer<AppDetailView>> {
  return asApp<AppDetailView>(ctx, appId, `/v1/apps/${appId}/signin-config`, { method: "PATCH", json: patch, headers: { "idempotency-key": `ds-${Date.now()}-${tag()}` } });
}

/**
 * Puts an app's sign-in setup back to `before` (a GET taken when the journey started): the whole document, so whatever
 * the journey changed goes back, and the secrets a journey added are removed (a stored secret of the seed is put back
 * from testkit/fake-apps.json). Throws when the API refuses, so a journey never leaves an app changed silently.
 */
export async function restoreConfig(ctx: Ctx, appId: string, before: SigninConfigView): Promise<void> {
  const { client_secret_set: googleSet, ...google } = before.google;
  const { private_key_set: appleSet, ...apple } = before.apple;
  const seeded = fakeApp(appId).signin_defaults as { google?: { client_secret?: string }; apple?: { private_key?: string } };
  const now = (await appDetail(ctx, appId)).signin_config;
  const patch: Record<string, unknown> = { ...before, google: { ...google }, apple: { ...apple } };
  if (!googleSet && now.google.client_secret_set) (patch.google as Record<string, unknown>).client_secret = null;
  if (googleSet && seeded.google?.client_secret) (patch.google as Record<string, unknown>).client_secret = seeded.google.client_secret;
  if (!appleSet && now.apple.private_key_set) (patch.apple as Record<string, unknown>).private_key = null;
  if (appleSet && seeded.apple?.private_key) (patch.apple as Record<string, unknown>).private_key = seeded.apple.private_key;
  const answer = await patchConfig(ctx, appId, patch);
  if (answer.status !== 200) throw new Error(`putting ${appId}'s sign-in setup back failed: ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Sign-ins                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Time travel for the per-destination code limit (10 codes per 10 minutes): the codes sent to `destination` count as
 * sent 11 minutes ago. The fake apps' owners sign in to the developer site in many journeys, so without this a long or
 * repeated walk would see "Too many codes were sent".
 */
export async function freshCodeWindow(env: Env, destination: string): Promise<void> {
  await sql(env, `update otp_challenges set created_at = created_at - interval '11 minutes' where destination = '${destination.replace(/'/g, "")}' and created_at > now() - interval '10 minutes'`);
}

/** A new address for a fresh Carbon (example.test never leaves the mock email server). */
export const freshEmail = (label: string) => `ds-${label}-${tag()}${tag()}@example.test`;

export interface SignedInBrowser {
  context: BrowserContext;
  page: Page;
  email: string;
}

/**
 * The owner of a fake app (the Carbon testkit/fake-apps.json seeds for it) signed in to the developer site in a new
 * browser context, through its BFF (its sign-in card, the account site's hosted pages, /auth/callback). The page is
 * watched, with the developer site's signed-out probe as expected noise.
 */
export async function ownerSignIn(ctx: Ctx, appId: string, options: ContextOptions & { returnTo?: string; label?: string; expected?: RegExp[] } = {}): Promise<SignedInBrowser> {
  const email = fakeApp(appId).owner_email;
  await freshCodeWindow(ctx.env, email);
  const context = await newContext(ctx.browser, options);
  const page = await context.newPage();
  ctx.results.watch(page, options.label ?? `owner-${appId}`, [DEVELOPER_SIGNED_OUT, ...(options.expected ?? [])]);
  await signInOnDeveloper(ctx.env, page, email, { returnTo: options.returnTo });
  return { context, page, email };
}

/** A fresh Carbon (signed up on the way) signed in to the developer site in a new browser context. */
export async function freshSignIn(ctx: Ctx, label: string, options: ContextOptions & { returnTo?: string; expected?: RegExp[] } = {}): Promise<SignedInBrowser> {
  const email = freshEmail(label);
  const context = await newContext(ctx.browser, options);
  const page = await context.newPage();
  ctx.results.watch(page, label, [DEVELOPER_SIGNED_OUT, ...(options.expected ?? [])]);
  await signInOnDeveloper(ctx.env, page, email, { returnTo: options.returnTo });
  return { context, page, email };
}

/** Signs the developer site out from its account menu and waits for /sign-in. */
export async function signOutOfDeveloper(env: Env, page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await page.getByRole("menuitem", { name: /Sign out/ }).click();
  await page.waitForURL(url => url.href.startsWith(`${env.developer}/sign-in`), { timeout: 20_000 });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The developer site's pages and controls                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

const TAB_LABEL: Record<string, string> = { overview: "Overview", "sign-in": "Sign-in", details: "Details", flows: "Flows", pages: "Pages", users: "Users", import: "Import", webhooks: "Webhooks", ata: "App verification", embed: "Embed" };

/** Opens one tab of an app with a full load and waits for its panel. */
export async function openAppTab(env: Env, page: Page, appId: string, tab: string): Promise<Locator> {
  await page.goto(`${env.developer}/apps/${appId}${tab === "overview" ? "" : `/${tab}`}`);
  const panel = page.getByRole("tabpanel", { name: TAB_LABEL[tab] ?? tab });
  await panel.waitFor({ timeout: 30_000 });
  // The tab's own code arrives on its own (a skeleton stands in until then).
  await page.waitForFunction(() => !document.querySelector('[role="tabpanel"] [aria-busy="true"][aria-label="Loading"]'), undefined, { timeout: 30_000 }).catch(() => undefined);
  return panel;
}

/** Switches to a tab of the app on screen by its tab (a click: the address changes in the browser). */
export async function clickTab(page: Page, tab: string): Promise<Locator> {
  const label = TAB_LABEL[tab] ?? tab;
  await page.getByRole("tab", { name: label, exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: label });
  await panel.waitFor({ timeout: 20_000 });
  return panel;
}

/** What a save ended as: saved (and as which version), or the problem it stopped at. */
export interface SaveOutcome {
  saved: boolean;
  version: number | null;
  /** The save bar's status, or the alert that stopped the save. */
  text: string;
}

/**
 * Presses the floating save bar's "Save changes" and waits for "Saved as version N" (a version the bar did not show
 * before: the status swaps with an animation, so the last save's words can still be on screen), or for what stopped it:
 * local problems ("Some settings need fixing", "… block saving"), the server's refusal or a version conflict.
 */
export async function saveChanges(page: Page, timeoutMs = 25_000): Promise<SaveOutcome> {
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  const versionsIn = (text: string) => [...text.matchAll(/Saved as version (\d+)/g)].map(match => Number(match[1]));
  const stale = new Set(versionsIn(await bar.innerText({ timeout: 2_000 }).catch(() => "")));
  await bar.getByRole("button", { name: "Save changes" }).click({ timeout: 10_000 });
  const deadline = Date.now() + timeoutMs;
  let text = "";
  const stopped = page.locator('[role="tabpanel"] [role="alert"], [role="tabpanel"] [role="status"], [id$="-conflict"], [id$="-save-error"]').filter({ hasText: /Some settings need fixing|The changes were not saved|Someone saved version/ }).first();
  while (Date.now() < deadline) {
    text = (await bar.innerText({ timeout: 1_000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    const fresh = versionsIn(text).find(version => !stale.has(version));
    if (fresh !== undefined) return { saved: true, version: fresh, text };
    if (await stopped.isVisible().catch(() => false)) return { saved: false, version: null, text: (await stopped.innerText().catch(() => "")).replace(/\s+/g, " ").trim() };
    if (/problems? blocks? saving/.test(text) && !/Saving changes/.test(text)) {
      await sleep(400);
      return { saved: false, version: null, text: `${text} ${await stopped.innerText().catch(() => "")}`.replace(/\s+/g, " ").trim() };
    }
    await sleep(120);
  }
  return { saved: false, version: null, text: text || "the save bar left without saying it saved" };
}

/** The save bar's status text, or "" when it is not on screen. */
export async function saveBarText(page: Page): Promise<string> {
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  if (!(await bar.isVisible().catch(() => false))) return "";
  return (await bar.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
}

/** The text of an element as assistive technology reads it: without its aria-hidden parts (animated digit strips…). */
export function accessibleText(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach(hidden => hidden.remove());
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  });
}

/** Picks `option` in an Arc Select (a Radix select labelled `label`). */
export async function selectOption(scope: Page | Locator, page: Page, label: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
  await page.getByRole("listbox").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}

/** Presses `option` in an Arc segmented control (a group of pressed buttons labelled `label`; the innermost group wins). */
export async function pressSegment(scope: Page | Locator, label: string, option: string): Promise<void> {
  await scope.getByRole("group", { name: label, exact: true }).last().getByRole("button", { name: option, exact: true }).click();
}

/** Sets a native range input (a labelled slider) the way a person dragging it would: React sees an input event. */
export async function setRange(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((element, next) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, String(next));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Types a hex colour into an Arc colour picker (its trigger is named "<label> #RRGGBB"), then closes it. */
export async function setColour(page: Page, label: string, hex: string): Promise<void> {
  const trigger = page.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} #[0-9A-F]{6}`) }).first();
  await trigger.click();
  const panel = page.getByRole("dialog", { name: `${label} color` });
  const input = panel.getByRole("textbox", { name: `${label} in Hex` });
  await input.waitFor({ timeout: 5_000 });
  await input.fill(hex);
  await input.press("Enter");
  await panel.getByRole("button", { name: "Done" }).click();
  await sleep(250);
}

/** Adds a value to a tag field (Enter adds it); returns the field's messages (a refusal says why). */
export async function addTag(scope: Page | Locator, label: string, value: string): Promise<string[]> {
  const input = scope.getByRole("textbox", { name: label, exact: true });
  await input.fill(value);
  await input.press("Enter");
  await sleep(200);
  const field = input.locator("xpath=ancestor::*[contains(@class,'tagField')][1]");
  return (await field.locator("ul[aria-live] li").allInnerTexts().catch(() => [])).map(text => text.trim());
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* What a hosted page paints                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface HostedLook {
  /** The hosted frame: the theme it paints and the layout it is drawn in. */
  paint: string | null;
  layout: string | null;
  /** The branding scope's attributes. */
  corner: string | null;
  bg: string | null;
  buttonStyle: string | null;
  density: string | null;
  /** Its custom properties (upper-case hex where they are colours). */
  vars: Record<string, string>;
  title: string;
  titleFont: string;
  bodyFont: string;
  /** The panel's logo (src) and whether the app name shows next to it. */
  logo: string | null;
  logoHeight: number | null;
  appName: string | null;
  /** The first primary button: its background, text colour and corner radius. */
  button: { background: string; color: string; radius: string } | null;
  /** "Powered by Silicon Accounts": where it links, its text, whether its link is the element at its own centre. */
  poweredBy: { href: string; text: string; onTop: boolean; inView: boolean };
}

/**
 * Reads the hosted page on screen (the step that is not morphing out). No named functions inside the evaluated code:
 * tsx (esbuild keepNames) would wrap them in a `__name` helper the page does not have.
 */
export async function hostedLook(page: Page): Promise<HostedLook> {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-paint][data-layout]");
    const scope = [...document.querySelectorAll(".sa-brand")].find(element => !element.closest("[data-step-leaving]")) ?? null;
    const style = scope ? getComputedStyle(scope) : null;
    const names = ["--background", "--surface", "--foreground", "--primary", "--primary-foreground", "--accent", "--danger", "--radius-control", "--font-body", "--font-display", "--brand-logo-height", "--brand-pad", "--control-height-md"];
    const vars: Record<string, string> = {};
    for (const name of names) vars[name] = (style?.getPropertyValue(name) ?? "").trim();
    const heading = [...document.querySelectorAll("h1")].find(element => !element.closest("[data-step-leaving]")) ?? null;
    const panel = [...document.querySelectorAll(".sa-brand-panel")].find(element => !element.closest("[data-step-leaving]")) ?? null;
    // The logo and name on screen: the panel's, or (split layout on a wide screen) the app's side's.
    const logo = [...document.querySelectorAll<HTMLImageElement>(".sa-brand .sa-brand-logo")].find(element => !element.closest("[data-step-leaving]") && element.getBoundingClientRect().height > 0) ?? null;
    const name = [...document.querySelectorAll(".sa-brand .sa-brand-name")].find(element => !element.closest("[data-step-leaving]") && element.getBoundingClientRect().height > 0) ?? null;
    const button = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(element => {
      const css = getComputedStyle(element);
      return !element.closest("[data-step-leaving]") && element.getClientRects().length > 0 && css.backgroundColor !== "rgba(0, 0, 0, 0)" && css.backgroundColor !== "transparent" && /^(continue|create account|share and continue|verify|send code)$/i.test((element.textContent ?? "").trim());
    }) ?? null;
    const powered = document.querySelector("[data-powered-by]");
    const links = [...(powered?.querySelectorAll("a") ?? [])];
    const link = links[links.length - 1] ?? null;
    const box = link?.getBoundingClientRect();
    let onTop = false;
    if (link && box && box.width > 0) {
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      onTop = !!hit && (hit === link || link.contains(hit));
    }
    const buttonStyle = button ? getComputedStyle(button) : null;
    return {
      paint: frame?.getAttribute("data-paint") ?? null,
      layout: frame?.getAttribute("data-layout") ?? null,
      corner: scope?.getAttribute("data-corner") ?? null,
      bg: scope?.getAttribute("data-bg") ?? null,
      buttonStyle: scope?.getAttribute("data-button-style") ?? null,
      density: scope?.getAttribute("data-density") ?? null,
      vars,
      title: (heading?.textContent ?? "").replace(/\s+/g, " ").trim(),
      titleFont: heading ? getComputedStyle(heading).fontFamily : "",
      bodyFont: panel ? getComputedStyle(panel).fontFamily : "",
      logo: logo?.getAttribute("src") ?? null,
      logoHeight: logo ? Math.round(logo.getBoundingClientRect().height) : null,
      appName: name ? (name.textContent ?? "").trim() : null,
      button: buttonStyle ? { background: buttonStyle.backgroundColor, color: buttonStyle.color, radius: buttonStyle.borderTopLeftRadius } : null,
      poweredBy: {
        href: link?.getAttribute("href") ?? "",
        text: (powered?.textContent ?? "").replace(/\s+/g, " ").trim(),
        onTop,
        inView: !!box && box.width > 0 && box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth,
      },
    };
  });
}

/** "rgb(229, 0, 126)" → "#E5007E" (computed colours read back as rgb()). */
export function rgbToHex(value: string): string {
  const match = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  if (!match) return value.trim().toUpperCase();
  return `#${[match[1], match[2], match[3]].map(part => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** WCAG contrast of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const channel = (offset: number) => {
      const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export { POWERED_BY_HREF };

export interface RenderedContrast {
  /** The heading's text against what is painted behind it. */
  heading: number | null;
  /** The main button's words against its own fill (or what shows through it). */
  button: number | null;
  detail: string;
}

/**
 * Contrast as painted: every colour is read back through a 1×1 canvas (so color-mix(), oklab() and alpha all resolve to
 * sRGB), and a background with alpha is laid over its ancestors' until the paint is opaque. The heading and the main
 * button ("Continue", "Create account", "Share and continue", "Verify") are measured; the button is found as on screen.
 */
export async function renderedContrast(page: Page): Promise<RenderedContrast> {
  // A plain script (a string): tsx would wrap named functions in code passed as a function in a helper the page lacks.
  return page.evaluate(RENDERED_CONTRAST_SCRIPT) as Promise<RenderedContrast>;
}

const RENDERED_CONTRAST_SCRIPT = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  function rgba(css) {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = css;
    paint.fillRect(0, 0, 1, 1);
    const d = paint.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function behind(element) {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor;
      const value = colour === "transparent" ? [0, 0, 0, 0] : rgba(colour);
      if (value[3] > 0) layers.push(value);
      if (value[3] >= 0.999) break;
    }
    let out = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    return out;
  }
  function lum(c) {
    const w = [0.2126, 0.7152, 0.0722];
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      const s = c[i] / 255;
      sum += w[i] * (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
    }
    return sum;
  }
  function ratio(fg, bg) {
    const mixed = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
    const x = lum(mixed), y = lum(bg);
    return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
  }
  const visible = element => !element.closest("[data-step-leaving]") && element.getBoundingClientRect().height > 0;
  const heading = [...document.querySelectorAll("h1")].find(visible) || null;
  const button = [...document.querySelectorAll(".sa-brand-panel button")].find(element => visible(element) && /^(Continue|Create account|Finish setup|Share and continue|Verify|Next|Finish)$/.test((element.textContent || "").trim())) || null;
  return {
    heading: heading ? ratio(rgba(getComputedStyle(heading).color), behind(heading)) : null,
    button: button ? ratio(rgba(getComputedStyle(button).color), behind(button)) : null,
    detail: "heading " + (heading ? getComputedStyle(heading).color + " on " + behind(heading).map(Math.round).join(",") : "none") + "; button " + (button ? JSON.stringify((button.textContent || "").trim()) + " " + getComputedStyle(button).color + " on " + behind(button).map(Math.round).join(",") : "none"),
  };
})()`;
