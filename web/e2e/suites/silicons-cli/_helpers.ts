/**
 * Helpers of the silicons-cli suite (Silicons, custodians and the `accounts` CLI). Kept in the suite (README: a helper
 * that lib.ts lacks lives in the suite until the harness owner moves it):
 *
 * - Carbons signed up through the account site's own API flow (`/v1/flows`, about a second each instead of a browser
 *   walk), with their `sa_session` cookie for API calls and for browser contexts;
 * - the real CLI with full control of its environment (`--home`, `--url`, HOME, SILICON_HOME, ACCOUNTS_HOME), a kill
 *   timer, strict JSON parsing of stdout and the JSON lines it writes on stderr in `--json` mode;
 * - webhook receivers: a Silicon's own webhook on the fake app server's generic sinks (`/hooks/<key>`), and the fake
 *   apps' own inboxes (both verify X-Accounts-Signature; refused deliveries are listed);
 * - app credentials (testkit/fake-apps.json), SLT exchanges and token calls as an app.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Cookie, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { E2E_DIR, json, lastSeq, newContext, randomIp, sleep, sql, type Env, type JsonAnswer } from "../../lib";

export const ROOT = resolve(E2E_DIR, "../..");

/** The report recipients UNDERSTANDING.md names (accounts report). */
export const REPORT_RECIPIENTS = ["saketdev12@gmail.com", "shubhastro2@gmail.com", "bugs@teamofsilicons.com"];

export type Json = Record<string, unknown>;

export const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const errOf = (body: unknown): Json => obj(obj(body).error);
export const short = (value: unknown, max = 300): string => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).replace(/\s+/g, " ").slice(0, max);

/** Runs `work` over `items`, `width` at a time, keeping the order of `items` in the answer. */
export async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]!);
      }
    }),
  );
  return out;
}

/** Polls `probe` until it returns something truthy (or the time is up, then null). */
export async function until<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, intervalMs = 250): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value as T;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Carbons                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The 6-digit code of the next sign-in code email to `to` after message `after`. Only code emails count (lib's codeFor
 * takes the next email of any kind, and a custodian request can land in the same inbox first).
 */
export async function codeEmail(env: Env, to: string, after: number, timeoutMs = 15_000): Promise<string> {
  const query = new URLSearchParams({ to, after: String(after), subject: "is your Silicon Accounts code", timeout_ms: String(timeoutMs) });
  const { status, body } = await json<{ code?: string | null }>(`${env.messaging}/_messages/wait?${query}`);
  if (status !== 200 || !body.code) throw new Error(`no sign-in code reached ${to} after message ${after} (${status} ${short(body)})`);
  return body.code;
}

export interface Carbon {
  email: string;
  id: string;
  uuid: string;
  /** The client address its calls come from (its own per-network limits). */
  ip: string;
  /** The account site's session cookie value (sa_session). */
  session: string;
}

class Jar {
  readonly cookies = new Map<string, string>();
  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string | undefined {
    return this.cookies.size ? [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") : undefined;
  }
}

async function siteCall(env: Env, jar: Jar, ip: string, method: string, path: string, body?: unknown): Promise<JsonAnswer> {
  const headers: Record<string, string> = { origin: env.site, "x-forwarded-for": ip, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${env.site}${path}`, { method, headers, redirect: "manual", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  jar.take(response);
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON.
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/**
 * Signs a new Carbon up through the account site's own sign-in (app `accounts`): email, the code from the mock
 * mailbox, then the prefilled sign-up details (the handle can be chosen). Throws with the step that failed.
 */
export async function signUpCarbon(env: Env, label: string, options: { email?: string; handle?: string } = {}): Promise<Carbon> {
  const t = Math.random().toString(36).slice(2, 8);
  const email = options.email ?? `scli.${label}.${t}@example.test`;
  const ip = randomIp();
  const jar = new Jar();
  const step = async (what: string, method: string, path: string, body?: unknown) => {
    const answer = await siteCall(env, jar, ip, method, path, body);
    if (answer.status >= 300) throw new Error(`signing up ${email}: ${what} answered ${answer.status} ${short(answer.body)}`);
    return answer;
  };
  const created = await step("POST /v1/flows", "POST", "/v1/flows", { app_id: "accounts", redirect_uri: `${env.site}/`, state: `scli-${t}`, timezone: "Asia/Kolkata" });
  const flowId = str(obj(obj(created.body).flow).id);
  const after = await lastSeq(env);
  await step("the email step", "POST", `/v1/flows/${flowId}/email`, { email });
  const code = await codeEmail(env, email, after);
  const verified = await step("the code", "POST", `/v1/flows/${flowId}/verify`, { code });
  const prefill = obj(obj(obj(verified.body).flow).signup);
  if (!prefill.id) throw new Error(`signing up ${email}: the flow did not reach the sign-up step: ${short(verified.body)}`);
  await step("the sign-up details", "POST", `/v1/flows/${flowId}/signup`, {
    display_name: prefill.display_name,
    id: options.handle ? `c:${options.handle}` : prefill.id,
    timezone: prefill.timezone,
    dob: prefill.dob,
  });
  const session = jar.cookies.get("sa_session");
  if (!session) throw new Error(`signing up ${email}: no sa_session cookie after the sign-up step (${[...jar.cookies.keys()].join(", ")})`);
  const me = await step("GET /v1/me", "GET", "/v1/me");
  const body = obj(me.body);
  return { email, id: str(body.id), uuid: str(body.uuid), ip, session };
}

/** An account-site call as this Carbon (session cookie + Origin, as the site's own pages make it). */
export function asCarbon<T = unknown>(env: Env, carbon: Carbon, method: string, path: string, body?: unknown): Promise<JsonAnswer<T>> {
  const jar = new Jar();
  jar.cookies.set("sa_session", carbon.session);
  return siteCall(env, jar, carbon.ip, method, path, body) as Promise<JsonAnswer<T>>;
}

/** A browser context signed in as this Carbon (its session cookie). */
export async function carbonContext(browser: Browser, carbon: Carbon): Promise<BrowserContext> {
  const cookie: Cookie = { name: "sa_session", value: carbon.session, domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" };
  return newContext(browser, { cookies: [cookie] });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The CLI                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Run {
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** The whole of stdout as JSON (null when stdout is not exactly one JSON document). */
  json: Json | null;
  /** The JSON lines on stderr (--json mode: device code, events, warnings). */
  events: Json[];
  timedOut: boolean;
}

export interface RunOptions {
  /** --home <dir> (default: none, so pass one); null leaves the flag out. */
  home?: string | null;
  /** --url <url> (default: the stack's site); null leaves the flag out. */
  url?: string | null;
  stdin?: string;
  /** Extra environment; undefined values remove a variable. ACCOUNTS_* and SILICON_HOME are never inherited. */
  env?: Record<string, string | undefined>;
  /** Kill the process after this long (default 120 s). */
  timeoutMs?: number;
  onEvent?: (event: Json) => void;
}

/** Every temporary directory this suite made (CLI homes hold test tokens): removed when the walk exits. */
const madeDirs: string[] = [];
process.once("exit", () => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, empty directory (a CLI home), removed when the walk exits. */
export const freshDir = (prefix = "sa-e2e-scli-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
};

/**
 * A HOME for every CLI run of this process, so the CLI never reads or writes the real ~/.accounts. Made on first use:
 * every walk imports every suite's journeys, and a walk that runs none of this suite should leave nothing behind.
 */
let sandboxHome: string | null = null;
const sandbox = () => (sandboxHome ??= freshDir("sa-e2e-scli-user-"));

/** Runs the real `accounts` CLI. */
export function accounts(env: Env, args: string[], options: RunOptions = {}): Promise<Run> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("ACCOUNTS_") || key === "SILICON_HOME") continue;
    base[key] = value;
  }
  base.NO_COLOR = "1";
  base.HOME = sandbox();
  base.ACCOUNTS_NO_BROWSER = "1";
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  const full = [...(options.url === null ? [] : ["--url", options.url ?? env.site]), ...(options.home ? ["--home", options.home] : []), ...args];
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(env.cli, full, { env: base });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const events: Json[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => {
      stderr += chunk;
      pending += String(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.startsWith("{")) {
          try {
            const event = JSON.parse(line) as Json;
            events.push(event);
            options.onEvent?.(event);
          } catch {
            // Not a JSON line.
          }
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
    child.on("close", code => {
      clearTimeout(timer);
      let parsed: Json | null = null;
      try {
        const value: unknown = JSON.parse(stdout.trim());
        parsed = value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
      } catch {
        parsed = null;
      }
      done({ args: full, code, stdout, stderr, ms: Date.now() - started, json: parsed, events, timedOut });
    });
  });
}

/** One line about a run for check details. */
export const said = (run: Run) => `exit ${run.code}${run.timedOut ? " (killed: timed out)" : ""} in ${run.ms} ms; stdout ${short(run.stdout, 260)}; stderr ${short(run.stderr, 200)}`;

/** The `{"error":{…}}` a --json run printed, or {}. */
export const cliError = (run: Run): Json => obj(run.json?.error);

/** `accounts login --silicon <id> --stk-stdin --json` in `home`. */
export function loginSilicon(env: Env, home: string, id: string, stk: string, extra: string[] = []): Promise<Run> {
  return accounts(env, ["login", "--silicon", id, "--stk-stdin", "--json", ...extra], { home, stdin: `${stk}\n` });
}

/** Headless email sign-in of a Carbon in `home`: send the code, read it from the mock mailbox, finish with --code. */
export async function loginCarbon(env: Env, home: string, carbon: Carbon): Promise<{ start: Run; finish: Run }> {
  const after = await lastSeq(env);
  const start = await accounts(env, ["login", "--email", carbon.email, "--json"], { home });
  const code = await codeEmail(env, carbon.email, after);
  const finish = await accounts(env, ["login", "--email", carbon.email, "--code", code, "--json"], { home });
  return { start, finish };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Silicons through the API                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface SelfCreated {
  status: number;
  body: Json;
  uuid: string;
  id: string;
  stk: string;
  requestId: string;
  requestToken: string;
  webhookSecret: string;
}

/** POST /v1/silicons (a Silicon creates its own account) from an address of its own. */
export async function selfCreate(ctx: Ctx, body: Json, ip: string = randomIp()): Promise<SelfCreated> {
  const answer = await json<Json>(`${ctx.env.site}/v1/silicons`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "idempotency-key": `scli-${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify(body),
  });
  const out = obj(answer.body);
  return {
    status: answer.status,
    body: out,
    uuid: str(obj(out.silicon).uuid),
    id: str(obj(out.silicon).id),
    stk: str(out.stk),
    requestId: str(obj(out.request).id),
    requestToken: str(out.request_token),
    webhookSecret: str(out.webhook_secret),
  };
}

/** GET /v1/silicons/requests/{id} with the request token (what `--wait` polls). */
export function requestStatus(ctx: Ctx, requestId: string, token: string): Promise<JsonAnswer<Json>> {
  return json<Json>(`${ctx.env.site}/v1/silicons/requests/${requestId}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ctx.ip } });
}

/** POST /v1/silicons/login (si:id + STK) from an address of its own. */
export function siliconLogin(ctx: Ctx, id: string, stk: string, ip: string = randomIp()): Promise<JsonAnswer<Json>> {
  return json<Json>(`${ctx.env.site}/v1/silicons/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ id, stk, client_label: "silicons-cli e2e" }),
  });
}

/** A call with a first-party bearer token (a Silicon's or a CLI Carbon's). */
export function withToken<T = Json>(ctx: Ctx, token: string, method: string, path: string, body?: unknown): Promise<JsonAnswer<T>> {
  return json<T>(`${ctx.env.site}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ctx.ip, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** id availability as an anonymous caller. */
export async function idAvailable(ctx: Ctx, id: string): Promise<Json> {
  const answer = await json<Json>(`${ctx.env.site}/v1/ids/available?id=${encodeURIComponent(id)}`, { headers: { "x-forwarded-for": ctx.ip } });
  return obj(answer.body);
}

/** A custodian request's row (time travel and inspection). */
export async function requestRow(env: Env, requestId: string): Promise<{ status: string; kind: string; createdAt: string; expiresAt: string; ttlSeconds: number; decidedAt: string; decidedBy: string } | null> {
  const rows = await sql(env, `select status, kind, created_at, expires_at, extract(epoch from (expires_at - created_at))::bigint, coalesce(decided_at::text, ''), coalesce(decided_by, '') from custodian_requests where id = '${requestId}'`);
  const row = rows[0];
  if (!row) return null;
  return { status: row[0] ?? "", kind: row[1] ?? "", createdAt: row[2] ?? "", expiresAt: row[3] ?? "", ttlSeconds: Number(row[4]), decidedAt: row[5] ?? "", decidedBy: row[6] ?? "" };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhooks                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface InboxEvent {
  seq: number;
  event_id: string;
  type: string;
  delivery_id: string | null;
  deliveries: number;
  duplicate_count: number;
  recovered: boolean;
  payload: Json;
}

export interface Inbox {
  items: InboxEvent[];
  rejected: Json[];
  deliveries: number;
  last_seq: number;
}

/** A Silicon's own webhook endpoint on the fake app server (a generic sink that verifies signatures). */
export const sinkUrl = (env: Env, key: string) => `${env.apps}/hooks/${key}`;

/** Registers the signing secret the Silicon got (deliveries refused before it are re-checked and recovered). */
export async function setSinkSecret(env: Env, key: string, secret: string): Promise<Json> {
  return obj((await json(`${env.apps}/hooks/${key}/_webhook-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) })).body);
}

async function inbox(url: string): Promise<Inbox> {
  const body = obj((await json(`${url}/_events?include_rejected=1`)).body);
  return {
    items: (Array.isArray(body.items) ? body.items : []) as InboxEvent[],
    rejected: (Array.isArray(body.rejected) ? body.rejected : []) as Json[],
    deliveries: Number(body.deliveries ?? 0),
    last_seq: Number(body.last_seq ?? 0),
  };
}

export const sinkInbox = (env: Env, key: string) => inbox(`${env.apps}/hooks/${key}`);
export const appInbox = (env: Env, app: string) => inbox(`${env.apps}/${app}`);

/** The first accepted (signature-verified) event of `type` matching `match`, waiting up to `timeoutMs`. */
async function waitIn(read: () => Promise<Inbox>, type: string, match: (event: InboxEvent) => boolean, timeoutMs: number): Promise<InboxEvent | null> {
  return until(async () => (await read()).items.find(event => event.type === type && match(event)) ?? null, timeoutMs, 300);
}

export const waitSink = (env: Env, key: string, type: string, match: (event: InboxEvent) => boolean = () => true, timeoutMs = 30_000) => waitIn(() => sinkInbox(env, key), type, match, timeoutMs);
export const waitApp = (env: Env, app: string, type: string, match: (event: InboxEvent) => boolean = () => true, timeoutMs = 30_000) => waitIn(() => appInbox(env, app), type, match, timeoutMs);

/** `data` of an event's body. */
export const dataOf = (event: InboxEvent | null): Json => obj(event?.payload.data);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Apps                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FakeApp {
  app_id: string;
  secret: string;
}

let fakeApps: FakeApp[] | null = null;

/** The fake app's secret (testkit/fake-apps.json; development-only credentials). */
export function appSecret(appId: string): string {
  fakeApps ??= (JSON.parse(readFileSync(join(ROOT, "testkit/fake-apps.json"), "utf8")) as { apps: FakeApp[] }).apps;
  const app = fakeApps.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`no fake app ${appId} in testkit/fake-apps.json`);
  return app.secret;
}

const basic = (appId: string) => `Basic ${Buffer.from(`${appId}:${appSecret(appId)}`).toString("base64")}`;

/** A form POST to the token/introspect/revoke endpoints as the app. */
export function asAppForm(ctx: Ctx, appId: string, path: string, form: Record<string, string>): Promise<JsonAnswer<Json>> {
  return json<Json>(`${ctx.env.site}${path}`, {
    method: "POST",
    headers: { authorization: basic(appId), "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ctx.ip },
    body: new URLSearchParams(form).toString(),
  });
}

/** A JSON call with the app's credentials. */
export function asApp<T = Json>(ctx: Ctx, appId: string, method: string, path: string, body?: unknown): Promise<JsonAnswer<T>> {
  return json<T>(`${ctx.env.site}${path}`, {
    method,
    headers: { authorization: basic(appId), "x-forwarded-for": ctx.ip, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The fake app exchanges an SLT (POST /<app>/slt-login), keeping the tokens it got. */
export async function appSltLogin(env: Env, app: string, slt: string): Promise<{ status: number; body: Json }> {
  const answer = await json<Json>(`${env.apps}/${app}/slt-login?include_tokens=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slt }) });
  return { status: answer.status, body: obj(answer.body) };
}

/** The fake app refreshes the tokens it holds for an account (POST /<app>/refresh). */
export async function appRefresh(env: Env, app: string, uuid: string): Promise<{ status: number; body: Json }> {
  const answer = await json<Json>(`${env.apps}/${app}/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid }) });
  return { status: answer.status, body: obj(answer.body) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The account site                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The request card for a Silicon on /silicons ("Waiting for you"). */
export function requestCard(page: Page, siliconId: string, kind: "initial" | "transfer") {
  return page.getByRole("listitem", { name: `${kind === "initial" ? "Custodian request from" : "Transfer of"} ${siliconId}` });
}

/** Accepts or declines a request on /silicons as the signed-in Carbon of `page`. Returns when the answer is sent. */
export async function answerOnSite(env: Env, page: Page, siliconId: string, kind: "initial" | "transfer", decision: "accept" | "decline"): Promise<number> {
  if (!page.url().startsWith(`${env.site}/silicons`)) await page.goto(`${env.site}/silicons`);
  const card = requestCard(page, siliconId, kind);
  await card.waitFor({ timeout: 30_000 });
  await sleep(600);
  // Caught at once: a click that throws must not leave a rejected promise behind (it would end the whole run).
  const decided = page.waitForResponse(response => /\/v1\/me\/custodian-requests\/[^/]+\/(accept|decline)$/.test(new URL(response.url()).pathname), { timeout: 30_000 }).catch(() => null);
  if (decision === "accept") {
    await card.getByRole("button", { name: kind === "initial" ? "Accept and become custodian" : "Accept the transfer" }).click();
  } else {
    // The resting "Decline" morphs into a question (a group) with Cancel and the confirming "Decline".
    await card.getByRole("button", { name: "Decline", exact: true }).click();
    const question = card.getByRole("group").filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
    await question.waitFor({ timeout: 10_000 });
    await question.getByRole("button", { name: "Decline", exact: true }).click();
  }
  const answer = await decided;
  return answer ? answer.status() : 0;
}

/** Ensures the e2e base directories exist (for artifacts written by journeys). */
export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
