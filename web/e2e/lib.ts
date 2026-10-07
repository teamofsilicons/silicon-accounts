/**
 * The browser end-to-end walk (`scripts/e2e.sh` for a whole isolated stack, `pnpm -C web e2e` against a running one):
 * helpers shared by every journey (e2e/journeys/*.ts, the "core" suite, and e2e/suites/<suite>/*.ts). Every journey
 * runs in a real browser against a running stack: this site (the public origin), accounts-api behind it, and the
 * testkit's mock Google/Apple, mock email/SMS, mock Iris and fake apps. README.md (this directory) is the guide.
 *
 * Where everything is comes from the environment. E2E_PORT_BASE=<base> names a stack started by scripts/e2e.sh (site
 * on base, accounts-api base-1, mock-oidc base+1, mock-messaging base+2, fake apps base+3, mock Iris base+4, the
 * developer site base+5, database accounts_e2e_<base>); without it the defaults are scripts/dev.sh's (8590, 8589,
 * 8591…8594, the developer site on 8600, silicon_accounts). Each value can be set on its own:
 *   E2E_SITE   E2E_DEVELOPER   E2E_API   E2E_OIDC   E2E_MESSAGING   E2E_APPS   E2E_IRIS   E2E_DB (postgres URL)
 *   E2E_PG_BIN   E2E_CLI [target/debug/accounts]   E2E_ENGINE [chromium | webkit]
 *   E2E_ARTIFACTS [e2e/.artifacts/<base>] (report.json, report.md, shots/)   E2E_SHOTS [<artifacts>/shots]
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type BrowserContext, type Cookie, type Page } from "@playwright/test";

export type Engine = "chromium" | "webkit";

export interface Env {
  /** The public origin: the account site, which proxies /v1 and /.well-known to accounts-api. */
  site: string;
  /**
   * The developer site (developer/, http://localhost:<base+5>): a BFF whose Next server signs Carbons in through the
   * account site's hosted pages (first-party app `developer`) and proxies /api/accounts/* to accounts-api /v1/*.
   */
  developer: string;
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
    // The developer site's public origin is http://localhost:<port> (its sign-in's redirect URI and its CSRF origin).
    developer: trim(process.env.E2E_DEVELOPER ?? `http://localhost:${fromBase === null ? 8600 : fromBase + 5}`),
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
/* Benchmarks on a shared machine                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface BenchSlot {
  /** False when the slot stayed taken for the whole wait and the benchmark ran without it. */
  held: boolean;
  waitedMs: number;
  /** Who held the slot while this benchmark waited for it (pid, then what the holder said about itself). */
  heldBy: string | null;
}

/** The machine's benchmark slot: .dev/locks/e2e-bench, beside the scripts' leases. */
export const BENCH_SLOT_DIR = resolve(E2E_DIR, "../../.dev/locks/e2e-bench");

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The slot's holder ("<pid> <owner>"), or null when its directory is gone or has no owner file yet. */
function benchSlotOwner(dir: string): string | null {
  try {
    return readFileSync(join(dir, "owner"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Takes the slot, or says why not: a live holder has it ("busy"), or a dead holder's slot was just freed. */
function tryBenchSlot(dir: string, owner: string): "taken" | "busy" | "freed" {
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, "owner"), `${process.pid} ${owner}\n`);
    return "taken";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const holder = benchSlotOwner(dir);
  const pid = Number(holder?.split(" ")[0]);
  let stale = holder ? Number.isInteger(pid) && pid > 0 && !processAlive(pid) : false;
  if (!holder) {
    // No owner file: a holder that died between mkdir and writing it, or a live one about to (given 30 s).
    try {
      stale = Date.now() - statSync(dir).mtimeMs > 30_000;
    } catch {
      return "freed";
    }
  }
  if (!stale) return "busy";
  // Rename first: of several runs taking over the same dead slot, only one rename succeeds.
  const grave = `${dir}.stale.${process.pid}`;
  try {
    renameSync(dir, grave);
    rmSync(grave, { recursive: true, force: true });
  } catch {
    // Another run took it over first.
  }
  return "freed";
}

/**
 * Runs `body` holding the machine's one benchmark slot (BENCH_SLOT_DIR, made with mkdir, which is atomic; the slot of
 * a holder that died is taken over), so two stacks never time their endpoints at the same moment. scripts/e2e-all.sh
 * walks every suite in Chromium and WebKit side by side, so without it a suite's latency benchmark runs at the very
 * moment its twin's does, and each loads the machine for the other. Waits up to `waitMs` (E2E_BENCH_SLOT_WAIT_MS,
 * default 6 minutes) for the slot, then runs without it and says so in `slot.held`. `owner` names the holder for
 * whoever waits (e.g. "9650 chromium proofs-perf-latency-verify"); `dir` is for tests.
 */
export async function withBenchSlot<T>(owner: string, body: (slot: BenchSlot) => Promise<T>, options: { waitMs?: number; dir?: string } = {}): Promise<T> {
  const waitMs = options.waitMs ?? Number(process.env.E2E_BENCH_SLOT_WAIT_MS ?? 360_000);
  const dir = options.dir ?? BENCH_SLOT_DIR;
  mkdirSync(dirname(dir), { recursive: true });
  const started = Date.now();
  let heldBy: string | null = null;
  let held = false;
  for (;;) {
    const outcome = tryBenchSlot(dir, owner.replace(/\s+/g, " "));
    if (outcome === "taken") {
      held = true;
      break;
    }
    if (outcome === "busy") heldBy = benchSlotOwner(dir) ?? heldBy;
    if (Date.now() - started >= waitMs) break;
    if (outcome === "busy") await sleep(Math.min(1000, Math.max(0, waitMs - (Date.now() - started))));
  }
  const release = () => {
    if (held && benchSlotOwner(dir)?.split(" ")[0] === String(process.pid)) rmSync(dir, { recursive: true, force: true });
    held = false;
  };
  process.once("exit", release);
  try {
    return await body({ held, waitedMs: Date.now() - started, heldBy });
  } finally {
    release();
    process.removeListener("exit", release);
  }
}

export interface Calm {
  /** The load average came down to the core count within the wait. */
  calm: boolean;
  waitedMs: number;
  /** The 1-minute load average when the wait ended, and the machine's cores. */
  load: number;
  cores: number;
}

/**
 * Waits up to `maxMs` until the machine's 1-minute load average is at most its number of cores (the other stacks'
 * walks and builds are over or pausing), checking every 5 seconds; returns what it saw and never throws. For timings
 * that are only worth taking on a machine with room to spare: other stacks' browsers, builds and benchmarks slow every
 * request of this one, whatever its endpoints do.
 */
export async function waitForCalm(maxMs: number): Promise<Calm> {
  const cores = availableParallelism();
  const started = Date.now();
  for (;;) {
    const load = Math.round((loadavg()[0] ?? 0) * 100) / 100;
    const waitedMs = Date.now() - started;
    if (load <= cores) return { calm: true, waitedMs, load, cores };
    if (waitedMs >= maxMs) return { calm: false, waitedMs, load, cores };
    await sleep(Math.min(5000, maxMs - waitedMs));
  }
}

/** A stall of this process this long is not load but a machine that was not running (asleep, or the process stopped). */
export const FROZEN_STALL_MS = 5_000;

/**
 * Watches this process while a benchmark measures, with a timer due every `everyMs`: `stop()` returns the longest time
 * the timer fired late (the stretch since its last tick included), in milliseconds, by the monotonic or the wall
 * clock, whichever saw more. A loaded machine delays it by milliseconds; a stall of seconds (FROZEN_STALL_MS) means
 * nothing ran: macOS puts the whole machine to sleep with every stack still up (on battery it sleeps for about 15
 * minutes between short maintenance wakes), and a request in flight then "takes" 900 s, keep-alive connections are
 * reset at wake, and a run's throughput reads 2 req/s. Such a run measured the sleep, not the endpoint.
 */
export function watchStalls(everyMs = 50): { stop: () => number } {
  let lastMono = performance.now();
  let lastWall = Date.now();
  let longest = 0;
  const tick = () => {
    const mono = performance.now();
    const wall = Date.now();
    longest = Math.max(longest, mono - lastMono - everyMs, wall - lastWall - everyMs);
    lastMono = mono;
    lastWall = wall;
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      tick();
      return Math.max(0, longest);
    },
  };
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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake apps                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The repository's root (web/e2e/../..). */
export const REPO_ROOT = resolve(E2E_DIR, "../..");

/** A detail an app can ask for (each one required or optional). */
export type DetailField = "email" | "phone" | "dob" | "timezone";
export type SigninMethod = "google" | "apple" | "email" | "phone";
/** Which version of the hosted pages an app asks for: the sign-in or the sign-up page. */
export type Intent = "signin" | "signup";

/** One page of an app's flow (SigninConfig.flow.steps). */
export interface FakeFlowStep {
  id: string;
  fields: DetailField[];
  title: string | null;
  subtitle: string | null;
  continue_label: string | null;
  layout: string | null;
}

/** A fake app as testkit/fake-apps.json delivers it (the parts journeys read). */
export interface FakeApp {
  app_id: string;
  name: string;
  owner_id: string;
  owner_email: string;
  secret: string;
  signin_defaults: {
    required_fields?: DetailField[];
    optional_fields?: DetailField[];
    copy?: Record<string, string | null | undefined>;
    flow?: { steps: FakeFlowStep[]; review: boolean } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

let fakeAppsCache: FakeApp[] | null = null;

/** A fake app of testkit/fake-apps.json: its owner, its fixed secret and the sign-in setup it is seeded with. */
export function fakeApp(appId: string): FakeApp {
  fakeAppsCache ??= (JSON.parse(readFileSync(join(REPO_ROOT, "testkit/fake-apps.json"), "utf8")) as { apps: FakeApp[] }).apps;
  const app = fakeAppsCache.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`testkit/fake-apps.json has no app "${appId}" (it has ${fakeAppsCache.map(entry => entry.app_id).join(", ")})`);
  return app;
}

/** Every address of a fake app's own pages (its home, callback, signed-in and error pages). */
export const appUrl = (env: Env, app: string) => new RegExp(`^${escapeRegExp(env.apps)}/${escapeRegExp(app)}/`);

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

/**
 * Starts a hosted sign-in from a fake app's own page, as a Carbon would: its "Sign in with Silicon Accounts" link
 * (`#signin-hosted`, the default), its "Create an account" link (`#signup-hosted`: `intent: "signup"`), or one of its
 * direct "Continue with …" buttons (`#continue-<method>`: `method`; Google and Apple then show the Opening page).
 * `extra` adds (or, with null, removes) query parameters of that link and goes there instead of clicking it, for what
 * an app could put in its own link (`prompt`, `scope`, a `login_hint` the hosted pages must ignore…); the app's state
 * and PKCE stay valid. Returns the address the browser went to (an /authorize address on the account site).
 */
export async function startAtApp(env: Env, page: Page, app: string, options: { intent?: Intent; method?: SigninMethod; extra?: Record<string, string | null> } = {}): Promise<URL> {
  await page.goto(`${env.apps}/${app}/`);
  const selector = options.method ? `#continue-${options.method}` : options.intent === "signup" ? "#signup-hosted" : "#signin-hosted";
  const link = page.locator(selector);
  await link.waitFor({ timeout: 15_000 });
  const href = new URL((await link.getAttribute("href")) ?? "", env.apps);
  if (!options.extra) {
    await link.click();
    return href;
  }
  for (const [key, value] of Object.entries(options.extra)) {
    if (value === null) href.searchParams.delete(key);
    else href.searchParams.set(key, value);
  }
  await page.goto(href.href);
  return href;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The hosted pages                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The hosted pages' live view of `selector`. The card morphs between steps (and between the pages of an app's flow):
 * the leaving step keeps rendering while it slides out, inert and aria-hidden, under `[data-step-leaving]`. getByRole
 * already skips it; CSS locators go through this.
 */
export const live = (page: Page, selector: string) => page.locator(`${selector}:not([data-step-leaving] *)`);

/** The heading of the step on screen (the hosted pages' only h1: the split layout's hero copy is a paragraph). */
export async function hostedTitle(page: Page, timeoutMs = 30_000): Promise<string> {
  const heading = live(page, "h1").first();
  await heading.waitFor({ timeout: timeoutMs });
  return (await heading.innerText()).replace(/\s+/g, " ").trim();
}

/** The methods page's buttons: "Continue with Google", "Continue with Apple" (the email and phone field is a form). */
export const methodButton = (page: Page, method: "google" | "apple") => page.getByRole("button", { name: method === "google" ? "Continue with Google" : "Continue with Apple", exact: true });

/**
 * "Powered by Silicon Accounts" on a hosted page: where it links, whether all of it is inside the viewport as the page
 * stands (`inView`), and whether it shows at the end of the page once scrolled to the bottom (`atEnd`: a page taller
 * than the window, like setting up an account on a phone, keeps it at its foot). The scroll position is put back.
 */
export async function poweredBy(page: Page, options: { scroll?: boolean } = {}): Promise<{ href: string; inView: boolean; atEnd: boolean; text: string }> {
  const link = page.getByRole("link", { name: "Silicon Accounts", exact: true }).last();
  await link.waitFor({ timeout: 15_000 }).catch(() => undefined);
  const href = (await link.getAttribute("href", { timeout: 2_000 }).catch(() => null)) ?? "";
  const text = (await link.evaluate(element => element.parentElement?.textContent ?? "", undefined, { timeout: 2_000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const within = async () => {
    const box = await link.boundingBox({ timeout: 2_000 }).catch(() => null);
    return !!box && box.y >= 0 && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width;
  };
  const inView = await within();
  if (inView || options.scroll === false) return { href, inView, atEnd: inView, text };
  // A page taller than the window: scroll to its foot, look, and put the scroll back (a page that is leaving, like the
  // Opening page on its way to Google, just reports what it had).
  const scrolled = await page.evaluate(() => {
    const before = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight);
    return before;
  }).catch(() => null);
  if (scrolled === null) return { href, inView, atEnd: false, text };
  await sleep(150);
  const atEnd = await within();
  await page.evaluate(top => window.scrollTo(0, top), scrolled).catch(() => undefined);
  return { href, inView, atEnd, text };
}

/** Where every "Powered by Silicon Accounts" links (UNDERSTANDING.md: not configurable). */
export const POWERED_BY_HREF = "https://accounts.teamofsilicons.com";

export interface OpeningSeen {
  /** The Opening page's heading: "Opening Google to sign you in to Briefcase…", or the app's copy.opening_title. */
  title: string;
  /** The heading's font family and the branded background (`--background`, e.g. "#16130F"): the app's own style. */
  headingFont: string;
  background: string;
  /** "Continue to Google": the fallback when the page does not move on by itself. */
  fallback: boolean;
  poweredBy: { href: string; inView: boolean; atEnd: boolean; text: string };
  /** From the Opening page showing to the browser reaching the provider (null with `stay`, or when it never moved). */
  movedAfterMs: number | null;
}

/**
 * The Opening page (UNDERSTANDING.md "Adding sign-in to an app"): the app's own "Continue with Google/Apple" shows
 * "Opening Google to sign you in to {app}…" in the app's style first, then moves on to the provider by itself (about
 * 900 ms). Waits for it, reads it, and (unless `stay`) waits until the browser reaches the mock provider.
 */
export async function waitForOpening(env: Env, page: Page, provider: "google" | "apple", options: { stay?: boolean; shotName?: string } = {}): Promise<OpeningSeen> {
  const opening = live(page, `[data-opening="${provider}"]`);
  await opening.waitFor({ timeout: 30_000 });
  const shownAt = Date.now();
  // Read in one go: the page moves on by itself about 900 ms after it shows.
  const name = provider === "google" ? "Google" : "Apple";
  const read = await opening.evaluate((element, buttonText) => {
    const heading = element.querySelector("h1");
    const brand = element.closest(".sa-brand") ?? document.querySelector(".sa-brand");
    const button = [...element.querySelectorAll("button")].find(candidate => (candidate.textContent ?? "").includes(buttonText));
    const links = [...document.querySelectorAll("a")].filter(link => link.textContent?.trim() === "Silicon Accounts");
    const link = links[links.length - 1];
    const box = link?.getBoundingClientRect();
    return {
      title: (heading?.textContent ?? "").replace(/\s+/g, " ").trim(),
      headingFont: heading ? getComputedStyle(heading).fontFamily : "",
      background: brand ? getComputedStyle(brand).getPropertyValue("--background").trim().toUpperCase() : "",
      fallback: !!button && button.getClientRects().length > 0,
      poweredBy: {
        href: link?.getAttribute("href") ?? "",
        inView: !!box && box.width > 0 && box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth,
        atEnd: false,
        text: (link?.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim(),
      },
    };
  }, `Continue to ${name}`);
  read.poweredBy.atEnd = read.poweredBy.inView;
  if (options.shotName) await shot(env, page, options.shotName);
  if (options.stay) return { ...read, movedAfterMs: null };
  const moved = await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 15_000 }).then(() => Date.now() - shownAt, () => null);
  return { ...read, movedAfterMs: moved };
}

/**
 * On the mock provider's chooser (Google or Apple): "Use another account" with this email and name. The provider then
 * sends the browser back to the hosted pages (Apple with a form_post through the site).
 */
export async function chooseMockIdentity(env: Env, page: Page, email: string, name: string): Promise<void> {
  await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 30_000 });
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(name);
  await page.locator('#new-identity button[data-action="use-another"]').click();
}

/** The code group of the step on screen ("Code from the email", "Code from the text message"). */
const codeGroup = (page: Page) => page.getByRole("group", { name: /^Code from the/ }).first();

/**
 * On the methods page: types an email (or, with `phone`, a phone number key by key after its "+") into the app's
 * field, continues, and types the code that arrives. The page then moves on (sign-up for a new address, the details
 * pages, or back to the app).
 */
export async function signInWithCode(env: Env, page: Page, to: { email: string } | { phone: string }): Promise<string> {
  if ("email" in to) {
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.fill(to.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, to.email.toLowerCase(), after);
    await codeGroup(page).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    return code;
  }
  // An app with both email and phone shows "Email | Phone" (a segmented control of pressed buttons) above one field.
  const choice = page.getByRole("button", { name: "Phone", exact: true });
  await page.getByRole("textbox", { name: /^(Email|Phone number)$/ }).first().waitFor({ timeout: 30_000 });
  if (await choice.isVisible().catch(() => false)) await choice.click();
  const field = page.getByRole("textbox", { name: "Phone number" });
  await field.waitFor({ timeout: 30_000 });
  await field.click();
  const after = await lastSeq(env);
  await page.keyboard.type(to.phone, { delay: 20 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = await codeFor(env, to.phone, after);
  await codeGroup(page).waitFor({ timeout: 15_000 });
  await page.keyboard.type(code, { delay: 25 });
  return code;
}

/** The sign-up page's button: "Create account", or "Finish setup" for an account an app imported. */
const signupButton = (page: Page) => page.getByRole("button", { name: /^(Create account|Finish setup)$/ });

/**
 * Finishes a hosted sign-in from the sign-up step: Create account (or Finish setup), then the app's details pages with
 * their defaults (required details shared, optional ones left unticked, the review approved), then back at the app.
 * Returns the sign-up page's text. Use completeDetails() after the sign-up for anything but the defaults.
 */
export async function finishSignup(env: Env, page: Page, app: string, shotName?: string): Promise<string> {
  const create = signupButton(page);
  await create.waitFor({ timeout: 25_000 });
  await sleep(400);
  if (shotName) await shot(env, page, `${shotName}-signup`);
  const text = (await live(page, "main").first().innerText()).replace(/\s+/g, " ");
  await create.click();
  await afterConsent(env, page, app, shotName);
  return text;
}

/**
 * After the account is known (a code, Google or Apple, a sign-up, "Continue as"): walks the app's details pages and
 * review with their defaults and waits to be back at the fake app. A required email or phone the account lacks needs
 * completeDetails() with `add`.
 */
export async function afterConsent(env: Env, page: Page, app: string, shotName?: string): Promise<void> {
  await completeDetails(env, page, app, { shotName });
}

/** One row of a details page, as the Carbon sees it. */
export interface DetailRowSeen {
  field: string;
  mode: "required" | "optional";
  /** The account has no such detail yet (email or phone). */
  missing: boolean;
  /** An optional detail's checkbox (null for a required one). */
  ticked: boolean | null;
  text: string;
}

/** One details page of an app's flow, as shown (and as the server described it). */
export interface DetailsPageSeen {
  /** 0-based position and the number of pages this sign-in shows. */
  index: number;
  count: number;
  /** The flow step's id ("contact", "about-you"; "details" for the one page of an app without a flow of its own). */
  id: string;
  title: string;
  /** "Step 1 of 2" when the sign-in shows several pages. */
  progress: string | null;
  continueLabel: string;
  /** This page's own layout (null: the branding's). */
  layout: string | null;
  /** The layout the page is drawn in (the hosted frame's data-layout: card, split or minimal). */
  shownLayout: string | null;
  rows: DetailRowSeen[];
  /** Details added on this page with a code. */
  added: DetailField[];
  /** What the page shared as it continued: its required details and the optional ones ticked (profile on the first). */
  shared: string[];
}

export interface ReviewSeen {
  title: string;
  /** Profile first, then what is shared. */
  shared: string[];
  /** What the app asked for and will not get (left unticked, or missing). */
  kept: string[];
}

export interface DetailsAnswers {
  /** Optional details to tick; every other optional detail stays as the page shows it (unticked unless shared before). */
  tick?: DetailField[];
  untick?: DetailField[];
  /** Emails and phones to add with a code when the account lacks them: required ones need it, optional ones are added (and so ticked) when given. */
  add?: { email?: string; phone?: string };
  /** Cancel on this details page (0-based) instead of continuing: the app gets error=access_denied. */
  cancelOnPage?: number;
  /** On the review page: approve (default) or cancel. */
  approve?: boolean;
  /** Stop on the review page without answering it (the journey goes Back, or cancels, itself). */
  stopAtReview?: boolean;
  /** Screenshot prefix: <shotName>-details-<n>, <shotName>-review. */
  shotName?: string;
  timeoutMs?: number;
}

export interface HostedWalk {
  pages: DetailsPageSeen[];
  review: ReviewSeen | null;
  /** True when the walk ended back at the app with its error (cancelled), false when it signed in. */
  cancelled: boolean;
}

/** A hosted flow as the server describes it (GET /v1/flows/{id}, the browser's own cookies): the parts helpers read. */
export interface FlowSeen {
  id: string;
  step: string;
  intent?: Intent | null;
  method_hint: string | null;
  app: { app_id: string; name: string; copy: Record<string, unknown> };
  methods: string[];
  details: {
    index: number;
    count: number;
    id: string;
    title: string | null;
    subtitle: string | null;
    continue_label: string | null;
    layout: string | null;
    review_next?: boolean;
    fields: Array<{ field: string; mode: "required" | "optional"; label: string; value: string | null; missing: boolean; shared: boolean; previously_granted: boolean }>;
    challenge: unknown;
  } | null;
  review: { fields: Array<{ field: string; mode: string; label: string; value: string | null; shared: boolean }> } | null;
  error: { code: string; message: string; hint: string | null } | null;
}

/** The hosted flow on screen as the server describes it (null when the page is not on /authorize/flow/{id}). */
export async function readFlow(page: Page): Promise<FlowSeen | null> {
  const url = new URL(page.url());
  const match = /^\/authorize\/flow\/([^/?#]+)/.exec(url.pathname);
  if (!match) return null;
  const response = await page.request.get(`${url.origin}/v1/flows/${match[1]}`);
  if (!response.ok()) return null;
  return ((await response.json()) as { flow: FlowSeen }).flow;
}

const DETAILS_LIST = 'ul[aria-label^="Details shared with"]';
const REVIEW_LIST = 'ul[aria-label^="Shared with"]';

/** The label of a details page's main button, as the page words it (FlowView details). */
function continueLabelOf(details: NonNullable<FlowSeen["details"]>): string {
  const own = details.continue_label?.trim();
  if (own) return own;
  if (details.review_next) return "Review";
  return details.index >= details.count - 1 ? "Share and continue" : "Continue";
}

/** Waits until the hosted sign-in shows a details page, the review page, or is back at the app. */
async function nextStop(env: Env, page: Page, app: string, timeoutMs: number, after: (stop: "details" | "review") => Promise<boolean> = async () => true): Promise<"app" | "details" | "review"> {
  const pattern = appUrl(env, app);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(page.url())) return "app";
    if (await live(page, DETAILS_LIST).first().isVisible().catch(() => false)) {
      if (await after("details")) return "details";
    } else if (await live(page, REVIEW_LIST).first().isVisible().catch(() => false)) {
      if (await after("review")) return "review";
    }
    await sleep(120);
  }
  const text = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
  throw new Error(`the hosted sign-in did not reach a details page, the review page or ${app} within ${Math.round(timeoutMs / 1000)} s (at ${page.url()}): ${text}`);
}

/** Reads the details page on screen: the server's view of it, and the rows as shown. */
async function readDetailsPage(page: Page): Promise<{ seen: DetailsPageSeen; flow: FlowSeen }> {
  const flow = await readFlow(page);
  const details = flow?.details;
  if (!flow || !details) throw new Error(`a details page is on screen but the flow says step ${flow?.step ?? "unknown"} (${page.url()})`);
  // The page on screen is the one the server describes once its progress says so (pages of a flow morph into each other).
  if (details.count > 1) await live(page, "span").filter({ hasText: new RegExp(`^Step ${details.index + 1} of ${details.count}$`) }).first().waitFor({ timeout: 10_000 });
  const rows = await live(page, `${DETAILS_LIST} > li`).evaluateAll(items =>
    items.map(item => {
      const box = item.querySelector('[role="checkbox"]');
      return {
        field: item.getAttribute("data-field") ?? "",
        mode: (item.hasAttribute("data-optional") ? "optional" : "required") as "required" | "optional",
        missing: item.hasAttribute("data-missing"),
        ticked: box ? box.getAttribute("aria-checked") === "true" : null,
        text: (item as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      };
    }),
  );
  const progress = await live(page, "span").filter({ hasText: /^Step \d+ of \d+$/ }).first().innerText({ timeout: 1_000 }).catch(() => null);
  return {
    flow,
    seen: {
      index: details.index,
      count: details.count,
      id: details.id,
      title: await hostedTitle(page),
      progress,
      continueLabel: continueLabelOf(details),
      layout: details.layout,
      shownLayout: await page.locator("[data-paint][data-layout]").first().getAttribute("data-layout").catch(() => null),
      rows,
      added: [],
      shared: [],
    },
  };
}

/** Adds a missing email or phone on the details page: the address (or number), Send code, the code that arrives. */
async function addOnDetailsPage(env: Env, page: Page, field: "email" | "phone", value: string, required: boolean): Promise<void> {
  const adder = live(page, `[data-adding="${field}"]`).first();
  if (!(await adder.isVisible().catch(() => false))) {
    // An optional detail opens with its row's "Add"; a required one opens by itself.
    await page.getByRole("button", { name: `Add ${required ? "your" : "a"} ${field === "email" ? "email address" : "phone number"}` }).click({ timeout: 10_000 });
    await adder.waitFor({ timeout: 10_000 });
  }
  const after = await lastSeq(env);
  if (field === "email") {
    const input = adder.getByRole("textbox", { name: "Email" });
    await input.waitFor({ timeout: 10_000 });
    await input.fill(value);
  } else {
    const input = adder.getByRole("textbox", { name: "Phone number" });
    await input.waitFor({ timeout: 10_000 });
    await input.click();
    await page.keyboard.type(value, { delay: 20 });
  }
  await adder.getByRole("button", { name: "Send code" }).click();
  const code = await codeFor(env, field === "email" ? value.toLowerCase() : value, after);
  await codeGroup(page).waitFor({ timeout: 15_000 });
  await page.keyboard.type(code, { delay: 25 });
  // Added: the row is no longer missing.
  await live(page, `${DETAILS_LIST} > li[data-field="${field}"]:not([data-missing])`).first().waitFor({ timeout: 15_000 });
}

/**
 * Walks the app's details pages (UNDERSTANDING.md "What's shared with the app", "Flows") and its review page until the
 * browser is back at the fake app: on every page adds the missing emails and phones it is given (`add`), ticks and
 * unticks optional details (`tick`, `untick`), and continues; on the review page approves (or cancels with
 * `approve: false`). Returns every page as it was shown, so a journey can check titles, required and optional rows,
 * what started ticked, and the review. Back at the app already (nothing new to share) is a walk without pages.
 */
export async function completeDetails(env: Env, page: Page, app: string, answers: DetailsAnswers = {}): Promise<HostedWalk> {
  const timeoutMs = answers.timeoutMs ?? 45_000;
  const walk: HostedWalk = { pages: [], review: null, cancelled: false };
  let lastPage = -1;
  for (let steps = 0; steps < 12; steps++) {
    // A details page counts once the server has moved past the one just answered (morphs keep both on screen a moment).
    const stop = await nextStop(env, page, app, timeoutMs, async kind => {
      if (kind === "review") return true;
      const flow = await readFlow(page).catch(() => null);
      // Not a details page any more (complete: the browser is on its way to the app), or still the one just answered.
      if (!flow || flow.step !== "details" || !flow.details) return false;
      return flow.details.index !== lastPage;
    });
    if (stop === "app") break;
    if (stop === "review") {
      const title = await hostedTitle(page);
      const fields = async (selector: string) => live(page, `${selector} > li`).evaluateAll(items => items.map(item => item.getAttribute("data-field") ?? ""));
      walk.review = { title, shared: await fields(REVIEW_LIST), kept: await fields('ul[aria-label^="Not shared with"]') };
      await sleep(300);
      if (answers.shotName) await shot(env, page, `${answers.shotName}-review`);
      if (answers.stopAtReview) return walk;
      if (answers.approve === false) {
        await page.getByRole("button", { name: "Cancel signing in" }).click();
        walk.cancelled = true;
      } else {
        await page.getByRole("button", { name: "Share and continue", exact: true }).click();
      }
      await page.waitForURL(appUrl(env, app), { timeout: timeoutMs });
      break;
    }
    const { seen, flow } = await readDetailsPage(page);
    lastPage = seen.index;
    for (const row of seen.rows) {
      const field = row.field as DetailField;
      if (!row.missing || (field !== "email" && field !== "phone")) continue;
      const value = answers.add?.[field];
      if (!value) {
        if (row.mode === "required") throw new Error(`${flow.app.name}'s details page ${seen.index + 1} of ${seen.count} needs a ${field} the account does not have; pass completeDetails(…, { add: { ${field}: … } })`);
        continue;
      }
      await addOnDetailsPage(env, page, field, value, row.mode === "required");
      seen.added.push(field);
    }
    for (const row of seen.rows) {
      if (row.mode !== "optional") continue;
      const field = row.field as DetailField;
      const want = answers.tick?.includes(field) ? true : answers.untick?.includes(field) ? false : null;
      if (want === null) continue;
      const box = live(page, `${DETAILS_LIST} > li[data-field="${field}"] [role="checkbox"]`).first();
      if (await live(page, `${DETAILS_LIST} > li[data-field="${field}"][data-missing]`).count()) {
        if (want) throw new Error(`${flow.app.name}'s details page ${seen.index + 1} of ${seen.count} cannot share ${field}: the account has none (a missing email or phone can be added with { add: { ${field}: … } })`);
        continue;
      }
      if ((await box.getAttribute("aria-checked")) !== String(want)) await box.click();
      await page.waitForFunction(([selector, value]) => [...document.querySelectorAll(selector!)].some(element => !element.closest("[data-step-leaving]") && element.getAttribute("aria-checked") === value), [`${DETAILS_LIST} > li[data-field="${field}"] [role="checkbox"]`, String(want)] as const, { timeout: 5_000 });
    }
    walk.pages.push(seen);
    await sleep(300);
    if (answers.shotName) await shot(env, page, `${answers.shotName}-details-${seen.index + 1}`);
    if (answers.cancelOnPage === seen.index) {
      await page.getByRole("button", { name: seen.index === 0 ? "Cancel" : "Cancel signing in", exact: true }).click();
      await page.waitForURL(appUrl(env, app), { timeout: timeoutMs });
      walk.cancelled = true;
      break;
    }
    // What the page shares as it continues: required details, and optional ones ticked.
    seen.shared = await live(page, `${DETAILS_LIST} > li`).evaluateAll(items =>
      items
        .filter(item => (item.hasAttribute("data-required") && !item.hasAttribute("data-missing")) || item.querySelector('[role="checkbox"][aria-checked="true"]'))
        .map(item => item.getAttribute("data-field") ?? ""),
    );
    await page.getByRole("button", { name: seen.continueLabel, exact: true }).click();
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
  return walk;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The account site's own sign-in                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Signs in on /sign-in with an email code; a new address goes through the sign-up step. Ends on the home page. */
export async function signInOnSite(env: Env, page: Page, email: string): Promise<void> {
  await page.goto(`${env.site}/sign-in`);
  await signInWithCode(env, page, { email });
  const create = page.getByRole("button", { name: "Create account" });
  const home = page.waitForURL(`${env.site}/`, { timeout: 30_000 }).then(() => "home" as const);
  if ((await Promise.race([home, create.waitFor({ timeout: 30_000 }).then(() => "signup" as const)])) === "signup") await create.click();
  await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The developer site                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * What a watched page of the developer site logs while signed out: its session probe (GET /api/accounts/me) answers
 * 401, which the browser reports as a failed resource. Pass it in `results.watch(page, label, [DEVELOPER_SIGNED_OUT])`
 * on pages that visit the developer site before signing in.
 */
export const DEVELOPER_SIGNED_OUT = /status of 401 \(Unauthorized\) @ https?:\/\/[^ ]+\/api\/accounts\/me\b/;

/**
 * Signs a Carbon in to the developer site through its BFF, the way a developer does: its /sign-in page's "Continue with
 * Silicon Accounts" (/auth/sign-in) sends the browser to the account site's hosted sign-in as the first-party app
 * `developer` (state and a PKCE S256 challenge); a browser already signed in to the account site continues as that
 * Carbon (`email` null), otherwise the email gets a code (a new address signs up first). /auth/callback exchanges the
 * code on the developer site's server and seals the tokens into its httpOnly session cookie; the page ends on
 * `returnTo` (default "/", the apps). Returns the /authorize address the developer site sent the browser to.
 */
export async function signInOnDeveloper(env: Env, page: Page, email: string | null, options: { returnTo?: string } = {}): Promise<URL> {
  const returnTo = options.returnTo ?? "/";
  await page.goto(`${env.developer}/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  const authorize = page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 }).then(() => new URL(page.url()));
  await page.getByRole("link", { name: /Continue with Silicon Accounts/ }).click({ timeout: 30_000 });
  const started = await authorize;
  const continueAs = page.getByRole("button", { name: /^Continue as / });
  const field = page.getByRole("textbox", { name: "Email" });
  const first = await Promise.race([continueAs.waitFor({ timeout: 30_000 }).then(() => "account" as const), field.waitFor({ timeout: 30_000 }).then(() => "email" as const)]);
  if (first === "account" && email === null) {
    await continueAs.click();
  } else {
    if (!email) throw new Error("signInOnDeveloper: the hosted sign-in asks for an email and none was given");
    if (first === "account") await page.getByRole("button", { name: "Use another account" }).click();
    await signInWithCode(env, page, { email });
    const create = page.getByRole("button", { name: "Create account" });
    const back = page.waitForURL(url => url.href.startsWith(env.developer), { timeout: 30_000 }).then(() => "back" as const);
    if ((await Promise.race([back, create.waitFor({ timeout: 30_000 }).then(() => "signup" as const)])) === "signup") await create.click();
  }
  const target = `${env.developer}${returnTo}`;
  await page.waitForURL(url => url.href.startsWith(env.developer) && !url.pathname.startsWith("/auth/") && !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  if (!page.url().startsWith(target)) await page.waitForURL(url => url.href.startsWith(target), { timeout: 15_000 }).catch(() => undefined);
  return started;
}

/**
 * Calls the developer site's BFF (`/api/accounts/<path>` → accounts-api `/v1/<path>`) as the browser context signed in
 * there: its sealed session cookie, and the developer site's Origin on every call (its guard refuses writes from
 * elsewhere). `path` starts with "/", e.g. "/apps/commit/proofs/ata".
 */
export async function developerApi<T = unknown>(env: Env, page: Page, path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<JsonAnswer<T>> {
  const response = await page.request.fetch(`${env.developer}/api/accounts${path}`, {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers: { origin: env.developer, ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.json === undefined ? {} : { data: JSON.stringify(init.json) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status(), body: body as T, headers: new Headers(response.headers()) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Proofs                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** POST /v1/proofs/ata and /v1/proofs/obo answer this. */
export interface IssuedProof {
  proof_id: string;
  kind: "ata" | "obo";
  proof_token: string;
  /** The issuing app keeps it to get new proof tokens (POST /v1/proofs/refresh). */
  proof_refresh_token?: string | null;
  expires_at: string;
  issuing_app: string | { app_id: string; name?: string };
  receiving_app: string | { app_id: string; name?: string };
  scopes?: string[];
  [key: string]: unknown;
}

export interface ProofVerification {
  valid: boolean;
  expires_at: string | null;
  [key: string]: unknown;
}

const basic = (appId: string) => `Basic ${Buffer.from(`${appId}:${fakeApp(appId).secret}`).toString("base64")}`;

/**
 * Issues an ATA proof as the fake app `app` (its own credentials) for exactly one receiving app (UNDERSTANDING.md:
 * "An ATA proof is always for exactly one app"): POST /v1/proofs/ata `{receiving_app}` with an Idempotency-Key.
 * Talking to two apps is two proofs, two calls. Through the site's /v1 unless `direct`; `ms` is the round trip.
 */
export async function issueAta(ctx: { env: Env; ip: string }, app: string, receivingApp: string, options: { scopes?: string[]; ttlSeconds?: number; idempotencyKey?: string; direct?: boolean } = {}): Promise<JsonAnswer<IssuedProof> & { ms: number }> {
  const started = performance.now();
  const answer = await api<IssuedProof>(ctx, "/v1/proofs/ata", {
    method: "POST",
    direct: options.direct,
    headers: { authorization: basic(app), "idempotency-key": options.idempotencyKey ?? `e2e-${Date.now()}-${tag()}` },
    json: { receiving_app: receivingApp, ...(options.scopes ? { scopes: options.scopes } : {}), ...(options.ttlSeconds ? { access_ttl_seconds: options.ttlSeconds } : {}) },
  });
  return { ...answer, ms: performance.now() - started };
}

/** Verifies a proof token as the fake app `app` (the receiving app checks a proof it was handed): POST /v1/proofs/verify. */
export async function verifyProof(ctx: { env: Env; ip: string }, app: string, proofToken: string, options: { direct?: boolean } = {}): Promise<JsonAnswer<ProofVerification> & { ms: number }> {
  const started = performance.now();
  const answer = await api<ProofVerification>(ctx, "/v1/proofs/verify", { method: "POST", direct: options.direct, headers: { authorization: basic(app) }, json: { proof_token: proofToken } });
  return { ...answer, ms: performance.now() - started };
}
