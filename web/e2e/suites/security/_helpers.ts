/**
 * Helpers of the security suite (web/e2e/suites/security): raw HTTP with full control over Origin, cookies and the
 * forwarded address, a cookie jar that keeps every Set-Cookie line, the hosted sign-in flow driven over HTTP, the fake
 * apps' fixed credentials, and extra accounts-api processes (secure cookies, production mode) on the stack's spare
 * ports (base + 5 … base + 8, between this stack's ports and the next base's).
 *
 * Kept in the suite (README: "a suite never edits lib.ts"); nothing here is specific to one journey.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Ctx } from "../../context";
import { E2E_DIR, codeFor, lastSeq, sleep, sql, tag, type Env } from "../../lib";

/** The repository root. */
export const ROOT = resolve(E2E_DIR, "../..");

/* ------------------------------------------------------------------------------------------------------------------ */
/* HTTP                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One parsed Set-Cookie line. */
export interface SetCookie {
  name: string;
  value: string;
  /** Attribute names in lower case → value ("" for flags like HttpOnly). */
  attributes: Map<string, string>;
  line: string;
}

export function parseSetCookie(line: string): SetCookie {
  const [pair = "", ...rest] = line.split(";");
  const eq = pair.indexOf("=");
  const attributes = new Map<string, string>();
  for (const part of rest) {
    const at = part.indexOf("=");
    const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
    if (key) attributes.set(key, at < 0 ? "" : part.slice(at + 1).trim());
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes, line };
}

/** Cookies of one site by name, plus every Set-Cookie line seen (for attribute checks). */
export class Jar {
  readonly values = new Map<string, string>();
  readonly seen: SetCookie[] = [];

  absorb(headers: Headers): SetCookie[] {
    const lines = headers.getSetCookie().map(parseSetCookie);
    for (const cookie of lines) {
      this.seen.push(cookie);
      const maxAge = cookie.attributes.get("max-age");
      if (!cookie.value || maxAge === "0") this.values.delete(cookie.name);
      else this.values.set(cookie.name, cookie.value);
    }
    return lines;
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }

  /** The newest Set-Cookie line for `name`. */
  last(name: string): SetCookie | undefined {
    return [...this.seen].reverse().find(cookie => cookie.name === name);
  }

  header(): string | undefined {
    return this.values.size ? [...this.values].map(([name, value]) => `${name}=${value}`).join("; ") : undefined;
  }

  clone(): Jar {
    const copy = new Jar();
    for (const [name, value] of this.values) copy.values.set(name, value);
    return copy;
  }
}

export interface Reply<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
  setCookies: SetCookie[];
  ms: number;
}

export interface CallOptions {
  method?: string;
  json?: unknown;
  form?: Record<string, string>;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Sends the jar's cookies and keeps what the answer sets. */
  jar?: Jar;
  /** The Origin header (null or undefined: none). */
  origin?: string | null;
  /** X-Forwarded-For (the stacks trust it); null or undefined: none. */
  ip?: string | null;
  basic?: [string, string];
  bearer?: string;
  /** Default "manual": redirects are answers to look at. */
  redirect?: "manual" | "follow";
  timeoutMs?: number;
}

/** A request with everything under the caller's control. Never throws on an HTTP status. */
export async function call<T = unknown>(url: string, options: CallOptions = {}): Promise<Reply<T>> {
  const headers = new Headers(options.headers);
  if (options.origin) headers.set("origin", options.origin);
  if (options.ip) headers.set("x-forwarded-for", options.ip);
  if (options.basic) headers.set("authorization", `Basic ${Buffer.from(`${options.basic[0]}:${options.basic[1]}`).toString("base64")}`);
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  const cookie = options.jar?.header();
  if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
  let body: string | undefined = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (options.form) {
    body = new URLSearchParams(options.form).toString();
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (options.contentType && !headers.has("content-type")) headers.set("content-type", options.contentType);
  const started = performance.now();
  const response = await fetch(url, {
    method: options.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    redirect: options.redirect ?? "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  const setCookies = options.jar ? options.jar.absorb(response.headers) : response.headers.getSetCookie().map(parseSetCookie);
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: parsed as T, text, headers: response.headers, setCookies, ms };
}

/** The API error object of a reply (`{"error":{code,message,hint,details}}`), or an empty one. */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export function errorOf(reply: Reply): ApiErrorBody {
  const body = reply.body as { error?: unknown } | null;
  return body && typeof body === "object" && body.error && typeof body.error === "object" ? (body.error as ApiErrorBody) : {};
}

/** "403 origin_not_allowed" for details. */
export const brief = (reply: Reply) => {
  const error = errorOf(reply);
  const body = reply.body as { error?: unknown; error_description?: unknown } | null;
  const oauth = body && typeof body === "object" && typeof body.error === "string" ? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}` : "";
  return `${reply.status} ${error.code ?? oauth ?? ""}${error.message ? ` — ${error.message}` : ""}`.slice(0, 400);
};

export const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export const randomEmail = (label: string) => `sec.${label}.${tag()}${tag()}@example.test`;

/** Median of a list (0 for none). */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake apps                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FakeAppFile {
  apps: Array<{ app_id: string; secret: string }>;
}

let fakeSecrets: Map<string, string> | null = null;

/** A fake app's fixed secret (testkit/fake-apps.json; the stack seeds the same apps with the same secrets). */
export function appSecret(appId: string): string {
  if (!fakeSecrets) {
    const file = JSON.parse(readFileSync(join(ROOT, "testkit/fake-apps.json"), "utf8")) as FakeAppFile;
    fakeSecrets = new Map(file.apps.map(app => [app.app_id, app.secret]));
  }
  const secret = fakeSecrets.get(appId);
  if (!secret) throw new Error(`testkit/fake-apps.json has no app '${appId}'`);
  return secret;
}

export const appCredentials = (appId: string): [string, string] => [appId, appSecret(appId)];

/** The fake app's registered callback on this stack's fake app server. */
export const callbackOf = (env: Env, appId: string) => `${env.apps}/${appId}/callback`;

/* ------------------------------------------------------------------------------------------------------------------ */
/* The hosted sign-in flow over HTTP                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FlowView {
  id: string;
  step: string;
  redirect_to: string | null;
  signed_in_as: { uuid: string; id: string } | null;
  signup: { id: string; display_name: string; email: string | null } | null;
  challenge: { channel: string; destination: string } | null;
  consent: { required: Array<{ scope: string }>; optional: Array<{ scope: string }> } | null;
  requirements: { missing: string[] } | null;
  error: { code: string; message: string } | null;
  app: { app_id: string };
}

/** Where a client talks to Silicon Accounts: `url` receives the requests, `origin` is the public origin (Origin header). */
export interface Target {
  env: Env;
  url: string;
  origin: string;
  ip: string;
}

/** The stack's site (the public origin, which proxies /v1 to accounts-api) as the journey's own client address. */
export const viaSite = (ctx: Pick<Ctx, "env" | "ip">): Target => ({ env: ctx.env, url: ctx.env.site, origin: ctx.env.site, ip: ctx.ip });

export interface FlowStart {
  app_id: string;
  redirect_uri: string;
  state?: string;
  scope?: string;
  prompt?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  nonce?: string;
}

export const flowOf = (reply: Reply) => (reply.body as { flow?: FlowView } | null)?.flow ?? null;

export function startFlow(target: Target, jar: Jar, start: FlowStart): Promise<Reply<{ flow: FlowView }>> {
  return call<{ flow: FlowView }>(`${target.url}/v1/flows`, { json: { timezone: "UTC", ...start }, jar, origin: target.origin, ip: target.ip });
}

export function flowStep(target: Target, jar: Jar, flowId: string, step: string, json: unknown = {}): Promise<Reply<{ flow: FlowView }>> {
  return call<{ flow: FlowView }>(`${target.url}/v1/flows/${encodeURIComponent(flowId)}/${step}`, { json, jar, origin: target.origin, ip: target.ip });
}

export interface SignedUp {
  jar: Jar;
  email: string;
  uuid: string;
  id: string;
  /** The last code the mock email server delivered for this sign-in. */
  code: string;
  /** The finished flow (its redirect_to carries the authorization code). */
  flow: FlowView;
  /** The authorization code from redirect_to (null for a first-party flow that ended on the site). */
  authCode: string | null;
  verifier: string;
  state: string;
}

function fail(what: string, reply: Reply): never {
  throw new Error(`${what}: ${brief(reply)}`);
}

/**
 * Signs in (signing up a new Carbon when the email is new) with an email code through the hosted flow, accepting the
 * sign-up prefill and approving consent. `appId` defaults to the account site itself (`accounts`).
 */
export async function signInWithEmail(target: Target, options: { email?: string; appId?: string; jar?: Jar; scope?: string; label?: string } = {}): Promise<SignedUp> {
  const env = target.env;
  const jar = options.jar ?? new Jar();
  const email = options.email ?? randomEmail(options.label ?? "carbon");
  const appId = options.appId ?? "accounts";
  const redirect = appId === "accounts" ? `${env.site}/sign-in` : callbackOf(env, appId);
  const { verifier, challenge } = pkcePair();
  const state = `st-${tag()}`;
  const created = await startFlow(target, jar, { app_id: appId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256", ...(options.scope ? { scope: options.scope } : {}), prompt: "login" });
  let flow = flowOf(created) ?? fail(`POST /v1/flows for ${appId}`, created);
  const after = await lastSeq(env);
  const sent = await flowStep(target, jar, flow.id, "email", { email });
  if (sent.status !== 200) fail(`POST /v1/flows/{id}/email for ${email}`, sent);
  const code = await codeFor(env, email, after);
  const verified = await flowStep(target, jar, flow.id, "verify", { code });
  flow = flowOf(verified) ?? fail(`POST /v1/flows/{id}/verify for ${email}`, verified);
  for (let guard = 0; guard < 6 && flow.step !== "complete"; guard++) {
    let next: Reply<{ flow: FlowView }>;
    if (flow.step === "signup") next = await flowStep(target, jar, flow.id, "signup", {});
    else if (flow.step === "consent") next = await flowStep(target, jar, flow.id, "consent", { approve: true, optional_scopes: [] });
    else throw new Error(`the flow for ${email} stopped at ${flow.step}${flow.error ? ` (${flow.error.code})` : ""}`);
    flow = flowOf(next) ?? fail(`the ${flow.step} step for ${email}`, next);
  }
  if (flow.step !== "complete") throw new Error(`the flow for ${email} did not complete (at ${flow.step})`);
  const session = await call<{ account?: { uuid: string; id: string } }>(`${target.url}/v1/session`, { jar, ip: target.ip });
  if (session.status !== 200 || !session.body.account) fail(`GET /v1/session after signing in ${email}`, session);
  const back = flow.redirect_to ? new URL(flow.redirect_to) : null;
  return { jar, email, uuid: session.body.account.uuid, id: session.body.account.id, code, flow, authCode: back?.searchParams.get("code") ?? null, verifier, state };
}

/** Continues as the browser's (jar's) signed-in Carbon into `appId` and returns the authorization code. */
export async function continueInto(target: Target, jar: Jar, appId: string, scope?: string): Promise<{ code: string; verifier: string; redirect: string; flow: FlowView }> {
  const redirect = callbackOf(target.env, appId);
  const { verifier, challenge } = pkcePair();
  const created = await startFlow(target, jar, { app_id: appId, redirect_uri: redirect, state: `st-${tag()}`, code_challenge: challenge, code_challenge_method: "S256", ...(scope ? { scope } : {}) });
  let flow = flowOf(created) ?? fail(`POST /v1/flows for ${appId}`, created);
  for (let guard = 0; guard < 6 && flow.step !== "complete"; guard++) {
    let next: Reply<{ flow: FlowView }>;
    if (flow.step === "choose_method" && flow.signed_in_as) next = await flowStep(target, jar, flow.id, "continue");
    else if (flow.step === "consent") next = await flowStep(target, jar, flow.id, "consent", { approve: true, optional_scopes: [] });
    else throw new Error(`continuing into ${appId} stopped at ${flow.step}${flow.error ? ` (${flow.error.code})` : ""}`);
    flow = flowOf(next) ?? fail(`continuing into ${appId} (${flow.step})`, next);
  }
  const code = flow.redirect_to ? new URL(flow.redirect_to).searchParams.get("code") : null;
  if (!code) throw new Error(`continuing into ${appId} ended without a code (${flow.step}, ${flow.redirect_to})`);
  return { code, verifier, redirect, flow };
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  account: { uuid: string; id: string };
}

/** POST /v1/oauth/token as `appId` (its fixed fake-app secret unless `credentials` say otherwise). */
export function token(target: Target, form: Record<string, string>, credentials: [string, string]): Promise<Reply<TokenResponse & { error?: string; error_description?: string }>> {
  return call(`${target.url}/v1/oauth/token`, { form, basic: credentials, ip: target.ip });
}

/** Signs a fresh Carbon into `appId` and exchanges the code: the app's tokens for that Carbon. */
export async function appTokens(target: Target, appId: string, options: { scope?: string; label?: string; jar?: Jar } = {}): Promise<{ tokens: TokenResponse; carbon: SignedUp }> {
  const carbon = await signInWithEmail(target, { appId, scope: options.scope, label: options.label ?? appId, jar: options.jar });
  if (!carbon.authCode) throw new Error(`signing into ${appId} returned no code (${carbon.flow.redirect_to})`);
  const exchanged = await token(target, { grant_type: "authorization_code", code: carbon.authCode, redirect_uri: callbackOf(target.env, appId), code_verifier: carbon.verifier }, appCredentials(appId));
  if (exchanged.status !== 200) throw new Error(`exchanging ${appId}'s code: ${exchanged.text.slice(0, 300)}`);
  return { tokens: exchanged.body, carbon };
}

/** Creates a Silicon for the signed-in Carbon of `jar` (cookie + Origin) and returns its id, uuid and STK. */
export async function createSilicon(target: Target, jar: Jar, label = "sec"): Promise<{ id: string; uuid: string; stk: string }> {
  const id = `si:${label}-${tag()}${tag()}`.slice(0, 33);
  const created = await call<{ silicon?: { uuid: string; id: string }; stk?: string | null }>(`${target.url}/v1/me/silicons`, {
    json: { id, display_name: `Security ${label}` },
    jar,
    origin: target.origin,
    ip: target.ip,
    headers: { "idempotency-key": `sec-${tag()}${tag()}` },
  });
  if (created.status !== 201 || !created.body.silicon || !created.body.stk) fail(`POST /v1/me/silicons ${id}`, created);
  return { id: created.body.silicon.id, uuid: created.body.silicon.uuid, stk: created.body.stk };
}

/** Silicon sign-in (si:id + STK) → a first-party token response, or the refusal. */
export function siliconLogin(target: Target, id: string, stk: string, ip = target.ip): Promise<Reply<TokenResponse>> {
  return call<TokenResponse>(`${target.url}/v1/silicons/login`, { json: { id, stk }, ip });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Secrets a journey saw (codes, tokens, STKs, cookies), for the log scan                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export const SECRETS_KEY = "security.secrets";

/** Remembers secret values this run produced (shared with the log-scan journey, which runs last). */
export function remember(ctx: Pick<Ctx, "shared">, kind: string, ...values: Array<string | null | undefined>): void {
  const list = ((ctx.shared[SECRETS_KEY] as Array<{ kind: string; value: string }> | undefined) ??= []);
  for (const value of values) if (value && value.length >= 6) list.push({ kind, value });
}

export function remembered(ctx: Pick<Ctx, "shared">): Array<{ kind: string; value: string }> {
  return (ctx.shared[SECRETS_KEY] as Array<{ kind: string; value: string }> | undefined) ?? [];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Extra accounts-api processes                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

const children = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/** A spare port of this stack: base + 5 … base + 8 (base − 1 … base + 4 are the stack's, base + 9 the next base's API). */
export function sparePort(env: Env, n: 5 | 6 | 7 | 8): number {
  return env.base + n;
}

export const binary = (env: Env, name: "accounts-api" | "accounts-migrate" | "accounts-seed") => join(dirname(env.cli), name);

/** The stack's own accounts-api environment file (scripts/dev.sh writes it), or null. */
export function stackEnvFile(env: Env): string | null {
  const path = join(ROOT, ".dev/run", String(env.base), "accounts-api.env");
  return existsSync(path) ? path : null;
}

/** The stack's accounts-api log (scripts/dev.sh), or null. */
export function stackLog(env: Env, name = "accounts-api"): string | null {
  const path = join(ROOT, ".dev/logs", String(env.base), `${name}.log`);
  return existsSync(path) ? path : null;
}

export interface Spawned {
  child: ChildProcess;
  /** Everything it printed so far (stdout and stderr interleaved). */
  output: () => string;
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  /** Stops it (SIGTERM, then SIGKILL after 10 s) and waits. */
  stop: () => Promise<void>;
}

/**
 * Runs one of the stack's binaries with exactly `vars` (plus PATH and HOME; nothing of this process's environment, so
 * the stack's own ACCOUNTS_* never leak in) from a directory without a .env (or `cwd`). With `stackEnv`, the stack's
 * accounts-api environment file is loaded first and `vars` override it.
 */
export function runBinary(env: Env, name: "accounts-api" | "accounts-migrate" | "accounts-seed", vars: Record<string, string>, options: { args?: string[]; stackEnv?: boolean; cwd?: string } = {}): Spawned {
  const bin = binary(env, name);
  // Next's types make NODE_ENV a required key of ProcessEnv; these processes are not Next, so none is set.
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir(), NO_COLOR: "1" } as Record<string, string> as NodeJS.ProcessEnv;
  let child: ChildProcess;
  const envFile = options.stackEnv ? stackEnvFile(env) : null;
  if (options.stackEnv && !envFile) throw new Error(`the stack's environment file .dev/run/${env.base}/accounts-api.env is missing`);
  if (envFile) {
    // The stack's file is shell (`export K=V`); overrides come after it.
    const overrides = Object.entries(vars).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
    child = spawn("bash", ["-c", `set -a; . ${shellQuote(envFile)}; set +a\n${overrides}\nexec ${shellQuote(bin)} ${(options.args ?? []).map(shellQuote).join(" ")}`], { cwd: options.cwd ?? tmpdir(), env: base, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    child = spawn(bin, options.args ?? [], { cwd: options.cwd ?? tmpdir(), env: { ...base, ...vars } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  }
  children.add(child);
  let output = "";
  child.stdout?.on("data", chunk => (output += String(chunk)));
  child.stderr?.on("data", chunk => (output += String(chunk)));
  const exited = new Promise<number | null>(done => {
    child.on("exit", code => {
      children.delete(child);
      done(code);
    });
    child.on("error", error => {
      output += `\nspawn error: ${error.message}`;
      children.delete(child);
      done(-1);
    });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const killed = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!killed) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  return { child, output: () => output, exited, stop };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Waits until `url` answers 200 while the process lives; resolves with the ms it took, or throws with its output. */
export async function waitReady(url: string, server: Spawned, timeoutMs = 90_000): Promise<number> {
  const started = Date.now();
  let exitCode: number | null | undefined;
  void server.exited.then(code => (exitCode = code));
  while (Date.now() - started < timeoutMs) {
    if (exitCode !== undefined) throw new Error(`the server exited (${exitCode}) before it was ready:\n${server.output().slice(-1500)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return Date.now() - started;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(`${url} was not ready within ${timeoutMs} ms:\n${server.output().slice(-1500)}`);
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return !(cause?.code === "ECONNREFUSED");
  }
}

/** A database next to the stack's (same server), created fresh; returns its URL. */
export async function freshDatabase(env: Env, suffix: string): Promise<string> {
  const name = `${new URL(env.db).pathname.slice(1)}_${suffix}`;
  const admin = { ...env, db: env.db.replace(/\/[^/]+$/, "/postgres") };
  await sql(admin, `drop database if exists ${name} with (force)`);
  await sql(admin, `create database ${name}`);
  return env.db.replace(/\/[^/]+$/, `/${name}`);
}

export async function dropDatabase(env: Env, url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^accounts_e2e_[a-z0-9_]+$/.test(name)) return;
  const admin = { ...env, db: env.db.replace(/\/[^/]+$/, "/postgres") };
  await sql(admin, `drop database if exists ${name} with (force)`).catch(() => undefined);
}

/** A random base64url 32-byte key (token pepper, keyring key, Ed25519 seed). */
export const key32 = () => base64url(randomBytes(32));
