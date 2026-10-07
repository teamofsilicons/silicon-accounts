/**
 * Helpers of the account-site suite (web/e2e/suites/account-site): a fresh Carbon in a browser context of its own, an
 * unwatched "probe" page for API calls with that browser's cookies, signing into a fake app through its hosted link,
 * the fake apps' webhook inboxes, a decodable PNG, and the site's own timezone and date words.
 *
 * Every journey of the suite makes its own Carbons (random emails), so journeys never depend on each other.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { E2E_DIR, codeFor, json, lastSeq, newContext, randomIp, signInOnSite, sleep, sql, tag, type Env } from "../../lib";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Carbons                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Carbon {
  context: BrowserContext;
  /** The page journeys walk (watched by the journey). */
  page: Page;
  /**
   * An unwatched page on the site's origin (`/sdk/v1.js`) for direct API calls with this browser's session cookie and
   * forwarded address. Deliberate 4xx answers made here never show up as browser problems of the walked page.
   */
  probe: Page;
  email: string;
  id: string;
  uuid: string;
  ip: string;
  displayName: string;
}

export interface Me {
  uuid: string;
  kind: string;
  id: string;
  display_name: string;
  pfp_url: string;
  dob: string;
  timezone: string;
  status: string;
  created_at: string;
  version: number;
  emails: Array<{ email: string; is_primary: boolean; verified_at: string | null; verified_via?: string | null }>;
  phones: Array<{ phone: string; is_primary: boolean; verified_at: string | null }>;
  identities: Array<{ provider: string; subject: string; email: string | null; created_at: string; last_used_at: string | null }>;
  custodian_of: number;
}

/**
 * Opens a probe page (unwatched) on the site's origin. It shows the SDK file as text: a same-origin document that runs
 * nothing and has no CSP of its own (the API's JSON answers carry `default-src 'none'`, which would block fetch).
 */
export async function probePage(env: Env, context: BrowserContext): Promise<Page> {
  const probe = await context.newPage();
  await probe.goto(`${env.site}/sdk/v1.js`);
  return probe;
}

/**
 * Signs up a new Carbon on the account site (/sign-in with an email code, then the prefilled sign-up page) in a
 * browser context of its own (its own forwarded address), and opens a probe page next to the walked page.
 */
export async function newCarbon(ctx: Ctx, label: string, options: { email?: string; watch?: RegExp[] } = {}): Promise<Carbon> {
  const { env, browser, results } = ctx;
  const ip = randomIp();
  const context = await newContext(browser, { forwardedFor: ip });
  const page = await context.newPage();
  results.watch(page, label, options.watch ?? []);
  const email = options.email ?? `${label.replace(/[^a-z0-9]+/g, ".")}.${tag()}@example.test`;
  await signInOnSite(env, page, email);
  const probe = await probePage(env, context);
  const me = await getMe(probe);
  return { context, page, probe, email, id: me.id, uuid: me.uuid, ip, displayName: me.display_name };
}

/** A second browser signed in to an existing Carbon (another session, another address). */
export async function signInAgain(ctx: Ctx, email: string, label: string, watch: RegExp[] = []): Promise<{ context: BrowserContext; page: Page; probe: Page; ip: string }> {
  const ip = randomIp();
  const context = await newContext(ctx.browser, { forwardedFor: ip });
  const page = await context.newPage();
  ctx.results.watch(page, label, watch);
  await signInOnSite(ctx.env, page, email);
  return { context, page, probe: await probePage(ctx.env, context), ip };
}

export interface Answer<T> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

export interface CallInit {
  method?: string;
  json?: unknown;
  /** A binary body (base64 here, bytes in the page), sent with `contentType`. */
  bytes?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Calls the site's API from inside `page` (same origin: the browser adds its cookies, its Origin header on writes,
 * and the context's forwarded address), exactly as the site's own code does.
 */
export async function call<T = Record<string, unknown>>(page: Page, path: string, init: CallInit = {}): Promise<Answer<T>> {
  const payload = { path, method: init.method ?? "GET", json: init.json === undefined ? null : JSON.stringify(init.json), b64: init.bytes ? init.bytes.toString("base64") : null, contentType: init.contentType ?? null, headers: init.headers ?? {} };
  return page.evaluate(async p => {
    const headers: Record<string, string> = { ...p.headers };
    let body: BodyInit | undefined;
    if (p.json !== null) {
      headers["content-type"] = "application/json";
      body = p.json;
    } else if (p.b64 !== null) {
      const raw = atob(p.b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      body = bytes;
      if (p.contentType) headers["content-type"] = p.contentType;
    }
    const response = await fetch(p.path, { method: p.method, headers, body, credentials: "same-origin", cache: "no-store" });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON.
    }
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    return { status: response.status, body: parsed, headers: out };
  }, payload) as Promise<Answer<T>>;
}

export const getMe = async (probe: Page): Promise<Me> => (await call<Me>(probe, "/v1/me")).body;

/**
 * Sends `times` requests of `size` bytes (starting with `head`, the rest `fill` bytes) to `path` from inside `page`, one
 * after another, and returns each status and the start of each answer (the bytes are made in the page, not shipped to
 * it). A request the browser could not complete (a reset connection) is status 0 with the error.
 */
export async function oversizedUploads(page: Page, path: string, head: Buffer, size: number, times: number, contentType: string, options: { method?: string; fill?: number } = {}): Promise<Array<{ status: number; text: string }>> {
  return page.evaluate(async p => {
    const raw = atob(p.head);
    const bytes = new Uint8Array(p.size);
    if (p.fill) bytes.fill(p.fill);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const out: Array<{ status: number; text: string }> = [];
    for (let i = 0; i < p.times; i++) {
      try {
        const response = await fetch(p.path, { method: p.method, headers: { "content-type": p.contentType }, body: bytes, credentials: "same-origin" });
        out.push({ status: response.status, text: (await response.text()).slice(0, 160) });
      } catch (error) {
        out.push({ status: 0, text: String(error).slice(0, 160) });
      }
    }
    return out;
  }, { path, head: head.toString("base64"), size, times, contentType, method: options.method ?? "POST", fill: options.fill ?? 0 });
}

/**
 * POSTs `body` to `url` from this process the way curl sends a big upload: with `Expect: 100-continue`, the body only
 * once the server says `100 Continue`. Returns the answer, whether the server asked for the body (`continued`), and how
 * long the whole exchange took. A request that breaks (a reset connection, no answer within 30 s) is status 0.
 */
export function expectContinuePost(url: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; text: string; continued: boolean; ms: number }> {
  return new Promise(done => {
    const started = Date.now();
    const target = new URL(url);
    let continued = false;
    let settled = false;
    const finish = (status: number, text: string) => {
      if (settled) return;
      settled = true;
      done({ status, text: text.slice(0, 200), continued, ms: Date.now() - started });
      request.destroy();
    };
    const request = httpRequest({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "POST", headers: { ...headers, "content-length": String(body.length), expect: "100-continue" } });
    request.on("continue", () => {
      continued = true;
      request.end(body);
    });
    request.on("response", response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => finish(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
      response.on("error", error => finish(0, `the answer broke off: ${String(error)}`));
    });
    request.on("error", error => finish(0, String(error)));
    request.setTimeout(30_000, () => finish(0, "no answer within 30 s"));
    request.flushHeaders();
  });
}

/** `error.code` of an API error body, or "". */
export const codeOf = (body: unknown): string => {
  const error = (body as { error?: { code?: string } | string } | null)?.error;
  return typeof error === "string" ? error : error?.code ?? "";
};
export const messageOf = (body: unknown): string => ((body as { error?: { message?: string } } | null)?.error?.message ?? "");
export const hintOf = (body: unknown): string => ((body as { error?: { hint?: string } } | null)?.error?.hint ?? "");

/** Adds and verifies an email (or phone) through the API, the way the site does: POST, the code, POST …/verify. */
export async function addContact(env: Env, probe: Page, channel: "email" | "phone", value: string): Promise<Answer<unknown>> {
  const route = channel === "email" ? "/v1/me/emails" : "/v1/me/phones";
  const after = await lastSeq(env);
  const started = await call<{ challenge_id?: string }>(probe, route, { method: "POST", json: channel === "email" ? { email: value } : { phone: value } });
  if (started.status !== 201 || !started.body.challenge_id) return started;
  const code = await codeFor(env, value, after);
  return call(probe, `${route}/verify`, { method: "POST", json: { challenge_id: started.body.challenge_id, code } });
}

/** A random valid US number (+1 202 [2-9]XX XXXX), so numbers never repeat within a stack. */
export function randomPhone(): string {
  const exchange = 2 + Math.floor(Math.random() * 8);
  const rest = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `+1202${exchange}${rest}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Fake apps                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FakeApp {
  app_id: string;
  name: string;
  secret: string;
}

const FAKE_APPS: FakeApp[] = (() => {
  try {
    const raw = JSON.parse(readFileSync(resolve(E2E_DIR, "../../testkit/fake-apps.json"), "utf8")) as { apps?: FakeApp[] };
    return raw.apps ?? [];
  } catch {
    return [];
  }
})();

/** `Authorization: Basic …` of a fake app (its fixed development secret). */
export function appAuth(appId: string): string {
  const app = FAKE_APPS.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`no fake app ${appId} in testkit/fake-apps.json`);
  return `Basic ${Buffer.from(`${app.app_id}:${app.secret}`).toString("base64")}`;
}

export const appName = (appId: string): string => FAKE_APPS.find(entry => entry.app_id === appId)?.name ?? appId;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\:/]/g, "\\$&");

/**
 * Signs the browser's Carbon into a fake app through the app's hosted link: "Continue as" (the browser is signed in to
 * the account site), the consent ("Share and continue") when the app asks, back at the app. Returns the account the app
 * received (its `<pre id="account">`). `share` names optional details (their labels, e.g. "Timezone") to switch on at
 * the consent; the others stay off, as they start.
 */
export async function signIntoApp(env: Env, page: Page, app: string, options: { share?: string[] } = {}): Promise<Record<string, unknown> | null> {
  await page.goto(`${env.apps}/${app}/`);
  // Clicked as soon as the page has loaded, as a Carbon would. The app's page also holds the embed iframe and the SDK,
  // which may still be reading the app's config: leaving cuts those reads off (WebKit cuts them before or after the
  // answer's headers). The embed and the SDK retry a cut-off read before they report anything, so a click this early
  // must not leave a browser problem behind (round 1 waited for the page to settle, to step around that defect).
  await page.locator("#signin-hosted").click();
  const back = new RegExp(`^${escapeRe(env.apps)}/${app}/(callback|signed-in)`);
  const continueAs = page.getByRole("button", { name: /^Continue as/ });
  const share = page.getByRole("button", { name: "Share and continue" });
  for (let step = 0; step < 6; step++) {
    if (back.test(page.url())) break;
    const next = await Promise.race([
      page.waitForURL(back, { timeout: 30_000 }).then(() => "back" as const),
      continueAs.waitFor({ timeout: 30_000 }).then(() => "continue" as const),
      share.waitFor({ timeout: 30_000 }).then(() => "share" as const),
    ]).catch(() => "timeout" as const);
    if (next === "back") break;
    if (next === "timeout") throw new Error(`signing into ${app}: no Continue as, consent or return within 30 s (at ${page.url()})`);
    await sleep(250);
    if (next === "continue") {
      await continueAs.click();
    } else {
      for (const label of options.share ?? []) {
        const toggle = page.getByRole("switch", { name: new RegExp(`^${escapeRe(label)}`) });
        if ((await toggle.getAttribute("aria-checked", { timeout: 5_000 })) !== "true") await toggle.click();
      }
      await share.click();
    }
    await sleep(400);
  }
  await page.locator("#account").waitFor({ timeout: 30_000 });
  const raw = await page.locator("#account").innerText().catch(() => "");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface InboxEvent {
  seq: number;
  event_id: string;
  type: string;
  received_at: string;
  payload: { event_id: string; type: string; app_id: string | null; data: Record<string, unknown> & { uuid?: string } };
}

/** Waits for a webhook event of `type` about `uuid` that the fake app accepted (its signature checked), or null. */
export async function waitEvent(env: Env, app: string, type: string, uuid: string, options: { after?: number; timeoutMs?: number } = {}): Promise<InboxEvent | null> {
  const query = new URLSearchParams({ type, uuid, timeout_ms: String(options.timeoutMs ?? 20_000) });
  if (options.after !== undefined) query.set("after", String(options.after));
  const answer = await json<InboxEvent>(`${env.apps}/${app}/_events/wait?${query}`);
  return answer.status === 200 ? answer.body : null;
}

/**
 * When the page sends its next `method` request whose path ends with `suffix` (Date.now() at that moment): start it
 * before the action, await it after.
 */
export function requestSent(page: Page, method: string, suffix: string, timeoutMs = 30_000): Promise<number> {
  return page.waitForRequest(request => request.method() === method && new URL(request.url()).pathname.endsWith(suffix), { timeout: timeoutMs }).then(() => Date.now(), () => Number.NaN);
}

/** Milliseconds from `sentAt` until the fake app received `event` (its own clock, the same machine). */
export const deliveredAfter = (event: InboxEvent | null, sentAt: number): number => (event ? Date.parse(event.received_at) - sentAt : Number.NaN);

/** Every event about `uuid` a fake app accepted (newest first), and its refused deliveries. */
export async function inbox(env: Env, app: string, uuid?: string): Promise<{ items: InboxEvent[]; last_seq: number; rejected: Array<{ type: string | null; reason: string }> }> {
  const query = new URLSearchParams({ include_rejected: "1" });
  if (uuid) query.set("uuid", uuid);
  const answer = await json<{ items?: InboxEvent[]; last_seq?: number; rejected?: Array<{ type: string | null; reason: string }> }>(`${env.apps}/${app}/_events?${query}`);
  return { items: answer.body.items ?? [], last_seq: answer.body.last_seq ?? 0, rejected: answer.body.rejected ?? [] };
}

/** How many webhook events of `type` the service queued for `target` (an app id) about `uuid` (read from the database). */
export async function queuedEvents(env: Env, target: string, uuid: string, type: string, extra = ""): Promise<number> {
  const [[count] = []] = await sql(env, `select count(*) from webhook_events where target_id = '${target}' and account_uuid = '${uuid}' and type = '${type}' ${extra}`);
  return Number(count ?? 0);
}

/** The fake app's refresh of the tokens it holds for `uuid` (`POST /<app>/refresh`): status and the error code. */
export async function appRefresh(env: Env, app: string, uuid: string): Promise<{ status: number; error: string }> {
  const answer = await json<{ ok?: boolean; status?: number; error?: { error?: string } | string }>(`${env.apps}/${app}/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid }) });
  const error = typeof answer.body.error === "string" ? answer.body.error : answer.body.error?.error ?? "";
  return { status: answer.body.status ?? answer.status, error };
}

/** The fake app's GET /v1/userinfo with the access token it holds for `uuid`: the status Silicon Accounts answered. */
export async function appUserinfo(env: Env, app: string, uuid: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await json<{ status?: number; body?: Record<string, unknown> }>(`${env.apps}/${app}/userinfo?uuid=${encodeURIComponent(uuid)}`);
  return { status: answer.body.status ?? answer.status, body: answer.body.body ?? {} };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The pages                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The text of `main`, whitespace collapsed. */
export const mainText = async (page: Page): Promise<string> => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");

/** Waits until `read()` satisfies `ok` (polling), returning the last value read. */
export async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 10_000, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(everyMs);
    value = await read();
  }
  return value;
}

/** The live status line of an id field (IdField), once it settled (not "Checking…" nor empty). */
export async function idStatus(scope: Locator | Page, settled: (text: string) => boolean = text => !!text && text !== "Checking…"): Promise<string> {
  const line = scope.locator('p[role="status"][data-tone]').first();
  return until(async () => (await line.innerText().catch(() => "")).trim(), settled, 12_000);
}

/** The rows of an AnimatedRows list (role=list with this name): each row's text, whitespace collapsed. */
export async function rowsOf(page: Page, listName: string): Promise<string[]> {
  const rows = page.getByRole("list", { name: listName, exact: true }).locator(':scope > [role="listitem"]:not([data-leaving])');
  return (await rows.allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
}

/** The row of an AnimatedRows list whose data-key is `key`. */
export const rowByKey = (page: Page, listName: string, key: string): Locator =>
  page.getByRole("list", { name: listName, exact: true }).locator(`:scope > [role="listitem"][data-key="${key.replace(/"/g, '\\"')}"]`);

/** Presses a ConfirmMorph inside `scope`: its trigger (`label`), then the confirm button of the question it asks. */
export async function confirmMorph(scope: Locator, label: string, confirm = label): Promise<void> {
  await scope.getByRole("button", { name: label, exact: true }).first().click();
  const question = scope.getByRole("group").filter({ has: scope.page().getByRole("button", { name: confirm, exact: true }) }).last();
  await question.getByRole("button", { name: confirm, exact: true }).click({ timeout: 10_000 });
}

/** Holds a button for `ms` (HoldToConfirm) with the mouse. */
export async function hold(page: Page, button: Locator, ms: number): Promise<void> {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error("the hold button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

/**
 * The headings inside `main` in document order, as assistive tech lists them (visually hidden ones included, anything
 * under aria-hidden, `hidden` or display:none left out), with every place the outline skips a level ("h1 → h3", or a
 * first heading that is not an h1), the number of h1s, and the number of main landmarks on the page.
 */
export async function headingOutline(page: Page): Promise<{ headings: string[]; skips: string[]; h1: number; mains: number }> {
  return page.evaluate(() => {
    const found: Array<{ level: number; text: string }> = [];
    for (const element of Array.from(document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6, main [role=heading]"))) {
      let hidden = false;
      for (let node: Element | null = element; node && !hidden; node = node.parentElement) {
        const style = getComputedStyle(node);
        hidden = node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden";
      }
      if (hidden) continue;
      const tag = /^H([1-6])$/.exec(element.tagName);
      found.push({ level: Number(element.getAttribute("aria-level") ?? tag?.[1] ?? 2), text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48) });
    }
    const skips: string[] = [];
    if (found[0] && found[0].level !== 1) skips.push(`starts at h${found[0].level} "${found[0].text}"`);
    for (let i = 1; i < found.length; i++) {
      const before = found[i - 1]!;
      const now = found[i]!;
      if (now.level > before.level + 1) skips.push(`h${before.level} "${before.text}" → h${now.level} "${now.text}"`);
    }
    return { headings: found.map(item => `h${item.level} ${item.text}`), skips, h1: found.filter(item => item.level === 1).length, mains: document.querySelectorAll("main").length };
  });
}

/** How many CSS pixels the page is wider than the window (0 or less: no horizontal scroll). */
export const overflowX = (page: Page): Promise<number> => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);

/** The activity timeline's rows on /activity (title and meta of each), whitespace collapsed. */
export async function timelineRows(page: Page): Promise<string[]> {
  const region = page.getByRole("region", { name: "Account activity" });
  await region.waitFor({ timeout: 20_000 }).catch(() => undefined);
  return (await region.locator("li").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Words the site uses                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** "Asia/Kolkata" → "Kolkata, Asia" (web/lib/timezones.ts timezoneLabel). */
export function timezoneLabel(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "Coordinated Universal Time";
  const parts = zone.split("/");
  const city = (parts[parts.length - 1] ?? zone).replace(/_/g, " ");
  const region = parts.length > 1 ? parts.slice(0, -1).join(" / ").replace(/_/g, " ") : "";
  return region ? `${city}, ${region}` : city;
}

/** "+05:30" (web/lib/timezones.ts utcOffset). */
export function utcOffset(zone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at);
  const name = parts.find(part => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return match ? `${match[1]}:${match[2] ?? "00"}` : "+00:00";
}

/** "Oct 17, 2026" for a moment, in `zone` (web/lib/format.ts formatDate); a YYYY-MM-DD date reads as itself. */
export function formatDate(value: string | number | Date, zone = "Asia/Kolkata"): string {
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = dateOnly ? new Date(`${value as string}T00:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: dateOnly ? "UTC" : zone }).format(date);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A real (decodable) PNG                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A width×height RGBA PNG of one colour with a darker diagonal (browsers decode it; the service reads its header). */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 4;
      const edge = Math.abs(x - y) < 3;
      raw[at] = edge ? rgb[0] >> 1 : rgb[0];
      raw[at + 1] = edge ? rgb[1] >> 1 : rgb[1];
      raw[at + 2] = edge ? rgb[2] >> 1 : rgb[2];
      raw[at + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The smallest JPEG header the service recognises (SOI + SOF0 of width×height + EOI); not decodable, only sniffable. */
export function jpegHeader(width = 8, height = 8): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
}
