/**
 * The browser end-to-end walk (`scripts/e2e.sh` for a whole isolated stack, `pnpm -C web e2e` against a running one):
 * helpers shared by every journey (e2e/journeys/*.ts, the "core" suite, and e2e/suites/<suite>/*.ts). Every journey
 * runs in a real browser against a running stack: this site (the public origin), accounts-api behind it, and the
 * testkit's mock Google/Apple, mock email/SMS, mock Iris and fake apps. README.md (this directory) is the guide.
 *
 * Where everything is comes from the environment. E2E_PORT_BASE=<base> names a stack started by scripts/e2e.sh (site
 * on base, accounts-api base-1, mock-oidc base+1, mock-messaging base+2, fake apps base+3, mock Iris base+4, database
 * accounts_e2e_<base>); without it the defaults are scripts/dev.sh's (8590, 8589, 8591…8594, silicon_accounts).
 * Each value can be set on its own:
 *   E2E_SITE   E2E_API   E2E_OIDC   E2E_MESSAGING   E2E_APPS   E2E_IRIS   E2E_DB (postgres URL)   E2E_PG_BIN
 *   E2E_CLI [target/debug/accounts]   E2E_ENGINE [chromium | webkit]
 *   E2E_ARTIFACTS [e2e/.artifacts/<base>] (report.json, report.md, shots/)   E2E_SHOTS [<artifacts>/shots]
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type BrowserContext, type Cookie, type Page } from "@playwright/test";

export type Engine = "chromium" | "webkit";

export interface Env {
  /** The public origin: the account site, which proxies /v1 and /.well-known to accounts-api. */
  site: string;
  /** accounts-api itself (http://127.0.0.1:<base-1>), for calls that should not cross the site. */
  api: string;
  messaging: string;
  oidc: string;
  apps: string;
  /** mock Iris: the default profile photos (ACCOUNTS_IRIS_BASE_URL of the stack). */
  iris: string;
  /** The stack's database (postgres URL), for time travel and inspection: see sql(). */
  db: string;
  /** Where psql lives. */
  pgBin: string;
  cli: string;
  engine: Engine;
  /** The stack's port base (the site's port): names the artifacts directory. */
  base: number;
  /** e2e/.artifacts/<base>: report.json, report.md and shots/. */
  artifacts: string;
  shots: string;
}

const trim = (value: string) => value.replace(/\/+$/, "");

/** This directory (web/e2e). */
export const E2E_DIR = dirname(fileURLToPath(import.meta.url));

export function envFromProcess(engineOverride?: Engine): Env {
  const root = resolve(E2E_DIR, "../..");
  const raw = process.env.E2E_PORT_BASE?.trim();
  const fromBase = raw ? Number(raw) : null;
  if (fromBase !== null && (!Number.isInteger(fromBase) || fromBase < 2 || fromBase > 65_530)) throw new Error(`E2E_PORT_BASE must be a port number, got "${raw}"`);
  const site = trim(process.env.E2E_SITE ?? `http://localhost:${fromBase ?? 8590}`);
  const base = fromBase ?? (Number(new URL(site).port) || 8590);
  const port = (offset: number) => (fromBase ?? 8590) + offset;
  const engine: Engine = engineOverride ?? (process.env.E2E_ENGINE === "webkit" ? "webkit" : "chromium");
  const artifacts = resolve(process.env.E2E_ARTIFACTS ?? join(E2E_DIR, ".artifacts", String(base)));
  const shots = resolve(process.env.E2E_SHOTS ?? join(artifacts, "shots"));
  mkdirSync(shots, { recursive: true });
  const pgPort = process.env.ACCOUNTS_PGPORT ?? "5444";
  return {
    site,
    api: trim(process.env.E2E_API ?? `http://127.0.0.1:${port(-1)}`),
    oidc: trim(process.env.E2E_OIDC ?? `http://127.0.0.1:${port(1)}`),
    messaging: trim(process.env.E2E_MESSAGING ?? `http://127.0.0.1:${port(2)}`),
    apps: trim(process.env.E2E_APPS ?? `http://127.0.0.1:${port(3)}`),
    iris: trim(process.env.E2E_IRIS ?? `http://127.0.0.1:${port(4)}`),
    db: process.env.E2E_DB ?? `postgres://postgres@127.0.0.1:${pgPort}/${fromBase ? `accounts_e2e_${fromBase}` : "silicon_accounts"}`,
    pgBin: process.env.E2E_PG_BIN ?? process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin",
    cli: process.env.E2E_CLI ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "debug", "accounts"),
    engine,
    base,
    artifacts,
    shots,
  };
}

/** The environment of the run in progress (run.ts sets it), so newContext() can scope its forwarded address. */
let runEnv: Env | null = null;
export function setRunEnv(env: Env): void {
  runEnv = env;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Results                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface CheckResult {
  journey: string;
  name: string;
  ok: boolean;
  detail: string;
  /** Milliseconds since the journey started. */
  at_ms: number;
}

export interface Metric {
  name: string;
  value: number;
  /** "ms", "count", "rows/s"… */
  unit: string;
}

/** What one journey records: its checks, numbers worth tracking, and what the browser said that it should not have. */
export class Results {
  readonly checks: CheckResult[] = [];
  readonly problems: string[] = [];
  readonly notes: string[] = [];
  readonly metrics: Metric[] = [];
  journey = "";
  started = Date.now();

  check(name: string, ok: boolean, detail = ""): boolean {
    this.checks.push({ journey: this.journey, name, ok, detail: detail.replace(/\s+/g, " ").slice(0, 2000), at_ms: Date.now() - this.started });
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
    return ok;
  }

  /** A number for the report and the merged summary (timings, throughput, counts); never pass or fail on its own. */
  metric(name: string, value: number, unit = "ms"): void {
    if (!Number.isFinite(value)) return;
    this.metrics.push({ name, value: Math.round(value * 1000) / 1000, unit });
  }

  /**
   * Watches a page: console errors, uncaught page errors, CSP refusals and failed requests are problems unless they
   * match `expected` (the 404 a journey asks for, a fixture's unreachable photo host…); 4xx/5xx answers are notes.
   */
  watch(page: Page, label: string, expected: RegExp[] = []): void {
    const allowed = (text: string) => expected.some(pattern => pattern.test(text)) || BENIGN.some(pattern => pattern.test(text));
    page.on("console", message => {
      const text = `${message.type()}: ${message.text()} @ ${message.location().url}`;
      if (message.type() === "error" || /Content Security Policy|Refused to/i.test(message.text())) {
        if (!allowed(text)) this.problems.push(`[${label}] console ${text}`);
      }
    });
    page.on("pageerror", failure => {
      const text = `pageerror ${failure.message}`;
      if (!allowed(text)) this.problems.push(`[${label}] ${text}`);
    });
    page.on("requestfailed", request => {
      const failure = request.failure()?.errorText ?? "";
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
      const text = `requestfailed ${request.method()} ${request.url()} ${failure}`;
      if (!allowed(text)) this.problems.push(`[${label}] ${text}`);
    });
    page.on("response", response => {
      if (response.status() >= 400) this.notes.push(`[${label}] HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    });
  }
}

/**
 * Browser noise that is not a fault of the site: WebKit reports an aborted fetch (Next's route prefetches cut short by
 * a full navigation) as "access control checks", the mock providers' redirect chains as an interrupted frame load, and
 * — when the app's page navigates away while the embed iframe is still settling — the iframe's "ResizeObserver loop
 * completed with undelivered notifications" (the spec's benign notice that some resize observations moved to the next
 * frame; it never reproduces with the embed on its own, resized or removed).
 */
const BENIGN = [/_rsc=.* due to access control checks/, /Frame load interrupted/, /ResizeObserver loop completed with undelivered notifications/];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browsers                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export async function launch(env: Env): Promise<Browser> {
  return env.engine === "webkit"
    ? webkit.launch({ headless: true })
    : chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });
}

/** A random address in 10.0.0.0/8, unlikely to repeat within a run (X-Forwarded-For in tests). */
export function randomIp(): string {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${1 + Math.floor(Math.random() * 254)}`;
}

export interface ContextOptions {
  width?: number;
  height?: number;
  dark?: boolean;
  cookies?: Cookie[];
  /**
   * The client address accounts-api sees for this browser's calls to the site's /v1 (default: a new random 10.x
   * address per context; null: none, so they count as 127.0.0.1). Next passes X-Forwarded-For through to accounts-api,
   * which the e2e stacks trust (ACCOUNTS_TRUST_FORWARDED_FOR=true), so every context gets its own per-network limits
   * (30 codes per 10 minutes, ids/available, telemetry…) and journeys never use up each other's.
   */
  forwardedFor?: string | null;
}

export async function newContext(browser: Browser, options: ContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    colorScheme: options.dark ? "dark" : "light",
    timezoneId: "Asia/Kolkata",
    locale: "en-US",
  });
  if (options.cookies?.length) await context.addCookies(options.cookies);
  const ip = options.forwardedFor === undefined ? randomIp() : options.forwardedFor;
  if (ip && runEnv) await forwardAs(context, runEnv.site, ip);
  return context;
}

/**
 * Sends `X-Forwarded-For: ip` on this context's requests to `${site}/v1/…` only. Playwright's extraHTTPHeaders would
 * put it on every request, and Chromium then preflights cross-origin fetches (the SDK's call from an app's page) that
 * the API does not allow that header on; routing just the site's API calls leaves every other request untouched.
 */
export async function forwardAs(context: BrowserContext, site: string, ip: string): Promise<void> {
  const prefix = `${trim(site)}/v1/`;
  await context.route(url => url.href.startsWith(prefix), route => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));
}

export async function shot(env: Env, page: Page, name: string, fullPage = false): Promise<void> {
  await page.screenshot({ path: join(env.shots, `${name}.png`), fullPage }).catch(() => undefined);
}

/** A short random tag, so every run's ids and addresses are new. */
export const tag = () => Math.random().toString(36).slice(2, 8);

export const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/* ------------------------------------------------------------------------------------------------------------------ */
/* The database: inspection and time travel                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Runs SQL on the stack's own database (psql -At: one row per line, columns joined by "|") and returns the rows.
 * Each stack has a database of its own (scripts/e2e.sh drops it afterwards), so a journey may move time there:
 *
 *   await sql(env, `update custodian_requests set expires_at = now() - interval '1 second' where id = '${id}'`);
 *
 * Values are not escaped: use it with ids the journey made itself. Throws with psql's message when it fails.
 */
export function sql(env: Env, query: string): Promise<string[][]> {
  return new Promise((done, fail) => {
    execFile(join(env.pgBin, "psql"), [env.db, "-v", "ON_ERROR_STOP=1", "-At", "-c", query], { env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" } }, (error, stdout, stderr) => {
      if (error) fail(new Error(`psql failed on ${env.db}: ${stderr.trim() || error.message}\n${query}`));
      else done(stdout.split("\n").filter(line => line.length > 0).map(line => line.split("|")));
    });
  });
}

/**
 * Forgets the per-network rate-limit buckets of one address (default: every address), as if their window had passed.
 * The CLI and Playwright's page.request reach the API as 127.0.0.1; a suite that makes many of those calls (more than
 * 10 self-created Silicons or 5 reports an hour from one address) moves their window here instead of waiting.
 */
export async function forgetRateLimits(env: Env, ip?: string): Promise<void> {
  await sql(env, ip ? `delete from rate_limits where bucket like '%:ip:${ip.replace(/'/g, "")}'` : "delete from rate_limits where bucket like '%:ip:%'");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* HTTP, codes and the CLI                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface JsonAnswer<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export async function json<T = unknown>(url: string, init?: RequestInit): Promise<JsonAnswer<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

export const postJson = <T = unknown>(url: string, body: unknown) => json<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface ApiInit extends Omit<RequestInit, "body"> {
  /** A JSON body (sets Content-Type). */
  json?: unknown;
  body?: RequestInit["body"];
  /** Straight at accounts-api (env.api) instead of through the site's /v1 proxy. */
  direct?: boolean;
  /** The client address accounts-api sees (default: the journey's own, ctx.ip; null: none, i.e. 127.0.0.1). */
  forwardedFor?: string | null;
}

/**
 * Calls Silicon Accounts the way an app or a script would: `path` is "/v1/…" (or "/.well-known/…"), through the site
 * unless `direct`, with the journey's own X-Forwarded-For so its per-network limits are its own.
 *
 *   const { status, body } = await api<{ available: boolean }>(ctx, "/v1/ids/available?id=c:ada");
 */
export function api<T = unknown>(ctx: { env: Env; ip: string }, path: string, init: ApiInit = {}): Promise<JsonAnswer<T>> {
  const { json: payload, direct, forwardedFor, headers, ...rest } = init;
  const merged = new Headers(headers);
  const ip = forwardedFor === undefined ? ctx.ip : forwardedFor;
  if (ip) merged.set("x-forwarded-for", ip);
  if (payload !== undefined && !merged.has("content-type")) merged.set("content-type", "application/json");
  return json<T>(`${direct ? ctx.env.api : ctx.env.site}${path}`, { ...rest, headers: merged, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
}

/** The newest message sequence number in the mock email/SMS server (read before asking for a code). */
export async function lastSeq(env: Env): Promise<number> {
  const { body } = await json<{ last_seq?: number }>(`${env.messaging}/_messages?limit=1`);
  return body.last_seq ?? 0;
}

/** Waits for the next email or SMS to `to` after `after` and returns its 6-digit code. */
export async function codeFor(env: Env, to: string, after: number, timeoutMs = 15_000): Promise<string> {
  const { status, body } = await json<{ code?: string | null }>(`${env.messaging}/_messages/wait?to=${encodeURIComponent(to)}&after=${after}&timeout_ms=${timeoutMs}`);
  if (status !== 200 || !body.code) throw new Error(`no code reached ${to} after message ${after} (${status} ${JSON.stringify(body)})`);
  return body.code;
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** stdout as JSON (the whole of it, else its last JSON object), or null. */
  json: Record<string, unknown> | null;
}

/** A fresh home for the CLI (its session lives in {home}/.accounts). */
export const cliHome = () => mkdtempSync(join(tmpdir(), "sa-e2e-cli-"));

/** Runs the `accounts` CLI against the site; `onStderr` sees each stderr line (the device code event comes there). */
export function cli(env: Env, home: string, args: string[], options: { stdin?: string; onStderr?: (line: string) => void } = {}): Promise<CliRun> {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(env.cli, ["--url", env.site, "--home", home, ...args], { env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => {
      stderr += chunk;
      for (const line of String(chunk).split("\n")) if (line.trim()) options.onStderr?.(line);
    });
    child.stdin.end(options.stdin ?? "");
    child.on("close", code => done({ code, stdout, stderr, ms: Date.now() - started, json: parseJson(stdout) }));
  });
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  for (const candidate of [trimmed, trimmed.slice(Math.max(0, trimmed.lastIndexOf("\n{") + 1))]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The site's own sign-in                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Signs in on /sign-in with an email code; a new address goes through the sign-up step. Ends on the home page. */
export async function signInOnSite(env: Env, page: Page, email: string): Promise<void> {
  await page.goto(`${env.site}/sign-in`);
  const field = page.getByRole("textbox", { name: "Email" });
  await field.waitFor({ timeout: 30_000 });
  const after = await lastSeq(env);
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = await codeFor(env, email, after);
  await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
  await page.keyboard.type(code, { delay: 25 });
  const create = page.getByRole("button", { name: "Create account" });
  const home = page.waitForURL(`${env.site}/`, { timeout: 30_000 }).then(() => "home" as const);
  if ((await Promise.race([home, create.waitFor({ timeout: 30_000 }).then(() => "signup" as const)])) === "signup") await create.click();
  await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
}

/** The account a fake app shows after its callback (`<pre id="account">`), or null. */
export async function appAccount(page: Page): Promise<Record<string, unknown> | null> {
  const raw = await page.locator("#account").innerText().catch(() => "");
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Finishes a hosted flow from the sign-up step: Create account, then consent when the app asks, then back at the app. */
export async function finishSignup(env: Env, page: Page, app: string, shotName?: string): Promise<string> {
  const create = page.getByRole("button", { name: "Create account" });
  await create.waitFor({ timeout: 25_000 });
  await sleep(400);
  if (shotName) await shot(env, page, `${shotName}-signup`);
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  await create.click();
  await afterConsent(env, page, app, shotName);
  return text;
}

/** Shares and continues when the app asks (consent), then waits to be back at the fake app. */
export async function afterConsent(env: Env, page: Page, app: string, shotName?: string): Promise<void> {
  const share = page.getByRole("button", { name: "Share and continue" });
  const appUrl = new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/${app}/`);
  const back = page.waitForURL(appUrl, { timeout: 30_000 }).then(() => "app" as const);
  const consent = share.waitFor({ timeout: 30_000 }).then(() => "consent" as const);
  if ((await Promise.race([back, consent])) === "consent") {
    await sleep(300);
    if (shotName) await shot(env, page, `${shotName}-consent`);
    await share.click();
    await page.waitForURL(appUrl, { timeout: 30_000 });
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
}
