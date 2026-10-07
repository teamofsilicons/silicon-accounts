/**
 * Helpers of the proofs-perf suite (OBO and ATA proofs end to end, their failure modes, and their latency).
 *
 * Kept in the suite (README: "keep it in the suite (_helpers.ts) and say so"): a Carbon signed into a fake app without
 * a browser (the hosted flow driven through the site's /v1, the fake app exchanging the code itself, so the fake app
 * server holds the account's tokens exactly as after a browser sign-in), calls made with an app's own credentials,
 * the exact "not valid" body, percentiles, and the server-side duration of a request from the stack's API log.
 *
 * testkit/lib has similar helpers, but it imports with `.ts` extensions that the site's tsconfig refuses, so the walk
 * keeps its own small versions here.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext } from "@playwright/test";
import type { Ctx } from "../../context";
import { E2E_DIR, api, codeFor, json, lastSeq, randomIp, sql, tag, type Env, type JsonAnswer } from "../../lib";

const ROOT = resolve(E2E_DIR, "../..");

/* ------------------------------------------------------------------------------------------------------------------ */
/* Apps                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FakeAppRecord {
  app_id: string;
  name: string;
  secret: string;
  owner_id?: string;
}

let fakeApps: FakeAppRecord[] | null = null;

/** The fake apps the stack seeded (testkit/fake-apps.json): fixed app ids and secrets, as Silicon Apps delivers them. */
export function fakeApp(appId: string): FakeAppRecord {
  fakeApps ??= (JSON.parse(readFileSync(join(ROOT, "testkit/fake-apps.json"), "utf8")) as { apps: FakeAppRecord[] }).apps;
  const app = fakeApps.find(candidate => candidate.app_id === appId);
  if (!app) throw new Error(`testkit/fake-apps.json has no app "${appId}"`);
  return app;
}

/** `Authorization: Basic base64(app_id:secret)` (client_secret_basic form-encodes both first, a no-op for these ids). */
export function basicAuth(appId: string, secret = fakeApp(appId).secret): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(appId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

export interface AppCallOptions {
  /** Idempotency-Key header. */
  key?: string;
  /** Straight at accounts-api instead of through the site (the public origin). */
  direct?: boolean;
  /** Another secret (a wrong one), or null for no Authorization header at all. */
  secret?: string | null;
  headers?: Record<string, string>;
}

/** A call to Silicon Accounts authenticated as an app (HTTP Basic), from the journey's own address. */
export function asApp<T = Record<string, unknown>>(ctx: Ctx, appId: string, method: string, path: string, body?: unknown, options: AppCallOptions = {}): Promise<JsonAnswer<T>> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.secret !== null) headers.authorization = basicAuth(appId, options.secret ?? undefined);
  if (options.key) headers["idempotency-key"] = options.key;
  return api<T>(ctx, path, { method, headers, direct: options.direct, ...(body === undefined ? {} : { json: body }) });
}

/** What POST /v1/proofs/obo|ata|refresh answers. */
export interface IssuedProof {
  proof_id: string;
  kind: "obo" | "ata";
  proof_token: string;
  expires_at: string;
  proof_refresh_token: string;
  refresh_expires_at: string;
  issuing_app: string;
  receiving_app?: string;
  receiving_apps?: string[];
  user: { uuid: string; id: string | null; kind: string; membership_id: string } | null;
  scopes: string[];
  error?: ApiErrorBody["error"];
}

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

export interface Verification {
  valid: boolean;
  expires_at: string | null;
  proof_id?: string;
  kind?: string;
  issuing_app?: { app_id: string; name: string };
  receiving_app?: { app_id: string; name: string };
  user?: { uuid: string; id: string | null; kind: string; membership_id: string } | null;
  scopes?: string[];
}

export const issueObo = (ctx: Ctx, appId: string, subjectToken: string, body: { receiving_app: string; scopes?: string[]; access_ttl_seconds?: number }, options: AppCallOptions = {}) =>
  asApp<IssuedProof>(ctx, appId, "POST", "/v1/proofs/obo", { subject_token: subjectToken, ...body }, { key: randomUUID(), ...options });

export const issueAta = (ctx: Ctx, appId: string, body: { audiences: string[]; scopes?: string[]; access_ttl_seconds?: number }, options: AppCallOptions = {}) =>
  asApp<IssuedProof>(ctx, appId, "POST", "/v1/proofs/ata", body, { key: randomUUID(), ...options });

export const verifyAs = (ctx: Ctx, appId: string, proofToken: string, options: AppCallOptions = {}) => asApp<Verification>(ctx, appId, "POST", "/v1/proofs/verify", { proof_token: proofToken }, options);

export const refreshAs = (ctx: Ctx, appId: string, refreshToken: string, extra: { access_ttl_seconds?: number } = {}, options: AppCallOptions = {}) =>
  asApp<IssuedProof>(ctx, appId, "POST", "/v1/proofs/refresh", { proof_refresh_token: refreshToken, ...extra }, options);

export const revokeAs = (ctx: Ctx, appId: string, body: Record<string, unknown>, options: AppCallOptions = {}) => asApp<ApiErrorBody | null>(ctx, appId, "POST", "/v1/proofs/revoke", body, options);

/** One item of GET /v1/apps/{app_id}/proofs. */
export interface AppProofItem {
  proof_id: string;
  kind: string;
  audiences: string[];
  user: { uuid: string; id: string | null; kind: string } | null;
  scopes: string[];
  status: string;
  access_ttl_seconds: number;
  created_at: string;
  expires_at: string;
  token_expires_at: string | null;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/** One item of GET /v1/me/proofs. */
export interface MyProofItem {
  proof_id: string;
  issuing_app: { app_id: string; name: string };
  receiving_app: { app_id: string; name: string };
  scopes: string[];
  status: string;
  created_at: string;
  expires_at: string;
  token_expires_at: string | null;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/** An app's listing entry for one proof (pages through the app's proofs, newest first). */
export async function appListing(ctx: Ctx, appId: string, proofId: string, query = ""): Promise<AppProofItem | null> {
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const answer = await asApp<{ items: AppProofItem[]; next_cursor: string | null }>(ctx, appId, "GET", `/v1/apps/${appId}/proofs?limit=200${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const found = answer.body.items?.find(item => item.proof_id === proofId);
    if (found) return found;
    if (!answer.body.next_cursor) return null;
    cursor = answer.body.next_cursor;
  }
  return null;
}

/** True for exactly `{"valid": false, "expires_at": null}`: those two keys, nothing else. */
export function isExactlyInvalid(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  const record = body as Record<string, unknown>;
  return keys.length === 2 && keys[0] === "expires_at" && keys[1] === "valid" && record.valid === false && record.expires_at === null;
}

export const errorCode = (body: unknown): string | undefined => {
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === "object") return (error as { code?: string }).code;
  return typeof error === "string" ? error : undefined;
};

export const short = (value: unknown, max = 300) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).replace(/sapr?_[A-Za-z0-9_-]{20,}/g, token => `${token.slice(0, 9)}…`).slice(0, max);
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* A browser stand-in at the site                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Calls the site's /v1 as a browser would: its own cookie jar (sa_flow, sa_signup, sa_session), an Origin header (the
 * CSRF guard of cookie-authenticated mutations) and its own forwarded address (per-network limits of its own).
 */
export class SiteSession {
  readonly jar = new Map<string, string>();
  readonly ip: string;

  constructor(readonly env: Env, ip: string = randomIp()) {
    this.ip = ip;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonAnswer<T>> {
    const all: Record<string, string> = { accept: "application/json", "x-forwarded-for": this.ip, origin: this.env.site, ...headers };
    if (body !== undefined) all["content-type"] = "application/json";
    if (this.jar.size) all.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(`${this.env.site}${path}`, { method, headers: all, redirect: "manual", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text.
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  /** Puts this session's cookies (the signed-in account site) into a browser context. */
  async into(context: BrowserContext): Promise<void> {
    await context.addCookies([...this.jar].map(([name, value]) => ({ name, value, url: this.env.site, httpOnly: true, sameSite: "Lax" as const })));
  }
}

interface FlowView {
  id: string;
  step: string;
  signed_in_as: { uuid: string; id: string } | null;
  signup: { display_name: string; id: string; timezone: string; dob: string } | null;
  requirements: { missing: string[] } | null;
  redirect_to: string | null;
  error: { code: string; message: string } | null;
}

export interface AppSignIn {
  appId: string;
  uuid: string;
  id: string;
  membershipId: string;
  email: string;
  phone: string;
  /** Signed in to the account site too (sa_session): the hosted flow signs the browser in. */
  session: SiteSession;
  /** What the fake app received (AccountForApp) and its callback answer. */
  callback: Record<string, unknown>;
  ms: number;
}

export const newEmail = (label: string) => `pp.${label}.${tag()}${tag()}@example.test`;
export const newPhone = () => `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;

async function flowStep(session: SiteSession, path: string, body: unknown, what: string): Promise<FlowView> {
  const answer = await session.call<{ flow?: FlowView; error?: { code: string; message: string } }>("POST", path, body);
  if ((answer.status !== 200 && answer.status !== 201) || !answer.body.flow) throw new Error(`${what}: POST ${path} answered ${answer.status} ${short(answer.body, 500)}`);
  return answer.body.flow;
}

/**
 * Signs a Carbon into a fake app through the hosted flow without a browser: the fake app starts the sign-in (its state,
 * PKCE pair and session cookie), the flow runs through the site's /v1 (email code, sign-up with the prefill, the
 * requirements the app has — a phone for dm — and consent), and the fake app's callback exchanges the code, so the
 * fake app server holds the account's tokens (its /_state, /actions/*), just as after a sign-in in a browser.
 * A session already signed in to the site continues as that account.
 */
export async function signInToApp(ctx: Ctx, appId: string, options: { email?: string; phone?: string; session?: SiteSession } = {}): Promise<AppSignIn> {
  const started = Date.now();
  const { env } = ctx;
  const session = options.session ?? new SiteSession(env);
  const email = options.email ?? newEmail(appId);
  const phone = options.phone ?? newPhone();
  const start = await json<{ authorize_url: string; session_cookie: string }>(`${env.apps}/${appId}/authorize-url`);
  if (start.status !== 200) throw new Error(`${appId}/authorize-url answered ${start.status} ${short(start.body)}`);
  const params: Record<string, string> = {};
  for (const [key, value] of new URL(start.body.authorize_url).searchParams) params[key] = value;
  delete params.response_type;
  params.timezone = "Asia/Kolkata";
  let flow = await flowStep(session, "/v1/flows", params, `starting the ${appId} sign-in`);
  if (flow.step === "choose_method" && flow.signed_in_as) {
    flow = await flowStep(session, `/v1/flows/${flow.id}/continue`, {}, "continue as");
  } else {
    const after = await lastSeq(env);
    flow = await flowStep(session, `/v1/flows/${flow.id}/email`, { email }, "sending the email code");
    const code = await codeFor(env, email, after);
    flow = await flowStep(session, `/v1/flows/${flow.id}/verify`, { code }, "verifying the email code");
  }
  for (let guard = 0; guard < 10 && flow.step !== "complete"; guard++) {
    if (flow.step === "signup") {
      const prefill = flow.signup;
      if (!prefill) throw new Error(`flow ${flow.id} is at signup without a prefill`);
      flow = await flowStep(session, `/v1/flows/${flow.id}/signup`, { display_name: prefill.display_name, id: prefill.id, timezone: prefill.timezone, dob: prefill.dob }, "signing up");
    } else if (flow.step === "requirements") {
      const missing = flow.requirements?.missing ?? [];
      const kind = missing.includes("phone") ? "phone" : missing.includes("email") ? "email" : null;
      if (!kind) throw new Error(`flow ${flow.id} requires ${missing.join(", ")}, which this helper cannot give`);
      const to = kind === "phone" ? phone : email;
      const after = await lastSeq(env);
      flow = await flowStep(session, `/v1/flows/${flow.id}/requirements/${kind}`, { [kind]: to }, `adding the required ${kind}`);
      const code = await codeFor(env, to, after);
      flow = await flowStep(session, `/v1/flows/${flow.id}/requirements/verify`, { code }, `verifying the required ${kind}`);
    } else if (flow.step === "consent") {
      flow = await flowStep(session, `/v1/flows/${flow.id}/consent`, { approve: true, optional_scopes: [] }, "consenting");
    } else {
      throw new Error(`flow ${flow.id} stopped at ${flow.step}: ${short(flow.error)}`);
    }
  }
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`flow ${flow.id} did not complete (${flow.step})`);
  const back = new URL(flow.redirect_to);
  const callback = await json<Record<string, unknown>>(`${env.apps}/${appId}/callback?${back.searchParams.toString()}&format=json`, { headers: { cookie: start.body.session_cookie, accept: "application/json" } });
  if (callback.status !== 200 || callback.body.ok !== true) throw new Error(`${appId}'s callback answered ${callback.status} ${short(callback.body, 500)}`);
  return {
    appId,
    uuid: String(callback.body.uuid),
    id: String(callback.body.id),
    membershipId: String(callback.body.membership_id),
    email,
    phone,
    session,
    callback: callback.body,
    ms: Date.now() - started,
  };
}

/** The tokens a fake app holds for an account (its /_state with include_tokens). */
export async function appTokens(env: Env, appId: string, uuid: string): Promise<{ access_token: string; refresh_token: string | null }> {
  const state = await json<{ accounts: Array<{ uuid: string; tokens?: { access_token: string; refresh_token: string | null } }> }>(`${env.apps}/${appId}/_state?include_tokens=1`);
  const tokens = state.body.accounts?.find(account => account.uuid === uuid)?.tokens;
  if (!tokens) throw new Error(`${appId} holds no tokens for ${uuid}`);
  return tokens;
}

/** The sign-in (token family) an access token belongs to: its `fid` claim. */
export function familyOf(accessToken: string): string {
  const [, payload = ""] = accessToken.split(".");
  return String((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { fid?: string }).fid ?? "");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Numbers                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles. */
export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? Number.NaN, mean: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1) };
}

export const describeStats = (s: Stats, unit = "ms") => `n=${s.n} p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} p99 ${s.p99.toFixed(2)} max ${s.max.toFixed(2)} mean ${s.mean.toFixed(2)} ${unit}`;

/** The machine's 1-minute load average and core count, for reading timings. */
export function machineLoad(): { load1: number; cores: number } {
  return { load1: Math.round((loadavg()[0] ?? 0) * 100) / 100, cores: availableParallelism() };
}

/**
 * accounts-api's own duration (whole milliseconds, from its `request … duration_ms=… request_id=…` log lines) of the
 * requests whose X-Request-Id is in `ids`. The stack's log is .dev/logs/<base>/accounts-api.log.
 */
export function serverDurations(env: Env, ids: Iterable<string>): Map<string, number> {
  const wanted = new Set(ids);
  const found = new Map<string, number>();
  const file = join(ROOT, ".dev", "logs", String(env.base), "accounts-api.log");
  if (!existsSync(file)) return found;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const id = /request_id=([0-9a-f-]{36})/.exec(line)?.[1];
    if (!id || !wanted.has(id)) continue;
    const duration = /duration_ms=(\d+)/.exec(line)?.[1];
    if (duration !== undefined) found.set(id, Number(duration));
  }
  return found;
}

/** One row of the stack's database as a record (sql() returns strings). */
export async function row(env: Env, query: string): Promise<string[] | null> {
  const rows = await sql(env, query);
  return rows[0] ?? null;
}

export const secondsBetween = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 1000;
