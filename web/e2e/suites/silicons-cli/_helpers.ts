/**
 * Helpers of the silicons-cli suite (Silicons, custodians and the `silicon-accounts` CLI). Kept in the suite (README: a helper
 * that lib.ts lacks lives in the suite until the harness owner moves it):
 *
 * - Carbons signed up through the account site's own API flow (`/v1/flows`, about a second each instead of a browser
 *   walk), with their `sa_session` cookie for API calls and for browser contexts;
 * - the real CLI with full control of its environment (`--home`, `--url`, HOME, SILICON_HOME, ACCOUNTS_HOME), a kill
 *   timer, strict JSON parsing of stdout and the JSON lines it writes on stderr in `--json` mode;
 * - webhook receivers: a Silicon's own webhook on the fake app server's generic sinks (`/hooks/<key>`), and the fake
 *   apps' own inboxes (both verify X-Accounts-Signature; refused deliveries are listed);
 * - app credentials (testkit/fake-apps.json), SLT exchanges and token calls as an app;
 * - row locks held from a psql session of the suite's own (holdRows, waitForLockWaiters), to line requests up behind a
 *   lock and let them go at once: races between a sign-in and whatever ends its Silicon, made deterministic.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Cookie, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { E2E_DIR, json, lastSeq, newContext, randomIp, sleep, sql, type Env, type JsonAnswer } from "../../lib";

export const ROOT = resolve(E2E_DIR, "../..");

/** The report recipients UNDERSTANDING.md names (silicon-accounts report). */
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

/** The `items` of a page (`{"items": [...]}`), or []. */
export const itemsOf = (body: unknown): Json[] => (Array.isArray(obj(body).items) ? (obj(body).items as Json[]) : []);

/** JSON with object keys sorted at every level, to compare documents whatever their key order. */
export function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Json).sort().map(key => [key, sorted((v as Json)[key])])) : v;
  return JSON.stringify(sorted(value)) ?? "undefined";
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
 * Signs a new Carbon up through the account site's own sign-in (app `silicon-accounts`): email, the code from the mock
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
  const created = await step("POST /v1/flows", "POST", "/v1/flows", { app_id: "silicon-accounts", redirect_uri: `${env.site}/`, state: `scli-${t}`, timezone: "Asia/Kolkata" });
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

/** A phone number (+1 415 555 xxxx) no account of this stack has yet. */
export async function freshPhone(env: Env): Promise<string> {
  for (;;) {
    const phone = `+1415555${String(1000 + Math.floor(Math.random() * 9000))}`;
    if (!(await sql(env, `select 1 from account_phones where phone = '${phone}'`)).length) return phone;
  }
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

export interface HostedSignIn {
  /** Every details page the sign-in showed, as the API described it (FlowView.details), in order. */
  pages: Json[];
  /** The review page (FlowView.review), when the app's flow has one. */
  review: Json | null;
  /** Where the flow sent the browser: the app's redirect URI with a code. */
  redirect: string;
  /** The fake app's answer when it took the code at its callback. */
  callbackStatus: number;
}

/**
 * Signs a Carbon into an app the way the app's hosted pages do, through their own API calls with the Carbon's
 * account-site session (no browser): the app's own sign-in link (its registered redirect URI, state and PKCE
 * challenge), POST /v1/flows, "Continue as", every details page answered with `share` (the optional details the
 * Carbon ticks; the others stay unticked; required ones are always shared), the review approved; then the fake app
 * takes the code at its callback. `prompt: "consent"` shows a returning Carbon the details pages again.
 */
export async function signInToApp(env: Env, carbon: Carbon, app: string, options: { share?: string[]; prompt?: string } = {}): Promise<HostedSignIn> {
  // The fake app ties the state of its link to its own session cookie, which its callback checks.
  const appJar = new Jar();
  const appPage = await fetch(`${env.apps}/${app}/`);
  appJar.take(appPage);
  const home = await appPage.text();
  const link = /id="signin-hosted"[^>]*href="([^"]+)"/.exec(home)?.[1];
  if (!link) throw new Error(`${app}'s own page (${env.apps}/${app}/) has no #signin-hosted link`);
  const authorize = new URL(link.replace(/&amp;/g, "&"));
  const body: Json = Object.fromEntries(authorize.searchParams.entries());
  if (options.prompt) body.prompt = options.prompt;
  const jar = new Jar();
  jar.cookies.set("sa_session", carbon.session);
  const step = async (what: string, method: string, path: string, payload?: unknown): Promise<Json> => {
    const answer = await siteCall(env, jar, carbon.ip, method, path, payload);
    if (answer.status >= 300) throw new Error(`signing ${carbon.id} into ${app}: ${what} answered ${answer.status} ${short(answer.body)}`);
    return obj(obj(answer.body).flow);
  };
  let flow = await step("POST /v1/flows", "POST", "/v1/flows", body);
  const id = str(flow.id);
  if (flow.step === "choose_method") flow = await step("continue as", "POST", `/v1/flows/${id}/continue`, {});
  const pages: Json[] = [];
  let review: Json | null = null;
  for (let i = 0; i < 12 && flow.step === "details"; i++) {
    const details = obj(flow.details);
    pages.push(details);
    const fields = (Array.isArray(details.fields) ? details.fields : []) as Json[];
    const share = fields.filter(field => field.mode === "optional" && (options.share ?? []).includes(str(field.field))).map(field => str(field.field));
    flow = await step(`details page ${i + 1}`, "POST", `/v1/flows/${id}/details/continue`, { share });
  }
  if (flow.step === "review") {
    review = obj(flow.review);
    flow = await step("the review", "POST", `/v1/flows/${id}/review`, { approve: true });
  }
  if (flow.step !== "complete" || !str(flow.redirect_to)) throw new Error(`signing ${carbon.id} into ${app}: the flow ended at ${str(flow.step)} (${short(flow.error ?? flow)})`);
  const redirect = str(flow.redirect_to);
  const cookie = appJar.header();
  const callback = await fetch(redirect, { redirect: "manual", headers: cookie ? { cookie } : {} });
  await callback.text().catch(() => "");
  return { pages, review, redirect, callbackStatus: callback.status };
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

/**
 * The environment of a CLI run: a copy of this process's (typed as one: the site's Next types make NODE_ENV a required
 * key of it) without the stack's own settings, so the CLI only knows what each run tells it, plus `extra` (undefined
 * removes a variable).
 */
function cliEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined || key.startsWith("ACCOUNTS_") || key === "SILICON_HOME") delete base[key];
  }
  base.NO_COLOR = "1";
  base.HOME = sandbox();
  base.ACCOUNTS_NO_BROWSER = "1";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

/** The CLI's arguments with the stack's --url and the run's --home in front. */
const cliArgs = (env: Env, args: string[], options: RunOptions) => [...(options.url === null ? [] : ["--url", options.url ?? env.site]), ...(options.home ? ["--home", options.home] : []), ...args];

/** Runs the real `silicon-accounts` CLI. */
export function accounts(env: Env, args: string[], options: RunOptions = {}): Promise<Run> {
  const base = cliEnv(options.env);
  const full = cliArgs(env, args, options);
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

/** `silicon-accounts login --silicon <id> --stk-stdin --json` in `home`. */
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
/* The CLI writing into a pipe nobody reads (EPIPE)                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PipedRun {
  args: string[];
  /** The CLI's own exit code (bash's PIPESTATUS[0]): 128 + n when signal n ended it (141: SIGPIPE). */
  code: number | null;
  /** What the CLI wrote on stderr (empty with `stderr: "gone"`). */
  stderr: string;
  ms: number;
  timedOut: boolean;
}

/**
 * Runs the CLI the way `accounts … | head -c 1` does once head has what it wants, through bash so the pipe is a real
 * one and the exit code is the CLI's own (PIPESTATUS):
 * - `reader: "gone"` (default): `{ sleep 0.3; accounts …; } | true`: the reading end is closed (true has exited) well
 *   before the CLI starts, so its first write to stdout fails with EPIPE (Rust ignores SIGPIPE, so it is an error the
 *   CLI must handle, not a signal that ends it);
 * - `reader: "head"`: `accounts … | head -c 1`: a reader that takes one byte and goes;
 * - `stderr: "gone"`: stderr goes into the closed pipe too, stdout to /dev/null.
 */
export function accountsIntoClosedPipe(env: Env, args: string[], options: RunOptions & { reader?: "gone" | "head"; stderr?: "kept" | "gone" } = {}): Promise<PipedRun> {
  const full = cliArgs(env, args, options);
  const redirect = options.stderr === "gone" ? " 2>&1 >/dev/null" : "";
  const script =
    options.reader === "head"
      ? `"$0" "$@"${redirect} | head -c 1 >/dev/null; exit "\${PIPESTATUS[0]}"`
      : `{ sleep 0.3; "$0" "$@"${redirect}; } | true; exit "\${PIPESTATUS[0]}"`;
  return new Promise(done => {
    const started = Date.now();
    const child = spawn("/bin/bash", ["-c", script, env.cli, ...full], { env: cliEnv(options.env), stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 60_000);
    child.stderr.on("data", chunk => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
    child.on("close", code => {
      clearTimeout(timer);
      done({ args: full, code, stderr, ms: Date.now() - started, timedOut });
    });
  });
}

/** What a Rust panic leaves on stderr ("thread 'main' panicked at …", the RUST_BACKTRACE note). */
export const PANIC = /panicked at|RUST_BACKTRACE|stack backtrace/;

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

/** Makes the sink refuse its next `failNext` deliveries with HTTP `status` (0 makes it accept again). */
export async function sinkFault(env: Env, key: string, failNext: number, status = 500): Promise<Json> {
  return obj((await json(`${env.apps}/hooks/${key}/_webhook-faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fail_next: failNext, status }) })).body);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Row locks (deterministic races)                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface RowHold {
  /** The database session holding the rows. */
  pid: number;
  /** Ends the hold (rollback) and waits until its session is gone. */
  release(): Promise<void>;
}

/**
 * Locks the rows of `table` matching `where` (`select … for update`) from a psql session of its own and keeps them
 * locked until `release()` (at most `maxMs`), so requests that need those rows line up behind it in the order they
 * arrive, and all go at once when it lets go. Only for this stack's own database and rows the journey made.
 */
export async function holdRows(env: Env, table: string, where: string, maxMs = 20_000): Promise<RowHold> {
  const mark = `scli_hold_${randomUUID().replace(/-/g, "")}`;
  const child = spawn(join(env.pgBin, "psql"), [env.db, "-v", "ON_ERROR_STOP=1", "-q", "-At"], {
    env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => (stderr += chunk));
  child.stdin.on("error", () => undefined);
  const closed = new Promise<void>(done => child.once("close", () => done()));
  let ended = false;
  const release = async () => {
    if (!ended) {
      ended = true;
      child.stdin.end("rollback;\n");
    }
    await closed;
    clearTimeout(timer);
  };
  // Declared after release(), which only runs once it exists (here, or when it fires).
  const timer = setTimeout(() => void release(), maxMs);
  child.stdin.write(`begin;\nselect '${mark}' from ${table} where ${where} for update;\n`);
  const pid = await until(async () => {
    const rows = await sql(env, `select pid from pg_stat_activity where state = 'idle in transaction' and query like '%${mark}%' and pid <> pg_backend_pid()`);
    return rows[0]?.[0] ? Number(rows[0][0]) : null;
  }, 15_000, 50);
  if (!pid) {
    await release();
    throw new Error(`could not lock ${table} where ${where}: ${stderr.trim() || "the session never got there"}`);
  }
  return { pid, release };
}

/** What the sessions of this stack's database that wait for a lock are running (their statements, shortened). */
export async function lockWaiters(env: Env): Promise<string[]> {
  const rows = await sql(env, "select left(regexp_replace(query, '\\s+', ' ', 'g'), 100) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid() order by query_start");
  return rows.map(row => row[0] ?? "");
}

/**
 * Waits until at least `n` sessions wait for a lock (one of them running a statement matching `including`, when
 * given); their statements, or null when the time is up.
 */
export function waitForLockWaiters(env: Env, n: number, including?: RegExp, timeoutMs = 15_000): Promise<string[] | null> {
  return until(async () => {
    const waiting = await lockWaiters(env);
    return waiting.length >= n && (!including || waiting.some(statement => including.test(statement))) ? waiting : null;
  }, timeoutMs, 50);
}

/** The statement a Silicon sign-in waits in while it counts its attempt (core's `begin_stk_attempt`). */
export const COUNTING_STK_ATTEMPT = /stk_failed_attempts = stk_failed_attempts \+ 1/;

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
