/**
 * Helpers of the v2-flows suite: UNDERSTANDING.md v2 ("What's shared with the app", "Flows", "Adding sign-in to an
 * app", "Proofs") and build spec 06-v2.md — the details pages of an app's flow and its review page, intents, direct
 * method buttons, the Opening Google/Apple page, no login_hint, the embed's and the SDK's Sign in / Sign up buttons,
 * and App verification proofs for exactly one app.
 *
 * Everything here talks to the stack the way an app, a Carbon's browser or an app's owner would: the fake apps'
 * credentials (Basic) for an app's own sign-in setup, the browser's own cookies for the hosted flow's API, and the
 * stack's database only to read what the API does not say (membership scopes, stored flows) or to move time.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { api, appAccount, appUrl, codeFor, fakeApp, forwardAs, lastSeq, live, randomIp, readFlow, signInWithCode, sleep, sql, tag, type Env, type FlowSeen, type JsonAnswer } from "../../lib";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Fresh identities                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A new email for this run (the stack's database may be walked again with --keep). */
export const freshEmail = (label: string) => `v2f.${label}.${tag()}${tag().slice(0, 2)}@example.test`;

const usedPhones = new Set<string>();

/** A US number (+1 202 555 xxxx) no account of the stack has yet. */
export async function freshPhone(env: Env): Promise<string> {
  for (let tries = 0; tries < 60; tries++) {
    const phone = `+1202555${String(Math.floor(1000 + Math.random() * 9000))}`;
    if (usedPhones.has(phone)) continue;
    usedPhones.add(phone);
    const taken = await sql(env, `select 1 from account_phones where phone = '${phone}'`);
    if (!taken.length) return phone;
  }
  throw new Error("no free +1 202 555 number left after 60 tries");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* An app's sign-in setup (with its own credentials)                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export const basicAuth = (appId: string) => `Basic ${Buffer.from(`${appId}:${fakeApp(appId).secret}`).toString("base64")}`;

export interface ApiErrorBody {
  code?: string;
  message?: string;
  hint?: string | null;
  details?: Record<string, unknown> & { fields?: Record<string, string> };
}

export interface AppDetails {
  app_id?: string;
  config_version?: number;
  signin_config: Record<string, unknown> & { flow?: unknown; required_fields?: string[]; optional_fields?: string[]; copy?: Record<string, unknown> };
  error?: ApiErrorBody;
}

type CallCtx = { env: Env; ip: string };

/** GET /v1/apps/{app_id} with the app's own credentials: its sign-in setup and config_version. */
export async function appDetails(ctx: CallCtx, appId: string): Promise<AppDetails> {
  const answer = await api<AppDetails>(ctx, `/v1/apps/${appId}`, { direct: true, headers: { authorization: basicAuth(appId) } });
  if (answer.status !== 200 || !answer.body?.signin_config) throw new Error(`GET /v1/apps/${appId} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`);
  return answer.body;
}

/** PATCH /v1/apps/{app_id}/signin-config with the app's own credentials (objects merge, arrays and scalars replace). */
export function patchConfig(ctx: CallCtx, appId: string, patch: Record<string, unknown>): Promise<JsonAnswer<AppDetails>> {
  return api<AppDetails>(ctx, `/v1/apps/${appId}/signin-config`, {
    method: "PATCH",
    direct: true,
    headers: { authorization: basicAuth(appId), "idempotency-key": `v2f-${Date.now()}-${tag()}` },
    json: patch,
  });
}

/**
 * Runs `body` while the app's sign-in setup has `patch` applied, then puts the whole setup back as it was (the stored
 * flow follows changed details, so restoring a field list alone could leave a detail on another page).
 */
export async function withConfig<T>(ctx: CallCtx, appId: string, patch: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const before = (await appDetails(ctx, appId)).signin_config;
  const applied = await patchConfig(ctx, appId, patch);
  if (applied.status !== 200) throw new Error(`PATCH /v1/apps/${appId}/signin-config ${JSON.stringify(patch).slice(0, 200)} answered ${applied.status}: ${JSON.stringify(applied.body).slice(0, 400)}`);
  try {
    return await body();
  } finally {
    await restoreConfig(ctx, appId, before);
  }
}

/** Puts an app's whole sign-in setup back (a PATCH of the document GET returned) and checks it took. */
export async function restoreConfig(ctx: CallCtx, appId: string, before: AppDetails["signin_config"]): Promise<void> {
  const answer = await patchConfig(ctx, appId, before);
  if (answer.status !== 200) throw new Error(`restoring ${appId}'s sign-in setup answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 400)}`);
  const now = (await appDetails(ctx, appId)).signin_config;
  const same = (key: string) => JSON.stringify(now[key] ?? null) === JSON.stringify(before[key] ?? null);
  const differs = ["required_fields", "optional_fields", "flow", "copy", "methods", "branding"].filter(key => !same(key));
  if (differs.length) throw new Error(`${appId}'s sign-in setup did not go back as it was (${differs.join(", ")} differ)`);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The hosted flow, as the Carbon's browser                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The flow id of the hosted page on screen (/authorize/flow/{id}), or null. */
export function flowIdOf(page: Page): string | null {
  try {
    return /^\/authorize\/flow\/([^/?#]+)/.exec(new URL(page.url()).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export type FlowAnswer = JsonAnswer<{ flow?: FlowSeen & Record<string, unknown>; error?: ApiErrorBody }>;

/**
 * Calls the hosted flow's API with the browser's own cookies (the flow's binding cookie and the session), the way the
 * hosted page does: `GET /v1/flows/{id}` for "" and POST `path` with `body` otherwise (with the site's Origin, which the
 * API's CSRF guard wants).
 */
export async function flowApi(env: Env, page: Page, id: string, path: string, body?: unknown, ip?: string): Promise<FlowAnswer> {
  const url = `${env.site}/v1/flows/${id}${path}`;
  const headers: Record<string, string> = { origin: env.site, ...(ip ? { "x-forwarded-for": ip } : {}) };
  const response =
    path === ""
      ? await page.request.get(url, { headers })
      : await page.request.post(url, { headers: { ...headers, "content-type": "application/json" }, data: JSON.stringify(body ?? {}) });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status(), body: parsed as FlowAnswer["body"], headers: new Headers(response.headers()) };
}

/** Polls the flow (the browser's cookies) until `until` holds; returns it. */
export async function waitForFlow(page: Page, until: (flow: FlowSeen) => boolean, what: string, timeoutMs = 30_000): Promise<FlowSeen> {
  const deadline = Date.now() + timeoutMs;
  let last: FlowSeen | null = null;
  while (Date.now() < deadline) {
    last = await readFlow(page).catch(() => null);
    if (last && until(last)) return last;
    await sleep(150);
  }
  throw new Error(`the hosted flow never reached ${what} within ${Math.round(timeoutMs / 1000)} s (it is at ${last?.step ?? "an unknown step"} on ${page.url()})`);
}

export const DETAILS_LIST = 'ul[aria-label^="Details shared with"]';
export const REVIEW_LIST = 'ul[aria-label^="Shared with"]';

/** One row of a details page as drawn: the detail, required or optional, missing, its checkbox, its words. */
export interface RowSeen {
  field: string;
  mode: "required" | "optional";
  missing: boolean;
  /** An optional detail's checkbox (null for a required one or the profile). */
  ticked: boolean | null;
  /** The checkbox is disabled (a missing optional detail cannot be ticked). */
  disabled: boolean | null;
  /** "Required", "Always", or "Optional" as the row labels itself. */
  tag: string;
  /** The row has the "New" badge (the app asks for it for the first time). */
  isNew: boolean;
  /** The row offers "Add" (a missing email or phone). */
  add: boolean;
  text: string;
}

/** The rows of the details page on screen (the page morphing out is skipped). */
export function detailRows(page: Page): Promise<RowSeen[]> {
  return live(page, `${DETAILS_LIST} > li`).evaluateAll(items =>
    items.map(item => {
      const box = item.querySelector('[role="checkbox"]');
      const words = (item as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      const tag = /\bRequired\b/.test(words) ? "Required" : /\bAlways\b/.test(words) ? "Always" : /\bOptional\b/.test(words) ? "Optional" : "";
      return {
        field: item.getAttribute("data-field") ?? "",
        mode: (item.hasAttribute("data-optional") ? "optional" : "required") as "required" | "optional",
        missing: item.hasAttribute("data-missing"),
        ticked: box ? box.getAttribute("aria-checked") === "true" : null,
        disabled: box ? box.hasAttribute("disabled") || box.getAttribute("aria-disabled") === "true" || box.hasAttribute("data-disabled") : null,
        tag,
        isNew: /\bNew\b/.test(words),
        add: [...item.querySelectorAll("button")].some(button => (button.textContent ?? "").trim() === "Add"),
        text: words,
      };
    }),
  );
}

/** "Step 2 of 3" on the page on screen, or null. */
export function progressText(page: Page): Promise<string | null> {
  return live(page, "span").filter({ hasText: /^Step \d+ of \d+$/ }).first().innerText({ timeout: 800 }).catch(() => null);
}

/**
 * Waits until the browser shows the details page the server is on (`index` of `count`, by its id), drawn and not
 * morphing: the flow says so, the list is visible, and a multi-page sign-in shows "Step n of m".
 */
export async function waitForDetailsPage(page: Page, expect: { id?: string; index?: number } = {}, timeoutMs = 30_000): Promise<FlowSeen> {
  const flow = await waitForFlow(page, f => f.step === "details" && !!f.details && (expect.id === undefined || f.details.id === expect.id) && (expect.index === undefined || f.details.index === expect.index), `the details page ${expect.id ?? expect.index ?? ""}`, timeoutMs);
  const details = flow.details!;
  await live(page, DETAILS_LIST).first().waitFor({ timeout: timeoutMs });
  if (details.count > 1) await live(page, "span").filter({ hasText: new RegExp(`^Step ${details.index + 1} of ${details.count}$`) }).first().waitFor({ timeout: timeoutMs });
  // Rows of the page that arrived (a page with another set of details may still be leaving).
  const want = details.fields.map(field => field.field).filter(field => field !== "profile").sort().join(",");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await detailRows(page).catch(() => [])).map(row => row.field).filter(field => field !== "profile").sort().join(",");
    if (rows === want) break;
    await sleep(100);
  }
  await sleep(250);
  return flow;
}

/** Lets the card's morph between pages finish (for screenshots: a page sliding in is clipped at its edge meanwhile). */
export async function settle(page: Page): Promise<void> {
  await sleep(500);
  await page.waitForFunction(() => !document.querySelector("[data-step-leaving]") && document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity), undefined, { timeout: 3_000 }).catch(() => undefined);
  await sleep(250);
}

/** Waits for the review page (the flow at `review` and its list on screen). */
export async function waitForReviewPage(page: Page, timeoutMs = 30_000): Promise<FlowSeen> {
  const flow = await waitForFlow(page, f => f.step === "review" && !!f.review, "the review page", timeoutMs);
  await live(page, REVIEW_LIST).first().waitFor({ timeout: timeoutMs });
  await sleep(250);
  return flow;
}

/** The fields the review page lists as shared, in its order. */
export function reviewFields(page: Page): Promise<string[]> {
  return live(page, `${REVIEW_LIST} > li`).evaluateAll(items => items.map(item => item.getAttribute("data-field") ?? ""));
}

/** Ticks (or unticks) an optional detail's checkbox on the page on screen and waits until it shows that. */
export async function setTicked(page: Page, field: string, want: boolean): Promise<void> {
  const selector = `${DETAILS_LIST} > li[data-field="${field}"] [role="checkbox"]`;
  const box = live(page, selector).first();
  await box.waitFor({ timeout: 10_000 });
  if ((await box.getAttribute("aria-checked")) !== String(want)) await box.click();
  await page.waitForFunction(
    ([css, value]) => [...document.querySelectorAll(css!)].some(element => !element.closest("[data-step-leaving]") && element.getAttribute("aria-checked") === value),
    [selector, String(want)] as const,
    { timeout: 5_000 },
  );
}

/** The page's main button by its exact label ("Continue", "Review", "Start messaging", "Share and continue"…). */
export const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/**
 * lib.ts signInWithCode for any app: an app whose field starts on Phone (dm's method order is phone, email) shows
 * "Email | Phone", so an email sign-in picks Email first.
 */
export async function codeSignIn(env: Env, page: Page, who: { email: string } | { phone: string }): Promise<string> {
  if ("email" in who) {
    await page.getByRole("textbox", { name: /^(Email|Phone number)$/ }).first().waitFor({ timeout: 30_000 });
    const choice = page.getByRole("button", { name: "Email", exact: true });
    if (await choice.isVisible().catch(() => false)) await choice.click();
  }
  return signInWithCode(env, page, who);
}

/** The layout the hosted page is drawn in (card, split or minimal). */
export const drawnLayout = (page: Page) => page.locator("[data-paint][data-layout]").first().getAttribute("data-layout").catch(() => null);

/**
 * Adds a missing email or phone on the details page on screen: opens its adder when it is not open yet (a required one
 * opens by itself), types the address or number, Send code, and the code that arrives; waits until the row is no
 * longer missing. Returns the code.
 */
export async function addOnPage(env: Env, page: Page, field: "email" | "phone", value: string): Promise<string> {
  const adder = live(page, `[data-adding="${field}"]`).first();
  if (!(await adder.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: new RegExp(`^Add (your|a) ${field === "email" ? "email address" : "phone number"}$`) }).first().click({ timeout: 10_000 });
    await adder.waitFor({ timeout: 10_000 });
  }
  await sendOnPage(env, page, field, value);
  const code = await codeFor(env, field === "email" ? value.toLowerCase() : value, sentAfter);
  await typeCode(page, code);
  await live(page, `${DETAILS_LIST} > li[data-field="${field}"]:not([data-missing])`).first().waitFor({ timeout: 15_000 });
  return code;
}

let sentAfter = 0;

/** In the open adder: types the email or phone and presses Send code (the code is not typed). */
export async function sendOnPage(env: Env, page: Page, field: "email" | "phone", value: string): Promise<void> {
  const adder = live(page, `[data-adding="${field}"]`).first();
  sentAfter = await lastSeq(env);
  if (field === "email") {
    const input = adder.getByRole("textbox", { name: "Email" });
    await input.waitFor({ timeout: 10_000 });
    await input.fill(value);
  } else {
    const input = adder.getByRole("textbox", { name: "Phone number" });
    await input.waitFor({ timeout: 10_000 });
    await input.click();
    await input.fill("");
    await page.keyboard.type(value, { delay: 20 });
  }
  await adder.getByRole("button", { name: "Send code" }).click();
}

/**
 * Waits for the code entry and types the code into it (clicking its first cell when the focus is elsewhere, as after
 * "Send a new code").
 */
export async function typeCode(page: Page, code: string): Promise<void> {
  const group = page.getByRole("group", { name: /^Code from the/ }).first();
  await group.waitFor({ timeout: 15_000 });
  const inside = await group.evaluate(element => element.contains(document.activeElement)).catch(() => false);
  if (!inside) await group.locator("input:not(:disabled)").first().click({ timeout: 10_000 });
  await page.keyboard.type(code, { delay: 25 });
}

/** The response errors the browser logs when the hosted page gets the refusals a journey asks for. */
export const refusal = (status: number, path: string) => new RegExp(`status of ${status} \\([^)]*\\) @ https?://[^ ]+/v1/flows/[^/ ]+/${path.replace(/\//g, "\\/")}`);

/** The last code the mock email/SMS server got for `to` after the last sendOnPage (or `after`). */
export const codeSentTo = (env: Env, to: string, after = sentAfter) => codeFor(env, to, after);

/** What the fake app got back: the account it received, the token's scope, or the error it was sent back with. */
export interface AppOutcome {
  account: Record<string, unknown> | null;
  scope: string[];
  error: string | null;
  url: string;
}

/** Waits until the browser is back at the fake app, then reads what it received. */
export async function backAtApp(env: Env, page: Page, app: string, timeoutMs = 30_000): Promise<AppOutcome> {
  await page.waitForURL(appUrl(env, app), { timeout: timeoutMs });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  const error = await page.locator("#error-code").innerText({ timeout: 1_500 }).catch(() => null);
  if (error) return { account: null, scope: [], error: error.trim(), url: page.url() };
  await page.locator("#account").waitFor({ timeout: 10_000 }).catch(() => undefined);
  const account = await appAccount(page);
  const token = await page.locator("#token").innerText({ timeout: 2_000 }).catch(() => "");
  let scope: string[] = [];
  try {
    const parsed = JSON.parse(token) as { scope?: string | null };
    scope = (parsed.scope ?? "").split(/\s+/).filter(Boolean);
  } catch {
    scope = [];
  }
  return { account, scope, error: null, url: page.url() };
}

/** The fake app's error page after a sign-in came back with an error (HTTP 400): expected on watched pages. */
export const appErrorPage = (app: string) => new RegExp(`status of 400 .* @ https?://[^ ]+/${app}/callback\\?`);

/* ------------------------------------------------------------------------------------------------------------------ */
/* The database: what the API does not say                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The account an email belongs to (its uuid), or null. */
export async function uuidByEmail(env: Env, email: string): Promise<string | null> {
  const rows = await sql(env, `select account_uuid from account_emails where email = '${email.toLowerCase().replace(/'/g, "")}'`);
  return rows[0]?.[0] ?? null;
}

/** The account a phone number belongs to (its uuid), or null. */
export async function uuidByPhone(env: Env, phone: string): Promise<string | null> {
  const rows = await sql(env, `select account_uuid from account_phones where phone = '${phone.replace(/'/g, "")}'`);
  return rows[0]?.[0] ?? null;
}

/** The account's membership with an app: its status and the scopes it granted (sorted), or null. */
export async function membershipOf(env: Env, appId: string, uuid: string): Promise<{ status: string; scopes: string[] } | null> {
  const rows = await sql(env, `select status, array_to_string(granted_scopes, ',') from memberships where app_id = '${appId}' and account_uuid = '${uuid.replace(/'/g, "")}'`);
  const row = rows[0];
  if (!row) return null;
  return { status: row[0] ?? "", scopes: (row[1] ?? "").split(",").filter(Boolean).sort() };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browsers                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A browser context like lib.ts newContext (1440×900, Asia/Kolkata, its own forwarded address) that also asks for
 * reduced motion (`prefers-reduced-motion: reduce`).
 */
export async function reducedMotionContext(browser: Browser, env: Env): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", timezoneId: "Asia/Kolkata", locale: "en-US", reducedMotion: "reduce" });
  await forwardAs(context, env.site, randomIp());
  return context;
}

/** Median of a list of numbers (NaN for an empty one). */
export function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The value as an app id (`receiving_app` may be a string, or `{app_id}` in verification answers). */
export const appIdOf = (value: unknown): string | undefined => (typeof value === "string" ? value : value && typeof value === "object" ? (value as { app_id?: string }).app_id : undefined);

/**
 * A page that shows a seeded fake app owner's photo loads it from the production Iris (the stack's accounts-seed runs
 * without ACCOUNTS_IRIS_BASE_URL, so the owners keep the default https://iris.teamofsilicons.com photo). The browser
 * refuses that cross-origin answer (ORB) or fails to reach it; v2-flows-seeded-owner-photos reports it once.
 */
export const SEEDED_OWNER_PHOTO = /requestfailed GET https:\/\/iris\.teamofsilicons\.com\/pfp\//;
