/**
 * Helpers of the security suite (web/e2e/suites/security): raw HTTP with full control over Origin, cookies and the
 * forwarded address (and `raw` for byte-exact request targets and Host headers), a cookie jar that keeps every
 * Set-Cookie line, the hosted sign-in flow driven over HTTP (v2: choose_method → verify_code → signup → the app's
 * details pages → review → complete), the developer site's BFF driven over HTTP (its sign-in round trip, its sealed
 * session cookie), the three kinds of account tokens (aud=developer through the `developer` app with PKCE, aud=silicon-accounts
 * through the device flow, an app's own), the fake apps' fixed credentials, a recording HTTP server (`serve`), a dump
 * of the stack's database (`dumpDatabase`), and extra accounts-api / developer-site processes (secure cookies,
 * production mode) on the stack's spare ports (base + 6 … base + 8: base − 1 … base + 5 are the stack's own, the
 * developer site being base + 5, and base + 9 is the next base's API).
 *
 * Kept in the suite (README: "a suite never edits lib.ts"); nothing here is specific to one journey.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
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

export interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/**
 * One HTTP/1.1 request with the request target sent exactly as given (fetch normalizes `//x`, `/\x` and `..`) and
 * every header under the caller's control, Host included. Never follows redirects; status -1 when the connection failed.
 */
export function raw(base: string, target: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawReply> {
  const url = new URL(base);
  return new Promise(done => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port || 80), path: target, method: options.method ?? "GET", headers: { host: url.host, ...options.headers }, timeout: 30_000 },
      (res: IncomingMessage) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", error => done({ status: -1, headers: {}, text: String(error) }));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A small HTTP server on 127.0.0.1:`port` that records every request and answers with `handler` (default 200). */
export async function serve(port: number, handler: (hit: Hit, res: ServerResponse) => void = (_hit, res) => res.end("ok")): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const hit = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      handler(hit, res);
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
  const close = () =>
    new Promise<void>(done => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return { url: `http://127.0.0.1:${port}`, hits, close };
}

/** The stack database's data as SQL text (pg_dump --data-only), for scanning what is stored in clear. */
export function dumpDatabase(env: Env, url = env.db): Promise<string> {
  return new Promise((done, fail) => {
    execFile(join(env.pgBin, "pg_dump"), ["--data-only", "--no-owner", "--no-privileges", url], { maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" } }, (error, stdout, stderr) => {
      if (error) fail(new Error(`pg_dump failed on ${url}: ${stderr.trim() || error.message}`));
      else done(stdout);
    });
  });
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

/** "403 origin_not_allowed — message" (or the OAuth error and its description) for details. */
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

/** A fresh US number in the fictional 555 range (as the core journeys use). */
export const randomPhone = () => `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;

/** Median of a list (0 for none). */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The payload of a JWT (no verification), or {} when it is not one. */
export function jwtClaims(jwt: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from((jwt ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake apps                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FakeAppFile {
  apps: Array<{ app_id: string; secret: string; owner_id?: string; owner_email?: string }>;
}

let fakeApps: FakeAppFile["apps"] | null = null;

function fakeAppEntry(appId: string): FakeAppFile["apps"][number] {
  fakeApps ??= (JSON.parse(readFileSync(join(ROOT, "testkit/fake-apps.json"), "utf8")) as FakeAppFile).apps;
  const app = fakeApps.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`testkit/fake-apps.json has no app '${appId}'`);
  return app;
}

/** A fake app's fixed secret (testkit/fake-apps.json; the stack seeds the same apps with the same secrets). */
export const appSecret = (appId: string): string => fakeAppEntry(appId).secret;

export const appCredentials = (appId: string): [string, string] => [appId, appSecret(appId)];

/** The Carbon who owns a fake app (its c:id and its seeded, verified email). */
export function appOwner(appId: string): { id: string; email: string } {
  const app = fakeAppEntry(appId);
  if (!app.owner_email || !app.owner_id) throw new Error(`testkit/fake-apps.json gives '${appId}' no owner`);
  return { id: app.owner_id, email: app.owner_email };
}

/** The fake app's registered callback on this stack's fake app server. */
export const callbackOf = (env: Env, appId: string) => `${env.apps}/${appId}/callback`;

/** The developer site's one redirect URI (the first-party app `developer`): `{developer}/auth/callback`. */
export const developerCallback = (env: Env) => `${env.developer}/auth/callback`;

/* ------------------------------------------------------------------------------------------------------------------ */
/* The hosted sign-in flow over HTTP (v2)                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface DetailsField {
  field: string;
  mode: "required" | "optional";
  label?: string;
  value: string | null;
  missing: boolean;
  shared: boolean;
  previously_granted?: boolean;
}

/** FlowView (06-v2.md §4): the parts this suite reads. */
export interface FlowView {
  id: string;
  /** choose_method | verify_code | signup | details | review | complete | failed */
  step: string;
  redirect_to: string | null;
  signed_in_as: { uuid: string; id: string } | null;
  signup: { id: string; display_name: string; email: string | null } | null;
  challenge: { channel: string; destination: string } | null;
  details: { index: number; count: number; id: string; fields: DetailsField[]; challenge: { channel: string; destination: string } | null } | null;
  review: { fields: Array<{ field: string; mode?: string; shared: boolean; value?: string | null }> } | null;
  intent?: string;
  method_hint?: string | null;
  prompt?: string | null;
  error: { code: string; message: string } | null;
  app: { app_id: string; name?: string };
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
  intent?: string;
  method?: string;
  [key: string]: string | undefined;
}

export const flowOf = (reply: Reply) => (reply.body as { flow?: FlowView } | null)?.flow ?? null;

export function startFlow(target: Target, jar: Jar, start: FlowStart): Promise<Reply<{ flow: FlowView }>> {
  return call<{ flow: FlowView }>(`${target.url}/v1/flows`, { json: { timezone: "UTC", ...start }, jar, origin: target.origin, ip: target.ip });
}

export function flowStep(target: Target, jar: Jar, flowId: string, step: string, json: unknown = {}): Promise<Reply<{ flow: FlowView }>> {
  return call<{ flow: FlowView }>(`${target.url}/v1/flows/${encodeURIComponent(flowId)}/${step}`, { json, jar, origin: target.origin, ip: target.ip });
}

/** The default redirect URI of an app on this target: the site's /sign-in (accounts), the developer site's callback, a fake app's callback. */
export function redirectFor(target: Target, appId: string): string {
  if (appId === "silicon-accounts") return `${target.origin}/sign-in`;
  if (appId === "developer") return developerCallback(target.env);
  return callbackOf(target.env, appId);
}

export interface Advance {
  /** Optional details to tick on the pages they are on (default: none). */
  share?: string[];
  /** On the review page (and to cancel on a details page): default approve. */
  approve?: boolean;
  /** Continue as the browser's account when the flow offers it (default true). */
  continueAs?: boolean;
}

/**
 * Walks a flow from wherever it is to `complete` (or `failed`) with the defaults of a Carbon who just goes on: the
 * sign-up details as prefilled, every details page continued (required details shared, the optional ones in `share`
 * ticked), the review approved. A required email or phone the account lacks stops the walk (the caller adds it).
 */
export async function advance(target: Target, jar: Jar, start: FlowView, options: Advance = {}): Promise<FlowView> {
  let flow = start;
  for (let guard = 0; guard < 12 && flow.step !== "complete" && flow.step !== "failed"; guard++) {
    let next: Reply<{ flow: FlowView }>;
    if (flow.step === "signup") next = await flowStep(target, jar, flow.id, "signup", {});
    else if (flow.step === "details" && flow.details) {
      if (options.approve === false) next = await flowStep(target, jar, flow.id, "review", { approve: false });
      else {
        const missing = flow.details.fields.filter(field => field.mode === "required" && field.missing);
        if (missing.length) throw new Error(`the flow for ${flow.app.app_id} needs ${missing.map(field => field.field).join(", ")} on its page ${flow.details.index + 1} (the account has none)`);
        const share = flow.details.fields.filter(field => field.mode === "optional" && !field.missing && (options.share ?? []).includes(field.field)).map(field => field.field);
        next = await flowStep(target, jar, flow.id, "details/continue", { share });
      }
    } else if (flow.step === "review") next = await flowStep(target, jar, flow.id, "review", { approve: options.approve ?? true });
    else if ((flow.step === "choose_method" || flow.step === "verify_code") && flow.signed_in_as && options.continueAs !== false) next = await flowStep(target, jar, flow.id, "continue");
    else throw new Error(`the flow for ${flow.app.app_id} stopped at ${flow.step}${flow.error ? ` (${flow.error.code}: ${flow.error.message})` : ""}`);
    const moved = flowOf(next);
    if (!moved) throw new Error(`the ${flow.step} step of the flow for ${flow.app.app_id}: ${brief(next)}`);
    flow = moved;
  }
  return flow;
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
  redirect: string;
}

function fail(what: string, reply: Reply): never {
  throw new Error(`${what}: ${brief(reply)}`);
}

/**
 * Signs in (signing up a new Carbon when the email is new) with an email code through the hosted flow, accepting the
 * sign-up prefill and walking the app's details pages and review with the defaults. `appId` defaults to the account
 * site itself (`silicon-accounts`).
 */
export async function signInWithEmail(target: Target, options: { email?: string; appId?: string; jar?: Jar; scope?: string; label?: string; share?: string[]; extra?: Record<string, string> } = {}): Promise<SignedUp> {
  const env = target.env;
  const jar = options.jar ?? new Jar();
  const email = options.email ?? randomEmail(options.label ?? "carbon");
  const appId = options.appId ?? "silicon-accounts";
  // The account site's own sign-in returns to the public origin the target serves (another server may have another).
  const redirect = redirectFor(target, appId);
  const { verifier, challenge } = pkcePair();
  const state = `st-${tag()}`;
  const created = await startFlow(target, jar, { app_id: appId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256", ...(options.scope ? { scope: options.scope } : {}), prompt: "login", ...options.extra });
  let flow = flowOf(created) ?? fail(`POST /v1/flows for ${appId}`, created);
  const after = await lastSeq(env);
  const sent = await flowStep(target, jar, flow.id, "email", { email });
  if (sent.status !== 200) fail(`POST /v1/flows/{id}/email for ${email}`, sent);
  const code = await codeFor(env, email.toLowerCase(), after);
  const verified = await flowStep(target, jar, flow.id, "verify", { code });
  flow = flowOf(verified) ?? fail(`POST /v1/flows/{id}/verify for ${email}`, verified);
  flow = await advance(target, jar, flow, { share: options.share, continueAs: false });
  if (flow.step !== "complete") throw new Error(`the flow for ${email} did not complete (at ${flow.step}${flow.error ? `, ${flow.error.code}` : ""})`);
  const session = await call<{ account?: { uuid: string; id: string } }>(`${target.url}/v1/session`, { jar, ip: target.ip });
  if (session.status !== 200 || !session.body.account) fail(`GET /v1/session after signing in ${email}`, session);
  const back = flow.redirect_to ? new URL(flow.redirect_to) : null;
  return { jar, email, uuid: session.body.account.uuid, id: session.body.account.id, code, flow, authCode: back?.searchParams.get("code") ?? null, verifier, state, redirect };
}

/** Signs a Carbon up (or in) on the account site with a phone code: a Carbon whose only contact is that phone. */
export async function signInWithPhone(target: Target, options: { phone: string; jar?: Jar }): Promise<{ jar: Jar; uuid: string; id: string; code: string; phone: string }> {
  const env = target.env;
  const jar = options.jar ?? new Jar();
  const created = await startFlow(target, jar, { app_id: "silicon-accounts", redirect_uri: redirectFor(target, "silicon-accounts"), state: `ph-${tag()}`, prompt: "login" });
  let flow = flowOf(created) ?? fail("POST /v1/flows for a phone sign-in", created);
  const after = await lastSeq(env);
  const sent = await flowStep(target, jar, flow.id, "phone", { phone: options.phone });
  if (sent.status !== 200) fail(`POST /v1/flows/{id}/phone for ${options.phone}`, sent);
  const code = await codeFor(env, options.phone, after);
  flow = flowOf(await flowStep(target, jar, flow.id, "verify", { code })) ?? fail("verifying the phone code", sent);
  flow = await advance(target, jar, flow, { continueAs: false });
  if (flow.step !== "complete") throw new Error(`the phone sign-in for ${options.phone} ended at ${flow.step} (${flow.error?.code ?? ""})`);
  const session = await call<{ account?: { uuid: string; id: string } }>(`${target.url}/v1/session`, { jar, ip: target.ip });
  if (session.status !== 200 || !session.body.account) fail(`GET /v1/session after the phone sign-in of ${options.phone}`, session);
  return { jar, uuid: session.body.account.uuid, id: session.body.account.id, code, phone: options.phone };
}

/** Continues as the browser's (jar's) signed-in Carbon into `appId` and returns the authorization code. */
export async function continueInto(target: Target, jar: Jar, appId: string, options: { scope?: string; share?: string[]; extra?: Record<string, string> } = {}): Promise<{ code: string; verifier: string; redirect: string; flow: FlowView; state: string }> {
  const redirect = redirectFor(target, appId);
  const { verifier, challenge } = pkcePair();
  const state = `st-${tag()}`;
  const created = await startFlow(target, jar, { app_id: appId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256", ...(options.scope ? { scope: options.scope } : {}), ...options.extra });
  let flow = flowOf(created) ?? fail(`POST /v1/flows for ${appId}`, created);
  flow = await advance(target, jar, flow, { share: options.share });
  const code = flow.redirect_to ? new URL(flow.redirect_to).searchParams.get("code") : null;
  if (!code) throw new Error(`continuing into ${appId} ended without a code (${flow.step}, ${flow.redirect_to}${flow.error ? `, ${flow.error.code}` : ""})`);
  return { code, verifier, redirect, flow, state };
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

export type TokenReply = Reply<TokenResponse & { error?: string; error_description?: string }>;

/** POST /v1/oauth/token as `appId` (its fixed fake-app secret unless `credentials` say otherwise). */
export function token(target: Target, form: Record<string, string>, credentials: [string, string]): Promise<TokenReply> {
  return call(`${target.url}/v1/oauth/token`, { form, basic: credentials, ip: target.ip });
}

/** POST /v1/oauth/token as a public first-party client (`client_id` in the body, no secret). */
export function publicToken(target: Target, clientId: "silicon-accounts" | "developer", form: Record<string, string>): Promise<TokenReply> {
  return call(`${target.url}/v1/oauth/token`, { form: { client_id: clientId, ...form }, ip: target.ip });
}

/** Signs a fresh Carbon into `appId` and exchanges the code: the app's tokens for that Carbon. */
export async function appTokens(target: Target, appId: string, options: { scope?: string; label?: string; jar?: Jar; share?: string[] } = {}): Promise<{ tokens: TokenResponse; carbon: SignedUp }> {
  const carbon = await signInWithEmail(target, { appId, scope: options.scope, label: options.label ?? appId, jar: options.jar, share: options.share });
  if (!carbon.authCode) throw new Error(`signing into ${appId} returned no code (${carbon.flow.redirect_to})`);
  const exchanged = await token(target, { grant_type: "authorization_code", code: carbon.authCode, redirect_uri: callbackOf(target.env, appId), code_verifier: carbon.verifier }, appCredentials(appId));
  if (exchanged.status !== 200) throw new Error(`exchanging ${appId}'s code: ${exchanged.text.slice(0, 300)}`);
  return { tokens: exchanged.body, carbon };
}

/**
 * The developer platform's tokens (aud=developer) for the jar's signed-in Carbon, exactly as the developer site's BFF
 * gets them: a flow for the first-party app `developer` to `{developer}/auth/callback` with PKCE S256, continued as the
 * browser's account, and the code exchanged by the public client (client_id=developer, no secret, the verifier).
 */
export async function developerTokens(target: Target, jar: Jar): Promise<TokenResponse> {
  const { code, verifier, redirect } = await continueInto(target, jar, "developer");
  const exchanged = await publicToken(target, "developer", { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
  if (exchanged.status !== 200) throw new Error(`exchanging the developer app's code: ${exchanged.text.slice(0, 300)}`);
  return exchanged.body;
}

/**
 * First-party tokens (aud=silicon-accounts) for the jar's signed-in Carbon, as the CLI gets them without a code: the device
 * flow (POST /v1/device/authorize), approved from the browser session, then polled by the public client `silicon-accounts`.
 */
export async function deviceTokens(target: Target, jar: Jar, label = "security suite"): Promise<TokenResponse> {
  const device = await call<{ device_code?: string; user_code?: string }>(`${target.url}/v1/device/authorize`, { json: { client_label: label }, ip: target.ip });
  if (device.status !== 200 || !device.body.device_code || !device.body.user_code) fail("POST /v1/device/authorize", device);
  const approved = await call(`${target.url}/v1/device/${encodeURIComponent(device.body.user_code)}/approve`, { method: "POST", body: "", jar, origin: target.origin, ip: target.ip });
  if (approved.status !== 204 && approved.status !== 200) fail("approving the device code", approved);
  const polled = await publicToken(target, "silicon-accounts", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.body.device_code });
  if (polled.status !== 200) fail("polling the approved device code", polled);
  return polled.body;
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
/* The developer site's BFF over HTTP                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The developer site's cookies on an http stack (`__Host-` prefixed over https). */
export const DEV_SESSION = "sa_dev_session";
export const DEV_SIGNIN = "sa_dev_signin";

export interface DeveloperSignIn {
  /** The developer site's cookies (sa_dev_signin while it runs, then sa_dev_session). */
  devJar: Jar;
  /** Where GET /auth/sign-in sent the browser (the hosted sign-in on the account site). */
  authorize: URL;
  /** GET /auth/callback's answer (303 to the return path, or to /sign-in?error=…). */
  callback: Reply;
  /** Its Location, absolute. */
  landed: string;
  /** The finished hosted flow. */
  flow: FlowView;
}

/**
 * Signs the Carbon of `accountJar` (signed in to the account site) in to the developer site the way a browser does,
 * over HTTP: GET /auth/sign-in?return_to=… (the BFF seals state + PKCE verifier into sa_dev_signin and answers 303 to
 * the account site's /authorize as the app `developer`), the hosted flow (continue as the account site's Carbon), then
 * GET /auth/callback?code&state with the developer cookies, which exchanges the code server side and seals the tokens.
 */
export async function developerSignIn(target: Target, accountJar: Jar, options: { returnTo?: string; devJar?: Jar; prompt?: string } = {}): Promise<DeveloperSignIn> {
  const env = target.env;
  const devJar = options.devJar ?? new Jar();
  const query = new URLSearchParams();
  if (options.returnTo !== undefined) query.set("return_to", options.returnTo);
  if (options.prompt) query.set("prompt", options.prompt);
  const start = await call(`${env.developer}/auth/sign-in${query.size ? `?${query}` : ""}`, { jar: devJar, ip: target.ip });
  const location = start.headers.get("location") ?? "";
  if (start.status !== 303 || !location) fail("GET /auth/sign-in on the developer site", start);
  const authorize = new URL(location, env.developer);
  const params = Object.fromEntries(authorize.searchParams) as Record<string, string>;
  const created = await startFlow(target, accountJar, { ...params, app_id: params.app_id ?? "developer", redirect_uri: params.redirect_uri ?? "" });
  let flow = flowOf(created) ?? fail("POST /v1/flows for the developer app", created);
  flow = await advance(target, accountJar, flow);
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`the developer app's hosted sign-in ended at ${flow.step} (${flow.error?.code ?? ""})`);
  const callback = await call(flow.redirect_to, { jar: devJar, ip: target.ip });
  const landed = new URL(callback.headers.get("location") ?? "/", env.developer).href;
  return { devJar, authorize, callback, landed, flow };
}

/** A call through the developer site's BFF (`/api/accounts/<path>`) with a developer cookie jar (Origin: the developer site unless said otherwise). */
export function viaBff<T = unknown>(env: Env, devJar: Jar | null, path: string, options: Omit<CallOptions, "jar"> = {}): Promise<Reply<T>> {
  const method = (options.method ?? (options.json !== undefined || options.body !== undefined || options.form ? "POST" : "GET")).toUpperCase();
  const origin = options.origin === undefined ? (method === "GET" || method === "HEAD" ? null : env.developer) : options.origin;
  return call<T>(`${env.developer}/api/accounts${path}`, { ...options, method, origin, ...(devJar ? { jar: devJar } : {}) });
}

/** The developer site's session secret on a stack started by scripts/dev.sh (its per-stack default). */
export const stackDeveloperSecret = (env: Env) => process.env.DEVELOPER_SESSION_SECRET ?? `local-stack-${env.base}-developer-session-secret-not-for-production`;

/** The public development secret the developer site falls back to outside production (developer/lib/server/config.ts). */
export const DEVELOPER_DEV_SECRET = "silicon-accounts-developer-site-dev-only-session-secret-0001";

function sealKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "silicon-accounts-developer", "cookie seal v1", 32));
}

/**
 * Opens a value the developer site sealed (developer/lib/server/seal.ts: `v1.` + base64url(iv ‖ AES-256-GCM ‖ tag),
 * the cookie's purpose as additional data), or null when it was not sealed with `secret` for `purpose`.
 * The suite uses it to know exactly which tokens the browser must never see.
 */
export function unsealDeveloper<T>(sealed: string | undefined, purpose: string, secret: string): T | null {
  if (!sealed?.startsWith("v1.")) return null;
  try {
    const rawBytes = Buffer.from(sealed.slice(3), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKey(secret), rawBytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(rawBytes.subarray(rawBytes.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(rawBytes.subarray(12, rawBytes.length - 16)), decipher.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Seals a value the way the developer site does (to forge cookies with a known secret, or for another purpose). */
export function sealDeveloper(value: unknown, purpose: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${base64url(Buffer.concat([iv, body, cipher.getAuthTag()]))}`;
}

/** What the developer site's session cookie holds (developer/lib/server/session.ts StoredSession). */
export interface DeveloperSession {
  v: 1;
  at: string;
  rt: string;
  ae: number;
  re: number;
  sub: string;
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
/* Extra processes                                                                                                     */
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

/** A spare port of this stack: base + 6 … base + 8 (base − 1 … base + 5 are the stack's, base + 9 the next base's API). */
export function sparePort(env: Env, n: 6 | 7 | 8): number {
  return env.base + n;
}

export const binary = (env: Env, name: "accounts-api" | "accounts-migrate" | "accounts-seed") => join(dirname(env.cli), name);

/** The stack's own accounts-api environment file (scripts/dev.sh writes it), or null. */
export function stackEnvFile(env: Env): string | null {
  const path = join(ROOT, ".dev/run", String(env.base), "accounts-api.env");
  return existsSync(path) ? path : null;
}

/** The stack's log (scripts/dev.sh: accounts-api, web, developer, testkit…), or null. */
export function stackLog(env: Env, name = "accounts-api"): string | null {
  const path = join(ROOT, ".dev/logs", String(env.base), `${name}.log`);
  return existsSync(path) ? path : null;
}

/** The developer site's standalone production server of this stack (developer/.next-<base>/standalone/server.js), or null. */
export function developerServerJs(env: Env): string | null {
  const dist = join(ROOT, ".dev/run", String(env.base), "developer.dist");
  const dir = existsSync(dist) ? readFileSync(dist, "utf8").trim() : join(ROOT, "developer", `.next-${env.base}`);
  const path = join(dir, "standalone", "server.js");
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

function track(child: ChildProcess): Spawned {
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

/** PATH and HOME only: nothing of this process's environment (the stack's ACCOUNTS_* never leak in). */
const bareEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir(), NO_COLOR: "1" }) as Record<string, string> as NodeJS.ProcessEnv;

/**
 * Runs one of the stack's binaries with exactly `vars` (plus PATH and HOME; nothing of this process's environment, so
 * the stack's own ACCOUNTS_* never leak in) from a directory without a .env (or `cwd`). With `stackEnv`, the stack's
 * accounts-api environment file is loaded first and `vars` override it.
 */
export function runBinary(env: Env, name: "accounts-api" | "accounts-migrate" | "accounts-seed", vars: Record<string, string>, options: { args?: string[]; stackEnv?: boolean; cwd?: string } = {}): Spawned {
  const bin = binary(env, name);
  let child: ChildProcess;
  const envFile = options.stackEnv ? stackEnvFile(env) : null;
  if (options.stackEnv && !envFile) throw new Error(`the stack's environment file .dev/run/${env.base}/accounts-api.env is missing`);
  if (envFile) {
    // The stack's file is shell (`export K=V`); overrides come after it.
    const overrides = Object.entries(vars).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
    child = spawn("bash", ["-c", `set -a; . ${shellQuote(envFile)}; set +a\n${overrides}\nexec ${shellQuote(bin)} ${(options.args ?? []).map(shellQuote).join(" ")}`], { cwd: options.cwd ?? tmpdir(), env: bareEnv(), stdio: ["ignore", "pipe", "pipe"] });
  } else {
    child = spawn(bin, options.args ?? [], { cwd: options.cwd ?? tmpdir(), env: { ...bareEnv(), ...vars } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  }
  return track(child);
}

/**
 * Runs the stack's developer-site build (its standalone production server) with exactly `vars` (plus PATH and HOME)
 * on a spare port: NODE_ENV, the secret and the public URL are the caller's. Throws when the stack has no such build.
 */
export function runDeveloperServer(env: Env, vars: Record<string, string>): Spawned {
  const serverJs = developerServerJs(env);
  if (!serverJs) throw new Error(`the stack's developer-site build (developer/.next-${env.base}/standalone/server.js) is missing`);
  const child = spawn(process.execPath, [serverJs], { cwd: dirname(serverJs), env: { ...bareEnv(), NEXT_TELEMETRY_DISABLED: "1", ...vars } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  return track(child);
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Waits until `url` answers `wanted` (default 200) while the process lives; resolves with the ms it took, or throws with its output. */
export async function waitReady(url: string, server: Spawned, timeoutMs = 90_000, wanted: (status: number) => boolean = status => status === 200): Promise<number> {
  const started = Date.now();
  let exitCode: number | null | undefined;
  void server.exited.then(code => (exitCode = code));
  while (Date.now() - started < timeoutMs) {
    if (exitCode !== undefined) throw new Error(`the server exited (${exitCode}) before it was ready:\n${server.output().slice(-1500)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
      if (wanted(response.status)) return Date.now() - started;
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

/**
 * Lets a seeded owner's email receive codes again: the per-address limit counts the codes sent in the last 10 minutes
 * (otp_challenges), so the codes this suite sent to it are moved 11 minutes back (time travel on its own rows).
 */
export async function forgetCodesTo(env: Env, destination: string): Promise<void> {
  await sql(env, `update otp_challenges set created_at = created_at - interval '11 minutes' where destination = '${destination.replace(/'/g, "")}' and created_at > now() - interval '11 minutes'`);
}
